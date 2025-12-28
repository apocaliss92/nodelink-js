#!/usr/bin/env node
/**
 * Test script to save Baichuan video frames locally and then merge them into a video.
 *
 * 1. Save video frames to a folder for 10-15 seconds
 * 2. Try different approaches to merge frames into a video using ffmpeg
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BaichuanVideoStream } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
// @ts-expect-error - Path resolution at runtime
import type { StreamProfile } from "../../index.js";

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
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 5).join("\n")}`);
    }
  } else {
    console.error(`   Details: ${error}`);
  }
}

/**
 * Merges video frames using ffmpeg with different approaches.
 */
async function mergeFramesWithFfmpeg(
  framesDir: string,
  outputFile: string,
  approach: "concat" | "pipe" | "image2" | "h264",
  fps: number = 10
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Merging frames (approach: ${approach})`, { outputFile, fps });

    let ffmpegArgs: string[] = [];
    
    if (approach === "concat") {
      // Approach 1: Concatenate all frames into a single file and run ffmpeg
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
        .sort()
        .map(f => path.join(framesDir, f));
      
      // Concatenate all frames into a single buffer
      const allFrames = Buffer.concat(
        frameFiles.map(f => fs.readFileSync(f))
      );
      
      // Save temporary concatenated file
      const concatFile = path.join(framesDir, "all_frames.h264");
      fs.writeFileSync(concatFile, allFrames);
      
      ffmpegArgs = [
        "-f", "h264", // Input format H.264 raw
        "-i", concatFile,
        "-c:v", "libx264", // Re-encode to improve compatibility
        "-preset", "ultrafast",
        "-crf", "23",
        "-r", fps.toString(), // Frame rate
        "-y",
        outputFile,
      ];
    } else if (approach === "pipe") {
      // Approach 2: Pipe all concatenated frames to ffmpeg
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
        .sort()
        .map(f => path.join(framesDir, f));
      
      const allFrames = Buffer.concat(
        frameFiles.map(f => fs.readFileSync(f))
      );
      
      const ffmpeg = spawn("ffmpeg", [
        "-f", "h264", // Input format H.264 raw
        "-i", "pipe:0",
        "-c:v", "libx264", // Re-encode to improve compatibility
        "-preset", "ultrafast",
        "-crf", "23",
        "-r", fps.toString(), // Frame rate
        "-y",
        outputFile,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      
      ffmpeg.stdin.write(allFrames);
      ffmpeg.stdin.end();
      
      let stderr = "";
      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          logSuccess(`Video created with approach ${approach}: ${outputFile}`);
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        }
      });
      
      ffmpeg.on("error", (error) => {
        reject(new Error(`ffmpeg spawn error: ${error.message}`));
      });
      
      return; // Early return for pipe approach
    } else if (approach === "image2") {
      // Approach 3: Treat frames as images (not applicable for raw H.264 frames)
      reject(new Error("image2 approach is not applicable for raw H.264 frames"));
      return;
    } else if (approach === "h264") {
      // Approach 4: Concatenate frames and use -f h264 with copy (no re-encoding)
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
        .sort()
        .map(f => path.join(framesDir, f));
      
      // Concatenate all frames into a single buffer
      const allFrames = Buffer.concat(
        frameFiles.map(f => fs.readFileSync(f))
      );
      
      // Save temporary concatenated file
      const concatFile = path.join(framesDir, "all_frames.h264");
      fs.writeFileSync(concatFile, allFrames);
      
      ffmpegArgs = [
        "-f", "h264", // Input format H.264 raw
        "-i", concatFile,
        "-c:v", "copy", // Copy codec (no re-encoding) - faster
        "-fflags", "+genpts", // Generate PTS
        "-r", fps.toString(), // Frame rate
        "-y",
        outputFile,
      ];
    }

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Video created with approach ${approach}: ${outputFile}`);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
      }
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`ffmpeg spawn error: ${error.message}`));
    });
  });
}

