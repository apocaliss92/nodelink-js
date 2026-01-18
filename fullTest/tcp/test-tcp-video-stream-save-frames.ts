#!/usr/bin/env node
/**
 * Test script to save video frames locally for later offline testing.
 * Saves decrypted cmd_id 3 frames to binary files.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index";
import { config } from "../env";
import * as fs from "node:fs";
import * as path from "node:path";

// Helper functions
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[INFO] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("=".repeat(60));
}

function logSuccess(message: string) {
  console.log(`\n[OK] ${message}`);
}

function logError(message: string, error: unknown) {
  console.error(`\n[ERROR] ${message}`);
  if (error instanceof Error) {
    console.error(`   Message: ${error.message}`);
  } else {
    console.error(`   Details: ${error}`);
  }
}

async function saveFrames() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     SAVE VIDEO FRAMES LOCALLY                              ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("[ERROR] TCP configuration is incomplete in the .env file");
    process.exit(1);
  }

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: false,
  });

  const channel = 0;
  const framesDir = path.join(process.cwd(), "test", "frames");
  
  // Create directory if it doesn't exist.
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  let frameCount = 0;
  const maxFrames = 50; // Save more frames to increase chances of complete video frames.

  // Handler for cmd_id 3 frames.
  api.client.on("push", (frame: BaichuanFrame) => {
    if (frame.header.cmdId !== 3) return;
    if (frameCount >= maxFrames) return;

    // For video frames, extension and payload might be encrypted separately.
    // Save the full decrypted body, plus decrypted extension/payload separately.
    const decryptedBody = api.client.tryDecryptBinary(
      frame.body,
      frame.header.channelId,
      api.client.enc
    );
    
    // Decrypt extension/payload separately (they might be encrypted differently).
    const decryptedExtension = frame.extension.length > 0 
      ? api.client.tryDecryptBinary(frame.extension, frame.header.channelId, api.client.enc)
      : Buffer.alloc(0);
    const decryptedPayload = frame.payload.length > 0
      ? api.client.tryDecryptBinary(frame.payload, frame.header.channelId, api.client.enc)
      : Buffer.alloc(0);

    // Save full decrypted body.
    const frameFile = path.join(framesDir, `frame_${frameCount.toString().padStart(3, "0")}.bin`);
    fs.writeFileSync(frameFile, decryptedBody);
    
    // Save the decrypted payload too (it may contain BcMedia packets).
    const payloadFile = path.join(framesDir, `frame_${frameCount.toString().padStart(3, "0")}_payload.bin`);
    fs.writeFileSync(payloadFile, decryptedPayload);
    
    // Save frame metadata.
    const metadata = {
      frameIndex: frameCount,
      cmdId: frame.header.cmdId,
      streamType: frame.header.streamType,
      channelId: frame.header.channelId,
      msgNum: frame.header.msgNum,
      responseCode: frame.header.responseCode,
      bodyLen: frame.body.length,
      extensionLen: frame.extension.length,
      payloadLen: frame.payload.length,
      decryptedBodyLen: decryptedBody.length,
      decryptedExtensionLen: decryptedExtension.length,
      decryptedPayloadLen: decryptedPayload.length,
      timestamp: new Date().toISOString(),
    };
    const metadataFile = path.join(framesDir, `frame_${frameCount.toString().padStart(3, "0")}.json`);
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));

    frameCount++;
    
    if (frameCount % 5 === 0) {
      logSuccess(`Saved ${frameCount} frames`);
    }
  });

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Start video stream
    log("Starting video stream (sub stream)");
    await api.startVideoStream(channel, "sub");
    logSuccess("Video stream started (response_code 200)");

    // Wait until we gather maxFrames.
    logSuccess(`Waiting until ${maxFrames} frames are collected...`);
    while (frameCount < maxFrames) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    logSuccess(`Saved ${frameCount} frames to ${framesDir}`);
    console.log(`\nSaved frames:`);
    for (let i = 0; i < frameCount; i++) {
      const idx = i.toString().padStart(3, "0");
      console.log(`   - frame_${idx}.bin (binary data)`);
      console.log(`   - frame_${idx}.json (metadata)`);
    }

  } catch (error) {
    logError("Fatal error while saving frames", error);
    if (error instanceof Error && error.stack) {
      console.error("\nFull stack trace:");
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    try {
      await api.close();
      logSuccess("Connection closed");
    } catch (error) {
      logError("Error while closing connection", error);
    }
  }
}

saveFrames().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

