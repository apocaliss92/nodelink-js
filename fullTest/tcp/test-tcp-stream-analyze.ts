#!/usr/bin/env node
/**
 * Baichuan video stream analysis.
 * Connects to the TCP device and analyzes all received frames to understand
 * how Baichuan video streaming works and to identify candidate video frames.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index";
import { config } from "../env";

// Helper functions
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[INFO] ${message}`);
  if (data !== undefined) {
    if (data instanceof Buffer) {
      console.log(`   Buffer: ${data.length} bytes`);
      console.log(`   Hex preview (first 64 bytes): ${data.subarray(0, Math.min(64, data.length)).toString("hex")}`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
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
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 3).join("\n")}`);
    }
  } else {
    console.error(`   Details: ${error}`);
  }
}

interface FrameStats {
  cmdId: number;
  streamType: number;
  channelId: number;
  bodyLen: number;
  count: number;
  samples: BaichuanFrame[];
  isXml: boolean;
  isBinary: boolean;
  firstBytes: string;
}

async function analyzeBaichuanStream() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     BAICHUAN VIDEO STREAM ANALYSIS (TCP)                  ║");
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
  const frameStats = new Map<string, FrameStats>();
  const analysisDuration = 30000; // 30 seconds (more time to capture video frames)

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Fetch stream metadata to see which profiles are available.
    log(`Fetching stream metadata for channel ${channel}`);
    const metadata = await api.getStreamMetadata(channel);
    logSuccess(`Available streams: ${metadata.streams.length}`);
    for (const stream of metadata.streams) {
      log(`Stream ${stream.profile.toUpperCase()}`, {
        profile: stream.profile,
        resolution: `${stream.width}x${stream.height}`,
        fps: stream.frameRate,
        codec: stream.videoEncType,
        bitrate: `${stream.bitRate} kbps`,
        audio: stream.audio === 1 ? "Yes" : "No",
      });
    }

    // Listen to all push events.
    log(`Starting push-event analysis for ${analysisDuration / 1000} seconds...`);
    log("Make sure there is video activity on the camera (motion, etc.)");
    
    const startTime = Date.now();
    let totalFrames = 0;

    api.client.on("push", (frame: BaichuanFrame) => {
      totalFrames++;
      
      const key = `${frame.header.cmdId}:${frame.header.streamType}:${frame.header.channelId}`;
      
      if (!frameStats.has(key)) {
        const bodyStr = frame.body.toString("utf8", 0, Math.min(100, frame.body.length));
        const isXml = bodyStr.startsWith("<?xml") || bodyStr.startsWith("<");
        
        frameStats.set(key, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          count: 0,
          samples: [],
          isXml,
          isBinary: !isXml,
          firstBytes: frame.body.subarray(0, Math.min(32, frame.body.length)).toString("hex"),
        });
      }

      const stats = frameStats.get(key)!;
      stats.count++;
      
      // Keep only the first 3 samples per frame type.
      if (stats.samples.length < 3) {
        stats.samples.push(frame);
      }
    });

    // Wait for data collection
    await new Promise((resolve) => setTimeout(resolve, analysisDuration));

    // Results
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║              FRAME ANALYSIS RESULTS                       ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\nTotal frames received: ${totalFrames}`);
    console.log(`Unique frame types: ${frameStats.size}\n`);

    // Sort by frequency (most frequent first)
    const sortedStats = Array.from(frameStats.values()).sort((a, b) => b.count - a.count);

    for (const stats of sortedStats) {
      log(`Frame Type: cmdId=${stats.cmdId}, streamType=${stats.streamType}, channelId=${stats.channelId}`, {
        count: stats.count,
        bodyLen: stats.bodyLen,
        type: stats.isXml ? "XML" : stats.isBinary ? "Binary" : "Unknown",
        firstBytes: stats.firstBytes,
        percentage: `${((stats.count / totalFrames) * 100).toFixed(2)}%`,
      });

      // More detailed analysis for binary frames (likely video).
      if (stats.isBinary && stats.bodyLen > 50) {
        log(`Detailed analysis of binary frame (possible video)`);
        
        const sample = stats.samples[0];
        if (sample) {
          // Try decrypting
          try {
            const decrypted = api.client.tryDecryptBinary(
              sample.body,
              sample.header.channelId,
              api.client.enc
            );
            
            log(`   Decrypted body length: ${decrypted.length} bytes`);
            log(`   Decrypted first 64 bytes (hex): ${decrypted.subarray(0, Math.min(64, decrypted.length)).toString("hex")}`);
            
            // Look for H.264/H.265 start codes (0x00000001 or 0x000001).
            const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
            const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
            
            if (nalStart1 !== -1 || nalStart2 !== -1) {
              logSuccess(`Found NAL start code pattern (possible H.264/H.265 video frame)`);
              log(`NAL start code position: ${nalStart1 !== -1 ? nalStart1 : nalStart2}`);
              
              // Analyze NAL unit type
              const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
              if (nalPos < decrypted.length) {
                const nalType = decrypted[nalPos]! & 0x1F;
                log(`   NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : "Other"})`);
              }
            } else {
              log(`No NAL start code pattern found (may be encapsulated)`);
            }
          } catch (error) {
            logError(`Decryption error`, error);
          }
        }
      }
    }

    // Identify possible video frames
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║           VIDEO FRAME IDENTIFICATION                      ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    
    const possibleVideoFrames = sortedStats.filter((s) => {
      return s.isBinary && 
             s.bodyLen > 50 && // Lower threshold to capture more frames
             s.streamType === 0; // streamType 0 is likely video
    });

    if (possibleVideoFrames.length > 0) {
      logSuccess(`Found ${possibleVideoFrames.length} candidate video frame types:`);
      for (const frame of possibleVideoFrames) {
        log(`Candidate video frame`, {
          cmdId: frame.cmdId,
          streamType: frame.streamType,
          channelId: frame.channelId,
          count: frame.count,
          avgBodyLen: frame.bodyLen,
        });
      }
    } else {
      log("No video frames identified. Try increasing the analysis duration or ensure there is video activity.");
    }

    // Suggestions
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    SUGGESTIONS                            ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\nTo identify the video stream:");
    console.log("1. Video frames likely have:");
    console.log("   - streamType = 0 (video)");
    console.log("   - binary body (not XML)");
    console.log("   - significant size (>100 bytes)");
    console.log("   - a specific cmd_id (to be identified)");
    console.log("\n2. Video frames contain H.264/H.265 NAL units");
    console.log("   - Pattern: 0x00000001 or 0x000001");
    console.log("   - They may be encapsulated in a Baichuan header");
    console.log("\n3. To request the video stream, you may need to:");
    console.log("   - Send a specific command (cmd_id to be identified)");
    console.log("   - Specify the stream profile (main/sub/ext)");
    console.log("   - Then receive video frames via push events\n");

  } catch (error) {
    logError("Fatal error during analysis", error);
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

// Run analysis
analyzeBaichuanStream().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

