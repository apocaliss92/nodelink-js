#!/usr/bin/env node
/**
 * PCAP-based analysis: HomeHub "events list" capture
 *
 * Input: pcap/hub_events_list.pcapng
 * Goal:
 * - Reconstruct the observed Baichuan flow when the Hub UI opens the events list.
 * - Summarize CoverPreview (cmdId=298) request/response patterns.
 * - Provide the reconstructed CoverPreview request XML template used by the library.
 *
 * Notes:
 * - This capture does NOT contain the login/nonce negotiation, so we treat XML payloads as opaque
 *   unless they are plaintext.
 */

import fs from "node:fs";
import path from "node:path";
import { createDecipheriv, createHash } from "node:crypto";

// Load environment variables from .env when running this test script.
// This lets us optionally decrypt captured Baichuan XML if the session nonce is known.
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { BaichuanFrameParser } from "../../index.js";

type Endian = "le" | "be";

type TcpSegment = { seq: number; tsMs: number; payload: Buffer };

type PcapInterface = { linkType: number; tsResol: number };

type FlowSummary = {
  pcapPath: string;
  hubIp: string;
  pcIp: string;
  baichuanTcpPort: number;
  tcpDirections: Array<{ dirKey: string; packets: number; payloadBytes: number }>;
  decryption: {
    available: boolean;
    encType?: number;
    missing?: string[];
  };
  cmdSummary: {
    requestsTop: Array<{ cmdId: number; count: number }>;
    responsesTop: Array<{ cmdId: number; count: number }>;
  };
  xmlSamples: Array<{
    dir: "tx" | "rx";
    cmdId: number;
    msgNum: number;
    channelId: number;
    responseCode: number;
    xmlSnippet: string;
  }>;
  eventsList: {
    present: boolean;
    sourceCmdIds: number[];
    events: Array<{
      channelId?: number;
      deviceId?: string;
      detectionType?: string;
      startTime?: string;
      endTime?: string;
      rawTags: Record<string, string>;
    }>;
    requestXmlByCmdId: Record<string, string[]>;
    responseXmlByCmdId: Record<string, string[]>;
  };
  coverPreview: {
    cmdId: number;
    requests: {
      count: number;
      uniqueChannelIds: number[];
      uniqueMsgNums: number[];
      bodyLenTop: Array<{ bodyLen: number; count: number }>;
    };
    responses: {
      count: number;
      responseCodeTop: Array<{ responseCode: number; count: number }>;
      streamHeader1001Hits: number;
      binaryDataExtHits: number;
    };
    reconstructedRequestXmlTemplate: string;
  };
};

function readU16(buf: Buffer, off: number, endian: Endian): number {
  return endian === "le" ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}

