/**
 * Lifecycle half of the in-clip seek probe:
 *  1. is a `<ReplaySeek>` STICKY on the connection (does it poison the next,
 *     unrelated replay that asks for no seek)?
 *  2. does a seek sent WHILE a replay is streaming move it in place, or does
 *     it take effect only on the next cmd 5 open?
 *
 * MEASUREMENT ONLY — no camera configuration is written.
 * Usage: npx tsx tools/seek-probe/lifecycle.ts <SLOT> <channel> <offsetSec>
 */
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { buildFileInfoListReplayByIdXml } from "../../src/reolink/baichuan/utils/recordingReplay";
import { bcDecrypt, aesDecrypt } from "../../src/protocol/crypto";
import type { EncryptionProtocol } from "../../src/protocol/crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
const slot = process.argv[2] ?? "TCP";
const channel = Number(process.argv[3] ?? "0");
const offsetSec = Number(process.argv[4] ?? "40");

const makeApi = (): ReolinkBaichuanApi => new ReolinkBaichuanApi({
  host: process.env[`${slot}_HOST`] as string,
  port: 9000,
  username: process.env[`${slot}_USERNAME`] ?? "admin",
  password: process.env[`${slot}_PASSWORD`] ?? "",
  transport: "auto",
  ...(process.env[`${slot}_UID`] ? { uid: process.env[`${slot}_UID`] as string } : {}),
});

let api = makeApi();

/** A brand-new socket: a seek is sticky, so a reused one proves nothing. */
const reconnect = async (): Promise<void> => {
  api.client.off("frame", tap as never);
  await api.close({ reason: "probe: fresh socket" }).catch(() => undefined);
  api = makeApi();
  await api.login();
  api.client.on("frame", tap as never);
};

const MAGICS = new Set<number>();
for (let i = 0x63643030; i <= 0x63643139; i++) MAGICS.add(i);
for (const m of [0x31303031, 0x32303031, 0x62773530, 0x62773130]) MAGICS.add(m);
const decOne = (b: Buffer, cid: number, e: EncryptionProtocol): Buffer =>
  e.kind === "none" ? b : e.kind === "bc" ? bcDecrypt(b, cid) : aesDecrypt(b, e.key);

/** Every I-frame wall-clock this tap sees, in order. */
const times: { at: number; t: number; label: string }[] = [];
let label = "";
const tap = (f: {
  header: { cmdId: number; channelId: number; payloadOffset?: number };
  body: Buffer;
}): void => {
  if (f.header.cmdId !== 5) return;
  const body = Buffer.from(f.body);
  let ext: Buffer;
  let pay: Buffer;
  if (f.header.payloadOffset === undefined && body.length >= 4) {
    const off = body.readUInt32LE(0);
    if (off < 0 || off + 4 > body.length) return;
    ext = body.subarray(4, 4 + off);
    pay = body.subarray(4 + off);
  } else {
    const off = f.header.payloadOffset ?? 0;
    ext = body.subarray(0, off);
    pay = body.subarray(off);
  }
  let encryptLen: number | undefined;
  if (ext.length > 0) {
    const m = /<encryptLen>(\d+)<\/encryptLen>/i.exec(
      api.client.tryDecryptXml(ext, f.header.channelId, api.client.enc),
    );
    if (m?.[1]) encryptLen = Number(m[1]);
  }
  const enc = api.client.enc;
  const dec =
    encryptLen !== undefined && encryptLen > 0 && encryptLen < pay.length
      ? Buffer.concat([decOne(pay.subarray(0, encryptLen), f.header.channelId, enc), pay.subarray(encryptLen)])
      : pay;
  if (dec.length < 32 || !MAGICS.has(dec.readUInt32LE(0))) return;
  const magic = dec.readUInt32LE(0);
  if (magic >= 0x63643030 && magic <= 0x63643039 && dec.readUInt32LE(12) >= 4) {
    times.push({ at: Date.now(), t: dec.readUInt32LE(24), label });
  }
};

