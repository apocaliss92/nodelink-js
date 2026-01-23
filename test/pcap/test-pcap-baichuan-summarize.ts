#!/usr/bin/env node
/**
 * PCAP-based analysis: summarize Baichuan TCP/9000 traffic without tshark.
 *
 * Usage:
 *   npm run test:build && node dist/test/pcap/test-pcap-baichuan-summarize.js pcap/192.168.50.226_1.pcapng --host 192.168.50.226
 *
 * Output:
 *   JSON summary to stdout (meant to be diffed across captures/devices).
 */

import fs from "node:fs";
import path from "node:path";

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { BaichuanFrameParser } from "../../index.js";
// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { aesDecrypt, bcDecrypt, deriveAesKey } from "../../index.js";

type Endian = "le" | "be";

type TcpSegment = { seq: number; tsMs: number; payload: Buffer };

type PcapInterface = { linkType: number; tsResol: number };

type FrameLike = {
  header: {
    cmdId: number;
    bodyLen: number;
    channelId: number;
    streamType: number;
    msgNum: number;
    responseCode: number;
    messageClass: number;
    payloadOffset?: number;
  };
  body: Buffer;
  payload: Buffer;
  extension: Buffer;
  raw: Buffer;
};

function bucketLen(n: number): string {
  if (n === 0) return "0";
  if (n < 4) return "<4";
  if (n < 16) return "<16";
  if (n < 64) return "<64";
  if (n < 256) return "<256";
  if (n < 1024) return "<1K";
  if (n < 8192) return "<8K";
  return ">=8K";
}

const ADDITIONAL_HEADER_MAGIC = Buffer.from([0x0b, 0x00, 0x01, 0x08]);

function findAdditionalHeaderMagicOffset(
  payload: Buffer,
  maxScan: number,
): number {
  if (payload.length < ADDITIONAL_HEADER_MAGIC.length) return -1;
  const limit = Math.min(
    payload.length - ADDITIONAL_HEADER_MAGIC.length,
    maxScan,
  );
  for (let i = 0; i <= limit; i++) {
    if (
      payload
        .subarray(i, i + ADDITIONAL_HEADER_MAGIC.length)
        .equals(ADDITIONAL_HEADER_MAGIC)
    )
      return i;
  }
  return -1;
}

function toHexSample(b: Buffer, maxBytes: number): string {
  const slice = b.subarray(0, Math.min(b.length, maxBytes));
  return slice.toString("hex");
}

function toAsciiSample(b: Buffer, maxBytes: number): string {
  const slice = b.subarray(0, Math.min(b.length, maxBytes));
  let out = "";
  for (const ch of slice) {
    out += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  }
  return out;
}

const KNOWN_MP4_BOX_TYPES = new Set([
  "ftyp",
  "moov",
  "mdat",
  "free",
  "skip",
  "moof",
  "traf",
  "tfhd",
  "trun",
  "mfhd",
  "mfra",
  "styp",
  "sidx",
  "emsg",
]);

function detectMp4BoxType(payload: Buffer): {
  boxType: string | null;
  boxSizeBE: number | null;
} {
  if (payload.length < 8) return { boxType: null, boxSizeBE: null };
  const size = payload.readUInt32BE(0);
  const type = payload.subarray(4, 8).toString("ascii");
  const looksAscii = /^[A-Za-z0-9 ]{4}$/.test(type);
  if (!looksAscii) return { boxType: null, boxSizeBE: size };
  return { boxType: type, boxSizeBE: size };
}

function looksLikeAnnexB(payload: Buffer): boolean {
  if (payload.length < 4) return false;
  // 00 00 00 01 or 00 00 01
  if (
    payload[0]! === 0x00 &&
    payload[1]! === 0x00 &&
    payload[2]! === 0x00 &&
    payload[3]! === 0x01
  )
    return true;
  if (payload[0]! === 0x00 && payload[1]! === 0x00 && payload[2]! === 0x01)
    return true;
  return false;
}

function looksLikeAdts(payload: Buffer): boolean {
  if (payload.length < 2) return false;
  // ADTS syncword 0xFFF (12 bits)
  return payload[0]! === 0xff && (payload[1]! & 0xf0) === 0xf0;
}

function readU16(buf: Buffer, off: number, endian: Endian): number {
  return endian === "le" ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}

