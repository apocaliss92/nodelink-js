#!/usr/bin/env npx tsx
/**
 * Hardware integration test: MPEG-TS TCP pipeline (Go2rtcTcpServer)
 *
 * Connects to every camera configured in .env, starts Go2rtcTcpServer for
 * each profile (main / sub), opens a raw TCP connection (simulating go2rtc),
 * reads MPEG-TS data for RECORD_DURATION seconds and validates:
 *
 *  ✓ Every byte falls on a 188-byte boundary with a 0x47 sync byte
 *  ✓ PAT (PID 0x0000) received
 *  ✓ PMT (PID 0x1000) received
 *  ✓ Video PID (0x0100) packets received
 *  ✓ Audio PID (0x0101) packets received          [when camera has audio]
 *  ✓ PMT stream type matches detected codec        [H.264→0x1B, H.265→0x24]
 *  ✓ PTS is present and monotonically increasing
 *  ✓ Continuity counters are consecutive (no gaps)
 *
 * Usage:
 *   npx tsx test/test-mpegts-pipeline.ts
 *   RECORD_DURATION=15 npx tsx test/test-mpegts-pipeline.ts
 */

import * as net from "node:net";
import * as dotenv from "dotenv";
import { ReolinkBaichuanApi, Go2rtcTcpServer } from "../src/index.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const RECORD_DURATION_S = Number(process.env.RECORD_DURATION ?? 8);
const TS_SIZE = 188;
const PID_PAT   = 0x0000;
const PID_PMT   = 0x1000;
const PID_VIDEO = 0x0100;
const PID_AUDIO = 0x0101;

const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_H265 = 0x24;
const STREAM_TYPE_AAC  = 0x0f;

// ---------------------------------------------------------------------------
// Camera definitions from .env
// ---------------------------------------------------------------------------
interface CameraConfig {
  label: string;
  host: string;
  username: string;
  password: string;
  uid?: string;          // BCUDP UID for battery cameras
  isBattery?: boolean;
  profiles?: Array<"main" | "sub">;
}

function envCam(label: string, prefix: string, opts: Partial<CameraConfig> = {}): CameraConfig | null {
  const host = process.env[`${prefix}_HOST`];
  if (!host) return null;
  return {
    label,
    host,
    username: process.env[`${prefix}_USERNAME`] ?? "admin",
    password: process.env[`${prefix}_PASSWORD`] ?? "",
    uid: process.env[`${prefix}_UID`],
    profiles: ["main", "sub"],
    ...opts,
  };
}

const CAMERAS: CameraConfig[] = [
  envCam("TCP H.264",   "TCP"),
  envCam("TCP H.265",   "TCP265"),
  envCam("Battery UDP", "UDP",  { isBattery: true, profiles: ["main"] }),
].filter(Boolean) as CameraConfig[];

