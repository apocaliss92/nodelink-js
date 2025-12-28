#!/usr/bin/env node
/**
 * Test script for Baichuan video streaming.
 * Tests startVideoStream/stopVideoStream with cmd_id candidates.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index";
import { config } from "../env";

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

async function testVideoStream() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST STREAM VIDEO BAICHUAN (TCP)                      ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("[ERROR] TCP configuration is incomplete in the .env file");
    console.error("Set TCP_HOST and TCP_PASSWORD");
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
  const profile: "main" | "sub" | "ext" = "sub"; // Test with sub stream (lighter)

  // cmd_id candidates. In practice MSG_ID_VIDEO is 3.
  const cmdIdCandidates = [3];

  const videoFrames: BaichuanFrame[] = [];
  let pushEventCount = 0;

  try {
    // Register handler BEFORE login to capture all push events.
    api.client.on("push", (frame: BaichuanFrame) => {
      pushEventCount++;
      
      // Log first 10 push events for debugging.
      if (pushEventCount <= 10) {
        const bodyPreview = frame.body.toString("utf8", 0, Math.min(50, frame.body.length));
        const isXml = bodyPreview.startsWith("<?xml") || bodyPreview.startsWith("<");
        log(`Push event #${pushEventCount}`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          isXml,
          bodyPreview: isXml ? bodyPreview : frame.body.subarray(0, Math.min(32, frame.body.length)).toString("hex"),
        });
      }
      
      // Identify potential video frames: cmd_id=3, binary body, significant size.
      const isBinary = !frame.body.toString("utf8", 0, Math.min(10, frame.body.length)).startsWith("<?xml");
      const isLarge = frame.body.length > 100;
      const isStreamType0 = frame.header.streamType === 0 || frame.header.streamType === 1;
      const isVideoCmdId = frame.header.cmdId === 3; // MSG_ID_VIDEO
      
      if (isVideoCmdId && isBinary && isLarge && isStreamType0) {
        videoFrames.push(frame);
        log(`Video frame received`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
        });
        
        // Analyze frame for NAL start codes.
        try {
          const decrypted = api.client.tryDecryptBinary(
            frame.body,
            frame.header.channelId,
            api.client.enc
          );
          
          const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
          
          if (nalStart1 !== -1 || nalStart2 !== -1) {
            logSuccess(`Frame cmd_id 3 contains H.264/H.265 NAL units`);
            const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
            if (nalPos < decrypted.length) {
              const nalType = decrypted[nalPos]! & 0x1F;
              log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : nalType === 7 ? "SPS" : nalType === 8 ? "PPS" : "Other"})`);
            }
          } else {
            log(`Frame cmd_id 3 has no visible NAL start codes (may be encapsulated)`);
            log(`First 64 bytes (hex): ${decrypted.subarray(0, Math.min(64, decrypted.length)).toString("hex")}`);
          }
        } catch (error) {
          logError(`Error while analyzing video frame`, error);
        }
      }
    });

    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Test each cmd_id candidate.
    for (const cmdId of cmdIdCandidates) {
      log(`Testing cmd_id ${cmdId} for startVideoStream`);
      
      try {
        // Aggiorna temporaneamente il valore in constants
        // Per ora testiamo direttamente con sendXml usando il pattern di neolink
        const channelId = channel + 1;
        const profileStr = profile as "main" | "sub" | "ext";
        let handle: number;
        let streamType: number;
        let streamName: string;
        if (profileStr === "main") {
          handle = 0;
          streamType = 0;
          streamName = "mainStream";
        } else if (profileStr === "sub") {
          handle = 256;
          streamType = 1;
          streamName = "subStream";
        } else {
          handle = 1024;
          streamType = 0;
          streamName = "externStream";
        }
        
        // Try different payload XML / Extension combinations.
        // neolink uses Bc::new_from_xml with BcMeta and BcXml, where Preview is in the payload.
        // Some devices may also require an Extension XML containing channelId.
        const testVariants = [
          // Variant 1: without <body> wrapper, without extension
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: undefined,
            description: "Preview only, no extension",
          },
          // Variant 2: with <body> wrapper, without extension
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>
</body>`,
            extensionXml: undefined,
            description: "Preview with <body>, no extension",
          },
          // Variant 3: without <body> wrapper, with extension (response_code 421 - different from 400)
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>${channelId}</channelId></Extension>`,
            description: "Preview with Extension XML (response_code 421)",
          },
          // Variant 5: with <body> wrapper, with extension
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>
</body>`,
            extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>${channelId}</channelId></Extension>`,
            description: "Preview with <body> and Extension XML",
          },
          // Variant 6: Preview without channelId in payload (only in extension)
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview version="1.0">
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>${channelId}</channelId></Extension>`,
            description: "Preview without channelId (only in extension)",
          },
          // Variant 4: Preview without version
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview>
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: undefined,
            description: "Preview without version",
          },
        ];

        const startTime = Date.now();
        let commandAccepted = false;

        // Test each variant
        for (let variantIndex = 0; variantIndex < testVariants.length; variantIndex++) {
          const variant = testVariants[variantIndex]!;
          
          log(`Testing cmd_id ${cmdId}, variant ${variantIndex + 1}/${testVariants.length}: ${variant.description}`);
          
          try {
            const frame = await api.client.sendFrame({
              cmdId,
              channel,
              payloadXml: variant.payloadXml,
              extensionXml: variant.extensionXml,
              messageClass: 0x6414, // BC_CLASS_MODERN_24
              streamType,
            });

            log(`Response cmd_id ${cmdId} (variant ${variantIndex + 1})`, {
              responseCode: frame.header.responseCode,
              cmdId: frame.header.cmdId,
              streamType: frame.header.streamType,
              channelId: frame.header.channelId,
              bodyLen: frame.body.length,
              success: frame.header.responseCode === 200,
              note: frame.header.responseCode === 200 ? "Command accepted" : `Rejected (response_code ${frame.header.responseCode})`,
            });

            if (frame.header.responseCode === 200) {
              logSuccess(`Found working variant ${variantIndex + 1} for cmd_id ${cmdId}`);
              commandAccepted = true;
              break; // exit variant loop
            } else if (frame.header.responseCode !== 400 && frame.header.responseCode !== 421) {
              // If the response_code is different from 400/421, it might be progress.
              log(`Response code ${frame.header.responseCode} (different from 400/421) - might be progress`);
            }
          } catch (error) {
            logError(`Variant error ${variantIndex + 1}`, error);
          }
        }
        
        if (!commandAccepted) {
          // If no variant worked, continue with next cmd_id.
          log(`No variant worked for cmd_id ${cmdId}`);
          continue;
        }

        // If the command was accepted, wait for video frames.
        const initialPushCount = pushEventCount;
        const initialVideoFrames = videoFrames.length;

        logSuccess(`cmd_id ${cmdId} accepted. Waiting for video frames...`);
        
        // Wait 15 seconds to see if video frames arrive.
        await new Promise((resolve) => setTimeout(resolve, 15000));

        const elapsed = Date.now() - startTime;
        const newPushCount = pushEventCount - initialPushCount;
        const newVideoFrames = videoFrames.length - initialVideoFrames;

        log(`Test result cmd_id ${cmdId}`, {
          elapsed: `${elapsed}ms`,
          pushEvents: newPushCount,
          videoFrames: newVideoFrames,
          success: newVideoFrames > 0,
        });

        if (newVideoFrames > 0) {
          logSuccess(`cmd_id ${cmdId} produced ${newVideoFrames} video frames`);
          
          // Analyze video frames
          for (let i = videoFrames.length - newVideoFrames; i < videoFrames.length; i++) {
            const frame = videoFrames[i];
            if (!frame) continue;
            
            try {
              const decrypted = api.client.tryDecryptBinary(
                frame.body,
                frame.header.channelId,
                api.client.enc
              );
              
              // Look for NAL start codes
              const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
              const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
              
              if (nalStart1 !== -1 || nalStart2 !== -1) {
                logSuccess(`Frame cmd_id ${frame.header.cmdId} contains H.264/H.265 NAL units`);
                const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
                if (nalPos < decrypted.length) {
                  const nalType = decrypted[nalPos]! & 0x1F;
                  log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : nalType === 7 ? "SPS" : nalType === 8 ? "PPS" : "Other"})`);
                }
                break; // Found, exit loop
              }
            } catch (error) {
              // Ignore decryption errors
            }
          }
          
          // If we found valid video frames, this is the correct cmd_id.
          console.log(`\n[RESULT] cmd_id ${cmdId} appears to be correct for video streaming.`);
          console.log(`Update BC_CMD_ID_VIDEO in src/protocol/constants.ts with this value.\n`);
          break; // Exit cmd_id loop
        }

        // Pause between tests
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        logError(`Error while testing cmd_id ${cmdId}`, error);
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
      const cmdIds = new Set(videoFrames.map((f) => f.header.cmdId));
      console.log(`\ncmd_id values that generated video frames:`);
      for (const cmdId of cmdIds) {
        const count = videoFrames.filter((f) => f.header.cmdId === cmdId).length;
        console.log(`   - cmd_id ${cmdId}: ${count} frames`);
      }
    } else {
      console.log(`\n[WARN] No video frames identified.`);
      console.log(`Possible causes:`);
      console.log(`- Tested cmd_id values are not correct`);
      console.log(`- Video stream requires different parameters`);
      console.log(`- Check values in neolink crates/core/src/bc/model.rs`);
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

// Run tests
testVideoStream().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

