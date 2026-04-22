#!/usr/bin/env npx tsx
/**
 * Regression test: BaichuanVideoStream watchdog fires after stopNativeStream()
 *
 * Reproduces the scenario where a battery camera's RTSP stream is stopped
 * (because no clients remain) but the BaichuanVideoStream watchdog continues
 * running and fires ~60 s after the last received frame, waking the camera.
 *
 * Expected behaviour (correct):
 *   After stopNativeStream() the watchdog is stopped and the camera stays asleep.
 *
 * Bug symptom:
 *   "Watchdog restarting native stream (reason=idle 60xxxms)" appears in the log
 *   AFTER stopNativeStream() has already run.
 *
 * Usage:
 *   npx tsx test/test-battery-watchdog.ts
 *
 * Requires in .env:
 *   UDP_STANDALONE_HOST        IP of the battery camera (campanello)
 *   UDP_STANDALONE_USERNAME    (default: admin)
 *   UDP_STANDALONE_PASSWORD
 *   UDP_STANDALONE_UID         BCUDP UID for wakeup
 */

import * as net from "node:net";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi.js";
import { BaichuanRtspServer } from "../src/baichuan/stream/BaichuanRtspServer.js";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HOST     = process.env.UDP_STANDALONE_HOST;
const USERNAME = process.env.UDP_STANDALONE_USERNAME ?? "admin";
const PASSWORD = process.env.UDP_STANDALONE_PASSWORD ?? "";
const UID      = process.env.UDP_STANDALONE_UID;

if (!HOST) {
  console.error("UDP_STANDALONE_HOST not set in .env");
  process.exit(1);
}

/** How long the RTSP client streams before disconnecting (ms). */
const STREAM_DURATION_MS = 35_000;
/** How long after stop to observe for unwanted watchdog activity (ms). */
const OBSERVE_DURATION_MS = 90_000;
/** Battery camera idle-stop: stop native stream 15 s after last client leaves. */
const NATIVE_IDLE_STOP_MS = 15_000;

// ---------------------------------------------------------------------------
// Intercepting logger
// ---------------------------------------------------------------------------
interface LogEntry { level: "info" | "warn" | "error" | "debug"; msg: string; ts: number }
const logEntries: LogEntry[] = [];
let stopNativeStreamCalledAt = 0;
let watchdogFiredAfterStop = false;

function makeLogger(tag: string) {
  const emit = (level: LogEntry["level"], msg: string) => {
    const ts = Date.now();
    const line = `[${new Date(ts).toISOString()}] [${tag}] ${msg}`;
    logEntries.push({ level, msg, ts });

    // Detect when stopNativeStream logs its starting message.
    if (msg.includes("native stream stopping")) {
      stopNativeStreamCalledAt = ts;
      console.log(`  ⏱  stopNativeStream() fired`);
    }

    // Detect watchdog firing.
    if (msg.includes("Watchdog restarting native stream")) {
      const afterStop = stopNativeStreamCalledAt > 0;
      if (afterStop) {
        watchdogFiredAfterStop = true;
        console.error(`  ✗ BUG: ${line}`);
        console.error(`       Watchdog fired ${ts - stopNativeStreamCalledAt}ms after stopNativeStream()`);
      } else {
        console.log(`  ℹ  ${line} (before stop — expected during initial wakeup)`);
      }
    } else if (level === "warn" || level === "error") {
      console.log(`  [${level.toUpperCase()}] ${line}`);
    } else if (level === "info") {
      console.log(`  ${line}`);
    }
  };

  return {
    info:  (m: string) => emit("info",  m),
    warn:  (m: string) => emit("warn",  m),
    error: (m: string) => emit("error", m),
    debug: (_: string) => {},
  };
}

// ---------------------------------------------------------------------------
// Inline RTSP client
// ---------------------------------------------------------------------------
interface StreamSession {
  framesReceived: number;
  firstFrameMs: number | null;
  destroy(): void;
}

