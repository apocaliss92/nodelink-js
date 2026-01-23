#!/usr/bin/env node
/**
 * Quick replay test to validate the extension-based crypto key extraction.
 */
import { ReolinkBaichuanApi } from "./dist/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import "dotenv/config";

const host = process.env.TCP_HOST;
const username = process.env.TCP_USERNAME;
const password = process.env.TCP_PASSWORD;

if (!host || !password) {
  console.error("Missing TCP_HOST or TCP_PASSWORD in .env");
  process.exit(1);
}

const api = new ReolinkBaichuanApi({
  host,
  username,
  password,
  transport: "tcp",
  debug: true,
  debugOptions: {
    general: true,
    traceNativeStream: true,
    dump: {
      enabled: true,
      dir: "test/artifacts/replay-ext-debug",
      bcmedia: true,
      nals: true,
    },
  },
});

async function main() {
  try {
    await api.login();
    console.log("Login OK");

    // Prefer an explicit file identifier/path, otherwise auto-pick a recent recording.
    // Format: 01YYYYMMDDHHMMSS for ID-based lookup or /mnt/... for path-based.
    let replayFile = (process.env.REPLAY_FILE ?? "").trim();
    if (!replayFile) {
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      console.log("REPLAY_FILE not set; trying to auto-pick latest recording...");
      const recs = await api.listDeviceRecordings({
        channel: 0,
        start,
        end,
        streamType: "mainStream",
        count: 50,
        timeoutMs: 5000,
      });
      const last = recs.at(-1);
      if (!last?.fileName) {
        throw new Error(
          "Could not auto-pick a recording (no recs). Set REPLAY_FILE to a valid /mnt/...mp4 path or 01YYYYMMDDHHMMSS id.",
        );
      }
      replayFile = last.fileName;
    }

    // cmdId=5 replay often expects a VOD identifier like /mnt/...mp4 (not a relative Mp4Record/... path).
    if (replayFile && !replayFile.startsWith("/")) {
      try {
        console.log("Trying to resolve to a /mnt/... recording via FileInfoList...");
        const uid = (process.env.REPLAY_UID ?? process.env.TCP_UID ?? "").trim() || undefined;
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        const vod = await api.listRecordings({
          channel: 0,
          ...(uid ? { uid } : {}),
          start,
          end,
          streamType: "mainStream",
        });
        const candidates = vod
          .map((r) => String(r?.id || r?.fileName || "").trim())
          .filter((s) => s.includes("/"));
        const mapped = candidates.at(-1);
        if (mapped) {
          console.log("Mapped to:", mapped);
          replayFile = mapped;
        } else {
          const guess = `/mnt/sda/${replayFile.replace(/^\/+/, "")}`;
          console.log("Could not map via FileInfoList; trying guess:", guess);
          replayFile = guess;
        }
      } catch (e) {
        const guess = `/mnt/sda/${replayFile.replace(/^\/+/, "")}`;
        console.log("FileInfoList mapping failed; trying guess:", guess);
        replayFile = guess;
      }
    }

    console.log("Using file:", replayFile);
    
    const outBase = "test/artifacts/replay-ext-fix-test";
    mkdirSync(dirname(outBase), { recursive: true });
    
    let totalBytes = 0;
    let videoAUs = 0;
    let keyframes = 0;
    let firstVideoType = null;
    const chunks = [];
    let firstUs = null;
    let lastUs = null;
    let minUs = null;
    let maxUs = null;

    console.log("\nStarting replay stream...");
    const { stream, stop } = await api.startRecordingReplayStream({
      channel: 0,
      fileName: replayFile,
      streamType: "mainStream",
    });

    stream.on("videoAccessUnit", ({ data, isKeyframe, videoType, microseconds }) => {
      videoAUs++;
      totalBytes += data.length;
      chunks.push({ data, videoType, microseconds: microseconds ?? null });
      if (!firstVideoType) firstVideoType = videoType;

      if (typeof microseconds === "number") {
        if (firstUs == null) firstUs = microseconds;
        lastUs = microseconds;
        if (minUs == null || microseconds < minUs) minUs = microseconds;
        if (maxUs == null || microseconds > maxUs) maxUs = microseconds;
      }
      if (isKeyframe) {
        keyframes++;
        if (keyframes <= 3 || keyframes % 10 === 0) {
          console.log(`[AU] Keyframe #${keyframes}, type=${videoType}, ${data.length} bytes, total: ${totalBytes}`);
        }
      }
    });

    stream.on("error", (err) => {
      console.error("Stream error:", err.message);
    });

    // Stop after 15 seconds
    console.log("Capturing for 15 seconds...");
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    let derivedFps = null;
    if (minUs != null && maxUs != null && maxUs > minUs && videoAUs > 1) {
      const spanSec = (maxUs - minUs) / 1_000_000;
      derivedFps = (videoAUs - 1) / spanSec;
      console.log(
        `\nStopping: ${videoAUs} AUs, ${keyframes} keyframes, ${totalBytes} bytes (mediaSpan=${spanSec.toFixed(3)}s, fps~${derivedFps.toFixed(3)}, firstUs=${firstUs}, lastUs=${lastUs})`,
      );
    } else {
      console.log(`\nStopping: ${videoAUs} AUs, ${keyframes} keyframes, ${totalBytes} bytes`);
    }
    await stop();
    
    // Write output
    if (chunks.length > 0) {
      // Help ffmpeg understand Access Unit boundaries: insert an AUD between AUs (H.264 only).
      // This avoids the h264 demuxer treating individual NALs as separate frames, which breaks duration.
      const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);
      const wantAud = String(firstVideoType || "").toUpperCase().includes("264");

      const allData = Buffer.concat(
        chunks.flatMap((c) => {
          if (!c?.data) return [];
          return wantAud ? [H264_AUD, c.data] : [c.data];
        }),
      );

      const vt = String(firstVideoType || "").toUpperCase();
      const demux = vt.includes("265") ? "hevc" : "h264";
      const ext = demux === "hevc" ? ".h265" : ".h264";
      const outPath = `${outBase}${ext}`;

      writeFileSync(outPath, allData);
      console.log(`Wrote ${allData.length} bytes to ${outPath}`);

      // Try to convert to MP4
      console.log("Converting to MP4...");
      const mp4Path = `${outBase}.mp4`;
      const { execSync } = await import("node:child_process");
      try {
        const inputFps = derivedFps && Number.isFinite(derivedFps) && derivedFps > 0 ? derivedFps : 25;
        const inputFpsStr = Number.isFinite(inputFps) ? inputFps.toFixed(3) : "25";
        const out = execSync(
          `ffmpeg -y -loglevel warning -fflags +genpts -r ${inputFpsStr} -f ${demux} -i "${outPath}" -c copy "${mp4Path}" 2>&1`,
          { encoding: "utf8" },
        );
        console.log(`Wrote ${mp4Path}`);
        console.log(out.split("\n").slice(-5).join("\n"));
      } catch (e) {
        console.log("ffmpeg conversion failed:", e.message);
      }
      
      // Probe output
      try {
        const probe = execSync(`ffprobe -hide_banner "${mp4Path}" 2>&1`, { encoding: "utf8" });
        console.log("\nffprobe output:");
        console.log(probe);
      } catch {
        console.log("ffprobe not available");
      }
    } else {
      console.log("No video data captured!");
    }
    
  } finally {
    await api.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
