/**
 * Capture NVR-specific protocol fixtures for multi-channel testing.
 * Wakes battery cameras before capturing streams.
 * Run with: npx tsx test/capture-nvr-fixtures.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanVideoStream } from "../src/baichuan/stream/BaichuanVideoStream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "nvr");

const NVR_HOST = "192.168.1.161";
const NVR_PORT = 9000;
const NVR_USER = "admin";
const NVR_PASS = "Ruocco123";
const CHANNELS = [0, 1, 2]; // 0=lavanderia, 1=porta retro, 2=baby monitor
const STREAM_CAPTURE_MS = 5000;
const WAKE_TIMEOUT_MS = 15000;

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, log: () => {} };

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const api = new ReolinkBaichuanApi({
    host: NVR_HOST,
    port: NVR_PORT,
    username: NVR_USER,
    password: NVR_PASS,
  });

  console.log(`Connecting to NVR ${NVR_HOST}:${NVR_PORT}...`);
  await api.login();
  api.setIsNvr(true);
  console.log("Logged in (NVR mode).\n");

  // Hub-level info
  const info = await api.getInfo();
  fs.writeFileSync(path.join(FIXTURES_DIR, "hub-info.json"), JSON.stringify(info, null, 2));
  console.log(`Hub: ${info?.type}`);

  const channelCount = await api.getChannelCount();
  fs.writeFileSync(path.join(FIXTURES_DIR, "channel-count.json"), JSON.stringify({ channelCount }));
  console.log(`Channels: ${channelCount}\n`);

  for (const ch of CHANNELS) {
    console.log(`=== Channel ${ch} ===`);

    // Try to get info — may fail if camera sleeping (400)
    let chInfo: any = null;
    try {
      chInfo = await api.getInfo(ch);
      fs.writeFileSync(path.join(FIXTURES_DIR, `ch${ch}-info.json`), JSON.stringify(chInfo, null, 2));
      console.log(`  Name: ${chInfo?.name}, Model: ${chInfo?.type}`);
    } catch (e) {
      console.log(`  getInfo failed (camera likely sleeping): ${(e as Error).message?.substring(0, 80)}`);
    }

    // Try to wake the camera by starting a stream
    console.log(`  Waking camera (starting stream)...`);
    let session: { client: any; release: () => Promise<void> } | null = null;
    try {
      session = await api.createDedicatedSession(`capture:ch${ch}:main`);
    } catch (e) {
      console.log(`  createDedicatedSession failed: ${(e as Error).message?.substring(0, 80)}`);
      continue;
    }

    const videoStream = new BaichuanVideoStream({
      client: session.client,
      api,
      channel: ch,
      profile: "main",
      logger: silentLogger,
    });

    const frames: Array<{
      audio: boolean;
      videoType?: string;
      isKeyframe?: boolean;
      dataLength: number;
      dataHead: string;
      microseconds?: number;
    }> = [];

    let stopped = false;
    videoStream.on("videoAccessUnit", (unit: any) => {
      if (stopped) return;
      frames.push({
        audio: false,
        videoType: unit.videoType,
        isKeyframe: unit.isKeyframe,
        dataLength: unit.data.length,
        dataHead: unit.data.subarray(0, 32).toString("hex"),
        microseconds: unit.microseconds,
      });
    });
    videoStream.on("audioFrame", (frame: Buffer) => {
      if (stopped) return;
      frames.push({
        audio: true,
        dataLength: frame.length,
        dataHead: frame.subarray(0, 16).toString("hex"),
      });
    });

    try {
      await videoStream.start();
      console.log(`  Stream started, capturing ${STREAM_CAPTURE_MS / 1000}s...`);

      // Wait for first frame or timeout
      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }

      if (frames.length === 0) {
        console.log(`  No frames after ${WAKE_TIMEOUT_MS / 1000}s — camera may be offline`);
      } else {
        console.log(`  First frame received, capturing more...`);
        await new Promise((r) => setTimeout(r, STREAM_CAPTURE_MS));
      }
    } catch (e) {
      console.log(`  Stream start failed: ${(e as Error).message?.substring(0, 80)}`);
    }

    stopped = true;
    try { await videoStream.stop(); } catch { /* ignore */ }

    const videoFrames = frames.filter((f) => !f.audio);
    const audioFrames = frames.filter((f) => f.audio);
    console.log(`  Captured: ${videoFrames.length} video, ${audioFrames.length} audio`);

    fs.writeFileSync(
      path.join(FIXTURES_DIR, `ch${ch}-main-frames.json`),
      JSON.stringify(frames, null, 2),
    );

    // Now that camera is awake, re-try info and stream options
    if (!chInfo) {
      try {
        chInfo = await api.getInfo(ch);
        fs.writeFileSync(path.join(FIXTURES_DIR, `ch${ch}-info.json`), JSON.stringify(chInfo, null, 2));
        console.log(`  Name: ${chInfo?.name}, Model: ${chInfo?.type}`);
      } catch { /* still sleeping */ }
    }

    try {
      const streamOpts = await api.buildVideoStreamOptions({ channel: ch, onNvr: true });
      fs.writeFileSync(path.join(FIXTURES_DIR, `ch${ch}-stream-options.json`), JSON.stringify(streamOpts, null, 2));
      for (const s of streamOpts.nativeStreams) {
        console.log(`  ${s.profile}: ${s.metadata?.width}x${s.metadata?.height} ${s.metadata?.videoEncType}`);
      }
    } catch (e) {
      console.log(`  buildVideoStreamOptions failed: ${(e as Error).message?.substring(0, 80)}`);
    }

    // Release dedicated session
    try { await session.release(); } catch { /* ignore */ }
    console.log();
  }

  // Socket pool state
  const poolSummary = api.getSocketPoolSummary();
  fs.writeFileSync(path.join(FIXTURES_DIR, "socket-pool-summary.json"), JSON.stringify(poolSummary, null, 2));
  console.log(`Socket pool: ${JSON.stringify(poolSummary)}`);

  await api.close();
  console.log(`\nDone! ${fs.readdirSync(FIXTURES_DIR).length} NVR fixtures saved.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