async function testSaveAndMerge() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: SAVE AND MERGE VIDEO FRAMES                     ║");
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
    uid: (config.tcp as any).uid,
    transport: "tcp",
    debug: false,
  });

  const channel = 0;
  const profile: StreamProfile = "sub";
  const saveDuration = 15; // seconds
  const framesDir = path.join(process.cwd(), "test", "frames-save");
  const recordingsDir = path.join(process.cwd(), "test", "recordings");

  // Create output directories if they don't exist
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  // Clean up previous frame files
  const existingFrames = fs.readdirSync(framesDir);
  for (const file of existingFrames) {
    fs.unlinkSync(path.join(framesDir, file));
  }

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Check available profiles
    log("Checking available profiles");
    const streamMetadata = await api.getStreamMetadata(channel);
    logSuccess("Stream metadata fetched");
    
    if (streamMetadata && streamMetadata.streams) {
      const stream = streamMetadata.streams.find((s: { profile: string }) => s.profile === profile);
      if (stream) {
          log(`Profile ${profile} found`, {
          width: stream.width,
          height: stream.height,
          fps: stream.frameRate,
        });
      }
    }

    // Create BaichuanVideoStream
    log(`Creating video stream for profile ${profile}`);
    const videoStream = new BaichuanVideoStream({
      client: api.client,
      api,
      channel,
      profile,
    });

    // Save video frames
    let frameCount = 0;
    let startTime = Date.now();
    const maxDuration = saveDuration * 1000; // Converti in millisecondi
    let totalBytes = 0;
    let lastFrameFile: string | null = null;

    videoStream.on("videoFrame", (frame: Buffer) => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxDuration) {
        return; // Stop saving after max duration
      }

      frameCount++;
      totalBytes += frame.length;
      const frameFile = path.join(framesDir, `frame_${frameCount.toString().padStart(5, "0")}.h264`);
      fs.writeFileSync(frameFile, frame);
      lastFrameFile = frameFile;

      if (frameCount % 10 === 0 || frameCount <= 5) {
        console.log(`[Save] Saved ${frameCount} video frames (${(elapsed / 1000).toFixed(1)}s, ${(totalBytes / 1024).toFixed(1)} KB, avg: ${(totalBytes / frameCount / 1024).toFixed(2)} KB/frame)`);
      }
    });

    videoStream.on("error", (error: Error) => {
      logError(`Video stream error`, error);
    });

    // Start video stream
    log(`Starting video stream for profile ${profile}`);
    await videoStream.start();
    logSuccess("Video stream started");

    // Wait for frames for the requested duration.
    log(`Waiting ${saveDuration} seconds to save frames...`);
    await new Promise((resolve) => setTimeout(resolve, maxDuration + 1000)); // +1s margin

    // Stop video stream
    await videoStream.stop();
    logSuccess(`Video stream stopped. Saved ${frameCount} total frames`);

    // Verify saved frames
    const savedFrames = fs.readdirSync(framesDir)
      .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
      .sort();
    
    if (savedFrames.length === 0) {
      logError("No frames saved", new Error("No frames saved"));
      return;
    }

    log(`Saved frames: ${savedFrames.length}`);
    
    // Estimate FPS
    const actualDuration = (Date.now() - startTime) / 1000;
    let estimatedFps = savedFrames.length / actualDuration;
    
    // If FPS is too low/invalid, fall back to metadata.
    if (estimatedFps < 1 || isNaN(estimatedFps)) {
      if (streamMetadata && streamMetadata.streams) {
        const stream = streamMetadata.streams.find((s: { profile: string }) => s.profile === profile);
        if (stream && stream.frameRate) {
          estimatedFps = stream.frameRate;
          log(`FPS too low/invalid, using metadata FPS: ${estimatedFps}`);
        } else {
          estimatedFps = 10; // Default fallback
          log(`FPS not available, using default: ${estimatedFps}`);
        }
      } else {
        estimatedFps = 10; // Default fallback
        log(`FPS not available, using default: ${estimatedFps}`);
      }
    }
    
    log(`Final FPS: ${estimatedFps.toFixed(2)}`);

    // Try different merge approaches
    const approaches: Array<"concat" | "pipe" | "h264"> = ["concat", "pipe", "h264"];
    
    for (const approach of approaches) {
      try {
        const outputFile = path.join(recordingsDir, `merged_${profile}_${approach}_${Date.now()}.mp4`);
        log(`\nTrying approach: ${approach}`);
        
        // Ensure FPS is at least 1
        const fpsToUse = Math.max(1, Math.round(estimatedFps));
        await mergeFramesWithFfmpeg(framesDir, outputFile, approach, fpsToUse);
        
        // Verify created file
        if (fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          logSuccess(`Video created: ${outputFile} (${stats.size} bytes)`);
          
          // Verify with ffprobe
          try {
            const ffprobe = spawn("ffprobe", [
              "-v", "error",
              "-show_format",
              "-show_streams",
              outputFile,
            ], {
              stdio: ["ignore", "pipe", "pipe"],
            });
            
            let probeOutput = "";
            ffprobe.stdout.on("data", (data) => {
              probeOutput += data.toString();
            });
            
            await new Promise<void>((resolve, reject) => {
              ffprobe.on("close", (code) => {
                if (code === 0) {
                  // Estrai informazioni chiave
                  const durationMatch = probeOutput.match(/duration=([\d.]+)/);
                  const widthMatch = probeOutput.match(/width=(\d+)/);
                  const heightMatch = probeOutput.match(/height=(\d+)/);
                  
                  if (durationMatch || widthMatch || heightMatch) {
                    log(`Video info`, {
                      duration: durationMatch ? `${durationMatch[1]}s` : "unknown",
                      resolution: widthMatch && heightMatch ? `${widthMatch[1]}x${heightMatch[1]}` : "unknown",
                    });
                  }
                  resolve();
                } else {
                  reject(new Error(`ffprobe exited with code ${code}`));
                }
              });
            });
          } catch (error) {
            console.warn(`[WARN] Could not analyze video: ${error}`);
          }
        }
      } catch (error) {
        logError(`Error with approach ${approach}`, error);
      }
    }

    logSuccess("All tests completed!");

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

testSaveAndMerge().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

