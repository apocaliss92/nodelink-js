/* eslint-disable no-console */
/**
 * Hardware reproduction of issue #8 — "battery awake/sleep loop after the
 * stream stops" — against a STANDALONE battery camera (not behind NVR/Hub).
 *
 * This is the exact setup reported by users:
 *   - Argus PT Plus / similar BCUDP-wake battery cam
 *   - No NVR proxying, library connects directly via UDP UID
 *   - api.isReady=false when idle (idle-disconnect path)
 *
 * Same phases A–E as issue-8-battery-loop.ts, but here the BCUDP wake-up
 * actually runs end-to-end (connect → login → sub stream → sleep).
 *
 * Requires .env:
 *   UDP_STANDALONE_HOST, UDP_STANDALONE_USERNAME, UDP_STANDALONE_PASSWORD, UDP_STANDALONE_UID
 */

import "dotenv/config";
import * as net from "node:net";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { Go2rtcTcpServer } from "../../src/baichuan/stream/Go2rtcTcpServer";

const PROFILE = (process.env.ISSUE8_PROFILE ?? "sub") as "main" | "sub" | "ext";
const WAKE_TIMEOUT_MS = 90_000; // standalone BCUDP wake can take a bit longer
const IDLE_WATCH_MS = 75_000;   // > the 60s window reported by users
const GRACE_MS = 8_000;

