import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDecipheriv } from "node:crypto";
import zlib from "node:zlib";

// Load environment variables from .env when running this test script.
// This lets us derive the Baichuan AES key (nonce-password) to decrypt captured XML.
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

type SessionEnc =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "bc" }
  | { kind: "aes"; key: Buffer; mode: "aes" | "full_aes" };

type SessionInfo = { enc: SessionEnc; nonce?: string; encType?: number };

let globalSession: SessionInfo | undefined;

function parseEnvSessionOverride(): SessionInfo | undefined {
  const nonce = process.env.BAICHUAN_NONCE?.trim();
  const encTypeRaw = process.env.BAICHUAN_ENC_TYPE?.trim();
  if (!nonce || !encTypeRaw) return undefined;

  const encType = encTypeRaw.startsWith("0x") || encTypeRaw.startsWith("0X") ? parseInt(encTypeRaw, 16) : parseInt(encTypeRaw, 10);
  if (!Number.isFinite(encType)) return undefined;

  if (encType === 0x00) return { enc: { kind: "none" }, nonce, encType };
  if (encType === 0x01) return { enc: { kind: "bc" }, nonce, encType };

  const password = process.env.BAICHUAN_PASSWORD ?? process.env.NVR_PASSWORD ?? process.env.TCP_PASSWORD;
  if (!password) return { enc: { kind: "unknown" }, nonce, encType };

  const md5HexUpper = (input: string): string => createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
  const md5StrModern = (input: string): string => md5HexUpper(input).slice(0, 31);
  const keyStr = md5StrModern(`${nonce}-${password}`).slice(0, 16);
  const key = Buffer.from(keyStr, "utf8");

  if (encType === 0x02) return { enc: { kind: "aes", key, mode: "aes" }, nonce, encType };
  if (encType === 0x12) return { enc: { kind: "aes", key, mode: "full_aes" }, nonce, encType };

  return { enc: { kind: "unknown" }, nonce, encType };
}

function detectSessionFromFrames(frames: BaichuanFrame[]): SessionInfo {
  const md5HexUpper = (input: string): string => createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
  const md5StrModern = (input: string): string => md5HexUpper(input).slice(0, 31);
  const deriveAesKey = (nonce: string, password: string): Buffer => {
    const keyStr = md5StrModern(`${nonce}-${password}`).slice(0, 16);
    return Buffer.from(keyStr, "utf8");
  };

  const bcXor = (buf: Buffer, offset: number): Buffer => {
    // Same XOR as bcDecrypt/bcEncrypt in src/protocol/crypto.ts
    const key = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];
    const off = offset & 0xff;
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i]! ^ key[(off + i) % key.length]! ^ off;
    }
    return out;
  };

  const xmlText = (xml: string, tagName: string): string | undefined => {
    const re = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, "i");
    return re.exec(xml)?.[1];
  };

  // Look for the legacy login reply: cmdId=1, responseCode 0xDDxx, body contains <Encryption><nonce>...</nonce>
  for (const f of frames) {
    if (f.header.cmdId !== 1) continue;
    const resp = f.header.responseCode;
    if (((resp >>> 8) & 0xff) !== 0xdd) continue;
    if (f.body.length === 0) continue;

    const encType = resp & 0xff;
    const preferred = encType === 0x00 ? "none" : "bc";
    const xml =
      (preferred === "none" ? f.body.toString("utf8") : bcXor(Buffer.from(f.body), f.header.channelId).toString("utf8")) ||
      f.body.toString("utf8");
    const nonce = xmlText(xml, "nonce");
    if (!nonce) continue;

    if (encType === 0x00) return { enc: { kind: "none" }, nonce, encType };
    if (encType === 0x01) return { enc: { kind: "bc" }, nonce, encType };

    const password = process.env.BAICHUAN_PASSWORD ?? process.env.NVR_PASSWORD ?? process.env.TCP_PASSWORD;
    if (!password) return { enc: { kind: "unknown" }, nonce, encType };

    if (encType === 0x02) return { enc: { kind: "aes", key: deriveAesKey(nonce, password), mode: "aes" }, nonce, encType };
    if (encType === 0x12) return { enc: { kind: "aes", key: deriveAesKey(nonce, password), mode: "full_aes" }, nonce, encType };

    return { enc: { kind: "unknown" }, nonce, encType };
  }

  return { enc: { kind: "unknown" } };
}

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { BaichuanFrameParser, BcMediaCodec } from "../../index.js";
import type { BaichuanFrame } from "../../src/protocol/framing";
import type { BcMedia } from "../../src/baichuan/stream/BcMediaParser";

type Endian = "le" | "be";

// Reuse the same BCUDP XOR keystream used in the UDP probe.
// This is a best-effort heuristic: some UDP/7777 payloads look BCUDP-related.
const BCUDP_XML_KEY_U32 = Uint32Array.from([
  0x1f2d3c4b, 0x5a6c7f8d, 0x38172e4b, 0x8271635a, 0x863f1a2b, 0xa5c6f7d8, 0x8371e1b4, 0x17f2d3a5,
]);

function* bcudpXmlKeystream(offset: number): Generator<number, void, void> {
  let idx = 0;
  while (true) {
    const word = (BCUDP_XML_KEY_U32[idx % BCUDP_XML_KEY_U32.length]! + (offset >>> 0)) >>> 0;
    yield word & 0xff;
    yield (word >>> 8) & 0xff;
    yield (word >>> 16) & 0xff;
    yield (word >>> 24) & 0xff;
    idx++;
  }
}

function bcudpXmlDecrypt(tid: number, enc: Buffer): Buffer {
  const out = Buffer.allocUnsafe(enc.length);
  const ks = bcudpXmlKeystream(tid >>> 0);
  for (let i = 0; i < enc.length; i++) out[i] = enc[i]! ^ (ks.next().value as number);
  return out;
}

