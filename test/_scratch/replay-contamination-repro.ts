/* eslint-disable no-console */
/**
 * REPRODUCTION: a superseded cmd 5 replay contaminates the next one.
 *
 * Opens a replay, abandons it mid-transfer, opens a second replay on the same
 * socket, and records the header channelId of every cmd 5 frame that arrives
 * so the residue of transfer A can be seen landing inside transfer B's window.
 *
 * Two arms:
 *   pinned  — channelIdOverride fixed (what fileInfoListReplayBinaryDownload
 *             does for an NVR/hub child): nothing on the wire tells A from B.
 *   minted  — channelId left to the per-transfer session counter (what the
 *             Reolink app does on EVERY topology, measured 2026-09-22).
 *
 * Runs against a MAINS camera only. Never point it at a battery device.
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import type { BaichuanFrame } from "../../src/protocol/framing";
import {
  buildFileInfoListReplayByIdXml,
  buildFileInfoListReplayByNameXml,
} from "../../src/reolink/baichuan/utils/recordingReplay";
import { BC_CLASS_MODERN_24 } from "../../src/protocol/constants";

const HOST = process.env.REPRO_HOST ?? process.env.TCP_HOST ?? "";
const USER = process.env.REPRO_USERNAME ?? process.env.TCP_USERNAME ?? "admin";
const PASS = process.env.REPRO_PASSWORD ?? process.env.TCP_PASSWORD ?? "";
const CHANNEL = Number(process.env.REPRO_CHANNEL ?? "0");
const PIN = Number(process.env.REPRO_PIN ?? "82");
const CUT_MS = Number(process.env.REPRO_CUT_MS ?? "400");

interface Observed {
  atMs: number;
  channelId: number;
  payloadLen: number;
  responseCode: number;
  msgNum: number;
}

async function pickRecording(api: ReolinkBaichuanApi): Promise<string> {
  const now = new Date();
  for (let back = 0; back < 5; back++) {
    const day = new Date(now.getTime() - back * 86_400_000);
    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(day);
    end.setHours(23, 59, 59, 999);
    const clips = await api
      .getVideoclips({ channel: CHANNEL, start, end })
      .catch(() => []);
    const big = clips
      .filter((c) => c.startTime != null && c.endTime != null)
      .map((c) => ({ c, dur: (c.endTime as Date).getTime() - (c.startTime as Date).getTime() }))
      .filter((x) => x.dur > 30_000)
      .sort((a, b) => b.dur - a.dur);
    if (big[0]) {
      console.log(`  picked ${big[0].c.fileName} (${Math.round(big[0].dur / 1000)} s)`);
      return big[0].c.fileName;
    }
  }
  throw new Error("no recording longer than 30 s found in the last 5 days");
}

function payloadXmlFor(fileName: string): string {
  const common = { channel: CHANNEL, xmlChannelId: CHANNEL, streamType: "mainStream" as const };
  return fileName.includes("/")
    ? buildFileInfoListReplayByIdXml({ ...common, id: fileName })
    : buildFileInfoListReplayByNameXml({ ...common, name: fileName });
}

async function arm(
  label: string,
  client: BaichuanClient,
  fileName: string,
  pinned: boolean,
): Promise<void> {
  const observed: Observed[] = [];
  const t0 = Date.now();
  const spy = (f: BaichuanFrame): void => {
    if (f.header.cmdId !== 5) return;
    observed.push({
      atMs: Date.now() - t0,
      channelId: f.header.channelId,
      payloadLen: f.payload.length,
      responseCode: f.header.responseCode,
      msgNum: f.header.msgNum,
    });
  };
  client.on("frame", spy);

  const pin = pinned ? { channelIdOverride: PIN } : {};

  // --- Transfer A: opened, then abandoned mid-flight (throw from onChunk).
  let aChunks = 0;
  const aStart = Date.now() - t0;
  const cut = Date.now() + CUT_MS;
  const aErr = await client
    .sendBinary({
      cmdId: 5,
      channel: CHANNEL,
      ...pin,
      msgNumOverride: 0,
      messageClass: BC_CLASS_MODERN_24,
      payloadXml: payloadXmlFor(fileName),
      streamType: 0,
      timeoutMs: 120_000,
      idleTimeoutMs: 1_500,
      onChunk: () => {
        aChunks++;
        if (Date.now() >= cut) throw new Error("consumer abandoned transfer A");
      },
      internal: true,
    })
    .then(() => "(completed, not cut)")
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const aEnd = Date.now() - t0;

  // --- Transfer B: opened immediately after, same socket.
  const bStart = Date.now() - t0;
  let bChunks = 0;
  let bBytes = 0;
  const bBuf = await client
    .sendBinary({
      cmdId: 5,
      channel: CHANNEL,
      ...pin,
      msgNumOverride: 0,
      messageClass: BC_CLASS_MODERN_24,
      payloadXml: payloadXmlFor(fileName),
      streamType: 0,
      timeoutMs: 120_000,
      idleTimeoutMs: 1_500,
      onChunk: (c) => {
        bChunks++;
        bBytes += c.length;
      },
      internal: true,
    })
    .catch((e: unknown) => {
      console.log(`  B failed: ${e instanceof Error ? e.message : String(e)}`);
      return Buffer.alloc(0);
    });
  const bEnd = Date.now() - t0;
  client.off("frame", spy);

  const inB = observed.filter((o) => o.atMs >= bStart && o.atMs <= bEnd);
  const byCh = new Map<number, number>();
  for (const o of inB) byCh.set(o.channelId, (byCh.get(o.channelId) ?? 0) + 1);
  const residue = observed.filter((o) => o.atMs > aEnd && o.atMs < bStart);

  console.log(`\n--- ${label} ---`);
  console.log(`  A: opened at ${aStart} ms, ${aChunks} chunks, ended ${aEnd} ms -> ${aErr}`);
  console.log(`  frames arriving between A's end and B's request: ${residue.length}`);
  console.log(`  B: ${bStart}..${bEnd} ms, ${bChunks} chunks, ${bBytes} bytes, buffer ${bBuf.length}`);
  console.log(`  cmd 5 frames inside B's window, by header channelId:`);
  for (const [ch, n] of [...byCh].sort((a, b) => b[1] - a[1])) {
    console.log(`     channelId=${ch}: ${n}`);
  }
  console.log(`  distinct channelIds over the whole arm: ${[...new Set(observed.map((o) => o.channelId))].join(", ")}`);
  console.log(`  msgNums seen: ${[...new Set(observed.map((o) => o.msgNum))].join(", ")}`);
}

async function main(): Promise<void> {
  if (!HOST) throw new Error("set REPRO_HOST (or TCP_HOST)");
  console.log(`=== replay contamination repro @ ${HOST} ch${CHANNEL} ===`);
  const api = new ReolinkBaichuanApi({ host: HOST, username: USER, password: PASS });
  await api.login();
  const fileName = await pickRecording(api);
  const client = api.client;

  const mode = process.env.REPRO_MODE ?? "both";
  if (mode === "both" || mode === "pinned")
    await arm(`PINNED channelId=${PIN} (the hub/NVR download path)`, client, fileName, true);
  if (mode === "both" || mode === "minted")
    await arm("MINTED channelId (per-transfer session counter)", client, fileName, false);

  await api.close().catch(() => undefined);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
