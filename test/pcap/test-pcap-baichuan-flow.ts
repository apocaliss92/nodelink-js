#!/usr/bin/env node
/**
 * PCAP-based analysis: reconstruct a high-level "flow" for Baichuan commands.
 *
 * Goal: for a given host (camera/NVR/HomeHub), group frames by cmdId+msgNum
 * and extract human-readable XML bodies (when present), to understand download
 * workflows (e.g. cmd143/cmd298 for events download).
 *
 * Usage:
 *   npm run test:build && node dist/test/pcap/test-pcap-baichuan-flow.js \
 *     "pcap/host 192.168.1.161 EVENTS_DOWNLOAD.pcapng" --host 192.168.1.161 --any-port \
 *     --out pcap/reports/host-192.168.1.161_EVENTS_DOWNLOAD.flow.json
 */

import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

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

function tryParseXmlPrefix(buf: Buffer, maxBytes: number): string | null {
  const slice = buf.subarray(0, Math.min(buf.length, maxBytes));
  const s = slice.toString("utf8");
  const i = s.indexOf("<?xml");
  if (i !== 0) return null;

  // heuristically cut at first NUL or obvious binary
  const nul = s.indexOf("\u0000");
  return (nul >= 0 ? s.slice(0, nul) : s).trim() || null;
}

function tryParseNonce(xml: string): string | null {
  const m = /<nonce>([^<]+)<\/nonce>/i.exec(xml);
  return m?.[1]?.trim() ? m[1].trim() : null;
}

function passwordForHostFromEnv(host: string): string | undefined {
  const h = host.trim();
  if (!h) return undefined;

  const direct = (process.env.BAICHUAN_PASSWORD ?? "").trim();
  if (direct) return direct;

  for (const [k, v] of Object.entries(process.env)) {
    if (!k.endsWith("_HOST")) continue;
    if (!v) continue;
    if (String(v).trim() !== h) continue;
    const pw = (process.env[k.replace(/_HOST$/, "_PASSWORD")] ?? "").trim();
    if (pw) return pw;
  }

  const tcp = (process.env.TCP_PASSWORD ?? "").trim();
  if (tcp) return tcp;
  const nvr = (process.env.NVR_PASSWORD ?? "").trim();
  if (nvr) return nvr;

  return undefined;
}

function parseArgs(argv: string[]): {
  pcapPath: string;
  host: string;
  port: number;
  outPath: string;
  password?: string;
} {
  const args = [...argv];
  const pcapPath = args.shift();
  if (!pcapPath) throw new Error("Missing pcap path arg");

  let host = process.env.BAICHUAN_HOST ?? "";
  let port = Number.parseInt(process.env.BAICHUAN_TCP_PORT ?? "9000", 10);
  let outPath = "pcap/reports/flow.json";
  let password: string | undefined;

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
    if (a === "--out") {
      outPath = String(args.shift() ?? outPath);
      continue;
    }
    if (a === "--password") {
      password = String(args.shift() ?? "").trim() || undefined;
      continue;
    }
  }

  host = host.trim();
  if (!host) throw new Error("Missing --host (or BAICHUAN_HOST)");
  if (!Number.isFinite(port) || port < 0)
    throw new Error(`Invalid port: ${port}`);

  if (!password) password = passwordForHostFromEnv(host);

  return {
    pcapPath,
    host,
    port,
    outPath,
    ...(password != null ? { password } : {}),
  };
}

