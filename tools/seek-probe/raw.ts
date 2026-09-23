/**
 * Raw in-clip seek probe.
 *
 * The library aborts a replay whose chunks carry a responseCode in [400,60000)
 * — and a replay that FOLLOWS a cmd 123 `<ReplaySeek>` carries exactly that.
 * So this probe taps the socket itself, decrypts the chunks with the exported
 * crypto helpers, and reads the BcMedia timestamps that actually arrive.
 *
 * MEASUREMENT ONLY. No camera configuration is written, so nothing to restore.
 *
 * Usage: npx tsx tools/seek-probe/raw.ts <SLOT> <channel> <offsetSecA> <offsetSecB>
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
const offsets = process.argv.slice(4).map(Number);

const makeApi = (): ReolinkBaichuanApi =>
  new ReolinkBaichuanApi({
    host: process.env[`${slot}_HOST`] as string,
    port: 9000,
    username: process.env[`${slot}_USERNAME`] ?? "admin",
    password: process.env[`${slot}_PASSWORD`] ?? "",
    transport: "auto",
    ...(process.env[`${slot}_UID`] ? { uid: process.env[`${slot}_UID`] as string } : {}),
  });

const MAGICS = new Set<number>();
for (let i = 0x63643030; i <= 0x63643039; i++) MAGICS.add(i);
for (let i = 0x63643130; i <= 0x63643139; i++) MAGICS.add(i);
for (const m of [0x31303031, 0x32303031, 0x62773530, 0x62773130]) MAGICS.add(m);

const score = (b: Buffer): number => {
  let n = 0;
  for (let i = 0; i + 4 <= Math.min(b.length, 8192); i++) if (MAGICS.has(b.readUInt32LE(i))) n++;
  return n;
};

const looksLikeXml = (b: Buffer): boolean => {
  let i = 0;
  while (i < b.length && (b[i] === 0 || b[i] === 9 || b[i] === 10 || b[i] === 13 || b[i] === 32)) i++;
  return i < b.length && b[i] === 0x3c;
};

const decOne = (buf: Buffer, cid: number, enc: EncryptionProtocol): Buffer =>
  enc.kind === "none" ? buf : enc.kind === "bc" ? bcDecrypt(buf, cid) : aesDecrypt(buf, enc.key);

/** `decryptBinaryForReplay` from BaichuanClient, reproduced for the tap. */
const decrypt = (payload: Buffer, frameChannelId: number, enc: EncryptionProtocol, encryptLen?: number): Buffer => {
  if (encryptLen !== undefined && encryptLen > 0 && encryptLen < payload.length) {
    return Buffer.concat([decOne(payload.subarray(0, encryptLen), frameChannelId, enc), payload.subarray(encryptLen)]);
  }
  if (enc.kind !== "bc") {
    const d = decOne(payload, frameChannelId, enc);
    return score(payload) >= score(d) ? payload : d;
  }
  for (const cid of [frameChannelId, 250, 0, 1]) {
    const d = decOne(payload, cid, enc);
    if (d.length > 0 && !looksLikeXml(d)) return d;
  }
  return decOne(payload, frameChannelId, enc);
};

const two = (n: number): string => String(n).padStart(2, "0");

const sendSeek = async (api: ReolinkBaichuanApi, at: Date): Promise<number> => {
  const payloadXml =
    `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<ReplaySeek version="1.1">\n` +
    `<channelId>${channel}</channelId>\n<seq>${Math.floor(Date.now() / 1000)}</seq>\n` +
    `<seekTime>\n<year>${at.getFullYear()}</year>\n<month>${at.getMonth() + 1}</month>\n` +
    `<day>${at.getDate()}</day>\n<hour>${at.getHours()}</hour>\n` +
    `<minute>${at.getMinutes()}</minute>\n<second>${at.getSeconds()}</second>\n` +
    `</seekTime>\n</ReplaySeek>\n</body>\n`;
  const t = Date.now();
  await api.sendXml({ cmdId: 123, extensionXml: "", payloadXml, timeoutMs: 8_000 });
  return Date.now() - t;
};

interface Run {
  label: string;
  seekSec: number | null;
  ttfbMs: number;
  bytes: number;
  rcs: Set<number>;
  info?: string;
  iframeTimes: number[];
  dumped: number;
  reframed: number;
  firstMicros?: number;
  lastMicros?: number;
  videoType?: string;
}

