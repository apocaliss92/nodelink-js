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
import { existsSync, mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
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
  lines.push(`  listen: ":${options.rtspPort}"`);
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

  // NOTE about the empty-streams case:
  // - A placeholder comment (`# No streams registered yet`) breaks go2rtc's
  //   in-process YAML editor: when it later adds a stream via the REST API,
  //   it rewrites the file with 8-space/tab indentation and leaves the stale
  //   comment at the wrong indent level, producing a malformed YAML that
  //   fails subsequent PUTs with "could not find expected ':'".
  // - `streams: {}` (flow-style empty map) also fails: go2rtc's YAML editor
  //   refuses to merge new keys into a flow-style empty map, producing
  //   "line N: did not find expected key" on PUT.
  // - A bare `streams:` (null value) is the only format go2rtc's editor can
  //   round-trip cleanly when adding streams via PUT.
  lines.push("streams:");
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
  private options: Go2rtcOptions;
  private resolvedBinaryPath: string | null = null;

  constructor(options: Go2rtcOptions) {
    this.options = options;
  }

  /**
   * Update the manager options in-place. Does NOT restart the process.
   * Call `restart()` (or `stop()`+`start()`) afterwards to apply changes
   * that affect the generated go2rtc.yaml (api/rtsp/webrtc port, iceServers,
   * binaryPath).
   */
  updateOptions(patch: Partial<Go2rtcOptions>): void {
    this.options = { ...this.options, ...patch };
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
    atomicWriteFileSync(configPath, yaml);
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

    // go2rtc's in-process YAML editor has a latent bug: after repeated
    // add/remove cycles it can leave the on-disk go2rtc.yaml in a state its
    // own parser refuses, making subsequent PUTs fail with 400 "could not
    // find expected key" or "line N: did not find expected ':'". The fix is
    // to rewrite the file cleanly from our authoritative in-memory state
    // and retry once. We already hold the latest streams map here.
    let res = await fetch(url, { method: "PUT" });
    if (!res.ok && res.status === 400) {
      const body = await res.text();
      if (/yaml:|could not find expected|did not find expected/i.test(body)) {
        logger.warn(
          `addStream "${name}": go2rtc YAML corrupted (${body.trim()}); rewriting and retrying`,
        );
        try {
          await this.rewriteYamlFromState();
          res = await fetch(url, { method: "PUT" });
        } catch (err) {
          logger.warn(`Failed to rewrite YAML: ${(err as Error).message}`);
        }
      }
    }

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

    // HTTP 400 on DELETE is almost always the go2rtc YAML editor bug (see
    // addStream). The stream is already gone from our in-memory state so
    // this is non-fatal; we rewrite the YAML to unstick future operations.
    if (!res.ok && res.status === 400) {
      logger.warn(
        `Failed to remove stream "${name}": HTTP 400 (likely go2rtc YAML editor bug); rewriting YAML`,
      );
      try {
        await this.rewriteYamlFromState();
      } catch (err) {
        logger.warn(`Failed to rewrite YAML: ${(err as Error).message}`);
      }
      return;
    }
    if (!res.ok && res.status !== 404) {
      logger.error(`Failed to remove stream "${name}": HTTP ${res.status}`);
    }
    logger.info(`Stream removed: ${name}`);
  }

  /**
   * Rewrite go2rtc.yaml from our authoritative in-memory streams + options.
   * Used to recover from go2rtc's YAML editor leaving stray fragments after
   * add/remove cycles. Safe to call while go2rtc is running: go2rtc re-reads
   * the file lazily when it next needs to persist state.
   */
  private async rewriteYamlFromState(): Promise<void> {
    if (!this.configPath) return;
    const yaml = generateGo2rtcYaml(this.streams, this.options);
    atomicWriteFileSync(this.configPath, yaml);
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
}): Promise<Go2rtcManager> {
  const dataDir = process.env.DATA_PATH || ".";

  manager = new Go2rtcManager({
    binaryPath: settings.binaryPath,
    apiPort: settings.apiPort,
    rtspPort: settings.rtspPort,
    webrtcPort: settings.webrtcPort,
    iceServers: settings.iceServers,
    dataDir,
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
