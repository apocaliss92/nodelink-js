#!/usr/bin/env node
/**
 * Extract a raw concatenated payload stream for a given Baichuan cmdId from a PCAPNG.
 *
 * This is intended for reverse-engineering the app's "download" path (e.g. cmdId=143)
 * by checking for MP4 boxes (ftyp/moov/moof/mdat) or other signatures.
 *
 * Usage:
 *   npm run test:build && node dist/test/pcap/test-pcap-baichuan-extract-cmd-stream.js \
 *     pcap/host\ 192.168.50.226\ _DOWNLOAD.pcapng --host 192.168.50.226 --cmd 143 --any-port \
 *     --out test/artifacts/pcap/extracts/226-cmd143.bin --max-bytes 5000000
 */

import fs from "node:fs";
import path from "node:path";

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { BaichuanFrameParser } from "../../index.js";

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
  payload: Buffer;
  extension: Buffer;
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

    if (s.seq < expectedSeq) {
      const delta = expectedSeq - s.seq;
      if (delta < s.payload.length) {
        const tail = s.payload.subarray(delta);
        out.push(tail);
        expectedSeq = (expectedSeq + tail.length) >>> 0;
      }
      continue;
    }

    gaps += 1;
    out.push(s.payload);
    expectedSeq = (s.seq + s.payload.length) >>> 0;
  }

  return { data: Buffer.concat(out), gaps };
}

function detectAnyMp4BoxAt(buf: Buffer, i: number): string | null {
  if (i + 8 > buf.length) return null;
  const type = buf.subarray(i + 4, i + 8).toString("ascii");
  if (!/^[A-Za-z0-9 ]{4}$/.test(type)) return null;
  if (["ftyp", "moov", "moof", "mdat", "styp", "sidx", "free", "skip"].includes(type)) return type;
  return null;
}

function parseArgs(argv: string[]): {
  pcapPath: string;
  host: string;
  port: number;
  cmdId: number;
  outPath: string;
  maxBytes: number;
  mode: "payload" | "body";
} {
  const args = [...argv];
  const pcapPath = args.shift();
  if (!pcapPath) throw new Error("Missing pcap path arg");

  let host = process.env.BAICHUAN_HOST ?? "";
  let port = Number.parseInt(process.env.BAICHUAN_TCP_PORT ?? "9000", 10);
  let cmdId = 143;
  let outPath = "test/artifacts/pcap/extracts/cmd.bin";
  let maxBytes = 5_000_000;
  let mode: "payload" | "body" = "payload";

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
    if (a === "--cmd") {
      cmdId = Number.parseInt(String(args.shift() ?? "143"), 10);
      continue;
    }
    if (a === "--out") {
      outPath = String(args.shift() ?? outPath);
      continue;
    }
    if (a === "--max-bytes") {
      maxBytes = Number.parseInt(String(args.shift() ?? String(maxBytes)), 10);
      continue;
    }
    if (a === "--body" || a === "--include-ext" || a === "--include-extension") {
      mode = "body";
      continue;
    }
    if (a === "--payload") {
      mode = "payload";
      continue;
    }
  }

  host = host.trim();
  if (!host) throw new Error("Missing --host (or BAICHUAN_HOST)");
  if (!Number.isFinite(port) || port < 0) throw new Error(`Invalid port: ${port}`);
  if (!Number.isFinite(cmdId) || cmdId <= 0) throw new Error(`Invalid cmdId: ${cmdId}`);
  if (!outPath) throw new Error("Missing --out");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error(`Invalid --max-bytes: ${maxBytes}`);

  return { pcapPath, host, port, cmdId, outPath, maxBytes, mode };
}

function main(): void {
  // Avoid crashing when stdout is closed early (e.g. piping to `head`).
  process.stdout.on("error", (err: any) => {
    if (err?.code === "EPIPE") process.exit(0);
  });

  const { pcapPath, host, port, cmdId, outPath, maxBytes, mode } = parseArgs(process.argv.slice(2));
  const abs = path.resolve(process.cwd(), pcapPath);
  const buf = fs.readFileSync(abs);
  if (buf.length < 12) throw new Error("Capture too small");

  const interfaceDefs: PcapInterface[] = [];
  const segmentsByDir = new Map<string, TcpSegment[]>();

  function ingestPacket(pkt: Buffer, linkType: number, tsMs: number) {
    if (linkType !== 1 && linkType !== 0) return;

    let ipOffset = 0;
    if (linkType === 1) {
      if (pkt.length < 14) return;
      let etherType = pkt.readUInt16BE(12);
      ipOffset = 14;
      if (etherType === 0x8100 && pkt.length >= 18) {
        etherType = pkt.readUInt16BE(16);
        ipOffset = 18;
      }
      if (etherType !== 0x0800) return;
    } else {
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
        : (dstIp === host && dstPort === port) || (srcIp === host && srcPort === port);
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

  const selectedChunks: Buffer[] = [];
  let selectedBytes = 0;
  let selectedFrames = 0;
  let gapsTotal = 0;

  const mp4Hits: Record<string, number> = {};
  let annexBHits = 0;
  let totalExtBytes = 0;

  for (const [dirKey, segs] of segmentsByDir.entries()) {
    const { data, gaps } = reassembleTcpSegments(segs);
    gapsTotal += gaps;

    const m = /^(\d+\.\d+\.\d+\.\d+):(\d+) -> (\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(dirKey);
    const srcIp = m?.[1] ?? "";
    const dstIp = m?.[3] ?? "";

    // only responses from camera
    if (srcIp !== host) continue;

    const parser = new BaichuanFrameParser();
    const frames = parser.push(data) as unknown as FrameLike[];

    for (const f of frames) {
      if (f.header.cmdId !== cmdId) continue;
      if (dstIp === host) continue; // sanity

      const dataBlob =
        mode === "body"
          ? f.extension.length
            ? Buffer.concat([f.extension, f.payload])
            : f.payload
          : f.payload;

      if (dataBlob.length === 0) continue;

      selectedFrames++;
      const remain = maxBytes - selectedBytes;
      if (remain <= 0) break;
      const chunk = dataBlob.length <= remain ? dataBlob : dataBlob.subarray(0, remain);
      selectedChunks.push(chunk);
      selectedBytes += chunk.length;
      totalExtBytes += mode === "body" ? f.extension.length : 0;

      // quick signature scan in the chunk
      for (let i = 0; i + 8 <= chunk.length && i < 1024; i++) {
        const t = detectAnyMp4BoxAt(chunk, i);
        if (t) mp4Hits[t] = (mp4Hits[t] ?? 0) + 1;
      }
      if (chunk.includes(Buffer.from([0x00, 0x00, 0x00, 0x01]))) annexBHits++;

      if (selectedBytes >= maxBytes) break;
    }
  }

  const outAbs = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, Buffer.concat(selectedChunks));

  const report = {
    input: { pcapPath, host, port, cmdId, mode },
    outPath: outAbs,
    selected: { frames: selectedFrames, bytes: selectedBytes, gapsTotal, totalExtBytes },
    signatures: { mp4Hits, annexBHits },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
