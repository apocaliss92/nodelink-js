/**
 * go2rtc Manager — spawns and manages go2rtc as a child process.
 *
 * When go2rtc is enabled in settings, each camera stream gets a Go2rtcTcpServer
 * (raw Annex-B TCP pipe) instead of a BaichuanRtspServer, and this manager
 * registers the tcp:// source with go2rtc via its REST API.
 *
 * go2rtc then provides WebRTC, HLS, MJPEG, and RTSP output automatically.
 *
 * Binary resolution order:
 *   1. Custom path from settings (if provided and exists)
 *   2. `go2rtc-static` npm package (bundled, always available)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createSourceLogger } from "./logger.js";

const logger = createSourceLogger("go2rtc");

const HEALTH_CHECK_INTERVAL_MS = 2_000;
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const RESTART_BACKOFF_BASE_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

// ---- Binary resolution ----

/**
 * Resolve the go2rtc binary path.
 *
 * Tries the user-supplied `binaryPath` first (absolute or relative to CWD).
 * Falls back to the `go2rtc-static` npm package which ships a pre-built
 * binary for the current platform/arch.
 */
export function resolveGo2rtcBinary(binaryPath?: string): string {
  // 1. User-supplied path (absolute or relative to CWD)
  if (binaryPath) {
    const abs = resolvePath(binaryPath);
    if (existsSync(abs)) return abs;

    const fromCwd = resolvePath(process.cwd(), binaryPath);
    if (existsSync(fromCwd)) return fromCwd;
  }

  // 2. GO2RTC_PATH environment variable (set by Docker)
  const envPath = process.env.GO2RTC_PATH;
  if (envPath && existsSync(envPath)) {
    logger.info(`Using go2rtc binary from GO2RTC_PATH: ${envPath}`);
    return envPath;
  }

  // 3. Common system paths
  for (const p of ["/usr/local/bin/go2rtc", "/usr/bin/go2rtc"]) {
    if (existsSync(p)) {
      logger.info(`Using go2rtc binary from system path: ${p}`);
      return p;
    }
  }

  // 4. Bundled via go2rtc-static npm package
  try {
    const require = createRequire(import.meta.url);
    const staticPath: string = require("go2rtc-static");
    if (existsSync(staticPath)) {
      logger.info(`Using bundled go2rtc binary from go2rtc-static: ${staticPath}`);
      return staticPath;
    }
  } catch {
    // Package not installed
  }

  throw new Error(
    `go2rtc binary not found. Tried: "${binaryPath ?? "(none)"}", GO2RTC_PATH="${envPath ?? ""}", system paths, go2rtc-static. ` +
      `Install go2rtc or set GO2RTC_PATH.`,
  );
}

export interface Go2rtcOptions {
  binaryPath?: string;
  apiPort: number;
  rtspPort: number;
  webrtcPort: number;
  iceServers?: string[];
  dataDir: string;
  rtspSource?: "go2rtc" | "local";
}

// ---- YAML config generation ----