function readU32(buf: Buffer, off: number, endian: Endian): number {
  return endian === "le" ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

function ipToString(pkt: Buffer, off: number): string {
  return `${pkt[off]}.${pkt[off + 1]}.${pkt[off + 2]}.${pkt[off + 3]}`;
}

function reassembleTcpSegments(segments: TcpSegment[]): {
  data: Buffer;
  gaps: number;
} {
  const sorted = [...segments].sort((a, b) => a.seq - b.seq || a.tsMs - b.tsMs);
  const out: Buffer[] = [];
  let expectedSeq: number | undefined;
  let gaps = 0;

  for (const s of sorted) {
    if (expectedSeq === undefined) {
      out.push(s.payload);
      expectedSeq = (s.seq + s.payload.length) >>> 0;
      continue;
    }

    if (s.seq === expectedSeq) {
      out.push(s.payload);
      expectedSeq = (expectedSeq + s.payload.length) >>> 0;
      continue;
    }

    // overlaps
    if (s.seq < expectedSeq) {
      const delta = expectedSeq - s.seq;
      if (delta < s.payload.length) {
        const tail = s.payload.subarray(delta);
        out.push(tail);
        expectedSeq = (expectedSeq + tail.length) >>> 0;
      }
      continue;
    }

    // gap
    gaps += 1;
    out.push(s.payload);
    expectedSeq = (s.seq + s.payload.length) >>> 0;
  }

  return { data: Buffer.concat(out), gaps };
}

function inc(map: Record<string, number>, key: string | number): void {
  const k = String(key);
  map[k] = (map[k] ?? 0) + 1;
}

function isKnownBcMediaMagic(m: number): boolean {
  const isInfoV1 = m === 0x31303031; // "1001"
  const isInfoV2 = m === 0x32303031; // "1002"
  const isIFrame = m >= 0x63643030 && m <= 0x63643039; // "cd00".."cd09"
  const isPFrame = m >= 0x63643130 && m <= 0x63643139; // "cd10".."cd19"
  const isAac = m === 0x62773530; // "bw50"
  const isAdpcm = m === 0x62773130; // "bw10"
  return isInfoV1 || isInfoV2 || isIFrame || isPFrame || isAac || isAdpcm;
}

function findBcMediaMagicOffset(b: Buffer, maxScan: number): number {
  if (b.length < 4) return -1;
  const limit = Math.min(b.length - 4, maxScan);
  for (let i = 0; i <= limit; i++) {
    if (isKnownBcMediaMagic(b.readUInt32LE(i))) return i;
  }
  return -1;
}

function loadDotEnvIfPresent(cwd: string): void {
  // Lightweight .env loader (no dependency). Only sets process.env[k] if missing.
  const envPath = path.join(cwd, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || String(process.env[key]).length === 0) {
      process.env[key] = val;
    }
  }
}

function passwordForHostFromEnv(host: string): string | undefined {
  const h = host.trim();
  if (!h) return undefined;

  // Prefer explicit Baichuan password if set.
  const direct = (process.env.BAICHUAN_PASSWORD ?? "").trim();
  if (direct) return direct;

  // Common convention in this repo: <PREFIX>_HOST and <PREFIX>_PASSWORD
  // e.g. TCP_HOST/TCP_PASSWORD, TCP265_HOST/TCP265_PASSWORD, NVR_HOST/NVR_PASSWORD, ...
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.endsWith("_HOST")) continue;
    if (!v) continue;
    if (String(v).trim() !== h) continue;
    const prefix = k.slice(0, -"_HOST".length);
    const pw = (process.env[`${prefix}_PASSWORD`] ?? "").trim();
    if (pw) return pw;
  }

  // Fallbacks
  const tcpPw = (process.env.TCP_PASSWORD ?? "").trim();
  if (tcpPw) return tcpPw;
  return undefined;
}

type SampleXmlCfg =
  | { mode: "none" }
  | { mode: "all"; limitPerCmdPerDir: number }
  | { mode: "cmd"; cmdIds: Set<number>; limitPerCmdPerDir: number };

function parseArgs(argv: string[]): {
  pcapPath: string;
  host: string;
  port: number;
  password?: string;
  sampleXml: SampleXmlCfg;
  sampleXmlMaxChars: number;
} {
  loadDotEnvIfPresent(process.cwd());

  const args = [...argv];
  const pcapPath = args.shift();
  if (!pcapPath) throw new Error("Missing pcap path arg");

  let host = process.env.BAICHUAN_HOST ?? "";
  let port = Number.parseInt(process.env.BAICHUAN_TCP_PORT ?? "9000", 10);
  let password: string | undefined =
    (process.env.BAICHUAN_PASSWORD ?? "").trim() ||
    (process.env.TCP_PASSWORD ?? "").trim() ||
    undefined;

  let sampleXml: SampleXmlCfg = { mode: "none" };
  const sampleCmdIds = new Set<number>();
  let limitPerCmdPerDir = Number.parseInt(
    process.env.BAICHUAN_SAMPLE_LIMIT ?? "6",
    10,
  );
  if (!Number.isFinite(limitPerCmdPerDir) || limitPerCmdPerDir <= 0)
    limitPerCmdPerDir = 6;

  let sampleXmlMaxChars = Number.parseInt(
    process.env.BAICHUAN_SAMPLE_XML_MAX ?? "420",
    10,
  );
  if (!Number.isFinite(sampleXmlMaxChars) || sampleXmlMaxChars <= 0)
    sampleXmlMaxChars = 420;

  while (args.length) {
    const a = args.shift();
    if (!a) break;
    if (a === "--host") {
      host = String(args.shift() ?? "");
      continue;
    }
    if (a === "--port") {
      port = Number.parseInt(String(args.shift() ?? "9000"), 10);
      continue;
    }
    if (a === "--any-port") {
      port = 0;
      continue;
    }
    if (a === "--password") {
      password = String(args.shift() ?? "").trim() || undefined;
      continue;
    }

    if (a === "--sample-limit") {
      const n = Number.parseInt(String(args.shift() ?? ""), 10);
      if (Number.isFinite(n) && n > 0) limitPerCmdPerDir = n;
      // Keep sampleXml in sync if it was already enabled.
      if (sampleXml.mode === "all")
        sampleXml = { mode: "all", limitPerCmdPerDir };
      if (sampleXml.mode === "cmd")
        sampleXml = { mode: "cmd", cmdIds: sampleCmdIds, limitPerCmdPerDir };
      continue;
    }

    if (a === "--sample-xml-max") {
      const n = Number.parseInt(String(args.shift() ?? ""), 10);
      if (Number.isFinite(n) && n > 0) sampleXmlMaxChars = n;
      continue;
    }

    if (a === "--sample-xml") {
      // Sample XML for a curated set of cmdIds (mainly for settings captures).
      sampleXml = { mode: "cmd", cmdIds: sampleCmdIds, limitPerCmdPerDir };
      continue;
    }

    if (a === "--sample-xml-all") {
      sampleXml = { mode: "all", limitPerCmdPerDir };
      continue;
    }

    if (a === "--sample-cmd") {
      const raw = String(args.shift() ?? "").trim();
      for (const part of raw.split(/[,\s]+/g)) {
        if (!part) continue;
        const n = Number.parseInt(part, 10);
        if (Number.isFinite(n)) sampleCmdIds.add(n);
      }
      sampleXml = { mode: "cmd", cmdIds: sampleCmdIds, limitPerCmdPerDir };
      continue;
    }
  }

  host = host.trim();
  if (!host) throw new Error("Missing --host (or BAICHUAN_HOST)");

  // If not explicitly provided, try to pick the right password for this host.
  if (!password) {
    password = passwordForHostFromEnv(host);
  }

  // port=0 means "any port" (host-only filtering)
  if (!Number.isFinite(port) || port < 0)
    throw new Error(`Invalid port: ${port}`);

  // If --sample-xml was passed with no explicit cmd list, prefill a common settings set.
  if (sampleXml.mode === "cmd" && sampleCmdIds.size === 0) {
    for (const id of [
      1, 10, 26, 33, 44, 54, 56, 57, 58, 70, 76, 78, 79, 80, 81, 93, 102, 104,
      109, 114, 115, 116, 145, 146, 151, 192, 199, 208, 209, 212, 217, 231, 232,
      253, 264, 265, 289, 290, 291, 296, 299, 318, 319, 342, 343, 439, 440, 464,
      481, 484, 507, 511, 547, 574, 623, 723,
    ])
      sampleCmdIds.add(id);
  }

  return {
    pcapPath,
    host,
    port,
    ...(password != null ? { password } : {}),
    sampleXml,
    sampleXmlMaxChars,
  };
}

