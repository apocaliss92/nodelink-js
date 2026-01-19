#!/usr/bin/env node
/**
 * PCAP-based analysis: HomeHub "events stream" capture
 *
 * Input: pcap/homehub_events_stream.pcapng
 * Goal:
 * - Identify which Baichuan cmdIds are present in the capture.
 * - Extract a few plaintext XML payload samples (when available).
 *
 * Notes:
 * - Many payloads may be encrypted; we only sample payloads that look like plaintext XML.
 */

import fs from "node:fs";
import path from "node:path";

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { BaichuanFrameParser } from "../../index.js";

type Endian = "le" | "be";

type TcpSegment = { seq: number; tsMs: number; payload: Buffer };

type PcapInterface = { linkType: number; tsResol: number };

type CmdSummary = {
  cmdId: number;
  requests: number;
  responses: number;
  responseCodesTop: Array<{ responseCode: number; count: number }>;
  sampleXmlPayloads: string[];
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

function tryExtractXmlSamples(buf: Buffer): string[] {
  const s = buf.toString("utf8");
  const out: string[] = [];
  // Very conservative: only keep strings that contain an XML body tag.
  if (!s.includes("<body") || !s.includes("</body>")) return out;

  // Extract up to 3 snippets.
  const re = /<\?xml[^>]*\?>[\s\S]*?<\/body>/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(s))) {
    const snippet = (m[0] ?? "").trim();
    if (!snippet) continue;
    out.push(snippet.length > 2000 ? `${snippet.slice(0, 2000)}...` : snippet);
    if (out.length >= 3) break;
  }

  return out;
}

function main(): void {
  const fileArg = process.argv[2];
  const pcapPath = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(process.cwd(), "pcap/homehub_events_stream.pcapng");

  const hubIp = process.env.HUB_IP ?? "192.168.1.161";
  const pcIp = process.env.PC_IP ?? "192.168.1.230";
  const baichuanTcpPort = Number.parseInt(process.env.BAICHUAN_TCP_PORT ?? "9000", 10);

  const buf = fs.readFileSync(pcapPath);
  if (buf.length < 12) throw new Error("Capture too small");

  const interfaceDefs: PcapInterface[] = [];
  const segmentsByDir = new Map<string, TcpSegment[]>();

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
      (srcIp === hubIp && dstIp === pcIp && srcPort === baichuanTcpPort) ||
      (srcIp === pcIp && dstIp === hubIp && dstPort === baichuanTcpPort);
    if (!isInScope) return;

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
          const iface = interfaceDefs[interfaceId] ?? interfaceDefs[0] ?? { linkType: 1, tsResol: 1e-6 };
          const ticks = (BigInt(tsHigh) << 32n) | BigInt(tsLow);
          const tsMs = Number(ticks) * iface.tsResol * 1000;
          ingestPacket(buf.subarray(pktStart, pktEnd), iface.linkType, tsMs);
        }
      }
    }

    off = blockEnd;
  }

  const framesByDir = new Map<string, Array<any>>();
  for (const [dirKey, segs] of segmentsByDir.entries()) {
    const { data } = reassembleTcpSegments(segs);
    const parser = new BaichuanFrameParser();
    const frames = parser.push(data) as unknown as Array<any>;
    framesByDir.set(dirKey, frames);
  }

  const cmdStats = new Map<number, { req: number; resp: number; respCodes: Map<number, number>; samples: string[] }>();

  for (const [dirKey, frames] of framesByDir.entries()) {
    const isPcToHub = dirKey.startsWith(`${pcIp}:`);
    for (const f of frames) {
      const cmdId = f?.header?.cmdId;
      if (typeof cmdId !== "number") continue;

      const s = cmdStats.get(cmdId) ?? ({ req: 0, resp: 0, respCodes: new Map<number, number>(), samples: [] as string[] });
      if (isPcToHub) s.req += 1;
      else {
        s.resp += 1;
        const rc = f?.header?.responseCode;
        if (typeof rc === "number") s.respCodes.set(rc, (s.respCodes.get(rc) ?? 0) + 1);
      }

      // Try to extract plaintext XML from body/extension/payload.
      const candidates: Buffer[] = [];
      try {
        if (f?.body) candidates.push(Buffer.from(f.body));
        if (f?.extension) candidates.push(Buffer.from(f.extension));
        if (f?.payload) candidates.push(Buffer.from(f.payload));
      } catch {
        // ignore
      }

      for (const c of candidates) {
        if (s.samples.length >= 6) break;
        const xmls = tryExtractXmlSamples(c);
        for (const x of xmls) {
          if (s.samples.length >= 6) break;
          if (!s.samples.includes(x)) s.samples.push(x);
        }
      }

      cmdStats.set(cmdId, s);
    }
  }

  const summaries: CmdSummary[] = [...cmdStats.entries()]
    .map(([cmdId, s]) => {
      const responseCodesTop = [...s.respCodes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([responseCode, count]) => ({ responseCode, count }));
      return {
        cmdId,
        requests: s.req,
        responses: s.resp,
        responseCodesTop,
        sampleXmlPayloads: s.samples,
      };
    })
    .sort((a, b) => (b.requests + b.responses) - (a.requests + a.responses));

  const out = {
    pcapPath,
    hubIp,
    pcIp,
    baichuanTcpPort,
    uniqueCmdIds: summaries.map((s) => s.cmdId).sort((a, b) => a - b),
    cmds: summaries,
    topCmds: summaries.slice(0, 25),
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

main();