function main(): void {
  const { pcapPath, host, port, outPath, password } = parseArgs(
    process.argv.slice(2),
  );

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
        : (dstIp === host && dstPort === port) ||
          (srcIp === host && srcPort === port);
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

  // Derive AES key from cmdId=1 negotiation response.
  let negotiatedAesKey: Buffer | null = null;
  let negotiatedEncType: number | null = null;
  let negotiatedNonce: string | null = null;

  if (password) {
    for (const [dirKey, segs] of segmentsByDir.entries()) {
      const m =
        /^(\d+\.\d+\.\d+\.\d+):(\d+) -> (\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(
          dirKey,
        );
      const srcIp = m?.[1] ?? "";
      if (srcIp !== host) continue;

      const { data } = reassembleTcpSegments(segs);
      const parser = new BaichuanFrameParser();
      const frames = parser.push(data) as unknown as FrameLike[];

      for (const f of frames) {
        if (f.header.cmdId !== 1) continue;
        const resp = f.header.responseCode;
        if (resp >>> 8 !== 0xdd) continue;

        const encType = resp & 0xff;
        negotiatedEncType = encType;

        const body = Buffer.concat([f.extension, f.payload]);
        let nonceXml = "";

        if (encType === 0x00) {
          nonceXml = body.toString("utf8");
        } else {
          for (const offTry of [f.header.channelId, 250, 0]) {
            try {
              const s = bcDecrypt(body, offTry).toString("utf8");
              nonceXml = s;
              const parsed = tryParseNonce(s);
              if (parsed) {
                negotiatedNonce = parsed;
                break;
              }
            } catch {
              // ignore
            }
          }
        }

        if (!negotiatedNonce) negotiatedNonce = tryParseNonce(nonceXml);

        if (negotiatedNonce && (encType === 0x02 || encType === 0x12)) {
          negotiatedAesKey = deriveAesKey(negotiatedNonce, password);
        }

        if (negotiatedAesKey) break;
      }

      if (negotiatedAesKey) break;
    }
  }

  type MsgGroup = {
    frames: number;
    payloadBytes: number;
    bodyBytes: number;
    extBytes: number;
    payloadOffset: Record<string, number>;
    exampleHeader?: {
      channelId: number;
      streamType: number;
      responseCode: number;
      messageClass: string;
    };
    exampleXml?: string;
  };

  type CmdGroup = {
    cmdId: number;
    req: Record<string, MsgGroup>;
    rsp: Record<string, MsgGroup>;
  };

  const cmds: Record<string, CmdGroup> = {};

  const ensure = (cmdId: number): CmdGroup => {
    const k = String(cmdId);
    if (!cmds[k]) cmds[k] = { cmdId, req: {}, rsp: {} };
    return cmds[k];
  };

  const update = (g: MsgGroup, f: FrameLike, body: Buffer): void => {
    g.frames++;
    g.bodyBytes += body.length;
    g.extBytes += f.extension.length;
    g.payloadBytes += f.payload.length;

    const po =
      typeof f.header.payloadOffset === "number" ? f.header.payloadOffset : 0;
    g.payloadOffset[String(po)] = (g.payloadOffset[String(po)] ?? 0) + 1;

    if (!g.exampleHeader) {
      g.exampleHeader = {
        channelId: f.header.channelId,
        streamType: f.header.streamType,
        responseCode: f.header.responseCode,
        messageClass: `0x${f.header.messageClass.toString(16)}`,
      };
    }

    if (!g.exampleXml) {
      const xml = tryParseXmlPrefix(body, 4096);
      if (xml) g.exampleXml = xml;
    }
  };

  let gapsTotal = 0;

  for (const [dirKey, segs] of segmentsByDir.entries()) {
    const m = /^(\d+\.\d+\.\d+\.\d+):(\d+) -> (\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(
      dirKey,
    );
    const srcIp = m?.[1] ?? "";
    const dstIp = m?.[3] ?? "";

    const isRsp = srcIp === host;
    const isReq = dstIp === host;
    if (!isRsp && !isReq) continue;

    const { data, gaps } = reassembleTcpSegments(segs);
    gapsTotal += gaps;

    const parser = new BaichuanFrameParser();
    const frames = parser.push(data) as unknown as FrameLike[];

    for (const f of frames) {
      const cmd = ensure(f.header.cmdId);
      const bucket = isReq ? cmd.req : cmd.rsp;
      const msgKey = `${f.header.channelId}:${f.header.streamType}:${f.header.msgNum}`;
      const g =
        bucket[msgKey] ??
        (bucket[msgKey] = {
          frames: 0,
          payloadBytes: 0,
          bodyBytes: 0,
          extBytes: 0,
          payloadOffset: {},
        });

      const rawBody = Buffer.concat([f.extension, f.payload]);
      let body = rawBody;

      if (
        negotiatedAesKey &&
        negotiatedEncType != null &&
        (negotiatedEncType === 0x02 || negotiatedEncType === 0x12)
      ) {
        try {
          body = aesDecrypt(rawBody, negotiatedAesKey);
        } catch {
          body = rawBody;
        }
      }

      update(g, f, body);
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
    tcp: { dirs: segmentsByDir.size, gapsTotal },
    cmds,
  };

  const outAbs = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(out, null, 2));
  process.stdout.write(`${outAbs}\n`);
}

main();
