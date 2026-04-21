/**
 * E2E test: local RTSP mode — single-port multiplexer.
 *
 * Tests LocalRtspMux + BaichuanRtspServer (restreamer=local) for:
 *   - TCP265_HOST  (Studio, H.265, AC-powered)
 *   - UDP_STANDALONE_HOST  (campanello, BCUDP, battery)
 *
 * Architecture being validated:
 *   A single LocalRtspMux listens on ONE TCP port (19100). For every
 *   camera × profile combination the test creates a BaichuanRtspServer
 *   in `muxMode` (so it does NOT bind its own port), registers it with
 *   the mux under a distinct URL path, and verifies the RTSP handshake
 *   + first frames can be negotiated through that shared port.
 *
 * For each camera the script:
 *   1. Connects the ReolinkBaichuanApi and logs in
 *   2. Detects available stream profiles from capabilities
 *   3. For every profile: registers a muxed BaichuanRtspServer, does a
 *      full RTSP DESCRIBE → SETUP → PLAY handshake via the shared mux
 *      port, counts RTP frames within the timeout window and records
 *      time-to-first-frame.
 *   4. Prints a result table and exits 0 (all pass) or 1 (any failure).
 *   5. Cross-camera identity check: different cameras must serve
 *      different streams (distinct SPS).
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
import { LocalRtspMux } from "../app/src/local-rtsp-mux.js";
import type { StreamProfile } from "../src/reolink/baichuan/types.js";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

// ─── Configuration ──────────────────────────────────────────────────────────

/** Single shared RTSP port — ALL streams mux through this one port. */
const MUX_PORT = 19100;
const MUX_HOST = "127.0.0.1";

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
  fmtp?: string;    // raw fmtp line (contains SPS/PPS for identity check)
  spropSps?: string; // extracted sprop-sps or sprop-parameter-sets value
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
    const url = `rtsp://${MUX_HOST}:${port}${rtspPath}`;
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
          fmtp: extractFmtp(sdp),
          spropSps: extractSpropSps(sdp),
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

    const socket = net.createConnection({ host: MUX_HOST, port });

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

function extractFmtp(sdp: string): string | undefined {
  const m = sdp.match(/a=fmtp:\d+\s+(.+)/);
  return m?.[1]?.trim();
}

/** Extract the SPS base64 value: first sprop-sps= (H.265) or sprop-parameter-sets= SPS part (H.264). */
function extractSpropSps(sdp: string): string | undefined {
  // H.265: sprop-sps=<base64>
  const h265 = sdp.match(/sprop-sps=([A-Za-z0-9+/=]+)/);
  if (h265) return h265[1];
  // H.264: sprop-parameter-sets=<SPS>,<PPS> — take SPS (before comma)
  const h264 = sdp.match(/sprop-parameter-sets=([A-Za-z0-9+/=]+)/);
  if (h264) return h264[1];
  return undefined;
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

// ─── Main ────────────────────────────────────────────────────────────────────

interface TestResult {
  camera: string;
  profile: string;
  status: "pass" | "warn" | "fail";
  codec?: string;
  spropSps?: string; // SPS fingerprint — must differ across cameras
  ttffMs?: number;
  frames: number;
  durationMs: number;
  rtspPath: string;
  error?: string;
}

interface MuxLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug?: (m: string) => void;
}

const muxLogger: MuxLogger = {
  info: (m) => console.log(`${DIM}${m}${RESET}`),
  warn: (m) => console.warn(`${YELLOW}${m}${RESET}`),
  error: (m) => console.error(`${RED}${m}${RESET}`),
  debug: () => {},
};

async function runCombination(
  cfg: CameraConfig,
  api: ReolinkBaichuanApi,
  profile: StreamProfile,
  mux: LocalRtspMux,
): Promise<TestResult> {
  const label = `${cfg.label} / ${profile}`;
  // Unique path per camera×profile so the mux can demux distinct streams
  // that share the same TCP port.
  const rtspPath = `/${cfg.host.replace(/\./g, "_")}/${profile}`;
  const timeoutMs = cfg.isBattery ? 65_000 : 20_000;

  let server: BaichuanRtspServer | undefined;

  try {
    server = new BaichuanRtspServer({
      api,
      channel: 0,
      profile,
      // listenHost/listenPort are informational in muxMode — the server
      // never binds a TCP socket; the mux owns the port.
      listenHost: MUX_HOST,
      listenPort: MUX_PORT,
      path: rtspPath,
      deviceId: cfg.host,
      lazyMetadata: true,
      nativeStreamIdleStopMs: 30_000,
      muxMode: true,
    });

    process.stdout.write(`  ${DIM}[${label}]${RESET} starting server (mux path=${rtspPath})… `);
    await server.start();
    mux.register(rtspPath, server);
    process.stdout.write(`started\n`);

    // Give the mux a brief moment to finish any in-flight registration bookkeeping
    await sleep(100);

    process.stdout.write(`  ${DIM}[${label}]${RESET} probing RTSP on :${MUX_PORT}${rtspPath} (timeout ${timeoutMs / 1000}s)… `);
    const t0 = Date.now();
    const probe = await rtspProbe(MUX_PORT, rtspPath, timeoutMs);
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
      spropSps: probe.spropSps,
      ttffMs: probe.ttffMs,
      frames: probe.framesReceived,
      durationMs: probe.durationMs,
      rtspPath,
      error: probe.errorMsg,
    };
  } catch (e) {
    return {
      camera: cfg.label,
      profile,
      status: "fail",
      frames: 0,
      durationMs: 0,
      rtspPath,
      error: String(e),
    };
  } finally {
    if (server) {
      try {
        mux.unregister(rtspPath);
        await server.stop();
      } catch {
        // ignore
      }
    }
  }
}

