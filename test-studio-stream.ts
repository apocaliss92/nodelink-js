/**
 * Test script: verify createNativeStream on Studio camera
 * Run: npx tsx test-studio-stream.ts
 */

import { ReolinkBaichuanApi } from "./src/reolink/baichuan/ReolinkBaichuanApi";
import { createNativeStream } from "./src/rfc/helpers";

const HOST = "192.168.1.170";
const PORT = 9000;
const USERNAME = "admin";
const PASSWORD = "Ruocco123";
const CHANNEL = 0;
const PROFILE = "main" as const;

async function main() {
  console.log(`\n=== Test 1: createNativeStream (used by WebRTC/MJPEG in management server) ===`);
  console.log(`Connecting to ${HOST}:${PORT}...`);

  const api = new ReolinkBaichuanApi({
    host: HOST,
    port: PORT,
    username: USERNAME,
    password: PASSWORD,
    debugOptions: { general: true },
    logger: console,
  });

  try {
    await api.login();
    console.log("✓ Login successful");

    // Check device info
    const info = await api.getInfo();
    console.log(`  Model: ${info?.type}, FW: ${info?.firmwareVersion}`);

    const channelCount = await api.getChannelCount();
    console.log(`  Channels: ${channelCount}`);

    // Set flags like the plugin does
    const isNvr = channelCount > 1;
    api.setIsNvr(isNvr);
    console.log(`  setIsNvr(${isNvr})`);

    let isMultifocal = false;
    try {
      const dualLens = await api.getDualLensChannelInfo(0, { onNvr: isNvr });
      isMultifocal = dualLens.isDualLens;
    } catch { /* ignore */ }
    api.setIsMultiFocal(isMultifocal);
    console.log(`  setIsMultiFocal(${isMultifocal})`);

    // First, subscribe to events (like the management server does)
    console.log("\n--- Subscribing to events (simulating management server) ---");
    await api.onSimpleEvent((ev) => {
      console.log(`  [event] ${ev.type} ch${ev.channel}`);
    });
    console.log("✓ Event subscription active");

    // Wait a bit for events to settle
    await new Promise(r => setTimeout(r, 1000));

    // Now try createNativeStream (this is what fails in the management server)
    console.log(`\n--- Starting createNativeStream(channel=${CHANNEL}, profile=${PROFILE}) ---`);
    const stream = createNativeStream(api, CHANNEL, PROFILE);

    let frameCount = 0;
    const timeout = setTimeout(() => {
      console.log(`\n⚠ Timeout after 15s. Received ${frameCount} frames.`);
      process.exit(frameCount > 0 ? 0 : 1);
    }, 15000);

    for await (const frame of stream) {
      frameCount++;
      if (frameCount === 1) {
        console.log(`✓ First frame received! audio=${frame.audio}, videoType=${frame.videoType}, isKeyframe=${frame.isKeyframe}, size=${frame.data.length}`);
      }
      if (frameCount <= 5) {
        console.log(`  Frame ${frameCount}: audio=${frame.audio}, size=${frame.data.length}${frame.videoType ? `, codec=${frame.videoType}` : ""}${frame.isKeyframe ? " [KEYFRAME]" : ""}`);
      }
      if (frameCount === 10) {
        console.log(`✓ Successfully received ${frameCount} frames. Stream works!`);
        clearTimeout(timeout);
        break;
      }
    }

    console.log("\n--- Cleaning up ---");
    await api.close();
    console.log("✓ Done");
    process.exit(0);
  } catch (error) {
    console.error(`\n✗ ERROR: ${error}`);
    try { await api.close(); } catch { /* ignore */ }
    process.exit(1);
  }
}

main();
