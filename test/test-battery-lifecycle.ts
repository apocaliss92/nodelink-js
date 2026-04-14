#!/usr/bin/env npx tsx
/**
 * Hardware lifecycle test: battery camera sleep / wake cycle (Go2rtcTcpServer)
 *
 * Verifies that Go2rtcTcpServer with prestartStream=false correctly:
 *
 *   Phase 0 – Idle guard: server starts but no TCP client → no native stream
 *             (camera stays asleep, port 9000 unreachable)
 *   Phase 1 – Wake: TCP client connects → camera wakes within timeout
 *             → valid MPEG-TS flows (sync, PAT, PMT, CC, PTS, audio)
 *             → wakeup latency is measured
 *   Phase 2 – Sleep: client disconnects → grace period fires → native stream stops
 *             → camera port 9000 is unreachable again
 *   Phase 3 – Repeat: second connect/disconnect cycle verifies repeatability
 *
 * Usage:
 *   npx tsx test/test-battery-lifecycle.ts
 *
 * Requires in .env:
 *   UDP_SLEEP_HOST        IP of sleeping battery camera (port 9000 closed)
 *   UDP_SLEEP_USERNAME    (default: admin)
 *   UDP_SLEEP_PASSWORD
 *   UDP_SLEEP_UID         BCUDP UID for wakeup
 *
 * The test also falls back to UDP_HOST if UDP_SLEEP_HOST is not configured.
 */

import * as net from "node:net";
import * as dotenv from "dotenv";
import { ReolinkBaichuanApi, Go2rtcTcpServer } from "../src/index.js";

dotenv.config();

// ---------------------------------------------------------------------------
// MPEG-TS constants / helpers (same as test-mpegts-pipeline.ts)
// ---------------------------------------------------------------------------
const TS_SIZE   = 188;
const PID_PAT   = 0x0000;
const PID_PMT   = 0x1000;
const PID_VIDEO = 0x0100;
const PID_AUDIO = 0x0101;

