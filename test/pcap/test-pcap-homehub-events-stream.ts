#!/usr/bin/env node
/**
 * PCAP-based analysis: HomeHub full session capture (events list + event streaming)
 *
 * Input: pcap/homehub_events_stream.pcapng
 * Goal:
 * - Extract and reconstruct ALL Baichuan XML calls observed (tx/rx).
 * - Extract any RTSP/HTTP URLs used to stream an event (or returned by XML).
 *
 * This script is intentionally best-effort:
 * - It parses PCAPNG directly (no tshark dependency).
 * - It can decrypt plaintext and BC-XOR XML.
 * - If it can find a nonce in plaintext XML, it will derive AES key using .env password and
 *   attempt AES-CFB decryption for the rest of the session.
 */

import fs from "node:fs";
import path from "node:path";
import { createDecipheriv, createHash } from "node:crypto";

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { BaichuanFrameParser } from "../../index.js";

type Endian = "le" | "be";

type TcpSegment = { seq: number; tsMs: number; payload: Buffer };

type PcapInterface = { linkType: number; tsResol: number };

type SessionEnc =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "bc" }
  | { kind: "aes"; key: Buffer };

type XmlCall = {
  dir: "tx" | "rx";
  tsHintMs?: number;
  cmdId: number;
  msgNum: number;
  channelId: number;
  responseCode: number;
  rootTag?: string;
  xml: string;
};

type TrafficWindow = {
  windowMs: number;
  bytes: number;
  packets: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
};

function buildTrafficWindow(segments: TcpSegment[], windowMs: number): TrafficWindow {
  if (segments.length === 0) {
    return { windowMs, bytes: 0, packets: 0, firstTsMs: null, lastTsMs: null };
  }

  const sorted = [...segments].sort((a, b) => a.tsMs - b.tsMs);
  const lastTsMs = sorted[sorted.length - 1]!.tsMs;
  const startTsMs = lastTsMs - windowMs;
  let bytes = 0;
  let packets = 0;

  for (const s of sorted) {
    if (s.tsMs < startTsMs) continue;
    bytes += s.payload.length;
    packets += 1;
  }

  return {
    windowMs,
    bytes,
    packets,
    firstTsMs: sorted[0]!.tsMs,
    lastTsMs,
  };
}

function topNFromCountMap(m: Map<number, number>, n: number): Array<{ key: number; count: number }> {
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
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
    if (s.includes("<?xml")) return s.slice(s.indexOf("<?xml"));
    if (s.startsWith("<body>")) return s;
    return undefined;
  };

  // Always try: provided session enc (if any), then BC-XOR, then plaintext.
  return tryAs(sessionEnc) ?? (sessionEnc.kind !== "bc" ? tryAs({ kind: "bc" }) : undefined) ?? tryAs({ kind: "none" });
}

function extractRootTag(xml: string): string | undefined {
  const bodyIdx = xml.indexOf("<body");
  const s = bodyIdx >= 0 ? xml.slice(bodyIdx) : xml;
  const m = s.match(/<body[^>]*>\s*<([A-Za-z0-9_:-]+)/);
  return m?.[1];
}

function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:rtsp|rtsps|http|https):\/\/[^\s<>"]+/gi)) {
    if (m[0]) out.add(m[0]);
  }
  return [...out];
}

function extractNonce(xml: string): string | undefined {
  const m = xml.match(/<nonce>([^<]+)<\/nonce>/i) ?? xml.match(/<Nonce>([^<]+)<\/Nonce>/i);
  const v = m?.[1]?.trim();
  return v && v.length >= 6 ? v : undefined;
}

