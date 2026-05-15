#!/usr/bin/env tsx
/**
 * End-to-end validation of `decodeDetectionHeader` against a real pcap.
 *
 * - Decrypts cmd_id=3 video frames using the production pipeline
 * - Decodes every BcMedia I-frame and P-frame
 * - Feeds each `additionalHeader` to the detection decoder
 * - Reports the distribution of decode states, plus session-token / counter
 *   stability checks that prove the marker parser is locking onto the right
 *   fields.
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
import { decodeDetectionHeader } from "../../src/reolink/baichuan/utils/detection";
import type { ReolinkDetectionDecodeState } from "../../src/reolink/baichuan/types";

interface Args {
  pcap: string;
  streamFilter?: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const payloads = await extractBaichuanPayloads(args.pcap);
  const passwords = loadPasswordsFromEnv();
  const { frames, sessions } = analyzePcap(payloads, { passwords });

  const stateCounts = new Map<ReolinkDetectionDecodeState, number>();
  const sizeCounts = new Map<number, number>();
  const pframeCountersByStream = new Map<number, number[]>();
  let totalHeaders = 0;
  let invalidMarkerSamples: string[] = [];
  let sampleCounter: number | undefined;

  const buckets = new Map<number, BaichuanFrame[]>();
  for (const af of frames) {
    if (af.frame.header.cmdId !== BC_CMD_ID_VIDEO) continue;
    if (af.frame.payload.length === 0) continue;
    if (args.streamFilter !== undefined && af.pcap.streamId !== args.streamFilter)
      continue;
    const list = buckets.get(af.pcap.streamId);
    if (list) list.push(af.frame);
    else buckets.set(af.pcap.streamId, [af.frame]);
  }

  for (const [streamId, list] of buckets) {
    const enc = sessions.get(streamId);
    if (!enc) continue;
    const codec = new BcMediaCodec(false);
    const encP: EncryptionProtocol =
      enc.kind === "none" || enc.kind === "bc"
        ? { kind: enc.kind }
        : { kind: enc.kind, key: enc.key };

    for (const frame of list) {
      const encryptLen = parseEncryptLen(
        frame.extension,
        frame.header.channelId,
        encP,
      );
      let dec: Buffer;
      if (
        encryptLen !== undefined &&
        encryptLen > 0 &&
        encryptLen < frame.payload.length
      ) {
        const encPart = frame.payload.subarray(0, encryptLen);
        const clearPart = frame.payload.subarray(encryptLen);
        dec = Buffer.concat([
          decryptOneShot(encPart, frame.header.channelId, encP),
          clearPart,
        ]);
      } else {
        dec = decryptOneShot(frame.payload, frame.header.channelId, encP);
      }
      const packets = codec.decode(dec);
      for (const p of packets) {
        if (p.type !== "Iframe" && p.type !== "Pframe") continue;
        if (!p.additionalHeader || p.additionalHeader.length === 0) continue;
        totalHeaders += 1;
        sizeCounts.set(
          p.additionalHeader.length,
          (sizeCounts.get(p.additionalHeader.length) ?? 0) + 1,
        );
        const decoded = decodeDetectionHeader(p.additionalHeader, p.type);
        stateCounts.set(
          decoded.state,
          (stateCounts.get(decoded.state) ?? 0) + 1,
        );
        if (decoded.state === "invalid-marker" && invalidMarkerSamples.length < 3) {
          invalidMarkerSamples.push(
            `len=${p.additionalHeader.length} type=${p.type} head=${p.additionalHeader.subarray(0, 16).toString("hex")}`,
          );
        }
        if (decoded.counter !== undefined && p.type === "Pframe") {
          let list = pframeCountersByStream.get(streamId);
          if (!list) {
            list = [];
            pframeCountersByStream.set(streamId, list);
          }
          list.push(decoded.counter);
        }
        if (sampleCounter === undefined && decoded.counter !== undefined) {
          sampleCounter = decoded.counter;
        }
      }
    }
  }

  process.stdout.write(`\n=== Detection decoder validation ===\n`);
  process.stdout.write(`pcap: ${args.pcap}\n`);
  if (args.streamFilter !== undefined) {
    process.stdout.write(`stream filter: ${args.streamFilter}\n`);
  }
  process.stdout.write(`total additionalHeaders: ${totalHeaders}\n\n`);

  process.stdout.write("decodeState distribution:\n");
  for (const [state, count] of [...stateCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    const pct = ((count / totalHeaders) * 100).toFixed(1);
    process.stdout.write(`  ${state.padEnd(20)} ${String(count).padStart(8)}  ${pct}%\n`);
  }

  if (invalidMarkerSamples.length > 0) {
    process.stdout.write("\ninvalid-marker samples (first 3):\n");
    for (const s of invalidMarkerSamples) {
      process.stdout.write(`  ${s}\n`);
    }
  }

  process.stdout.write(
    "\nP-frame counter coverage per stream (number of distinct counters):\n",
  );
  for (const [streamId, list] of pframeCountersByStream) {
    const distinct = new Set(list).size;
    const pct = ((distinct / list.length) * 100).toFixed(1);
    process.stdout.write(
      `  stream=${streamId}: ${list.length} P-frames, ${distinct} distinct counters  (${pct}% unique)\n`,
    );
  }

  process.stdout.write("\nsize histogram (top 8):\n");
  const sortedSizes = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [size, count] of sortedSizes.slice(0, 8)) {
    const pct = ((count / totalHeaders) * 100).toFixed(1);
    process.stdout.write(
      `  ${String(size).padStart(4)} bytes  ${String(count).padStart(8)}  ${pct}%\n`,
    );
  }

  if (sampleCounter !== undefined) {
    process.stdout.write(
      `\nsample counter from first header: 0x${sampleCounter
        .toString(16)
        .padStart(8, "0")}\n`,
    );
  }
}

function decryptOneShot(
  buf: Buffer,
  channelId: number,
  enc: EncryptionProtocol,
): Buffer {
  try {
    if (enc.kind === "none") return buf;
    if (enc.kind === "bc") return bcDecrypt(buf, channelId);
    return aesDecrypt(buf, enc.key);
  } catch {
    return buf;
  }
}

function parseEncryptLen(
  extension: Buffer,
  channelId: number,
  enc: EncryptionProtocol,
): number | undefined {
  if (extension.length === 0) return undefined;
  const candidates: Buffer[] = [];
  try {
    if (enc.kind === "aes" || enc.kind === "full_aes")
      candidates.push(aesDecrypt(extension, enc.key));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(bcDecrypt(extension, channelId));
  } catch {
    /* ignore */
  }
  candidates.push(extension);
  for (const c of candidates) {
    const s = c.toString("utf8");
    if (!s.startsWith("<?xml") && !s.startsWith("<Extension")) continue;
    const m = /<encryptLen>(\d+)<\/encryptLen>/i.exec(s);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let pcap = "";
  let streamFilter: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--stream") streamFilter = Number(argv[++i]);
    else if (!pcap) pcap = a;
  }
  if (!pcap) {
    process.stderr.write(
      "usage: validate-detection-decoder.ts [--stream N] <pcap>\n",
    );
    process.exit(1);
  }
  return { pcap, ...(streamFilter !== undefined ? { streamFilter } : {}) };
}

function loadPasswordsFromEnv(): string[] {
  const envPath = pathResolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return [];
  const raw = readFileSync(envPath, "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const m = /^([A-Z0-9_]*PASSWORD)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[2]!.replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