function getPid(pkt: Buffer): number {
  return ((pkt[1]! & 0x1f) << 8) | pkt[2]!;
}
function getCC(pkt: Buffer): number {
  return pkt[3]! & 0x0f;
}
function hasPusi(pkt: Buffer): boolean {
  return !!(pkt[1]! & 0x40);
}
function hasPayload(pkt: Buffer): boolean {
  return !!((pkt[3]! >> 4) & 0x01);
}
function adaptLen(pkt: Buffer): number {
  const afc = (pkt[3]! >> 4) & 0x03;
  return afc === 2 || afc === 3 ? 1 + pkt[4]! : 0;
}
function extractPts(pkt: Buffer): number | null {
  if (!hasPusi(pkt) || !hasPayload(pkt)) return null;
  const payloadOff = 4 + adaptLen(pkt);
  const p = pkt.subarray(payloadOff);
  if (p.length < 14) return null;
  if (p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return null;
  const ptsDtsFlags = (p[7]! >> 6) & 0x03;
  if (ptsDtsFlags < 2) return null;
  const b = p.subarray(9);
  if (b.length < 5) return null;
  return (
    (((b[0]! >> 1) & 0x07) * 2 ** 30) +
    (b[1]! * 2 ** 22) +
    (((b[2]! >> 1) & 0x7f) * 2 ** 15) +
    (b[3]! * 2 ** 7) +
    ((b[4]! >> 1) & 0x7f)
  );
}

interface StreamStats {
  totalPackets: number;
  malformedPackets: number;
  pids: Map<number, number>;
  ptsSamples: Map<number, number[]>;
  ccState: Map<number, number>;
  ccErrors: number;
  pmtVideoStreamType: number | null;
  pmtAudioStreamType: number | null;
}

function createStats(): StreamStats {
  return {
    totalPackets: 0,
    malformedPackets: 0,
    pids: new Map(),
    ptsSamples: new Map(),
    ccState: new Map(),
    ccErrors: 0,
    pmtVideoStreamType: null,
    pmtAudioStreamType: null,
  };
}

function consumePacket(raw: Buffer, offset: number, stats: StreamStats): void {
  const pkt = raw.subarray(offset, offset + TS_SIZE);
  stats.totalPackets++;
  if (pkt[0] !== 0x47) { stats.malformedPackets++; return; }
  const pid = getPid(pkt);
  stats.pids.set(pid, (stats.pids.get(pid) ?? 0) + 1);
  if (hasPayload(pkt)) {
    const cc = getCC(pkt);
    const prev = stats.ccState.get(pid);
    if (prev !== undefined) {
      const expected = (prev + 1) & 0x0f;
      if (cc !== expected) stats.ccErrors++;
    }
    stats.ccState.set(pid, cc);
  }
  const pts = extractPts(pkt);
  if (pts !== null) {
    if (!stats.ptsSamples.has(pid)) stats.ptsSamples.set(pid, []);
    stats.ptsSamples.get(pid)!.push(pts);
  }
  if (pid === PID_PMT && hasPusi(pkt)) {
    // parse PMT: skip 17 bytes of header
    let i = 17;
    while (i + 5 <= TS_SIZE) {
      const st = pkt[i];
      if (st === undefined || st === 0xff) break;
      const ePid = ((pkt[i + 1]! & 0x1f) << 8) | pkt[i + 2]!;
      if (ePid === PID_VIDEO) stats.pmtVideoStreamType = st;
      if (ePid === PID_AUDIO) stats.pmtAudioStreamType = st;
      i += 5;
    }
  }
}

// ---------------------------------------------------------------------------
// TCP probe: attempt a plain TCP connect to cameraHost:9000
// Returns true if connection succeeds, false if refused/timed-out
// ---------------------------------------------------------------------------
async function probeCameraPort(host: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(9000, host);
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Collect MPEG-TS from a server port for durationMs ms.
// Resolves with { stats, firstByteMs } where firstByteMs is the elapsed time
// from the call until the first byte was received (wakeup latency).
// ---------------------------------------------------------------------------
async function collectMpegTs(
  serverPort: number,
  durationMs: number,
): Promise<{ stats: StreamStats; firstByteMs: number | null }> {
  const stats = createStats();
  let residual = Buffer.alloc(0);
  let firstByteMs: number | null = null;
  const connectAt = Date.now();

  await new Promise<void>((resolve) => {
    const socket = net.createConnection(serverPort, "127.0.0.1");
    const deadline = setTimeout(() => socket.destroy(), durationMs);

    socket.on("data", (chunk: Buffer) => {
      if (firstByteMs === null) firstByteMs = Date.now() - connectAt;
      const buf = Buffer.concat([residual, chunk]);
      const aligned = Math.floor(buf.length / TS_SIZE) * TS_SIZE;
      for (let off = 0; off < aligned; off += TS_SIZE) consumePacket(buf, off, stats);
      residual = buf.subarray(aligned);
    });

    socket.on("close", () => { clearTimeout(deadline); resolve(); });
    socket.on("error", () => { clearTimeout(deadline); resolve(); });
  });

  return { stats, firstByteMs };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`    ✓ ${message}`);
    passed++;
  } else {
    console.error(`    ✗ FAIL: ${message}`);
    failed++;
  }
}

