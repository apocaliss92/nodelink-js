#!/usr/bin/env node
/**
 * TCP -> RTSP HEVC (H.265) validation test.
 *
 * Goal: confirm at least one HEVC (H.265) stream is correctly proxied via our RTSP server.
 *
 * Requires .env:
 *  - TCP265_HOST / TCP265_USERNAME / TCP265_PASSWORD
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

async function probeVideoCodecName(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name",
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
      const value = stdout.trim();
      if (!value) {
        reject(new Error(`ffprobe returned empty codec_name`));
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

function normalizeProfile(value: unknown): "main" | "sub" | "ext" | undefined {
  return value === "main" || value === "sub" || value === "ext" ? value : undefined;
}

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

async function recordVideoFromRtsp(rtspUrl: string, outputFile: string, durationSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Recording video from RTSP`, { rtspUrl, outputFile, durationSeconds });

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-stats",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtspUrl,
        "-t",
        durationSeconds.toString(),
        "-c",
        "copy",
        "-y",
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

      if (!hasStarted && (output.includes("Stream") || output.includes("frame="))) {
        hasStarted = true;
        console.log(`[FFmpeg Record] Stream started`);
      }

      if (output.includes("Error") || output.includes("error")) {
        console.error(`[FFmpeg Record] ${output.trim()}`);
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Recording completed: ${outputFile}`);
        ok();
      } else {
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

async function testTcp265RtspProxy() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║        BAICHUAN TCP -> RTSP H.265 (HEVC) TEST            ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  console.log(`\nConfiguration:`);
  console.log(`  Host: ${config.tcp265.host}`);
  console.log(`  Username: ${config.tcp265.username}`);

  if (!config.tcp265.host || !config.tcp265.password) {
    console.error("[ERROR] Incomplete TCP265 configuration in .env");
    process.exit(1);
  }

  const api = new ReolinkBaichuanApi({
    host: config.tcp265.host,
    username: config.tcp265.username,
    password: config.tcp265.password,
    transport: "tcp",
    debug: false,
  });

  const channel = 0;

  const recordingsDir = path.join(process.cwd(), "test", "recordings", "tcp265");
  const duration = config.rtsp.recordDuration;

  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  // Cleanup previous artifacts to avoid accumulating recordings between runs.
  cleanupRecordingsDir(recordingsDir);

  const rtspServers: BaichuanRtspServer[] = [];

  try {
    log("Baichuan TCP login (tcp265)");
    const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;
    await api.login(maxEnc ?? "aes");
    logSuccess("Login completed");

    log("Checking available profiles");
    const streamMetadata = await api.getStreamMetadata(channel);
    logSuccess("Stream metadata fetched");
    log("Stream metadata", streamMetadata);

    const availableProfiles: Array<"main" | "sub" | "ext"> = [];
    if (Array.isArray(streamMetadata)) {
      for (const stream of streamMetadata) {
        const p = normalizeProfile((stream as any)?.profile);
        if (p && !availableProfiles.includes(p)) availableProfiles.push(p);
      }
    } else if (streamMetadata && typeof streamMetadata === "object") {
      if ("main" in streamMetadata && (streamMetadata as any).main) availableProfiles.push("main");
      if ("sub" in streamMetadata && (streamMetadata as any).sub) availableProfiles.push("sub");
      if ("ext" in streamMetadata && (streamMetadata as any).ext) availableProfiles.push("ext");
      if ("streams" in streamMetadata && Array.isArray((streamMetadata as any).streams)) {
        for (const stream of (streamMetadata as any).streams) {
          const p = normalizeProfile(stream?.profile);
          if (p && !availableProfiles.includes(p)) availableProfiles.push(p);
        }
      }
    }

    log(`Available profiles: ${availableProfiles.length > 0 ? availableProfiles.join(", ") : "none (continuing anyway)"}`);
    if (availableProfiles.length === 0) {
      log("No profiles found in metadata, continuing with 'sub' as default");
      availableProfiles.push("sub");
    }

    const preferredOrder: Array<"main" | "sub" | "ext"> = ["main", "sub", "ext"];
    const profiles = preferredOrder.filter((p) => availableProfiles.includes(p));
    log(`Profiles to test: ${profiles.join(", ")}`);

    const codecByProfile: Partial<Record<"main" | "sub" | "ext", string>> = {};
    const recordedFiles: string[] = [];

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i]!;

      log(`Creating RTSP stream for profile ${profile}`);
      const rtspServer = await api.createRtspStream(channel, profile, {
        listenPort: 8654 + i,
        path: `/${profile}`,
      });
      rtspServers.push(rtspServer);

      rtspServer.on("error", (error: Error) => {
        logError(`RTSP server error for profile ${profile}`, error);
      });

      const rtspUrl = rtspServer.getRtspUrl();
      logSuccess(`RTSP stream created: ${rtspUrl}`);

      await rtspServer.waitUntilReady();
      logSuccess(`RTSP server is ready: ${rtspUrl}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const outputFile = path.join(recordingsDir, `recording_tcp265_${profile}_${Date.now()}.mp4`);

      await Promise.race([
        recordVideoFromRtsp(rtspUrl, outputFile, duration),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout recording from RTSP")), (duration + 10) * 1000)
        ),
      ]);

      if (!fs.existsSync(outputFile)) {
        throw new Error(`File not created: ${outputFile}`);
      }

      const stats = fs.statSync(outputFile);
      logSuccess(`Recorded file: ${outputFile} (${stats.size} bytes)`);
      recordedFiles.push(outputFile);

      const recordedDuration = await probeVideoDurationSeconds(outputFile);
      console.log(`[FFprobe] Duration (${profile}): ${recordedDuration.toFixed(3)}s (target ${duration}s)`);
      const toleranceSeconds = 0.75;
      if (Math.abs(recordedDuration - duration) > toleranceSeconds) {
        throw new Error(`Recorded duration out of tolerance for ${profile}: ${recordedDuration}s (target ${duration}s)`);
      }

      const codecName = await probeVideoCodecName(outputFile);
      codecByProfile[profile] = codecName;
      console.log(`[FFprobe] codec_name (${profile}): ${codecName}`);

      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    const hevcProfiles = Object.entries(codecByProfile)
      .filter(([, codec]) => codec === "hevc")
      .map(([p]) => p);

    if (hevcProfiles.length === 0) {
      throw new Error(
        `No HEVC stream found. Recorded codecs: ${JSON.stringify(codecByProfile)}`
      );
    }

    log("Final ffprobe verification (no errors)");
    for (const f of recordedFiles) {
      await ffprobeAssertNoErrors(f);
    }

    logSuccess(`tcp-265 test passed (HEVC proxied via RTSP). HEVC profiles: ${hevcProfiles.join(", ")}`);
  } catch (error) {
    logError("tcp-265 test failed", error);
    process.exit(1);
  } finally {
    for (const rtspServer of rtspServers) {
      try {
        await rtspServer.stop();
      } catch (error) {
        logError("Error while stopping RTSP stream", error);
      }
    }

    try {
      await api.close();
      logSuccess("Connection closed");
    } catch (error) {
      logError("Error while closing connection", error);
    }

    setTimeout(() => process.exit(0), 750);
  }
}

testTcp265RtspProxy().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
