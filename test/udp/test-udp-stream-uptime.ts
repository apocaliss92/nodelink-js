#!/usr/bin/env node
/**
 * UDP stream uptime test (Main profile).
 *
 * Opens a Baichuan UDP stream (profile: "main") and measures how long it stays alive.
 * The stream is considered "alive" while we keep receiving video/audio frames.
 *
 * Env vars:
 * - UDP_HOST / UDP_USERNAME / UDP_PASSWORD / UDP_UID: connection settings (see test/env.ts)
 * - UDP_UPTIME_TARGET_SECONDS: how long we try to keep the stream running (default: 30)
 * - UDP_UPTIME_MIN_SECONDS: minimum required uptime to pass (default: 12)
 * - UDP_UPTIME_IDLE_MS: declare the stream dead if no frames for this long (default: 1500)
 * - UDP_UPTIME_FIRST_FRAME_TIMEOUT_MS: fail if no first frame within this time (default: 15000)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BaichuanVideoStream } from "../../index.js";
import { config } from "../env.js";

function envNum(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw == null || raw.trim() === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return defaultValue;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<boolean> {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║       UDP STREAM UPTIME TEST (BCUDP) - MAIN PROFILE       ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  if (!config.udp.uid || !config.udp.password) {
    console.error("[ERROR] Incomplete UDP configuration in .env (need UDP_UID and UDP_PASSWORD)");
    return false;
  }

  const targetSeconds = envNum("UDP_UPTIME_TARGET_SECONDS", 30);
  const minSeconds = envNum("UDP_UPTIME_MIN_SECONDS", 12);
  const idleMs = envNum("UDP_UPTIME_IDLE_MS", 1500);
  const firstFrameTimeoutMs = envNum("UDP_UPTIME_FIRST_FRAME_TIMEOUT_MS", 15000);
  const debug = envBool("UDP_DEBUG", false);

  console.log("Configuration:");
  console.log(`  Host: ${config.udp.host || "255.255.255.255 (broadcast)"}`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Target seconds: ${targetSeconds}`);
  console.log(`  Min seconds (pass threshold): ${minSeconds}`);
  console.log(`  Idle timeout (ms): ${idleMs}`);
  console.log(`  First frame timeout (ms): ${firstFrameTimeoutMs}`);
  console.log(`  Debug: ${debug ? "on" : "off"}`);

  const useBroadcast = !config.udp.host || config.udp.host === "255.255.255.255";

  const api = new ReolinkBaichuanApi({
    host: useBroadcast ? "255.255.255.255" : config.udp.host!,
    username: config.udp.username,
    password: config.udp.password,
    transport: "udp",
    udp: {
      mode: "uid",
      uid: config.udp.uid,
      host: useBroadcast ? undefined : config.udp.host,
      broadcast: useBroadcast,
      discoveryTimeout: 30_000,
      discoveryRetryInterval: 500,
    },
    debug,
  });

  let firstFrameAt: number | null = null;
  let lastActivityAt: number | null = null;
  let videoUnits = 0;
  let audioFrames = 0;
  let totalVideoBytes = 0;
  let totalAudioBytes = 0;

  let closed = false;
  let error: Error | null = null;

  api.client.on("error", (e: Error) => {
    // Do not throw from event handler
    error = e;
  });

  const stream = new BaichuanVideoStream({
    client: api.client,
    api,
    channel: 0,
    profile: "main",
    logger: api.logger,
  });

  stream.on("videoAccessUnit", (unit: any) => {
    const now = Date.now();
    if (firstFrameAt == null) firstFrameAt = now;
    lastActivityAt = now;
    videoUnits++;
    if (unit?.data && Buffer.isBuffer(unit.data)) totalVideoBytes += unit.data.length;
  });

  stream.on("audioFrame", (buf: Buffer) => {
    const now = Date.now();
    if (firstFrameAt == null) firstFrameAt = now;
    lastActivityAt = now;
    audioFrames++;
    if (Buffer.isBuffer(buf)) totalAudioBytes += buf.length;
  });

  stream.on("close", () => {
    closed = true;
  });

  stream.on("error", (e: Error) => {
    error = e;
  });

  const cleanup = async () => {
    try {
      await stream.stop();
    } catch {
      // ignore
    }
    try {
      await api.close();
    } catch {
      // ignore
    }
  };

  try {
    await api.login();
    console.log("\n[OK] UDP login succeeded");

    console.log("[INFO] Starting BaichuanVideoStream (profile=main) ...");
    await stream.start();

    // Wait for first frame.
    const startWait = Date.now();
    while (firstFrameAt == null && !closed && !error) {
      if (Date.now() - startWait > firstFrameTimeoutMs) {
        throw new Error(`No first frame received within ${firstFrameTimeoutMs}ms`);
      }
      await sleepMs(50);
    }

    if (error) throw error;
    if (closed) throw new Error("Stream closed before first frame");

    console.log("[OK] First frame received; measuring uptime...");

    const measurementStart = firstFrameAt ?? Date.now();
    let endedAt: number | null = null;

    const statusTimer = setInterval(() => {
      const now = Date.now();
      const uptimeSec = (now - measurementStart) / 1000;
      const lastDelta = lastActivityAt == null ? NaN : (now - lastActivityAt);

      const lastDeltaStr = Number.isFinite(lastDelta) ? `${Math.round(lastDelta)}ms` : "n/a";
      process.stdout.write(
        `\r[UPTIME] ${uptimeSec.toFixed(1)}s | videoAU=${videoUnits} (${(totalVideoBytes / 1024).toFixed(1)} KiB) | audio=${audioFrames} (${(totalAudioBytes / 1024).toFixed(1)} KiB) | last=${lastDeltaStr}   `
      );
    }, 1000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (statusTimer as any)?.unref?.();

    while (!closed && !error) {
      const now = Date.now();
      const elapsedSec = (now - measurementStart) / 1000;

      // Success condition: we managed to stay alive for targetSeconds.
      if (elapsedSec >= targetSeconds) {
        endedAt = now;
        break;
      }

      // Failure condition: no frames for idleMs.
      if (lastActivityAt != null && now - lastActivityAt > idleMs) {
        endedAt = lastActivityAt;
        break;
      }

      await sleepMs(50);
    }

    clearInterval(statusTimer);

    process.stdout.write("\n");

    if (error) throw error;

    const finalEnd = endedAt ?? Date.now();
    const uptimeSeconds = (finalEnd - measurementStart) / 1000;

    console.log("\nSummary:");
    console.log(`  Uptime seconds: ${uptimeSeconds.toFixed(3)}`);
    console.log(`  Video access units: ${videoUnits}`);
    console.log(`  Audio frames: ${audioFrames}`);

    if (uptimeSeconds < minSeconds) {
      console.error(`\n[FAIL] Stream uptime ${uptimeSeconds.toFixed(3)}s < min ${minSeconds}s`);
      return false;
    }

    if (uptimeSeconds < targetSeconds) {
      console.error(`\n[FAIL] Stream stopped early at ${uptimeSeconds.toFixed(3)}s (target ${targetSeconds}s).`);
      return false;
    }

    console.log(`\n[OK] Stream stayed alive for at least ${targetSeconds}s`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n[ERROR] UDP stream uptime test failed: ${msg}`);
    return false;
  } finally {
    await cleanup();
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => {
    console.error("\n[ERROR] Fatal error:", e);
    process.exit(1);
  });