function openRtspStream(host: string, port: number, rtspPath: string): StreamSession {
  const url = `rtsp://${host}:${port}${rtspPath}`;
  let cseq = 1;
  let sessionId = "";
  let sdp = "";
  let contentBase = url;
  let videoTrackUrl = "";
  let phase: "options" | "describe" | "setup" | "play" | "streaming" = "options";
  let framesReceived = 0;
  let firstFrameMs: number | null = null;
  const startTs = Date.now();
  let interleavedBuf = Buffer.alloc(0);
  let headerBuf = Buffer.alloc(0);

  const socket = net.createConnection(port, host);

  const send = (msg: string) => {
    if (!socket.destroyed) socket.write(msg);
  };

  const nextRequest = () => {
    if (phase === "options") {
      send(`OPTIONS ${url} RTSP/1.0\r\nCSeq: ${cseq++}\r\n\r\n`);
    } else if (phase === "describe") {
      send(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\n\r\n`);
    } else if (phase === "setup") {
      const trackUrl = videoTrackUrl
        ? (videoTrackUrl.startsWith("rtsp://")
            ? videoTrackUrl
            : `${contentBase.replace(/\/$/, "")}/${videoTrackUrl}`)
        : `${contentBase.replace(/\/$/, "")}/track0`;
      send(`SETUP ${trackUrl} RTSP/1.0\r\nCSeq: ${cseq++}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`);
    } else if (phase === "play") {
      send(`PLAY ${contentBase} RTSP/1.0\r\nCSeq: ${cseq++}\r\nSession: ${sessionId}\r\nRange: npt=0.000-\r\n\r\n`);
      phase = "streaming";
    }
  };

  socket.on("connect", () => nextRequest());

  socket.on("data", (chunk: Buffer) => {
    if (phase === "streaming") {
      interleavedBuf = Buffer.concat([interleavedBuf, chunk]);
      let idx = 0;
      while (idx < interleavedBuf.length) {
        if (interleavedBuf[idx] !== 0x24) { idx++; continue; }
        if (interleavedBuf.length < idx + 4) break;
        const ch = interleavedBuf[idx + 1]!;
        const len = interleavedBuf.readUInt16BE(idx + 2);
        if (interleavedBuf.length < idx + 4 + len) break;
        if (ch === 0) {
          framesReceived++;
          if (firstFrameMs === null) firstFrameMs = Date.now() - startTs;
        }
        idx += 4 + len;
      }
      interleavedBuf = interleavedBuf.slice(idx);
      return;
    }

    headerBuf = Buffer.concat([headerBuf, chunk]);
    const text = headerBuf.toString("utf8");
    const endIdx = text.indexOf("\r\n\r\n");
    if (endIdx === -1) return;

    const header = text.slice(0, endIdx);
    const bodyStart = endIdx + 4;

    if (phase === "describe") {
      const clMatch = header.match(/Content-Length:\s*(\d+)/i);
      const cl = clMatch ? parseInt(clMatch[1]!, 10) : 0;
      if (headerBuf.length < bodyStart + cl) return;
      sdp = headerBuf.slice(bodyStart, bodyStart + cl).toString("utf8");
      headerBuf = headerBuf.slice(bodyStart + cl);
      const cbMatch = header.match(/Content-Base:\s*([^\r\n]+)/i);
      if (cbMatch) contentBase = cbMatch[1]!.trim();
      const ctrlMatch = sdp.match(/a=control:(track\S+)/);
      if (ctrlMatch) videoTrackUrl = ctrlMatch[1]!;
    } else {
      headerBuf = headerBuf.slice(bodyStart);
    }

    if (phase === "setup") {
      const sesMatch = header.match(/Session:\s*([^;\r\n]+)/i);
      if (sesMatch) sessionId = sesMatch[1]!.trim();
    }

    const prev = phase;
    if (prev === "options") phase = "describe";
    else if (prev === "describe") phase = "setup";
    else if (prev === "setup") phase = "play";
    nextRequest();
  });

  socket.on("error", (e) => {
    if (!socket.destroyed) console.log(`  [socket] ${e.message}`);
  });

  return {
    get framesReceived() { return framesReceived; },
    get firstFrameMs()   { return firstFrameMs; },
    destroy()            { socket.destroy(); },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(" Battery watchdog regression test — BaichuanRtspServer");
  console.log(`  Camera : ${HOST}  uid=${UID ?? "(none)"}`);
  console.log(`  Stream : ${STREAM_DURATION_MS / 1000}s   nativeIdleStop=${NATIVE_IDLE_STOP_MS / 1000}s`);
  console.log(`  Observe: ${OBSERVE_DURATION_MS / 1000}s after stop`);
  console.log("═══════════════════════════════════════════════════════════════");

  const apiLogger = makeLogger("api");
  const serverLogger = makeLogger("server");

  const api = new ReolinkBaichuanApi({
    host: HOST!,
    username: USERNAME,
    password: PASSWORD,
    channel: 0,
    ...(UID ? { uid: UID } : {}),
    transport: "udp",
    udpDiscoveryMethod: "local-direct",
    logger: apiLogger,
  });

  // BaichuanRtspServer in standalone mode (no mux) with battery camera settings.
  const server = new BaichuanRtspServer({
    api,
    channel: 0,
    profile: "main",
    listenHost: "127.0.0.1",
    listenPort: 0,
    lazyMetadata: true,
    nativeStreamIdleStopMs: NATIVE_IDLE_STOP_MS,
    nativeStreamPrimeIdleStopMs: NATIVE_IDLE_STOP_MS,
    logger: serverLogger,
  });

  await server.start();
  const port = (server as any).listenPort as number;
  const rtspPath = (server as any).path as string;
  if (!port) {
    console.error("  ✗ Server did not bind a port");
    process.exit(1);
  }
  console.log(`\n  Server listening on rtsp://127.0.0.1:${port}${rtspPath}`);

  // ── Phase 1: connect RTSP client and stream ────────────────────────────────
  console.log(`\n── Phase 1: Streaming for ${STREAM_DURATION_MS / 1000}s ──`);
  const session = openRtspStream("127.0.0.1", port, rtspPath);

  // Poll for first frame (wakeup can take up to ~30s for battery cameras)
  const wakeupTimeout = 35_000;
  const wakeupStart = Date.now();
  while (session.firstFrameMs === null && Date.now() - wakeupStart < wakeupTimeout) {
    await sleep(500);
  }

  if (session.firstFrameMs === null) {
    console.error("  ✗ No frames received within wakeup timeout — camera may be sleeping");
    session.destroy();
    await server.stop();
    await api.close().catch(() => {});
    process.exit(1);
  }

  console.log(`  ✓ First frame in ${session.firstFrameMs}ms`);
  console.log(`  Streaming for ${STREAM_DURATION_MS / 1000}s…`);
  await sleep(STREAM_DURATION_MS);

  const frameCount = session.framesReceived;
  console.log(`  ✓ ${frameCount} RTP frames received`);

  // ── Phase 2: disconnect client ─────────────────────────────────────────────
  console.log(`\n── Phase 2: Client disconnect ──`);
  console.log(`  Closing RTSP socket`);
  session.destroy();

  // Wait for nativeStreamIdleStopMs to fire (server logs "native stream stopping")
  const stopWait = NATIVE_IDLE_STOP_MS + 3_000;
  console.log(`  Waiting ${stopWait / 1000}s for idle-stop timer…`);
  await sleep(stopWait);

  if (stopNativeStreamCalledAt === 0) {
    console.warn("  ⚠  stopNativeStream() has not been called yet (log not seen)");
  } else {
    console.log(`  ✓ stopNativeStream() was called`);
  }

  // ── Phase 3: observe for watchdog ─────────────────────────────────────────
  console.log(`\n── Phase 3: Observing for ${OBSERVE_DURATION_MS / 1000}s ──`);
  console.log("  Watching for unwanted watchdog activity after stop…");

  const observeStart = Date.now();
  while (Date.now() - observeStart < OBSERVE_DURATION_MS) {
    await sleep(1_000);
    if (watchdogFiredAfterStop) break;
  }

  // ── Teardown ───────────────────────────────────────────────────────────────
  await server.stop();
  await api.close().catch(() => {});

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  if (watchdogFiredAfterStop) {
    console.error(" RESULT: BUG REPRODUCED");
    console.error("         Watchdog fired after stopNativeStream() — camera was woken unnecessarily");
    process.exit(1);
  } else {
    console.log(" RESULT: PASS — watchdog did not fire after stopNativeStream()");
  }
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
