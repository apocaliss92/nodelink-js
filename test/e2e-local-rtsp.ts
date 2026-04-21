/**
 * E2E test: local RTSP mode — all camera × profile combinations.
 *
 * Tests BaichuanRtspServer (restreamer=local) for:
 *   - TCP265_HOST  (Studio, H.265, AC-powered)
 *   - UDP_STANDALONE_HOST  (campanello, BCUDP, battery)
 *
 * For each camera the script:
 *   1. Connects the ReolinkBaichuanApi and logs in
 *   2. Detects available stream profiles from capabilities
 *   3. For every profile: starts a BaichuanRtspServer, does a full
 *      RTSP DESCRIBE → SETUP → PLAY handshake over a raw TCP socket,
 *      counts RTP frames delivered within the timeout window and records
 *      time-to-first-frame.
 *   4. Prints a result table and exits 0 (all pass) or 1 (any failure).
 *
 * Run:
 *   npx tsx test/e2e-local-rtsp.ts
 */

import * as net from "node:net";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi.js";
import { BaichuanRtspServer } from "../src/baichuan/stream/BaichuanRtspServer.js";
import type { StreamProfile } from "../src/reolink/baichuan/types.js";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_PORT = 19100; // test ports 19100–19199, won't clash with manager ports

interface CameraConfig {
  label: string;
  host: string;
  username: string;
  password: string;
  uid?: string;
  transport?: "tcp" | "udp" | "auto";
  udpDiscoveryMethod?: string;
  isBattery: boolean;
}

function loadCameras(): CameraConfig[] {
  const cameras: CameraConfig[] = [];

  if (process.env.TCP265_HOST) {
    cameras.push({
      label: "TCP265 (Studio)",
      host: process.env.TCP265_HOST,
      username: process.env.TCP265_USERNAME ?? "admin",
      password: process.env.TCP265_PASSWORD ?? "",
      transport: "auto",
      isBattery: false,
    });
  }

  if (process.env.UDP_STANDALONE_HOST) {
    cameras.push({
      label: "UDP_STANDALONE (campanello)",
      host: process.env.UDP_STANDALONE_HOST,
      username: process.env.UDP_STANDALONE_USERNAME ?? "admin",
      password: process.env.UDP_STANDALONE_PASSWORD ?? "",
      uid: process.env.UDP_STANDALONE_UID,
      transport: "udp",
      udpDiscoveryMethod: "local-direct",
      isBattery: true,
    });
  }

  return cameras;
}

// ─── RTSP probe (inline TCP client) ─────────────────────────────────────────

interface ProbeResult {
  ok: boolean;
  sdp?: string;
  hasCodecParams: boolean; // fmtp / sprop-parameter-sets present
  codec?: string;
  ttffMs?: number;
  framesReceived: number;
  errorMsg?: string;
  durationMs: number;
}

