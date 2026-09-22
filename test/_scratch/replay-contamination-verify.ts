/* eslint-disable no-console */
/**
 * VERIFICATION of the fix, through the real download path.
 *
 * Clean run of a clip, then: abandon a transfer of that clip mid-flight and
 * immediately download it again. The second download must be byte-identical to
 * the clean one. Mains camera only.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import type { BaichuanFrame } from "../../src/protocol/framing";

const HOST = process.env.REPRO_HOST ?? process.env.TCP_HOST ?? "";
const CHANNEL = Number(process.env.REPRO_CHANNEL ?? "0");
const CUT_MS = Number(process.env.REPRO_CUT_MS ?? "400");

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
      .filter((x) => x.dur > 30_000 && x.dur < 120_000)
      .sort((a, b) => b.dur - a.dur)[0];
    if (best) {
      console.log(`  clip ${best.c.fileName} (${Math.round(best.dur / 1000)} s)`);
      return best.c.fileName;
    }
  }
  throw new Error("no suitable recording");
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 16);

async function main(): Promise<void> {
  const api = new ReolinkBaichuanApi({
    host: HOST,
    username: process.env.REPRO_USERNAME ?? process.env.TCP_USERNAME ?? "admin",
    password: process.env.REPRO_PASSWORD ?? process.env.TCP_PASSWORD ?? "",
  });
  await api.login();
  const fileName = await pick(api);

  const handles: number[] = [];
  api.client.on("frame", (f: BaichuanFrame) => {
    if (f.header.cmdId === 5 && !handles.includes(f.header.channelId))
      handles.push(f.header.channelId);
  });

  console.log("\n[1] clean download");
  const clean = await api.fileInfoListReplayBinaryDownload({ channel: CHANNEL, fileName });
  console.log(`    ${clean.length} bytes sha=${sha(clean)}`);

  console.log("\n[2] abandon a transfer mid-flight");
  const cut = Date.now() + CUT_MS;
  let abandonedChunks = 0;
  await api
    .fileInfoListReplayBinaryDownload({
      channel: CHANNEL,
      fileName,
      onChunk: () => {
        abandonedChunks++;
        if (Date.now() >= cut) throw new Error("consumer abandoned");
      },
    })
    .then(() => console.log("    (completed, not cut — raise REPRO_CUT_MS)"))
    .catch((e: unknown) => console.log(`    abandoned after ${abandonedChunks} chunks: ${e instanceof Error ? e.message : String(e)}`));

  console.log("\n[3] download the SAME clip immediately after");
  const t = Date.now();
  const after = await api.fileInfoListReplayBinaryDownload({ channel: CHANNEL, fileName });
  console.log(`    ${after.length} bytes sha=${sha(after)} in ${Date.now() - t} ms`);

  const ok = after.length === clean.length && sha(after) === sha(clean);
  console.log(`\n  identical to the clean download: ${ok ? "YES" : `NO (delta ${after.length - clean.length} bytes)`}`);
  console.log(`  distinct cmd 5 header channelIds seen: ${handles.join(", ")}`);

  await api.close().catch(() => undefined);
  process.exit(ok ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
