#!/usr/bin/env node
/**
 * Test script to validate parsing of BcMedia frames.
 * Analyzes frames received with cmd_id 3 and checks whether they contain BcMedia packets.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame, parseBcMedia } from "../../index.js";
import { config } from "../env.js";

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

async function testBcMediaParsing() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: PARSE BCMEDIA PACKETS                           ║");
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
  let frameCount = 0;
  let bcMediaCount = 0;
  const bcMediaTypes = new Map<string, number>();

  // Handler for cmd_id 3 frames.
  api.client.on("push", (frame: BaichuanFrame) => {
    if (frame.header.cmdId !== 3) return;

    frameCount++;

    // Decrypt frame body
    const decrypted = api.client.tryDecryptBinary(
      frame.body,
      frame.header.channelId,
      api.client.enc
    );

    // Find where BcMedia packets start (after XML if present)
    let searchStart = 0;
    const extensionEnd = decrypted.indexOf(Buffer.from("</Extension>"));
    const bodyEnd = decrypted.indexOf(Buffer.from("</body>"));
    
    if (extensionEnd !== -1) {
      searchStart = extensionEnd + Buffer.from("</Extension>").length;
    } else if (bodyEnd !== -1) {
      searchStart = bodyEnd + Buffer.from("</body>").length;
    }

    // Parse BcMedia packets
    let offset = searchStart;
    let parsedInFrame = 0;
    
    while (offset < decrypted.length) {
      const remaining = decrypted.subarray(offset);
      const result = parseBcMedia(remaining);
      
      if (!result) {
        break;
      }

      const { media, consumed } = result;
      bcMediaCount++;
      parsedInFrame++;
      
      const typeKey = media.type;
      bcMediaTypes.set(typeKey, (bcMediaTypes.get(typeKey) || 0) + 1);

      // Log the first 5 BcMedia packets for debugging.
      if (bcMediaCount <= 5) {
        if (media.type === "Iframe" || media.type === "Pframe") {
          log(`BcMedia #${bcMediaCount} - ${media.type}`, {
            videoType: media.videoType,
            microseconds: media.microseconds,
            time: media.type === "Iframe" ? media.time : undefined,
            dataLen: media.data.length,
            dataPreview: media.data.subarray(0, Math.min(32, media.data.length)).toString("hex"),
          });
        } else {
          log(`BcMedia #${bcMediaCount} - ${media.type}`, {
            dataLen: media.data ? media.data.length : undefined,
          });
        }
      }

      offset += consumed;
    }

    // Log every 100 frames.
    if (frameCount % 100 === 0) {
      log(`Frames processed: ${frameCount}, BcMedia packets: ${bcMediaCount}`);
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

    // Wait 30 seconds to gather frames.
    logSuccess("Waiting 30 seconds to gather and parse BcMedia frames...");
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Results
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RESULTS                                 ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\nFrames received (cmd_id 3): ${frameCount}`);
    console.log(`BcMedia packets parsed: ${bcMediaCount}`);
    console.log(`\nBcMedia packet types:`);
    
    for (const [type, count] of Array.from(bcMediaTypes.entries()).sort((a, b) => b[1] - a[1])) {
      const percentage = ((count / bcMediaCount) * 100).toFixed(2);
      console.log(`   ${type}: ${count} (${percentage}%)`);
    }

    if (bcMediaCount > 0) {
      logSuccess(`Found ${bcMediaCount} BcMedia packets`);
      logSuccess("BcMedia parser appears to be working");
      
      const videoFrames = (bcMediaTypes.get("Iframe") || 0) + (bcMediaTypes.get("Pframe") || 0);
      if (videoFrames > 0) {
        logSuccess(`Found ${videoFrames} video frames (Iframe + Pframe)`);
      }
    } else {
      logError("No BcMedia packets parsed", new Error("No BcMedia packets found"));
    }

  } catch (error) {
    logError("Fatal error during test", error);
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

testBcMediaParsing().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});



