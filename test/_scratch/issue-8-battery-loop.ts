/* eslint-disable no-console */
/**
 * Hardware reproduction of issue #8 — "battery awake/sleep loop after the
 * stream stops".
 *
 * Target: NVR ch0 "Videocamera lavanderia" (Argus 3E), confirmed sleeping.
 *
 * Phases:
 *   A  Start Go2rtcTcpServer (prestartStream=false) pointed at the sleeping
 *      battery channel.
 *   B  Open a TCP client, consume MPEG-TS until at least one keyframe arrives
 *      (= native stream awake, camera woken).
 *   C  Disconnect the TCP client, wait for the grace period, verify native
 *      stream stops.
 *   D  OBSERVATION WINDOW (60 s) — no TCP client, no external action.
 *      Verify:
 *        - createNativeStream is NOT called again (no auto-restart on EOF)
 *        - no handleClient invocations (only a real consumer connect should
 *          wake the camera — nothing else).
 *      This is the key check for the ~60 s wake loop report.
 *   E  Reconnect a second TCP client and confirm the wake-up still works
 *      (repeatability).
 *
 * Requires .env:
 *   NVR_HOST, NVR_USERNAME, NVR_PASSWORD (+ optionally NVR_UID).
 *
 * Usage: npx tsx test/_scratch/issue-8-battery-loop.ts
 */

import "dotenv/config";
import * as net from "node:net";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { Go2rtcTcpServer } from "../../src/baichuan/stream/Go2rtcTcpServer";

const CHANNEL = Number(process.env.ISSUE8_CHANNEL ?? 0);
const PROFILE = (process.env.ISSUE8_PROFILE ?? "sub") as "main" | "sub" | "ext";
const WAKE_TIMEOUT_MS = 60_000;
const IDLE_WATCH_MS = 60_000;
const GRACE_MS = 8_000;

function fmt(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function drainMpegTsUntilFirstKeyframe(
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
      // ~100 KB is plenty to confirm stream is flowing (includes several
      // MPEG-TS 188-byte packets including PAT/PMT and video PES).
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
  const host = process.env.NVR_HOST!;
  const username = process.env.NVR_USERNAME ?? "admin";
  const password = process.env.NVR_PASSWORD ?? "";
  if (!host) throw new Error("NVR_HOST not set");

  console.log(`\n── Issue #8 repro — NVR ${host} ch${CHANNEL}/${PROFILE} ──`);
  const api = new ReolinkBaichuanApi({ host, username, password });

  // Counters intercept createNativeStream usage via a spy on the server.
  let handleClientCount = 0;
  let startNativeStreamCount = 0;

  await api.login();

  // Confirm the target channel is actually battery + sleeping.
  const summary = await api.getNvrChannelsSummary({ source: "cgi" });
  const dev = summary.devices.find((d) => d.channel === CHANNEL);
  if (!dev) throw new Error(`channel ${CHANNEL} not found on NVR`);
  console.log(
    `  target: ch${dev.channel} "${dev.name}" model=${dev.model} battery=${dev.isBattery} sleeping=${dev.sleeping}`,
  );
  if (!dev.isBattery) {
    console.log("  ⚠️  channel is NOT marked battery — results may not reflect the loop bug");
  }

  const server = new Go2rtcTcpServer({
    api,
    channel: CHANNEL,
    profile: PROFILE,
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: false,
    gracePeriodMs: GRACE_MS,
    streamTimeoutMs: 25_000,
    logger: {
      info: (m: string) => process.stdout.write(`  [srv] ${m}\n`),
      warn: (m: string) => process.stdout.write(`  [srv WARN] ${m}\n`),
      error: (m: string) => process.stderr.write(`  [srv ERR] ${m}\n`),
      debug: (_: string) => {},
    },
  });

  // Monkey-patch to count internal activations
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

  // ── Phase A ───────────────────────────────────────────────────────────────
  await server.start();
  const port = server.port!;
  console.log(`\nPhase A  server listening on tcp://127.0.0.1:${port}  prestart=false`);
  console.log(`         startNativeStream=${startNativeStreamCount}  handleClient=${handleClientCount}`);

  // ── Phase B ───────────────────────────────────────────────────────────────
  console.log(`\nPhase B  opening TCP client, expecting wake-up within ${fmt(WAKE_TIMEOUT_MS)}…`);
  const { firstByteMs, totalBytes } = await drainMpegTsUntilFirstKeyframe(
    port,
    WAKE_TIMEOUT_MS,
  );
  console.log(
    `         ✓ camera woke — first byte at ${fmt(firstByteMs)}, drained ${totalBytes} bytes before disconnect`,
  );

  // ── Phase C ───────────────────────────────────────────────────────────────
  console.log(`\nPhase C  waiting grace (${fmt(GRACE_MS)}) + 3 s for native stream to stop…`);
  await new Promise<void>((r) => setTimeout(r, GRACE_MS + 3_000));
  console.log(
    `         after grace: startNativeStream=${startNativeStreamCount}  handleClient=${handleClientCount}`,
  );

  // ── Phase D ───────────────────────────────────────────────────────────────
  console.log(`\nPhase D  idle observation for ${fmt(IDLE_WATCH_MS)} — no TCP client opened.`);
  const startD = Date.now();
  const snapshotStart = startNativeStreamCount;
  const handleStart = handleClientCount;
  const sampleEvery = 10_000;
  let nextSample = Date.now() + sampleEvery;
  while (Date.now() - startD < IDLE_WATCH_MS) {
    await new Promise<void>((r) => setTimeout(r, 500));
    if (Date.now() >= nextSample) {
      console.log(
        `         t+${fmt(Date.now() - startD)}  startNativeStream=${startNativeStreamCount}  handleClient=${handleClientCount}`,
      );
      nextSample += sampleEvery;
    }
  }
  const deltaStart = startNativeStreamCount - snapshotStart;
  const deltaHandle = handleClientCount - handleStart;
  console.log(
    `\n         idle delta: startNativeStream +${deltaStart}  handleClient +${deltaHandle}`,
  );
  const idleLoopBug = deltaStart > 0 || deltaHandle > 0;
  if (idleLoopBug) {
    console.log("         ❌ WAKE LOOP DETECTED — camera was re-woken during idle");
  } else {
    console.log("         ✓ no spontaneous wake-ups during idle window");
  }

  // ── Phase E ───────────────────────────────────────────────────────────────
  console.log(`\nPhase E  reconnect a fresh TCP client to verify repeatability…`);
  try {
    const second = await drainMpegTsUntilFirstKeyframe(port, WAKE_TIMEOUT_MS);
    console.log(
      `         ✓ second wake — first byte at ${fmt(second.firstByteMs)}, drained ${second.totalBytes} bytes`,
    );
  } catch (e) {
    console.log(`         ❌ second wake FAILED: ${e}`);
  }

  console.log(`\n── Final counters ──`);
  console.log(`  startNativeStream total: ${startNativeStreamCount}`);
  console.log(`  handleClient total:      ${handleClientCount}`);
  console.log(
    `  Expected with fix: startNativeStream=2 (phase B + phase E), handleClient=2.`,
  );

  await server.stop();
  await api.close().catch(() => {});
  process.exit(idleLoopBug ? 1 : 0);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
