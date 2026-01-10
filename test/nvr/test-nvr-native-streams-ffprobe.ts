#!/usr/bin/env node
/**
 * NVR test: start native streams (wide + tele) and probe video params with ffprobe.
 *
 * Goal
 * - Start 4 native streams on the same NVR channel:
 *   - wide main (variant=default)
 *   - wide sub  (variant=default)
 *   - tele main (variant=telephoto)
 *   - tele sub  (variant=telephoto)
 * - For each stream:
 *   - Start a local RTSP server (BaichuanRtspServer)
 *   - Run ffprobe to read codec/width/height/fps/pix_fmt/profile
 *
 * Env (.env via test/env.ts)
 * - NVR_HOST, NVR_USERNAME, NVR_PASSWORD (required)
 * - NVR_CHANNEL (optional, default: 2)
 * - BAICHUAN_MAX_ENC (optional: none|bc|aes|full_aes)
 * - NVR_FFPROBE_TIMEOUT_MS (optional, default: 15000)
 * - NVR_LOCAL_RTSP_BASE_PORT (optional, default: 9854)
 */

import { spawn } from "node:child_process";

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { BaichuanRtspServer, ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

type NativeVariant = "default" | "telephoto";
type Profile = "main" | "sub";

interface StreamSpec {
  label: string;
  profile: Profile;
  variant: NativeVariant;
}

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

function envInt(key: string, def: number): number {
  const raw = (process.env[key] ?? "").trim();
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

async function runFfprobe(rtspUrl: string, timeoutMs: number): Promise<any> {
  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-rtsp_transport",
    "tcp",
    "-analyzeduration",
    "2000000",
    "-probesize",
    "2000000",
    "-rw_timeout",
    String(Math.max(1000000, timeoutMs * 1000)),
    "-i",
    rtspUrl,
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,codec_long_name,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,bit_rate,codec_tag_string",
    "-of",
    "json",
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.once("error", (e) => {
      clearTimeout(killTimer);
      reject(e);
    });

    child.once("close", (code) => {
      clearTimeout(killTimer);
      const parsed = safeJsonParse(stdout);
      if (code === 0 && parsed) return resolve(parsed);
      const hint = stdout.trim() || stderr.trim() || `ffprobe exited with code ${code}`;
      reject(new Error(hint));
    });
  });
}

function pickVideoStreamInfo(ffprobeJson: any): {
  codec?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
} {
  const stream = Array.isArray(ffprobeJson?.streams) ? ffprobeJson.streams[0] : undefined;
  if (!stream || typeof stream !== "object") return {};
  return {
    codec: typeof stream.codec_name === "string" ? stream.codec_name : undefined,
    profile: typeof stream.profile === "string" ? stream.profile : undefined,
    width: typeof stream.width === "number" ? stream.width : undefined,
    height: typeof stream.height === "number" ? stream.height : undefined,
    pix_fmt: typeof stream.pix_fmt === "string" ? stream.pix_fmt : undefined,
    r_frame_rate: typeof stream.r_frame_rate === "string" ? stream.r_frame_rate : undefined,
    avg_frame_rate: typeof stream.avg_frame_rate === "string" ? stream.avg_frame_rate : undefined,
    bit_rate: typeof stream.bit_rate === "string" ? stream.bit_rate : undefined,
  };
}