function fmt(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function drainMpegTs(
  port: number,
  timeoutMs: number,
): Promise<{ firstByteMs: number; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const start = Date.now();
    let firstByteMs = -1;
    let totalBytes = 0;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no frame within ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on("data", (chunk) => {
      if (firstByteMs < 0) firstByteMs = Date.now() - start;
      totalBytes += chunk.length;
      if (totalBytes >= 100_000) {
        clearTimeout(timer);
        sock.end();
        resolve({ firstByteMs, totalBytes });
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on("close", () => {
      if (totalBytes > 0 && firstByteMs >= 0) {
        clearTimeout(timer);
        resolve({ firstByteMs, totalBytes });
      }
    });
  });
}

async function main() {
  const host = process.env.UDP_STANDALONE_HOST!;
  const username = process.env.UDP_STANDALONE_USERNAME ?? "admin";
  const password = process.env.UDP_STANDALONE_PASSWORD ?? "";
  const uid = process.env.UDP_STANDALONE_UID;
  if (!host) throw new Error("UDP_STANDALONE_HOST not set");

  console.log(`\n── Issue #8 repro (STANDALONE BATTERY) — ${host} uid=${uid ?? "-"} ch0/${PROFILE} ──`);
  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    transport: "auto", // TCP first, BCUDP fallback via UID when TCP refused
    ...(uid ? { uid } : {}),
  });

  let handleClientCount = 0;
  let startNativeStreamCount = 0;

  const server = new Go2rtcTcpServer({
    api,
    channel: 0,
    profile: PROFILE,
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: false, // battery: on-demand
    gracePeriodMs: GRACE_MS,
    streamTimeoutMs: 25_000,
    logger: {
      info: (m: string) => process.stdout.write(`  [srv] ${m}\n`),
      warn: (m: string) => process.stdout.write(`  [srv WARN] ${m}\n`),
      error: (m: string) => process.stderr.write(`  [srv ERR] ${m}\n`),
      debug: (_: string) => {},
    },
  });

  const origHandle = (server as any).handleClient.bind(server);
  (server as any).handleClient = function (sock: net.Socket) {
    handleClientCount++;
    return origHandle(sock);
  };
  const origStart = (server as any).startNativeStream.bind(server);
  (server as any).startNativeStream = function () {
    startNativeStreamCount++;
    console.log(`  [spy] startNativeStream call #${startNativeStreamCount}`);
    return origStart();
  };

  // NOTE: no api.login() — the stream server's startNativeStream will drive
  // ensureConnected() on first connect, which is the exact battery wake path.

  // ── Phase A ───────────────────────────────────────────────────────────────
  await server.start();
  const port = server.port!;
  console.log(`\nPhase A  server listening on tcp://127.0.0.1:${port}  prestart=false`);
  console.log(`         startNativeStream=${startNativeStreamCount} handleClient=${handleClientCount}`);
  console.log(`         api.isReady=${api.isReady} api.isClosed=${api.isClosed}`);

  // ── Phase B ───────────────────────────────────────────────────────────────
  console.log(`\nPhase B  opening TCP client, expecting wake within ${fmt(WAKE_TIMEOUT_MS)}…`);
  let phaseBok = false;
  try {
    const { firstByteMs, totalBytes } = await drainMpegTs(port, WAKE_TIMEOUT_MS);
    phaseBok = true;
    console.log(
      `         ✓ woke — first byte at ${fmt(firstByteMs)}, drained ${totalBytes} bytes`,
    );
  } catch (e) {
    console.log(
      `         ⚠  Phase B failed: ${e}. Continuing to observe idle behavior (this still validates that failed wakes don't loop).`,
    );
  }

  // ── Phase C ───────────────────────────────────────────────────────────────
  if (phaseBok) {
    console.log(`\nPhase C  waiting grace (${fmt(GRACE_MS)}) + 3s for native stream to stop…`);
    await new Promise<void>((r) => setTimeout(r, GRACE_MS + 3_000));
  } else {
    console.log(`\nPhase C  skipped (Phase B did not wake the camera)`);
  }
  console.log(
    `         after Phase C: startNativeStream=${startNativeStreamCount} handleClient=${handleClientCount} api.isReady=${api.isReady}`,
  );

  // ── Phase D ───────────────────────────────────────────────────────────────
  console.log(
    `\nPhase D  idle observation for ${fmt(IDLE_WATCH_MS)} — no TCP client opened. Watch for spontaneous wake-ups.`,
  );
  const startD = Date.now();
  const snapshotStart = startNativeStreamCount;
  const handleStart = handleClientCount;
  const sampleEvery = 10_000;
  let nextSample = Date.now() + sampleEvery;
  while (Date.now() - startD < IDLE_WATCH_MS) {
    await new Promise<void>((r) => setTimeout(r, 500));
    if (Date.now() >= nextSample) {
      console.log(
        `         t+${fmt(Date.now() - startD)}  startNativeStream=${startNativeStreamCount} handleClient=${handleClientCount} api.isReady=${api.isReady}`,
      );
      nextSample += sampleEvery;
    }
  }
  const deltaStart = startNativeStreamCount - snapshotStart;
  const deltaHandle = handleClientCount - handleStart;
  console.log(`\n         idle delta: startNativeStream +${deltaStart}  handleClient +${deltaHandle}`);
  const idleLoopBug = deltaStart > 0 || deltaHandle > 0;
  if (idleLoopBug) {
    console.log("         ❌ WAKE LOOP DETECTED — camera was re-woken during idle");
  } else {
    console.log("         ✓ no spontaneous wake-ups during idle window");
  }

  // ── Phase E ───────────────────────────────────────────────────────────────
  if (phaseBok) {
    console.log(`\nPhase E  reconnect fresh TCP client to verify repeatability…`);
    try {
      const second = await drainMpegTs(port, WAKE_TIMEOUT_MS);
      console.log(
        `         ✓ second wake — first byte at ${fmt(second.firstByteMs)}, drained ${second.totalBytes} bytes`,
      );
    } catch (e) {
      console.log(`         ❌ second wake FAILED: ${e}`);
    }
  } else {
    console.log(`\nPhase E  skipped (Phase B did not wake the camera)`);
  }

  console.log(`\n── Final counters ──`);
  console.log(`  startNativeStream total: ${startNativeStreamCount}`);
  console.log(`  handleClient total:      ${handleClientCount}`);
  console.log(`  Expected: startNativeStream=2, handleClient=2 (no idle restarts, no probes).`);

  await server.stop();
  await api.close().catch(() => {});
  process.exit(idleLoopBug ? 1 : 0);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