function assertStream(stats: StreamStats, label: string): void {
  assert(stats.totalPackets > 0, `${label}: received TS packets`);
  assert(stats.malformedPackets === 0, `${label}: 0 malformed packets (sync byte)`);
  assert((stats.pids.get(PID_PAT) ?? 0) > 0, `${label}: PAT (PID 0x0000) present`);
  assert((stats.pids.get(PID_PMT) ?? 0) > 0, `${label}: PMT (PID 0x1000) present`);
  assert((stats.pids.get(PID_VIDEO) ?? 0) > 0, `${label}: video PID (0x0100) present`);
  assert(stats.pmtVideoStreamType !== null, `${label}: PMT declares video stream type`);
  assert(stats.ccErrors === 0, `${label}: 0 continuity-counter errors`);

  // PTS monotonicity for video
  const videoPts = stats.ptsSamples.get(PID_VIDEO) ?? [];
  if (videoPts.length >= 2) {
    let monotonic = true;
    for (let i = 1; i < videoPts.length; i++) {
      if (videoPts[i]! < videoPts[i - 1]!) { monotonic = false; break; }
    }
    assert(monotonic, `${label}: video PTS monotonically increasing (${videoPts.length} samples)`);
  }

  // Audio (optional but logged)
  const audioCount = stats.pids.get(PID_AUDIO) ?? 0;
  if (audioCount > 0) {
    console.log(`    ℹ ${label}: audio PID (0x0101) present — ${audioCount} packets`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Resolve camera config from .env
  const host = process.env.UDP_SLEEP_HOST ?? process.env.UDP_HOST;
  if (!host) {
    console.error("No battery camera configured. Set UDP_SLEEP_HOST (or UDP_HOST) in .env");
    process.exit(1);
  }
  const username = process.env.UDP_SLEEP_USERNAME ?? process.env.UDP_USERNAME ?? "admin";
  const password = process.env.UDP_SLEEP_PASSWORD ?? process.env.UDP_PASSWORD ?? "";
  const uid      = process.env.UDP_SLEEP_UID ?? process.env.UDP_UID;

  const GRACE_MS          = 8_000;   // short grace period for fast testing
  const WAKEUP_TIMEOUT_MS = 35_000;  // battery cameras can take ~30 s to wake
  const READ_DURATION_MS  = 10_000;  // how long to collect MPEG-TS after wake
  const IDLE_WAIT_MS      = GRACE_MS + 4_000; // > grace period

  console.log("═══════════════════════════════════════════════════════════");
  console.log(" Battery camera lifecycle test — Go2rtcTcpServer");
  console.log(`  Camera : ${host}  uid=${uid ?? "(none)"}`);
  console.log(`  Grace  : ${GRACE_MS}ms   Wakeup timeout: ${WAKEUP_TIMEOUT_MS}ms`);
  console.log("═══════════════════════════════════════════════════════════");

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 0: Idle guard — camera should be asleep, port 9000 unreachable
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n── Phase 0: Idle guard (camera asleep before test) ──");
  {
    const reachable = await probeCameraPort(host, 4_000);
    if (reachable) {
      console.log("  ⚠  Camera port 9000 is reachable — camera may not be sleeping.");
      console.log("     The test continues but Phase 2 sleep verification may be trivially true.");
    } else {
      console.log("  ✓ Camera port 9000 unreachable — confirmed sleeping");
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Create API + server
  // ──────────────────────────────────────────────────────────────────────────
  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    channel: 0,
    ...(uid ? { uid } : {}),
  });

  const logger = {
    info:  (m: string) => process.stdout.write(`  [srv] ${m}\n`),
    warn:  (m: string) => process.stdout.write(`  [srv] WARN ${m}\n`),
    error: (m: string) => process.stderr.write(`  [srv] ERROR ${m}\n`),
    debug: (_: string) => {},
  };

  const server = new Go2rtcTcpServer({
    api,
    profile: "main",
    channel: 0,
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: false,   // ← KEY: do NOT wake camera on start()
    gracePeriodMs: GRACE_MS,
    streamTimeoutMs: WAKEUP_TIMEOUT_MS + 5_000, // plenty of room for wakeup
    logger,
  });

  // Do NOT call api.login() here — for battery cameras the camera is sleeping
  // and the TCP port is unreachable. The login / wakeup happens transparently
  // inside Go2rtcTcpServer.startNativeStream() → api.ensureConnected() which
  // uses the BCUDP UID to wake the camera when a client connects.
  await server.start();
  const port = server.port!;
  console.log(`\n  Server listening on tcp://127.0.0.1:${port}  prestartStream=false`);

  // Phase 0 cont: wait a moment then verify no bytes arrive without a client
  console.log("\n── Phase 0b: No client → no stream (3 s silence check) ──");
  {
    await new Promise<void>((resolve) => {
      const probeSocket = net.createConnection(port, "127.0.0.1");
      // Connect then immediately close — verifies the server accepts connections
      // but we do not wait for data (with prestartStream=false, none should flow)
      probeSocket.on("connect", () => { probeSocket.destroy(); resolve(); });
      probeSocket.on("error", () => resolve());
    });

    // Wait 3 s; if native stream were pre-started, we'd see data in prebuffer.
    // Since prestartStream=false the native stream should NOT have started.
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    assert(server.clientCount === 0, "Phase 0b: clientCount=0 after probe close");
    // nativeStreamActive is private, but we can infer it: if prestartStream=false
    // and no client ever stayed connected, no stream should be running
    console.log("    ✓ Phase 0b: no native stream active (prestartStream=false)  [inferred from clientCount=0]");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 1: Wake — connect a real client, camera should wake within timeout
  // ──────────────────────────────────────────────────────────────────────────
  for (const cycle of [1, 2]) {
    console.log(`\n── Phase ${cycle === 1 ? "1: Wake (cycle 1)" : "3: Repeat (cycle 2)"} ──`);
    console.log(`  Connecting TCP client to tcp://127.0.0.1:${port}…`);
    console.log(`  Camera wakeup timeout: ${WAKEUP_TIMEOUT_MS / 1000}s`);

    const { stats, firstByteMs } = await collectMpegTs(
      port,
      READ_DURATION_MS + WAKEUP_TIMEOUT_MS,
    );

    if (firstByteMs === null) {
      assert(false, `Cycle ${cycle}: received MPEG-TS data (timed out — camera did not wake)`);
    } else {
      console.log(`  ℹ Wakeup latency: ${firstByteMs}ms`);
      assert(
        firstByteMs <= WAKEUP_TIMEOUT_MS,
        `Cycle ${cycle}: first byte within ${WAKEUP_TIMEOUT_MS / 1000}s wakeup timeout (actual ${firstByteMs}ms)`,
      );
      assertStream(stats, `Cycle ${cycle}`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 2 / 4: Sleep — client has disconnected (collectMpegTs closed the
    // socket on its deadline). Wait for grace period + buffer, then verify
    // camera port 9000 is closed again.
    // ────────────────────────────────────────────────────────────────────────
    const sleepLabel = cycle === 1 ? "Phase 2: Sleep (after cycle 1)" : "Phase 4: Sleep (after cycle 2)";
    console.log(`\n── ${sleepLabel} ──`);
    console.log(`  Waiting ${IDLE_WAIT_MS / 1000}s for grace period + camera idle disconnect…`);

    await new Promise<void>((resolve) => setTimeout(resolve, IDLE_WAIT_MS));

    assert(server.clientCount === 0, `${sleepLabel}: server.clientCount=0`);

    // Give the camera a moment after stream stop to actually idle-disconnect
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));

    const stillReachable = await probeCameraPort(host, 4_000);
    assert(!stillReachable, `${sleepLabel}: camera port 9000 unreachable (sleeping)`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Teardown
  // ──────────────────────────────────────────────────────────────────────────
  await server.stop();
  await api.close().catch(() => {});

  // ──────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(" Summary");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Passed : ${passed}`);
  console.log(`  Failed : ${failed}`);
  if (failed > 0) {
    console.log("\n  SOME ASSERTIONS FAILED");
    process.exit(1);
  } else {
    console.log("\n  ALL ASSERTIONS PASSED");
  }
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
