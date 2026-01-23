#!/usr/bin/env node
/**
 * Offline replay runner.
 *
 * Replays `bcmedia_chunk_*.bin` dumps through the same BaichuanVideoStream pipeline
 * (including replay cmdId=5 heuristics) without contacting the device.
 *
 * Inputs (env):
 * - DUMP_DIR: directory containing bcmedia_chunk_*.bin + replay_start_ack_msgNum_*.json + replay_keys.json
 *             default: test/artifacts/replay-ext-debug
 * - OUT_BASE: output base path (without extension)
 *             default: test/artifacts/replay-offline/<timestamp>
 * - REPLAY_H264_FORCE_MODE: same as online runner (optional)
 */

import { BaichuanVideoStream } from "./dist/index.js";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function pickStartAckJson(dumpDir) {
  const files = readdirSync(dumpDir).filter((f) => f.startsWith("replay_start_ack_msgNum_") && f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort();
  return join(dumpDir, files[files.length - 1]);
}

const dumpDir = (process.env.DUMP_DIR ?? "test/artifacts/replay-ext-debug").trim();
const outBase = (process.env.OUT_BASE ?? `test/artifacts/replay-offline/${nowStamp()}`).trim();

mkdirSync(dirname(outBase), { recursive: true });

// Load replay keys/session material if present (used by replay decrypt heuristics)
let sessionKey16 = null;
try {
  const keys = readJson(join(dumpDir, "replay_keys.json"));
  if (keys?.sessionKeyHex) {
    sessionKey16 = Buffer.from(String(keys.sessionKeyHex), "hex");
  }
} catch {
  // ignore
}

// Load start-ack tail32 (ack_a/ack_b) if present
let ackTail32 = null;
try {
  const startAckPath = pickStartAckJson(dumpDir);
  if (startAckPath) {
    const ack = readJson(startAckPath);
    if (ack?.bodyTailHex) {
      ackTail32 = Buffer.from(String(ack.bodyTailHex), "hex");
    }
  }
} catch {
  // ignore
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.enc = {
      kind: "none",
      // BaichuanVideoStream.tryGetSessionKey16() reads `client.enc.key`.
      ...(sessionKey16 && sessionKey16.length === 16 ? { key: sessionKey16 } : {}),
    };
  }

  getDebugConfig() {
    return {
      general: false,
      debugRtsp: false,
      traceNativeStream: false,
      dumpEnabled: false,
      dumpDir: "",
      dumpBcMedia: false,
      dumpNals: false,
    };
  }

  getTransport() {
    return "tcp";
  }

  // Only used when enc.kind is aes/full_aes/bc; we keep kind=none.
  tryDecryptBinary(buf) {
    return buf;
  }
}

async function main() {
  const forceMode = (process.env.REPLAY_H264_FORCE_MODE ?? "").trim();
  if (forceMode) {
    console.log("REPLAY_H264_FORCE_MODE:", forceMode);
  }
  console.log("Using dumpDir:", dumpDir);

  const chunkFiles = readdirSync(dumpDir)
    .filter((f) => /^bcmedia_chunk_\d{4}\.bin$/.test(f))
    .sort();

  if (chunkFiles.length === 0) {
    throw new Error(`No bcmedia_chunk_*.bin found in ${dumpDir}`);
  }

  const client = new FakeClient();
  const stream = new BaichuanVideoStream({
    client,
    api: undefined,
    channel: 0,
    profile: "main",
    variant: "default",
    cmdId: 5,
    acceptAnyStreamType: true,
  });

  if (ackTail32 && ackTail32.length >= 32) {
    stream.setReplayStartAckTail32(ackTail32);
  }

  const aus = [];
  let totalBytes = 0;
  let keyframes = 0;
  let firstVideoType = null;
  let minUs = null;
  let maxUs = null;

  stream.on("videoAccessUnit", ({ data, isKeyframe, videoType, microseconds }) => {
    if (!firstVideoType) firstVideoType = videoType;
    aus.push({ data, microseconds: microseconds ?? null });
    totalBytes += data.length;
    if (typeof microseconds === "number") {
      if (minUs == null || microseconds < minUs) minUs = microseconds;
      if (maxUs == null || microseconds > maxUs) maxUs = microseconds;
    }
    if (isKeyframe) keyframes++;
  });

  await stream.start();

  const msgNum = 11;
  const channelId = 1;
  const streamType = 0;

  for (let i = 0; i < chunkFiles.length; i++) {
    const p = join(dumpDir, chunkFiles[i]);
    const payload = readFileSync(p);

    const frame = {
      header: {
        magic: Buffer.alloc(4),
        cmdId: 5,
        bodyLen: payload.length,
        channelId,
        streamType,
        msgNum,
        responseCode: 0,
        messageClass: 0,
      },
      body: payload,
      extension: Buffer.alloc(0),
      payload,
      messageKey: 0,
      raw: payload,
    };

    client.emit("push", frame);
  }

  await stream.stop();

  console.log(`Decoded: ${aus.length} AUs, keyframes=${keyframes}, bytes=${totalBytes}`);

  if (aus.length === 0) {
    throw new Error("No videoAccessUnit emitted from dump");
  }

  // Write Annex-B output.
  const vt = String(firstVideoType || "H264").toUpperCase();
  const demux = vt.includes("265") ? "hevc" : "h264";
  const ext = demux === "hevc" ? ".h265" : ".h264";
  const outAnnex = `${outBase}${ext}`;

  // Help ffmpeg understand AU boundaries: insert AUD between AUs (H.264 only).
  const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);
  const wantAud = demux === "h264";

  const allData = Buffer.concat(
    aus.flatMap((c) => {
      if (!c?.data) return [];
      return wantAud ? [H264_AUD, c.data] : [c.data];
    }),
  );

  writeFileSync(outAnnex, allData);
  console.log(`Wrote ${allData.length} bytes to ${outAnnex}`);

  // Derive fps from microseconds when possible.
  let derivedFps = null;
  if (minUs != null && maxUs != null && maxUs > minUs && aus.length > 1) {
    const spanSec = (maxUs - minUs) / 1_000_000;
    derivedFps = (aus.length - 1) / spanSec;
    console.log(`mediaSpan=${spanSec.toFixed(3)}s fps~${derivedFps.toFixed(3)}`);
  }

  // Convert to MP4.
  const mp4Path = `${outBase}.mp4`;
  try {
    const inputFps = derivedFps && Number.isFinite(derivedFps) && derivedFps > 0 ? derivedFps : 25;
    const inputFpsStr = Number.isFinite(inputFps) ? inputFps.toFixed(3) : "25";
    const out = execSync(
      `ffmpeg -y -loglevel warning -fflags +genpts -r ${inputFpsStr} -f ${demux} -i "${outAnnex}" -c copy "${mp4Path}" 2>&1`,
      { encoding: "utf8" },
    );
    console.log(`Wrote ${mp4Path}`);
    console.log(out.split("\n").slice(-8).join("\n"));
  } catch (e) {
    console.log("ffmpeg conversion failed:", e?.message ?? String(e));
  }

  // Probe.
  try {
    const probe = execSync(`ffprobe -hide_banner "${mp4Path}" 2>&1`, { encoding: "utf8" });
    console.log("\nffprobe output:");
    console.log(probe);
  } catch (e) {
    console.log("ffprobe failed:", e?.message ?? String(e));
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.stack || err?.message || String(err));
  process.exit(1);
});