let crcTable: Uint32Array | undefined;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function crc32ReolinkInit0(buf: Buffer): number {
  // Matches bcudpCrc32() in the UDP probe (init=0, no final xor)
  const t = getCrcTable();
  let crc = 0x00000000;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    crc = (t[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

function crc32Standard(buf: Buffer): number {
  // Standard CRC-32 (Ethernet) style: init=0xFFFFFFFF, final xor=0xFFFFFFFF
  const t = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    crc = (t[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type Udp7777Parsed = {
  magicLE?: number;
  dataLen?: number;
  seq?: number;
  uid?: string;
  headerLen?: number;
  dataHeadHex?: string;
  dataTailHex?: string;
  decodedPreview?: string;
  inflatedPreview?: string;
  checksumHint?: string;
  note?: string;
};

function parseUdp7777(payload: Buffer): Udp7777Parsed {
  if (payload.length < 16) return { note: "too_short" };

  const magicLE = payload.readUInt32LE(0);
  const dataLen = payload.readUInt32LE(4);
  const seq = payload.readUInt32LE(8);
  const headerLen = payload.length - dataLen;

  // UID/serial-like ASCII is typically at offset 12 and null-padded.
  const uidRaw = payload.subarray(12, Math.min(payload.length, 12 + 32));
  const nul = uidRaw.indexOf(0);
  const uid = (nul >= 0 ? uidRaw.subarray(0, nul) : uidRaw).toString("ascii");

  // Data is typically at offset=headerLen (often 44 bytes).
  const data = headerLen >= 0 && headerLen <= payload.length ? payload.subarray(headerLen) : Buffer.alloc(0);
  const dataHeadHex = data.subarray(0, Math.min(24, data.length)).toString("hex");
  const dataTailHex = data.subarray(Math.max(0, data.length - 16)).toString("hex");

  // Heuristic: try BCUDP XOR decrypt using a few candidate offsets.
  let decodedPreview: string | undefined;
  if (data.length > 0 && data.length <= 512) {
    const candidates = [seq >>> 0, 0, (seq - 1) >>> 0, (seq + 1) >>> 0];
    for (const tid of candidates) {
      const plain = bcudpXmlDecrypt(tid, data);
      const text = plain.toString("utf8");
      if (text.includes("<?xml") || text.includes("<Alarm") || text.includes("<body") || text.includes("<Event") || text.includes("<PIR")) {
        decodedPreview = text.length > 300 ? `${text.slice(0, 300)}...` : text;
        break;
      }
    }
  }

  // Heuristic: try zlib inflate (some firmwares compress event payloads).
  let inflatedPreview: string | undefined;
  if (!decodedPreview && data.length > 8 && data.length <= 4096) {
    const tryInflate = (fn: (b: Buffer) => Buffer): void => {
      try {
        const out = fn(data);
        const txt = out.toString("utf8");
        if (txt.includes("<?xml") || txt.includes("<Alarm") || txt.includes("<body") || txt.includes("<Event") || txt.includes("PIR")) {
          inflatedPreview = txt.length > 300 ? `${txt.slice(0, 300)}...` : txt;
        }
      } catch {
        // ignore
      }
    };
    tryInflate((b) => zlib.inflateSync(b));
    if (!inflatedPreview) tryInflate((b) => zlib.inflateRawSync(b));
  }

  // Heuristic: attempt to validate a checksum if the data is long enough.
  // We don't yet know where the checksum is stored; try common placements.
  let checksumHint: string | undefined;
  if (data.length >= 8) {
    const tailU32 = data.readUInt32LE(data.length - 4) >>> 0;
    const core = data.subarray(0, data.length - 4);

    const r0 = crc32ReolinkInit0(core);
    const s0 = crc32Standard(core);
    if (tailU32 === r0) checksumHint = `data_tail=crc32_reolink(init0,core)`;
    else if (tailU32 === s0) checksumHint = `data_tail=crc32_standard(core)`;
    else {
      // Maybe checksum covers full packet minus 4 bytes.
      const pktCore = payload.subarray(0, payload.length - 4);
      const pktTail = payload.readUInt32LE(payload.length - 4) >>> 0;
      const pr0 = crc32ReolinkInit0(pktCore);
      const ps0 = crc32Standard(pktCore);
      if (pktTail === pr0) checksumHint = `pkt_tail=crc32_reolink(init0,pktCore)`;
      else if (pktTail === ps0) checksumHint = `pkt_tail=crc32_standard(pktCore)`;
    }
  }

  const out: Udp7777Parsed = { magicLE, dataLen, seq, uid, headerLen, dataHeadHex, dataTailHex };
  if (decodedPreview) out.decodedPreview = decodedPreview;
  if (inflatedPreview) out.inflatedPreview = inflatedPreview;
  if (checksumHint) out.checksumHint = checksumHint;
  return out;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function topN<K>(
  byBytes: Map<K, number>,
  byPackets: Map<K, number>,
  n: number,
): Array<{ key: K; bytes: number; packets: number }> {
  const out: Array<{ key: K; bytes: number; packets: number }> = [];
  for (const [key, bytes] of byBytes.entries()) {
    out.push({ key, bytes, packets: byPackets.get(key) ?? 0 });
  }
  out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  return out.slice(0, n);
}

function previewAscii(buf: Buffer): string {
  const chars: string[] = [];
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) chars.push(String.fromCharCode(b));
    else chars.push(".");
  }
  return chars.join("");
}

function hexPreview(buf: Buffer, maxBytes = 256): string {
  const max = Math.min(buf.length, maxBytes);
  const lines: string[] = [];
  for (let off = 0; off < max; off += 16) {
    const chunk = buf.subarray(off, Math.min(off + 16, max));
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = previewAscii(chunk);
    lines.push(`${off.toString(16).padStart(4, "0")}: ${hex.padEnd(16 * 3 - 1, " ")}  |${ascii}|`);
  }
  return lines.join("\n");
}

function guessProtocolFromTcpPrefix(buf: Buffer): string | undefined {
  if (buf.length < 4) return undefined;
  // TLS ClientHello/ServerHello: 0x16 0x03 0x01/0x03/0x02...
  if (buf[0] === 0x16 && buf[1] === 0x03) return "TLS handshake";
  const s = buf.subarray(0, Math.min(buf.length, 12)).toString("utf8");
  if (s.startsWith("GET ") || s.startsWith("POST ") || s.startsWith("HTTP/")) return "HTTP";
  return undefined;
}

function extractSrcDstIpFromDirKey(dirKey: string): { srcIp: string; dstIp: string } | undefined {
  const m = /^(\d+\.\d+\.\d+\.\d+):\d+ -> (\d+\.\d+\.\d+\.\d+):\d+$/.exec(dirKey.trim());
  if (!m) return undefined;
  return { srcIp: m[1]!, dstIp: m[2]! };
}

type LenTypeRecord = { len: number; type: number };

type LenTypeRecordWithPayload = { off: number; len: number; type: number; payload: Buffer };

function tryParseLenTypeRecords(data: Buffer): LenTypeRecord[] | undefined {
  // Observed on hub<->battery (TCP/6666):
  // u32le magic=0x0001000c, u32le payloadLen, u32le type, then payloadLen bytes.
  // So recordTotalLen = 12 + payloadLen.
  if (data.length < 12) return undefined;
  const magic = data.readUInt32LE(0);
  if (magic !== 0x0001000c) return undefined;

  const records: LenTypeRecord[] = [];
  let off = 0;
  while (off + 12 <= data.length) {
    const m = data.readUInt32LE(off);
    if (m !== 0x0001000c) break;
    const payloadLen = data.readUInt32LE(off + 4);
    const type = data.readUInt32LE(off + 8);
    // 0 is allowed (header-only)
    const totalLen = 12 + payloadLen;
    if (totalLen < 12) break;
    if (off + totalLen > data.length) break;
    records.push({ len: payloadLen, type });
    off += totalLen;
  }
  return records.length > 0 ? records : undefined;
}

function findLenTypeRecordsAnywhere(data: Buffer, maxRecords = 500): LenTypeRecordWithPayload[] {
  const magic = 0x0001000c;
  const records: LenTypeRecordWithPayload[] = [];
  let off = 0;

  const tryParseSequenceAt = (start: number): { records: LenTypeRecordWithPayload[]; end: number } | undefined => {
    let cur = start;
    const out: LenTypeRecordWithPayload[] = [];
    while (cur + 12 <= data.length) {
      if (data.readUInt32LE(cur) !== magic) break;
      const payloadLen = data.readUInt32LE(cur + 4);
      const type = data.readUInt32LE(cur + 8);
      const totalLen = 12 + payloadLen;
      if (totalLen < 12) break;
      if (cur + totalLen > data.length) break;
      const payload = data.subarray(cur + 12, cur + totalLen);
      out.push({ off: cur, len: payloadLen, type, payload });
      cur += totalLen;
      if (out.length >= maxRecords) break;
    }
    if (out.length === 0) return undefined;
    return { records: out, end: cur };
  };

  while (off + 12 <= data.length && records.length < maxRecords) {
    if (data.readUInt32LE(off) !== magic) {
      off++;
      continue;
    }
    const parsed = tryParseSequenceAt(off);
    if (!parsed) {
      off++;
      continue;
    }
    for (const r of parsed.records) records.push(r);
    off = Math.max(parsed.end, off + 1);
  }

  return records;
}

function scanForPrivateIpv4InBinary(buf: Buffer, limit = 32): string[] {
  const found = new Set<string>();
  for (let i = 0; i + 4 <= buf.length; i++) {
    const ip = ipToString(buf, i);
    if (isPrivateIpv4(ip)) {
      found.add(ip);
      if (found.size >= limit) break;
    }
  }
  return [...found.values()];
}

function scanForU16Value(buf: Buffer, value: number, endian: Endian, limit = 20): number[] {
  const offs: number[] = [];
  for (let i = 0; i + 2 <= buf.length; i++) {
    const v = endian === "le" ? buf.readUInt16LE(i) : buf.readUInt16BE(i);
    if (v === value) {
      offs.push(i);
      if (offs.length >= limit) break;
    }
  }
  return offs;
}

function scanForAsciiTokens(buf: Buffer, minLen = 8, limit = 20): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.length >= minLen) out.push(cur);
    cur = "";
  };
  for (const b of buf) {
    const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    if (isAlnum) {
      cur += String.fromCharCode(b);
      if (cur.length > 64) push();
    } else {
      push();
      if (out.length >= limit) break;
    }
  }
  push();
  return out.slice(0, limit);
}

function isHexUpper(s: string): boolean {
  return /^[0-9A-F]+$/.test(s);
}

function parseMacUidToken(token: string): { macHex?: string; uid?: string } {
  // Observed in 6666 prefix: "EC71DB72BBFE9527000HXOHJ142G" (12 hex chars + 16 char UID)
  if (token.length < 12 + 16) return {};
  const macHex = token.slice(0, 12);
  const rest = token.slice(12);
  const uid = rest.slice(0, 16);
  if (!isHexUpper(macHex)) return {};
  // UID seems alnum; keep it loose.
  if (!/^[0-9A-Za-z]{16}$/.test(uid)) return { macHex };
  return { macHex, uid };
}

function ipv4ToBytes(ip: string): Buffer | undefined {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return undefined;
  return Buffer.from(parts.map((n) => n & 0xff));
}

function findAllOccurrences(hay: Buffer, needle: Buffer, limit = 20): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let off = 0;
  while (off + needle.length <= hay.length) {
    const idx = hay.indexOf(needle, off);
    if (idx < 0) break;
    out.push(idx);
    if (out.length >= limit) break;
    off = idx + 1;
  }
  return out;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, obj: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function readU32(buf: Buffer, offset: number, endian: Endian): number {
  return endian === "le" ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function readU16(buf: Buffer, offset: number, endian: Endian): number {
  return endian === "le" ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

function ipToString(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

type TcpSegment = {
  seq: number;
  tsMs: number;
  payload: Buffer;
};

type Tcp6666RecordEvent = {
  dirKey: string;
  tsMs: number;
  streamOff: number;
  type: number;
  len: number;
};

function reassembleTcpSegments(segments: TcpSegment[]): { data: Buffer; gaps: number } {
  if (segments.length === 0) return { data: Buffer.alloc(0), gaps: 0 };

  const sorted = [...segments].sort((a, b) => a.seq - b.seq);

  let gaps = 0;
  let currentSeq = sorted[0]!.seq;
  const chunks: Buffer[] = [];

  for (const seg of sorted) {
    if (seg.payload.length === 0) continue;

    if (seg.seq > currentSeq) {
      // Missing bytes in capture; stop here to avoid feeding broken data.
      gaps += 1;
      break;
    }

    const overlap = currentSeq - seg.seq;
    if (overlap >= seg.payload.length) continue;
    const toAppend = overlap > 0 ? seg.payload.subarray(overlap) : seg.payload;
    if (toAppend.length > 0) {
      chunks.push(toAppend);
      currentSeq += toAppend.length;
    }
  }

  return { data: Buffer.concat(chunks), gaps };
}

function parse6666RecordsFromSegments(dirKey: string, segments: TcpSegment[], maxEvents = 5000): {
  prefix: Buffer;
  events: Tcp6666RecordEvent[];
} {
  const magicBytes = Buffer.from([0x0c, 0x00, 0x01, 0x00]); // u32le 0x0001000c
  const sorted = [...segments].filter((s) => s.payload.length > 0).sort((a, b) => a.seq - b.seq);

  if (sorted.length === 0) return { prefix: Buffer.alloc(0), events: [] };

  let expectedSeq = sorted[0]!.seq;

  let streamOff = 0;
  let buf = Buffer.alloc(0);
  const prefixChunks: Buffer[] = [];
  let prefixCaptured = 0;
  const events: Tcp6666RecordEvent[] = [];

  const capPrefix = (b: Buffer) => {
    if (prefixCaptured >= 512) return;
    const take = b.subarray(0, Math.min(b.length, 512 - prefixCaptured));
    if (take.length > 0) {
      prefixChunks.push(take);
      prefixCaptured += take.length;
    }
  };

  for (const seg of sorted) {
    // Align like reassembly: skip overlaps/retransmits so streamOff matches reassembled offsets.
    let payload = seg.payload;
    if (seg.seq > expectedSeq) {
      // Gap: we can't recover missing bytes; advance streamOff and drop any partial buffer.
      const gap = seg.seq - expectedSeq;
      streamOff += gap;
      buf = Buffer.alloc(0);
      expectedSeq = seg.seq;
    } else if (seg.seq < expectedSeq) {
      const overlap = expectedSeq - seg.seq;
      if (overlap >= payload.length) continue;
      payload = payload.subarray(overlap);
    }
    expectedSeq += payload.length;

    buf = buf.length === 0 ? payload : Buffer.concat([buf, payload]);

    while (buf.length >= 12) {
      const idx = buf.indexOf(magicBytes);
      if (idx < 0) {
        // keep last 3 bytes in case magic spans boundary
        const keep = Math.min(3, buf.length);
        const drop = buf.length - keep;
        if (drop > 0) {
          capPrefix(buf.subarray(0, drop));
          streamOff += drop;
          buf = buf.subarray(drop);
        }
        break;
      }

      if (idx > 0) {
        capPrefix(buf.subarray(0, idx));
        streamOff += idx;
        buf = buf.subarray(idx);
        if (buf.length < 12) break;
      }

      // Now magic at buf[0]
      const payloadLen = buf.readUInt32LE(4);
      const type = buf.readUInt32LE(8);
      const totalLen = 12 + payloadLen;
      if (totalLen < 12) {
        // desync; drop 1 byte and rescan
        capPrefix(buf.subarray(0, 1));
        streamOff += 1;
        buf = buf.subarray(1);
        continue;
      }
      if (buf.length < totalLen) break; // need more bytes

      events.push({ dirKey, tsMs: seg.tsMs, streamOff, type, len: payloadLen });
      if (events.length >= maxEvents) return { prefix: Buffer.concat(prefixChunks), events };

      // consume record
      streamOff += totalLen;
      buf = buf.subarray(totalLen);
    }
  }

  return { prefix: Buffer.concat(prefixChunks), events };
}

function tryGet6666RecordPayloadAt(reassembled: Buffer, streamOff: number): { type: number; len: number; payload: Buffer } | undefined {
  if (streamOff < 0 || streamOff + 12 > reassembled.length) return undefined;
  const magic = reassembled.readUInt32LE(streamOff);
  if (magic !== 0x0001000c) return undefined;
  const len = reassembled.readUInt32LE(streamOff + 4);
  const type = reassembled.readUInt32LE(streamOff + 8);
  const total = 12 + len;
  if (streamOff + total > reassembled.length) return undefined;
  return { type, len, payload: reassembled.subarray(streamOff + 12, streamOff + total) };
}

function analyzeBaichuanStream(label: string, stream: Buffer): void {
  const parser = new BaichuanFrameParser();
  const frames: BaichuanFrame[] = parser.push(stream) as BaichuanFrame[];

  const md5HexUpper = (input: string): string => createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
  const md5StrModern = (input: string): string => md5HexUpper(input).slice(0, 31);
  const deriveAesKey = (nonce: string, password: string): Buffer => {
    const keyStr = md5StrModern(`${nonce}-${password}`).slice(0, 16);
    return Buffer.from(keyStr, "utf8");
  };

  const bcXor = (buf: Buffer, offset: number): Buffer => {
    // Same XOR as bcDecrypt/bcEncrypt in src/protocol/crypto.ts
    const key = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];
    const off = offset & 0xff;
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i]! ^ key[(off + i) % key.length]! ^ off;
    }
    return out;
  };

  const aesDecrypt = (buf: Buffer, key: Buffer): Buffer => {
    if (buf.length === 0) return Buffer.alloc(0);
    const iv = Buffer.from("0123456789abcdef", "utf8");
    const decipher = createDecipheriv("aes-128-cfb", key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  };

  const xmlText = (xml: string, tagName: string): string | undefined => {
    const re = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, "i");
    return re.exec(xml)?.[1];
  };

  const findSessionEnc = (): SessionInfo => {
    // Look for the legacy login reply: cmdId=1, responseCode 0xDDxx, body contains <Encryption><nonce>...</nonce>
    for (const f of frames) {
      if (f.header.cmdId !== 1) continue;
      const resp = f.header.responseCode;
      if (((resp >>> 8) & 0xff) !== 0xdd) continue;
      if (f.body.length === 0) continue;
      const encType = resp & 0xff;
      const preferred = encType === 0x00 ? "none" : "bc";
      const xml =
        (preferred === "none" ? f.body.toString("utf8") : bcXor(Buffer.from(f.body), f.header.channelId).toString("utf8")) ||
        f.body.toString("utf8");
      const nonce = xmlText(xml, "nonce");
      if (!nonce) continue;

      if (encType === 0x00) return { enc: { kind: "none" }, nonce, encType };
      if (encType === 0x01) return { enc: { kind: "bc" }, nonce, encType };

      const password = process.env.BAICHUAN_PASSWORD ?? process.env.NVR_PASSWORD ?? process.env.TCP_PASSWORD;
      if (!password) return { enc: { kind: "unknown" }, nonce, encType };

      if (encType === 0x02) return { enc: { kind: "aes", key: deriveAesKey(nonce, password), mode: "aes" }, nonce, encType };
      if (encType === 0x12) return { enc: { kind: "aes", key: deriveAesKey(nonce, password), mode: "full_aes" }, nonce, encType };

      return { enc: { kind: "unknown" }, nonce, encType };
    }

    return { enc: { kind: "unknown" } };
  };

  const session = globalSession ?? findSessionEnc();
  if (!globalSession && session.nonce) globalSession = session;

  const tryDecodeXml = (buf: Buffer, channelId: number): string | undefined => {
    const asUtf8 = (b: Buffer) => b.toString("utf8");
    const candidates: Buffer[] = [buf, bcXor(buf, channelId)];
    if (session.enc.kind === "aes") candidates.unshift(aesDecrypt(buf, session.enc.key));
    for (const c of candidates) {
      const s = asUtf8(c);
      // Some payloads start directly with <body> (no XML declaration), so accept common tags too.
      if (
        s.startsWith("<?xml") ||
        s.startsWith("<body") ||
        s.includes("<body>") ||
        s.includes("<Encryption") ||
        s.includes("<DeviceInfo") ||
        s.includes("AlarmEventList") ||
        s.includes("BatteryInfo") ||
        s.includes("PIR")
      ) {
        return s;
      }
    }
    return undefined;
  };

  const byCmd = new Map<number, number>();
  const byCmdStreamType = new Map<string, number>();

  for (const f of frames) {
    byCmd.set(f.header.cmdId, (byCmd.get(f.header.cmdId) ?? 0) + 1);
    byCmdStreamType.set(
      `${f.header.cmdId}/${f.header.streamType}`,
      (byCmdStreamType.get(`${f.header.cmdId}/${f.header.streamType}`) ?? 0) + 1,
    );
  }

  const topCmd = [...byCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topCmdStream = [...byCmdStreamType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  console.log(`\n=== ${label} ===`);
  console.log(`Baichuan frames decoded: ${frames.length}`);
  console.log("Top cmdId:");
  for (const [cmdId, count] of topCmd) {
    console.log(`  cmdId=${cmdId} count=${count}`);
  }
  console.log("Top cmdId/streamType:");
  for (const [k, count] of topCmdStream) {
    const [cmdId, streamType] = k.split("/");
    console.log(`  cmdId=${cmdId} streamType=${streamType} count=${count}`);
  }

  const interesting = frames
    .filter((f) => f.header.cmdId === 3)
    .slice(0, 20)
    .map((f) => ({
      cmdId: f.header.cmdId,
      channelId: f.header.channelId,
      streamType: f.header.streamType,
      msgNum: f.header.msgNum,
      responseCode: f.header.responseCode,
      messageClass: f.header.messageClass,
      payloadOffset: f.header.payloadOffset ?? null,
      bodyLen: f.header.bodyLen,
      messageKey: f.messageKey,
    }));

  if (interesting.length > 0) {
    console.log("Sample cmdId=3 headers (first 20):");
    for (const h of interesting) {
      console.log(
        `  ch=${h.channelId} streamType=${h.streamType} msgNum=${h.msgNum} class=${h.messageClass} bodyLen=${h.bodyLen} rc=${h.responseCode} payloadOffset=${h.payloadOffset} messageKey=${h.messageKey}`,
      );
    }
  }

  // Summarize Preview requests (these are what we send to the hub to start streams).
  const previewRequests = frames
    .filter((f) => f.header.cmdId === 3)
    .filter((f) => f.header.responseCode === 0)
    .filter((f) => f.header.bodyLen > 0 && f.header.bodyLen <= 2048);

  if (previewRequests.length > 0) {
    type PreviewSummaryVal = {
      count: number;
      firstMsgNum: number;
      lastMsgNum: number;
      sampleXml: string | undefined;
      channelId: string | undefined;
      handle: string | undefined;
      streamType: string | undefined;
      handleBase: number | undefined;
    };
    const previewSummary = new Map<string, PreviewSummaryVal>();

    for (const f of previewRequests) {
      const xml =
        (f.payload.length > 0 ? tryDecodeXml(Buffer.from(f.payload), f.header.channelId) : undefined) ??
        tryDecodeXml(Buffer.from(f.body), f.header.channelId) ??
        (f.extension.length > 0 ? tryDecodeXml(Buffer.from(f.extension), f.header.channelId) : undefined);
      if (!xml || !xml.includes("<Preview")) continue;

      const channelId = xmlText(xml, "channelId");
      const handle = xmlText(xml, "handle");
      const streamType = xmlText(xml, "streamType");
      const handleNum = handle ? parseInt(handle, 10) : undefined;
      const channelNum = channelId ? parseInt(channelId, 10) : undefined;
      const handleBase =
        handleNum !== undefined && Number.isFinite(handleNum) && channelNum !== undefined && Number.isFinite(channelNum)
          ? handleNum - channelNum
          : undefined;
      const key = `ch=${channelId ?? "?"} handle=${handle ?? "?"} streamType=${streamType ?? "?"} base=${handleBase ?? "?"}`;
      const cur: PreviewSummaryVal = previewSummary.get(key) ?? {
        count: 0,
        firstMsgNum: f.header.msgNum,
        lastMsgNum: f.header.msgNum,
        sampleXml: undefined,
        channelId,
        handle,
        streamType,
        handleBase,
      };
      cur.count++;
      cur.firstMsgNum = Math.min(cur.firstMsgNum, f.header.msgNum);
      cur.lastMsgNum = Math.max(cur.lastMsgNum, f.header.msgNum);
      if (!cur.sampleXml) cur.sampleXml = xml.replace(/\s+/g, " ").slice(0, 240);
      previewSummary.set(key, cur);
    }

    if (previewSummary.size > 0) {
      console.log("Preview request summary (cmdId=3 rc=0):");
      for (const [k, v] of [...previewSummary.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.log(`  ${k} count=${v.count} msgNum=${v.firstMsgNum}..${v.lastMsgNum}`);
        if (v.sampleXml) console.log(`    xmlHead: ${v.sampleXml}`);
      }
    }
  }

  // Surface other small XML commands (often includes PTZ/zoom/etc) once we have the session key.
  const keywordRe = /(Ptz|Zoom|focal|lens|Track|Tele|Wide|multi|ratio|digital|optical)/i;
  const smallFrames = frames.filter((f) => f.header.bodyLen > 0 && f.header.bodyLen <= 2048);
  const hits: Array<{ cmdId: number; rc: number; ch: number; msgNum: number; head: string }> = [];
  for (const f of smallFrames) {
    const extXml = f.extension.length > 0 ? tryDecodeXml(Buffer.from(f.extension), f.header.channelId) : undefined;
    const payXml = f.payload.length > 0 ? tryDecodeXml(Buffer.from(f.payload), f.header.channelId) : undefined;
    const bodyXml = tryDecodeXml(Buffer.from(f.body), f.header.channelId);
    const xml = payXml ?? bodyXml ?? extXml;
    if (!xml) continue;
    if (!keywordRe.test(xml)) continue;
    hits.push({
      cmdId: f.header.cmdId,
      rc: f.header.responseCode,
      ch: f.header.channelId,
      msgNum: f.header.msgNum,
      head: xml.replace(/\s+/g, " ").slice(0, 260),
    });
    if (hits.length >= 12) break;
  }
  if (hits.length > 0) {
    console.log("Small XML keyword hits (first 12):");
    for (const h of hits) {
      console.log(`  cmdId=${h.cmdId} rc=${h.rc} ch=${h.ch} msgNum=${h.msgNum} xmlHead: ${h.head}`);
    }
  }

  // Specifically hunt for motion/PIR/event payloads (cmdId=33, cmdId=31, etc).
  // When encryption is negotiated, these may become visible only after we derive the session key.
  const eventKeywordRe = /(AlarmEventList|AiAlarm|MdAlarm|PIR|Pir|motion|Motion)/;
  const eventHits: Array<{ cmdId: number; rc: number; ch: number; msgNum: number; head: string }> = [];
  for (const f of smallFrames) {
    // Heuristic: focus on typical event-ish commands first, but keep it generic.
    if (![31, 33, 46, 93, 212, 253].includes(f.header.cmdId) && f.header.bodyLen > 1024) continue;

    const extXml = f.extension.length > 0 ? tryDecodeXml(Buffer.from(f.extension), f.header.channelId) : undefined;
    const payXml = f.payload.length > 0 ? tryDecodeXml(Buffer.from(f.payload), f.header.channelId) : undefined;
    const bodyXml = tryDecodeXml(Buffer.from(f.body), f.header.channelId);
    const xml = payXml ?? bodyXml ?? extXml;
    if (!xml) continue;
    if (!eventKeywordRe.test(xml)) continue;

    eventHits.push({
      cmdId: f.header.cmdId,
      rc: f.header.responseCode,
      ch: f.header.channelId,
      msgNum: f.header.msgNum,
      head: xml.replace(/\s+/g, " ").slice(0, 320),
    });
    if (eventHits.length >= 12) break;
  }
  if (eventHits.length > 0) {
    console.log("Event XML hits (first 12):");
    for (const h of eventHits) {
      console.log(`  cmdId=${h.cmdId} rc=${h.rc} ch=${h.ch} msgNum=${h.msgNum} xmlHead: ${h.head}`);
    }
  }

  // If cmdId=33/cmdId=252 exist but we didn't match keywords, dump a few samples anyway.
  // This helps reverse-engineer how PIR/motion notifications are delivered to the hub.
  const eventCmdIds = new Set([33, 252]);
  const eventSamples = frames
    .filter((f) => eventCmdIds.has(f.header.cmdId))
    .filter((f) => f.header.bodyLen > 0 && f.header.bodyLen <= 4096)
    .slice(0, 8);
  if (eventSamples.length > 0) {
    console.log("Event frame samples (cmdId=33/252, first 8):");
    for (const f of eventSamples) {
      const extXml = f.extension.length > 0 ? tryDecodeXml(Buffer.from(f.extension), f.header.channelId) : undefined;
      const payXml = f.payload.length > 0 ? tryDecodeXml(Buffer.from(f.payload), f.header.channelId) : undefined;
      const bodyXml = tryDecodeXml(Buffer.from(f.body), f.header.channelId);
      console.log(
        `  cmdId=${f.header.cmdId} rc=${f.header.responseCode} ch=${f.header.channelId} streamType=${f.header.streamType} msgNum=${f.header.msgNum} bodyLen=${f.header.bodyLen} payloadLen=${f.payload.length} extLen=${f.extension.length}`,
      );
      const xml = payXml ?? bodyXml ?? extXml;
      if (xml) {
        console.log(`    xmlHead: ${xml.replace(/\s+/g, " ").slice(0, 320)}`);
      } else {
        const raw = Buffer.from(f.body);
        console.log(`    bodyRaw hex: ${raw.subarray(0, Math.min(64, raw.length)).toString("hex")}`);
      }
    }
  }

  // Decode candidate request frames (usually responseCode=0) to understand which parameters are sent to the hub.
  // Many firmwares use XML in Extension/Payload, often encrypted (AES/BC).
  const requestCmdIds = new Set<number>([3, 44, 104, 253, 10, 299, 80, 151, 58, 146, 192, 199, 102, 93, 319, 511]);
  const requestFrames = frames
    .filter((f) => requestCmdIds.has(f.header.cmdId))
    .filter((f) => f.header.responseCode === 0)
    .filter((f) => f.header.bodyLen > 0 && f.header.bodyLen <= 4096);

  if (requestFrames.length > 0) {
    console.log("Request-frame XML decode (responseCode=0, bodyLen<=4096):");
    for (const f of requestFrames.slice(0, 12)) {
      const extXml = f.extension.length > 0 ? tryDecodeXml(Buffer.from(f.extension), f.header.channelId) : undefined;
      const payXml = f.payload.length > 0 ? tryDecodeXml(Buffer.from(f.payload), f.header.channelId) : undefined;
      const bodyXml = tryDecodeXml(Buffer.from(f.body), f.header.channelId);

      console.log(
        `  cmdId=${f.header.cmdId} ch=${f.header.channelId} streamType=${f.header.streamType} msgNum=${f.header.msgNum} class=${f.header.messageClass} bodyLen=${f.header.bodyLen} payloadOffset=${f.header.payloadOffset ?? 0}`,
      );
      console.log(
        `    decoded: extXml=${extXml ? "yes" : "no"} payloadXml=${payXml ? "yes" : "no"} bodyXml=${bodyXml ? "yes" : "no"}`,
      );

      const xml = payXml ?? bodyXml ?? extXml;
      if (xml) {
        const head = xml.replace(/\s+/g, " ").slice(0, 260);
        console.log(`    xmlHead: ${head}`);
      } else {
        const raw = Buffer.from(f.body);
        console.log(`    bodyRaw hex: ${raw.subarray(0, Math.min(64, raw.length)).toString("hex")}`);
      }
    }
  }

  // Try to decode VIDEO start requests (cmdId=3) as XML.
  // On many models this is Extension XML + Preview XML, possibly BC-XOR encrypted.
  const cmd3XmlCandidates = frames
    .filter((f) => f.header.cmdId === 3)
    .filter((f) => f.payload.length > 0)
    // heuristic: xml requests are small; media payloads are often larger and/or binary
    .filter((f) => f.header.bodyLen > 0 && f.header.bodyLen <= 2048);

  if (cmd3XmlCandidates.length > 0) {
    console.log("cmdId=3 XML-ish candidates (bodyLen<=2048):");
    for (const f of cmd3XmlCandidates.slice(0, 5)) {
      const extXml = f.extension.length > 0 ? tryDecodeXml(Buffer.from(f.extension), f.header.channelId) : undefined;
      const payXml = f.payload.length > 0 ? tryDecodeXml(Buffer.from(f.payload), f.header.channelId) : undefined;

      console.log(
        `  header: ch=${f.header.channelId} streamType=${f.header.streamType} msgNum=${f.header.msgNum} class=${f.header.messageClass} rc=${f.header.responseCode} bodyLen=${f.header.bodyLen} payloadOffset=${f.header.payloadOffset ?? 0}`,
      );
      console.log(`  parts: extLen=${f.extension.length} payloadLen=${f.payload.length} extXml=${extXml ? "yes" : "no"} payloadXml=${payXml ? "yes" : "no"}`);

      const previewXml = payXml ?? extXml;
      if (previewXml) {
        const channelId = xmlText(previewXml, "channelId");
        const handle = xmlText(previewXml, "handle");
        const streamTypeTag = xmlText(previewXml, "streamType");
        console.log(`  Preview params: channelId=${channelId ?? "?"} handle=${handle ?? "?"} streamTypeTag=${streamTypeTag ?? "?"}`);
      }

      if (!extXml && f.extension.length > 0) {
        const s = Buffer.from(f.extension);
        const slice = s.subarray(0, Math.min(48, s.length));
        console.log(`  extRaw hex: ${slice.toString("hex")}`);
      }
      if (!payXml && f.payload.length > 0) {
        const s = Buffer.from(f.payload);
        const slice = s.subarray(0, Math.min(64, s.length));
        console.log(`  payloadRaw hex: ${slice.toString("hex")}`);
      }

      if (extXml) console.log(`  extXmlHead: ${extXml.replace(/\s+/g, " ").slice(0, 180)}`);
      if (payXml) console.log(`  payloadXmlHead: ${payXml.replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }

  // Try to decode BcMedia packets inside cmdId=3 payloads.
  // If encryption is enabled, we won't see valid magics and decoding will yield 0 packets.
  const cmd3 = frames.filter((f) => f.header.cmdId === 3);
  const payloadStream = Buffer.concat(cmd3.map((f) => f.payload));

  const scanBcMediaMagics = (buf: Buffer): { hits: number; firstOffset: number; score: number } => {
    if (buf.length < 4) return { hits: 0, firstOffset: -1, score: -1 };
    const maxScan = Math.min(64 * 1024, buf.length - 4);
    let hits = 0;
    let first = -1;
    for (let i = 0; i <= maxScan; i++) {
      const magic = buf.readUInt32LE(i);
      const isInfoV1 = magic === 0x31303031; // "1001"
      const isInfoV2 = magic === 0x32303031; // "1002"
      const isIFrame = magic >= 0x63643030 && magic <= 0x63643039; // "cd00".."cd09"
      const isPFrame = magic >= 0x63643130 && magic <= 0x63643139; // "cd10".."cd19"
      const isAac = magic === 0x62773530; // "bw50"
      const isAdpcm = magic === 0x62773130; // "bw10"
      if (isInfoV1 || isInfoV2 || isIFrame || isPFrame || isAac || isAdpcm) {
        hits++;
        if (first === -1) first = i;
      }
    }
    const score = hits === 0 ? -1 : hits;
    return { hits, firstOffset: first, score };
  };

  // Attempt to decrypt cmdId=3 response payload blocks when negotiated AES is available.
  // Many hubs send media payload as an AES block described by Extension XML (<encryptLen>...</encryptLen>).
  let payloadStreamDecrypted: Buffer | undefined;
  if (session.enc.kind === "aes") {
    const parts: Buffer[] = [];
    const cmd3Resp = cmd3.filter((f) => f.header.responseCode === 200 && f.payload.length > 0);
    for (const f of cmd3Resp) {
      const extXml = f.extension.length > 0 ? tryDecodeXml(Buffer.from(f.extension), f.header.channelId) : undefined;
      const encryptLenText = extXml ? xmlText(extXml, "encryptLen") : undefined;
      const encryptLen = encryptLenText ? parseInt(encryptLenText, 10) : undefined;
      const payload = Buffer.from(f.payload);
      if (encryptLen !== undefined && Number.isFinite(encryptLen) && encryptLen > 0 && payload.length !== encryptLen) {
        // If ext says encryptLen but doesn't match, don't guess.
        continue;
      }
      let dec = aesDecrypt(payload, session.enc.key);
      // Many firmwares prepend a small per-chunk header before the BcMedia packets.
      // Trim to first magic to help the stream decoder resync.
      const s = scanBcMediaMagics(dec);
      if (s.firstOffset >= 0 && s.firstOffset < dec.length) {
        dec = dec.subarray(s.firstOffset);
      }
      parts.push(dec);
      if (parts.length >= 600) break; // cap to keep memory bounded
    }
    if (parts.length > 0) payloadStreamDecrypted = Buffer.concat(parts);
  }

  const scan = scanBcMediaMagics(payloadStream);
  const scanDec = payloadStreamDecrypted ? scanBcMediaMagics(payloadStreamDecrypted) : undefined;
  const dumpHex = (b: Buffer): string => b.toString("hex");
  const dumpAscii = (b: Buffer): string => b
    .toString("latin1")
    .replace(/[\x00-\x1f\x7f-\xff]/g, ".")
    .slice(0, 64);

  console.log(
    `BcMedia scan: payloadBytes=${payloadStream.length} magicHits=${scan.hits} firstOffset=${scan.firstOffset} (encrypted? ${scan.hits === 0 ? "likely" : "unknown"})`,
  );
  if (scanDec) {
    console.log(
      `BcMedia scan (AES-decrypted): payloadBytes=${payloadStreamDecrypted!.length} magicHits=${scanDec.hits} firstOffset=${scanDec.firstOffset} (better? ${scanDec.hits > scan.hits ? "yes" : "no"})`,
    );
  }
  if (scan.firstOffset >= 0) {
    const slice = payloadStream.subarray(scan.firstOffset, Math.min(payloadStream.length, scan.firstOffset + 64));
    console.log(`BcMedia first-magic bytes (hex): ${dumpHex(slice)}`);
    console.log(`BcMedia first-magic bytes (ascii): ${dumpAscii(slice)}`);
  }

  const codec = new BcMediaCodec(false /* strict */);
  const chosenPayload = scanDec && scanDec.hits > scan.hits ? payloadStreamDecrypted! : payloadStream;
  const medias: BcMedia[] = codec.decode(chosenPayload) as BcMedia[];
  if (medias.length === 0) {
    console.log("BcMedia decoded: 0 (could be encrypted or too short capture)");
    return;
  }

  const byType = new Map<string, number>();
  const infos: Array<{ idx: number; t: string; w: number; h: number; fps: number }> = [];
  const videoTypes = new Map<string, number>();
  const spsHashes = new Map<string, number>();

  const sha1Hex = (b: Buffer): string => createHash("sha1").update(b).digest("hex");

  const findH264SpsInAnnexB = (accessUnit: Buffer): Buffer | null => {
    // minimal scan: find NAL type 7 (SPS) in Annex-B
    for (let i = 0; i < accessUnit.length - 4; i++) {
      const is3 = accessUnit[i] === 0x00 && accessUnit[i + 1] === 0x00 && accessUnit[i + 2] === 0x01;
      const is4 =
        accessUnit[i] === 0x00 &&
        accessUnit[i + 1] === 0x00 &&
        accessUnit[i + 2] === 0x00 &&
        accessUnit[i + 3] === 0x01;
      if (!is3 && !is4) continue;
      const nalStart = i + (is4 ? 4 : 3);
      if (nalStart >= accessUnit.length) continue;
      const nalType = (accessUnit[nalStart] ?? 0) & 0x1f;
      if (nalType !== 7) continue;

      // extract until next start code
      let j = nalStart;
      while (j < accessUnit.length) {
        const next3 = j + 3 < accessUnit.length && accessUnit[j] === 0x00 && accessUnit[j + 1] === 0x00 && accessUnit[j + 2] === 0x01;
        const next4 =
          j + 4 < accessUnit.length &&
          accessUnit[j] === 0x00 &&
          accessUnit[j + 1] === 0x00 &&
          accessUnit[j + 2] === 0x00 &&
          accessUnit[j + 3] === 0x01;
        if (j !== nalStart && (next3 || next4)) break;
        j++;
      }
      return accessUnit.subarray(nalStart, j);
    }
    return null;
  };

  for (let i = 0; i < medias.length; i++) {
    const m = medias[i]! as any;
    byType.set(m.type, (byType.get(m.type) ?? 0) + 1);

    if (m.type === "InfoV1" || m.type === "InfoV2") {
      infos.push({ idx: i, t: m.type, w: m.videoWidth, h: m.videoHeight, fps: m.fps });
    }

    if (m.type === "Iframe" || m.type === "Pframe") {
      videoTypes.set(m.videoType, (videoTypes.get(m.videoType) ?? 0) + 1);
      if (m.videoType === "H264" && m.type === "Iframe") {
        const sps = findH264SpsInAnnexB(m.data);
        if (sps) spsHashes.set(sha1Hex(sps), (spsHashes.get(sha1Hex(sps)) ?? 0) + 1);
      }
    }
  }

  console.log(`BcMedia decoded packets: ${medias.length}`);
  console.log("BcMedia types:");
  for (const [t, c] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}`);
  }

  if (videoTypes.size > 0) {
    console.log("VideoType counts:");
    for (const [t, c] of [...videoTypes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}: ${c}`);
    }
  }

  if (infos.length > 0) {
    console.log("Info packets (width/height/fps):");
    const uniq = new Map<string, number>();
    for (const inf of infos) {
      const k = `${inf.w}x${inf.h}@${inf.fps}`;
      uniq.set(k, (uniq.get(k) ?? 0) + 1);
    }
    for (const [k, c] of [...uniq.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k} count=${c}`);
    }
    const hasInvalidInfo = infos.some((inf) => {
      const badWxH = inf.w <= 0 || inf.h <= 0 || inf.w > 16384 || inf.h > 16384;
      const badFps = inf.fps <= 0 || inf.fps > 240;
      return badWxH || badFps;
    });
    if (hasInvalidInfo) {
      console.log("Info packets look suspicious (e.g. 0x0 dimensions). Payload likely encrypted or not standard BcMedia.");
    }

    if (uniq.size > 1) {
      console.log("Resolution/fps change detected (InfoV1/InfoV2 differ). First occurrences:");
      const seen = new Set<string>();
      for (const inf of infos) {
        const k = `${inf.w}x${inf.h}@${inf.fps}`;
        if (seen.has(k)) continue;
        seen.add(k);
        console.log(`  idx=${inf.idx} ${inf.t} ${k}`);
      }
    } else {
      console.log("No resolution/fps change detected from Info packets.");
    }
  } else {
    console.log("No InfoV1/InfoV2 packets observed in this capture window.");
  }

  if (spsHashes.size > 0) {
    console.log(`H264 SPS hashes observed: ${spsHashes.size}`);
    for (const [h, c] of [...spsHashes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`  spsSha1=${h} count=${c}`);
    }
  }
}

function analyzeBaichuanSegments(label: string, segments: TcpSegment[]): void {
  if (segments.length === 0) return;
  const parser = new BaichuanFrameParser();
  const framesWithTime: Array<{ tsMs: number; frame: BaichuanFrame }> = [];

  const tsMin = Math.min(...segments.map((s) => s.tsMs));
  const tsMax = Math.max(...segments.map((s) => s.tsMs));

  const sorted = [...segments].sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq);
  for (const seg of sorted) {
    const out = parser.push(seg.payload);
    for (const f of out) framesWithTime.push({ tsMs: seg.tsMs, frame: f as BaichuanFrame });
  }

  const frames = framesWithTime.map((x) => x.frame);
  console.log(`\n=== ${label} ===`);
  console.log(`Baichuan frames decoded: ${frames.length}`);
  if (Number.isFinite(tsMin) && Number.isFinite(tsMax) && tsMax >= tsMin) {
    console.log(`Flow span: ${(tsMax - tsMin).toFixed(1)}ms (firstTs=${tsMin.toFixed(1)} lastTs=${tsMax.toFixed(1)})`);
  }

  const byCmd = new Map<number, number>();
  const byCmdStreamType = new Map<string, number>();
  for (const f of frames) {
    byCmd.set(f.header.cmdId, (byCmd.get(f.header.cmdId) ?? 0) + 1);
    byCmdStreamType.set(
      `${f.header.cmdId}/${f.header.streamType}`,
      (byCmdStreamType.get(`${f.header.cmdId}/${f.header.streamType}`) ?? 0) + 1,
    );
  }

  const topCmd = [...byCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topCmdStream = [...byCmdStreamType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log("Top cmdId:");
  for (const [cmdId, count] of topCmd) console.log(`  cmdId=${cmdId} count=${count}`);
  console.log("Top cmdId/streamType:");
  for (const [k, count] of topCmdStream) {
    const [cmdId, streamType] = k.split("/");
    console.log(`  cmdId=${cmdId} streamType=${streamType} count=${count}`);
  }

  if (frames.length === 0 && (process.env.PCAP_DUMP_TCP_UNKNOWN ?? "").trim() === "1") {
    const { data, gaps } = reassembleTcpSegments(segments);
    console.log(`Unknown TCP payload preview (reassembledLen=${data.length} gaps=${gaps}):`);
    const guess = guessProtocolFromTcpPrefix(data);
    if (guess) console.log(`Protocol guess: ${guess}`);
    const recs = tryParseLenTypeRecords(data);
    if (recs) {
      const byType = new Map<number, { count: number; lens: Map<number, number> }>();
      for (const r of recs) {
        const t = byType.get(r.type) ?? { count: 0, lens: new Map<number, number>() };
        t.count += 1;
        t.lens.set(r.len, (t.lens.get(r.len) ?? 0) + 1);
        byType.set(r.type, t);
      }
      console.log(`Record framing detected: magic=0x0001000c records=${recs.length}`);
      for (const [type, info] of [...byType.entries()].sort((a, b) => b[1].count - a[1].count)) {
        const lensTop = [...info.lens.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([len, c]) => `${len}x${c}`)
          .join(" ");
        console.log(`  type=0x${type.toString(16)} (${type}) count=${info.count} lens=${lensTop}`);
      }
    }
    if (data.length > 0) console.log(hexPreview(data, 256));
    return;
  }

  const cmd3Timed = framesWithTime.filter((x) => x.frame.header.cmdId === 3);
  if (cmd3Timed.length === 0) return;

  const bodyLenCounts = new Map<number, number>();
  const bodyLenBins = {
    le512: 0,
    le1024: 0,
    le4096: 0,
    le16384: 0,
    gt16384: 0,
  };

  const t0 = cmd3Timed[0]!.tsMs;
  const buckets = new Map<number, { count: number; sumBody: number; sumPayload: number; minBody: number; maxBody: number }>();

  for (const { tsMs, frame } of cmd3Timed) {
    bodyLenCounts.set(frame.header.bodyLen, (bodyLenCounts.get(frame.header.bodyLen) ?? 0) + 1);
    if (frame.header.bodyLen <= 512) bodyLenBins.le512++;
    else if (frame.header.bodyLen <= 1024) bodyLenBins.le1024++;
    else if (frame.header.bodyLen <= 4096) bodyLenBins.le4096++;
    else if (frame.header.bodyLen <= 16384) bodyLenBins.le16384++;
    else bodyLenBins.gt16384++;

    const sec = Math.floor((tsMs - t0) / 1000);
    const b = buckets.get(sec) ?? { count: 0, sumBody: 0, sumPayload: 0, minBody: Number.POSITIVE_INFINITY, maxBody: 0 };
    b.count += 1;
    b.sumBody += frame.header.bodyLen;
    b.sumPayload += frame.payload.length;
    b.minBody = Math.min(b.minBody, frame.header.bodyLen);
    b.maxBody = Math.max(b.maxBody, frame.header.bodyLen);
    buckets.set(sec, b);
  }

  console.log("cmdId=3 size stats by second (relative):");
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const b = buckets.get(k)!;
    const avgBody = b.sumBody / Math.max(1, b.count);
    const kbpsApprox = (b.sumPayload * 8) / 1000;
    console.log(
      `  t+${k}s frames=${b.count} avgBodyLen=${avgBody.toFixed(1)} minBodyLen=${b.minBody} maxBodyLen=${b.maxBody} payloadKbps≈${kbpsApprox.toFixed(1)}`,
    );
  }

  console.log(
    `cmdId=3 bodyLen bins: <=512=${bodyLenBins.le512} <=1024=${bodyLenBins.le1024} <=4096=${bodyLenBins.le4096} <=16384=${bodyLenBins.le16384} >16384=${bodyLenBins.gt16384}`,
  );
  console.log("Top cmdId=3 bodyLen values:");
  for (const [len, c] of [...bodyLenCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  bodyLen=${len} count=${c}`);
  }

  // Also run the deeper payload analysis (BcMedia scan/decode) on reassembled stream.
  const { data, gaps } = reassembleTcpSegments(segments);
  analyzeBaichuanStream(`${label} [reassembled gaps=${gaps}]`, data);
}

function main() {
  const fileArg = process.argv[2];
  const pcapPath = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(process.cwd(), "pcap/ip.addr == 192.168.1.161.pcapng");

  const hubIp = process.env.HUB_IP ?? "192.168.1.161";
  const pcIp = process.env.PC_IP ?? "192.168.1.193";
  const baichuanTcpPort = Number.parseInt(process.env.BAICHUAN_TCP_PORT ?? "9000", 10);
  const analyzeAll9000 = (process.env.PCAP_ANALYZE_ALL_9000 ?? "").trim() === "1";

  const buf = fs.readFileSync(pcapPath);
  if (buf.length < 12) throw new Error("Capture too small");

  const interfaceDefs: Array<{ linkType: number; tsResol: number }> = [];
  const interfacePackets = new Map<number, number>();

  let ingestedIpPackets = 0;
  let ingestedTcpPayloadPackets = 0;
  let ingestedUdpPayloadPackets = 0;

  const segmentsByDir = new Map<string, TcpSegment[]>();
  const bytesByDir = new Map<string, number>();
  const packetsByDir = new Map<string, number>();

  const udpBytesByDir = new Map<string, number>();
  const udpPacketsByDir = new Map<string, number>();

  const udpDstPortBytes = new Map<number, number>();
  const udpDstPortPackets = new Map<number, number>();
  const udpSrcPortBytes = new Map<number, number>();
  const udpSrcPortPackets = new Map<number, number>();

  const udp7777Samples: Array<{ tsMs: number; dirKey: string; payloadLen: number; payload: Buffer }> = [];

  const ipBytes = new Map<string, number>();
  const ipPackets = new Map<string, number>();

  const highlightUdpPorts = new Set([2015, 2018, 9000, 1900, 3702, 5353, 9999, 5000, 554, 80, 443]);
  const highlightedUdpFlows: Array<{ dirKey: string; bytes: number; packets: number }> = [];

  function ingestPacket(pkt: Buffer, linkType: number, tsMs: number) {
    // DLT_EN10MB = 1 (Ethernet), DLT_NULL = 0 (loopback)
    if (linkType !== 1 && linkType !== 0) return;

    let ipOffset = 0;
    if (linkType === 1) {
      if (pkt.length < 14) return;
      let etherType = pkt.readUInt16BE(12);
      ipOffset = 14;
      if (etherType === 0x8100 && pkt.length >= 18) {
        // VLAN tag
        etherType = pkt.readUInt16BE(16);
        ipOffset = 18;
      }
      if (etherType !== 0x0800) return;
    } else {
      // DLT_NULL: 4-byte family then IP
      if (pkt.length < 4) return;
      ipOffset = 4;
    }

    if (pkt.length < ipOffset + 20) return;

    const verIhl = pkt[ipOffset]!;
    const version = (verIhl >> 4) & 0x0f;
    if (version !== 4) return;
    const ihl = verIhl & 0x0f;
    const ipHeaderLen = ihl * 4;
    if (pkt.length < ipOffset + ipHeaderLen) return;

    const proto = pkt[ipOffset + 9]!;

    const ipTotalLen = pkt.readUInt16BE(ipOffset + 2);
    const srcIp = ipToString(pkt, ipOffset + 12);
    const dstIp = ipToString(pkt, ipOffset + 16);

    ingestedIpPackets += 1;

    if (proto === 6) {
      const tcpOffset = ipOffset + ipHeaderLen;
      if (pkt.length < tcpOffset + 20) return;

      const srcPort = pkt.readUInt16BE(tcpOffset);
      const dstPort = pkt.readUInt16BE(tcpOffset + 2);
      const seq = pkt.readUInt32BE(tcpOffset + 4);
      const dataOffsetWords = (pkt[tcpOffset + 12]! >> 4) & 0x0f;
      const tcpHeaderLen = dataOffsetWords * 4;

      const payloadOffset = tcpOffset + tcpHeaderLen;
      const tcpLen = Math.max(0, ipTotalLen - ipHeaderLen);
      const payloadLen = Math.max(0, tcpLen - tcpHeaderLen);

      if (payloadLen <= 0 || payloadOffset >= pkt.length) return;

      const available = Math.min(payloadLen, pkt.length - payloadOffset);
      const payload = pkt.subarray(payloadOffset, payloadOffset + available);
      if (payload.length === 0) return;

      ingestedTcpPayloadPackets += 1;

      const dirKey = `${srcIp}:${srcPort} -> ${dstIp}:${dstPort}`;
      const arr = segmentsByDir.get(dirKey) ?? [];
      arr.push({ seq, tsMs, payload: Buffer.from(payload) });
      segmentsByDir.set(dirKey, arr);

      bytesByDir.set(dirKey, (bytesByDir.get(dirKey) ?? 0) + payload.length);
      packetsByDir.set(dirKey, (packetsByDir.get(dirKey) ?? 0) + 1);

      ipBytes.set(srcIp, (ipBytes.get(srcIp) ?? 0) + payload.length);
      ipBytes.set(dstIp, (ipBytes.get(dstIp) ?? 0) + payload.length);
      ipPackets.set(srcIp, (ipPackets.get(srcIp) ?? 0) + 1);
      ipPackets.set(dstIp, (ipPackets.get(dstIp) ?? 0) + 1);
      return;
    }

    if (proto === 17) {
      const udpOffset = ipOffset + ipHeaderLen;
      if (pkt.length < udpOffset + 8) return;
      const srcPort = pkt.readUInt16BE(udpOffset);
      const dstPort = pkt.readUInt16BE(udpOffset + 2);
      const udpLen = pkt.readUInt16BE(udpOffset + 4);
      const payloadOffset = udpOffset + 8;
      const payloadLen = Math.max(0, Math.min(udpLen - 8, pkt.length - payloadOffset));
      if (payloadLen <= 0) return;
      const dirKey = `${srcIp}:${srcPort} -> ${dstIp}:${dstPort}`;

      if ((srcPort === 7777 || dstPort === 7777) && udp7777Samples.length < 40) {
        const payload = pkt.subarray(payloadOffset, payloadOffset + payloadLen);
        udp7777Samples.push({ tsMs, dirKey, payloadLen, payload: Buffer.from(payload) });
      }

      ingestedUdpPayloadPackets += 1;
      udpBytesByDir.set(dirKey, (udpBytesByDir.get(dirKey) ?? 0) + payloadLen);
      udpPacketsByDir.set(dirKey, (udpPacketsByDir.get(dirKey) ?? 0) + 1);

      udpDstPortBytes.set(dstPort, (udpDstPortBytes.get(dstPort) ?? 0) + payloadLen);
      udpDstPortPackets.set(dstPort, (udpDstPortPackets.get(dstPort) ?? 0) + 1);
      udpSrcPortBytes.set(srcPort, (udpSrcPortBytes.get(srcPort) ?? 0) + payloadLen);
      udpSrcPortPackets.set(srcPort, (udpSrcPortPackets.get(srcPort) ?? 0) + 1);

      ipBytes.set(srcIp, (ipBytes.get(srcIp) ?? 0) + payloadLen);
      ipBytes.set(dstIp, (ipBytes.get(dstIp) ?? 0) + payloadLen);
      ipPackets.set(srcIp, (ipPackets.get(srcIp) ?? 0) + 1);
      ipPackets.set(dstIp, (ipPackets.get(dstIp) ?? 0) + 1);

      if (highlightUdpPorts.has(srcPort) || highlightUdpPorts.has(dstPort)) {
        highlightedUdpFlows.push({
          dirKey,
          bytes: (udpBytesByDir.get(dirKey) ?? 0) + payloadLen,
          packets: (udpPacketsByDir.get(dirKey) ?? 0) + 1,
        });
      }
    }
  }

  const magicOrBlockType = buf.readUInt32LE(0);
  const isPcapng = magicOrBlockType === 0x0a0d0d0a;

  if (isPcapng) {
    // Minimal PCAPNG reader (SHB + IDB + EPB/SPB)
    if (buf.length < 28) throw new Error("PCAPNG too small");

    // Determine endianness from SHB byte-order magic at offset 8
    const bomLE = buf.readUInt32LE(8);
    const bomBE = buf.readUInt32BE(8);
    let endian: Endian;
    if (bomLE === 0x1a2b3c4d) endian = "le";
    else if (bomBE === 0x1a2b3c4d) endian = "be";
    else throw new Error(`Unknown PCAPNG byte-order magic (LE=0x${bomLE.toString(16)} BE=0x${bomBE.toString(16)})`);

    const interfaces = interfaceDefs;
    let off = 0;
    while (off + 12 <= buf.length) {
      const blockType = readU32(buf, off, endian);
      const blockLen = readU32(buf, off + 4, endian);
      if (blockLen < 12) break;
      const blockEnd = off + blockLen;
      if (blockEnd > buf.length) break;

      if (blockType === 0x00000001) {
        // IDB
        if (off + 16 <= blockEnd) {
          const linkType = readU16(buf, off + 8, endian);

          // Default ts resolution: 10^-6 seconds
          let tsResol = 1e-6;
          // Parse IDB options for if_tsresol (option code 9)
          let optOff = off + 16;
          while (optOff + 4 <= blockEnd - 4) {
            const optCode = readU16(buf, optOff, endian);
            const optLen = readU16(buf, optOff + 2, endian);
            optOff += 4;
            if (optCode === 0) break;
            const optEnd = optOff + optLen;
            if (optEnd > blockEnd - 4) break;
            if (optCode === 9 && optLen >= 1) {
              const v = buf.readUInt8(optOff);
              const isPow2 = (v & 0x80) !== 0;
              const exp = v & 0x7f;
              tsResol = isPow2 ? 1 / 2 ** exp : 1 / 10 ** exp;
            }
            // options are 32-bit padded
            optOff = optOff + optLen + ((4 - (optLen % 4)) % 4);
          }

          interfaces.push({ linkType, tsResol });
        }
      } else if (blockType === 0x00000006) {
        // EPB
        if (off + 32 <= blockEnd) {
          const interfaceId = readU32(buf, off + 8, endian);
          const tsHigh = readU32(buf, off + 12, endian);
          const tsLow = readU32(buf, off + 16, endian);
          const capLen = readU32(buf, off + 20, endian);
          const pktStart = off + 28;
          const pktEnd = Math.min(pktStart + capLen, blockEnd - 4);
          if (pktEnd > pktStart) {
            const iface = interfaces[interfaceId] ?? interfaces[0] ?? { linkType: 1, tsResol: 1e-6 };
            const ticks = (BigInt(tsHigh) << 32n) | BigInt(tsLow);
            const tsMs = Number(ticks) * iface.tsResol * 1000;

            interfacePackets.set(interfaceId, (interfacePackets.get(interfaceId) ?? 0) + 1);
            ingestPacket(buf.subarray(pktStart, pktEnd), iface.linkType, tsMs);
          }
        }
      } else if (blockType === 0x00000003) {
        // SPB
        if (off + 16 <= blockEnd) {
          const pktLen = readU32(buf, off + 8, endian);
          const pktStart = off + 12;
          const maxDataLen = Math.max(0, blockLen - 16);
          const pktEnd = Math.min(pktStart + Math.min(pktLen, maxDataLen), blockEnd - 4);
          if (pktEnd > pktStart) {
            const iface = interfaces[0] ?? { linkType: 1, tsResol: 1e-6 };
            interfacePackets.set(0, (interfacePackets.get(0) ?? 0) + 1);
            ingestPacket(buf.subarray(pktStart, pktEnd), iface.linkType, 0);
          }
        }
      }

      off = blockEnd;
    }

    console.log(`PCAPNG: ${pcapPath}`);
  } else {
    // Classic PCAP
    if (buf.length < 24) throw new Error("PCAP too small");

    const magic = buf.readUInt32LE(0);
    let endian: Endian;
    if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) {
      endian = "be";
    } else if (magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1) {
      endian = "le";
    } else {
      throw new Error(`Unknown PCAP magic: 0x${magic.toString(16)}`);
    }

    const network = readU32(buf, 20, endian);
    if (network !== 1 && network !== 0) {
      throw new Error(`Unsupported pcap linktype: ${network}`);
    }

    let offset = 24;
    while (offset + 16 <= buf.length) {
      const inclLen = readU32(buf, offset + 8, endian);
      if (inclLen === 0) {
        offset += 16;
        continue;
      }
      const pktStart = offset + 16;
      const pktEnd = pktStart + inclLen;
      if (pktEnd > buf.length) break;
      interfacePackets.set(0, (interfacePackets.get(0) ?? 0) + 1);
      ingestPacket(buf.subarray(pktStart, pktEnd), network, 0);
      offset = pktEnd;
    }

    console.log(`PCAP: ${pcapPath}`);
  }

  if (interfaceDefs.length > 0) {
    console.log("\nPCAP interfaces:");
    for (let i = 0; i < interfaceDefs.length; i++) {
      const d = interfaceDefs[i]!;
      console.log(`  if#${i} linkType=${d.linkType} tsResol=${d.tsResol} packets=${interfacePackets.get(i) ?? 0}`);
    }
  }

  console.log(
    `\nIngest stats: ipPackets=${ingestedIpPackets} tcpPayloadPackets=${ingestedTcpPayloadPackets} udpPayloadPackets=${ingestedUdpPayloadPackets}`,
  );

  const dirs = [...bytesByDir.entries()].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  console.log("\nTop TCP payload directions by bytes:");
  for (const [k, bytes] of dirs.slice(0, 20)) {
    console.log(`  ${k} packets=${packetsByDir.get(k) ?? 0} payloadBytes=${bytes}`);
  }

  const udpDirs = [...udpBytesByDir.entries()].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (udpDirs.length > 0) {
    console.log("\nTop UDP payload directions by bytes:");
    for (const [k, bytes] of udpDirs.slice(0, 20)) {
      console.log(`  ${k} packets=${udpPacketsByDir.get(k) ?? 0} payloadBytes=${bytes}`);
    }

    console.log("\nTop UDP destination ports by bytes:");
    for (const row of topN(udpDstPortBytes, udpDstPortPackets, 20)) {
      console.log(`  dstPort=${row.key} packets=${row.packets} payloadBytes=${row.bytes}`);
    }

    console.log("\nTop UDP source ports by bytes:");
    for (const row of topN(udpSrcPortBytes, udpSrcPortPackets, 20)) {
      console.log(`  srcPort=${row.key} packets=${row.packets} payloadBytes=${row.bytes}`);
    }

    const privateUdp = udpDirs.filter(([k]) => {
      const m = /^(\d+\.\d+\.\d+\.\d+):\d+ -> (\d+\.\d+\.\d+\.\d+):\d+$/.exec(k);
      if (!m) return false;
      const src = m[1]!;
      const dst = m[2]!;
      return isPrivateIpv4(src) || isPrivateIpv4(dst);
    });
    if (privateUdp.length > 0) {
      console.log("\nTop UDP flows involving private IPs:");
      for (const [k, bytes] of privateUdp.slice(0, 20)) {
        console.log(`  ${k} packets=${udpPacketsByDir.get(k) ?? 0} payloadBytes=${bytes}`);
      }
    }

    const privateToPrivateUdp = udpDirs.filter(([k]) => {
      const m = /^(\d+\.\d+\.\d+\.\d+):\d+ -> (\d+\.\d+\.\d+\.\d+):\d+$/.exec(k);
      if (!m) return false;
      const src = m[1]!;
      const dst = m[2]!;
      return isPrivateIpv4(src) && isPrivateIpv4(dst);
    });
    if (privateToPrivateUdp.length > 0) {
      console.log("\nTop UDP flows private -> private:");
      for (const [k, bytes] of privateToPrivateUdp.slice(0, 50)) {
        console.log(`  ${k} packets=${udpPacketsByDir.get(k) ?? 0} payloadBytes=${bytes}`);
      }
    }

    const flows192 = udpDirs.filter(([k]) => k.includes("192.168."));
    if (flows192.length > 0) {
      console.log("\nTop UDP flows involving 192.168.*:");
      for (const [k, bytes] of flows192.slice(0, 50)) {
        console.log(`  ${k} packets=${udpPacketsByDir.get(k) ?? 0} payloadBytes=${bytes}`);
      }
    }

    const highlighted = [...new Map(highlightedUdpFlows.map((x) => [x.dirKey, x])).values()].sort(
      (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0),
    );
    if (highlighted.length > 0) {
      console.log("\nHighlighted UDP flows (common ports):");
      for (const f of highlighted.slice(0, 50)) {
        console.log(`  ${f.dirKey} packets=${f.packets} payloadBytes=${f.bytes}`);
      }
    }
  }

  const ipTop = topN(ipBytes, ipPackets, 20);
  if (ipTop.length > 0) {
    console.log("\nTop IPs by payload bytes (TCP+UDP):");
    for (const row of ipTop) {
      const priv = isPrivateIpv4(String(row.key)) ? "private" : "public";
      console.log(`  ip=${row.key} (${priv}) packets=${row.packets} payloadBytes=${row.bytes}`);
    }
  }

  if ((process.env.PCAP_DUMP_UDP_7777 ?? "").trim() === "1" && udp7777Samples.length > 0) {
    console.log("\nUDP/7777 samples (first 40):");
    const byLen = new Map<number, number>();
    for (const s of udp7777Samples) byLen.set(s.payloadLen, (byLen.get(s.payloadLen) ?? 0) + 1);
    console.log(
      `Lengths: ${[...byLen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([len, c]) => `${len}x${c}`)
        .join(" ")}`,
    );
    for (const s of udp7777Samples) {
      const headHex = s.payload.subarray(0, Math.min(48, s.payload.length)).toString("hex");
      const parsed = parseUdp7777(s.payload);
      const magic = parsed.magicLE !== undefined ? `0x${parsed.magicLE.toString(16)}` : "?";
      console.log(
        `  t=${s.tsMs.toFixed(1)} ${s.dirKey} len=${s.payloadLen}` +
          ` magicLE=${magic} dataLen=${parsed.dataLen ?? "?"} headerLen=${parsed.headerLen ?? "?"} seq=${parsed.seq ?? "?"}` +
          ` uid=${parsed.uid ? JSON.stringify(parsed.uid) : "?"}` +
          (parsed.checksumHint ? ` checksum=${parsed.checksumHint}` : "") +
          ` dataHeadHex=${parsed.dataHeadHex ?? ""}` +
          ` dataTailHex=${parsed.dataTailHex ?? ""}` +
          (parsed.decodedPreview ? ` decoded=${JSON.stringify(parsed.decodedPreview)}` : "") +
          (parsed.inflatedPreview ? ` inflated=${JSON.stringify(parsed.inflatedPreview)}` : "") +
          ` headHex=${headHex}`,
      );
    }
  }

  if ((process.env.PCAP_DUMP_UDP_7777 ?? "").trim() === "1" && udp7777Samples.length > 0) {
    const sumTcpBytesInWindow = (port: number, t0: number, t1: number): number => {
      let sum = 0;
      for (const [dirKey, segs] of segmentsByDir.entries()) {
        if (!dirKey.includes(`:${port}`)) continue;
        for (const s of segs) {
          if (s.tsMs >= t0 && s.tsMs <= t1) sum += s.payload.length;
        }
      }
      return sum;
    };

    console.log("\nUDP/7777 correlation (bytes near packet):");
    console.log("  window: [-250ms, +2000ms] around each UDP/7777 packet (approx)");
    for (const u of udp7777Samples) {
      const parsed = parseUdp7777(u.payload);
      const w0 = u.tsMs - 250;
      const w1 = u.tsMs + 2000;
      const b9000 = sumTcpBytesInWindow(9000, w0, w1);
      const b6666 = sumTcpBytesInWindow(6666, w0, w1);
      console.log(
        `  t=${u.tsMs.toFixed(1)} len=${u.payloadLen} dataLen=${parsed.dataLen ?? "?"} seq=${parsed.seq ?? "?"}` +
          ` tcp9000Bytes≈${b9000} tcp6666Bytes≈${b6666}`,
      );
    }
  }

  if ((process.env.PCAP_ANALYZE_6666 ?? "").trim() === "1") {
    const flows6666 = [...segmentsByDir.entries()].filter(([k]) => k.includes(":6666") || k.includes("->") && k.includes(":6666 "));
    if (flows6666.length > 0) {
      console.log("\nTCP/6666 analysis (custom hub<->battery framing):");
      console.log("  Looks for u32le magic=0x0001000c, then u32le payloadLen, u32le type, then payloadLen bytes");

      const dumpStreamEvents = (process.env.PCAP_6666_DUMP_STREAM_EVENTS ?? "").trim() === "1";
      const dumpStreamEventsLimit = Number.parseInt((process.env.PCAP_6666_DUMP_STREAM_EVENTS_LIMIT ?? "200").trim(), 10);
      const focusDirKey = (process.env.PCAP_6666_FOCUS_DIRKEY ?? "").trim();
      const focusIp = (process.env.PCAP_6666_FOCUS_IP ?? "").trim();

      const all6666Events: Tcp6666RecordEvent[] = [];
      const exportTranscript = (process.env.PCAP_EXPORT_6666_TRANSCRIPT ?? "").trim() === "1";
      const exportOnlyIp = (process.env.PCAP_EXPORT_6666_TRANSCRIPT_IP ?? "").trim();
      const exportPathRaw = (process.env.PCAP_EXPORT_6666_TRANSCRIPT_PATH ?? "").trim();
      const exportPath = exportPathRaw
        ? (path.isAbsolute(exportPathRaw) ? exportPathRaw : path.resolve(process.cwd(), exportPathRaw))
        : path.resolve(process.cwd(), "test/pcap/exports/last-6666-transcript.json");

      const exportOut: {
        generatedAt: string;
        pcapPath: string;
        hubIp: string;
        entries: Array<{
          dirKey: string;
          reassembledBytes: number;
          gaps: number;
          prefixHex: string;
          prefixU32le0?: number;
          prefixU16le0?: number;
          prefixU16le2?: number;
          prefixTokens: string[];
          prefixTokenHint?: { macHex?: string; uid?: string };
          records: Array<{ tsMs: number; relMs: number; streamOff: number; type: number; len: number; payloadB64: string }>;
        }>;
        udp7777Samples: Array<{ tsMs: number; dirKey: string; payloadLen: number; parsed: Udp7777Parsed; payloadB64: string }>;
      } = {
        generatedAt: new Date().toISOString(),
        pcapPath,
        hubIp,
        entries: [],
        udp7777Samples: udp7777Samples.map((s) => ({
          tsMs: s.tsMs,
          dirKey: s.dirKey,
          payloadLen: s.payloadLen,
          parsed: parseUdp7777(s.payload),
          payloadB64: s.payload.toString("base64"),
        })),
      };

      for (const [dirKey, segments] of flows6666) {
        const { data, gaps } = reassembleTcpSegments(segments);
        const proto = guessProtocolFromTcpPrefix(data);
        console.log(`\n  Flow ${dirKey} segments=${segments.length} reassembledBytes=${data.length} gaps=${gaps}${proto ? ` protoGuess=${proto}` : ""}`);
        console.log(`  headHex=${data.subarray(0, Math.min(48, data.length)).toString("hex")}`);

        const searchIps = (process.env.PCAP_6666_SEARCH_IPS ?? "").trim();
        const ipsToSearch = [hubIp, ...searchIps.split(",").map((s) => s.trim()).filter(Boolean)];
        const ipNeedles = ipsToSearch
          .map((ip) => ({ ip, bytes: ipv4ToBytes(ip) }))
          .filter((x): x is { ip: string; bytes: Buffer } => Boolean(x.bytes));
        const port7777be = Buffer.from([0x1e, 0x61]);
        const port7777le = Buffer.from([0x61, 0x1e]);

        const records = findLenTypeRecordsAnywhere(data, 500);
        if (records.length === 0) {
          const p = tryParseLenTypeRecords(data);
          console.log(`  No 0x0001000c records found (tryParseLenTypeRecords=${p ? p.length : 0})`);
          continue;
        }

        // Timestamp-aware parsing (works even if reassembled payload was out-of-order in capture)
        const parsedStream = parse6666RecordsFromSegments(dirKey, segments, 20000);
        all6666Events.push(...parsedStream.events);
        if (parsedStream.events.length > 0) {
          const firstTs = parsedStream.events[0]!.tsMs;
          const lastTs = parsedStream.events[parsedStream.events.length - 1]!.tsMs;
          console.log(
            `  Stream records (timestamped): count=${parsedStream.events.length} span≈${(lastTs - firstTs).toFixed(1)}ms firstTs=${firstTs.toFixed(1)} lastTs=${lastTs.toFixed(1)}`,
          );
          const byTypeTs = new Map<number, number>();
          for (const e of parsedStream.events) byTypeTs.set(e.type, (byTypeTs.get(e.type) ?? 0) + 1);
          const topTypesTs = [...byTypeTs.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([t, c]) => `type=${t}x${c}`)
            .join(" ");
          console.log(`  Stream top types: ${topTypesTs || "-"}`);

          if (dumpStreamEvents) {
            const focusOk =
              (!focusDirKey || dirKey.includes(focusDirKey)) &&
              (!focusIp || dirKey.includes(`${focusIp}:`) || dirKey.includes(`-> ${focusIp}:`));

            if (focusOk) {
              const limit = Number.isFinite(dumpStreamEventsLimit) && dumpStreamEventsLimit > 0 ? dumpStreamEventsLimit : 200;
              console.log(`  Stream event timeline (first ${Math.min(limit, parsedStream.events.length)}):`);
              for (const e of parsedStream.events.slice(0, limit)) {
                const rel = (e.tsMs - firstTs).toFixed(1);
                const pay = tryGet6666RecordPayloadAt(data, e.streamOff);
                const head = pay?.payload ? pay.payload.subarray(0, Math.min(24, pay.payload.length)).toString("hex") : "";
                console.log(
                  `    t+${rel}ms off=${e.streamOff} type=${e.type} len=${e.len}` +
                    (head ? ` payloadHeadHex=${head}` : ""),
                );
              }
            }
          }

          if (parsedStream.prefix.length > 0) {
            const tks = scanForAsciiTokens(parsedStream.prefix, 6, 20);
            const hint = tks.map(parseMacUidToken).find((x) => x.macHex || x.uid);
            const head = parsedStream.prefix.subarray(0, Math.min(96, parsedStream.prefix.length)).toString("hex");
            console.log(`  Stream prefixCaptured=${parsedStream.prefix.length} headHex=${head}`);
            if (tks.length) console.log(`  Stream prefixTokens=${tks.map((t) => JSON.stringify(t)).join(" ")}`);
            if (hint?.macHex || hint?.uid) console.log(`  Stream prefixTokenHint: macHex=${hint.macHex ?? "?"} uid=${hint.uid ?? "?"}`);
          }
        }

        const firstOff = records[0]!.off;
        if (firstOff > 0) {
          const prefix = data.subarray(0, firstOff);
          const prefixHeadHex = prefix.subarray(0, Math.min(96, prefix.length)).toString("hex");
          const prefixTokens = scanForAsciiTokens(prefix, 6, 20);
          const u32a = prefix.length >= 4 ? prefix.readUInt32LE(0) : undefined;
          const u16a = prefix.length >= 2 ? prefix.readUInt16LE(0) : undefined;
          const u16b = prefix.length >= 4 ? prefix.readUInt16LE(2) : undefined;
          console.log(
            `  Prefix before framed records: len=${prefix.length}` +
              (u32a !== undefined ? ` u32le@0=${u32a}` : "") +
              (u16a !== undefined && u16b !== undefined ? ` u16le@0=${u16a} u16le@2=${u16b}` : ""),
          );
          console.log(`  prefixHeadHex=${prefixHeadHex}`);
          if (prefixTokens.length) {
            console.log(`  prefixTokens=${prefixTokens.map((t) => JSON.stringify(t)).join(" ")}`);
            const macUid = prefixTokens.map(parseMacUidToken).find((x) => x.macHex || x.uid);
            if (macUid?.macHex || macUid?.uid) {
              console.log(`  prefixTokenHint: macHex=${macUid.macHex ?? "?"} uid=${macUid.uid ?? "?"}`);
            }
          }

          const p7777InPrefix = {
            be: findAllOccurrences(prefix, port7777be, 6),
            le: findAllOccurrences(prefix, port7777le, 6),
          };
          if (p7777InPrefix.be.length || p7777InPrefix.le.length) {
            console.log(
              `  prefix has port7777 bytes at ${[
                ...p7777InPrefix.be.map((o) => `be:${o}`),
                ...p7777InPrefix.le.map((o) => `le:${o}`),
              ].join("|")}`,
            );
          }
          for (const n of ipNeedles) {
            const occ = findAllOccurrences(prefix, n.bytes, 6);
            if (occ.length) console.log(`  prefix has ip=${n.ip} at off=${occ.join(",")}`);
          }
        }

        if (exportTranscript) {
          if (exportOnlyIp && !dirKey.includes(`${exportOnlyIp}:`) && !dirKey.includes(`-> ${exportOnlyIp}:`)) {
            // skip
          } else {
            const firstOff2 = records[0]!.off;
            const prefix = firstOff2 > 0 ? data.subarray(0, firstOff2) : Buffer.alloc(0);
            const prefixU32le0 = prefix.length >= 4 ? prefix.readUInt32LE(0) : undefined;
            const prefixU16le0 = prefix.length >= 2 ? prefix.readUInt16LE(0) : undefined;
            const prefixU16le2 = prefix.length >= 4 ? prefix.readUInt16LE(2) : undefined;
            const prefixTokens = scanForAsciiTokens(prefix, 6, 50);
            const prefixTokenHint = prefixTokens.map(parseMacUidToken).find((x) => x.macHex || x.uid);

            const firstTs = parsedStream.events[0]?.tsMs ?? 0;
            const outRecs: Array<{ tsMs: number; relMs: number; streamOff: number; type: number; len: number; payloadB64: string }> = [];
            for (const e of parsedStream.events) {
              const pay = tryGet6666RecordPayloadAt(data, e.streamOff);
              const payloadB64 = pay?.payload ? pay.payload.toString("base64") : "";
              outRecs.push({
                tsMs: e.tsMs,
                relMs: e.tsMs - firstTs,
                streamOff: e.streamOff,
                type: e.type,
                len: e.len,
                payloadB64,
              });
            }

            const entry: (typeof exportOut.entries)[number] = {
              dirKey,
              reassembledBytes: data.length,
              gaps,
              prefixHex: prefix.toString("hex"),
              prefixTokens,
              records: outRecs,
            };
            if (prefixU32le0 != null) entry.prefixU32le0 = prefixU32le0;
            if (prefixU16le0 != null) entry.prefixU16le0 = prefixU16le0;
            if (prefixU16le2 != null) entry.prefixU16le2 = prefixU16le2;
            if (prefixTokenHint?.macHex || prefixTokenHint?.uid) entry.prefixTokenHint = prefixTokenHint;
            exportOut.entries.push(entry);
          }
        }

        const byType = new Map<number, number>();
        const byLen = new Map<number, number>();
        for (const r of records) {
          byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
          byLen.set(r.len, (byLen.get(r.len) ?? 0) + 1);
        }
        const topTypes = [...byType.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([t, c]) => `type=${t}x${c}`)
          .join(" ");
        const topLens = [...byLen.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([l, c]) => `${l}x${c}`)
          .join(" ");
        console.log(`  Parsed records=${records.length} (top types: ${topTypes || "-"})`);
        console.log(`  Payload lengths: ${topLens || "-"}`);

        for (const r of records.slice(0, 40)) {
          const p7777le = scanForU16Value(r.payload, 7777, "le", 4);
          const p7777be = scanForU16Value(r.payload, 7777, "be", 4);
          const p9000le = scanForU16Value(r.payload, 9000, "le", 4);
          const p9000be = scanForU16Value(r.payload, 9000, "be", 4);
          const tokens = scanForAsciiTokens(r.payload, 10, 8);
          const tokenHint = tokens.find((t) => t.length >= 16 && t.length <= 24) ?? tokens[0];

          const ipHits: string[] = [];
          for (const n of ipNeedles) {
            const occ = findAllOccurrences(r.payload, n.bytes, 3);
            if (occ.length) ipHits.push(`${n.ip}@${occ.join("|")}`);
          }

          const head = r.payload.subarray(0, Math.min(32, r.payload.length)).toString("hex");
          const tail = r.payload.subarray(Math.max(0, r.payload.length - 16)).toString("hex");
          console.log(
            `  rec off=${r.off} type=${r.type} len=${r.len} head=${head}${r.payload.length > 32 ? ` tail=${tail}` : ""}` +
              (ipHits.length ? ` ipHits=${ipHits.join(",")}` : "") +
              (p7777le.length || p7777be.length ? ` port7777@${[...p7777le.map((o) => `le:${o}`), ...p7777be.map((o) => `be:${o}`)].join("|")}` : "") +
              (p9000le.length || p9000be.length ? ` port9000@${[...p9000le.map((o) => `le:${o}`), ...p9000be.map((o) => `be:${o}`)].join("|")}` : "") +
              (tokenHint ? ` token=${JSON.stringify(tokenHint)}` : ""),
          );

          if ((process.env.PCAP_DUMP_6666_PAYLOADS ?? "").trim() === "1" && r.len > 0 && r.len <= 512) {
            console.log(`    ascii=${JSON.stringify(previewAscii(r.payload.subarray(0, Math.min(256, r.payload.length))))}`);
          }
        }
      }

      if (exportTranscript && exportOut.entries.length > 0) {
        writeJson(exportPath, exportOut);
        console.log(`\nWrote TCP/6666 transcript export: ${exportPath}`);
        console.log(`  entries=${exportOut.entries.length} udp7777Samples=${exportOut.udp7777Samples.length}`);
      }

      if ((process.env.PCAP_DUMP_UDP_7777 ?? "").trim() === "1" && udp7777Samples.length > 0 && all6666Events.length > 0) {
        console.log("\nUDP/7777 vs TCP/6666 record correlation:");
        console.log("  window: [-250ms, +2000ms] around each UDP/7777 packet (approx)");
        const eventsSorted = [...all6666Events].sort((a, b) => a.tsMs - b.tsMs);
        const reassembledByDir = new Map<string, Buffer>();
        for (const [dirKey, segs] of flows6666) {
          const { data } = reassembleTcpSegments(segs);
          reassembledByDir.set(dirKey, data);
        }
        for (const u of udp7777Samples) {
          const w0 = u.tsMs - 250;
          const w1 = u.tsMs + 2000;

          const udpIps = extractSrcDstIpFromDirKey(u.dirKey);
          const camIp = udpIps?.srcIp;
          const hits = eventsSorted.filter((e) => {
            if (e.tsMs < w0 || e.tsMs > w1) return false;
            if (!camIp) return true;
            return e.dirKey.includes(`${camIp}:`) || e.dirKey.includes(`-> ${camIp}:`);
          });
          const byType = new Map<number, number>();
          for (const h of hits) byType.set(h.type, (byType.get(h.type) ?? 0) + 1);
          const top = [...byType.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([t, c]) => `${t}x${c}`)
            .join(" ");
          console.log(
            `  t=${u.tsMs.toFixed(1)} len=${u.payloadLen} src=${camIp ?? "?"} -> 6666records=${hits.length}${top ? ` types=${top}` : ""}`,
          );

          if ((process.env.PCAP_6666_DUMP_AROUND_UDP ?? "").trim() === "1" && hits.length > 0) {
            for (const h of hits.slice(0, 12)) {
              const dt = h.tsMs - u.tsMs;
              const reassembled = reassembledByDir.get(h.dirKey);
              const pay = reassembled ? tryGet6666RecordPayloadAt(reassembled, h.streamOff) : undefined;
              const head = pay?.payload ? pay.payload.subarray(0, Math.min(24, pay.payload.length)).toString("hex") : "";
              console.log(
                `    dt=${dt.toFixed(1)}ms dir=${h.dirKey} off=${h.streamOff} type=${h.type} len=${h.len}` +
                  (head ? ` payloadHeadHex=${head}` : ""),
              );
            }
          }
        }
      }
    }
  }

  // Focus: Baichuan over TCP/9000 between hub and pc (default), or all flows when PCAP_ANALYZE_ALL_9000=1
  const targets = [...segmentsByDir.entries()].filter(([k]) => {
    if (!Number.isFinite(baichuanTcpPort)) return false;
    if (!k.includes(`:${baichuanTcpPort}`)) return false;
    if (analyzeAll9000) return true;
    return (
      k.startsWith(`${hubIp}:${baichuanTcpPort} -> ${pcIp}:`) ||
      k.startsWith(`${pcIp}:`) ||
      k.includes(`-> ${hubIp}:${baichuanTcpPort}`)
    );
  });

  // Optional manual override for captures missing the login negotiation.
  // Example: BAICHUAN_NONCE=... BAICHUAN_ENC_TYPE=0x12
  globalSession = parseEnvSessionOverride() ?? globalSession;
  if (globalSession?.nonce) {
    const encTypeHex = globalSession.encType !== undefined ? `0x${globalSession.encType.toString(16)}` : "?";
    const encKind = globalSession.enc.kind;
    const aesNote =
      encKind === "aes"
        ? ` (${globalSession.enc.mode}, key derived: yes)`
        : globalSession.encType && (globalSession.encType === 0x02 || globalSession.encType === 0x12)
          ? " (AES, key derived: no - set BAICHUAN_PASSWORD/NVR_PASSWORD/TCP_PASSWORD)"
          : "";
    console.log(`Session override: nonce=${globalSession.nonce} encType=${encTypeHex} -> enc=${encKind}${aesNote}`);
  }

  // Detect session encryption by scanning both directions for the legacy login reply.
  // This is required to decrypt client->hub request frames, since the nonce/encType appears in hub->client traffic.
  const allFrames: BaichuanFrame[] = [];
  for (const [, segments] of targets) {
    const { data } = reassembleTcpSegments(segments);
    const parser = new BaichuanFrameParser();
    const out = parser.push(data) as BaichuanFrame[];
    for (const f of out) allFrames.push(f);
  }
  if (!globalSession || globalSession.enc.kind === "unknown") {
    globalSession = detectSessionFromFrames(allFrames);
  }
  if (globalSession?.nonce) {
    const encTypeHex = globalSession.encType !== undefined ? `0x${globalSession.encType.toString(16)}` : "?";
    const encKind = globalSession.enc.kind;
    const aesNote =
      encKind === "aes"
        ? ` (${globalSession.enc.mode}, key derived: yes)`
        : globalSession.encType && (globalSession.encType === 0x02 || globalSession.encType === 0x12)
          ? " (AES, key derived: no - set BAICHUAN_PASSWORD/NVR_PASSWORD/TCP_PASSWORD)"
          : "";
    console.log(`Session negotiation observed: nonce=${globalSession.nonce} encType=${encTypeHex} -> enc=${encKind}${aesNote}`);
  }

  for (const [dirKey, segments] of targets) {
    const label = `${dirKey} (segments=${segments.length})`;
    analyzeBaichuanSegments(label, segments);
  }
}

main();