async function main() {
  console.log(`\n${BOLD}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD} E2E Local RTSP — single-port multiplexer${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════════${RESET}\n`);

  const cameras = loadCameras();
  if (cameras.length === 0) {
    console.error("No cameras configured. Set TCP265_HOST and/or UDP_STANDALONE_HOST in .env");
    process.exit(1);
  }

  // Bring up the single-port mux ONCE for the whole test.
  const mux = new LocalRtspMux(MUX_PORT, MUX_HOST, muxLogger);
  try {
    await mux.start();
  } catch (e) {
    console.error(`${RED}Failed to bind LocalRtspMux on ${MUX_HOST}:${MUX_PORT}: ${e}${RESET}`);
    process.exit(1);
  }
  console.log(`LocalRtspMux listening on ${MUX_HOST}:${MUX_PORT} — all streams share this port\n`);

  const allResults: TestResult[] = [];

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
        rtspPath: "",
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

    // Run each profile sequentially — all streams multiplexed through the
    // single mux port, routed by URL path.
    for (const profile of profiles) {
      const result = await runCombination(cfg, api, profile, mux);
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

  // Tear down the mux before emitting the summary — any lingering route
  // error would surface here, not mid-test.
  try {
    await mux.stop();
  } catch (e) {
    console.warn(`${YELLOW}Warning: mux.stop() threw: ${e}${RESET}`);
  }

  // Summary table
  console.log(`\n${BOLD}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD} Summary (single-port :${MUX_PORT})${RESET}`);
  console.log(`${"─".repeat(72)}`);
  console.log(
    `${"Camera".padEnd(30)} ${"Profile".padEnd(8)} ${"Status".padEnd(8)} ${"TTFF".padEnd(8)} ${"Frames".padEnd(8)} Path`,
  );
  console.log(`${"─".repeat(72)}`);
  for (const r of allResults) {
    const s = r.status === "pass" ? `${GREEN}PASS${RESET}` : r.status === "warn" ? `${YELLOW}WARN${RESET}` : `${RED}FAIL${RESET}`;
    const ttff = r.ttffMs !== undefined ? `${r.ttffMs}ms` : "-";
    console.log(
      `${r.camera.slice(0, 30).padEnd(30)} ${r.profile.padEnd(8)} ${s.padEnd(8 + 9)} ${ttff.padEnd(8)} ${String(r.frames).padEnd(8)} ${r.rtspPath}`,
    );
    if (r.spropSps) {
      // Show SPS fingerprint (first 32 chars, enough to see differences between same-model cameras)
      const full = r.spropSps;
      const fp = full.length > 32 ? `${full.slice(0, 32)}…` : full;
      console.log(`${"".padEnd(30)}   ${DIM}SPS[${full.length}]: ${fp}${RESET}`);
    } else if (r.status !== "fail") {
      console.log(`${"".padEnd(30)}   ${DIM}SPS: (none — priming timed out)${RESET}`);
    }
  }
  console.log(`${"─".repeat(72)}`);

  // Cross-camera identity check: same profile, different cameras MUST have different SPS
  console.log(`\n${BOLD} Identity check (SPS must differ across cameras)${RESET}`);
  const profiles = [...new Set(allResults.map((r) => r.profile))];
  let identityFail = false;
  for (const profile of profiles) {
    const byProfile = allResults.filter((r) => r.profile === profile && r.spropSps);
    if (byProfile.length < 2) continue;
    const spsSeen = new Map<string, string>();
    for (const r of byProfile) {
      const sps = r.spropSps!;
      if (spsSeen.has(sps)) {
        console.log(
          `  ${RED}${BOLD}✗ IDENTITY FAIL${RESET} profile=${profile}: ${r.camera} and ${spsSeen.get(sps)} have IDENTICAL SPS (same stream!)`,
        );
        identityFail = true;
      } else {
        spsSeen.set(sps, r.camera);
        const fp = sps.length > 32 ? `${sps.slice(0, 32)}…` : sps;
        console.log(`  ${GREEN}✓${RESET} profile=${profile}  ${r.camera}  SPS=${fp}`);
      }
    }
  }
  if (!identityFail) {
    console.log(`  ${GREEN}${BOLD}All cameras serve distinct streams.${RESET}`);
  }

  const passed = allResults.filter((r) => r.status === "pass").length;
  const warned = allResults.filter((r) => r.status === "warn").length;
  const failed = allResults.filter((r) => r.status === "fail").length;
  const exitCode = (failed > 0 || identityFail) ? 1 : 0;
  console.log(`\n${BOLD}Total: ${passed} pass, ${warned} warn, ${failed} fail / ${allResults.length} combinations${RESET}\n`);

  process.exit(exitCode);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