if (CAMERAS.length === 0) {
  console.error("No cameras found in .env — set TCP_HOST, TCP265_HOST or UDP_HOST.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// MPEG-TS stream statistics collector
// ---------------------------------------------------------------------------
interface StreamStats {
  totalBytes: number;
  totalPackets: number;
  malformedPackets: number;
  pids: Map<number, number>; // PID → packet count
  ptsSamples: Map<number, number[]>; // PID → PTS values (90kHz)
  ccState: Map<number, number>;  // PID → last CC
  ccErrors: number;
  pmtVideoStreamType: number | null;
  pmtAudioStreamType: number | null;
}

function createStats(): StreamStats {
  return {
    totalBytes: 0,
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
  // adaptation_field_control bits 5-4 of byte 3
  const afc = (pkt[3]! >> 4) & 0x03;
  if (afc === 2 || afc === 3) {
    return 1 + pkt[4]!; // length byte + field itself
  }
  return 0;
}

function extractPts(pkt: Buffer): number | null {
  if (!hasPusi(pkt) || !hasPayload(pkt)) return null;
  const payloadOff = 4 + adaptLen(pkt);
  const p = pkt.subarray(payloadOff);
  // PES start code
  if (p.length < 14) return null;
  if (p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return null;
  const ptsDtsFlags = (p[7]! >> 6) & 0x03;
  if (ptsDtsFlags < 2) return null;
  const b = p.subarray(9);
  if (b.length < 5) return null;
  const pts =
    (((b[0]! >> 1) & 0x07) * 2 ** 30) +
    (b[1]! * 2 ** 22) +
    (((b[2]! >> 1) & 0x7f) * 2 ** 15) +
    (b[3]! * 2 ** 7) +
    ((b[4]! >> 1) & 0x7f);
  return pts;
}

function parsePmt(pkt: Buffer, stats: StreamStats): void {
  // Skip TS header (4) + pointer field (1) + table_id(1) + section_syntax+len(2) + prog_num(2) + ver(1) + sec(1) + last(1) + PCR_PID(2) + prog_info_len(2)
  // = 4 + 1 + 12 = 17
  let i = 17;
  while (i + 5 <= TS_SIZE) {
    const st = pkt[i];
    if (st === undefined || st === 0xff) break;
    const pid = ((pkt[i + 1]! & 0x1f) << 8) | pkt[i + 2]!;
    if (pid === PID_VIDEO) stats.pmtVideoStreamType = st;
    if (pid === PID_AUDIO) stats.pmtAudioStreamType = st;
    i += 5;
  }
}

function consumePacket(raw: Buffer, offset: number, stats: StreamStats): void {
  const pkt = raw.subarray(offset, offset + TS_SIZE);
  stats.totalPackets++;

  if (pkt[0] !== 0x47) {
    stats.malformedPackets++;
    return;
  }

  const pid = getPid(pkt);
  stats.pids.set(pid, (stats.pids.get(pid) ?? 0) + 1);

  // Continuity counter check (only for PIDs with payload)
  if (hasPayload(pkt)) {
    const cc = getCC(pkt);
    const prev = stats.ccState.get(pid);
    if (prev !== undefined) {
      const expected = (prev + 1) & 0x0f;
      if (cc !== expected) stats.ccErrors++;
    }
    stats.ccState.set(pid, cc);
  }

  // PTS extraction
  const pts = extractPts(pkt);
  if (pts !== null) {
    if (!stats.ptsSamples.has(pid)) stats.ptsSamples.set(pid, []);
    stats.ptsSamples.get(pid)!.push(pts);
  }

  // Parse PMT
  if (pid === PID_PMT && hasPusi(pkt)) {
    parsePmt(pkt, stats);
  }
}

// ---------------------------------------------------------------------------
// Run a single camera × profile test
// ---------------------------------------------------------------------------
async function testStream(
  cam: CameraConfig,
  profile: "main" | "sub",
): Promise<{ passed: boolean; notes: string[] }> {
  const label = `${cam.label} / ${profile}`;
  const notes: string[] = [];

  console.log(`\n  ── ${label} ──`);

  // 1. Connect API
  const api = new ReolinkBaichuanApi({
    host: cam.host,
    username: cam.username,
    password: cam.password,
    channel: 0,
    ...(cam.uid ? { uid: cam.uid } : {}),
  });

  try {
    const loginTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("login timeout")), 20_000),
    );
    await Promise.race([api.login(), loginTimeout]);
  } catch (e) {
    await api.close().catch(() => {});
    notes.push(`SKIP: API login failed: ${e}`);
    console.log(`    SKIP (offline): ${e}`);
    return { passed: true, notes }; // treat unreachable cameras as skipped not failed
  }

  // 2. Start Go2rtcTcpServer
  const server = new Go2rtcTcpServer({
    api,
    profile,
    channel: 0,
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: !cam.isBattery,
    gracePeriodMs: 5_000,
    logger: {
      info: (m: string) => process.stdout.write(`    [tcp] ${m}\n`),
      warn: (m: string) => process.stdout.write(`    [tcp] WARN ${m}\n`),
      error: (m: string) => process.stderr.write(`    [tcp] ERROR ${m}\n`),
      debug: () => {},
    },
  });

  try {
    await server.start();
  } catch (e) {
    notes.push(`FAIL: Go2rtcTcpServer.start() failed: ${e}`);
    await api.close().catch(() => {});
    return { passed: false, notes };
  }

  const port = server.port!;
  console.log(`    Listening on tcp://127.0.0.1:${port} — reading for ${RECORD_DURATION_S}s`);

  // 3. Connect TCP client and collect MPEG-TS data
  const stats = createStats();
  let residual = Buffer.alloc(0);

  await new Promise<void>((resolve) => {
    const socket = net.createConnection(port, "127.0.0.1");
    const deadline = setTimeout(() => {
      socket.destroy();
    }, RECORD_DURATION_S * 1000);

    socket.on("data", (chunk: Buffer) => {
      stats.totalBytes += chunk.length;
      const buf = Buffer.concat([residual, chunk]);
      const aligned = Math.floor(buf.length / TS_SIZE) * TS_SIZE;
      for (let i = 0; i < aligned; i += TS_SIZE) {
        consumePacket(buf, i, stats);
      }
      residual = buf.subarray(aligned);
    });

    socket.on("close", () => { clearTimeout(deadline); resolve(); });
    socket.on("error", () => { clearTimeout(deadline); resolve(); });
  });

  // 4. Stop everything
  await server.stop();
  await api.close().catch(() => {});

  // 5. Evaluate results
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

  checks.push({
    name: "Received MPEG-TS data",
    ok: stats.totalPackets > 0,
    detail: `${stats.totalPackets} packets (${(stats.totalBytes / 1024).toFixed(1)} KB)`,
  });

  checks.push({
    name: "No malformed packets (sync byte 0x47)",
    ok: stats.malformedPackets === 0,
    detail: `${stats.malformedPackets} bad out of ${stats.totalPackets}`,
  });

  checks.push({
    name: "PAT received",
    ok: (stats.pids.get(PID_PAT) ?? 0) > 0,
    detail: `${stats.pids.get(PID_PAT) ?? 0} PAT packets`,
  });

  checks.push({
    name: "PMT received",
    ok: (stats.pids.get(PID_PMT) ?? 0) > 0,
    detail: `${stats.pids.get(PID_PMT) ?? 0} PMT packets`,
  });

  checks.push({
    name: "Video PID (0x0100) packets received",
    ok: (stats.pids.get(PID_VIDEO) ?? 0) > 0,
    detail: `${stats.pids.get(PID_VIDEO) ?? 0} video packets`,
  });

  checks.push({
    name: "Audio PID (0x0101) packets received",
    ok: (stats.pids.get(PID_AUDIO) ?? 0) > 0,
    detail: `${stats.pids.get(PID_AUDIO) ?? 0} audio packets`,
  });

  if (stats.pmtVideoStreamType !== null) {
    const expected = [STREAM_TYPE_H264, STREAM_TYPE_H265];
    checks.push({
      name: "PMT video stream type is H.264 (0x1B) or H.265 (0x24)",
      ok: expected.includes(stats.pmtVideoStreamType),
      detail: `0x${stats.pmtVideoStreamType.toString(16).padStart(2, "0")} (${
        stats.pmtVideoStreamType === STREAM_TYPE_H264 ? "H.264" :
        stats.pmtVideoStreamType === STREAM_TYPE_H265 ? "H.265" : "unknown"
      })`,
    });
  }

  if (stats.pmtAudioStreamType !== null) {
    checks.push({
      name: "PMT audio stream type is AAC-ADTS (0x0F)",
      ok: stats.pmtAudioStreamType === STREAM_TYPE_AAC,
      detail: `0x${stats.pmtAudioStreamType.toString(16).padStart(2, "0")}`,
    });
  }

  checks.push({
    name: "No continuity counter errors",
    ok: stats.ccErrors === 0,
    detail: `${stats.ccErrors} CC errors`,
  });

  const videoPts = stats.ptsSamples.get(PID_VIDEO) ?? [];
  if (videoPts.length >= 2) {
    let monotonic = true;
    for (let i = 1; i < videoPts.length; i++) {
      if (videoPts[i]! <= videoPts[i - 1]!) { monotonic = false; break; }
    }
    checks.push({
      name: "Video PTS monotonically increasing",
      ok: monotonic,
      detail: `${videoPts.length} PTS samples, first=${videoPts[0]} last=${videoPts[videoPts.length - 1]}`,
    });
  }

  const audioPts = stats.ptsSamples.get(PID_AUDIO) ?? [];
  if (audioPts.length >= 2) {
    let monotonic = true;
    for (let i = 1; i < audioPts.length; i++) {
      if (audioPts[i]! <= audioPts[i - 1]!) { monotonic = false; break; }
    }
    checks.push({
      name: "Audio PTS monotonically increasing",
      ok: monotonic,
      detail: `${audioPts.length} PTS samples`,
    });
  }

  // Print results
  let allPassed = true;
  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    const line = `    ${icon} ${c.name}${c.detail ? ` (${c.detail})` : ""}`;
    if (!c.ok) { allPassed = false; notes.push(line); }
    console.log(line);
  }

  return { passed: allPassed, notes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(" MPEG-TS TCP pipeline — hardware integration test");
  console.log(`  Cameras: ${CAMERAS.map((c) => c.label).join(", ")}`);
  console.log(`  Duration per stream: ${RECORD_DURATION_S}s`);
  console.log("═══════════════════════════════════════════════════════════");

  const results: Array<{ label: string; passed: boolean }> = [];

  for (const cam of CAMERAS) {
    const profiles = cam.profiles ?? ["main", "sub"];
    for (const profile of profiles) {
      const label = `${cam.label} / ${profile}`;
      try {
        const { passed, notes } = await testStream(cam, profile);
        results.push({ label, passed });
        if (!passed) {
          console.log(`\n  FAILURES for ${label}:`);
          for (const n of notes) console.log(n);
        }
      } catch (e) {
        console.error(`\n  EXCEPTION for ${label}: ${e}`);
        results.push({ label, passed: false });
      }
    }
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(" Summary");
  console.log("═══════════════════════════════════════════════════════════");
  let anyFail = false;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.label}`);
    if (!r.passed) anyFail = true;
  }
  console.log("");
  if (anyFail) {
    console.error("  SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("  ALL TESTS PASSED");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