const run = async (label: string, ident: string, clipStart: Date, seekSec: number | null, holdMs: number): Promise<Run> => {
  const api = makeApi();
  const r: Run = { label, seekSec, ttfbMs: -1, bytes: 0, rcs: new Set(), iframeTimes: [], dumped: 0, reframed: 0 };
  let t0 = 0;
  const tap = (f: {
    header: { cmdId: number; channelId: number; responseCode: number; messageClass: number; payloadOffset?: number };
    payload: Buffer;
    extension: Buffer;
    body: Buffer;
  }): void => {
    if (f.header.cmdId !== 5) return;
    r.rcs.add(f.header.responseCode);
    const enc = api.client.enc;
    const body = Buffer.from(f.body);
    let ext: Buffer;
    let pay: Buffer;
    if (f.header.payloadOffset === undefined && body.length >= 4) {
      // The parser did not recognise this messageClass and read a 20-byte
      // header, so `body` still begins with the 24-byte header's
      // payloadOffset field. Put the frame back together.
      const off = body.readUInt32LE(0);
      if (off < 0 || off + 4 > body.length) return;
      ext = body.subarray(4, 4 + off);
      pay = body.subarray(4 + off);
      r.reframed++;
    } else {
      ext = Buffer.from(f.extension);
      pay = Buffer.from(f.payload);
    }
    let encryptLen: number | undefined;
    let markedBinary = false;
    if (ext.length > 0) {
      const x = api.client.tryDecryptXml(ext, f.header.channelId, enc);
      if (x.includes("<binaryData>1</binaryData>")) markedBinary = true;
      const m = /<encryptLen>(\d+)<\/encryptLen>/i.exec(x);
      if (m?.[1]) encryptLen = Number(m[1]);
    }
    const dec = decrypt(pay, f.header.channelId, enc, encryptLen);
    if (dec.length === 0) return;
    if (!markedBinary && looksLikeXml(dec)) return;
    if (r.ttfbMs < 0) r.ttfbMs = Date.now() - t0;
    r.bytes += dec.length;
    if (process.env.DUMP && r.dumped < 4) {
      r.dumped++;
      console.log(`      [f${r.dumped}] rc=${f.header.responseCode} pay=${pay.length} encLen=${encryptLen ?? "-"} dec[0..32]=${dec.subarray(0, 32).toString("hex")}`);
    }
    // Read the BcMedia packet header at the START of this frame. Payloads span
    // frames so a full parse is impossible here, but the header carries what
    // the question needs: packet type and wall-clock time.
    if (dec.length >= 32 && MAGICS.has(dec.readUInt32LE(0))) {
      const magic = dec.readUInt32LE(0);
      if (magic === 0x31303031 || magic === 0x32303031) {
        r.info = `Info ${dec.readUInt32LE(8)}x${dec.readUInt32LE(12)}@${dec[17]} file ${two(dec[21]!)}:${two(dec[22]!)}:${two(dec[23]!)}->${two(dec[27]!)}:${two(dec[28]!)}:${two(dec[29]!)}`;
      } else if (magic >= 0x63643030 && magic <= 0x63643139) {
        const kind = magic <= 0x63643039 ? "I" : "P";
        const addHdr = dec.readUInt32LE(12);
        const micros = dec.readUInt32LE(16);
        const time = addHdr >= 4 ? dec.readUInt32LE(24) : undefined;
        r.videoType = dec.toString("utf8", 4, 8);
        if (kind === "I" && time !== undefined) r.iframeTimes.push(time);
        if (r.firstMicros === undefined) r.firstMicros = micros;
        r.lastMicros = micros;
      }
    }
  };
  try {
    await api.login();
    if (seekSec != null) {
      const at = new Date(clipStart.getTime() + seekSec * 1000);
      const ms = await sendSeek(api, at);
      console.log(`  seek -> ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())} (+${seekSec}s) accepted in ${ms}ms`);
    }
    api.client.on("frame", tap as never);
    t0 = Date.now();
    await api.client
      .sendBinary({
        cmdId: 5,
        channel,
        msgNumOverride: 0,
        payloadXml: buildFileInfoListReplayByIdXml({ channel, xmlChannelId: 0, id: ident, streamType: "mainStream" }),
        streamType: 0,
        timeoutMs: 30_000,
        idleTimeoutMs: 3_000,
      })
      .catch(() => undefined); // the library's own guard may abort; the tap keeps reading
    await new Promise((res) => setTimeout(res, holdMs));
  } finally {
    api.client.off("frame", tap as never);
    await api.close({ reason: "probe done" }).catch(() => undefined);
  }
  return r;
};

const show = (r: Run, clipStart: Date): void => {
  const first = r.iframeTimes[0];
  const rel = first === undefined ? null : Math.round(first - Math.floor(clipStart.getTime() / 1000));
  console.log(
    `  ${r.label}\n` +
      `    ttfb=${r.ttfbMs}ms media=${r.bytes}B rc={${[...r.rcs].join(",")}} reframed=${r.reframed} ${r.videoType ?? ""}\n` +
      `    ${r.info ?? "(no Info packet)"}\n` +
      `    first I-frame t=${first ?? "none"}  => ${rel === null ? "n/a" : `${rel >= 0 ? "+" : ""}${rel}s into the clip`}   (asked +${r.seekSec ?? 0}s)\n` +
      `    I-frames seen: ${r.iframeTimes.length}  micros ${r.firstMicros} -> ${r.lastMicros} (span ${r.firstMicros !== undefined && r.lastMicros !== undefined ? ((r.lastMicros - r.firstMicros) / 1e6).toFixed(2) : "?"}s)`,
  );
};

const api0 = makeApi();
await api0.login();
const info = await api0.getInfo();
console.log(`### slot=${slot} ch=${channel} ${info?.type} ${info?.firmwareVersion}\n`);
const now = new Date();
const clips = await api0.getVideoclips({ channel, start: new Date(now.getTime() - 24 * 3600 * 1000), end: now, streamType: "mainStream" });
const need = Math.max(...offsets, 0) + 15;
const long = clips.filter((c) => c.startTime && c.endTime && (c.endTime.getTime() - c.startTime.getTime()) / 1000 >= need);
console.log(`clips=${clips.length} long enough (>=${need}s)=${long.length}`);
const clip = long[long.length - 1];
if (!clip) { console.log("no clip long enough"); process.exit(0); }
const ident = clip.id ?? clip.fileName;
const dur = (clip.endTime!.getTime() - clip.startTime!.getTime()) / 1000;
console.log(`clip ${ident}\n  local start ${two(clip.startTime!.getHours())}:${two(clip.startTime!.getMinutes())}:${two(clip.startTime!.getSeconds())} dur=${dur}s\n`);
await api0.close({ reason: "listing done" });

show(await run("A baseline (no seek)", ident, clip.startTime!, null, 3000), clip.startTime!);
for (const o of offsets) {
  show(await run(`B ReplaySeek +${o}s`, ident, clip.startTime!, o, 3000), clip.startTime!);
}
show(await run("Z baseline again (no seek)", ident, clip.startTime!, null, 3000), clip.startTime!);
process.exit(0);
