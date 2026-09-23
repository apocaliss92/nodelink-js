/**
 * In-clip seek probe — cmd 123 `<ReplaySeek>` before a cmd 5 replay.
 *
 * MEASUREMENT ONLY. Touches no camera configuration, so there is nothing to
 * restore. It opens replay sessions and abandons them (the library stops and
 * drains each one on the way out), exactly as a download does.
 *
 * Usage: npx tsx tools/seek-probe/probe.ts <SLOT> <channel> [seekOffsetSeconds]
 * Credentials come from .env slots (<SLOT>_HOST/_USERNAME/_PASSWORD/_UID).
 */
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { parseBcMedia } from "../../src/baichuan/stream/BcMediaParser";
import { buildFileInfoListReplayByIdXml } from "../../src/reolink/baichuan/utils/recordingReplay";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const slot = process.argv[2] ?? "TCP";
const channel = Number(process.argv[3] ?? "0");
const seekOffsetSec = Number(process.argv[4] ?? "60");

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

interface Observation {
  label: string;
  ttfbMs: number;
  bytes: number;
  info?: string;
  frames: { kind: string; time?: number; micros: number }[];
  rawFrames: string[];
  error?: string;
}

const MAGICS = new Set<number>();
for (let i = 0x63643030; i <= 0x63643039; i++) MAGICS.add(i);
for (let i = 0x63643130; i <= 0x63643139; i++) MAGICS.add(i);
MAGICS.add(0x31303031);
MAGICS.add(0x32303031);
MAGICS.add(0x62773530);
MAGICS.add(0x62773130);

const findMagic = (buf: Buffer, from: number): number => {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (MAGICS.has(buf.readUInt32LE(i))) return i;
  }
  return -1;
};