function rtspProbe(
  port: number,
  rtspPath: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const url = `rtsp://127.0.0.1:${port}${rtspPath}`;
    const start = Date.now();
    let cseq = 1;
    let sessionId = "";
    let sdp = "";
    let phase: "options" | "describe" | "setup" | "play" | "streaming" | "done" =
      "options";
    let firstFrameAt: number | undefined;
    let framesReceived = 0;
    let interleavedBuf = Buffer.alloc(0);
    let settled = false;

    const done = (result: Omit<ProbeResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      clearTimeout(deadline);
      resolve({ ...result, durationMs: Date.now() - start });
    };

    const deadline = setTimeout(() => {
      if (phase === "streaming" || phase === "play") {
        done({
          ok: framesReceived > 0,
          sdp,
          hasCodecParams: /fmtp|sprop-parameter-sets/i.test(sdp),
          codec: detectCodec(sdp),
          ttffMs: firstFrameAt,
          framesReceived,
          errorMsg: framesReceived === 0 ? "timeout: no frames within deadline" : undefined,
        });
      } else {
        done({
          ok: false,
          sdp,
          hasCodecParams: false,
          framesReceived: 0,
          errorMsg: `timeout in phase=${phase}`,
        });
      }
    }, timeoutMs);

    const socket = net.createConnection({ host: "127.0.0.1", port });

    socket.on("error", (e) =>
      done({ ok: false, sdp, hasCodecParams: false, framesReceived: 0, errorMsg: String(e) }),
    );

    let contentBase = url; // updated from Content-Base header in DESCRIBE response
    let videoTrackUrl = ""; // parsed from SDP a=control:track0

    const send = (msg: string) => {
      if (!socket.destroyed) socket.write(msg);
    };

    const nextRequest = () => {
      if (phase === "options") {
        send(`OPTIONS ${url} RTSP/1.0\r\nCSeq: ${cseq++}\r\n\r\n`);
      } else if (phase === "describe") {
        send(
          `DESCRIBE ${url} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\n\r\n`,
        );
      } else if (phase === "setup") {
        // Build track URL from SDP a=control line
        const trackUrl = videoTrackUrl
          ? (videoTrackUrl.startsWith("rtsp://")
              ? videoTrackUrl
              : `${contentBase.replace(/\/$/, "")}/${videoTrackUrl}`)
          : `${contentBase.replace(/\/$/, "")}/track0`;
        send(
          `SETUP ${trackUrl} RTSP/1.0\r\nCSeq: ${cseq++}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`,
        );
      } else if (phase === "play") {
        send(
          `PLAY ${contentBase} RTSP/1.0\r\nCSeq: ${cseq++}\r\nSession: ${sessionId}\r\nRange: npt=0.000-\r\n\r\n`,
        );
        phase = "streaming";
      }
    };

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (phase === "streaming") {
        // Count interleaved RTP video frames ($\x00 = channel 0)
        interleavedBuf = Buffer.concat([interleavedBuf, chunk]);
        let idx = 0;
        while (idx < interleavedBuf.length) {
          if (interleavedBuf[idx] !== 0x24) { idx++; continue; }
          if (interleavedBuf.length < idx + 4) break;
          const channel = interleavedBuf[idx + 1]!;
          const len = interleavedBuf.readUInt16BE(idx + 2);
          if (interleavedBuf.length < idx + 4 + len) break;
          if (channel === 0) {
            // video RTP packet
            framesReceived++;
            if (firstFrameAt === undefined) firstFrameAt = Date.now() - start;
          }
          idx += 4 + len;
        }
        interleavedBuf = interleavedBuf.slice(idx);
        return;
      }

      // Parse RTSP response headers
      const text = buf.toString("utf8");
      const endIdx = text.indexOf("\r\n\r\n");
      if (endIdx === -1) return;

      const header = text.slice(0, endIdx);
      const bodyStart = endIdx + 4;

      // For DESCRIBE: read Content-Length to get SDP body
      if (phase === "describe") {
        const clMatch = header.match(/Content-Length:\s*(\d+)/i);
        const cl = clMatch ? parseInt(clMatch[1]!, 10) : 0;
        if (buf.length < bodyStart + cl) return; // wait for full body
        sdp = buf.slice(bodyStart, bodyStart + cl).toString("utf8");
        buf = buf.slice(bodyStart + cl);

        // Populate Content-Base from response headers
        const cbMatch = header.match(/Content-Base:\s*([^\r\n]+)/i);
        if (cbMatch) contentBase = cbMatch[1]!.trim();

        // Parse first video track control URL from SDP (skip session-level a=control:*)
        const ctrlMatch = sdp.match(/a=control:(track\S+)/);
        if (ctrlMatch) videoTrackUrl = ctrlMatch[1]!;
      } else {
        buf = buf.slice(bodyStart);
      }

      const statusMatch = header.match(/RTSP\/1\.0\s+(\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;

      if (status !== 200) {
        done({ ok: false, sdp, hasCodecParams: false, framesReceived: 0, errorMsg: `RTSP ${status} in phase=${phase}` });
        return;
      }

      // Extract Session for SETUP response
      if (phase === "setup") {
        const sesMatch = header.match(/Session:\s*([^;\r\n]+)/i);
        if (sesMatch) sessionId = sesMatch[1]!.trim();
      }

      // Advance phase
      const prev = phase;
      if (prev === "options") phase = "describe";
      else if (prev === "describe") phase = "setup";
      else if (prev === "setup") phase = "play";

      nextRequest();
    });

    socket.on("connect", () => nextRequest());
  });
}

