#!/usr/bin/env node
/**
 * Detailed test script to identify Baichuan video frames.
 * Analyzes all push events after sending the Preview command.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame, buildChannelExtensionXml } from "../../index";
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

interface FrameAnalysis {
  cmdId: number;
  streamType: number;
  channelId: number;
  bodyLen: number;
  isXml: boolean;
  isBinary: boolean;
  firstBytes: string;
  decryptedPreview?: string;
  hasNalUnits?: boolean;
  nalUnitTypes?: number[];
}

async function testVideoStreamDetailed() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: DETAILED BAICHUAN VIDEO STREAM                  ║");
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

  const allFrames: BaichuanFrame[] = [];
  const frameAnalysis = new Map<string, FrameAnalysis>();
  let pushEventCount = 0;

  // Handler for ALL push events - analyze everything.
  api.client.on("push", (frame: BaichuanFrame) => {
    pushEventCount++;
    allFrames.push(frame);

    const key = `${frame.header.cmdId}:${frame.header.streamType}:${frame.header.channelId}`;
    
    const bodyPreview = frame.body.toString("utf8", 0, Math.min(50, frame.body.length));
    const isXml = bodyPreview.startsWith("<?xml") || bodyPreview.startsWith("<");
    const isBinary = !isXml && frame.body.length > 0;

    if (!frameAnalysis.has(key)) {
      frameAnalysis.set(key, {
        cmdId: frame.header.cmdId,
        streamType: frame.header.streamType,
        channelId: frame.header.channelId,
        bodyLen: frame.body.length,
        isXml,
        isBinary,
        firstBytes: frame.body.subarray(0, Math.min(32, frame.body.length)).toString("hex"),
      });
    }

    // Analyze ALL binary frames (not only big ones) - they could be video frames.
    if (isBinary && frame.body.length > 0) {
      try {
        const decrypted = api.client.tryDecryptBinary(
          frame.body,
          frame.header.channelId,
          api.client.enc
        );

        const analysis = frameAnalysis.get(key)!;
        
        // For cmdId=3 frames, show more details.
        if (frame.header.cmdId === 3 && frame.body.length > 100) {
          // Show the first 512 bytes to understand the structure.
          analysis.decryptedPreview = decrypted.subarray(0, Math.min(512, decrypted.length)).toString("hex");
          
          // Also show as string to check for embedded XML.
          const asString = decrypted.toString("utf8", 0, Math.min(200, decrypted.length));
          if (asString.includes("<?xml") || asString.includes("<Extension")) {
            // XML present - find where it ends.
            const xmlEnd = decrypted.indexOf(Buffer.from("</Extension>"));
            if (xmlEnd === -1) {
              const bodyEnd = decrypted.indexOf(Buffer.from("</body>"));
              if (bodyEnd !== -1) {
                // Show bytes after </body>
                const afterBody = decrypted.subarray(bodyEnd + 7, Math.min(bodyEnd + 100, decrypted.length));
                analysis.decryptedPreview = `XML until </body>, then: ${afterBody.toString("hex").substring(0, 128)}`;
              }
            } else {
              // Show bytes after </Extension>
              const afterExt = decrypted.subarray(xmlEnd + 13, Math.min(xmlEnd + 100, decrypted.length));
              analysis.decryptedPreview = `XML until </Extension>, then: ${afterExt.toString("hex").substring(0, 128)}`;
            }
          }
        } else {
          analysis.decryptedPreview = decrypted.subarray(0, Math.min(256, decrypted.length)).toString("hex");
        }

        // Search for NAL unit patterns (H.264/H.265).
        const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
        const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));

        if (nalStart1 !== -1 || nalStart2 !== -1) {
          analysis.hasNalUnits = true;

          // Analyze NAL unit types.
          const nalTypes: number[] = [];
          let searchPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
          while (searchPos < decrypted.length && nalTypes.length < 5) {
            const nalType = decrypted[searchPos]! & 0x1F;
            nalTypes.push(nalType);
            // Find next NAL unit.
            const nextNal1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]), searchPos + 1);
            const nextNal2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]), searchPos + 1);
            if (nextNal1 !== -1 || nextNal2 !== -1) {
              searchPos = nextNal1 !== -1 ? nextNal1 + 4 : nextNal2 + 3;
            } else {
              break;
            }
          }
          analysis.nalUnitTypes = nalTypes;
        } else {
          // Baichuan video frames may include XML Extension before video data.
          // Search for NAL units after Extension/body XML.
          let searchStart = 0;
          const extensionEnd = decrypted.indexOf(Buffer.from("</Extension>"));
          const bodyEnd = decrypted.indexOf(Buffer.from("</body>"));
          
          if (extensionEnd !== -1) {
            // Extension XML present - search after it.
            searchStart = extensionEnd + Buffer.from("</Extension>").length;
          } else if (bodyEnd !== -1) {
            // Body XML present - search after it.
            searchStart = bodyEnd + Buffer.from("</body>").length;
          }
          
          if (searchStart > 0 && searchStart < decrypted.length) {
            const afterXml = decrypted.subarray(searchStart);
            const nalStart1 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
            const nalStart2 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x01]));
            
            if (nalStart1 !== -1 || nalStart2 !== -1) {
              analysis.hasNalUnits = true;
              const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
              const videoData = afterXml.subarray(nalStart1 !== -1 ? nalStart1 : nalStart2);
              analysis.decryptedPreview = videoData.subarray(0, Math.min(256, videoData.length)).toString("hex");
              
              // Analyze NAL unit types.
              const nalTypes: number[] = [];
              let searchPos = nalPos;
              while (searchPos < afterXml.length && nalTypes.length < 5) {
                const nalType = afterXml[searchPos]! & 0x1F;
                nalTypes.push(nalType);
                // Find next NAL unit.
                const nextNal1 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]), searchPos + 1);
                const nextNal2 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x01]), searchPos + 1);
                if (nextNal1 !== -1 || nextNal2 !== -1) {
                  searchPos = nextNal1 !== -1 ? nextNal1 + 4 : nextNal2 + 3;
                } else {
                  break;
                }
              }
              analysis.nalUnitTypes = nalTypes;
            } else {
              // No NAL units after XML - show bytes after XML for debugging.
              analysis.decryptedPreview = afterXml.subarray(0, Math.min(512, afterXml.length)).toString("hex");
            }
          }
          
          // Even without visible NAL units, it could still be an encapsulated video frame.
          // Look for common patterns (magic bytes, headers, etc.).
          const startsWithZeros = decrypted[0] === 0x00 && decrypted[1] === 0x00;
          if (startsWithZeros && decrypted.length > 10) {
            // Could be a video frame with a custom header.
            analysis.decryptedPreview = decrypted.subarray(0, Math.min(512, decrypted.length)).toString("hex");
          }
        }
      } catch (error) {
        // Ignore decryption errors.
      }
    }
  });

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Send Preview command (sub stream).
    // Note: neolink calls connection.subscribe(MSG_ID_VIDEO, msg_num) BEFORE sending the command.
    // This creates a dedicated channel. In our case, frames arrive as push events.
    log("Sending Preview command for sub stream");
    
    // Test different XML variants
    // Variant 1: Preview with channelId + extension XML (response_code 421)
    const payloadXml1 = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>256</handle>
<streamType>subStream</streamType>
</Preview>
</body>`;

    // Variant 2: Preview without channelId (only in extension) + extension XML
    const payloadXml2 = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<handle>256</handle>
<streamType>subStream</streamType>
</Preview>
</body>`;

    // Variant 3: Preview without version attribute
    const payloadXml3 = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview>
<channelId>${channelId}</channelId>
<handle>256</handle>
<streamType>subStream</streamType>
</Preview>
</body>`;

    // neolink does NOT use Extension XML for the Preview command.
    // Test variants without extension XML (like neolink).
    const variants = [
      { name: "Preview with channelId WITHOUT extension (like neolink)", payload: payloadXml1, extension: undefined },
      { name: "Preview without channelId WITHOUT extension", payload: payloadXml2, extension: undefined },
      { name: "Preview without version WITHOUT extension", payload: payloadXml3, extension: undefined },
      // Also test with extension for comparison
      { name: "Preview with channelId + extension (comparison)", payload: payloadXml1, extension: buildChannelExtensionXml(channelId) },
    ];

    let bestFrame: { frame: any; variant: string } | undefined;

    for (const variant of variants) {
      log(`Testing variant: ${variant.name}`);
      
      try {
        const frame = await api.client.sendFrame({
          cmdId: 3, // MSG_ID_VIDEO
          channel,
          payloadXml: variant.payload,
          extensionXml: variant.extension,
          messageClass: 0x6414, // BC_CLASS_MODERN_24
          streamType: 1, // sub stream
        });

        log(`Variant response "${variant.name}"`, {
          responseCode: frame.header.responseCode,
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          note: frame.header.responseCode === 200 ? "SUCCESS" : frame.header.responseCode === 421 ? "421" : `${frame.header.responseCode}`,
        });

        if (frame.header.responseCode === 200) {
          logSuccess(`Found a working variant: "${variant.name}" (response_code 200)`);
          bestFrame = { frame, variant: variant.name };
          break; // Found, exit
        } else if (frame.header.responseCode === 421 && !bestFrame) {
          // 421 is better than 400, but not ideal.
          bestFrame = { frame, variant: variant.name };
        }

        // Pause between tests
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        logError(`Variant error "${variant.name}"`, error);
      }
    }

    if (!bestFrame) {
      logError("No variant worked", new Error("All variants failed"));
      return;
    }

    log(`Best variant: "${bestFrame.variant}" (response_code ${bestFrame.frame.header.responseCode})`);
    
    // Even with response_code 421 it might still work - keep listening.

    // Wait 30 seconds to gather frames.
    logSuccess("Waiting 30 seconds to gather video frames...");
    log("Make sure there is video activity on the camera (motion, etc.)");
    log("Analyzing ALL received frames, not only cmd_id=3");
    
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Results
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    FRAME ANALYSIS                          ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\nPush events received: ${pushEventCount}`);
    console.log(`Unique frame types: ${frameAnalysis.size}\n`);

    // Ordina per frequenza
    const frameCounts = new Map<string, number>();
    for (const f of allFrames) {
      const key = `${f.header.cmdId}:${f.header.streamType}:${f.header.channelId}`;
      frameCounts.set(key, (frameCounts.get(key) || 0) + 1);
    }

    const sortedFrames = Array.from(frameAnalysis.entries()).sort((a, b) => {
      const countA = frameCounts.get(a[0]) || 0;
      const countB = frameCounts.get(b[0]) || 0;
      return countB - countA;
    });

    for (const [key, analysis] of sortedFrames) {
      const count = frameCounts.get(key) || 0;
      const percentage = ((count / pushEventCount) * 100).toFixed(2);

      log(`Frame Type: cmdId=${analysis.cmdId}, streamType=${analysis.streamType}, channelId=${analysis.channelId}`, {
        count,
        percentage: `${percentage}%`,
        bodyLen: analysis.bodyLen,
        type: analysis.isXml ? "XML" : analysis.isBinary ? "Binary" : "Unknown",
        firstBytes: analysis.firstBytes,
        hasNalUnits: analysis.hasNalUnits,
        nalUnitTypes: analysis.nalUnitTypes,
        decryptedPreview: analysis.decryptedPreview ? `${analysis.decryptedPreview.substring(0, 128)}...` : undefined,
      });

      if (analysis.hasNalUnits) {
        logSuccess(`Found video frames with NAL units`);
        log(`   NAL unit types: ${analysis.nalUnitTypes?.map(t => {
          const names: Record<number, string> = {
            1: "Non-IDR",
            5: "IDR (I-frame)",
            6: "SEI",
            7: "SPS",
            8: "PPS",
          };
          return `${t} (${names[t] || "Other"})`;
        }).join(", ")}`);
        log(`   Decrypted preview (hex): ${analysis.decryptedPreview}`);
      }
    }

    // Identifica possibili frame video
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║           IDENTIFICAZIONE FRAME VIDEO                      ║");
    console.log("╚════════════════════════════════════════════════════════════╝");

    const videoFrames = sortedFrames.filter(([_, a]) => a.hasNalUnits);
    if (videoFrames.length > 0) {
      logSuccess(`Found ${videoFrames.length} frame types with NAL units`);
      for (const [key, analysis] of videoFrames) {
        log(`Frame Video`, {
          cmdId: analysis.cmdId,
          streamType: analysis.streamType,
          channelId: analysis.channelId,
          count: frameCounts.get(key),
          nalUnitTypes: analysis.nalUnitTypes,
        });
      }
    } else {
      logError("No video frames identified with NAL units", new Error("No video frames found"));
      console.log("\nHints:");
      console.log("   - Video frames may be encapsulated in a different format");
      console.log("   - A subscribe mechanism (like neolink) may be required");
      console.log("   - Verify whether cmd_id 3 frames contain video data");
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

testVideoStreamDetailed().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

