import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDecipheriv } from "node:crypto";

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
      if (s.startsWith("<?xml")) return s;
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

  const buf = fs.readFileSync(pcapPath);
  if (buf.length < 12) throw new Error("Capture too small");

  const segmentsByDir = new Map<string, TcpSegment[]>();
  const bytesByDir = new Map<string, number>();
  const packetsByDir = new Map<string, number>();

  const udpBytesByDir = new Map<string, number>();
  const udpPacketsByDir = new Map<string, number>();

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

      const dirKey = `${srcIp}:${srcPort} -> ${dstIp}:${dstPort}`;
      const arr = segmentsByDir.get(dirKey) ?? [];
      arr.push({ seq, tsMs, payload: Buffer.from(payload) });
      segmentsByDir.set(dirKey, arr);

      bytesByDir.set(dirKey, (bytesByDir.get(dirKey) ?? 0) + payload.length);
      packetsByDir.set(dirKey, (packetsByDir.get(dirKey) ?? 0) + 1);
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
      udpBytesByDir.set(dirKey, (udpBytesByDir.get(dirKey) ?? 0) + payloadLen);
      udpPacketsByDir.set(dirKey, (udpPacketsByDir.get(dirKey) ?? 0) + 1);
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

    const interfaces: Array<{ linkType: number; tsResol: number }> = [];
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
      ingestPacket(buf.subarray(pktStart, pktEnd), network, 0);
      offset = pktEnd;
    }

    console.log(`PCAP: ${pcapPath}`);
  }

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
  }

  // Focus: Baichuan over TCP/9000 between hub and pc
  const targets = [...segmentsByDir.entries()].filter(([k]) => {
    if (!k.includes(":9000")) return false;
    return k.startsWith(`${hubIp}:9000 -> ${pcIp}:`) || k.startsWith(`${pcIp}:`) || k.includes(`-> ${hubIp}:9000`);
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
