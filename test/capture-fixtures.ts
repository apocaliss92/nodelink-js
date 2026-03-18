/**
 * Capture real camera packets for offline replay testing.
 * Run with: npx tsx test/capture-fixtures.ts
 *
 * Captures:
 * - Login handshake (request + response)
 * - Device info (getInfo)
 * - Stream metadata (getStreamMetadata, buildVideoStreamOptions)
 * - A few seconds of native video stream (main, sub, ext)
 *
 * Saves everything as JSON fixtures in test/fixtures/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanVideoStream } from "../src/baichuan/stream/BaichuanVideoStream";

const CAMERA_HOST = "192.168.1.170";
const CAMERA_PORT = 9000;
const CAMERA_USER = "admin";
const CAMERA_PASS = "Ruocco123";
const STREAM_CAPTURE_MS = 5000; // 5 seconds per stream

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const api = new ReolinkBaichuanApi({
    host: CAMERA_HOST,
    port: CAMERA_PORT,
    username: CAMERA_USER,
    password: CAMERA_PASS,
  });

  console.log(`Connecting to ${CAMERA_HOST}:${CAMERA_PORT}...`);
  await api.login();
  console.log("Logged in.");

  // 1. Device info
  console.log("Capturing device info...");
  const info = await api.getInfo();
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "device-info.json"),
    JSON.stringify(info, null, 2),
  );
  console.log(`  Model: ${info?.type}, FW: ${info?.firmwareVersion}`);

  // 2. Channel count
  const channelCount = await api.getChannelCount();
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "channel-count.json"),
    JSON.stringify({ channelCount }),
  );
  console.log(`  Channels: ${channelCount}`);

  // 3. Stream metadata
  console.log("Capturing stream metadata...");
  const metadata = await api.getStreamMetadata(0);
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "stream-metadata.json"),
    JSON.stringify(metadata, null, 2),
  );

  // 4. Build video stream options
  console.log("Capturing video stream options...");
  const streamOpts = await api.buildVideoStreamOptions({ channel: 0 });
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "stream-options.json"),
    JSON.stringify(streamOpts, null, 2),
  );
  for (const s of streamOpts.nativeStreams) {
    console.log(
      `  ${s.profile}: ${s.metadata?.width}x${s.metadata?.height} ${s.metadata?.videoEncType}`,
    );
  }

  // 5. Capabilities (via getSupportInfo)
  console.log("Capturing capabilities...");
  try {
    const caps = await api.getSupportInfo();
    fs.writeFileSync(
      path.join(FIXTURES_DIR, "capabilities.json"),
      JSON.stringify(caps, null, 2),
    );
  } catch (e) {
    console.log(`  Capabilities failed: ${e}`);
  }

  // 6. Capture native video frames for each profile
  for (const profile of ["main", "sub", "ext"] as const) {
    console.log(`Capturing ${profile} stream (${STREAM_CAPTURE_MS / 1000}s)...`);

    const frames: Array<{
      audio: boolean;
      videoType?: string;
      isKeyframe?: boolean;
      dataLength: number;
      dataHead: string; // first 64 bytes hex
      microseconds?: number;
    }> = [];

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
        frames.push({
          audio: false,
          videoType: unit.videoType,
          isKeyframe: unit.isKeyframe,
          dataLength: unit.data.length,
          dataHead: unit.data.subarray(0, 64).toString("hex"),
          microseconds: unit.microseconds,
        });
      });

      videoStream.on("audioFrame", (frame: Buffer) => {
        if (stopped) return;
        frames.push({
          audio: true,
          dataLength: frame.length,
          dataHead: frame.subarray(0, 64).toString("hex"),
        });
      });

      await videoStream.start();

      await new Promise((r) => setTimeout(r, STREAM_CAPTURE_MS));

      stopped = true;
      await videoStream.stop();

      console.log(
        `  Captured ${frames.length} frames (${frames.filter((f) => !f.audio).length} video, ${frames.filter((f) => f.audio).length} audio)`,
      );

      fs.writeFileSync(
        path.join(FIXTURES_DIR, `stream-${profile}-frames.json`),
        JSON.stringify(frames, null, 2),
      );

      // Save first keyframe raw data for converter tests
      const firstKeyframe = frames.find((f) => f.isKeyframe);
      if (firstKeyframe) {
        console.log(
          `  First keyframe: ${firstKeyframe.videoType} ${firstKeyframe.dataLength} bytes`,
        );
      }
    } catch (e) {
      console.log(`  ${profile} stream failed: ${e}`);
      fs.writeFileSync(
        path.join(FIXTURES_DIR, `stream-${profile}-frames.json`),
        JSON.stringify({ error: String(e), frames }),
      );
    }
  }

  // 7. Save first raw keyframe data for H264/H265 converter tests
  console.log("Capturing raw keyframe data for converter tests...");
  try {
    const videoStream = new BaichuanVideoStream({
      client: api.client,
      api,
      channel: 0,
      profile: "main",
      logger: console,
    });

    await new Promise<void>(async (resolve) => {
      videoStream.on("videoAccessUnit", (unit: any) => {
        if (unit.isKeyframe) {
          fs.writeFileSync(
            path.join(FIXTURES_DIR, `raw-keyframe-${unit.videoType?.toLowerCase() ?? "unknown"}.bin`),
            unit.data,
          );
          console.log(`  Saved raw ${unit.videoType} keyframe: ${unit.data.length} bytes`);
          videoStream.stop().then(resolve);
        }
      });
      await videoStream.start();
      // Timeout after 10s
      setTimeout(() => resolve(), 10000);
    });
  } catch (e) {
    console.log(`  Raw keyframe capture failed: ${e}`);
  }

  await api.close();
  console.log("\nDone! Fixtures saved to test/fixtures/");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
