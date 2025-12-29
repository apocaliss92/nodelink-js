#!/usr/bin/env node
/**
 * Baichuan end-to-end video streaming test.
 * Records a short MP4 clip for each available profile (main, sub, ext).
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

async function recordVideoFromUrl(inputUrl: string, outputFile: string, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Recording video`, { inputUrl, outputFile, duration });
    
    const u = new URL(inputUrl);
    const inputArgs: string[] = [];
    // Only for RTSP it makes sense to force rtsp_transport.
    if (u.protocol === "rtsp:") {
      inputArgs.push("-rtsp_transport", "tcp");
    }

    // ffmpeg -i <url> -t 5 -c copy output.mp4
    // Note: ffmpeg can be "quiet" and not print frame=; we also track the output file growth.
    const ffmpeg = spawn(
      "ffmpeg",
      [
        ...inputArgs,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-stats",
        "-i",
        inputUrl,
        "-t",
        duration.toString(),
        "-c",
        "copy", // Copy codec (no re-encoding)
        "-y", // Overwrite output file
        outputFile,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let settled = false;
    let stderr = "";
    let hasStarted = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let startedPoll: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      if (killTimer) clearTimeout(killTimer);
      killTimer = undefined;
      if (startedPoll) clearInterval(startedPoll);
      startedPoll = undefined;
      // Avoid listener leaks (helps the process exit cleanly).
      ffmpeg.removeAllListeners();
      ffmpeg.stderr?.removeAllListeners();
      ffmpeg.stdout?.removeAllListeners();
    };

    const killFfmpeg = () => {
      try {
        ffmpeg.kill("SIGTERM");
      } catch {
        // ignore
      }
      // If it doesn't exit, force SIGKILL (otherwise Node may hang).
      killTimer = setTimeout(() => {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1500);
      // Don't keep the process alive.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (killTimer as any)?.unref?.();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      killFfmpeg();
      cleanup();
      reject(err);
    };

    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    
    ffmpeg.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      stderr += output;
      
      // Mark when ffmpeg starts receiving/processing stream data.
      if (!hasStarted && (output.includes("Stream") || output.includes("frame="))) {
        hasStarted = true;
          console.log(`[FFmpeg Record] Stream started`);
      }
      
      // Log critical errors (ignore common decode warnings).
      if (output.includes("error") && !output.includes("top block unavailable") && !output.includes("error while decoding MB")) {
        console.error(`[FFmpeg Record] ${output.trim()}`);
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Recording completed: ${outputFile}`);
        ok();
      } else {
        // Exit code 1 can be normal if the stream ends early after producing output.
        if (code === 1 && hasStarted) {
          logSuccess(`Recording completed (exit code ${code}): ${outputFile}`);
          ok();
        } else {
          fail(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        }
      }
    });

    ffmpeg.on("error", (error) => {
      fail(new Error(`ffmpeg spawn error: ${error.message}`));
    });
    
    // Mark started even if ffmpeg doesn't print "frame=" (check output file growth)
    const markStartedIfOutputGrows = () => {
      if (hasStarted) return;
      try {
        if (fs.existsSync(outputFile)) {
          const s = fs.statSync(outputFile);
          if (s.size > 0) {
            hasStarted = true;
            console.log(`[FFmpeg Record] Output file started (size=${s.size} bytes)`);
          }
        }
      } catch {
        // ignore
      }
    };
    startedPoll = setInterval(markStartedIfOutputGrows, 400);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (startedPoll as any)?.unref?.();

    // Soft safety timeout: fail only if it never really starts (no logs and no output file growth).
    timeout = setTimeout(() => {
      markStartedIfOutputGrows();
      if (!hasStarted) {
        fail(new Error(`Timeout: ffmpeg did not start producing output within 10 seconds`));
      }
    }, 10000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (timeout as any)?.unref?.();
  });
}

async function recordVideoFromRtsp(rtspUrl: string, outputFile: string, durationSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Recording video from RTSP`, { rtspUrl, outputFile, durationSeconds });

    let recordingStarted = false;
    let stopRequested = false;
    
    // ffmpeg -i <rtsp_url> -c copy output.mp4
    // We stop ffmpeg via wallclock timer once output starts, because some streams may not have
    // reliable timestamps for ffmpeg's -t.
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      "-i", rtspUrl,
      "-t", durationSeconds.toString(),
      "-c", "copy", // Copy codec (no re-encoding)
      "-y", // Overwrite output file
      outputFile,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stderr = "";
    let hasStarted = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let startedPoll: NodeJS.Timeout | undefined;
    let safetyKill: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      if (killTimer) clearTimeout(killTimer);
      killTimer = undefined;
      if (startedPoll) clearInterval(startedPoll);
      startedPoll = undefined;
      if (safetyKill) clearTimeout(safetyKill);
      safetyKill = undefined;
      ffmpeg.removeAllListeners();
      ffmpeg.stderr?.removeAllListeners();
      ffmpeg.stdout?.removeAllListeners();
    };

    const killFfmpeg = () => {
      try {
        ffmpeg.kill("SIGTERM");
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1500);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (killTimer as any)?.unref?.();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      killFfmpeg();
      cleanup();
      reject(err);
    };

    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    
    ffmpeg.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      stderr += output;
      
      // Detect when first frame arrives (ffmpeg starts processing)
      if (!recordingStarted && (output.includes("frame=") || output.includes("time=") || output.includes("Stream #"))) {
        recordingStarted = true;
        hasStarted = true;
        console.log(`[FFmpeg Recording] Stream started; target duration ${durationSeconds}s`);
      }
      
      // Log all ffmpeg output for debugging
      if (output.includes("error") || output.includes("Error") || output.includes("Invalid") || output.includes("Connection")) {
        console.error(`[FFmpeg Recording] ${output.trim()}`);
      }
      
      // Log progress
      if (output.includes("time=")) {
        const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (timeMatch) {
          console.log(`[FFmpeg Recording] Progress: ${timeMatch[1]}`);
        }
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Recording completed: ${outputFile}`);
        ok();
      } else {
        if ((code === 1 && hasStarted) || (stopRequested && hasStarted)) {
          logSuccess(`Recording completed (exit code ${code}): ${outputFile}`);
          ok();
        } else {
          fail(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        }
      }
    });

    ffmpeg.on("error", (error) => {
      fail(new Error(`ffmpeg spawn error: ${error.message}`));
    });
    
    const markStartedIfOutputGrows = () => {
      if (hasStarted) return;
      try {
        if (fs.existsSync(outputFile)) {
          const s = fs.statSync(outputFile);
          if (s.size > 0) {
            hasStarted = true;
            console.log(`[FFmpeg Recording] Output file started (size=${s.size} bytes)`);
          }
        }
      } catch {
        // ignore
      }
    };
    startedPoll = setInterval(markStartedIfOutputGrows, 400);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (startedPoll as any)?.unref?.();

    timeout = setTimeout(() => {
      markStartedIfOutputGrows();
      if (!hasStarted) {
        fail(new Error(`Timeout: ffmpeg did not start producing output within 10 seconds`));
      }
    }, 10000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (timeout as any)?.unref?.();

    // Hard safety kill: if timestamps are weird and -t doesn't terminate, avoid hanging forever.
    safetyKill = setTimeout(() => {
      stopRequested = true;
      console.log(`[FFmpeg Recording] Safety stop reached, stopping ffmpeg`);
      killFfmpeg();
    }, (durationSeconds + 15) * 1000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (safetyKill as any)?.unref?.();
  });
}

async function recordVideoFromStream(
  videoStream: any,
  outputFile: string,
  durationSeconds: number,
  inputFps: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Recording video (direct pipe)`, { outputFile, durationSeconds, inputFps });

    const rawH264File = outputFile.replace(/\.mp4$/i, ".h264");
    const rawOut = fs.createWriteStream(rawH264File);

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "warning",
        "-fflags", "+genpts",
        "-r", String(inputFps),
        "-f", "h264",
        "-i", "pipe:0",
        // NB: duration is controlled by JS (after the first keyframe).
        "-an",
        "-c:v", "copy",
        "-movflags", "+faststart",
        "-y",
        outputFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let settled = false;
    let stderr = "";
    let written = 0;
    const kill = () => {
      try { ffmpeg.kill("SIGTERM"); } catch {}
      const t = setTimeout(() => { try { ffmpeg.kill("SIGKILL"); } catch {} }, 1500);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (t as any)?.unref?.();
    };
    const doneOk = () => {
      if (settled) return;
      settled = true;
      if (stopTimer) clearTimeout(stopTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
      try { ffmpeg.stdin?.end(); } catch {}
      try { rawOut.end(); } catch {}
      resolve();
    };
    const doneErr = (e: Error) => {
      if (settled) return;
      settled = true;
      if (stopTimer) clearTimeout(stopTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
      try { ffmpeg.stdin?.end(); } catch {}
      try { rawOut.end(); } catch {}
      kill();
      reject(e);
    };

    ffmpeg.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    ffmpeg.on("error", (e) => doneErr(new Error(`ffmpeg spawn error: ${e.message}`)));
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Recording completed: ${outputFile}`);
        return doneOk();
      }
      doneErr(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });

    const onVideo = (data: Buffer) => {
      if (!ffmpeg.stdin || ffmpeg.stdin.destroyed) return;
      try {
        ffmpeg.stdin.write(data);
        rawOut.write(data);
        written++;
      } catch {
        // ignore
      }
    };

    // Debug/compat: keyframes-only recording (intra-only) can produce a viewable MP4 even when P-frames are corrupted.
    const keyframesOnly = process.env.BAICHUAN_RECORD_KEYFRAMES_ONLY === "1";
    // Default ON: avoids initial "black" seconds by starting at the first IDR.
    const waitForKeyframe = process.env.BAICHUAN_WAIT_FOR_KEYFRAME !== "0";
    let started = !waitForKeyframe; // becomes true when the first keyframe arrives
    let stopTimer: NodeJS.Timeout | undefined;
    let safetyTimer: NodeJS.Timeout | undefined;
    const onAccessUnit = (unit: any) => {
      if (!unit || !Buffer.isBuffer(unit.data)) return;
      if (waitForKeyframe && !started) {
        if (!unit.isKeyframe) return;
        started = true;
        console.log(`[FFmpeg Record] First keyframe received, starting recording (${durationSeconds}s)`);
        stopTimer = setTimeout(() => {
          videoStream.removeListener("videoAccessUnit" as any, onAccessUnit as any);
          if (useVideoFrameFallback) videoStream.removeListener("videoFrame", onVideo);
          try { ffmpeg.stdin?.end(); } catch {}
          try { rawOut.end(); } catch {}
          console.log(`[FFmpeg Record] Frames sent via pipe: ${written}`);
        }, durationSeconds * 1000);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        (stopTimer as any)?.unref?.();
      }
      if (keyframesOnly && !unit.isKeyframe) return;
      onVideo(unit.data);
    };

    if (keyframesOnly) {
      console.log(`[FFmpeg Record] Keyframes-only mode enabled (BAICHUAN_RECORD_KEYFRAMES_ONLY=1)`);
    }
    if (waitForKeyframe) {
      console.log(`[FFmpeg Record] Waiting for the first keyframe before writing to ffmpeg (BAICHUAN_WAIT_FOR_KEYFRAME=1)`);
    }

    videoStream.on("videoAccessUnit" as any, onAccessUnit as any);
    // Fallback: avoid double writes (videoFrame + videoAccessUnit). Enable only if needed.
    const useVideoFrameFallback = process.env.BAICHUAN_USE_VIDEOFRAME_FALLBACK === "1";
    if (useVideoFrameFallback) {
      videoStream.on("videoFrame", onVideo);
    }

    // If we are not waiting for a keyframe, start the stop timer immediately.
    if (!waitForKeyframe) {
      stopTimer = setTimeout(() => {
        videoStream.removeListener("videoAccessUnit" as any, onAccessUnit as any);
        if (useVideoFrameFallback) videoStream.removeListener("videoFrame", onVideo);
        try { ffmpeg.stdin?.end(); } catch {}
        try { rawOut.end(); } catch {}
        console.log(`[FFmpeg Record] Frames sent via pipe: ${written}`);
      }, durationSeconds * 1000);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (stopTimer as any)?.unref?.();
    }

    // Safety: if the keyframe doesn't arrive, close anyway (caller already has a race-timeout).
    safetyTimer = setTimeout(() => {
      if (settled) return;
      if (!started) {
        doneErr(new Error(`Timeout: no keyframe within 12s (BAICHUAN_WAIT_FOR_KEYFRAME=1)`));
      }
    }, 12_000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (safetyTimer as any)?.unref?.();
  });
}

async function testVideoStreamRecording() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     BAICHUAN VIDEO STREAM RECORDING TEST                 ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("[ERROR] Incomplete TCP configuration in .env");
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
  const recordingsDir = path.join(process.cwd(), "test", "recordings", "tcp");
  // Deterministic default: record RECORD_DURATION seconds for every available profile.
  const duration = config.rtsp.recordDuration;

  // Create directory if it doesn't exist
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  try {
    // Login
    log("Baichuan TCP login");
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
    
    // If no profile is reported, still try with "sub" as a fallback.
    if (availableProfiles.length === 0) {
      log("No profiles found in metadata, continuing with 'sub' as default");
      availableProfiles.push("sub");
    }

    // Deterministic: record every available profile (preferred order).
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
          listenPort: 8554 + i, // Use different ports for each profile
          path: `/${profile}`,
        });
        
        // Handle RTSP server errors (don't crash the test)
        rtspServer.on("error", (error: Error) => {
          logError(`RTSP server error for profile ${profile}`, error);
        });
        
        const rtspUrl = rtspServer.getRtspUrl();
        logSuccess(`RTSP stream created: ${rtspUrl}`);
        
        // Wait for RTSP server to be ready
        log(`Waiting for RTSP server to be ready...`);
        try {
          await rtspServer.waitUntilReady();
          logSuccess(`RTSP server is ready: ${rtspUrl}`);
        } catch (error) {
          logError(`RTSP server not ready after timeout`, error);
          continue;
        }
        
        // Wait a bit more to ensure RTSP server is fully ready to accept connections
        log(`Waiting for RTSP server to be fully ready...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        
        // Record from RTSP stream using ffmpeg (emulating a user connecting to the stream)
        // The native stream will start automatically when ffmpeg connects
        const outputFile = path.join(recordingsDir, `recording_tcp_${profile}_${Date.now()}.mp4`);
        log(`Recording ${duration}s from RTSP stream: ${rtspUrl}`);
        log(`This emulates a user (ffmpeg) connecting to the RTSP stream`);
        log(`The native stream will start automatically when ffmpeg connects`);
        
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
        
        // Verify the file was created
        if (fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          logSuccess(`Recorded file: ${outputFile} (${stats.size} bytes)`);

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

testVideoStreamRecording().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