/** Open a replay and read only far enough to see the first media frames. */
const observe = async (
  api: ReolinkBaichuanApi,
  label: string,
  fileName: string,
  wantFrames: number,
  rawMsgNum = 1,
): Promise<Observation> => {
  const obs: Observation = { label, ttfbMs: -1, bytes: 0, frames: [], rawFrames: [] };
  const t0 = Date.now();
  let acc = Buffer.alloc(0);
  let cursor = -1;
  const ABORT = "probe-enough";
  const tap = (f: { header: { cmdId: number; channelId: number; msgNum: number; responseCode: number; bodyLen: number } }): void => {
    if (f.header.cmdId !== 5) return;
    if (obs.rawFrames.length < 8)
      obs.rawFrames.push(`ch=${f.header.channelId} msg=${f.header.msgNum} rc=${f.header.responseCode} len=${f.header.bodyLen}`);
  };
  api.client.on("frame", tap as never);
  try {
    // Sent through the client directly, with msgNum 1 instead of the wrapper's
    // 0. The camera answers on msgNum 0 either way; the only thing this
    // changes is that BaichuanClient's `isHardError && msgNum === reqMsgNum`
    // guard cannot fire, so a stream the camera stamps with a non-zero
    // responseCode is READ instead of thrown away. Probe-only: the library is
    // untouched.
    await api.client.sendBinary({
      cmdId: 5,
      channel,
      msgNumOverride: rawMsgNum,
      payloadXml: buildFileInfoListReplayByIdXml({ channel, xmlChannelId: 0, id: fileName, streamType: "mainStream" }),
      streamType: 0,
      timeoutMs: 60_000,
      idleTimeoutMs: 4_000,
      onChunk: (chunk: Buffer) => {
        if (obs.ttfbMs < 0) obs.ttfbMs = Date.now() - t0;
        obs.bytes += chunk.length;
        acc = Buffer.concat([acc, chunk]);
        if (cursor < 0) {
          cursor = findMagic(acc, 0);
          if (cursor < 0) return;
        }
        for (;;) {
          const rest = acc.subarray(cursor);
          const r = parseBcMedia(rest);
          if (!r) return;
          const m = r.media;
          if (m.type === "InfoV1" || m.type === "InfoV2") {
            obs.info = `${m.type} ${m.videoWidth}x${m.videoHeight}@${m.fps} start=${m.startYear}-${m.startMonth}-${m.startDay} ${m.startHour}:${String(m.startMin).padStart(2, "0")}:${String(m.startSeconds).padStart(2, "0")} end=${m.endHour}:${String(m.endMin).padStart(2, "0")}:${String(m.endSeconds).padStart(2, "0")}`;
          } else if (m.type === "Iframe" || m.type === "Pframe") {
            obs.frames.push({
              kind: m.type,
              ...(m.type === "Iframe" && m.time !== undefined ? { time: m.time } : {}),
              micros: m.microseconds,
            });
          }
          cursor += r.consumed;
          if (obs.frames.length >= wantFrames && obs.info !== undefined) {
            throw new Error(ABORT);
          }
        }
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(ABORT)) obs.error = msg;
  } finally {
    api.client.off("frame", tap as never);
  }
  return obs;
};

const two = (n: number): string => String(n).padStart(2, "0");

/** cmd 123 <ReplaySeek>, verbatim in the shape the official app sends. */
const sendSeek = async (
  api: ReolinkBaichuanApi,
  at: Date,
  opts: { channelIdOverride?: number } = {},
): Promise<string> => {
  const payloadXml =
    `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<ReplaySeek version="1.1">\n` +
    `<channelId>${channel}</channelId>\n` +
    `<seq>${Math.floor(Date.now() / 1000)}</seq>\n` +
    `<seekTime>\n<year>${at.getFullYear()}</year>\n<month>${at.getMonth() + 1}</month>\n` +
    `<day>${at.getDate()}</day>\n<hour>${at.getHours()}</hour>\n` +
    `<minute>${at.getMinutes()}</minute>\n<second>${at.getSeconds()}</second>\n` +
    `</seekTime>\n</ReplaySeek>\n</body>\n`;
  // The app sends NO extension on cmd 123 (payloadOffset=0 in every capture).
  return await api.sendXml({
    cmdId: 123,
    extensionXml: "",
    ...(opts.channelIdOverride != null ? { channelIdOverride: opts.channelIdOverride } : {}),
    payloadXml,
    timeoutMs: 8_000,
  });
};

const show = (o: Observation): void => {
  console.log(
    `  ${o.label}\n    ttfb=${o.ttfbMs}ms bytes=${o.bytes}${o.error ? ` ERROR=${o.error}` : ""}\n` +
      `    ${o.info ?? "(no Info packet)"}\n` +
      `    frames: ${o.frames
        .slice(0, 6)
        .map((f) => `${f.kind}${f.time ? `@${new Date(f.time * 1000).toISOString().slice(11, 19)}Z(${f.time})` : ""}/us=${f.micros}`)
        .join(" ")}\n    wire: ${o.rawFrames.join(" | ")}`,
  );
};

await api.login();
const info = await api.getInfo();
console.log(`### slot=${slot} ch=${channel} ${info?.type} ${info?.firmwareVersion}\n`);

const now = new Date();
const start = new Date(now.getTime() - 24 * 3600 * 1000);
const clips = await api.getVideoclips({ channel, start, end: now, streamType: "mainStream" });
const withSpan = clips.filter(
  (c) => c.startTime && c.endTime && (c.endTime.getTime() - c.startTime.getTime()) / 1000 >= seekOffsetSec + 20,
);
console.log(`clips in 24h: ${clips.length}; long enough (> ${seekOffsetSec + 20}s): ${withSpan.length}`);
const clip = withSpan[withSpan.length - 1];
if (!clip) { console.log("no clip long enough — nothing to measure"); process.exit(0); }
const dur = (clip.endTime!.getTime() - clip.startTime!.getTime()) / 1000;
const ident = clip.id ?? clip.fileName;
console.log(`clip: ${ident}\n  start=${clip.startTime!.toISOString()} dur=${dur}s\n`);
await api.close({ reason: "probe: listing done" });

/** Every run gets a virgin session, so nothing it sees is inherited. */
const run = async (label: string, seekSec: number | null): Promise<void> => {
  const a = makeApi();
  try {
    await a.login();
    if (seekSec != null) {
      const at = new Date(clip.startTime!.getTime() + seekSec * 1000);
      const tSeek = Date.now();
      try {
        const reply = await sendSeek(a, at);
        console.log(`  seek -> ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())} (+${seekSec}s) rc=200 body=${reply.length}B in ${Date.now() - tSeek}ms`);
      } catch (e) {
        console.log(`  seek -> +${seekSec}s FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    show(await observe(a, label, ident, 4));
  } finally {
    await a.close({ reason: "probe: run done" }).catch(() => undefined);
  }
  await new Promise((r) => setTimeout(r, 1500));
};

const far = Math.min(Math.floor(dur) - 8, seekOffsetSec * 2);

await run("A baseline (no seek)", null);
await run(`B ReplaySeek +${seekOffsetSec}s`, seekOffsetSec);
if (far > seekOffsetSec + 5) await run(`C ReplaySeek +${far}s`, far);
await run("D baseline again (no seek)", null);

process.exit(0);