function main(): void {
  // Avoid crashing when stdout is closed early (e.g. piping to `head`).
  process.stdout.on("error", (err: any) => {
    if (err?.code === "EPIPE") process.exit(0);
  });

  const { pcapPath, host, port, password, sampleXml, sampleXmlMaxChars } =
    parseArgs(process.argv.slice(2));
  const abs = path.resolve(process.cwd(), pcapPath);
  const buf = fs.readFileSync(abs);
  if (buf.length < 12) throw new Error("Capture too small");

  const interfaceDefs: PcapInterface[] = [];
  const segmentsByDir = new Map<string, TcpSegment[]>();

  // When capturing without a port filter, this helps identify which ports the camera actually uses.
  const cameraPortsPackets: Record<string, number> = {};
  const cameraPortsBytes: Record<string, number> = {};

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
    if (proto !== 6) return;

    const ipTotalLen = pkt.readUInt16BE(ipOffset + 2);
    const srcIp = ipToString(pkt, ipOffset + 12);
    const dstIp = ipToString(pkt, ipOffset + 16);

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

    const isInScope =
      port === 0
        ? dstIp === host || srcIp === host
        : (dstIp === host && dstPort === port) ||
          (srcIp === host && srcPort === port);
    if (!isInScope) return;

    const cameraPort = srcIp === host ? srcPort : dstPort;
    inc(cameraPortsPackets, cameraPort);
    cameraPortsBytes[String(cameraPort)] =
      (cameraPortsBytes[String(cameraPort)] ?? 0) + payload.length;

    const dirKey = `${srcIp}:${srcPort} -> ${dstIp}:${dstPort}`;
    const arr = segmentsByDir.get(dirKey) ?? [];
    arr.push({ seq, tsMs, payload: Buffer.from(payload) });
    segmentsByDir.set(dirKey, arr);
  }

  const magicOrBlockType = buf.readUInt32LE(0);
  const isPcapng = magicOrBlockType === 0x0a0d0d0a;
  if (!isPcapng) throw new Error("Expected PCAPNG");

  const bomLE = buf.readUInt32LE(8);
  const bomBE = buf.readUInt32BE(8);
  let endian: Endian;
  if (bomLE === 0x1a2b3c4d) endian = "le";
  else if (bomBE === 0x1a2b3c4d) endian = "be";
  else throw new Error("Unknown PCAPNG endianness");

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

        let tsResol = 1e-6;
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
          optOff = optOff + optLen + ((4 - (optLen % 4)) % 4);
        }

        interfaceDefs.push({ linkType, tsResol });
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
          const iface = interfaceDefs[interfaceId] ??
            interfaceDefs[0] ?? { linkType: 1, tsResol: 1e-6 };
          const ticks = (BigInt(tsHigh) << 32n) | BigInt(tsLow);
          const tsMs = Number(ticks) * iface.tsResol * 1000;
          ingestPacket(buf.subarray(pktStart, pktEnd), iface.linkType, tsMs);
        }
      }
    }

    off = blockEnd;
  }

  const byCmd: Record<string, any> = {};
  const dirs: any[] = [];

  // Optional: derive AES key from cmdId=1 negotiation (nonce) so we can decrypt cmdId=143 samples.
  let negotiatedEncType: number | null = null;
  let negotiatedNonce: string | null = null;
  let negotiatedAesKey: Buffer | null = null;

  const tryDecodeXml = (buf: Buffer): string | null => {
    if (!buf || buf.length === 0) return null;
    const s = buf.toString("utf8");
    const head = s.slice(0, 64).trimStart();
    if (head.startsWith("<?xml") || head.startsWith("<")) return s;
    return null;
  };

  const xmlRootTag = (xml: string): string | null => {
    const s = xml.trimStart();
    const withoutDecl = s.startsWith("<?xml")
      ? s.replace(/^<\?xml[^>]*\?>\s*/i, "")
      : s;
    const m = /^<([A-Za-z0-9_:-]+)(\s|>)/.exec(withoutDecl);
    return m?.[1] ?? null;
  };

  const tryDecryptXmlFrom = (
    buf: Buffer,
    channelId: number,
  ): {
    enc: "none" | "bc" | "aes";
    xml: string;
    root: string | null;
  } | null => {
    if (!buf || buf.length === 0) return null;

    // Prefer AES when we can derive a key (post-login captures).
    if (negotiatedAesKey) {
      try {
        const dec = aesDecrypt(buf, negotiatedAesKey);
        const xml = tryDecodeXml(dec);
        if (xml) return { enc: "aes", xml, root: xmlRootTag(xml) };
      } catch {
        // ignore
      }
    }

    // BC-XOR candidate (common for negotiation and some legacy commands)
    for (const off of [channelId, 250, 0]) {
      try {
        const dec = bcDecrypt(buf, off);
        const xml = tryDecodeXml(dec);
        if (xml) return { enc: "bc", xml, root: xmlRootTag(xml) };
      } catch {
        // ignore
      }
    }

    // Raw plaintext
    const raw = tryDecodeXml(buf);
    if (raw) return { enc: "none", xml: raw, root: xmlRootTag(raw) };
    return null;
  };

  const tryParseNonce = (xml: string): string | null => {
    const m = /<nonce>([^<]+)<\/nonce>/i.exec(xml);
    return m?.[1]?.trim() ? m[1].trim() : null;
  };

  const tryAesDec = (buf: Buffer): Buffer | null => {
    if (!negotiatedAesKey) return null;
    try {
      return aesDecrypt(buf, negotiatedAesKey);
    } catch {
      return null;
    }
  };

  const postProcessCmd143Decrypt = () => {
    if (!negotiatedAesKey) return;
    const c143 = byCmd["143"]; // may not exist
    const ex = c143?.extra?.cmd143;
    if (!ex) return;

    const decorate = (sample: any, label: string) => {
      if (!sample || sample.aesDecHeadHex) return;
      const b64 = typeof sample.bodyB64 === "string" ? sample.bodyB64 : "";
      if (!b64) return;
      const body = Buffer.from(b64, "base64");
      const dec = tryAesDec(body);
      if (!dec) return;
      const off =
        typeof sample.payloadOffset === "number" ? sample.payloadOffset : 0;
      const decPayload = dec.subarray(Math.min(Math.max(off, 0), dec.length));
      sample.aesDecLen = dec.length;
      sample.aesDecHeadHex = toHexSample(decPayload, 160);
      sample.aesDecHeadAscii = toAsciiSample(decPayload, 160);
      sample.aesDecLabel = label;

      // Help reverse engineering: keep decrypted UTF-8 for small request payloads.
      try {
        const text = decPayload.toString("utf8");
        if (label === "req") {
          sample.aesDecUtf8 = text;
        } else {
          sample.aesDecUtf8Preview =
            text.length > 2048 ? `${text.slice(0, 2048)}…` : text;
        }
      } catch {
        // ignore
      }
    };

    if (Array.isArray(ex.reqSamples)) {
      for (const s of ex.reqSamples) decorate(s, "req");
    }
    if (Array.isArray(ex.rspExtSamples)) {
      for (const s of ex.rspExtSamples) decorate(s, "rsp");
    }
  };

  const topCameraPortsByBytes = Object.entries(cameraPortsBytes)
    .map(([p, bytes]) => ({ port: Number.parseInt(p, 10), bytes }))
    .filter((x) => Number.isFinite(x.port))
    .sort(
      (a, b) =>
        (b.bytes as number) - (a.bytes as number) ||
        (a.port as number) - (b.port as number),
    );

  const parsePorts =
    port === 0
      ? new Set(topCameraPortsByBytes.slice(0, 3).map((x) => x.port))
      : new Set([port]);

  const parsedDirs: Array<{
    kind: "req" | "rsp" | "other";
    frames: FrameLike[];
  }> = [];

  for (const [dirKey, segs] of segmentsByDir.entries()) {
    const m = /^(\d+\.\d+\.\d+\.\d+):(\d+) -> (\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(
      dirKey,
    );
    const srcIp = m?.[1] ?? "";
    const srcPort = Number.parseInt(m?.[2] ?? "0", 10);
    const dstIp = m?.[3] ?? "";
    const dstPort = Number.parseInt(m?.[4] ?? "0", 10);

    const cameraPort = srcIp === host ? srcPort : dstPort;
    if (!parsePorts.has(cameraPort)) {
      // Keep direction inventory even if we skip parsing Baichuan frames for this port.
      const bytes = segs.reduce((acc, s) => acc + s.payload.length, 0);
      const kind =
        port === 0
          ? dstIp === host
            ? "req"
            : srcIp === host
              ? "rsp"
              : "other"
          : "other";
      dirs.push({
        dirKey,
        kind,
        segments: segs.length,
        bytes,
        gaps: 0,
        frames: 0,
      });
      continue;
    }

    const { data, gaps } = reassembleTcpSegments(segs);
    // Important: do NOT reuse the parser across independent TCP directions.
    // Doing so can leak framing state and skew results.
    const parser = new BaichuanFrameParser();
    const frames = parser.push(data) as unknown as FrameLike[];

    // classify direction

    const kind =
      port === 0
        ? dstIp === host
          ? "req"
          : srcIp === host
            ? "rsp"
            : "other"
        : dstIp === host && dstPort === port
          ? "req"
          : srcIp === host && srcPort === port
            ? "rsp"
            : "other";

    dirs.push({
      dirKey,
      kind,
      segments: segs.length,
      bytes: data.length,
      gaps,
      frames: frames.length,
    });

    parsedDirs.push({ kind, frames });
  }

  // Pre-pass: discover negotiation key even if cmdId=1 appears late in the capture.
  // This allows decrypting XML (and binary signatures) for earlier frames.
  for (const { kind, frames } of parsedDirs) {
    if (kind !== "rsp") continue;
    for (const f of frames) {
      const cmdId = f.header.cmdId;
      if (cmdId !== 1) continue;
      if (negotiatedEncType != null) continue;

      const resp = f.header.responseCode;
      if (resp >>> 8 !== 0xdd) continue;

      const encType = resp & 0xff;
      negotiatedEncType = encType;

      let nonceXml = "";
      if (encType === 0x00) {
        nonceXml = f.body.toString("utf8");
      } else {
        // Some captures show channelId=0 here; try common host offset 250 as a fallback.
        const tries = [f.header.channelId, 250];
        for (const off of tries) {
          const s = bcDecrypt(f.body, off).toString("utf8");
          if (tryParseNonce(s)) {
            nonceXml = s;
            break;
          }
          if (!nonceXml) nonceXml = s;
        }
      }

      negotiatedNonce = tryParseNonce(nonceXml);
      if (
        negotiatedNonce &&
        password &&
        (encType === 0x02 || encType === 0x12)
      ) {
        negotiatedAesKey = deriveAesKey(negotiatedNonce, password);
      }
    }
  }

  // Main pass: summarize and sample.
  for (const { kind, frames } of parsedDirs) {
    for (const f of frames) {
      const cmdId = f.header.cmdId;
      const k = String(cmdId);
      if (!byCmd[k]) {
        byCmd[k] = {
          cmdId,
          req: 0,
          rsp: 0,
          payloadBytesTotal: 0,
          payloadBytesReq: 0,
          payloadBytesRsp: 0,
          extBytesTotal: 0,
          extBytesReq: 0,
          extBytesRsp: 0,
          reqMessageClass: {},
          rspMessageClass: {},
          rspCodes: {},
          channelIds: {},
          streamTypes: {},
          payloadOffset: {},
          bodyLenBuckets: {},
          payloadLenBuckets: {},
          extLenBuckets: {},
          bcMediaMagicOff: {},
          extra: {
            // cmdId=5: small ACK payload (often 4 bytes) used for stream crypto.
            cmd5AckSamples: [] as any[],
            // cmdId=5: push frames with additional header marker + likely IV.
            cmd5PushAdditionalHeader: {
              present: 0,
              absent: 0,
              offsets: {} as Record<string, number>,
              ivSamples: [] as any[],
              prefixU32le: {} as Record<string, number>,
              headSamples: [] as any[],
              commonPrefixLen: 0,
              commonPrefixHex: "",
              commonPrefixAfter4Len: 0,
              commonPrefixAfter4Hex: "",
            },

            // cmdId=143 seems to carry bulk clip download traffic on some firmwares/apps.
            // We collect light-weight signatures and samples to infer the transported format.
            cmd143: {
              rspFrames: 0,
              payloadBytesRsp: 0,
              headSamples: [] as any[],
              reqSamples: [] as any[],
              rspExtSamples: [] as any[],
              commonPrefixLen: 0,
              commonPrefixHex: "",
              mp4KnownTypes: {} as Record<string, number>,
              mp4Likely: 0,
              annexBLikely: 0,
              adtsLikely: 0,
              bcMediaMagicOff256: {} as Record<string, number>,
              additionalHeaderMagicOff256: {} as Record<string, number>,
              iv16Samples: [] as any[],
            },
          },
          samples: { req: [], rsp: [] as any[] },
        };
      }

      const entry = byCmd[k];

      entry.payloadBytesTotal += f.payload.length;
      entry.extBytesTotal += f.extension.length;
      if (kind === "req") {
        entry.payloadBytesReq += f.payload.length;
        entry.extBytesReq += f.extension.length;
      } else if (kind === "rsp") {
        entry.payloadBytesRsp += f.payload.length;
        entry.extBytesRsp += f.extension.length;
      }

      inc(entry.channelIds, f.header.channelId);
      inc(entry.streamTypes, f.header.streamType);
      inc(entry.payloadOffset, f.header.payloadOffset ?? 0);

      // bucket bodyLen coarsely
      const bl = f.header.bodyLen;
      const bucket =
        bl < 64
          ? "<64"
          : bl < 256
            ? "<256"
            : bl < 1024
              ? "<1K"
              : bl < 8192
                ? "<8K"
                : ">=8K";
      inc(entry.bodyLenBuckets, bucket);

      inc(entry.payloadLenBuckets, bucketLen(f.payload.length));
      inc(entry.extLenBuckets, bucketLen(f.extension.length));

      const magicOff = findBcMediaMagicOffset(f.payload, 64);
      inc(entry.bcMediaMagicOff, magicOff);

      // cmdId=1 negotiation: learn nonce + enc type to derive AES key.
      if (cmdId === 1 && kind === "rsp") {
        const resp = f.header.responseCode;
        if (resp >>> 8 === 0xdd && negotiatedEncType == null) {
          const encType = resp & 0xff;
          negotiatedEncType = encType;
          let nonceXml = "";
          if (encType === 0x00) {
            nonceXml = f.body.toString("utf8");
          } else {
            // Some captures show channelId=0 here; try common host offset 250 as a fallback.
            const tries = [f.header.channelId, 250];
            for (const off of tries) {
              const s = bcDecrypt(f.body, off).toString("utf8");
              if (tryParseNonce(s)) {
                nonceXml = s;
                break;
              }
              if (!nonceXml) nonceXml = s;
            }
          }
          negotiatedNonce = tryParseNonce(nonceXml);
          if (
            negotiatedNonce &&
            password &&
            (encType === 0x02 || encType === 0x12)
          ) {
            negotiatedAesKey = deriveAesKey(negotiatedNonce, password);
          }
        }
      }

      const shouldSampleXml = (cmdId: number): boolean => {
        if (sampleXml.mode === "all") return true;
        if (sampleXml.mode === "cmd") return sampleXml.cmdIds.has(cmdId);
        return false;
      };

      const maybePushXmlSample = () => {
        if (!shouldSampleXml(cmdId)) return;
        const arr =
          kind === "req"
            ? entry.samples.req
            : kind === "rsp"
              ? entry.samples.rsp
              : null;
        if (!arr) return;

        const limit =
          sampleXml.mode === "none" ? 0 : sampleXml.limitPerCmdPerDir;
        if (arr.length >= limit) return;

        const blob = Buffer.concat([f.extension, f.payload]);
        const extDec =
          f.extension.length > 0
            ? tryDecryptXmlFrom(f.extension, f.header.channelId)
            : null;
        const payloadDec =
          f.payload.length > 0
            ? tryDecryptXmlFrom(f.payload, f.header.channelId)
            : null;
        const blobDec =
          blob.length > 0 ? tryDecryptXmlFrom(blob, f.header.channelId) : null;

        const pick = payloadDec ?? extDec ?? blobDec;
        if (!pick) {
          // Still sample a tiny signature for unknown/binary commands.
          // Also try to show decrypted heads (even when not XML) to help classification.
          let aesDecHeadHex: string | undefined;
          let aesDecHeadAscii: string | undefined;
          let bcDecHeadHex: string | undefined;
          let bcDecHeadAscii: string | undefined;

          if (blob.length > 0 && negotiatedAesKey) {
            try {
              const dec = aesDecrypt(blob, negotiatedAesKey);
              aesDecHeadHex = toHexSample(dec, 96);
              aesDecHeadAscii = toAsciiSample(dec, 96);
            } catch {
              // ignore
            }
          }

          if (blob.length > 0) {
            for (const off of [f.header.channelId, 250, 0]) {
              try {
                const dec = bcDecrypt(blob, off);
                bcDecHeadHex = toHexSample(dec, 96);
                bcDecHeadAscii = toAsciiSample(dec, 96);
                break;
              } catch {
                // ignore
              }
            }
          }

          arr.push({
            dir: kind,
            cmdId,
            msgNum: f.header.msgNum,
            responseCode: f.header.responseCode,
            messageClass: `0x${f.header.messageClass.toString(16)}`,
            channelId: f.header.channelId,
            streamType: f.header.streamType,
            bodyLen: f.header.bodyLen,
            payloadOffset: f.header.payloadOffset ?? 0,
            extLen: f.extension.length,
            payloadLen: f.payload.length,
            blobLen: blob.length,
            extHeadAscii: toAsciiSample(f.extension, 96),
            payloadHeadAscii: toAsciiSample(f.payload, 96),
            payloadHeadHex: toHexSample(f.payload, 96),
            ...(aesDecHeadHex ? { aesDecHeadHex } : {}),
            ...(aesDecHeadAscii ? { aesDecHeadAscii } : {}),
            ...(bcDecHeadHex ? { bcDecHeadHex } : {}),
            ...(bcDecHeadAscii ? { bcDecHeadAscii } : {}),
          });
          return;
        }

        const oneLine = pick.xml.replace(/\s+/g, " ").trim();
        arr.push({
          dir: kind,
          cmdId,
          msgNum: f.header.msgNum,
          responseCode: f.header.responseCode,
          messageClass: `0x${f.header.messageClass.toString(16)}`,
          channelId: f.header.channelId,
          streamType: f.header.streamType,
          bodyLen: f.header.bodyLen,
          payloadOffset: f.header.payloadOffset ?? 0,
          extLen: f.extension.length,
          payloadLen: f.payload.length,
          xmlEnc: pick.enc,
          xmlRoot: pick.root,
          xmlHead:
            oneLine.length > sampleXmlMaxChars
              ? `${oneLine.slice(0, sampleXmlMaxChars)}...`
              : oneLine,
        });
      };

      maybePushXmlSample();

      // cmdId=143: sample + signature detection (download path)
      if (cmdId === 143 && kind === "req") {
        const ex = entry.extra.cmd143;
        if (ex.reqSamples.length < 4) {
          ex.reqSamples.push({
            msgNum: f.header.msgNum,
            responseCode: f.header.responseCode,
            messageClass: `0x${f.header.messageClass.toString(16)}`,
            channelId: f.header.channelId,
            streamType: f.header.streamType,
            payloadOffset: f.header.payloadOffset ?? 0,
            bodyB64: f.body.toString("base64"),
            payloadLen: f.payload.length,
            payloadHex: toHexSample(f.payload, 96),
            payloadB64: f.payload.toString("base64"),
            extLen: f.extension.length,
            extHeadHex: toHexSample(f.extension, 128),
            extHeadAscii: toAsciiSample(f.extension, 128),
            extTailHex: f.extension
              .subarray(Math.max(0, f.extension.length - 128))
              .toString("hex"),
            ...(negotiatedEncType != null
              ? { negotiatedEncType: `0x${negotiatedEncType.toString(16)}` }
              : {}),
            ...(negotiatedNonce != null ? { negotiatedNonce } : {}),
            ...(negotiatedAesKey ? { aesKeyDerived: true } : {}),
          });
        }
      }

      if (cmdId === 143 && kind === "rsp") {
        const ex = entry.extra.cmd143;
        ex.rspFrames++;
        ex.payloadBytesRsp += f.payload.length;

        const decBody = tryAesDec(f.body);
        const decPayloadOffset = f.header.payloadOffset ?? 0;
        const decExt =
          decBody && decPayloadOffset > 0 && decPayloadOffset <= decBody.length
            ? decBody.subarray(0, decPayloadOffset)
            : null;
        const decPayload = decBody
          ? decBody.subarray(Math.min(decPayloadOffset, decBody.length))
          : null;

        const cpMax = 512;
        const payloadHead = f.payload.subarray(
          0,
          Math.min(f.payload.length, cpMax),
        );
        const cur: Buffer | undefined = ex._commonPrefix;
        if (!cur) {
          ex._commonPrefix = Buffer.from(payloadHead);
        } else {
          const limit = Math.min(cur.length, payloadHead.length);
          let same = 0;
          while (same < limit && cur[same] === payloadHead[same]) same++;
          ex._commonPrefix = cur.subarray(0, same);
        }

        // MP4 box detection (common for app-exported clips)
        const mp4 = detectMp4BoxType(f.payload);
        if (mp4.boxType) {
          if (KNOWN_MP4_BOX_TYPES.has(mp4.boxType)) {
            inc(ex.mp4KnownTypes, mp4.boxType);
            ex.mp4Likely++;
          }
        }

        if (looksLikeAnnexB(f.payload)) ex.annexBLikely++;
        if (looksLikeAdts(f.payload)) ex.adtsLikely++;

        if (f.extension.length > 0 && ex.rspExtSamples.length < 8) {
          ex.rspExtSamples.push({
            msgNum: f.header.msgNum,
            responseCode: f.header.responseCode,
            messageClass: `0x${f.header.messageClass.toString(16)}`,
            channelId: f.header.channelId,
            streamType: f.header.streamType,
            payloadOffset: f.header.payloadOffset ?? 0,
            bodyB64: f.body.toString("base64"),
            payloadLen: f.payload.length,
            extLen: f.extension.length,
            extHeadHex: toHexSample(f.extension, 96),
            extHeadAscii: toAsciiSample(f.extension, 96),
          });
        }

        // Scan deeper for BcMedia magic. In practice we saw "1002" appear at offset ~106.
        const bcOff = findBcMediaMagicOffset(f.payload, 256);
        inc(ex.bcMediaMagicOff256, bcOff);

        const hdrOff = findAdditionalHeaderMagicOffset(f.payload, 256);
        inc(ex.additionalHeaderMagicOff256, hdrOff);
        if (hdrOff >= 0) {
          const ivStart = hdrOff + ADDITIONAL_HEADER_MAGIC.length;
          const iv =
            f.payload.length >= ivStart + 16
              ? f.payload.subarray(ivStart, ivStart + 16)
              : Buffer.alloc(0);
          if (iv.length === 16 && ex.iv16Samples.length < 12) {
            ex.iv16Samples.push({
              msgNum: f.header.msgNum,
              payloadLen: f.payload.length,
              payloadOffset: f.header.payloadOffset ?? 0,
              additionalHeaderOff: hdrOff,
              iv16Hex: iv.toString("hex"),
            });
          }
        }

        if (ex.headSamples.length < 20) {
          ex.headSamples.push({
            msgNum: f.header.msgNum,
            responseCode: f.header.responseCode,
            messageClass: `0x${f.header.messageClass.toString(16)}`,
            payloadLen: f.payload.length,
            payloadOffset: f.header.payloadOffset ?? 0,
            extLen: f.extension.length,
            headHex: toHexSample(f.payload, 64),
            headAscii: toAsciiSample(f.payload, 64),
            mp4BoxType: mp4.boxType,
            mp4BoxSizeBE: mp4.boxSizeBE,
          });
        }
      }

      // Deeper extraction for cmdId=5 (replay/live push) to support crypto/framing diffs.
      if (cmdId === 5 && kind === "rsp") {
        const isAck =
          f.header.responseCode === 200 &&
          f.header.messageClass === 0x0 &&
          f.extension.length > 0;
        const isPush =
          f.header.messageClass === 0x696f || f.header.responseCode >= 50000;

        // ACK-like response: XML extension + small binary tail (often used as stream key material).
        if (
          isAck &&
          f.payload.length > 0 &&
          f.payload.length <= 64 &&
          entry.extra.cmd5AckSamples.length < 20
        ) {
          const tailU32LE =
            f.payload.length >= 4
              ? f.payload.readUInt32LE(f.payload.length - 4)
              : undefined;
          entry.extra.cmd5AckSamples.push({
            msgNum: f.header.msgNum,
            responseCode: f.header.responseCode,
            messageClass: `0x${f.header.messageClass.toString(16)}`,
            extLen: f.extension.length,
            payloadLen: f.payload.length,
            payloadHex: toHexSample(f.payload, 64),
            tailU32LE,
            extHeadHex: toHexSample(f.extension, 32),
            extTailHex: f.extension
              .subarray(Math.max(0, f.extension.length - 32))
              .toString("hex"),
          });
        }

        // Push-like response: encrypted media; BcMedia magic won't appear pre-decrypt.
        if (isPush) {
          // Track common prefix across push payloads (bounded) to spot per-stream constant headers.
          const cpMax = 512;
          const payloadHead = f.payload.subarray(
            0,
            Math.min(f.payload.length, cpMax),
          );
          const payloadHeadAfter4 =
            f.payload.length > 4
              ? f.payload.subarray(4, Math.min(f.payload.length, 4 + cpMax))
              : Buffer.alloc(0);
          const cp: Buffer | undefined =
            entry.extra.cmd5PushAdditionalHeader._commonPrefix;
          const cpA4: Buffer | undefined =
            entry.extra.cmd5PushAdditionalHeader._commonPrefixAfter4;
          if (!cp) {
            entry.extra.cmd5PushAdditionalHeader._commonPrefix =
              Buffer.from(payloadHead);
          } else {
            const limit = Math.min(cp.length, payloadHead.length);
            let same = 0;
            while (same < limit && cp[same] === payloadHead[same]) same++;
            entry.extra.cmd5PushAdditionalHeader._commonPrefix = cp.subarray(
              0,
              same,
            );
          }

          if (!cpA4) {
            entry.extra.cmd5PushAdditionalHeader._commonPrefixAfter4 =
              Buffer.from(payloadHeadAfter4);
          } else {
            const limit = Math.min(cpA4.length, payloadHeadAfter4.length);
            let same = 0;
            while (same < limit && cpA4[same] === payloadHeadAfter4[same])
              same++;
            entry.extra.cmd5PushAdditionalHeader._commonPrefixAfter4 =
              cpA4.subarray(0, same);
          }

          if (f.payload.length >= 4) {
            const u32 = f.payload.readUInt32LE(0);
            inc(
              entry.extra.cmd5PushAdditionalHeader.prefixU32le,
              `0x${u32.toString(16)}`,
            );
          }
          if (entry.extra.cmd5PushAdditionalHeader.headSamples.length < 12) {
            entry.extra.cmd5PushAdditionalHeader.headSamples.push({
              msgNum: f.header.msgNum,
              responseCode: f.header.responseCode,
              messageClass: `0x${f.header.messageClass.toString(16)}`,
              payloadLen: f.payload.length,
              headHex: toHexSample(f.payload, 64),
            });
          }

          const off2 = findAdditionalHeaderMagicOffset(f.payload, 256);
          if (off2 >= 0) {
            entry.extra.cmd5PushAdditionalHeader.present++;
            inc(entry.extra.cmd5PushAdditionalHeader.offsets, off2);

            // Heuristic: IV is typically 16 bytes right after the 4-byte marker.
            const ivStart = off2 + ADDITIONAL_HEADER_MAGIC.length;
            const iv =
              f.payload.length >= ivStart + 16
                ? f.payload.subarray(ivStart, ivStart + 16)
                : Buffer.alloc(0);
            if (
              iv.length === 16 &&
              entry.extra.cmd5PushAdditionalHeader.ivSamples.length < 20
            ) {
              entry.extra.cmd5PushAdditionalHeader.ivSamples.push({
                msgNum: f.header.msgNum,
                responseCode: f.header.responseCode,
                messageClass: `0x${f.header.messageClass.toString(16)}`,
                payloadOffset: f.header.payloadOffset ?? 0,
                payloadLen: f.payload.length,
                additionalHeaderOff: off2,
                iv16Hex: iv.toString("hex"),
                payloadHeadHex: toHexSample(f.payload, 64),
              });
            }
          } else {
            entry.extra.cmd5PushAdditionalHeader.absent++;
          }
        }
      }

      if (kind === "req") {
        entry.req++;
        inc(entry.reqMessageClass, `0x${f.header.messageClass.toString(16)}`);
      } else if (kind === "rsp") {
        entry.rsp++;
        inc(entry.rspMessageClass, `0x${f.header.messageClass.toString(16)}`);
        inc(entry.rspCodes, f.header.responseCode);
      }

      // Note: legacy "interesting" sampling removed in favor of --sample-xml/--sample-xml-all
      // which includes XML heads (and a small binary signature when no XML is found).
    }
  }

  const out = {
    input: { pcapPath, host, port },
    negotiation: {
      encType:
        negotiatedEncType != null
          ? `0x${negotiatedEncType.toString(16)}`
          : null,
      nonce: negotiatedNonce,
      aesKeyDerived: !!negotiatedAesKey,
      passwordProvided: !!password,
    },
    cameraPorts: {
      packets: cameraPortsPackets,
      bytes: cameraPortsBytes,
      topByBytes: topCameraPortsByBytes.slice(0, 12),
      parsedPorts: [...parsePorts].sort((a, b) => a - b),
    },
    dirs: dirs.sort((a, b) => b.frames - a.frames),
    byCmd,
  };

  // finalize derived fields
  for (const entry of Object.values(byCmd)) {
    const extra = entry?.extra;
    const push = extra?.cmd5PushAdditionalHeader;
    if (push && push._commonPrefix) {
      const b: Buffer = push._commonPrefix;
      push.commonPrefixLen = b.length;
      push.commonPrefixHex = b.subarray(0, 96).toString("hex");
      delete push._commonPrefix;
    }
    if (push && push._commonPrefixAfter4) {
      const b: Buffer = push._commonPrefixAfter4;
      push.commonPrefixAfter4Len = b.length;
      push.commonPrefixAfter4Hex = b.subarray(0, 96).toString("hex");
      delete push._commonPrefixAfter4;
    }

    const cmd143 = extra?.cmd143;
    if (cmd143 && cmd143._commonPrefix) {
      const b: Buffer = cmd143._commonPrefix;
      cmd143.commonPrefixLen = b.length;
      cmd143.commonPrefixHex = b.subarray(0, 96).toString("hex");
      delete cmd143._commonPrefix;
    }
  }

  // If we derived an AES key from the login nonce, decrypt cmd143 sample bodies now.
  postProcessCmd143Decrypt();

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main();