function generateGo2rtcYaml(
  streams: Map<string, readonly string[]>,
  options: Go2rtcOptions,
): string {
  const lines: string[] = [];

  lines.push("api:");
  lines.push(`  listen: ":${options.apiPort}"`);
  lines.push('  origin: "*"');
  lines.push("");

  lines.push("rtsp:");
  if (options.rtspSource === "local") {
    lines.push('  listen: ""');
  } else {
    lines.push(`  listen: ":${options.rtspPort}"`);
  }
  lines.push("");

  lines.push("webrtc:");
  lines.push(`  listen: ":${options.webrtcPort}"`);
  if (options.iceServers && options.iceServers.length > 0) {
    lines.push("  candidates:");
    for (const server of options.iceServers) {
      lines.push(`    - ${server}`);
    }
  }
  lines.push("");

  lines.push("ffmpeg:");
  lines.push("  bin: ffmpeg");
  // Template for MJPEG transcoding (H264/H265 → MJPEG via ffmpeg)
  lines.push("  mjpeg: -hide_banner -an -vf \"scale=-1:720\" -q:v 5 -f mjpeg -");
  lines.push("");

  lines.push("streams:");
  if (streams.size === 0) {
    lines.push("  # No streams registered yet");
  } else {
    for (const [name, sources] of streams) {
      if (sources.length === 1) {
        lines.push(`  ${name}: "${sources[0]}"`);
      } else {
        lines.push(`  ${name}:`);
        for (const src of sources) {
          lines.push(`    - "${src}"`);
        }
      }
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ---- Manager class ----

export class Go2rtcManager {
  private process: ChildProcess | null = null;
  private configPath: string | null = null;
  private readonly streams = new Map<string, readonly string[]>();
  private restartCount = 0;
  private stopping = false;
  private readonly options: Go2rtcOptions;
  private resolvedBinaryPath: string | null = null;

  constructor(options: Go2rtcOptions) {
    this.options = options;
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.options.apiPort}`;
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /** The resolved binary path (available after start()). */
  get binaryPath(): string | null {
    return this.resolvedBinaryPath;
  }

  /** Start go2rtc process. */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.stopping = false;

    // Write config
    const yaml = generateGo2rtcYaml(this.streams, this.options);
    const configPath = join(this.options.dataDir, "go2rtc.yaml");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, yaml, "utf-8");
    this.configPath = configPath;

    // Resolve binary
    this.resolvedBinaryPath = resolveGo2rtcBinary(this.options.binaryPath);

    logger.info(`Starting: ${this.resolvedBinaryPath} -config ${this.configPath}`);
    this.process = spawn(this.resolvedBinaryPath, ["-config", this.configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.process.on("error", (err) => {
      logger.error(`Spawn error: ${err.message}`);
      this.process = null;
    });

    // Pipe go2rtc stdout/stderr to the app logger so they appear in the Logs page.
    const pipeToLogger = (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        if (line.includes("ERR") || line.includes("error") || line.includes("panic")) {
          logger.error(line);
        } else if (line.includes("WRN")) {
          logger.warn(line);
        } else {
          logger.info(line);
        }
      }
    };
    this.process.stdout?.on("data", pipeToLogger);
    this.process.stderr?.on("data", pipeToLogger);

    // Handle unexpected exit
    this.process.on("exit", (code, signal) => {
      logger.info(`Process exited (code=${code}, signal=${signal})`);
      this.process = null;

      if (!this.stopping) {
        const delay = Math.min(
          RESTART_BACKOFF_BASE_MS * 2 ** this.restartCount,
          RESTART_BACKOFF_MAX_MS,
        );
        this.restartCount++;
        logger.info(`Restarting in ${delay}ms (attempt ${this.restartCount})`);
        setTimeout(() => {
          if (!this.stopping) void this.start();
        }, delay);
      }
    });

    await this.waitForHealthy();
    this.restartCount = 0;
    logger.info(`Started successfully (API: ${this.apiUrl})`);
  }

  /** Stop go2rtc process gracefully. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.process) return;

    const proc = this.process;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn("Graceful stop timeout, sending SIGKILL");
        proc.kill("SIGKILL");
      }, STOP_TIMEOUT_MS);

      proc.on("exit", () => {
        clearTimeout(timer);
        this.process = null;
        logger.info("Stopped");
        resolve();
      });

      proc.kill("SIGTERM");
    });
  }

  /** Restart with updated config. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Add or update a stream via go2rtc REST API (hot, no restart needed).
   * @param name — stream name (e.g. "camera_studio_main")
   * @param sourceUrl — source URL or array of sources. When multiple sources
   *   are provided, go2rtc picks the best one that matches the client's
   *   requested codecs (e.g. an `ffmpeg:...#video=h264` fallback enables
   *   WebRTC playback for H265 cameras while keeping the native RTSP source
   *   for RTSP/HLS/MSE clients).
   */
  async addStream(name: string, sourceUrl: string | readonly string[]): Promise<void> {
    const sources = Array.isArray(sourceUrl)
      ? (sourceUrl as readonly string[])
      : [sourceUrl as string];
    this.streams.set(name, sources);

    if (!this.isRunning) {
      logger.warn(`Cannot add stream "${name}" — go2rtc is not running`);
      return;
    }

    const query = new URLSearchParams();
    query.set("name", name);
    for (const src of sources) query.append("src", src);

    const url = `${this.apiUrl}/api/streams?${query.toString()}`;
    const res = await fetch(url, { method: "PUT" });
    if (!res.ok) {
      const body = await res.text();
      logger.error(`Failed to add stream "${name}": HTTP ${res.status} — ${body}`);
      throw new Error(`go2rtc PUT failed (${res.status}): ${body}`);
    }
    logger.info(`Stream added: ${name} → [${sources.join(", ")}]`);
  }

  /** Remove a stream via go2rtc REST API. */
  async removeStream(name: string): Promise<void> {
    this.streams.delete(name);

    if (!this.isRunning) return;

    const url = `${this.apiUrl}/api/streams?src=${encodeURIComponent(name)}`;
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      logger.error(`Failed to remove stream "${name}": HTTP ${res.status}`);
    }
    logger.info(`Stream removed: ${name}`);
  }

  /** Get registered streams (from go2rtc API if running, otherwise from local cache). */
  async getStreams(): Promise<Record<string, unknown>> {
    if (!this.isRunning) return Object.fromEntries(this.streams);

    try {
      const res = await fetch(`${this.apiUrl}/api/streams`);
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      // fallback
    }
    return Object.fromEntries(
      Array.from(this.streams, ([name, sources]) => [name, sources] as const),
    );
  }

  /** Proxy a request to go2rtc API. */
  async proxyApi(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, init);
  }

  /** Wait for go2rtc API to become healthy. */
  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error("go2rtc process exited before becoming healthy");
      }
      try {
        const res = await fetch(`${this.apiUrl}/api`);
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }

    throw new Error(`go2rtc health check timeout after ${HEALTH_CHECK_TIMEOUT_MS}ms`);
  }
}

// ---- Singleton ----

let manager: Go2rtcManager | null = null;

/** Get the global Go2rtcManager instance. */
export function getGo2rtcManager(): Go2rtcManager | null {
  return manager;
}

/** Initialize and start go2rtc from settings. */
export async function initGo2rtc(settings: {
  binaryPath?: string;
  apiPort: number;
  rtspPort: number;
  webrtcPort: number;
  iceServers?: string[];
  rtspSource?: "go2rtc" | "local";
}): Promise<Go2rtcManager> {
  const dataDir = process.env.DATA_PATH || ".";

  manager = new Go2rtcManager({
    binaryPath: settings.binaryPath,
    apiPort: settings.apiPort,
    rtspPort: settings.rtspPort,
    webrtcPort: settings.webrtcPort,
    iceServers: settings.iceServers,
    dataDir,
    rtspSource: settings.rtspSource,
  });

  await manager.start();
  return manager;
}

/** Stop go2rtc if running. */
export async function stopGo2rtc(): Promise<void> {
  if (manager) {
    await manager.stop();
    manager = null;
  }
}
