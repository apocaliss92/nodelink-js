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

function main(): void {
  const fileArg = process.argv[2];
  const pcapPath = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(process.cwd(), "pcap/hub_events_list.pcapng");

  const hubIp = process.env.HUB_IP ?? "192.168.1.161";
  const pcIp = process.env.PC_IP ?? "192.168.1.230";
  const baichuanTcpPort = Number.parseInt(process.env.BAICHUAN_TCP_PORT ?? "9000", 10);

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
