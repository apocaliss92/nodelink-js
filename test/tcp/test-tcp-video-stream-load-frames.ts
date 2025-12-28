#!/usr/bin/env node
/**
 * Test script to load and parse locally saved Baichuan video frames.
 * Does not require a camera connection.
 */

// @ts-expect-error - Path resolution at runtime
import { parseBcMedia, BcMediaCodec } from "../../index.js";
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

async function loadAndParseFrames() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: PARSE LOCALLY SAVED FRAMES                      ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  const framesDir = path.join(process.cwd(), "test", "frames");
  
  if (!fs.existsSync(framesDir)) {
    logError("Frames directory not found", new Error(`Directory ${framesDir} does not exist. Run test-tcp-video-stream-save-frames.ts first.`));
    process.exit(1);
  }

  // Find all frame_*.bin files
  const frameFiles = fs.readdirSync(framesDir)
    .filter(f => f.startsWith("frame_") && f.endsWith(".bin"))
    .sort();

  if (frameFiles.length === 0) {
    logError("No frames found", new Error(`No frame_*.bin files found in ${framesDir}`));
    process.exit(1);
  }

  log(`Found ${frameFiles.length} frames to analyze`);

  let totalBcMedia = 0;
  const bcMediaTypes = new Map<string, number>();
  const videoFrames: Array<{ frameFile: string; media: any }> = [];
  
  // Use BcMediaCodec to handle fragmented packets
  const codec = new BcMediaCodec(false);

  for (const frameFile of frameFiles) {
    const framePath = path.join(framesDir, frameFile);
    const frameData = fs.readFileSync(framePath);
    
    // Load metadata if available
    const metadataFile = frameFile.replace(".bin", ".json");
    const metadataPath = path.join(framesDir, metadataFile);
    let metadata: any = null;
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    }

    log(`Analyzing ${frameFile}`, {
      size: frameData.length,
      metadata: metadata ? {
        cmdId: metadata.cmdId,
        streamType: metadata.streamType,
        channelId: metadata.channelId,
      } : null,
    });

    // Also try loading the separate payload file if present.
    const payloadFile = frameFile.replace(".bin", "_payload.bin");
    let payloadData: Buffer | null = null;
    if (fs.existsSync(path.join(framesDir, payloadFile))) {
      payloadData = fs.readFileSync(path.join(framesDir, payloadFile));
      log(`Found separate payload: ${payloadFile} (${payloadData.length} bytes)`);
    }

    // Find where BcMedia packets start (after XML if present)
    let searchStart = 0;
    const extensionEnd = frameData.indexOf(Buffer.from("</Extension>"));
    const bodyEnd = frameData.indexOf(Buffer.from("</body>"));
    
    if (extensionEnd !== -1) {
      searchStart = extensionEnd + Buffer.from("</Extension>").length;
    } else if (bodyEnd !== -1) {
      searchStart = bodyEnd + Buffer.from("</body>").length;
    }

    // Use BcMediaCodec to handle fragmented packets
    // The codec buffers incomplete packets and assembles them when complete
    const dataToParse = payloadData || frameData.subarray(searchStart);
    const mediaPackets = codec.decode(dataToParse);
    
    let parsedInFrame = 0;
    for (const media of mediaPackets) {
      totalBcMedia++;
      parsedInFrame++;
      
      const typeKey = media.type;
      bcMediaTypes.set(typeKey, (bcMediaTypes.get(typeKey) || 0) + 1);

      // Save video frames for analysis
      if (media.type === "Iframe" || media.type === "Pframe") {
        videoFrames.push({ frameFile, media });
        
        log(`BcMedia #${totalBcMedia} - ${media.type}`, {
          videoType: media.videoType,
          microseconds: media.microseconds,
          time: media.type === "Iframe" ? media.time : undefined,
          dataLen: media.data.length,
          dataPreview: media.data.subarray(0, Math.min(32, media.data.length)).toString("hex"),
        });
      }
    }

    if (parsedInFrame > 0) {
      logSuccess(`Parsed ${parsedInFrame} BcMedia packets from ${frameFile}`);
    } else {
      log(`No BcMedia packets found in ${frameFile}`);
    }
  }

  // Risultati finali
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                    RISULTATI                                ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nFrames analyzed: ${frameFiles.length}`);
  console.log(`BcMedia packets parsed: ${totalBcMedia}`);
  console.log(`\nBcMedia packet types:`);
  
  for (const [type, count] of Array.from(bcMediaTypes.entries()).sort((a, b) => b[1] - a[1])) {
    const percentage = totalBcMedia > 0 ? ((count / totalBcMedia) * 100).toFixed(2) : "0.00";
    console.log(`   ${type}: ${count} (${percentage}%)`);
  }

  if (totalBcMedia > 0) {
    logSuccess(`Found ${totalBcMedia} BcMedia packets`);
    logSuccess("BcMedia parser appears to be working");
    
    const videoFramesCount = (bcMediaTypes.get("Iframe") || 0) + (bcMediaTypes.get("Pframe") || 0);
    if (videoFramesCount > 0) {
      logSuccess(`Found ${videoFramesCount} video frames (Iframe + Pframe)`);
    }
  } else {
    logError("No BcMedia packets parsed", new Error("No BcMedia packets found"));
  }
}

loadAndParseFrames().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