async function probeOne(params: {
  api: ReolinkBaichuanApi;
  channel: number;
  spec: StreamSpec;
  port: number;
  timeoutMs: number;
}): Promise<{ spec: StreamSpec; rtspUrl: string; info: ReturnType<typeof pickVideoStreamInfo> }> {
  const { api, channel, spec, port, timeoutMs } = params;
  const path = `/probe/${spec.variant}/${spec.profile}`;

  const rtspServer = new BaichuanRtspServer({
    api,
    channel,
    profile: spec.profile,
    ...(spec.variant !== "default" ? { variant: spec.variant } : {}),
    listenHost: "127.0.0.1",
    listenPort: port,
    path,
    logger: console,
  });

  await rtspServer.start();

  try {
    await rtspServer.waitUntilReady(8000).catch(() => undefined);
    const rtspUrl = rtspServer.getRtspUrl();
    const probed = await runFfprobe(rtspUrl, timeoutMs);
    const info = pickVideoStreamInfo(probed);
    return { spec, rtspUrl, info };
  } finally {
    await rtspServer.stop().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!config.nvr.host) die("Missing NVR_HOST in .env");
  if (!config.nvr.password) die("Missing NVR_PASSWORD in .env");

  const channel = envInt("NVR_CHANNEL", 2);
  const timeoutMs = envInt("NVR_FFPROBE_TIMEOUT_MS", 15000);
  const basePort = envInt("NVR_LOCAL_RTSP_BASE_PORT", 9854);
  const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;

  const specs: StreamSpec[] = [
    { label: "wide_main", profile: "main", variant: "default" },
    { label: "wide_sub", profile: "sub", variant: "default" },
    { label: "tele_main", profile: "main", variant: "telephoto" },
    { label: "tele_sub", profile: "sub", variant: "telephoto" },
  ];

  console.log("\n================================================================================");
  console.log("TEST: NVR native streams (wide+tele) ffprobe");
  console.log("================================================================================");
  console.log(`Host: ${config.nvr.host}`);
  console.log(`Channel: ${channel}`);
  console.log(`BasePort: ${basePort}`);
  console.log(`ffprobe timeout: ${timeoutMs}ms`);

  const api = new ReolinkBaichuanApi({
    host: config.nvr.host,
    username: config.nvr.username,
    password: config.nvr.password,
    transport: "tcp",
    debug: false,
    logger: console,
  });

  // Prevent unhandled 'error' events on the underlying socket from crashing the test.
  // We still log them so we can correlate with NVR behavior.
  api.client.on("error", (e: Error) => {
    console.warn(`[BaichuanClient] error: ${e?.message ?? String(e)}`);
  });

  try {
    console.log("\nLogging in...");
    await api.login(maxEnc ?? "aes");
    console.log("Login OK");

    const results: Array<{ spec: StreamSpec; rtspUrl: string; info: ReturnType<typeof pickVideoStreamInfo> }> = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const port = basePort + i;
      console.log(`\n--- Probing ${spec.label} (profile=${spec.profile} variant=${spec.variant}) ---`);

      try {
        const r = await probeOne({ api, channel, spec, port, timeoutMs });
        results.push(r);
        const { codec, profile, width, height, pix_fmt, avg_frame_rate } = r.info;
        console.log(`RTSP: ${r.rtspUrl}`);
        console.log(
          `ffprobe: codec=${codec ?? "?"} profile=${profile ?? "?"} size=${width ?? "?"}x${height ?? "?"} fps=${avg_frame_rate ?? "?"} pix_fmt=${pix_fmt ?? "?"}`
        );
      } catch (e) {
        console.log(`RTSP: rtsp://127.0.0.1:${port}/probe/${spec.variant}/${spec.profile}`);
        console.error(`[ffprobe] failed for ${spec.label}:`, e instanceof Error ? e.message : String(e));
      }
    }

    console.log("\n=== Summary ===");
    for (const r of results) {
      const { width, height, codec } = r.info;
      console.log(`${r.spec.label}: ${codec ?? "?"} ${width ?? "?"}x${height ?? "?"}`);
    }

    const wideMain = results.find((r) => r.spec.label === "wide_main")?.info;
    const teleMain = results.find((r) => r.spec.label === "tele_main")?.info;
    if (wideMain?.width && wideMain?.height && teleMain?.width && teleMain?.height) {
      const same = wideMain.width === teleMain.width && wideMain.height === teleMain.height;
      console.log("\n=== Wide vs Tele (main) ===");
      console.log(`wide_main: ${wideMain.width}x${wideMain.height}`);
      console.log(`tele_main: ${teleMain.width}x${teleMain.height}`);
      console.log(`match: ${same ? "YES (suspicious aliasing)" : "NO (streams differ)"}`);
    }

    const wideSub = results.find((r) => r.spec.label === "wide_sub")?.info;
    const teleSub = results.find((r) => r.spec.label === "tele_sub")?.info;
    if (wideSub?.width && wideSub?.height && teleSub?.width && teleSub?.height) {
      const same = wideSub.width === teleSub.width && wideSub.height === teleSub.height;
      console.log("\n=== Wide vs Tele (sub) ===");
      console.log(`wide_sub: ${wideSub.width}x${wideSub.height}`);
      console.log(`tele_sub: ${teleSub.width}x${teleSub.height}`);
      console.log(`match: ${same ? "YES (suspicious aliasing)" : "NO (streams differ)"}`);
    }
  } finally {
    await api.close().catch(() => undefined);
    // Ensure the process does not hang due to any lingering timers/intervals.
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
