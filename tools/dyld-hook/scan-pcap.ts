#!/usr/bin/env tsx
/**
 * Scan our pcap's additionalHeader bytes for the `04 0a 00` box-TLV signature
 * we discovered from the live SDK hook.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { extractBaichuanPayloads } from "../pcap/tshark";
import { analyzePcap } from "../pcap/decrypt";
import { BC_CMD_ID_VIDEO } from "../../src/protocol/constants";
import {
  aesDecrypt,
  bcDecrypt,
  type EncryptionProtocol,
} from "../../src/protocol/crypto";
import { BcMediaCodec } from "../../src/baichuan/stream/BcMediaCodec";
import type { BaichuanFrame } from "../../src/protocol/framing";

const BOX_TLV_PREFIX = Buffer.from([0x04, 0x0a, 0x00]);

function findBoxTlvs(raw: Buffer): Array<{
  offset: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number;
}> {
  const out: Array<{ offset: number; x1: number; y1: number; x2: number; y2: number; conf: number }> = [];
  for (let i = 0; i + 13 <= raw.length; i++) {
    if (raw[i] === 0x04 && raw[i + 1] === 0x0a && raw[i + 2] === 0x00) {
      out.push({
        offset: i,
        x1: raw.readUInt16LE(i + 3),
        y1: raw.readUInt16LE(i + 5),
        x2: raw.readUInt16LE(i + 7),
        y2: raw.readUInt16LE(i + 9),
        conf: raw.readUInt16LE(i + 11),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const pcap = process.argv[2];
  if (!pcap) {
    process.stderr.write("usage: scan-pcap.ts <pcap>\n");
    process.exit(1);
  }
  const payloads = await extractBaichuanPayloads(pcap);
  const { frames, sessions } = analyzePcap(payloads, {
    passwords: loadPasswordsFromEnv(),
  });

  const buckets = new Map<number, BaichuanFrame[]>();
  for (const af of frames) {
    if (af.frame.header.cmdId !== BC_CMD_ID_VIDEO) continue;
    if (af.frame.payload.length === 0) continue;
    const list = buckets.get(af.pcap.streamId);
    if (list) list.push(af.frame);
    else buckets.set(af.pcap.streamId, [af.frame]);
  }

  let totalHeaders = 0;
  let headersWithBoxTlv = 0;
  const sizesWithBox = new Map<number, number>();
  const allSizes = new Map<number, number>();
  const sampleBoxes: Array<{ size: number; tlvs: ReturnType<typeof findBoxTlvs> }> = [];

  for (const [streamId, list] of buckets) {
    const enc = sessions.get(streamId);
    if (!enc) continue;
    const codec = new BcMediaCodec(false);
    const encP: EncryptionProtocol =
      enc.kind === "none" || enc.kind === "bc"
        ? { kind: enc.kind }
        : { kind: enc.kind, key: enc.key };
    for (const frame of list) {
      const encryptLen = parseEncryptLen(frame.extension, frame.header.channelId, encP);
      let dec: Buffer;
      if (encryptLen !== undefined && encryptLen > 0 && encryptLen < frame.payload.length) {
        dec = Buffer.concat([
          decryptOneShot(frame.payload.subarray(0, encryptLen), frame.header.channelId, encP),
          frame.payload.subarray(encryptLen),
        ]);
      } else {
        dec = decryptOneShot(frame.payload, frame.header.channelId, encP);
      }
      for (const p of codec.decode(dec)) {
        if (p.type !== "Iframe" && p.type !== "Pframe") continue;
        if (!p.additionalHeader) continue;
        const sz = p.additionalHeader.length;
        totalHeaders++;
        allSizes.set(sz, (allSizes.get(sz) ?? 0) + 1);
        const tlvs = findBoxTlvs(p.additionalHeader);
        if (tlvs.length > 0) {
          headersWithBoxTlv++;
          sizesWithBox.set(sz, (sizesWithBox.get(sz) ?? 0) + 1);
          if (sampleBoxes.length < 10) {
            sampleBoxes.push({ size: sz, tlvs });
          }
        }
      }
    }
  }

  process.stdout.write(`\npcap: ${pcap}\n`);
  process.stdout.write(`Total I/P additionalHeaders: ${totalHeaders}\n`);
  process.stdout.write(`Headers containing 04 0a 00 box-TLV: ${headersWithBoxTlv}\n\n`);

  if (sizesWithBox.size > 0) {
    process.stdout.write("Sizes that had a box-TLV:\n");
    const rows = [...sizesWithBox.entries()].sort((a, b) => b[1] - a[1]);
    for (const [sz, n] of rows) {
      const total = allSizes.get(sz) ?? 0;
      process.stdout.write(`  ${sz} bytes: ${n}/${total} (${((n / total) * 100).toFixed(1)}%)\n`);
    }
  }

  process.stdout.write("\nFirst 10 box-TLV samples:\n");
  for (const s of sampleBoxes) {
    process.stdout.write(`  size=${s.size}B  boxes=[`);
    process.stdout.write(s.tlvs.map(t => `(x1=${t.x1},y1=${t.y1},x2=${t.x2},y2=${t.y2},conf=${t.conf})`).join(" "));
    process.stdout.write(`]\n`);
  }
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
  try { if (enc.kind === "aes" || enc.kind === "full_aes") candidates.push(aesDecrypt(extension, enc.key)); } catch {}
  try { candidates.push(bcDecrypt(extension, channelId)); } catch {}
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
    if (m) out.push(m[2]!.replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
