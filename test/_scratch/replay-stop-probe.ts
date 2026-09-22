/* eslint-disable no-console */
/**
 * Does cmd 7 (FILE_INFO_LIST_STOP) really end a cmd 5 replay at the camera?
 *
 * Opens a replay, abandons it, then either sends the stop or does not, and
 * counts how many more cmd 5 frames the camera sends afterwards and for how
 * long. Mains camera only.
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import type { BaichuanFrame } from "../../src/protocol/framing";
import {
  buildFileInfoListReplayByIdXml,
  buildFileInfoListStopXml,
  buildReplayStopNameFromFileName,
} from "../../src/reolink/baichuan/utils/recordingReplay";
import {
  BC_CLASS_MODERN_24,
  BC_CMD_ID_FILE_INFO_LIST_STOP,
} from "../../src/protocol/constants";

const HOST = process.env.REPRO_HOST ?? process.env.TCP_HOST ?? "";
const USER = process.env.REPRO_USERNAME ?? process.env.TCP_USERNAME ?? "admin";
const PASS = process.env.REPRO_PASSWORD ?? process.env.TCP_PASSWORD ?? "";
const CHANNEL = Number(process.env.REPRO_CHANNEL ?? "0");
const CUT_MS = Number(process.env.REPRO_CUT_MS ?? "400");
const WATCH_MS = Number(process.env.REPRO_WATCH_MS ?? "8000");

async function pick(api: ReolinkBaichuanApi): Promise<string> {
  const now = new Date();
  for (let back = 0; back < 5; back++) {
    const day = new Date(now.getTime() - back * 86_400_000);
    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(day);
    end.setHours(23, 59, 59, 999);
    const clips = await api.getVideoclips({ channel: CHANNEL, start, end }).catch(() => []);
    const best = clips
      .filter((c) => c.startTime != null && c.endTime != null)
      .map((c) => ({ c, dur: (c.endTime as Date).getTime() - (c.startTime as Date).getTime() }))
      .filter((x) => x.dur > 30_000)
      .sort((a, b) => b.dur - a.dur)[0];
    if (best) {
      console.log(`  picked ${best.c.fileName} (${Math.round(best.dur / 1000)} s)`);
      return best.c.fileName;
    }
  }
  throw new Error("no long recording found");
}

async function arm(api: ReolinkBaichuanApi, fileName: string, sendStop: boolean): Promise<void> {
  const client = api.client;
  const seen: Array<{ atMs: number; channelId: number }> = [];
  let t0 = Date.now();
  const spy = (f: BaichuanFrame): void => {
    if (f.header.cmdId === 5) seen.push({ atMs: Date.now() - t0, channelId: f.header.channelId });
  };
  client.on("frame", spy);

  const cut = Date.now() + CUT_MS;
  t0 = Date.now();
  await client
    .sendBinary({
      cmdId: 5,
      channel: CHANNEL,
      msgNumOverride: 0,
      messageClass: BC_CLASS_MODERN_24,
      payloadXml: buildFileInfoListReplayByIdXml({
        channel: CHANNEL,
        xmlChannelId: CHANNEL,
        id: fileName,
        streamType: "mainStream",
      }),
      streamType: 0,
      timeoutMs: 120_000,
      idleTimeoutMs: 1_000,
      onChunk: () => {
        if (Date.now() >= cut) throw new Error("abandoned");
      },
      internal: true,
    })
    .catch(() => undefined);
  const abandonedAt = Date.now() - t0;
  const framesAtAbandon = seen.length;

  let stopMs = -1;
  let stopRc = -1;
  if (sendStop) {
    const name = buildReplayStopNameFromFileName(fileName);
    if (!name) throw new Error(`cannot derive stop name from ${fileName}`);
    const sentAt = Date.now();
    try {
      const frame = await client.sendFrame({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_STOP,
        channel: CHANNEL,
        payloadXml: buildFileInfoListStopXml({ channel: CHANNEL, name, streamType: "mainStream" }),
        messageClass: BC_CLASS_MODERN_24,
        timeoutMs: 4_000,
        internal: true,
      });
      stopRc = frame.header.responseCode;
    } catch (e) {
      console.log(`  stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    stopMs = Date.now() - t0;
    console.log(`  stop <name>${name}</name> sent at ${stopMs} ms, rc=${stopRc}, took ${Date.now() - sentAt} ms`);
  }

  await new Promise((r) => setTimeout(r, WATCH_MS));
  client.off("frame", spy);

  const ref = sendStop ? stopMs : abandonedAt;
  const after = seen.filter((s) => s.atMs > ref);
  console.log(
    `  ${sendStop ? "WITH stop" : "NO stop  "}: abandoned at ${abandonedAt} ms after ${framesAtAbandon} frames; ` +
      `${after.length} more cmd5 frames after ${sendStop ? "the stop" : "the abandon"}` +
      (after.length ? `, last at +${after[after.length - 1]!.atMs - ref} ms` : ""),
  );
}

async function main(): Promise<void> {
  if (!HOST) throw new Error("set REPRO_HOST");
  console.log(`=== cmd 7 stop probe @ ${HOST} ch${CHANNEL} ===`);
  const api = new ReolinkBaichuanApi({ host: HOST, username: USER, password: PASS });
  await api.login();
  const fileName = await pick(api);
  await arm(api, fileName, false);
  await new Promise((r) => setTimeout(r, 2000));
  await arm(api, fileName, true);
  await api.close().catch(() => undefined);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
