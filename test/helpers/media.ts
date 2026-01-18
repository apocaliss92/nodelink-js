import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "_");

export const getArtifactsRoot = (): string => {
  const root = process.env.REOLINK_TEST_ARTIFACTS_DIR ?? "test/artifacts";
  return resolve(process.cwd(), root);
};

export const buildDeviceArtifactsDir = async (params: { deviceLabel: string; host: string }): Promise<string> => {
  const root = getArtifactsRoot();
  const dir = resolve(root, slug(params.deviceLabel), slug(params.host));
  await mkdir(dir, { recursive: true });
  return dir;
};

export const recordDurationSeconds = (envVar = "RECORD_DURATION", fallbackSeconds = 5): number => {
  const raw = process.env[envVar];
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.min(120, Math.max(1, Math.floor(n)));
  return fallbackSeconds;
};

export const getFfmpegBin = (): string => process.env.FFMPEG_BIN ?? "ffmpeg";

export const ensureFfmpegAvailable = async (): Promise<boolean> => {
  const bin = getFfmpegBin();
  return await new Promise<boolean>((resolvePromise) => {
    const child = spawn(bin, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolvePromise(false));
    child.once("exit", (code) => resolvePromise(code === 0));
  });
};

export const execFfmpeg = async (args: string[], options?: { timeoutMs?: number }): Promise<void> => {
  const bin = getFfmpegBin();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const timeoutMs = options?.timeoutMs;
    const timeout = timeoutMs != null
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          rejectPromise(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });

    child.once("error", (e) => {
      if (timeout) clearTimeout(timeout);
      rejectPromise(e);
    });

    child.once("exit", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`ffmpeg exited with code ${code}. stderr tail: ${stderr.trim()}`));
    });
  });
};

export const recordRtspMp4 = async (params: { rtspUrl: string; outFile: string; seconds: number }): Promise<void> => {
  const seconds = Math.max(1, params.seconds);
  const timeoutMs = (seconds + 20) * 1000;

  const commonArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-rtsp_transport",
    "tcp",
  ];

  const buildArgs = (outputArgs: string[]): string[] => [
    ...commonArgs,
    "-i",
    params.rtspUrl,
    "-t",
    String(seconds),
    ...outputArgs,
  ];

  // First attempt: stream copy (fast). Fallback: transcode to H.264.
  try {
    await execFfmpeg(
      buildArgs(["-an", "-c", "copy", "-movflags", "+faststart", params.outFile]),
      { timeoutMs },
    );
  } catch {
    await execFfmpeg(
      buildArgs(["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-movflags", "+faststart", params.outFile]),
      { timeoutMs },
    );
  }
};
