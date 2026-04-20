/* eslint-disable no-console */
/**
 * Reproduction harness for issue #8 (Khomotica): wired-cam ECONNRESET loop.
 *
 * User report:
 *   [rtsp:CamFront:sub] [Go2rtcTcpServer] client connected  ...
 *   [rtsp:CamFront:sub] [Go2rtcTcpServer] prebuffer replay  frames=38
 *   [rtsp:CamFront:sub] [Go2rtcTcpServer] entering live loop  seenKeyframe=true
 *   [rtsp:CamFront:sub] [Go2rtcTcpServer] client disconnected  reason=error: read ECONNRESET
 *   (repeats forever, stream eventually gets stuck → must disconnect/reconnect)
 *
 *   [camera:CamFront] [BaichuanVideoStream] Frame streamType mismatch: received=1, ...
 *
 * This script:
 *   1. Starts Go2rtcTcpServer main + sub on a wired cam (prestart=true).
 *   2. Simulates fast go2rtc client connect→drop cycles for several minutes.
 *   3. Logs server/native stream health: totalRx, clientCount, ECONNRESET count,
 *      time-to-first-frame on each reconnect, any stalls.
 *
 * Expected (healthy): each reconnect replays the prebuffer, live loop resumes,
 * frames keep flowing. Total ECONNRESETs = N client cycles, stream remains OK.
 *
 * Regression (bug): after M cycles, a new client either never gets frames
 * (prebuffer empty + no live frames) or the native stream dies without
 * auto-restart.
 */

import "dotenv/config";
import * as net from "node:net";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { Go2rtcTcpServer } from "../../src/baichuan/stream/Go2rtcTcpServer";

const HOST = process.env.ISSUE8_WIRED_HOST ?? process.env.TCP265_HOST ?? process.env.TCP_HOST;
const USER = process.env.ISSUE8_WIRED_USER ?? process.env.TCP265_USERNAME ?? process.env.TCP_USERNAME ?? "admin";
const PASS = process.env.ISSUE8_WIRED_PASS ?? process.env.TCP265_PASSWORD ?? process.env.TCP_PASSWORD ?? "";
const CYCLES = Number(process.env.ISSUE8_CYCLES ?? 40);
const CLIENT_HOLD_MS = Number(process.env.ISSUE8_HOLD_MS ?? 1_500);
const GAP_MS = Number(process.env.ISSUE8_GAP_MS ?? 500);

if (!HOST) {
  console.error("set TCP_HOST or TCP265_HOST (or ISSUE8_WIRED_HOST) in .env");
  process.exit(2);
}

type Counters = {
  connects: number;
  cleanCloses: number;
  econnresets: number;
  zeroByteCloses: number;
  firstByteLatenciesMs: number[];
  totalBytes: number;
};

async function runOneClient(
  port: number,
  counters: Counters,
  holdMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    counters.connects++;
    const start = Date.now();
    let bytes = 0;
    let firstByteMs = -1;
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (firstByteMs < 0) counters.zeroByteCloses++;
      else counters.firstByteLatenciesMs.push(firstByteMs);
      counters.totalBytes += bytes;
      resolve();
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish();
    }, holdMs);
    sock.on("data", (chunk) => {
      if (firstByteMs < 0) firstByteMs = Date.now() - start;
      bytes += chunk.length;
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET") counters.econnresets++;
      clearTimeout(timer);
      finish();
    });
    sock.on("close", (hadErr) => {
      if (!hadErr) counters.cleanCloses++;
      clearTimeout(timer);
      finish();
    });
  });
}