const two = (n: number): string => String(n).padStart(2, "0");
const sendSeek = async (at: Date): Promise<void> => {
  await api.sendXml({
    cmdId: 123,
    extensionXml: "",
    payloadXml:
      `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<ReplaySeek version="1.1">\n<channelId>${channel}</channelId>\n` +
      `<seq>${Math.floor(Date.now() / 1000)}</seq>\n<seekTime>\n<year>${at.getFullYear()}</year>\n` +
      `<month>${at.getMonth() + 1}</month>\n<day>${at.getDate()}</day>\n<hour>${at.getHours()}</hour>\n` +
      `<minute>${at.getMinutes()}</minute>\n<second>${at.getSeconds()}</second>\n</seekTime>\n</ReplaySeek>\n</body>\n`,
    timeoutMs: 8000,
  });
};

const replay = (ident: string): Promise<unknown> =>
  api.client
    .sendBinary({
      cmdId: 5,
      channel,
      msgNumOverride: 0,
      payloadXml: buildFileInfoListReplayByIdXml({ channel, xmlChannelId: 0, id: ident, streamType: "mainStream" }),
      streamType: 0,
      timeoutMs: 20_000,
      idleTimeoutMs: 2_000,
    })
    .catch(() => undefined);

await api.login();
const info = await api.getInfo();
console.log(`### slot=${slot} ch=${channel} ${info?.type} ${info?.firmwareVersion}`);
const now = new Date();
const clips = await api.getVideoclips({ channel, start: new Date(now.getTime() - 24 * 3600 * 1000), end: now, streamType: "mainStream" });
const long = clips.filter((c) => c.startTime && c.endTime && (c.endTime.getTime() - c.startTime.getTime()) / 1000 >= offsetSec + 15);
const clip = long[long.length - 1];
if (!clip) { console.log("no clip long enough"); process.exit(0); }
const ident = clip.id ?? clip.fileName;
const base = Math.floor(clip.startTime!.getTime() / 1000);
console.log(`clip ${ident} dur=${(clip.endTime!.getTime() - clip.startTime!.getTime()) / 1000}s\n`);

api.client.on("frame", tap as never);
const rel = (t: number): string => `${t - base - 7200 >= 0 ? "+" : ""}${t - base - 7200}s`;
const report = (l: string): void => {
  const mine = times.filter((x) => x.label === l);
  console.log(`  ${l}: ${mine.length} I-frames, first ${mine[0] ? rel(mine[0].t) : "none"}, last ${mine.at(-1) ? rel(mine.at(-1)!.t) : "none"}`);
};

// ---- 1. is the seek sticky on this connection? ----
console.log("1) sticky test — one connection throughout");
label = "1a reference (no seek)";
await replay(ident); await new Promise((r) => setTimeout(r, 2500)); report(label);
const at = new Date(clip.startTime!.getTime() + offsetSec * 1000);
console.log(`   seek -> ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())} (+${offsetSec}s)`);
await sendSeek(at);
label = `1b right after the seek`;
await replay(ident); await new Promise((r) => setTimeout(r, 2500)); report(label);
label = "1c next replay, NO new seek";
await replay(ident); await new Promise((r) => setTimeout(r, 2500)); report(label);

// ---- 2. seek while a replay is streaming ----
// A VIRGIN connection: part 1 just proved a seek is sticky, so reusing that
// socket would start this stream at the seek point and prove nothing.
await reconnect();
console.log("\n2) in-place test — seek sent DURING an open replay, on a FRESH connection");
label = "2z sanity: fresh connection, no seek";
await replay(ident); await new Promise((r) => setTimeout(r, 2500)); report(label);
await reconnect();
label = "2a stream, seek injected at ~700ms";
const p = replay(ident);
setTimeout(() => { void sendSeek(at); console.log(`   seek injected mid-stream -> +${offsetSec}s`); }, 700);
await p;
await new Promise((r) => setTimeout(r, 2500));
const mine = times.filter((x) => x.label === label);
console.log(`  ${label}: ${mine.length} I-frames  ${mine.slice(0, 3).map((x) => rel(x.t)).join(",")} ... ${mine.slice(-3).map((x) => rel(x.t)).join(",")}`);
const jump = mine.findIndex((x, i) => i > 0 && x.t - mine[i - 1]!.t > 5);
console.log(`  discontinuity > 5s inside the stream: ${jump < 0 ? "NONE (the open transfer kept playing straight through)" : `at index ${jump}: ${rel(mine[jump - 1]!.t)} -> ${rel(mine[jump]!.t)}`}`);

api.client.off("frame", tap as never);
await api.close({ reason: "probe done" });
process.exit(0);
