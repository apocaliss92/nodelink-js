#!/usr/bin/env node
/**
 * Test script to identify the correct cmd_id to request the video stream.
 * Tries multiple cmd_id values and analyzes responses.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index.js";
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

interface StreamRequestTest {
  cmdId: number;
  payloadXml: string;
  description: string;
}

async function testStreamRequests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: VIDEO STREAM REQUEST (TCP)                       ║");
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
  const profile = "sub"; // Test with sub stream (lighter)

  // cmd_id values to test based on common patterns
  const tests: StreamRequestTest[] = [
    {
      cmdId: 56, // GetEnc - already used for metadata
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 56 (GetEnc) with subStream enable",
    },
    {
      cmdId: 57, // SetEnc - already used to set encoding
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 57 (SetEnc) with subStream enable",
    },
    {
      cmdId: 58, // Possibile cmd_id per streaming
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 58 with subStream enable",
    },
    {
      cmdId: 59, // Possibile cmd_id per streaming
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 59 with subStream enable",
    },
    {
      cmdId: 57,
      payloadXml: `<body><subStream><streamType>0</streamType></subStream></body>`,
      description: "cmd_id 57 with streamType",
    },
    {
      cmdId: 57,
      payloadXml: `<body><subStream><start>1</start></subStream></body>`,
      description: "cmd_id 57 with subStream start",
    },
  ];

  const videoFrames: BaichuanFrame[] = [];
  let pushEventCount = 0;

  try {
    // Register handler BEFORE login to capture automatic frames.
    api.client.on("push", (frame: BaichuanFrame) => {
      pushEventCount++;
      
      // Identifica possibili frame video
      const isBinary = !frame.body.toString("utf8", 0, Math.min(10, frame.body.length)).startsWith("<?xml");
      const isLarge = frame.body.length > 100;
      const isStreamType0 = frame.header.streamType === 0;
      
      if (isBinary && isLarge && isStreamType0) {
        videoFrames.push(frame);
        log(`Potential video frame received`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
        });
      }
    });

    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Wait to see if frames arrive automatically after login.
    log("Waiting 5 seconds to see if frames arrive automatically after login...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    
    log(`Frames during wait: ${pushEventCount} push events, ${videoFrames.length} potential video frames`);

    // Analyze automatically received frames.
    if (videoFrames.length > 0) {
      log(`Found ${videoFrames.length} automatic frames after login`);
      for (const frame of videoFrames) {
        try {
          const decrypted = api.client.tryDecryptBinary(
            frame.body,
            frame.header.channelId,
            api.client.enc
          );
          
          log(`Analisi frame automatico cmd_id ${frame.header.cmdId}`, {
            originalLen: frame.body.length,
            decryptedLen: decrypted.length,
            firstBytes: decrypted.subarray(0, Math.min(32, decrypted.length)).toString("hex"),
          });
          
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
          } else {
            // Check if it's XML (not video)
            const isXml = decrypted.toString("utf8", 0, Math.min(10, decrypted.length)).startsWith("<?xml");
            if (isXml) {
              log(`Frame cmd_id ${frame.header.cmdId} is XML, not video`);
            } else {
              log(`Frame cmd_id ${frame.header.cmdId} has no visible NAL start codes (may be encapsulated)`);
            }
          }
        } catch (error) {
          logError(`Error while analyzing frame cmd_id ${frame.header.cmdId}`, error);
        }
      }
    }

    // Handler already registered above

    // Test ogni cmd_id
    for (const test of tests) {
      log(`Test: ${test.description}`);
      
      try {
        const startTime = Date.now();
        const initialPushCount = pushEventCount;
        const initialVideoFrames = videoFrames.length;

        // Invia comando
        await api.sendXml({
          cmdId: test.cmdId,
          channel,
          payloadXml: test.payloadXml,
        });

        // Wait 3 seconds to see if video frames arrive.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const elapsed = Date.now() - startTime;
        const newPushCount = pushEventCount - initialPushCount;
        const newVideoFrames = videoFrames.length - initialVideoFrames;

        log(`Risultato test`, {
          cmdId: test.cmdId,
          elapsed: `${elapsed}ms`,
          pushEvents: newPushCount,
          videoFrames: newVideoFrames,
          success: newVideoFrames > 0,
        });

        if (newVideoFrames > 0) {
          logSuccess(`cmd_id ${test.cmdId} produced ${newVideoFrames} video frames`);
          
          // Analyze all new video frames
          for (let i = videoFrames.length - newVideoFrames; i < videoFrames.length; i++) {
            const frame = videoFrames[i];
            if (!frame) continue;
            
            try {
              const decrypted = api.client.tryDecryptBinary(
                frame.body,
                frame.header.channelId,
                api.client.enc
              );
              
              log(`Frame analysis cmd_id ${frame.header.cmdId}`, {
                originalLen: frame.body.length,
                decryptedLen: decrypted.length,
                firstBytes: decrypted.subarray(0, Math.min(32, decrypted.length)).toString("hex"),
              });
              
              // Look for NAL start codes
              const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
              const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
              
              if (nalStart1 !== -1 || nalStart2 !== -1) {
                logSuccess(`Frame cmd_id ${frame.header.cmdId} contains H.264/H.265 NAL units`);
                const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
                if (nalPos < decrypted.length) {
                  const nalType = decrypted[nalPos]! & 0x1F;
                  log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : "Other"})`);
                }
              } else {
                // Check if it's XML (not video)
                const isXml = decrypted.toString("utf8", 0, Math.min(10, decrypted.length)).startsWith("<?xml");
                if (isXml) {
                  log(`Frame cmd_id ${frame.header.cmdId} is XML, not video`);
                } else {
                  log(`Frame cmd_id ${frame.header.cmdId} has no visible NAL start codes (may be encapsulated)`);
                }
              }
            } catch (error) {
              logError(`Error while analyzing frame cmd_id ${frame.header.cmdId}`, error);
            }
          }
        }
      } catch (error) {
        logError(`Error while testing cmd_id ${test.cmdId}`, error);
      }

      // Pause between tests
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
      console.log(`\ncmd_id values that generated video frames:`);
      const cmdIds = new Set(videoFrames.map((f) => f.header.cmdId));
      for (const cmdId of cmdIds) {
        const count = videoFrames.filter((f) => f.header.cmdId === cmdId).length;
        console.log(`   - cmd_id ${cmdId}: ${count} frames`);
      }
    } else {
      console.log(`\n[WARN] No video frames identified.`);
      console.log(`Possible causes:`);
      console.log(`- The correct cmd_id was not tested`);
      console.log(`- The video stream requires different parameters`);
      console.log(`- The video stream arrives automatically without an explicit command`);
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
testStreamRequests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