function readU32(buf: Buffer, off: number, endian: Endian): number {
  return endian === "le" ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

function ipToString(pkt: Buffer, off: number): string {
  return `${pkt[off]}.${pkt[off + 1]}.${pkt[off + 2]}.${pkt[off + 3]}`;
}

function reassembleTcpSegments(segments: TcpSegment[]): { data: Buffer; gaps: number } {
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

function buildCoverPreviewXml(params: { channel: number; time: Date; snapType: "main" | "sub" }): string {
  const endTime = new Date(params.time.getTime() + 10_000);
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<CoverPreview version="1.1">\n<channelId>${params.channel}</channelId>\n<streamType>${params.snapType}</streamType>\n<startTime>\n<year>${params.time.getFullYear()}</year>\n<month>${params.time.getMonth() + 1}</month>\n<day>${params.time.getDate()}</day>\n<hour>${params.time.getHours()}</hour>\n<minute>${params.time.getMinutes()}</minute>\n<second>${params.time.getSeconds()}</second>\n</startTime>\n<endTime>\n<year>${endTime.getFullYear()}</year>\n<month>${endTime.getMonth() + 1}</month>\n<day>${endTime.getDate()}</day>\n<hour>${endTime.getHours()}</hour>\n<minute>${endTime.getMinutes()}</minute>\n<second>${endTime.getSeconds()}</second>\n</endTime>\n</CoverPreview>\n</body>`;
}

type SessionEnc =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "bc" }
  | { kind: "aes"; key: Buffer };

function md5HexUpper(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
}

function md5StrModern(input: string): string {
  return md5HexUpper(input).slice(0, 31);
}

function deriveAesKey(nonce: string, password: string): Buffer {
  const keyStr = md5StrModern(`${nonce}-${password}`).slice(0, 16);
  return Buffer.from(keyStr, "utf8");
}

function bcDecrypt(buf: Buffer, channelId: number): Buffer {
  // Same XOR as src/protocol/crypto.ts
  const key = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];
  const off = channelId & 0xff;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]! ^ key[(off + i) % key.length]! ^ off;
  return out;
}

function aesDecrypt(buf: Buffer, key: Buffer): Buffer {
  if (buf.length === 0) return Buffer.alloc(0);
  const iv = Buffer.from("0123456789abcdef", "utf8");
  const decipher = createDecipheriv("aes-128-cfb", key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}

function parseEnvSession(): { encType?: number; enc: SessionEnc; missing: string[] } {
  const missing: string[] = [];
  const nonce = process.env.BAICHUAN_NONCE?.trim();
  const encTypeRaw = process.env.BAICHUAN_ENC_TYPE?.trim();
  const password = process.env.BAICHUAN_PASSWORD ?? process.env.NVR_PASSWORD ?? process.env.TCP_PASSWORD;

  if (!nonce) missing.push("BAICHUAN_NONCE");
  if (!encTypeRaw) missing.push("BAICHUAN_ENC_TYPE");
  if (!password) missing.push("BAICHUAN_PASSWORD|NVR_PASSWORD|TCP_PASSWORD");

  if (!nonce || !encTypeRaw) return { enc: { kind: "unknown" }, missing };
  const encType = encTypeRaw.startsWith("0x") || encTypeRaw.startsWith("0X") ? parseInt(encTypeRaw, 16) : parseInt(encTypeRaw, 10);
  if (!Number.isFinite(encType)) return { enc: { kind: "unknown" }, missing: [...missing, "BAICHUAN_ENC_TYPE(invalid)"] };

  if (encType === 0x00) return { encType, enc: { kind: "none" }, missing: [] };
  if (encType === 0x01) return { encType, enc: { kind: "bc" }, missing: [] };
  if (!password) return { encType, enc: { kind: "unknown" }, missing };

  // 0x02 = aes, 0x12 = full_aes. For PCAP XML body decryption the cipher is the same.
  if (encType === 0x02 || encType === 0x12) {
    const key = deriveAesKey(nonce, password);
    return { encType, enc: { kind: "aes", key }, missing: [] };
  }

  return { encType, enc: { kind: "unknown" }, missing: [...missing, `BAICHUAN_ENC_TYPE(unsupported:${encTypeRaw})`] };
}

function tryDecryptXmlBody(buf: Buffer, channelId: number, sessionEnc: SessionEnc): string | undefined {
  const tryAs = (enc: SessionEnc): string | undefined => {
    let dec: Buffer;
    try {
      if (enc.kind === "none") dec = buf;
      else if (enc.kind === "bc") dec = bcDecrypt(buf, channelId);
      else if (enc.kind === "aes") dec = aesDecrypt(buf, enc.key);
      else return undefined;
    } catch {
      return undefined;
    }
    const s = dec.toString("utf8");
    return s.includes("<?xml") ? s.slice(s.indexOf("<?xml")) : s.startsWith("<body>") ? s : undefined;
  };

  return tryAs(sessionEnc) ?? (sessionEnc.kind !== "bc" ? tryAs({ kind: "bc" }) : undefined) ?? tryAs({ kind: "none" });
}

function inferDetectionType(tags: Record<string, string>): string | undefined {
  const aiType = (tags.AItype ?? tags.aiType ?? tags.aitype ?? tags.ai_type ?? "").trim();
  const alarmType = (tags.alarmType ?? tags.AlarmType ?? tags.type ?? tags.Type ?? "").trim();
  const status = (tags.status ?? tags.Status ?? "").trim();

  const aiTok = aiType
    .split(",")
    .map((t) => t.trim())
    .find((t) => t.length && t.toLowerCase() !== "none");

  if (aiTok) return `ai:${aiTok.toLowerCase()}`;
  if (/pir/i.test(alarmType) || /pir/i.test(status)) return "pir";
  if (/md|motion/i.test(alarmType) || /motion/i.test(status)) return "motion";
  if (alarmType) return alarmType;
  if (status) return status;
  return undefined;
}

function extractSimpleTags(xml: string): Record<string, string> {
  // Shallow best-effort extractor: <tag>value</tag>
  const out: Record<string, string> = {};
  const re = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
  for (const m of xml.matchAll(re)) {
    const k = m[1] ?? "";
    const v = (m[2] ?? "").trim();
    if (!k || v === "") continue;
    // Keep first occurrence to avoid noisy overwrites.
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

function main(): void {
  const fileArg = process.argv[2];
  const pcapPath = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(process.cwd(), "pcap/hub_events_list.pcapng");

  const hubIp = process.env.HUB_IP ?? "192.168.1.161";
  const pcIp = process.env.PC_IP ?? "192.168.1.230";
  const baichuanTcpPort = Number.parseInt(process.env.BAICHUAN_TCP_PORT ?? "9000", 10);

  const session = parseEnvSession();
  const decryptionAvailable = session.enc.kind !== "unknown";

  const buf = fs.readFileSync(pcapPath);
  if (buf.length < 12) throw new Error("Capture too small");

  const interfaceDefs: PcapInterface[] = [];

  const segmentsByDir = new Map<string, TcpSegment[]>();
  const bytesByDir = new Map<string, number>();
  const packetsByDir = new Map<string, number>();

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

    // Focus on the hub<->pc Baichuan session only.
    const isInScope =
      (srcIp === hubIp && dstIp === pcIp && srcPort === baichuanTcpPort) ||
      (srcIp === pcIp && dstIp === hubIp && dstPort === baichuanTcpPort);
    if (!isInScope) return;

    const dirKey = `${srcIp}:${srcPort} -> ${dstIp}:${dstPort}`;
    const arr = segmentsByDir.get(dirKey) ?? [];
    arr.push({ seq, tsMs, payload: Buffer.from(payload) });
    segmentsByDir.set(dirKey, arr);

    bytesByDir.set(dirKey, (bytesByDir.get(dirKey) ?? 0) + payload.length);
    packetsByDir.set(dirKey, (packetsByDir.get(dirKey) ?? 0) + 1);
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
          const iface = interfaceDefs[interfaceId] ?? interfaceDefs[0] ?? { linkType: 1, tsResol: 1e-6 };
          const ticks = (BigInt(tsHigh) << 32n) | BigInt(tsLow);
          const tsMs = Number(ticks) * iface.tsResol * 1000;
          ingestPacket(buf.subarray(pktStart, pktEnd), iface.linkType, tsMs);
        }
      }
    }

    off = blockEnd;
  }

  const tcpDirections = [...bytesByDir.entries()]
    .map(([dirKey, payloadBytes]) => ({
      dirKey,
      payloadBytes,
      packets: packetsByDir.get(dirKey) ?? 0,
    }))
    .sort((a, b) => b.payloadBytes - a.payloadBytes);

  // Parse Baichuan frames per direction
  const framesByDir = new Map<string, ReturnType<BaichuanFrameParser["push"]>>();
  for (const [dirKey, segs] of segmentsByDir.entries()) {
    const { data } = reassembleTcpSegments(segs);
    const parser = new BaichuanFrameParser();
    const frames = parser.push(data) as unknown as Array<any>;
    framesByDir.set(dirKey, frames);
  }

  const requestFramesAll: any[] = [];
  const responseFramesAll: any[] = [];

  for (const [dirKey, frames] of framesByDir.entries()) {
    for (const f of frames) {
      if (!f?.header) continue;
      if (dirKey.startsWith(`${pcIp}:`)) requestFramesAll.push(f);
      else responseFramesAll.push(f);
    }
  }

  const topCounts = (frames: any[]): Array<{ cmdId: number; count: number }> => {
    const m = new Map<number, number>();
    for (const f of frames) {
      const cmdId = Number(f?.header?.cmdId);
      if (!Number.isFinite(cmdId)) continue;
      m.set(cmdId, (m.get(cmdId) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([cmdId, count]) => ({ cmdId, count }));
  };

  const xmlSamples: FlowSummary["xmlSamples"] = [];
  const seenSampleKey = new Set<string>();
  const maybeAddSample = (dir: "tx" | "rx", f: any) => {
    const bodyBuf: Buffer = Buffer.from(f.body ?? []);
    const xml = decryptionAvailable ? tryDecryptXmlBody(bodyBuf, Number(f.header.channelId), session.enc) : undefined;
    if (!xml) return;
    const key = `${dir}:${f.header.cmdId}:${f.header.msgNum}:${f.header.channelId}:${f.header.responseCode}`;
    if (seenSampleKey.has(key)) return;
    seenSampleKey.add(key);
    const snippet = xml.length > 4000 ? `${xml.slice(0, 4000)}...` : xml;
    xmlSamples.push({
      dir,
      cmdId: Number(f.header.cmdId),
      msgNum: Number(f.header.msgNum),
      channelId: Number(f.header.channelId),
      responseCode: Number(f.header.responseCode),
      xmlSnippet: snippet,
    });
  };

  // Collect a small number of plaintext XML samples (if present).
  for (const f of requestFramesAll) {
    maybeAddSample("tx", f);
    if (xmlSamples.length >= 12) break;
  }
  for (const f of responseFramesAll) {
    maybeAddSample("rx", f);
    if (xmlSamples.length >= 24) break;
  }

  // Attempt to reconstruct the events list flow by decrypting cmdId 102/516/517 request/response.
  const eventsCmdCandidates = [102, 516, 517];
  const requestXmlByCmdId: Record<string, string[]> = {};
  const responseXmlByCmdId: Record<string, string[]> = {};
  const events: FlowSummary["eventsList"]["events"] = [];

  const pushXmlByCmdId = (target: Record<string, string[]>, cmdId: number, xml: string) => {
    const k = String(cmdId);
    if (!target[k]) target[k] = [];
    // Keep at most a few samples per cmdId to avoid huge output.
    if (target[k]!.length < 3) target[k]!.push(xml.length > 6000 ? `${xml.slice(0, 6000)}...` : xml);
  };

  if (decryptionAvailable) {
    for (const f of requestFramesAll) {
      const cmdId = Number(f?.header?.cmdId);
      if (!eventsCmdCandidates.includes(cmdId)) continue;
      const xml = tryDecryptXmlBody(Buffer.from(f.body ?? []), Number(f.header.channelId), session.enc);
      if (xml) pushXmlByCmdId(requestXmlByCmdId, cmdId, xml);
    }
    for (const f of responseFramesAll) {
      const cmdId = Number(f?.header?.cmdId);
      if (!eventsCmdCandidates.includes(cmdId) && cmdId !== 33) continue;
      const xml = tryDecryptXmlBody(Buffer.from(f.body ?? []), Number(f.header.channelId), session.enc);
      if (xml) pushXmlByCmdId(responseXmlByCmdId, cmdId, xml);

      // Best-effort event extraction from responses that contain recognizable event blocks.
      if (xml && (xml.includes("Event") || xml.includes("Alarm") || xml.includes("alarm"))) {
        // If there are multiple <AlarmEvent> blocks, extract those; otherwise fall back to whole XML.
        const alarmMatches = [...xml.matchAll(/<AlarmEvent\b[^>]*>([\s\S]*?)<\/AlarmEvent>/g)].map((m) => m[1] ?? "");
        const candidates = alarmMatches.length ? alarmMatches : [xml];
        for (const c of candidates) {
          const tags = extractSimpleTags(c);
          const channelIdRaw = tags.channelId ?? tags.ChannelId;
          const channelIdNum = channelIdRaw != null ? Number(channelIdRaw) : undefined;
          const deviceId = tags.deviceId ?? tags.uid ?? tags.UID;
          const detectionType = inferDetectionType(tags);
          const startTime = tags.startTime;
          const endTime = tags.endTime;
          if (channelIdNum !== undefined || detectionType !== undefined || deviceId !== undefined) {
            events.push({
              ...(Number.isFinite(channelIdNum as number) ? { channelId: channelIdNum as number } : {}),
              ...(deviceId ? { deviceId } : {}),
              ...(detectionType ? { detectionType } : {}),
              ...(startTime ? { startTime } : {}),
              ...(endTime ? { endTime } : {}),
              rawTags: tags,
            });
          }
        }
      }
    }
  }

  const cmdId = 298;

  const requestFrames: any[] = [];
  const responseFrames: any[] = [];

  for (const [dirKey, frames] of framesByDir.entries()) {
    for (const f of frames) {
      if (f?.header?.cmdId !== cmdId) continue;
      if (dirKey.startsWith(`${pcIp}:`)) requestFrames.push(f);
      else responseFrames.push(f);
    }
  }

  const uniqueReqChannelIds = [...new Set(requestFrames.map((f) => f.header.channelId))].sort((a, b) => a - b);
  const uniqueReqMsgNums = [...new Set(requestFrames.map((f) => f.header.msgNum))].sort((a, b) => a - b);

  const bodyLenCounts = new Map<number, number>();
  for (const f of requestFrames) bodyLenCounts.set(f.body.length, (bodyLenCounts.get(f.body.length) ?? 0) + 1);
  const bodyLenTop = [...bodyLenCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([bodyLen, count]) => ({ bodyLen, count }));

  const respCodeCounts = new Map<number, number>();
  let streamHeader1001Hits = 0;
  let binaryDataExtHits = 0;

  for (const f of responseFrames) {
    respCodeCounts.set(f.header.responseCode, (respCodeCounts.get(f.header.responseCode) ?? 0) + 1);
    const payload: Buffer = Buffer.from(f.payload);
    if (payload.length >= 4 && payload.subarray(0, 4).toString("ascii") === "1001") streamHeader1001Hits++;
    const ext: Buffer = Buffer.from(f.extension);
    if (ext.length > 0 && ext.includes(Buffer.from("<binaryData>1</binaryData>", "utf8"))) binaryDataExtHits++;
  }

  const responseCodeTop = [...respCodeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([responseCode, count]) => ({ responseCode, count }));

  const out: FlowSummary = {
    pcapPath,
    hubIp,
    pcIp,
    baichuanTcpPort,
    tcpDirections: tcpDirections.slice(0, 10),
    decryption: {
      available: decryptionAvailable,
      ...(session.encType != null ? { encType: session.encType } : {}),
      ...(session.missing.length ? { missing: session.missing } : {}),
    },
    cmdSummary: {
      requestsTop: topCounts(requestFramesAll),
      responsesTop: topCounts(responseFramesAll),
    },
    xmlSamples,
    eventsList: {
      present: decryptionAvailable && Object.keys(responseXmlByCmdId).length > 0,
      sourceCmdIds: eventsCmdCandidates,
      events,
      requestXmlByCmdId,
      responseXmlByCmdId,
    },
    coverPreview: {
      cmdId,
      requests: {
        count: requestFrames.length,
        uniqueChannelIds: uniqueReqChannelIds,
        uniqueMsgNums: uniqueReqMsgNums,
        bodyLenTop,
      },
      responses: {
        count: responseFrames.length,
        responseCodeTop,
        streamHeader1001Hits,
        binaryDataExtHits,
      },
      // We can't deterministically recover the exact per-request timestamps from the encrypted PCAP
      // without the session nonce. We still provide the exact XML structure used by the library.
      reconstructedRequestXmlTemplate: buildCoverPreviewXml({ channel: 0, time: new Date(0), snapType: "sub" }),
    },
  };

  const asJson = (process.env.EVENTS_STDOUT_JSON ?? "").trim() === "1";
  if (asJson) {
    process.stdout.write(JSON.stringify(out, null, 2));
    return;
  }

  console.log(JSON.stringify(out, null, 2));
}

main();