async function runCycle(
  label: string,
  port: number,
  counters: Counters,
): Promise<void> {
  for (let i = 0; i < CYCLES; i++) {
    await runOneClient(port, counters, CLIENT_HOLD_MS);
    if (i % 5 === 4) {
      const avg =
        counters.firstByteLatenciesMs.length > 0
          ? Math.round(
              counters.firstByteLatenciesMs.reduce((a, b) => a + b, 0) /
                counters.firstByteLatenciesMs.length,
            )
          : -1;
      console.log(
        `  [${label}] cycle ${i + 1}/${CYCLES}  ` +
          `connects=${counters.connects} firstByteOk=${counters.firstByteLatenciesMs.length} ` +
          `zeroByte=${counters.zeroByteCloses} ECONNRESET=${counters.econnresets} ` +
          `avgFirstByte=${avg}ms totalBytes=${counters.totalBytes}`,
      );
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
}

async function main() {
  console.log(`\n── Issue #8 wired ECONNRESET repro — ${HOST} ──`);
  console.log(
    `cycles=${CYCLES} hold=${CLIENT_HOLD_MS}ms gap=${GAP_MS}ms (per profile, main+sub in parallel)\n`,
  );

  const api = new ReolinkBaichuanApi({
    host: HOST,
    username: USER,
    password: PASS,
    debugOptions: { general: true }, // enable streamType mismatch logs for this repro
  });
  await api.login();

  const makeServer = (profile: "main" | "sub") =>
    new Go2rtcTcpServer({
      api,
      channel: 0,
      profile,
      listenHost: "127.0.0.1",
      listenPort: 0,
      prestartStream: true, // wired cam: pre-start to keep native stream warm
      gracePeriodMs: 5_000,
      streamTimeoutMs: 15_000,
      logger: {
        info: (m: string) =>
          process.stdout.write(`  [${profile}] ${m}\n`),
        warn: (m: string) =>
          process.stdout.write(`  [${profile} WARN] ${m}\n`),
        error: (m: string) =>
          process.stderr.write(`  [${profile} ERR] ${m}\n`),
        debug: () => {},
      },
    });

  const mainSrv = makeServer("main");
  const subSrv = makeServer("sub");

  await mainSrv.start();
  await subSrv.start();

  console.log(
    `main port=${mainSrv.port}  sub port=${subSrv.port}  — waiting 4s for prestart…\n`,
  );
  await new Promise((r) => setTimeout(r, 4_000));

  const mainCounters: Counters = {
    connects: 0,
    cleanCloses: 0,
    econnresets: 0,
    zeroByteCloses: 0,
    firstByteLatenciesMs: [],
    totalBytes: 0,
  };
  const subCounters: Counters = {
    connects: 0,
    cleanCloses: 0,
    econnresets: 0,
    zeroByteCloses: 0,
    firstByteLatenciesMs: [],
    totalBytes: 0,
  };

  await Promise.all([
    runCycle("main", mainSrv.port!, mainCounters),
    runCycle("sub", subSrv.port!, subCounters),
  ]);

  console.log("\n── Final ──");
  const report = (label: string, c: Counters) => {
    const avg =
      c.firstByteLatenciesMs.length > 0
        ? Math.round(
            c.firstByteLatenciesMs.reduce((a, b) => a + b, 0) /
              c.firstByteLatenciesMs.length,
          )
        : -1;
    const p95 =
      c.firstByteLatenciesMs.length > 0
        ? c.firstByteLatenciesMs.slice().sort((a, b) => a - b)[
            Math.floor(c.firstByteLatenciesMs.length * 0.95)
          ]
        : -1;
    console.log(
      `  ${label}: connects=${c.connects}  firstByteOk=${c.firstByteLatenciesMs.length}  zeroByteCloses=${c.zeroByteCloses}  ECONNRESET=${c.econnresets}  avgFirstByte=${avg}ms  p95FirstByte=${p95}ms  totalBytes=${c.totalBytes}`,
    );
  };
  report("main", mainCounters);
  report("sub", subCounters);

  console.log(
    `\nExpected HEALTHY: zeroByteCloses=0 on a wired cam with prestart=true.`,
  );

  await mainSrv.stop();
  await subSrv.stop();
  await api.close().catch(() => {});
  process.exit(0);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
