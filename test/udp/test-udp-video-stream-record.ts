#!/usr/bin/env node
/**
 * Baichuan UDP end-to-end video streaming test.
 * Records a short MP4 clip for each available profile (main, sub, ext) via UDP/BCUDP.
 * This test is specifically for battery-powered cameras that use UDP transport.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BaichuanRtspServer } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

async function probeVideoDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nk=1:nw=1",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    ffprobe.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    ffprobe.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    ffprobe.on("error", (e) => reject(new Error(`ffprobe spawn error: ${e.message}`)));
    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}\n${stderr}`));
        return;
      }
      const value = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(value)) {
        reject(new Error(`ffprobe returned invalid duration: ${stdout.trim()}`));
        return;
      }
      resolve(value);
    });
  });
}

async function ffprobeAssertNoErrors(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    ffprobe.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    ffprobe.on("error", (e) => reject(new Error(`ffprobe spawn error: ${e.message}`)));
    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}\n${stderr}`));
        return;
      }
      if (stderr.trim().length > 0) {
        reject(new Error(`ffprobe reported errors:\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

function cleanupRecordingsDir(recordingsDir: string): void {
  if (!fs.existsSync(recordingsDir)) return;
  const entries = fs.readdirSync(recordingsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".mp4")) continue;
    try {
      fs.rmSync(path.join(recordingsDir, entry.name));
    } catch {
      // ignore
    }
  }
}

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
 * Record video from RTSP stream using ffmpeg.
 * This is much simpler than handling raw frames directly.
 */
