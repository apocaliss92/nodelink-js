#!/usr/bin/env node
/**
 * Generates a diagnostics bundle to help debug different camera models and streaming behavior.
 *
 * What it collects:
 * - DevInfo (model/firmware/hardware)
 * - Net ports
 * - Stream metadata (profiles)
 * - Stream start/stop for each profile (keyframe latency + frame counters)
 * - Optional recording samples (MP4/H264) using the existing recording pipeline
 *
 * Output:
 * - A timestamped directory with `diagnostics.json`, `stream.ndjson` and optional recordings.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BaichuanVideoStream } from "../../index";
import { config } from "../env";
import * as fs from "node:fs";
import * as path from "node:path";

type StreamProfile = "main" | "sub" | "ext";

function nowIsoCompact(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function envBool(v: string | undefined, def: boolean): boolean {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return def;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function run(): Promise<void> {
  if (!config.tcp.host || !config.tcp.password) {
    throw new Error("Missing TCP configuration in .env (TCP_HOST/TCP_PASSWORD).");
  }

  const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;
  const recordSeconds = Number(process.env.BAICHUAN_DIAG_SECONDS ?? "5");
  const recordSamples = envBool(process.env.BAICHUAN_DIAG_RECORD, false);
  const dumpDirBase = (process.env.BAICHUAN_DIAG_DIR && process.env.BAICHUAN_DIAG_DIR.trim()) || path.join(process.cwd(), "test", "diagnostics");
  const outDir = path.join(dumpDirBase, `diag_${config.tcp.host}_${nowIsoCompact()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const ndjsonPath = path.join(outDir, "stream.ndjson");
  const ndjson = (obj: unknown) => fs.appendFileSync(ndjsonPath, JSON.stringify(obj) + "\n");

  const debugEnabled = envBool(process.env.BAICHUAN_DEBUG, false);
  const dumpEnabled = envBool(process.env.BAICHUAN_DUMP, false);
  const debugOptions = {
    enabled: debugEnabled,
    traceNativeStream:
      envBool(process.env.BAICHUAN_TRACE_NATIVE_STREAM, false) ||
      envBool(process.env.BAICHUAN_TRACE_STREAM, false) ||
      envBool(process.env.BAICHUAN_DEBUG_H264, debugEnabled) ||
      envBool(process.env.BAICHUAN_DEBUG_PARAMSETS, false),
    dump: {
      enabled: dumpEnabled,
      dir: (process.env.BAICHUAN_DUMP_DIR && process.env.BAICHUAN_DUMP_DIR.trim()) || undefined,
      bcmedia: envBool(process.env.BAICHUAN_DUMP_BCMEDIA, dumpEnabled),
      nals: envBool(process.env.BAICHUAN_DUMP_NALS, dumpEnabled),
    },
  } as const;

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: false,
    debugOptions,
  });

  const channel = 0;
  const startedAt = Date.now();

  try {
    await api.login(maxEnc ?? "aes");

    const devInfo = await api.getInfo().catch((e: any) => ({ error: String(e) }));
    const ports = await api.getPorts().catch((e: any) => ({ error: String(e) }));
    const streamMetadata = await api.getStreamMetadata(channel).catch((e: any) => ({ error: String(e) }));

    fs.writeFileSync(
      path.join(outDir, "diagnostics.json"),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          host: config.tcp.host,
          maxEnc: maxEnc ?? "aes",
          env: {
            BAICHUAN_DEBUG: process.env.BAICHUAN_DEBUG,
            BAICHUAN_TRACE_STREAM: process.env.BAICHUAN_TRACE_STREAM,
            BAICHUAN_DUMP: process.env.BAICHUAN_DUMP,
            BAICHUAN_DUMP_DIR: process.env.BAICHUAN_DUMP_DIR,
            BAICHUAN_DEBUG_H264: process.env.BAICHUAN_DEBUG_H264,
            BAICHUAN_DEBUG_PARAMSETS: process.env.BAICHUAN_DEBUG_PARAMSETS,
            BAICHUAN_DUMP_BCMEDIA: process.env.BAICHUAN_DUMP_BCMEDIA,
            BAICHUAN_DUMP_NALS: process.env.BAICHUAN_DUMP_NALS,
          },
          devInfo,
          ports,
          streamMetadata,
        },
        null,
        2
      )
    );

    const profiles: StreamProfile[] = [];
    const streams = (streamMetadata as any)?.streams;
    if (Array.isArray(streams)) {
      for (const s of streams) {
        if (s?.profile === "main" || s?.profile === "sub" || s?.profile === "ext") {
          if (!profiles.includes(s.profile)) profiles.push(s.profile);
        }
      }
    }
    if (profiles.length === 0) profiles.push("sub");

    for (const profile of profiles) {
      const vs = new BaichuanVideoStream({ client: api.client, api, channel, profile });
      let firstKeyframeMs: number | null = null;
      let videoAUs = 0;
      let audioFrames = 0;

      const onAU = (u: any) => {
        if (!u || !Buffer.isBuffer(u.data)) return;
        videoAUs++;
        if (u.isKeyframe && firstKeyframeMs == null) {
          firstKeyframeMs = Date.now() - startedAt;
        }
      };
      const onAudio = () => {
        audioFrames++;
      };
      vs.on("videoAccessUnit" as any, onAU as any);
      vs.on("audioFrame", onAudio);

      ndjson({ t: Date.now(), type: "stream_start", profile });
      await vs.start();

      // Warm-up a bit to gather counters.
      await sleep(Math.max(1000, recordSeconds * 1000));

      ndjson({
        t: Date.now(),
        type: "stream_stats",
        profile,
        firstKeyframeMs,
        videoAccessUnits: videoAUs,
        audioFrames,
      });

      await vs.stop();
      ndjson({ t: Date.now(), type: "stream_stop", profile });

      if (recordSamples) {
        // Reuse existing recording test script pipeline by spawning it is overkill here;
        // for now we just emit a hint to use test-tcp-video-stream-record (it records all profiles deterministically).
        ndjson({ t: Date.now(), type: "note", message: `To record samples, run: npm run test:tcp:video-stream-record` });
      }
    }
  } finally {
    await api.close().catch(() => undefined);
  }

  console.log(`[Diagnostics] Bundle created: ${outDir}`);
  console.log(`[Diagnostics] Stream trace: ${ndjsonPath}`);
}

run().catch((e) => {
  console.error(`[Diagnostics] Fatal error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});


