#!/usr/bin/env tsx
/**
 * Emit a per-frame timeline of BcMedia I/P-frame additionalHeader sizes,
 * so we can correlate size variations with the camera's motion activity.
 *
 * Hypothesis under test: the additionalHeader carries Reolink "Motion Mark"
 * bounding boxes. If true, frames with no detected object would share the
 * same baseline size (e.g. 128 bytes), and the size would step up by a fixed
 * stride (e.g. 8 or 24 bytes) for each additional box.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { extractBaichuanPayloads } from "./tshark";
import { analyzePcap } from "./decrypt";
import { BC_CMD_ID_VIDEO } from "../../src/protocol/constants";
import { aesDecrypt, bcDecrypt, type EncryptionProtocol } from "../../src/protocol/crypto";
import { BcMediaCodec } from "../../src/baichuan/stream/BcMediaCodec";
import type { BaichuanFrame } from "../../src/protocol/framing";

async function main(): Promise<void> {
  const pcapPath = process.argv[2];
  const streamFilter = process.argv[3] ? Number(process.argv[3]) : undefined;
  if (!pcapPath) {
    process.stderr.write("usage: iframe-header-timeline.ts <pcap> [streamId]\n");
    process.exit(1);
  }
  const payloads = await extractBaichuanPayloads(pcapPath);
  const passwords = loadPasswordsFromEnv();
  const { frames, sessions } = analyzePcap(payloads, { passwords });

  const buckets = new Map<string, { afFrame: BaichuanFrame; t: number; n: number }[]>();
  for (const af of frames) {
    if (af.frame.header.cmdId !== BC_CMD_ID_VIDEO) continue;
    if (af.frame.payload.length === 0) continue;
    if (streamFilter !== undefined && af.pcap.streamId !== streamFilter) continue;
    const key = `${af.pcap.streamId}:${af.pcap.direction}`;
    const list = buckets.get(key);
    if (list) list.push({ afFrame: af.frame, t: af.pcap.timestamp, n: af.pcap.frameNumber });
    else buckets.set(key, [{ afFrame: af.frame, t: af.pcap.timestamp, n: af.pcap.frameNumber }]);
  }

  for (const [key, list] of buckets) {
    const streamId = Number(key.split(":")[0]);
    const enc = sessions.get(streamId);
    if (!enc) continue;
    const encP: EncryptionProtocol =
      enc.kind === "none" || enc.kind === "bc" ? { kind: enc.kind } : { kind: enc.kind, key: enc.key };
    const codec = new BcMediaCodec(false);

    process.stdout.write(`\n=== stream ${key} (enc=${enc.kind}) ===\n`);
    process.stdout.write(`frame#    Δms   type    extraSize  blocks  hex[8..16]\n`);

    let last: number | undefined;
    for (const { afFrame, t, n } of list) {
      const encryptLen = parseEncryptLen(afFrame.extension, afFrame.header.channelId, encP);
      let dec: Buffer;
      if (encryptLen !== undefined && encryptLen > 0 && encryptLen < afFrame.payload.length) {
        const encPart = afFrame.payload.subarray(0, encryptLen);
        const clearPart = afFrame.payload.subarray(encryptLen);
        dec = Buffer.concat([decryptOneShot(encPart, afFrame.header.channelId, encP), clearPart]);
      } else {
        dec = decryptOneShot(afFrame.payload, afFrame.header.channelId, encP);
      }
      const packets = codec.decode(dec);
      for (const p of packets) {
        if (p.type !== "Iframe" && p.type !== "Pframe") continue;
        const size = p.additionalHeader?.length ?? 0;
        if (size === 0) continue;
        const extra = size - 128;
        const blocks = extra / 8;
        const hex8 = (p.additionalHeader ?? Buffer.alloc(0))
          .subarray(8, 24)
          .toString("hex")
          .match(/../g)!
          .join(" ");
        const tMs = t * 1000;
        const delta = last !== undefined ? Math.round(tMs - last) : 0;
        last = tMs;
        process.stdout.write(
          `${String(n).padStart(6)}  ${String(delta).padStart(5)}  ${p.type.padEnd(6)}  ${String(extra).padStart(8)}  ${String(blocks).padStart(5)}  ${hex8}\n`,
        );
      }
    }
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

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
