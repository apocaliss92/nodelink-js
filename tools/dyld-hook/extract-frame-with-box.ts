#!/usr/bin/env tsx
/**
 * Find an I-frame whose additionalHeader contains a `04 0a 00` box TLV,
 * decode the H.264/H.265 bitstream to a PNG, then draw the decoded box on
 * top using ffmpeg's drawbox filter. Output: /tmp/aimark-validation.png.
 *
 * This is a visual sanity check that our `decodeDetectionHeader` parser
 * produces coordinates that line up with the actual video pixels.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { spawnSync } from "node:child_process";
import { extractBaichuanPayloads } from "../pcap/tshark";
import { analyzePcap } from "../pcap/decrypt";
import { BC_CMD_ID_VIDEO } from "../../src/protocol/constants";
import {
  aesDecrypt,
  bcDecrypt,
  type EncryptionProtocol,
} from "../../src/protocol/crypto";
import { BcMediaCodec } from "../../src/baichuan/stream/BcMediaCodec";
import { convertToAnnexB, hasStartCodes } from "../../src/baichuan/stream/H264Converter";
import { convertToAnnexB as convertH265ToAnnexB } from "../../src/baichuan/stream/H265Converter";
import type { BaichuanFrame } from "../../src/protocol/framing";
import { decodeDetectionHeader } from "../../src/reolink/baichuan/utils/detection";

async function main(): Promise<void> {
  const pcap = process.argv[2];
  if (!pcap) {
    process.stderr.write("usage: extract-frame-with-box.ts <pcap>\n");
    process.exit(1);
  }
  const outDir = "/tmp/aimark-validation";
  mkdirSync(outDir, { recursive: true });

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

  // Walk frames in capture order. Track the most recently seen SPS/PPS NAL
  // payloads (raw, without Annex-B start codes). When we hit an I-frame whose
  // additionalHeader carries a decoded box, glue SPS+PPS+I-frame together so
  // ffmpeg has the parameter sets it needs to decode the picture.
  let bestSample: {
    type: "Iframe" | "Pframe";
    data: Buffer;
    videoType: "H264" | "H265";
    additionalHeader: Buffer;
    streamId: number;
    sps: Buffer | null;
    pps: Buffer | null;
    vps: Buffer | null;
  } | null = null;

  // Scan a frame's data for Annex-B NAL units and return all of them.
  // Used to capture SPS/PPS from any frame that carries them.
  function scanNals(data: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let i = 0;
    while (i < data.length - 3) {
      // Find 0x00 0x00 0x00 0x01 or 0x00 0x00 0x01 start code
      let scLen = 0;
      if (
        data[i] === 0 &&
        data[i + 1] === 0 &&
        data[i + 2] === 0 &&
        data[i + 3] === 1
      ) {
        scLen = 4;
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        scLen = 3;
      } else {
        i++;
        continue;
      }
      // Find next start code
      let next = data.length;
      for (let j = i + scLen + 1; j < data.length - 2; j++) {
        if (
          data[j] === 0 &&
          data[j + 1] === 0 &&
          (data[j + 2] === 1 || (data[j + 2] === 0 && data[j + 3] === 1))
        ) {
          next = j;
          break;
        }
      }
      out.push(data.subarray(i + scLen, next));
      i = next;
    }
    return out;
  }

  for (const [streamId, list] of buckets) {
    const enc = sessions.get(streamId);
    if (!enc) continue;
    const codec = new BcMediaCodec(false);
    const encP: EncryptionProtocol =
      enc.kind === "none" || enc.kind === "bc"
        ? { kind: enc.kind }
        : { kind: enc.kind, key: enc.key };

    let lastSps: Buffer | null = null;
    let lastPps: Buffer | null = null;
    let lastVps: Buffer | null = null;

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
        if (p.type !== "Iframe") continue;

        // Walk NALs to capture SPS / PPS / VPS as they appear.
        for (const nal of scanNals(p.data)) {
          if (nal.length === 0) continue;
          if (p.videoType === "H264") {
            const nt = nal[0]! & 0x1f;
            if (nt === 7) lastSps = nal;     // SPS
            else if (nt === 8) lastPps = nal; // PPS
          } else {
            const nt = (nal[0]! >> 1) & 0x3f;
            if (nt === 32) lastVps = nal;     // H.265 VPS
            else if (nt === 33) lastSps = nal;
            else if (nt === 34) lastPps = nal;
          }
        }

        if (!p.additionalHeader) continue;
        const decoded = decodeDetectionHeader(p.additionalHeader, "Iframe");
        if (decoded.boxes.length === 0) continue;

        bestSample = {
          type: "Iframe",
          data: p.data,
          videoType: p.videoType,
          additionalHeader: p.additionalHeader,
          streamId,
          sps: lastSps,
          pps: lastPps,
          vps: lastVps,
        };
        break;
      }
      if (bestSample) break;
    }
    if (bestSample) break;
  }

  if (!bestSample) {
    process.stderr.write("No I-frame with decoded box found.\n");
    process.exit(1);
  }

  const decoded = decodeDetectionHeader(
    bestSample.additionalHeader,
    "Iframe",
  );
  process.stdout.write(
    `\nFound I-frame in stream=${bestSample.streamId}, codec=${bestSample.videoType}\n`,
  );
  process.stdout.write(`  data size: ${bestSample.data.length} bytes\n`);
  process.stdout.write(
    `  AI frame: ${decoded.aiFrameWidth ?? "?"}x${decoded.aiFrameHeight ?? "?"}\n`,
  );
  process.stdout.write(
    `  boxes: ${JSON.stringify(decoded.boxes, null, 2)}\n`,
  );

  // Convert AVCC (length-prefixed NAL) to Annex-B if needed. The library's
  // converter handles both formats and adds start codes where missing.
  const annexB = hasStartCodes(bestSample.data)
    ? bestSample.data
    : bestSample.videoType === "H265"
      ? convertH265ToAnnexB(bestSample.data)
      : convertToAnnexB(bestSample.data);

  const h264Path = `${outDir}/frame.h264`;
  writeFileSync(h264Path, annexB);
  process.stdout.write(
    `  raw=${bestSample.data.length}B annexB=${annexB.length}B (had_start_codes=${hasStartCodes(bestSample.data)})\n`,
  );

  // Use ffmpeg to decode the single I-frame into PNG.
  const rawPng = `${outDir}/raw.png`;
  const ff1 = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "warning",
      "-f",
      bestSample.videoType === "H265" ? "hevc" : "h264",
      "-i",
      h264Path,
      "-vframes",
      "1",
      rawPng,
    ],
    { encoding: "utf8" },
  );
  if (ff1.status !== 0) {
    process.stderr.write(`ffmpeg decode failed:\n${ff1.stderr}\n`);
    process.exit(1);
  }
  process.stdout.write(`  raw PNG: ${rawPng}\n`);

  // For each decoded box, drawbox using ffmpeg. The box is in [0,1] coords
  // relative to the AI frame; the video frame may be a different resolution,
  // but the coordinate space is the SAME fractional space (Reolink renders
  // overlays in fractional space too). So we can use normalized coords.
  const filters = decoded.boxes
    .map((b, i) => {
      const x = Math.round(b.x * 10000) / 100; // percent
      const y = Math.round(b.y * 10000) / 100;
      const w = Math.round(b.width * 10000) / 100;
      const h = Math.round(b.height * 10000) / 100;
      const label = b.confidence
        ? `conf=${Math.round(b.confidence * 100)}%`
        : `#${i}`;
      // drawbox uses iw/ih; drawtext expressions use uppercase W/H for canvas.
      return `drawbox=x=iw*${b.x.toFixed(4)}:y=ih*${b.y.toFixed(4)}:w=iw*${b.width.toFixed(4)}:h=ih*${b.height.toFixed(4)}:color=yellow:thickness=4,drawtext=text='${label}':x=W*${b.x.toFixed(4)}+6:y=H*${b.y.toFixed(4)}+6:fontcolor=yellow:fontsize=24:box=1:boxcolor=black@0.6:borderw=2:bordercolor=black`;
    })
    .join(",");

  const outPng = "/tmp/aimark-validation.png";
  const ff2 = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "warning", "-i", rawPng, "-vf", filters, outPng],
    { encoding: "utf8" },
  );
  if (ff2.status !== 0) {
    process.stderr.write(`ffmpeg drawbox failed:\n${ff2.stderr}\n`);
    process.exit(1);
  }
  process.stdout.write(`\nFINAL OUTPUT: ${outPng}\n`);
  process.stdout.write(`Open with: open ${outPng}\n`);
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
  } catch { /* ignore */ }
  try {
    candidates.push(bcDecrypt(extension, channelId));
  } catch { /* ignore */ }
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