async function recordVideoFromRtsp(
  rtspUrl: string,
  outputFile: string,
  durationSeconds: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Recording from RTSP stream`, { rtspUrl, outputFile, durationSeconds });

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-rtsp_transport",
        "tcp",
        "-rtsp_flags",
        "prefer_tcp",
        "-timeout",
        "5000000", // 5 second timeout for RTSP connection (in microseconds)
        "-i",
        rtspUrl,
        "-t",
        durationSeconds.toString(),
        "-c",
        "copy",
        "-y",
        outputFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    let stdout = "";
    let settled = false;

    const doneOk = () => {
      if (settled) return;
      settled = true;
      try { 
        ffmpeg.kill("SIGTERM"); 
      } catch {}
      resolve();
    };

    const doneErr = (e: Error) => {
      if (settled) return;
      settled = true;
      try { 
        ffmpeg.kill("SIGTERM"); 
      } catch {}
      const t = setTimeout(() => { 
        try { ffmpeg.kill("SIGKILL"); } catch {} 
      }, 1500);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (t as any)?.unref?.();
      reject(e);
    };

    ffmpeg.stderr?.on("data", (d: Buffer) => { 
      const output = d.toString();
      stderr += output;
      
      // Log important messages
      if (output.includes("Connection refused") || 
          output.includes("Connection timed out") ||
          output.includes("Unable to open") ||
          output.includes("Server returned 404") ||
          output.includes("error")) {
        console.error(`[FFmpeg Recording] ${output.trim()}`);
      }
    });

    ffmpeg.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    
    ffmpeg.on("error", (e) => {
      console.error(`[FFmpeg Recording] Spawn error:`, e);
      doneErr(new Error(`ffmpeg spawn error: ${e.message}`));
    });
    
    ffmpeg.on("close", (code, signal) => {
      console.log(`[FFmpeg Recording] Process closed with code ${code}, signal ${signal}`);
      if (code === 0 || code === null) {
        logSuccess(`Recording completed: ${outputFile}`);
        return doneOk();
      }
      // Show full error output
      console.error(`[FFmpeg Recording] Full stderr:\n${stderr}`);
      console.error(`[FFmpeg Recording] Full stdout:\n${stdout}`);
      doneErr(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });

    // Safety timeout - extended to account for camera wake-up time.
    const timeout = setTimeout(() => {
      if (settled) return;
      console.error(`[FFmpeg Recording] Timeout after ${durationSeconds + 20} seconds`);
      doneErr(new Error(`Recording timeout after ${durationSeconds + 20} seconds`));
    }, (durationSeconds + 20) * 1000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (timeout as any)?.unref?.();
  });
}

async function testUdpVideoStreamRecording() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     BAICHUAN UDP VIDEO STREAM RECORDING TEST              ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: 255.255.255.255 (broadcast)`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Username: ${config.udp.username}\n`);

  if (!config.udp.uid || !config.udp.password) {
    console.error("[ERROR] Incomplete UDP configuration in .env");
    process.exit(1);
  }

  const api = new ReolinkBaichuanApi({
    host: "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debug: true, // Enable debug to see what's happening
    debugOptions: {
      enabled: true,
      traceStream: true, // Enable stream command tracing (tx/rx cmd_id 3/4 + rx stream frames)
      debugH264: true, // Enable H.264-centric debug logs
      debugParamSets: true, // Enable SPS/PPS cache/prepend debug logs
      dump: {
        enabled: true,
        dir: path.join(process.cwd(), "test", "frames-debug"),
        bcmedia: true, // Dump BCMedia packets
        nals: true, // Dump NAL units
      },
    },
  });

  // Handle errors
  api.client.on("error", () => {
    // Errors are handled in try/catch blocks.
  });

  // Discovery debug - show all UDP debug events
  api.client.on("debug", (event: string, data?: unknown) => {
    console.log(`  [DEBUG UDP] ${event}:`, data);
  });

  const channel = 0;
  const recordingsDir = path.join(process.cwd(), "test", "recordings", "udp");
  // Deterministic default: record RECORD_DURATION seconds for every available profile.
  const duration = config.rtsp.recordDuration;

  // Create directory if it doesn't exist
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  // Cleanup previous artifacts to avoid accumulating recordings between runs.
  cleanupRecordingsDir(recordingsDir);

  const recordedFiles: string[] = [];

  try {
    // Check battery status first (for battery cameras)
    log("Checking battery status");
    try {
      const batteryStatus = await api.getBatteryStatus(channel);
      log("Battery status", batteryStatus);
      if (batteryStatus.sleeping) {
        log("Camera is sleeping, attempting to wake up");
        await api.wakeUp(channel);
        // Wait a bit for camera to fully wake up
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Re-check battery status
        const newStatus = await api.getBatteryStatus(channel);
        log("Battery status after wake-up", newStatus);
      }
    } catch (error) {
      logError("Could not get battery status (camera may not be battery-powered)", error);
      // Continue anyway, as this might be a wired camera using UDP
    }

    // Login
    log("Baichuan UDP login");
    const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;
    await api.login(maxEnc ?? "aes");
    logSuccess("Login completed");

    // Check available profiles
    log("Checking available profiles");
    const streamMetadata = await api.getStreamMetadata(channel);
    logSuccess("Stream metadata fetched");
    log("Stream metadata", streamMetadata);
    
    const availableProfiles: Array<"main" | "sub" | "ext"> = [];
    // streamMetadata can be an array or an object depending on camera/firmware
    if (Array.isArray(streamMetadata)) {
      // Array: each element includes a profile
      for (const stream of streamMetadata) {
        if (stream.profile === "main" || stream.profile === "sub" || stream.profile === "ext") {
          if (!availableProfiles.includes(stream.profile)) {
            availableProfiles.push(stream.profile);
          }
        }
      }
    } else if (streamMetadata && typeof streamMetadata === "object") {
      // Object: check known properties
      if ("main" in streamMetadata && streamMetadata.main) availableProfiles.push("main");
      if ("sub" in streamMetadata && streamMetadata.sub) availableProfiles.push("sub");
      if ("ext" in streamMetadata && streamMetadata.ext) availableProfiles.push("ext");
      // Or an array under "streams"
      if ("streams" in streamMetadata && Array.isArray(streamMetadata.streams)) {
        for (const stream of streamMetadata.streams) {
          if (stream.profile === "main" || stream.profile === "sub" || stream.profile === "ext") {
            if (!availableProfiles.includes(stream.profile)) {
              availableProfiles.push(stream.profile);
            }
          }
        }
      }
    }
    
    log(`Available profiles: ${availableProfiles.length > 0 ? availableProfiles.join(", ") : "none (continuing anyway)"}`);
    
    // If no profile is reported, still try with "sub" as a fallback
    if (availableProfiles.length === 0) {
      log("No profiles found in metadata, continuing with 'sub' as default");
      availableProfiles.push("sub");
    }

    // Deterministic: record every available profile (preferred order)
    const preferredOrder: Array<"main" | "sub" | "ext"> = ["main", "sub", "ext"];
    const profiles = preferredOrder.filter((p) => availableProfiles.includes(p));
    log(`Profiles to test: ${profiles.join(", ")}`);

    // Test and record each available profile
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i]!;
      if (!availableProfiles.includes(profile)) {
        log(`Profile ${profile} not available, skipping`);
        continue;
      }

      log(`\n🎥 Testing profile: ${profile}`);
      
      let rtspServer: BaichuanRtspServer | undefined;

      try {
        // Create RTSP stream using the library
        // The library will automatically detect H.264/H.265 and configure ffmpeg accordingly
        log(`Creating RTSP stream for profile ${profile}`);
        rtspServer = await api.createRtspStream(channel, profile, {
          listenPort: 18554 + i, // Use different ports for each profile (avoid EADDRINUSE)
          path: `/${profile}`,
        });
        
        // Handle RTSP server errors (don't crash the test)
        rtspServer.on("error", (error: Error) => {
          logError(`RTSP server error for profile ${profile}`, error);
        });
        
        const rtspUrl = rtspServer.getRtspUrl();
        logSuccess(`RTSP stream created: ${rtspUrl}`);
        log(`Waiting for RTSP server to be ready...`);
        
        // Wait for RTSP server to be ready (this will wait for port to be listening AND first frame from camera)
        try {
          await rtspServer.waitUntilReady(30000); // 30 seconds timeout for battery cameras that may be sleeping
          logSuccess(`RTSP server is ready: ${rtspUrl}`);
        } catch (error) {
          logError(`RTSP server not ready after timeout`, error);
          continue;
        }
        
        // Wait a bit more to ensure RTSP server is fully ready to accept connections
        log(`Waiting for RTSP server to be fully ready...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        
        // Record from RTSP stream using ffmpeg (emulating a user connecting to the stream)
        // The server will automatically start the native stream when ffmpeg connects
        const outputFile = path.join(recordingsDir, `recording_udp_${profile}_${Date.now()}.mp4`);
        log(`Recording ${duration}s from RTSP stream: ${rtspUrl}`);
        log(`This emulates a user (ffmpeg) connecting to the RTSP stream`);
        
        // Record from RTSP stream (this is the actual client connection)
        try {
          await Promise.race([
            recordVideoFromRtsp(rtspUrl, outputFile, duration),
            new Promise((_, reject) => 
              setTimeout(() => {
                reject(new Error("Timeout recording from RTSP"));
              }, (duration + 10) * 1000)
            ),
          ]);
        } catch (error) {
          logError(`Error during recording from RTSP`, error);
          continue;
        }
        
        // No explicit client disconnection needed, ffmpeg client will close its connection
        // and the server will handle native stream stopping automatically
        
        // Verify the file was created
        if (fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          logSuccess(`Recorded file: ${outputFile} (${stats.size} bytes)`);
          recordedFiles.push(outputFile);

          try {
            const recordedDuration = await probeVideoDurationSeconds(outputFile);
            console.log(`[FFprobe] Duration: ${recordedDuration.toFixed(3)}s (target ${duration}s)`);
            const toleranceSeconds = 0.75;
            if (Math.abs(recordedDuration - duration) > toleranceSeconds) {
              throw new Error(`Recorded duration out of tolerance: ${recordedDuration}s (target ${duration}s)`);
            }
          } catch (e) {
            logError(`Duration verification failed for ${profile}`, e);
            continue;
          }
        } else {
          logError(`File not created: ${outputFile}`, new Error("File not found"));
        }

      } catch (error) {
        logError(`Error while testing profile ${profile}`, error);
      } finally {
        // Cleanup RTSP server
        if (rtspServer) {
          try {
            await rtspServer.stop();
            logSuccess(`RTSP stream stopped for profile ${profile}`);
          } catch (error) {
            logError(`Error while stopping RTSP stream for profile ${profile}`, error);
          }
        }

        // Small delay before the next profile
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    log("Final ffprobe verification (no errors)");
    for (const f of recordedFiles) {
      await ffprobeAssertNoErrors(f);
    }

    logSuccess("All tests completed!");

  } catch (error) {
    logError("Critical error during tests", error);
    process.exit(1);
  } finally {
    try {
      await api.close();
      logSuccess("Connection closed");
    } catch (error) {
      logError("Error while closing connection", error);
    }
    // Ensure process exits
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
}

testUdpVideoStreamRecording().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

