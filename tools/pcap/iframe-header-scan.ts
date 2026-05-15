#!/usr/bin/env tsx
/**
 * Dump the `additionalHeader` field of every I/P-frame BcMedia packet found in
 * a pcap (via the live AES-stateful decrypt pipeline). This is the only
 * variable-length region inside a Reolink media packet that COULD carry
 * structured side-channel data (e.g. Motion Mark coordinates) without the
 * pcap analyzer noticing it as a separate sub-packet.
 *
 * Output is a per-size histogram + a hex dump of the first few samples.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { extractBaichuanPayloads } from "./tshark";
import { analyzePcap } from "./decrypt";
import { BC_CMD_ID_VIDEO } from "../../src/protocol/constants";
import {
  aesDecrypt,
  bcDecrypt,
  type EncryptionProtocol,
} from "../../src/protocol/crypto";
import { BcMediaCodec } from "../../src/baichuan/stream/BcMediaCodec";
import type { BaichuanFrame } from "../../src/protocol/framing";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let pcapPath = "";
  let streamFilter: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--stream") {
      streamFilter = Number(argv[++i]);
    } else if (!pcapPath) {
      pcapPath = a;
    }
  }
  if (!pcapPath) {
    process.stderr.write("usage: iframe-header-scan.ts [--stream N] <pcap>\n");
    process.exit(1);
  }
  const payloads = await extractBaichuanPayloads(pcapPath);

  // Use existing decrypt pipeline to learn the session keys.
  const passwords = loadPasswordsFromEnv();
  const { frames, sessions } = analyzePcap(payloads, { passwords });

  type Stat = {
    sizes: Map<number, number>;
    samples: string[];
    iframeN: number;
    pframeN: number;
    headersBySize: Map<number, Buffer[]>;
  };
  const stat: Stat = {
    sizes: new Map(),
    samples: [],
    iframeN: 0,
    pframeN: 0,
    headersBySize: new Map(),
  };

  // Bucket frames by (streamId, direction).
  const buckets = new Map<string, BaichuanFrame[]>();
  for (const af of frames) {
    if (af.frame.header.cmdId !== BC_CMD_ID_VIDEO) continue;
    if (af.frame.payload.length === 0) continue;
    if (streamFilter !== undefined && af.pcap.streamId !== streamFilter) continue;
    const key = `${af.pcap.streamId}:${af.pcap.direction}`;
    const list = buckets.get(key);
    if (list) list.push(af.frame);
    else buckets.set(key, [af.frame]);
  }

  for (const [key, list] of buckets) {
    const streamId = Number(key.split(":")[0]);
    const enc = sessions.get(streamId);
    if (!enc) continue;
    const codec = new BcMediaCodec(false);
    const encP: EncryptionProtocol =
      enc.kind === "none" || enc.kind === "bc" ? { kind: enc.kind } : { kind: enc.kind, key: enc.key };

    for (const frame of list) {
      const encryptLen = parseEncryptLen(frame.extension, frame.header.channelId, encP);
      let dec: Buffer;
      if (encryptLen !== undefined && encryptLen > 0 && encryptLen < frame.payload.length) {
        const encPart = frame.payload.subarray(0, encryptLen);
        const clearPart = frame.payload.subarray(encryptLen);
        dec = Buffer.concat([decryptOneShot(encPart, frame.header.channelId, encP), clearPart]);
      } else {
        dec = decryptOneShot(frame.payload, frame.header.channelId, encP);
      }
      const packets = codec.decode(dec);
      for (const p of packets) {
        if (p.type !== "Iframe" && p.type !== "Pframe") continue;
        if (p.type === "Iframe") stat.iframeN += 1;
        else stat.pframeN += 1;
        if (!p.additionalHeader) continue;
        const sz = p.additionalHeader.length;
        stat.sizes.set(sz, (stat.sizes.get(sz) ?? 0) + 1);
        if (stat.samples.length < 8 && sz > 4) {
          stat.samples.push(`[${p.type} size=${sz}] ${p.additionalHeader.toString("hex")}`);
        }
        let bucket = stat.headersBySize.get(sz);
        if (!bucket) {
          bucket = [];
          stat.headersBySize.set(sz, bucket);
        }
        // Cap collection to keep memory in check on big pcaps.
        if (bucket.length < 5000) bucket.push(p.additionalHeader);
      }
    }
  }

  process.stdout.write(`I-frames: ${stat.iframeN}  P-frames: ${stat.pframeN}\n`);
  process.stdout.write("\nadditionalHeader size histogram:\n");
  const rows = [...stat.sizes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [size, count] of rows) {
    process.stdout.write(`  ${String(size).padStart(5)} bytes  ×  ${count}\n`);
  }
  if (stat.samples.length > 0) {
    process.stdout.write("\nFirst non-trivial samples:\n");
    for (const s of stat.samples) process.stdout.write(`  ${s}\n`);
  }

  // Pick the dominant size class and run a byte-level diff:
  // for each offset within the additionalHeader, count distinct byte values.
  // Static positions (count=1) are header constants; varying positions are
  // payload (timestamp, frame counter, possibly box coordinates).
  const dominantSize = rows[0]?.[0];
  if (dominantSize) {
    const samples = stat.headersBySize.get(dominantSize) ?? [];
    process.stdout.write(`\nByte-level diff for size=${dominantSize} additionalHeaders (count=${samples.length}):\n`);
    process.stdout.write(byteLevelDiff(samples));

    process.stdout.write(`\nFrame-to-frame XOR delta (Hamming distance per offset):\n`);
    process.stdout.write(xorDelta(samples));
  }

  // Per-size byte-level diff for the EXTRA bytes beyond the baseline size.
  // The baseline is the smallest observed size (typically a no-overlay header).
  // We print only sizes with at least 5 samples to keep noise low.
  const baselineSize = Math.min(...rows.map(([sz]) => sz));
  const otherSizes = rows
    .map(([sz, n]) => ({ sz, n }))
    .filter(({ sz, n }) => sz > baselineSize && n >= 5)
    .sort((a, b) => a.sz - b.sz);

  if (otherSizes.length > 0) {
    process.stdout.write(`\n=== Per-size analysis (baseline=${baselineSize}) ===\n`);
    for (const { sz, n } of otherSizes) {
      const samples = stat.headersBySize.get(sz) ?? [];
      process.stdout.write(
        `\nByte-level diff for size=${sz} additionalHeaders (count=${n}):\n`
      );
      process.stdout.write(byteLevelDiff(samples));
      // Show the EXTRA region (bytes beyond baselineSize) hex-dumped from the first sample
      // and the distinct-value mark per offset in that region.
      if (samples.length > 0 && samples[0]) {
        const extraStart = baselineSize;
        const extraEnd = sz;
        process.stdout.write(
          `  --- extra region offsets +0x${extraStart
            .toString(16)
            .padStart(3, "0")}..+0x${(extraEnd - 1)
            .toString(16)
            .padStart(3, "0")} (${extraEnd - extraStart} bytes) ---\n`
        );
        // Hex preview of first 3 samples' extra region
        const limit = Math.min(3, samples.length);
        for (let i = 0; i < limit; i++) {
          const extra = samples[i]!.subarray(extraStart, extraEnd);
          process.stdout.write(`  sample[${i}] ${extra.toString("hex")}\n`);
        }
      }
    }
  }
}

function xorDelta(headers: Buffer[]): string {
  if (headers.length < 2) return "  (need at least 2 samples)\n";
  const size = headers[0]!.length;
  const flips = new Array<number>(size).fill(0);
  for (let i = 1; i < headers.length; i++) {
    const a = headers[i - 1]!;
    const b = headers[i]!;
    if (a.length !== size || b.length !== size) continue;
    for (let j = 0; j < size; j++) {
      if (a[j] !== b[j]) flips[j]! += 1;
    }
  }
  const lines: string[] = [];
  for (let row = 0; row < size; row += 16) {
    const cells: string[] = [];
    for (let j = 0; j < 16 && row + j < size; j++) {
      const ratio = flips[row + j]! / (headers.length - 1);
      // visualize: '·' 0-25%, ':' 25-50%, '-' 50-75%, '*' 75-100%
      if (ratio === 0) cells.push(".");
      else if (ratio < 0.25) cells.push("·");
      else if (ratio < 0.5) cells.push(":");
      else if (ratio < 0.75) cells.push("-");
      else cells.push("*");
    }
    lines.push(`  +0x${row.toString(16).padStart(3, "0")}  ${cells.join(" ")}`);
  }
  lines.push("  legend: . = always same vs prev frame, ·/:/-/* = increasing change rate");
  return lines.join("\n") + "\n";
}

function byteLevelDiff(headers: Buffer[]): string {
  if (headers.length === 0) return "  (no samples)\n";
  const size = headers[0]!.length;
  const counts: Array<Set<number>> = [];
  for (let i = 0; i < size; i++) counts.push(new Set());
  for (const h of headers) {
    for (let i = 0; i < size; i++) counts[i]!.add(h[i]!);
  }
  // Group bytes into runs (consecutive offsets sharing distinct-value tier)
  // and print as table rows of 16 bytes.
  const lines: string[] = [];
  for (let row = 0; row < size; row += 16) {
    const offsets = [...Array(Math.min(16, size - row))].map((_, j) => row + j);
    const distinctMarks = offsets
      .map((off) => {
        const n = counts[off]!.size;
        if (n === 1) return ".";
        if (n < 4) return "·";
        if (n < 16) return ":";
        return "*";
      })
      .join(" ");
    const sample = headers[0]!.subarray(row, row + 16).toString("hex").match(/../g)!.join(" ");
    lines.push(`  +0x${row.toString(16).padStart(3, "0")}  ${sample}  ${distinctMarks}`);
  }
  lines.push(`  legend: '.' = always-same byte, '·' < 4 distinct, ':' < 16 distinct, '*' = highly variable`);
  return lines.join("\n") + "\n";
}

function decryptOneShot(buf: Buffer, channelId: number, enc: EncryptionProtocol): Buffer {
  try {
    if (enc.kind === "none") return buf;
    if (enc.kind === "bc") return bcDecrypt(buf, channelId);
    return aesDecrypt(buf, enc.key);
  } catch {
    return buf;
  }
}

function parseEncryptLen(extension: Buffer, channelId: number, enc: EncryptionProtocol): number | undefined {
  if (extension.length === 0) return undefined;
  const candidates: Buffer[] = [];
  try { if (enc.kind === "aes" || enc.kind === "full_aes") candidates.push(aesDecrypt(extension, enc.key)); } catch {/* */}
  try { candidates.push(bcDecrypt(extension, channelId)); } catch {/* */}
  candidates.push(extension);
  for (const c of candidates) {
    const s = c.toString("utf8");
    if (!s.startsWith("<?xml") && !s.startsWith("<Extension")) continue;
    const m = /<encryptLen>(\d+)<\/encryptLen>/i.exec(s);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function loadPasswordsFromEnv(): string[] {
  const envPath = pathResolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return [];
  const raw = readFileSync(envPath, "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const m = /^([A-Z0-9_]*PASSWORD)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[2].replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
