#!/usr/bin/env node
/**
 * TCP test: list available streams and record a fixed duration from each one.
 * Duration is controlled via RECORD_DURATION in .env.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, buildRtspUrl } from "../../index";
import { config } from "../env";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 3).join("\n")}`);
    }
  } else {
    console.error(`   Details: ${error}`);
  }
}

/**
 * Records an RTSP stream using ffmpeg.
 */
async function recordStream(
  rtspUrl: string,
  outputFile: string,
  duration: number = config.rtsp.recordDuration
): Promise<boolean> {
  return new Promise((resolve) => {
    log(`Recording stream: ${rtspUrl}`);
    log(`Output file: ${outputFile}`);
    log(`Duration: ${duration} seconds`);

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-rtsp_transport",
      "tcp",
      "-i",
      rtspUrl,
      "-t",
      String(duration),
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-y",
      outputFile,
    ]);

    let ffmpegError = "";

    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      ffmpegError += output;
      // Mostra progresso se disponibile
      if (output.includes("time=")) {
        process.stdout.write(`\r   ${output.trim()}`);
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Recording completed: ${outputFile}`);
        resolve(true);
      } else {
        logError(`Recording error`, ffmpegError);
        resolve(false);
      }
    });

    ffmpeg.on("error", (err) => {
      logError(`ffmpeg error`, err);
      resolve(false);
    });
  });
}

async function runStreamRecordTest() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: AVAILABLE STREAMS + RECORDING (TCP)             ║");
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
  const recordDuration = config.rtsp.recordDuration;
  const outputDir = join(process.cwd(), "test", "recordings");

  try {
    // Create output directory
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      // Directory already exists, ok
    }

    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Fetch stream metadata
    log(`Fetching stream metadata for channel ${channel}`);
    const metadata = await api.getStreamMetadata(channel);
    logSuccess(`Available streams: ${metadata.streams.length}`);

    // Mostra informazioni su ogni stream
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

    // Record each available stream
    const results: Record<string, boolean> = {};

    for (const stream of metadata.streams) {
      const rtspUrl = buildRtspUrl({
        host: config.tcp.host,
        username: config.tcp.username,
        password: config.tcp.password,
        channel,
        stream: stream.profile,
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputFile = join(outputDir, `tcp-${stream.profile}-${timestamp}.mp4`);

      log(`\nRecording stream ${stream.profile.toUpperCase()}`);
      const success = await recordStream(rtspUrl, outputFile, recordDuration);
      results[stream.profile] = success;

      // Small pause between recordings
      if (metadata.streams.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Summary
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RECORDING SUMMARY                       ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\n");

    const passed = Object.values(results).filter((r) => r).length;
    const total = Object.keys(results).length;

    for (const [streamProfile, result] of Object.entries(results)) {
      console.log(`Stream ${streamProfile.toUpperCase()}: ${result ? "OK" : "FAILED"}`);
    }

    console.log(`\nResults: ${passed}/${total} streams recorded successfully`);
    console.log(`Files saved in: ${outputDir}\n`);

    if (passed === total) {
      console.log("All recordings completed successfully");
    } else {
      console.log(`[WARN] ${total - passed} recordings failed`);
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
runStreamRecordTest().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

