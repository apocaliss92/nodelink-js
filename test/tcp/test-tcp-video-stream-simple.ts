#!/usr/bin/env node
/**
 * Simplified test script for Baichuan video streaming.
 * Focuses on cmd_id 3 with multiple parameter variants.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame, buildChannelExtensionXml } from "../../index.js";
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

async function testVideoStreamSimple() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: BAICHUAN VIDEO STREAM (SIMPLE)                  ║");
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
  const channelId = channel + 1;

  const videoFrames: BaichuanFrame[] = [];
  let pushEventCount = 0;

  // Handler for push events - look for cmd_id 3 video frames.
  api.client.on("push", (frame: BaichuanFrame) => {
    pushEventCount++;
    
    // Frame video: cmd_id 3, body binario, dimensione significativa
    if (frame.header.cmdId === 3 && frame.body.length > 100) {
      const isBinary = !frame.body.toString("utf8", 0, Math.min(10, frame.body.length)).startsWith("<?xml");
      if (isBinary) {
        videoFrames.push(frame);
        log(`Video frame received`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
        });
      }
    }
    
    // Log first 20 push events for debugging.
    if (pushEventCount <= 20) {
      const bodyPreview = frame.body.toString("utf8", 0, Math.min(50, frame.body.length));
      const isXml = bodyPreview.startsWith("<?xml") || bodyPreview.startsWith("<");
      if (pushEventCount <= 10 || frame.header.cmdId === 3) {
        log(`Push #${pushEventCount}`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          isXml,
        });
      }
    }
  });

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // cmd_id 3 (MSG_ID_VIDEO) - parameter variants.
    // Based on neolink stream.rs: BcXml serializes as <body> with Preview inside.
    // Try with and without Extension XML (response_code 421 suggests extension may be needed).
    const testCases = [
      {
        name: "Sub stream - con extension XML (response_code 421)",
        handle: 256,
        streamType: 1,
        streamName: "subStream",
        useExtension: true,
      },
      {
        name: "Sub stream - senza extension XML",
        handle: 256,
        streamType: 1,
        streamName: "subStream",
        useExtension: false,
      },
      {
        name: "Main stream - con extension XML",
        handle: 0,
        streamType: 0,
        streamName: "mainStream",
        useExtension: true,
      },
    ];

    for (const testCase of testCases) {
      log(`\nTest: ${testCase.name}`);
      
      // Based on neolink: BcXml serializes as <body> with Preview inside.
      // Preview has version as an attribute (@version in serde).
      const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${testCase.handle}</handle>
<streamType>${testCase.streamName}</streamType>
</Preview>
</body>`;

      try {
        const initialPushCount = pushEventCount;
        const initialVideoFrames = videoFrames.length;

        const frame = await api.client.sendFrame({
          cmdId: 3, // MSG_ID_VIDEO
          channel,
          payloadXml,
          extensionXml: testCase.useExtension ? buildChannelExtensionXml(channelId) : undefined,
          messageClass: 0x6414, // BC_CLASS_MODERN_24
          streamType: testCase.streamType,
        });

        log(`Response`, {
          responseCode: frame.header.responseCode,
          success: frame.header.responseCode === 200,
          note: frame.header.responseCode === 200 ? "SUCCESS" : frame.header.responseCode === 421 ? "421 (different from 400)" : `${frame.header.responseCode}`,
        });

        if (frame.header.responseCode === 200 || frame.header.responseCode === 421) {
          // Even if response_code is 421, the stream might still be active.
          logSuccess(`Command sent (response_code ${frame.header.responseCode}). Waiting for video frames...`);
          
          // After sending Preview, it may be necessary to explicitly subscribe to video frames.
          log(`Attempting explicit subscription to video frames...`);
          
          try {
            // Attempt to subscribe to video frames (best-effort).
            const subscribeFrame = await api.client.sendFrame({
              cmdId: 3, // MSG_ID_VIDEO - potrebbe servire per sottoscriversi
              channel,
              payloadXml: "",
              extensionXml: buildChannelExtensionXml(channelId),
              messageClass: 0x6414,
              streamType: testCase.streamType,
            });
            
            log(`Subscription response`, {
              responseCode: subscribeFrame.header.responseCode,
              note: subscribeFrame.header.responseCode === 200 ? "Subscription accepted" : `${subscribeFrame.header.responseCode}`,
            });
          } catch (error) {
            log(`Subscription attempt error: ${error instanceof Error ? error.message : String(error)}`);
          }
          
          // Wait 20 seconds to see if video frames arrive.
          await new Promise((resolve) => setTimeout(resolve, 20000));
          
          const newPushCount = pushEventCount - initialPushCount;
          const newVideoFrames = videoFrames.length - initialVideoFrames;
          
          log(`Result`, {
            pushEvents: newPushCount,
            videoFrames: newVideoFrames,
            success: newVideoFrames > 0,
          });
          
          if (newVideoFrames > 0) {
            logSuccess(`Received ${newVideoFrames} video frames`);
            
            // Analyze the first video frame
            const videoFrame = videoFrames[videoFrames.length - newVideoFrames];
            if (videoFrame) {
              try {
                const decrypted = api.client.tryDecryptBinary(
                  videoFrame.body,
                  videoFrame.header.channelId,
                  api.client.enc
                );
                
                // Cerca pattern NAL unit
                const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
                const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
                
                if (nalStart1 !== -1 || nalStart2 !== -1) {
                  logSuccess(`Frame contains H.264/H.265 NAL units`);
                  const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
                  if (nalPos < decrypted.length) {
                    const nalType = decrypted[nalPos]! & 0x1F;
                    log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : nalType === 7 ? "SPS" : nalType === 8 ? "PPS" : "Other"})`);
                  }
                } else {
                  log(`No NAL unit start code pattern found`);
                  log(`   Primi 128 bytes (hex): ${decrypted.subarray(0, Math.min(128, decrypted.length)).toString("hex")}`);
                }
              } catch (error) {
                logError(`Error while analyzing frame`, error);
              }
            }
            
            // Found! Exit.
            break;
          } else {
            log(`No video frames received after 20 seconds`);
          }
        } else {
          log(`Command rejected (response_code: ${frame.header.responseCode})`);
        }
        
        // Pause between tests
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (error) {
        logError(`Error during test`, error);
      }
    }

    // Summary
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    TEST SUMMARY                           ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\nPush events received: ${pushEventCount}`);
    console.log(`Video frames identified: ${videoFrames.length}`);
    
    if (videoFrames.length > 0) {
      logSuccess(`Found ${videoFrames.length} video frames`);
    } else {
      console.log(`\n[WARN] No video frames identified.`);
      console.log(`Response code 421 with Extension XML suggests we are close,`);
      console.log(`but a different format or additional parameters might be required.`);
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

testVideoStreamSimple().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

