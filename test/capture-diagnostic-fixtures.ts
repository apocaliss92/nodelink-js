/**
 * Capture H.265 stream fixtures for diagnostic pipeline tests.
 * Run with: npx tsx test/capture-diagnostic-fixtures.ts
 *
 * Reads camera connection from .env:
 *   TCP265_HOST      — camera IP or hostname
 *   TCP265_USERNAME  — camera username (default: admin)
 *   TCP265_PASSWORD  — camera password
 *
 * For each profile (main, sub, ext) captures 60 seconds and saves:
 *   {profile}-stream.h265    — raw Annex-B video bytes
 *   {profile}-frames.json    — frame metadata array
 *   {profile}-summary.json   — capture stats
 *
 * Also saves device-info.json.
 * Output directory: test/fixtures/diagnostics/
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanVideoStream } from "../src/baichuan/stream/BaichuanVideoStream";
import { convertToAnnexB as convertH264ToAnnexB } from "../src/baichuan/stream/H264Converter";
import { convertToAnnexB as convertH265ToAnnexB } from "../src/baichuan/stream/H265Converter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "diagnostics");
const STREAM_CAPTURE_MS = 60_000; // 60 seconds per profile

const CAMERA_HOST = process.env["TCP265_HOST"];
const CAMERA_USER = process.env["TCP265_USERNAME"] ?? "admin";
const CAMERA_PASS = process.env["TCP265_PASSWORD"];
const CAMERA_PORT = 9000;

if (!CAMERA_HOST) {
  console.error("Error: TCP265_HOST is not set in .env");
  process.exit(1);
}
if (!CAMERA_PASS) {
  console.error("Error: TCP265_PASSWORD is not set in .env");
  process.exit(1);
}

interface FrameMeta {
  audio: boolean;
  videoType?: string;
  isKeyframe?: boolean;
  dataLength: number;
  microseconds?: number;
}

interface ProfileSummary {
  profile: string;
  captureMs: number;
  totalFrames: number;
  videoFrames: number;
  audioFrames: number;
  keyframes: number;
  h265Bytes: number;
  codec: string | null;
  error?: string;
}

async function captureProfile(
  api: ReolinkBaichuanApi,
  profile: "main" | "sub" | "ext",
): Promise<ProfileSummary> {
  console.log(`\nCapturing ${profile} stream (${STREAM_CAPTURE_MS / 1000}s)...`);

  const frames: FrameMeta[] = [];
  const h265Chunks: Buffer[] = [];
  let codec: string | null = null;
  const startMs = Date.now();

  try {
    const videoStream = new BaichuanVideoStream({
      client: api.client,
      api,
      channel: 0,
      profile,
      logger: console,
    });

    let stopped = false;

    videoStream.on("videoAccessUnit", (unit: any) => {
      if (stopped) return;

      if (!codec && unit.videoType) {
        codec = unit.videoType as string;
      }

      frames.push({
        audio: false,
        videoType: unit.videoType as string | undefined,
        isKeyframe: unit.isKeyframe as boolean | undefined,
        dataLength: (unit.data as Buffer).length,
        microseconds: unit.microseconds as number | undefined,
      });

      // Convert to Annex-B and accumulate raw bitstream
      try {
        const raw = unit.data as Buffer;
        let annexB: Buffer | null = null;
        if (unit.videoType === "H265" || unit.videoType === "h265") {
          annexB = convertH265ToAnnexB(raw);
        } else {
          annexB = convertH264ToAnnexB(raw);
        }
        if (annexB) {
          h265Chunks.push(annexB);
        }
      } catch {
        // Conversion failure — skip frame but keep metadata
      }
    });

    videoStream.on("audioFrame", (frame: Buffer) => {
      if (stopped) return;
      frames.push({
        audio: true,
        dataLength: frame.length,
      });
    });

    await videoStream.start();
    await new Promise((r) => setTimeout(r, STREAM_CAPTURE_MS));
    stopped = true;
    await videoStream.stop();
  } catch (err) {
    console.error(`  ${profile} stream error: ${err}`);
    const summary: ProfileSummary = {
      profile,
      captureMs: Date.now() - startMs,
      totalFrames: frames.length,
      videoFrames: frames.filter((f) => !f.audio).length,
      audioFrames: frames.filter((f) => f.audio).length,
      keyframes: frames.filter((f) => f.isKeyframe).length,
      h265Bytes: 0,
      codec,
      error: String(err),
    };
    return summary;
  }

  // Write raw Annex-B bitstream
  const ext = codec?.toLowerCase() === "h264" ? "h264" : "h265";
  const streamPath = path.join(FIXTURES_DIR, `${profile}-stream.${ext}`);
  if (h265Chunks.length > 0) {
    const combined = Buffer.concat(h265Chunks);
    fs.writeFileSync(streamPath, combined);
    console.log(`  Wrote ${combined.length} bytes → ${path.basename(streamPath)}`);
  }

  // Write frame metadata
  fs.writeFileSync(
    path.join(FIXTURES_DIR, `${profile}-frames.json`),
    JSON.stringify(frames, null, 2),
  );

  const summary: ProfileSummary = {
    profile,
    captureMs: Date.now() - startMs,
    totalFrames: frames.length,
    videoFrames: frames.filter((f) => !f.audio).length,
    audioFrames: frames.filter((f) => f.audio).length,
    keyframes: frames.filter((f) => f.isKeyframe).length,
    h265Bytes: h265Chunks.reduce((s, c) => s + c.length, 0),
    codec,
  };

  // Write summary
  fs.writeFileSync(
    path.join(FIXTURES_DIR, `${profile}-summary.json`),
    JSON.stringify(summary, null, 2),
  );

  console.log(
    `  Done: ${summary.videoFrames} video frames, ${summary.audioFrames} audio, ` +
      `${summary.keyframes} keyframes, codec=${codec ?? "unknown"}`,
  );

  return summary;
}

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  console.log(`Connecting to ${CAMERA_HOST}:${CAMERA_PORT}...`);

  const api = new ReolinkBaichuanApi({
    host: CAMERA_HOST!,
    port: CAMERA_PORT,
    username: CAMERA_USER,
    password: CAMERA_PASS!,
  });

  await api.login();
  console.log("Logged in.");

  // Device info
  const info = await api.getInfo();
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "device-info.json"),
    JSON.stringify(info, null, 2),
  );
  console.log(`Device: ${info?.type ?? "unknown"}, FW: ${info?.firmwareVersion ?? "unknown"}`);

  const summaries: ProfileSummary[] = [];

  for (const profile of ["main", "sub", "ext"] as const) {
    const summary = await captureProfile(api, profile);
    summaries.push(summary);
  }

  await api.close();

  // Write overall capture summary
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "capture-summary.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        host: CAMERA_HOST,
        profiles: summaries,
      },
      null,
      2,
    ),
  );

  console.log("\nDone! Fixtures saved to test/fixtures/diagnostics/");
  console.log("Profile results:");
  for (const s of summaries) {
    const status = s.error ? `ERROR: ${s.error}` : `${s.videoFrames} video / ${s.audioFrames} audio`;
    console.log(`  ${s.profile}: ${status}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
