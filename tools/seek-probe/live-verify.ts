/**
 * Live verification of the 0.11.0 seek path through the PUBLIC API only.
 *
 * No frame taps, no re-slicing: if this passes, a consumer gets the same.
 * MEASUREMENT ONLY — no camera configuration is written.
 *
 * Usage: npx tsx tools/seek-probe/live-verify.ts <SLOT> <channel>
 */
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import type { ReplaySeekOutcome } from "../../src/reolink/baichuan/utils/recordingReplay";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
const slot = process.argv[2] ?? "TCP";
const channel = Number(process.argv[3] ?? "0");

const makeApi = (): ReolinkBaichuanApi =>
  new ReolinkBaichuanApi({
    host: process.env[`${slot}_HOST`] as string,
    port: 9000,
    username: process.env[`${slot}_USERNAME`] ?? "admin",
    password: process.env[`${slot}_PASSWORD`] ?? "",
    transport: "auto",
    ...(process.env[`${slot}_UID`] ? { uid: process.env[`${slot}_UID`] as string } : {}),
  });

const api = makeApi();
await api.login();
const info = await api.getInfo();
console.log(`\n### ${slot} ch${channel} — ${info?.type} ${info?.firmwareVersion}`);

const now = new Date();
const clips = await api.getVideoclips({
  channel,
  start: new Date(now.getTime() - 24 * 3600 * 1000),
  end: now,
  streamType: "mainStream",
});
const long = clips.filter(
  (c) => c.startTime && c.endTime && (c.endTime.getTime() - c.startTime.getTime()) / 1000 >= 60,
);
const clip = long[long.length - 1];
if (!clip) {
  console.log("  no clip >= 60 s in the last 24 h — NOT VERIFIED on this device");
  process.exit(0);
}
const ident = clip.id ?? clip.fileName;
const dur = (clip.endTime!.getTime() - clip.startTime!.getTime()) / 1000;
console.log(`  clip ${ident.split("/").pop()}  dur=${dur}s`);

const run = async (label: string, seekSec: number | null): Promise<void> => {
  let outcome: ReplaySeekOutcome | undefined;
  const t0 = Date.now();
  let firstByteMs = -1;
  let bytes = 0;
  const buf = await api.fileInfoListReplayBinaryDownload({
    channel,
    fileName: ident,
    idleTimeoutMs: 2_000,
    timeoutMs: 120_000,
    ...(seekSec != null
      ? { seekTo: new Date(clip.startTime!.getTime() + seekSec * 1000) }
      : {}),
    onChunk: (c) => {
      if (firstByteMs < 0) firstByteMs = Date.now() - t0;
      bytes += c.length;
    },
    onSeekOutcome: (o) => {
      outcome = o;
    },
  });
  const rel = (d: Date | null): string =>
    d === null ? "unknown" : `+${Math.round((d.getTime() - clip.startTime!.getTime()) / 1000)}s`;
  console.log(
    `  ${label}\n` +
      `    asked=${outcome?.requestedAt ? rel(outcome.requestedAt) : "(start)"} ` +
      `delivered=${rel(outcome?.deliveredAt ?? null)} drift=${outcome?.driftMs ?? "n/a"}ms ` +
      `seekApplied=${outcome?.seekApplied}${outcome?.reason ? ` reason="${outcome.reason}"` : ""}\n` +
      `    ttfb=${firstByteMs}ms bytes=${bytes} returned=${buf.length}`,
  );
};

await run("A no seek (the reset path every existing download now takes)", null);
await run("B seek +20s", 20);
await run("C seek +40s", 40);
await run("D no seek again — a sticky position would show HERE", null);

await api.close({ reason: "live verify done" });
process.exit(0);
