#!/usr/bin/env tsx
/**
 * Empirical box-decoder explorer.
 *
 * Hypothesis under test:
 *   additionalHeader.length = 128 (baseline) + 8 (overlay header) + N × 8 (boxes)
 *   so 152 = 1 box,  160 = 2 boxes,  168 = 3 boxes,  176 = 4 boxes, …
 *
 * Each candidate "box" is the 8 bytes after the overlay header. We try a few
 * encodings (uint16_le / uint16_be × xywh / cxcywh × normalize-by-65535) and
 * count, per encoding, how many decoded boxes pass a sanity check
 * (x,y,w,h in [0, 1], x+w ≤ 1.05, y+h ≤ 1.05). Whichever encoding has the
 * highest validation rate is the one we wire into utils/detection.ts.
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

const BASELINE = 128;
const OVERLAY_HEADER = 8;
const BOX_BYTES = 8;

type Box = { x: number; y: number; w: number; h: number };
type Encoder = (b: Buffer, off: number) => Box;

const encoders: Record<string, Encoder> = {
  "u16le-xywh-/65535": (b, o) => ({
    x: b.readUInt16LE(o) / 0xffff,
    y: b.readUInt16LE(o + 2) / 0xffff,
    w: b.readUInt16LE(o + 4) / 0xffff,
    h: b.readUInt16LE(o + 6) / 0xffff,
  }),
  "u16le-xyxy-/65535": (b, o) => {
    const x1 = b.readUInt16LE(o) / 0xffff;
    const y1 = b.readUInt16LE(o + 2) / 0xffff;
    const x2 = b.readUInt16LE(o + 4) / 0xffff;
    const y2 = b.readUInt16LE(o + 6) / 0xffff;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  },
  "u16be-xywh-/65535": (b, o) => ({
    x: b.readUInt16BE(o) / 0xffff,
    y: b.readUInt16BE(o + 2) / 0xffff,
    w: b.readUInt16BE(o + 4) / 0xffff,
    h: b.readUInt16BE(o + 6) / 0xffff,
  }),
  "u16be-xyxy-/65535": (b, o) => {
    const x1 = b.readUInt16BE(o) / 0xffff;
    const y1 = b.readUInt16BE(o + 2) / 0xffff;
    const x2 = b.readUInt16BE(o + 4) / 0xffff;
    const y2 = b.readUInt16BE(o + 6) / 0xffff;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  },
  "u16le-cxcywh-/65535": (b, o) => {
    const cx = b.readUInt16LE(o) / 0xffff;
    const cy = b.readUInt16LE(o + 2) / 0xffff;
    const w = b.readUInt16LE(o + 4) / 0xffff;
    const h = b.readUInt16LE(o + 6) / 0xffff;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  },
  "u16le-xywh-/4096": (b, o) => ({
    x: b.readUInt16LE(o) / 4096,
    y: b.readUInt16LE(o + 2) / 4096,
    w: b.readUInt16LE(o + 4) / 4096,
    h: b.readUInt16LE(o + 6) / 4096,
  }),
  "u16le-xywh-/10000": (b, o) => ({
    x: b.readUInt16LE(o) / 10000,
    y: b.readUInt16LE(o + 2) / 10000,
    w: b.readUInt16LE(o + 4) / 10000,
    h: b.readUInt16LE(o + 6) / 10000,
  }),
  "u8-xywh-/255": (b, o) => ({
    x: b[o]! / 255,
    y: b[o + 1]! / 255,
    w: b[o + 2]! / 255,
    h: b[o + 3]! / 255,
  }),
};

function isValid(box: Box): boolean {
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return false;
  if (!Number.isFinite(box.w) || !Number.isFinite(box.h)) return false;
  if (box.w <= 0 || box.h <= 0) return false;
  if (box.x < 0 || box.x > 1) return false;
  if (box.y < 0 || box.y > 1) return false;
  // Allow tiny rounding slop above 1 — boxes that hug the right/bottom edge.
  if (box.x + box.w > 1.02) return false;
  if (box.y + box.h > 1.02) return false;
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let pcap = "";
  let streamFilter: number | undefined;
  let printSamples = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--stream") streamFilter = Number(argv[++i]);
    else if (a === "--print-samples") printSamples = Number(argv[++i]);
    else if (!pcap) pcap = a;
  }
  if (!pcap) {
    process.stderr.write(
      "usage: decode-boxes-explore.ts [--stream N] [--print-samples N] <pcap>\n",
    );
    process.exit(1);
  }
  const payloads = await extractBaichuanPayloads(pcap);
  const { frames, sessions } = analyzePcap(payloads, {
    passwords: loadPasswordsFromEnv(),
  });

  // Collect all P-frame additional headers >128 bytes (size with overlay).
  const collected: { size: number; raw: Buffer }[] = [];
  const buckets = new Map<number, BaichuanFrame[]>();
  for (const af of frames) {
    if (af.frame.header.cmdId !== BC_CMD_ID_VIDEO) continue;
    if (af.frame.payload.length === 0) continue;
    if (streamFilter !== undefined && af.pcap.streamId !== streamFilter)
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
        dec = Buffer.concat([
          decryptOneShot(
            frame.payload.subarray(0, encryptLen),
            frame.header.channelId,
            encP,
          ),
          frame.payload.subarray(encryptLen),
        ]);
      } else {
        dec = decryptOneShot(frame.payload, frame.header.channelId, encP);
      }
      for (const p of codec.decode(dec)) {
        if (p.type !== "Pframe") continue;
        if (!p.additionalHeader) continue;
        if (p.additionalHeader.length <= BASELINE) continue;
        collected.push({
          size: p.additionalHeader.length,
          raw: p.additionalHeader,
        });
      }
    }
  }
  process.stdout.write(
    `\nCollected ${collected.length} P-frame headers with overlay (size > ${BASELINE}).\n`,
  );

  // Per-encoding validation rate.
  for (const [name, fn] of Object.entries(encoders)) {
    let total = 0;
    let valid = 0;
    for (const { size, raw } of collected) {
      const overlay = raw.subarray(BASELINE);
      const nBoxes = Math.floor((overlay.length - OVERLAY_HEADER) / BOX_BYTES);
      if (nBoxes <= 0) continue;
      for (let i = 0; i < nBoxes; i++) {
        const off = OVERLAY_HEADER + i * BOX_BYTES;
        if (off + BOX_BYTES > overlay.length) break;
        const box = fn(overlay, off);
        total += 1;
        if (isValid(box)) valid += 1;
      }
      void size;
    }
    const pct = total > 0 ? ((valid / total) * 100).toFixed(1) : "n/a";
    process.stdout.write(
      `  ${name.padEnd(24)}  valid ${valid}/${total}  (${pct}%)\n`,
    );
  }

  // Same per-encoding test but treating each 8-byte slice across the ENTIRE
  // post-baseline region as a candidate box (in case overlay header is 0/16
  // bytes instead of 8). Helps confirm the header-size assumption.
  process.stdout.write(
    `\nAlt header-size sweep (encoding=u16le-xywh-/65535):\n`,
  );
  for (const overlayHdr of [0, 8, 16, 24, 32]) {
    let total = 0;
    let valid = 0;
    for (const { raw } of collected) {
      const overlay = raw.subarray(BASELINE);
      if (overlay.length < overlayHdr) continue;
      const usable = overlay.length - overlayHdr;
      const nBoxes = Math.floor(usable / BOX_BYTES);
      for (let i = 0; i < nBoxes; i++) {
        const off = overlayHdr + i * BOX_BYTES;
        const box = encoders["u16le-xywh-/65535"]!(overlay, off);
        total += 1;
        if (isValid(box)) valid += 1;
      }
    }
    const pct = total > 0 ? ((valid / total) * 100).toFixed(1) : "n/a";
    process.stdout.write(
      `  overlayHeader=${String(overlayHdr).padStart(2)}B  valid ${valid}/${total}  (${pct}%)\n`,
    );
  }

  if (printSamples > 0) {
    process.stdout.write(
      `\nFirst ${printSamples} headers, hex of post-baseline bytes:\n`,
    );
    for (let i = 0; i < Math.min(printSamples, collected.length); i++) {
      const c = collected[i]!;
      process.stdout.write(
        `  size=${c.size}  extra=${c.raw.subarray(BASELINE).toString("hex")}\n`,
      );
    }
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
  } catch {/* ignore */}
  try { candidates.push(bcDecrypt(extension, channelId)); } catch {/* ignore */}
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