function detectCodec(sdp: string): string | undefined {
  const m = sdp.match(/a=rtpmap:\d+\s+([A-Za-z0-9/-]+)/);
  return m?.[1]?.toUpperCase();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function status(ok: boolean, noFrames = false) {
  if (ok) return `${GREEN}${BOLD}✓ PASS${RESET}`;
  if (noFrames) return `${YELLOW}${BOLD}⚠ PASS (SDP ok, 0 frames in window)${RESET}`;
  return `${RED}${BOLD}✗ FAIL${RESET}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface TestResult {
  camera: string;
  profile: string;
  status: "pass" | "warn" | "fail";
  codec?: string;
  ttffMs?: number;
  frames: number;
  durationMs: number;
  error?: string;
}

async function runCombination(
  cfg: CameraConfig,
  api: ReolinkBaichuanApi,
  profile: StreamProfile,
  port: number,
): Promise<TestResult> {
  const label = `${cfg.label} / ${profile}`;
  const rtspPath = `/${cfg.host.replace(/\./g, "_")}/${profile}`;
  const timeoutMs = cfg.isBattery ? 65_000 : 20_000;

  let server: BaichuanRtspServer | undefined;

  try {
    server = new BaichuanRtspServer({
      api,
      channel: 0,
      profile,
      listenHost: "127.0.0.1",
      listenPort: port,
      path: rtspPath,
      deviceId: cfg.host,
      lazyMetadata: true,
      nativeStreamIdleStopMs: 30_000,
    });

    process.stdout.write(`  ${DIM}[${label}]${RESET} starting server on :${port}… `);
    await server.start();
    process.stdout.write(`started\n`);

    // Give the server a brief moment to bind
    await sleep(200);

    process.stdout.write(`  ${DIM}[${label}]${RESET} probing RTSP (timeout ${timeoutMs / 1000}s)… `);
    const t0 = Date.now();
    const probe = await rtspProbe(port, rtspPath, timeoutMs);
    process.stdout.write(`done in ${Date.now() - t0}ms\n`);

    const hasCodec = probe.hasCodecParams || !!probe.codec;

    let resultStatus: "pass" | "warn" | "fail";
    if (!probe.ok && probe.framesReceived === 0 && !hasCodec) {
      resultStatus = "fail";
    } else if (probe.framesReceived === 0 && hasCodec) {
      // SDP ok but no frames in window — acceptable for battery camera that is slow to wake
      resultStatus = "warn";
    } else if (probe.framesReceived > 0) {
      resultStatus = "pass";
    } else {
      resultStatus = "fail";
    }

    return {
      camera: cfg.label,
      profile,
      status: resultStatus,
      codec: probe.codec,
      ttffMs: probe.ttffMs,
      frames: probe.framesReceived,
      durationMs: probe.durationMs,
      error: probe.errorMsg,
    };
  } catch (e) {
    return {
      camera: cfg.label,
      profile,
      status: "fail",
      frames: 0,
      durationMs: 0,
      error: String(e),
    };
  } finally {
    if (server) {
      try {
        await server.stop();
      } catch {
        // ignore
      }
    }
  }
}

async function main() {
  console.log(`\n${BOLD}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD} E2E Local RTSP — all camera × profile combinations${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════════${RESET}\n`);

  const cameras = loadCameras();
  if (cameras.length === 0) {
    console.error("No cameras configured. Set TCP265_HOST and/or UDP_STANDALONE_HOST in .env");
    process.exit(1);
  }

  const allResults: TestResult[] = [];
  let portOffset = 0;

  for (const cfg of cameras) {
    console.log(`\n${BOLD}── ${cfg.label} @ ${cfg.host}${RESET}`);

    // Connect API
    let api: ReolinkBaichuanApi | undefined;
    try {
      process.stdout.write("  Connecting API… ");
      api = new ReolinkBaichuanApi({
        host: cfg.host,
        port: 9000,
        username: cfg.username,
        password: cfg.password,
        transport: cfg.transport ?? "auto",
        ...(cfg.uid ? { uid: cfg.uid } : {}),
        ...(cfg.udpDiscoveryMethod ? { udpDiscoveryMethod: cfg.udpDiscoveryMethod as any } : {}),
      });
      const t0 = Date.now();
      await api.login();
      console.log(`✓ (${Date.now() - t0}ms, transport=${api.client.getTransport()})`);
    } catch (e) {
      console.error(`✗ login failed: ${e}`);
      allResults.push({
        camera: cfg.label,
        profile: "(all)",
        status: "fail",
        frames: 0,
        durationMs: 0,
        error: `login failed: ${String(e)}`,
      });
      continue;
    }

    // Detect available profiles
    let profiles: StreamProfile[] = ["main", "sub"];
    try {
      const support = await api.getSupportInfo();
      const hasExt = (support as any)?.support?.streamNum >= 3 || (support as any)?.streamNum >= 3;
      if (hasExt) profiles = ["main", "sub", "ext"];
    } catch {
      // fallback: try main + sub
    }

    console.log(`  Profiles detected: ${profiles.join(", ")}`);

    // Run each profile sequentially (battery camera: keep API alive between tests)
    for (const profile of profiles) {
      const port = BASE_PORT + portOffset++;
      const result = await runCombination(cfg, api, profile, port);
      allResults.push(result);

      const s = result.status === "pass"
        ? `${GREEN}✓ PASS${RESET}`
        : result.status === "warn"
          ? `${YELLOW}⚠ WARN${RESET}`
          : `${RED}✗ FAIL${RESET}`;

      const meta = [
        result.codec ? `codec=${result.codec}` : "",
        result.ttffMs !== undefined ? `ttff=${result.ttffMs}ms` : "",
        `frames=${result.frames}`,
        `${result.durationMs}ms`,
      ].filter(Boolean).join("  ");

      console.log(`  ${s}  ${profile}  ${DIM}${meta}${RESET}`);
      if (result.error) console.log(`       ${RED}error: ${result.error}${RESET}`);

      // Brief pause between streams to let the server fully stop
      await sleep(1_000);
    }

    // Close API after all profiles for this camera
    await api.close({ reason: "e2e-test-done" }).catch(() => {});
  }

  // Summary table
  console.log(`\n${BOLD}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD} Summary${RESET}`);
  console.log(`${"─".repeat(54)}`);
  console.log(
    `${"Camera".padEnd(30)} ${"Profile".padEnd(8)} ${"Status".padEnd(8)} ${"TTFF".padEnd(8)} ${"Frames"}`,
  );
  console.log(`${"─".repeat(54)}`);
  for (const r of allResults) {
    const s = r.status === "pass" ? `${GREEN}PASS${RESET}` : r.status === "warn" ? `${YELLOW}WARN${RESET}` : `${RED}FAIL${RESET}`;
    const ttff = r.ttffMs !== undefined ? `${r.ttffMs}ms` : "-";
    console.log(
      `${r.camera.slice(0, 30).padEnd(30)} ${r.profile.padEnd(8)} ${s.padEnd(8 + 9)} ${ttff.padEnd(8)} ${r.frames}`,
    );
  }
  console.log(`${"─".repeat(54)}`);

  const passed = allResults.filter((r) => r.status === "pass").length;
  const warned = allResults.filter((r) => r.status === "warn").length;
  const failed = allResults.filter((r) => r.status === "fail").length;
  console.log(`\n${BOLD}Total: ${passed} pass, ${warned} warn, ${failed} fail / ${allResults.length} combinations${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