function main(): void {
  const fileArg = process.argv[2];
  const pcapPath = fileArg ? path.resolve(process.cwd(), fileArg) : path.resolve(process.cwd(), "pcap/homehub_events_stream.pcapng");

  const password = process.env.BAICHUAN_PASSWORD ?? process.env.NVR_PASSWORD ?? process.env.TCP_PASSWORD;

  const buf = fs.readFileSync(pcapPath);
  const magicOrBlockType = buf.readUInt32LE(0);
  const isPcapng = magicOrBlockType === 0x0a0d0d0a;
  if (!isPcapng) throw new Error("Expected PCAPNG");

  // Detect endianness from SHB byte-order magic
  const bom = buf.readUInt32LE(8);
  const endian: Endian = bom === 0x1a2b3c4d ? "le" : bom === 0x4d3c2b1a ? "be" : "le";

  const interfaceDefs: PcapInterface[] = [];

  const segmentsByDir = new Map<string, TcpSegment[]>();
  const packetsByDir = new Map<string, number>();
  const bytesByDir = new Map<string, number>();

  const tcpPortPairs = new Map<string, number>();

  let captureFirstTsMs: number | undefined;
  let captureLastTsMs: number | undefined;

  function ingestTcpPayload(srcIp: string, srcPort: number, dstIp: string, dstPort: number, seq: number, tsMs: number, payload: Buffer) {
    if (payload.length === 0) return;

    captureFirstTsMs = captureFirstTsMs === undefined ? tsMs : Math.min(captureFirstTsMs, tsMs);
    captureLastTsMs = captureLastTsMs === undefined ? tsMs : Math.max(captureLastTsMs, tsMs);

    const dirKey = `${srcIp}:${srcPort} > ${dstIp}:${dstPort}`;
    if (!segmentsByDir.has(dirKey)) segmentsByDir.set(dirKey, []);
    segmentsByDir.get(dirKey)!.push({ seq, tsMs, payload });

    packetsByDir.set(dirKey, (packetsByDir.get(dirKey) ?? 0) + 1);
    bytesByDir.set(dirKey, (bytesByDir.get(dirKey) ?? 0) + payload.length);

    const pairKey = `${Math.min(srcPort, dstPort)}-${Math.max(srcPort, dstPort)}`;
    tcpPortPairs.set(pairKey, (tcpPortPairs.get(pairKey) ?? 0) + payload.length);
  }

  function ingestPacket(pkt: Buffer, linkType: number, tsMs: number) {
    // Only Ethernet (1) supported for now.
    if (linkType !== 1) return;
    if (pkt.length < 14) return;

    const etherType = pkt.readUInt16BE(12);
    if (etherType !== 0x0800) return; // IPv4 only

    const ipOff = 14;
    if (pkt.length < ipOff + 20) return;
    const verIhl = pkt[ipOff]!;
    const ihl = (verIhl & 0x0f) * 4;
    const proto = pkt[ipOff + 9]!;
    if (proto !== 6) return; // TCP only

    const srcIp = ipToString(pkt, ipOff + 12);
    const dstIp = ipToString(pkt, ipOff + 16);

    const tcpOff = ipOff + ihl;
    if (pkt.length < tcpOff + 20) return;
    const srcPort = pkt.readUInt16BE(tcpOff);
    const dstPort = pkt.readUInt16BE(tcpOff + 2);
    const seq = pkt.readUInt32BE(tcpOff + 4);
    const dataOff = (pkt[tcpOff + 12]! >> 4) * 4;
    const payloadOff = tcpOff + dataOff;
    if (payloadOff > pkt.length) return;
    const payload = pkt.subarray(payloadOff);

    ingestTcpPayload(srcIp, srcPort, dstIp, dstPort, seq >>> 0, tsMs, payload);
  }

  // Iterate PCAPNG blocks
  let off = 0;
  while (off + 12 <= buf.length) {
    const blockType = readU32(buf, off, endian);
    const blockLen = readU32(buf, off + 4, endian);
    if (blockLen < 12) break;
    const blockEnd = off + blockLen;
    if (blockEnd > buf.length) break;

    if (blockType === 0x00000001) {
      // IDB
      if (off + 20 <= blockEnd) {
        const linkType = readU16(buf, off + 8, endian);
        let tsResol = 1e-6;

        // options
        let optOff = off + 20;
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

  const dirsSorted = [...bytesByDir.entries()]
    .map(([dirKey, payloadBytes]) => ({ dirKey, payloadBytes, packets: packetsByDir.get(dirKey) ?? 0 }))
    .sort((a, b) => b.payloadBytes - a.payloadBytes);

  // Attempt to parse Baichuan frames per direction.
  const baichuanDirs: Array<{ dirKey: string; frames: any[]; gaps: number }> = [];
  const nonBaichuanDirs: Array<{ dirKey: string; data: Buffer }> = [];

  for (const [dirKey, segs] of segmentsByDir.entries()) {
    const { data, gaps } = reassembleTcpSegments(segs);
    const parser = new BaichuanFrameParser();
    const frames = parser.push(data) as unknown as any[];
    if (frames.length > 0) baichuanDirs.push({ dirKey, frames, gaps });
    else nonBaichuanDirs.push({ dirKey, data });
  }

  // Summarize Baichuan cmdIds (includes frames with no XML, e.g. ping keepalive).
  const baichuanCmdStats = baichuanDirs.map((d) => {
    const cmdCounts = new Map<number, number>();
    const msgIdCounts = new Map<number, number>();
    let ping93 = 0;
    for (const f of d.frames) {
      const cmdId = Number(f.header?.cmdId ?? -1);
      const msgId = Number(f.header?.msgId ?? -1);
      if (!Number.isFinite(cmdId) || cmdId < 0) continue;
      cmdCounts.set(cmdId, (cmdCounts.get(cmdId) ?? 0) + 1);
      if (cmdId === 93) ping93 += 1;
      if (Number.isFinite(msgId) && msgId >= 0) msgIdCounts.set(msgId, (msgIdCounts.get(msgId) ?? 0) + 1);
    }

    return {
      dirKey: d.dirKey,
      totalFrames: d.frames.length,
      ping93,
      topCmdIds: topNFromCountMap(cmdCounts, 20),
      topMsgIds: topNFromCountMap(msgIdCounts, 20),
    };
  });

  // Traffic windows: helps spot if the client keeps sending packets towards the end.
  const trafficWindows = dirsSorted.slice(0, 20).map((d) => {
    const segs = segmentsByDir.get(d.dirKey) ?? [];
    return {
      dirKey: d.dirKey,
      payloadBytes: d.payloadBytes,
      packets: d.packets,
      last1s: buildTrafficWindow(segs, 1_000),
      last2s: buildTrafficWindow(segs, 2_000),
      last5s: buildTrafficWindow(segs, 5_000),
      last10s: buildTrafficWindow(segs, 10_000),
      last30s: buildTrafficWindow(segs, 30_000),
      last60s: buildTrafficWindow(segs, 60_000),
    };
  });

  // Guess PC/HUB by looking at a Baichuan stream: server side usually uses port 9000.
  let hubIp: string | undefined;
  let pcIp: string | undefined;
  let baichuanPort: number | undefined;

  const baichuanDirKey = baichuanDirs.map((d) => d.dirKey).sort((a, b) => (bytesByDir.get(b) ?? 0) - (bytesByDir.get(a) ?? 0))[0];
  if (baichuanDirKey) {
    const m = baichuanDirKey.match(/^(.*?):(\d+) > (.*?):(\d+)$/);
    if (m) {
      const srcIp = m[1]!;
      const srcPort = Number(m[2]!);
      const dstIp = m[3]!;
      const dstPort = Number(m[4]!);
      if (srcPort === 9000) {
        hubIp = srcIp;
        pcIp = dstIp;
        baichuanPort = srcPort;
      } else if (dstPort === 9000) {
        hubIp = dstIp;
        pcIp = srcIp;
        baichuanPort = dstPort;
      }
    }
  }

  // Pass 1: try to extract XML without AES (BC/plaintext). Also try to find nonce.
  const calls: XmlCall[] = [];
  let nonce: string | undefined;

  for (const d of baichuanDirs) {
    const dir = hubIp && d.dirKey.startsWith(`${pcIp}:`) ? "tx" : "rx";
    for (const f of d.frames) {
      const xmlBuf: Buffer = Buffer.from((f.extension && f.extension.length ? f.extension : f.body) ?? []);
      const xml = tryDecryptXmlBody(xmlBuf, Number(f.header?.channelId ?? 0), { kind: "unknown" });
      if (!xml) continue;

      const n = extractNonce(xml);
      if (!nonce && n) nonce = n;

      const rootTag = extractRootTag(xml);

      calls.push({
        dir,
        cmdId: Number(f.header?.cmdId ?? -1),
        msgNum: Number(f.header?.msgNum ?? -1),
        channelId: Number(f.header?.channelId ?? -1),
        responseCode: Number(f.header?.responseCode ?? -1),
        ...(rootTag ? { rootTag } : {}),
        xml,
      });
    }
  }

  // If nonce + password are available, attempt AES decrypt for all frames and replace/extend calls.
  let sessionEnc: SessionEnc = { kind: "unknown" };
  if (nonce && password) {
    const key = deriveAesKey(nonce, password);
    sessionEnc = { kind: "aes", key };

    const callsAes: XmlCall[] = [];
    for (const d of baichuanDirs) {
      const dir = hubIp && d.dirKey.startsWith(`${pcIp}:`) ? "tx" : "rx";
      for (const f of d.frames) {
        const xmlBuf: Buffer = Buffer.from((f.extension && f.extension.length ? f.extension : f.body) ?? []);
        const xml = tryDecryptXmlBody(xmlBuf, Number(f.header?.channelId ?? 0), sessionEnc);
        if (!xml) continue;

        const rootTag = extractRootTag(xml);
        callsAes.push({
          dir,
          cmdId: Number(f.header?.cmdId ?? -1),
          msgNum: Number(f.header?.msgNum ?? -1),
          channelId: Number(f.header?.channelId ?? -1),
          responseCode: Number(f.header?.responseCode ?? -1),
          ...(rootTag ? { rootTag } : {}),
          xml,
        });
      }
    }

    // Prefer AES-decrypted set if it yields more.
    if (callsAes.length >= calls.length) {
      calls.length = 0;
      calls.push(...callsAes);
    }
  }

  // Deduplicate calls by (dir/cmd/msg/ch/rc + xml hash)
  const dedup: XmlCall[] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    const h = createHash("sha1").update(c.xml, "utf8").digest("hex");
    const k = `${c.dir}:${c.cmdId}:${c.msgNum}:${c.channelId}:${c.responseCode}:${h}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(c);
  }

  // Extract RTSP/HTTP URLs from:
  // 1) decrypted XML
  // 2) raw non-baichuan TCP streams (RTSP requests)
  const urlsFromXml = new Set<string>();
  for (const c of dedup) {
    for (const u of extractUrls(c.xml)) urlsFromXml.add(u);
  }

  const rtspRequests: Array<{ dirKey: string; firstLine: string; url?: string }> = [];
  for (const d of nonBaichuanDirs) {
    const s = d.data.toString("utf8");
    if (!/(RTSP\/1\.0|DESCRIBE |SETUP |PLAY |TEARDOWN )/.test(s)) continue;
    // Split by CRLF and collect request lines.
    const lines = s.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^(DESCRIBE|SETUP|PLAY|TEARDOWN)\s+([^\s]+)\s+RTSP\/1\.0$/);
      if (!m) continue;
      const url = m[2];
      rtspRequests.push({ dirKey: d.dirKey, firstLine: line, ...(url ? { url } : {}) });
    }
  }

  // Keep a compact report on disk.
  const report = {
    pcapPath,
    guessed: { hubIp, pcIp, baichuanPort },
    passwordAvailable: Boolean(password),
    capture: {
      firstTsMs: captureFirstTsMs ?? null,
      lastTsMs: captureLastTsMs ?? null,
      durationMs: captureFirstTsMs !== undefined && captureLastTsMs !== undefined ? Math.max(0, captureLastTsMs - captureFirstTsMs) : null,
    },
    nonceDetected: nonce ?? null,
    decryption: sessionEnc.kind === "aes" ? "aes" : "bc/plaintext-only",
    directionsTop: dirsSorted.slice(0, 20),
    baichuanStreams: baichuanDirs.map((d) => ({ dirKey: d.dirKey, frames: d.frames.length, gaps: d.gaps, bytes: bytesByDir.get(d.dirKey) ?? 0 })),
    baichuanCmdStats,
    trafficWindows,
    xmlCalls: dedup.map((c) => ({ ...c, xml: c.xml.length > 20000 ? `${c.xml.slice(0, 20000)}...` : c.xml })),
    urls: {
      fromXml: [...urlsFromXml],
      rtspRequests,
    },
  };

  const outPath = path.resolve(process.cwd(), "test/pcap/exports/homehub_events_stream-analysis.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  // Console summary (keep it short)
  const uniqueCmdIds = [...new Set(dedup.map((c) => c.cmdId))].sort((a, b) => a - b);
  const uniqueRoots = [...new Set(dedup.map((c) => c.rootTag).filter(Boolean) as string[])].sort();

  console.log(JSON.stringify({
    pcapPath,
    guessed: { hubIp, pcIp, baichuanPort },
    capture: report.capture,
    nonceDetected: nonce ?? null,
    decryption: report.decryption,
    baichuan: {
      streams: report.baichuanStreams,
      ping93ByDir: report.baichuanCmdStats.map((s) => ({ dirKey: s.dirKey, ping93: s.ping93, totalFrames: s.totalFrames })),
      topCmdIdsByDir: report.baichuanCmdStats.map((s) => ({ dirKey: s.dirKey, topCmdIds: s.topCmdIds.slice(0, 10) })),
    },
    xmlCalls: { total: dedup.length, uniqueCmdIds, uniqueRootTags: uniqueRoots.slice(0, 50) },
    urls: {
      fromXml: [...urlsFromXml].slice(0, 50),
      rtspRequestCount: rtspRequests.length,
      rtspRequestUrls: [...new Set(rtspRequests.map((r) => r.url).filter(Boolean) as string[])].slice(0, 50),
    },
    reportPath: outPath,
  }, null, 2));
}

main();
