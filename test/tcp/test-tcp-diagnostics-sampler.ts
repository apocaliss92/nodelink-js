#!/usr/bin/env node
/**
 * Diagnostics Sampler (TCP)
 *
 * Collects CGI + native "crucial points" and performs stream sampling:
 * - Native (Baichuan): saves Annex-B clip + keyframe snapshots + raw cmd_id=3 payload dumps + events.ndjson
 * - RTSP: ffmpeg copy-record to MP4 + periodic JPEG snapshots
 * - RTMP: optional (requires explicit RTMP URLs)
 *
 * Required env (.env is loaded by test/env.ts):
 * - TCP_HOST / TCP_USERNAME / TCP_PASSWORD
 *
 * Optional env:
 * - BAICHUAN_DIAG_DIR: output base dir (default: test/diagnostics)
 * - BAICHUAN_DIAG_SECONDS: duration per stream/profile (default: 5)
 * - BAICHUAN_DIAG_CHANNEL: channel (default: 0)
 * - BAICHUAN_DIAG_STREAMS: comma list: native,rtsp,rtmp (default: native,rtsp)
 * - BAICHUAN_DIAG_PROFILES: comma list: main,sub,ext (default: all)
 * - BAICHUAN_DIAG_SNAPSHOT_INTERVAL: seconds (default: 2)
 * - BAICHUAN_DIAG_MAX_RAW_FRAMES: max native raw frames per profile (default: 400)
 * - BAICHUAN_DIAG_MAX_RAW_BYTES: max native raw bytes per profile (default: 52428800)
 * - BAICHUAN_RTMP_URL_MAIN / _SUB / _EXT: optional RTMP URLs to sample
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, ReolinkCgiApi, createDiagnosticsBundle, sampleStreams } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";

function nowIsoCompact(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function envNum(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function envCsv(name: string, def: string): string[] {
  const raw = (process.env[name] ?? def).trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function run(): Promise<void> {
  if (!config.tcp.host || !config.tcp.password) {
    throw new Error("Missing TCP configuration in .env (TCP_HOST/TCP_PASSWORD).");
  }

  const durationSeconds = envNum("BAICHUAN_DIAG_SECONDS", 5);
  const channel = envNum("BAICHUAN_DIAG_CHANNEL", 0);
  const snapshotIntervalSeconds = envNum("BAICHUAN_DIAG_SNAPSHOT_INTERVAL", 2);

  const baseDir = (process.env.BAICHUAN_DIAG_DIR && process.env.BAICHUAN_DIAG_DIR.trim()) || path.join(process.cwd(), "test", "diagnostics");
  const outDir = path.join(baseDir, `diag_${config.tcp.host}_${nowIsoCompact()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const kinds = envCsv("BAICHUAN_DIAG_STREAMS", "native,rtsp") as Array<"native" | "rtsp" | "rtmp">;
  const profiles = envCsv("BAICHUAN_DIAG_PROFILES", "") as Array<"main" | "sub" | "ext">;

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: false,
    debugOptions: {
      enabled: false,
      debugParamSets: true,
      dump: { enabled: false },
    } as any,
  });

  const cgi = new ReolinkCgiApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
  });

  try {
    await Promise.all([api.login("aes" as any), cgi.login()]);

    await createDiagnosticsBundle({
      outDir,
      native: { api, channel },
      cgi: { cgi, channel },
      extra: {
        env: {
          BAICHUAN_DIAG_SECONDS: process.env.BAICHUAN_DIAG_SECONDS,
          BAICHUAN_DIAG_CHANNEL: process.env.BAICHUAN_DIAG_CHANNEL,
          BAICHUAN_DIAG_STREAMS: process.env.BAICHUAN_DIAG_STREAMS,
          BAICHUAN_DIAG_PROFILES: process.env.BAICHUAN_DIAG_PROFILES,
          BAICHUAN_DIAG_SNAPSHOT_INTERVAL: process.env.BAICHUAN_DIAG_SNAPSHOT_INTERVAL,
        },
      },
    });

    const rtmpUrls: any = {
      main: process.env.BAICHUAN_RTMP_URL_MAIN,
      sub: process.env.BAICHUAN_RTMP_URL_SUB,
      ext: process.env.BAICHUAN_RTMP_URL_EXT,
    };

    await sampleStreams({
      outDir: path.join(outDir, "samples"),
      durationSeconds,
      snapshotIntervalSeconds,
      channel,
      selection: {
        kinds,
        ...(profiles.length ? { profiles } : {}),
      },
      native: { api },
      rtsp: {
        host: config.tcp.host,
        username: config.tcp.username,
        password: config.tcp.password,
      },
      rtmp: { urlsByProfile: rtmpUrls },
      limits: {
        maxNativeRawFrames: envNum("BAICHUAN_DIAG_MAX_RAW_FRAMES", 400),
        maxNativeRawBytes: envNum("BAICHUAN_DIAG_MAX_RAW_BYTES", 50 * 1024 * 1024),
      },
    });
  } finally {
    await Promise.allSettled([api.close(), cgi.logout()]);
  }

  console.log(`[DiagnosticsSampler] Bundle created: ${outDir}`);
  console.log(`[DiagnosticsSampler] Samples: ${path.join(outDir, "samples")}`);
}

run().catch((e) => {
  console.error(`[DiagnosticsSampler] Fatal error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
