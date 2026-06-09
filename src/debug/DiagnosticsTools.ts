import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../reolink/baichuan/types";
import type {
  ReolinkCgiApi,
  DeviceInputData,
} from "../reolink/cgi/ReolinkCgiApi";
import type { ReolinkHttpClientOptions } from "../reolink/http/ReolinkHttpClient";
import { ReolinkCgiApi as ReolinkCgiApiImpl } from "../reolink/cgi/ReolinkCgiApi";
import { join } from "node:path";
import { zipDirectory } from "./zip";
import { BaichuanVideoStream } from "../baichuan/stream/BaichuanVideoStream";
import type { StreamProfile } from "../reolink/baichuan/types";
import { buildRtspUrl } from "../rtsp/urls";
import { splitAnnexBToNalPayloads } from "../baichuan/stream/H264Converter";
import {
  getH265NalType,
  splitAnnexBToNalPayloads as splitH265AnnexBToNalPayloads,
} from "../baichuan/stream/H265Converter";
import type { Logger } from "./DebugConfig";
import {
  BC_CLASS_MODERN_24,
  BC_CLASS_MODERN_24_ALT,
  BC_CMD_ID_GET_WHITE_LED,
  BC_CMD_ID_VIDEO,
} from "../protocol/constants";
import type { BaichuanFrame } from "../protocol/framing";
import {
  buildChannelExtensionXml,
  buildPreviewStopXml,
  buildPreviewStopXmlV11,
  buildPreviewXml,
  buildPreviewXmlV11,
} from "../protocol/xml";

export type DiagnosticsStreamKind = "native" | "rtsp" | "rtmp";

export type DiagnosticsCollectorResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function safeStringifyError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function tryCall<T>(
  fn: () => Promise<T>,
): Promise<DiagnosticsCollectorResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: safeStringifyError(e) };
  }
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, obj: unknown): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function writeText(filePath: string, text: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, text);
}

function appendNdjson(filePath: string, obj: unknown): void {
  mkdirp(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIsoCompact(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nalTypesSummary(
  videoType: "H264" | "H265",
  accessUnitAnnexB: Buffer,
): number[] {
  if (videoType === "H264") {
    const nals = splitAnnexBToNalPayloads(accessUnitAnnexB);
    return nals.map((n) => (n[0] ?? 0) & 0x1f);
  }
  const nals = splitH265AnnexBToNalPayloads(accessUnitAnnexB);
  return nals
    .map((nal: Buffer) => getH265NalType(nal))
    .filter((t: number | null): t is number => typeof t === "number");
}

function normalizeProfiles(
  p: Array<string | undefined | null> | undefined,
): StreamProfile[] {
  const out: StreamProfile[] = [];
  for (const v of p ?? []) {
    if (v === "main" || v === "sub" || v === "ext") {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

export async function collectNativeDiagnostics(params: {
  api: ReolinkBaichuanApi;
  channel?: number;
}): Promise<Record<string, unknown>> {
  const { api } = params;
  const channel = params.channel ?? 0;

  const result: Record<string, unknown> = {
    kind: "native",
    channel,
    transport: api.client.getTransport?.(),
    encKind: api.client.enc?.kind,
    collectedAt: new Date().toISOString(),
  };

  const [
    info,
    ports,
    streamMetadata,
    abilities,
    capabilities,
    talkAbility,
    twoWayAudio,
  ] = await Promise.all([
    tryCall(() => api.getInfo(channel)),
    tryCall(() => api.getPorts()),
    tryCall(() => api.getStreamMetadata(channel)),
    tryCall(() => api.getAbilityInfo()),
    tryCall(() => api.getDeviceCapabilities(channel)),
    tryCall(() => api.getTalkAbility(channel)),
    tryCall(() => api.getTwoWayAudioConfig(channel)),
  ]);

  result.info = info;
  result.ports = ports;
  result.streamMetadata = streamMetadata;
  result.abilityInfo = abilities;
  result.deviceCapabilities = capabilities;
  result.talkAbility = talkAbility;
  result.twoWayAudio = twoWayAudio;

  // Convenience: derive a "recommended" config (no side effects) from TalkAbility.
  if (talkAbility?.ok && talkAbility.value) {
    const v: any = talkAbility.value as any;
    const recommended = {
      duplex: Array.isArray(v.duplexList) ? v.duplexList[0] : undefined,
      audioStreamMode: Array.isArray(v.audioStreamModeList)
        ? v.audioStreamModeList[0]
        : undefined,
      audioConfig: Array.isArray(v.audioConfigList)
        ? v.audioConfigList[0]
        : undefined,
    };
    result.intercomRecommended = recommended;
  }

  return result;
}

export async function collectCgiDiagnostics(params: {
  cgi: ReolinkCgiApi;
  channel?: number;
}): Promise<Record<string, unknown>> {
  const { cgi } = params;
  const channel = params.channel ?? 0;

  const result: Record<string, unknown> = {
    kind: "cgi",
    channel,
    collectedAt: new Date().toISOString(),
  };

  const [info, netPort, ability, enc, chStatus, chnType, aiState] =
    await Promise.all([
      tryCall(() => cgi.getInfo(channel)),
      tryCall(() => cgi.GetNetPort()),
      tryCall(() => cgi.GetAbility()),
      tryCall(() => cgi.GetEnc(channel)),
      tryCall(() => cgi.GetChannelstatus()),
      tryCall(() => cgi.GetChnTypeInfo(channel)),
      tryCall(() => cgi.GetAiState(channel)),
    ]);

  result.info = info;
  result.netPort = netPort;
  result.ability = ability;
  result.enc = enc;
  result.channelStatus = chStatus;
  result.channelTypeInfo = chnType;
  result.aiState = aiState;

  // Batch helper includes raw requestBody/response: super useful for user diagnostics.
  result.devicesInfo = await tryCall(() => cgi.getDevicesInfo());

  return result;
}

export async function createDiagnosticsBundle(params: {
  outDir: string;
  native?: { api: ReolinkBaichuanApi; channel?: number };
  cgi?: { cgi: ReolinkCgiApi; channel?: number };
  extra?: Record<string, unknown>;
}): Promise<{ outDir: string; diagnosticsPath: string }> {
  const outDir = params.outDir;
  mkdirp(outDir);

  const [native, cgi] = await Promise.all([
    params.native
      ? tryCall(() => collectNativeDiagnostics(params.native!))
      : Promise.resolve(undefined),
    params.cgi
      ? tryCall(() => collectCgiDiagnostics(params.cgi!))
      : Promise.resolve(undefined),
  ]);

  const diagnostics = {
    createdAt: new Date().toISOString(),
    native,
    cgi,
    ...(params.extra ? { extra: params.extra } : {}),
  };

  const diagnosticsPath = path.join(outDir, "diagnostics.json");
  writeJson(diagnosticsPath, diagnostics);

  return { outDir, diagnosticsPath };
}

export type StreamSamplingSelection = {
  kinds: DiagnosticsStreamKind[];
  profiles?: StreamProfile[];
};

export type StreamSamplingOptions = {
  outDir: string;
  durationSeconds: number;
  snapshotIntervalSeconds?: number;
  channel?: number;
  selection: StreamSamplingSelection;

  /** Optional logger for human-readable progress logs. */
  logger?: Logger;

  // RTSP: if enabled, build the direct-camera RTSP URL.
  rtsp?: {
    host: string;
    username: string;
    password: string;
    port?: number;
  };

  // RTMP: optional explicit URLs per profile.
  rtmp?: {
    urlsByProfile: Partial<Record<StreamProfile, string>>;
  };

  // Native: required when "native" is selected.
  native?: {
    api: ReolinkBaichuanApi;
  };

  // Limits to avoid runaway dumps.
  limits?: {
    maxNativeRawFrames?: number;
    maxNativeRawBytes?: number;
  };
};

type FfmpegResult = { ok: true } | { ok: false; error: string };

/**
 * Sanitize error messages by removing credentials from URLs.
 * Replaces patterns like "rtsp://username:password@host" with "rtsp://***:***@host"
 */
function sanitizeFfmpegError(error: string): string {
  // Replace credentials in URLs (rtsp://, rtmp://, http://, https://)
  return error.replace(
    /([a-z]+:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
    (match, protocol, username, password) => {
      // Keep the protocol, but hide username and password
      return `${protocol}***:***@`;
    },
  );
}

function spawnFfmpeg(args: string[], logPath: string): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    mkdirp(path.dirname(logPath));
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    p.on("error", (e) => {
      logStream.write(
        `ffmpeg spawn error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      logStream.end();
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });

    let stderr = "";
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      // Sanitize credentials before writing to log file
      logStream.write(sanitizeFfmpegError(s));
    });

    p.on("close", (code) => {
      logStream.end();
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const errorMsg = `ffmpeg exited with code ${code}\n${stderr.slice(-4000)}`;
      resolve({ ok: false, error: sanitizeFfmpegError(errorMsg) });
    });
  });
}

type FfprobeVideoInfo = {
  codecName?: string;
  codecLongName?: string;
  width?: number;
  height?: number;
  avgFrameRate?: string;
  rFrameRate?: string;
  pixFmt?: string;
};

function spawnFfprobeJson(
  args: string[],
  logPath: string,
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    mkdirp(path.dirname(logPath));
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const p = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    p.on("error", (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      logStream.write(`ffprobe spawn error: ${msg}\n`);
      logStream.end();
      resolve({ ok: false, error: msg });
    });

    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      logStream.write(sanitizeFfmpegError(s));
    });

    p.on("close", (code) => {
      logStream.end();
      if (code === 0) {
        try {
          const json = JSON.parse(stdout || "{}");
          resolve({ ok: true, json });
        } catch (e) {
          resolve({
            ok: false,
            error: `ffprobe JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        return;
      }

      resolve({
        ok: false,
        error: sanitizeFfmpegError(
          `ffprobe exited with code ${code}\n${stderr.slice(-2000)}`,
        ),
      });
    });
  });
}

async function probeVideoInfo(params: {
  url: string;
  kind: "rtsp" | "rtmp";
  logPath: string;
}): Promise<
  { ok: true; info: FfprobeVideoInfo } | { ok: false; error: string }
> {
  const args = [
    "-v",
    "error",
    ...(params.kind === "rtsp" ? ["-rtsp_transport", "tcp"] : []),
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "v:0",
    params.url,
  ];

  const res = await spawnFfprobeJson(args, params.logPath);
  if (!res.ok) return res;

  const streams = Array.isArray(res.json?.streams) ? res.json.streams : [];
  const s0 = streams[0] ?? undefined;
  const info: FfprobeVideoInfo = {
    codecName: typeof s0?.codec_name === "string" ? s0.codec_name : undefined,
    codecLongName:
      typeof s0?.codec_long_name === "string" ? s0.codec_long_name : undefined,
    width: typeof s0?.width === "number" ? s0.width : undefined,
    height: typeof s0?.height === "number" ? s0.height : undefined,
    avgFrameRate:
      typeof s0?.avg_frame_rate === "string" ? s0.avg_frame_rate : undefined,
    rFrameRate:
      typeof s0?.r_frame_rate === "string" ? s0.r_frame_rate : undefined,
    pixFmt: typeof s0?.pix_fmt === "string" ? s0.pix_fmt : undefined,
  };

  return { ok: true, info };
}

async function recordRtspOrRtmpToFile(params: {
  kind: "rtsp" | "rtmp";
  url: string;
  outputPath: string;
  durationSeconds: number;
  logPath: string;
}): Promise<FfmpegResult> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-stats",
    ...(params.kind === "rtsp" ? ["-rtsp_transport", "tcp"] : []),
    "-i",
    params.url,
    "-t",
    String(params.durationSeconds),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-y",
    params.outputPath,
  ];

  return await spawnFfmpeg(args, params.logPath);
}

/**
 * Test stream availability with ffmpeg (short session).
 * Returns success if ffmpeg can connect and receive data.
 */
async function testStreamWithFfmpeg(params: {
  url: string;
  kind: "rtsp" | "rtmp";
  durationSeconds?: number;
}): Promise<DiagnosticsCollectorResult<{ duration: number }>> {
  const duration = params.durationSeconds ?? 2;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(params.kind === "rtsp" ? ["-rtsp_transport", "tcp"] : []),
    "-i",
    params.url,
    "-t",
    String(duration),
    "-f",
    "null",
    "-", // Output to null (we just want to test connection)
  ];

  return new Promise((resolve) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let hasData = false;

    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      // Check for successful connection indicators
      if (
        s.includes("Stream #0") ||
        s.includes("Video:") ||
        s.includes("Audio:") ||
        s.includes("Duration:")
      ) {
        hasData = true;
      }
    });

    p.on("close", (code) => {
      if (code === 0 || hasData) {
        resolve({ ok: true, value: { duration } });
      } else {
        const errorMsg = `ffmpeg exited with code ${code}\n${stderr.slice(-1000)}`;
        resolve({ ok: false, error: sanitizeFfmpegError(errorMsg) });
      }
    });

    p.on("error", (e) => {
      const errorMsg = e instanceof Error ? e.message : String(e);
      resolve({ ok: false, error: sanitizeFfmpegError(errorMsg) });
    });
  });
}

async function recordRtspOrRtmp(params: {
  kind: "rtsp" | "rtmp";
  url: string;
  outputMp4: string;
  durationSeconds: number;
  logPath: string;
}): Promise<FfmpegResult> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-stats",
    ...(params.kind === "rtsp" ? ["-rtsp_transport", "tcp"] : []),
    "-i",
    params.url,
    "-t",
    String(params.durationSeconds),
    "-c",
    "copy",
    "-y",
    params.outputMp4,
  ];

  return await spawnFfmpeg(args, params.logPath);
}

async function snapshotsRtspOrRtmp(params: {
  kind: "rtsp" | "rtmp";
  url: string;
  snapshotsPattern: string;
  durationSeconds: number;
  snapshotIntervalSeconds: number;
  logPath: string;
}): Promise<FfmpegResult> {
  const fpsExpr = `fps=1/${Math.max(0.25, params.snapshotIntervalSeconds)}`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-stats",
    ...(params.kind === "rtsp" ? ["-rtsp_transport", "tcp"] : []),
    "-i",
    params.url,
    "-t",
    String(params.durationSeconds),
    "-vf",
    fpsExpr,
    "-q:v",
    "2",
    "-y",
    params.snapshotsPattern,
  ];

  return await spawnFfmpeg(args, params.logPath);
}

async function tryJpegFromAnnexB(params: {
  videoType: "H264" | "H265";
  snapshotAnnexBPath: string;
  outputJpegPath: string;
  logPath: string;
}): Promise<void> {
  // Best-effort: this is optional for user diagnostics.
  // ffmpeg can decode raw Annex-B elementary streams with -f h264/-f hevc.
  const fmt = params.videoType === "H265" ? "hevc" : "h264";
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-stats",
    "-f",
    fmt,
    "-i",
    params.snapshotAnnexBPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    params.outputJpegPath,
  ];

  const res = await spawnFfmpeg(args, params.logPath);
  void res;
}

export async function sampleStreams(
  opts: StreamSamplingOptions,
): Promise<void> {
  const channel = opts.channel ?? 0;
  const durationMs = Math.max(250, Math.round(opts.durationSeconds * 1000));
  const snapshotIntervalSeconds = opts.snapshotIntervalSeconds ?? 2;

  const logger = opts.logger;
  const log = (
    level: "log" | "warn" | "error",
    msg: string,
    extra?: unknown,
  ) => {
    const fn = (logger?.[level] ?? logger?.log) as
      | ((...args: any[]) => void)
      | undefined;
    if (!fn) return;
    if (extra !== undefined) fn.call(logger, msg, extra);
    else fn.call(logger, msg);
  };

  const profiles = normalizeProfiles(
    opts.selection.profiles,
  ) as StreamProfile[];
  const selectedProfiles: StreamProfile[] = profiles.length
    ? profiles
    : ["main", "sub", "ext"];

  const outDir = opts.outDir;
  mkdirp(outDir);

  log("log", "[Diagnostics] stream sampling start", {
    outDir,
    channel,
    durationSeconds: opts.durationSeconds,
    snapshotIntervalSeconds,
    selection: opts.selection,
  });

  const eventsPath = path.join(outDir, "events.ndjson");
  appendNdjson(eventsPath, {
    t: Date.now(),
    type: "sampling_start",
    channel,
    durationSeconds: opts.durationSeconds,
    snapshotIntervalSeconds,
    selection: opts.selection,
  });

  for (const profile of selectedProfiles) {
    for (const kind of opts.selection.kinds) {
      const tag = `${kind}_${profile}`;
      const baseDir = path.join(outDir, tag);
      mkdirp(baseDir);

      appendNdjson(eventsPath, {
        t: Date.now(),
        type: "stream_begin",
        kind,
        profile,
        channel,
      });
      log("log", "[Diagnostics] stream begin", { kind, profile, channel });

      if (kind === "native") {
        const api = opts.native?.api;
        if (!api) {
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "stream_skip",
            kind,
            profile,
            reason: "native api missing",
          });
          log("warn", "[Diagnostics] stream skip (native api missing)", {
            kind,
            profile,
            channel,
          });
          continue;
        }

        const rawDir = path.join(baseDir, "raw_frames");
        const snapsDir = path.join(baseDir, "snapshots");
        mkdirp(rawDir);
        mkdirp(snapsDir);

        const maxRawFrames = opts.limits?.maxNativeRawFrames ?? 400;
        const maxRawBytes = opts.limits?.maxNativeRawBytes ?? 50 * 1024 * 1024;
        let rawFrames = 0;
        let rawBytes = 0;

        const expectedStreamType = profile === "sub" ? 1 : 0;

        const onFrame = (frame: any) => {
          if (!frame?.header) return;
          if (frame.header.cmdId !== 3) return;
          if (frame.header.streamType !== expectedStreamType) return;
          if (rawFrames >= maxRawFrames) return;
          const payload: Buffer =
            Buffer.isBuffer(frame.payload) && frame.payload.length
              ? frame.payload
              : frame.body;
          if (!Buffer.isBuffer(payload) || payload.length === 0) return;
          if (rawBytes + payload.length > maxRawBytes) return;

          rawFrames++;
          rawBytes += payload.length;

          const idx = String(rawFrames).padStart(6, "0");
          const binPath = path.join(rawDir, `frame_${idx}.bin`);
          try {
            fs.writeFileSync(binPath, payload);
          } catch {
            // ignore
          }

          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_raw_frame",
            kind,
            profile,
            idx: rawFrames,
            bytes: payload.length,
            header: frame.header,
            bodyLen: frame.body?.length ?? 0,
            payloadLen: frame.payload?.length ?? 0,
          });
        };

        api.client.on("frame", onFrame);

        const videoStream = new BaichuanVideoStream({
          client: api.client as any,
          api: api as any,
          channel,
          profile,
        });

        const clipBase = path.join(baseDir, `clip_${nowIsoCompact()}`);
        const clipAnnexBPath = clipBase + ".annexb";
        const clipAudioPath = clipBase + ".audio.bin";
        const clipInfoPath = clipBase + ".json";

        const videoOut = fs.createWriteStream(clipAnnexBPath, { flags: "w" });
        const audioOut = fs.createWriteStream(clipAudioPath, { flags: "w" });

        let firstVideoType: "H264" | "H265" | undefined;
        let firstKeyframeAtMs: number | null = null;
        let videoAUs = 0;
        let audioFrames = 0;
        let lastSnapshotAtMs = 0;
        let startedAtMs: number | null = null;

        const onAU = (u: any) => {
          if (!u || !Buffer.isBuffer(u.data)) return;
          if (!firstVideoType) firstVideoType = u.videoType;

          videoAUs++;
          try {
            videoOut.write(u.data);
          } catch {
            // ignore
          }

          if (u.isKeyframe && firstKeyframeAtMs == null) {
            firstKeyframeAtMs = Date.now();
          }

          const nalTypes = nalTypesSummary(u.videoType, u.data);
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_access_unit",
            kind,
            profile,
            isKeyframe: !!u.isKeyframe,
            videoType: u.videoType,
            microseconds: u.microseconds,
            bytes: u.data.length,
            nalTypes,
          });

          const now = Date.now();
          if (
            u.isKeyframe &&
            now - lastSnapshotAtMs >= snapshotIntervalSeconds * 1000
          ) {
            lastSnapshotAtMs = now;
            const snapId = nowIsoCompact();
            const snapAnnex = path.join(
              snapsDir,
              `snap_${snapId}.${u.videoType === "H265" ? "h265" : "h264"}`,
            );
            try {
              fs.writeFileSync(snapAnnex, u.data);
              appendNdjson(eventsPath, {
                t: Date.now(),
                type: "native_snapshot_saved",
                kind,
                profile,
                path: snapAnnex,
              });

              // Optional: try producing a jpeg (best-effort).
              const snapJpeg = path.join(snapsDir, `snap_${snapId}.jpg`);
              void tryJpegFromAnnexB({
                videoType: u.videoType,
                snapshotAnnexBPath: snapAnnex,
                outputJpegPath: snapJpeg,
                logPath: path.join(baseDir, "ffmpeg_snapshot.log"),
              });
            } catch {
              // ignore
            }
          }
        };

        const onAudio = (buf: Buffer) => {
          if (!Buffer.isBuffer(buf) || buf.length === 0) return;
          audioFrames++;
          try {
            audioOut.write(buf);
          } catch {
            // ignore
          }
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_audio",
            kind,
            profile,
            bytes: buf.length,
          });
        };

        videoStream.on("videoAccessUnit" as any, onAU as any);
        videoStream.on("audioFrame" as any, onAudio as any);
        videoStream.on("error", (e: any) => {
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_error",
            kind,
            profile,
            error: safeStringifyError(e),
          });
        });

        try {
          await videoStream.start();
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_started",
            kind,
            profile,
          });

          startedAtMs = Date.now();
          while (Date.now() - startedAtMs < durationMs) {
            await sleepMs(200);
          }
        } finally {
          try {
            await videoStream.stop();
          } catch {
            // ignore
          }

          api.client.removeListener("frame", onFrame);

          try {
            videoOut.end();
          } catch {
            // ignore
          }
          try {
            audioOut.end();
          } catch {
            // ignore
          }

          const clipInfo = {
            kind,
            profile,
            channel,
            durationSeconds: opts.durationSeconds,
            videoAccessUnits: videoAUs,
            audioFrames,
            videoType: firstVideoType,
            firstKeyframeLatencyMs:
              firstKeyframeAtMs == null || startedAtMs == null
                ? null
                : Math.max(0, firstKeyframeAtMs - startedAtMs),
            rawFrames,
            rawBytes,
          };
          writeJson(clipInfoPath, clipInfo);

          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_done",
            ...clipInfo,
          });
          log("log", "[Diagnostics] stream done", clipInfo);
        }

        continue;
      }

      if (kind === "rtsp") {
        if (!opts.rtsp) {
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "stream_skip",
            kind,
            profile,
            reason: "rtsp config missing",
          });
          log("warn", "[Diagnostics] stream skip (rtsp config missing)", {
            kind,
            profile,
            channel,
          });
          continue;
        }

        const url = buildRtspUrl({
          host: opts.rtsp.host,
          username: opts.rtsp.username,
          password: opts.rtsp.password,
          channel,
          stream: profile,
          ...(opts.rtsp.port != null ? { port: opts.rtsp.port } : {}),
        });

        const mp4Path = path.join(baseDir, `clip_${nowIsoCompact()}.mp4`);
        const logPath = path.join(baseDir, "ffmpeg_record.log");
        const snapsDir = path.join(baseDir, "snapshots");
        mkdirp(snapsDir);
        const snapsPattern = path.join(snapsDir, "snap_%05d.jpg");

        appendNdjson(eventsPath, {
          t: Date.now(),
          type: "rtsp_url",
          kind,
          profile,
          url,
        });

        const [recordRes, snapsRes] = await Promise.all([
          recordRtspOrRtmp({
            kind: "rtsp",
            url,
            outputMp4: mp4Path,
            durationSeconds: opts.durationSeconds,
            logPath,
          }),
          snapshotsRtspOrRtmp({
            kind: "rtsp",
            url,
            snapshotsPattern: snapsPattern,
            durationSeconds: opts.durationSeconds,
            snapshotIntervalSeconds,
            logPath: path.join(baseDir, "ffmpeg_snapshots.log"),
          }),
        ]);

        appendNdjson(eventsPath, {
          t: Date.now(),
          type: "rtsp_done",
          kind,
          profile,
          mp4Path,
          record: recordRes,
          snapshots: snapsRes,
        });

        log("log", "[Diagnostics] stream done", {
          kind,
          profile,
          channel,
          mp4Path,
          record: recordRes,
          snapshots: snapsRes,
        });

        continue;
      }

      if (kind === "rtmp") {
        const url = opts.rtmp?.urlsByProfile?.[profile];
        if (!url) {
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "stream_skip",
            kind,
            profile,
            reason: "rtmp url missing",
          });
          log("warn", "[Diagnostics] stream skip (rtmp url missing)", {
            kind,
            profile,
            channel,
          });
          continue;
        }

        const mp4Path = path.join(baseDir, `clip_${nowIsoCompact()}.mp4`);
        const logPath = path.join(baseDir, "ffmpeg_record.log");
        const snapsDir = path.join(baseDir, "snapshots");
        mkdirp(snapsDir);
        const snapsPattern = path.join(snapsDir, "snap_%05d.jpg");

        appendNdjson(eventsPath, {
          t: Date.now(),
          type: "rtmp_url",
          kind,
          profile,
          url,
        });

        const [recordRes, snapsRes] = await Promise.all([
          recordRtspOrRtmp({
            kind: "rtmp",
            url,
            outputMp4: mp4Path,
            durationSeconds: opts.durationSeconds,
            logPath,
          }),
          snapshotsRtspOrRtmp({
            kind: "rtmp",
            url,
            snapshotsPattern: snapsPattern,
            durationSeconds: opts.durationSeconds,
            snapshotIntervalSeconds,
            logPath: path.join(baseDir, "ffmpeg_snapshots.log"),
          }),
        ]);

        appendNdjson(eventsPath, {
          t: Date.now(),
          type: "rtmp_done",
          kind,
          profile,
          mp4Path,
          record: recordRes,
          snapshots: snapsRes,
        });

        log("log", "[Diagnostics] stream done", {
          kind,
          profile,
          channel,
          mp4Path,
          record: recordRes,
          snapshots: snapsRes,
        });

        continue;
      }
    }
  }

  appendNdjson(eventsPath, { t: Date.now(), type: "sampling_done" });
}

/**
 * Comprehensive NVR/HUB diagnostics function.
 * Collects and prints all available information about the NVR/HUB device and all its channels.
 */
export async function collectNvrDiagnostics(params: {
  cgi: ReolinkCgiApi;
  logger?: Logger;
}): Promise<Record<string, unknown>> {
  const { cgi, logger } = params;
  const log = (msg: string, data?: unknown) => {
    if (logger?.log) {
      if (data !== undefined) logger.log(msg, data);
      else logger.log(msg);
    } else {
      console.log(msg);
      if (data !== undefined) console.log(JSON.stringify(data, null, 2));
    }
  };

  const result: Record<string, unknown> = {
    kind: "nvr_diagnostics",
    collectedAt: new Date().toISOString(),
  };

  log("=".repeat(80));
  log("NVR/HUB DIAGNOSTICS - Starting comprehensive data collection");
  log("=".repeat(80));

  // 1. NVR/HUB Device Information
  log("\n[1/7] Collecting NVR/HUB device information...");
  const nvrInfo = await tryCall(() => cgi.getNvrInfo());
  result.nvrInfo = nvrInfo;
  if (nvrInfo.ok) {
    log("✓ NVR/HUB info collected", {
      model: nvrInfo.value.devInfo?.type,
      name: nvrInfo.value.devInfo?.name,
      firmware: nvrInfo.value.devInfo?.firmVer,
      hardware: nvrInfo.value.devInfo?.hardVer,
      serial: nvrInfo.value.devInfo?.serial,
    });
  } else {
    log("✗ Failed to collect NVR/HUB info", nvrInfo.error);
  }

  // 2. Get all channels
  log("\n[2/7] Discovering channels...");
  // Use channelNum fallback for multi-focal cameras
  const channelsResult = await tryCall(() =>
    cgi.getChannels({ useChannelNumFallback: true }),
  );
  result.channels = channelsResult;
  let channels: number[] = [];
  if (channelsResult.ok) {
    channels = channelsResult.value.channels;
    log(`✓ Found ${channels.length} channel(s): ${channels.join(", ")}`);
    result.channelList = channels;
  } else {
    log("✗ Failed to discover channels", channelsResult.error);
    result.channelList = [];
  }

  // 3. Devices Information (per-channel: type, AI, encoding)
  log("\n[3/7] Collecting devices information for all channels...");
  const devicesInfo = await tryCall(() =>
    cgi.getDevicesInfo({ useChannelNumFallback: true }),
  );
  result.devicesInfo = devicesInfo;
  if (devicesInfo.ok) {
    log(
      `✓ Devices info collected for ${Object.keys(devicesInfo.value.devicesData).length} channel(s)`,
    );
    for (const [channel, device] of Object.entries(
      devicesInfo.value.devicesData,
    )) {
      const ch = Number(channel);
      const info = device as any;
      log(`  Channel ${ch}:`, {
        model: info.channelInfo?.typeInfo || info.channelStatus?.typeInfo,
        name: info.channelStatus?.name,
        online: info.channelStatus?.online === 1,
        sleeping: info.channelStatus?.sleep === 1,
        uid: info.channelStatus?.uid,
        firmware: info.channelInfo?.firmVer,
        boardInfo: info.channelInfo?.boardInfo,
      });
    }
  } else {
    log("✗ Failed to collect devices info", devicesInfo.error);
  }

  // 4. Events and Detection (motion, AI)
  log("\n[4/7] Collecting events and detection states for all channels...");
  const eventsInfo = await tryCall(() =>
    cgi.getAllChannelsEvents({ useChannelNumFallback: true }),
  );
  result.eventsInfo = eventsInfo;
  if (eventsInfo.ok) {
    log(
      `✓ Events info collected for ${Object.keys(eventsInfo.value.parsed).length} channel(s)`,
    );
    for (const [channel, events] of Object.entries(eventsInfo.value.parsed)) {
      const ch = Number(channel);
      const evt = events as any;
      log(`  Channel ${ch}:`, {
        motion: evt.motion,
        detectedObjects: evt.objects,
      });
    }
  } else {
    log("✗ Failed to collect events info", eventsInfo.error);
  }

  // 5. Battery Information
  log("\n[5/7] Collecting battery information for all channels...");
  const batteryInfo = await tryCall(() =>
    cgi.getAllChannelsBatteryInfo({ useChannelNumFallback: true }),
  );
  result.batteryInfo = batteryInfo;
  if (batteryInfo.ok) {
    log(
      `✓ Battery info collected for ${Object.keys(batteryInfo.value.batteryInfoData).length} channel(s)`,
    );
    for (const [channel, battery] of Object.entries(
      batteryInfo.value.batteryInfoData,
    )) {
      const ch = Number(channel);
      const bat = battery as any;
      log(`  Channel ${ch}:`, {
        batteryLevel: bat.batteryLevel,
        sleeping: bat.sleeping,
      });
    }
  } else {
    log("✗ Failed to collect battery info", batteryInfo.error);
  }

  // 6. Build DeviceInputData map for status info
  log("\n[6/7] Building device capabilities map...");
  const channelsMap = new Map<number, DeviceInputData>();
  if (devicesInfo.ok && batteryInfo.ok) {
    for (const channel of channels) {
      const device = devicesInfo.value.devicesData[channel];
      const battery = batteryInfo.value.batteryInfoData[channel];
      const abilities = device?.abilities;

      channelsMap.set(channel, {
        hasBattery:
          battery?.batteryLevel !== undefined && battery.batteryLevel > 0,
        hasPirEvents: !!(abilities as any)?.pirAlarm,
        hasFloodlight: !!(abilities as any)?.ledCtrl,
        hasPtz: !!(abilities as any)?.ptz,
        sleeping: battery?.sleeping ?? false,
      });
    }
    log(`✓ Built capabilities map for ${channelsMap.size} channel(s)`);
  }

  // 7. Status Information (OSD, Floodlight, PIR, PTZ Presets)
  log(
    "\n[7/7] Collecting status information (OSD, Floodlight, PIR, PTZ) for all channels...",
  );
  const statusInfo = await tryCall(() => cgi.getStatusInfo(channelsMap));
  result.statusInfo = statusInfo;
  if (statusInfo.ok) {
    log(
      `✓ Status info collected for ${Object.keys(statusInfo.value.deviceStatusData).length} channel(s)`,
    );
    for (const [channel, status] of Object.entries(
      statusInfo.value.deviceStatusData,
    )) {
      const ch = Number(channel);
      const st = status as any;
      log(`  Channel ${ch}:`, {
        osd: st.osd ? "configured" : "not available",
        floodlightEnabled: st.floodlightEnabled,
        pirEnabled: st.pirEnabled,
        ptzPresets: st.ptzPresets?.length ?? 0,
      });
    }
  } else {
    log("✗ Failed to collect status info", statusInfo.error);
  }

  // 8. Additional per-channel details
  log("\n[8/8] Collecting additional per-channel details...");
  const perChannelDetails: Record<number, Record<string, unknown>> = {};

  for (const channel of channels) {
    const channelDetails: Record<string, unknown> = {};

    // OSD
    const osd = await tryCall(() => cgi.GetOsd(channel));
    if (osd.ok) channelDetails.osd = osd.value;

    // Local Link / WiFi
    const localLink = await tryCall(() => cgi.getLocalLink(channel));
    if (localLink.ok) channelDetails.localLink = localLink.value;

    // PIR State
    const pirState = await tryCall(() => cgi.getPirState(channel));
    if (pirState.ok) channelDetails.pirState = pirState.value;

    // Siren/Audio Alarm
    const siren = await tryCall(() => cgi.getSiren(channel));
    if (siren.ok) channelDetails.siren = siren.value;

    // PTZ Presets
    const ptzPresets = await tryCall(() => cgi.GetPtzPreset(channel));
    if (ptzPresets.ok) channelDetails.ptzPresets = ptzPresets.value;

    // White LED / Floodlight
    const whiteLed = await tryCall(() => cgi.GetWhiteLed(channel));
    if (whiteLed.ok) channelDetails.whiteLed = whiteLed.value;

    // Encoding Configuration
    const enc = await tryCall(() => cgi.GetEnc(channel));
    if (enc.ok) channelDetails.encoding = enc.value;

    // AI State
    const aiState = await tryCall(() => cgi.GetAiState(channel));
    if (aiState.ok) channelDetails.aiState = aiState.value;

    // Motion Detection State
    const mdState = await tryCall(() => cgi.GetMdState(channel));
    if (mdState.ok) channelDetails.motionDetection = mdState.value;

    // Battery Info
    const battery = await tryCall(() => cgi.GetBatteryInfo(channel));
    if (battery.ok) channelDetails.battery = battery.value;

    // Channel Type Info
    const chnType = await tryCall(() => cgi.GetChnTypeInfo(channel));
    if (chnType.ok) channelDetails.channelType = chnType.value;

    // WiFi Signal
    const wifiSignal = await tryCall(() => cgi.GetWifiSignal(channel));
    if (wifiSignal.ok) channelDetails.wifiSignal = wifiSignal.value;

    perChannelDetails[channel] = channelDetails;
    log(
      `  Channel ${channel}: collected ${Object.keys(channelDetails).length} detail(s)`,
    );
  }

  result.perChannelDetails = perChannelDetails;
  log(
    `✓ Additional details collected for ${Object.keys(perChannelDetails).length} channel(s)`,
  );

  // Summary
  log("\n" + "=".repeat(80));
  log("NVR/HUB DIAGNOSTICS - Summary");
  log("=".repeat(80));
  log(`Total Channels: ${channels.length}`);
  log(`NVR Info: ${nvrInfo.ok ? "✓" : "✗"}`);
  log(`Devices Info: ${devicesInfo.ok ? "✓" : "✗"}`);
  log(`Events Info: ${eventsInfo.ok ? "✓" : "✗"}`);
  log(`Battery Info: ${batteryInfo.ok ? "✓" : "✗"}`);
  log(`Status Info: ${statusInfo.ok ? "✓" : "✗"}`);
  log(
    `Per-Channel Details: ✓ (${Object.keys(perChannelDetails).length} channels)`,
  );
  log("=".repeat(80));

  return result;
}

/**
 * Print NVR/HUB diagnostics in a human-readable format.
 */
export function printNvrDiagnostics(
  diagnostics: Record<string, unknown>,
  logger?: Logger,
): void {
  const log = (msg: string, data?: unknown) => {
    if (logger?.log) {
      if (data !== undefined) logger.log(msg, data);
      else logger.log(msg);
    } else {
      console.log(msg);
      if (data !== undefined) console.log(JSON.stringify(data, null, 2));
    }
  };

  log("\n" + "=".repeat(80));
  log("NVR/HUB DIAGNOSTICS REPORT");
  log("=".repeat(80));

  // NVR/HUB Info
  const nvrInfo = diagnostics.nvrInfo as
    | DiagnosticsCollectorResult<any>
    | undefined;
  if (nvrInfo?.ok) {
    log("\n📡 NVR/HUB DEVICE:");
    const devInfo = nvrInfo.value.devInfo;
    if (devInfo) {
      log(`  Model: ${devInfo.type || "N/A"}`);
      log(`  Name: ${devInfo.name || "N/A"}`);
      log(`  Firmware: ${devInfo.firmVer || "N/A"}`);
      log(`  Hardware: ${devInfo.hardVer || "N/A"}`);
      log(`  Serial: ${devInfo.serial || "N/A"}`);
      log(`  Item No: ${devInfo.exactType || devInfo.model || "N/A"}`);
    }
  }

  // Channels
  const channels = (diagnostics.channelList as number[]) || [];
  log(`\n📺 CHANNELS (${channels.length}):`);

  // Devices Info
  const devicesInfo = diagnostics.devicesInfo as
    | DiagnosticsCollectorResult<any>
    | undefined;
  if (devicesInfo?.ok) {
    for (const channel of channels) {
      const device = devicesInfo.value.devicesData?.[channel];
      if (!device) continue;

      log(
        `\n  ┌─ Channel ${channel} ────────────────────────────────────────────────────`,
      );

      const status = device.channelStatus;
      if (status) {
        log(`  │ Status:`);
        log(`  │   Online: ${status.online === 1 ? "✓" : "✗"}`);
        log(`  │   Sleeping: ${status.sleep === 1 ? "Yes" : "No"}`);
        log(`  │   UID: ${status.uid || "N/A"}`);
        log(`  │   Name: ${status.name || "N/A"}`);
      }

      const channelInfo = device.channelInfo;
      if (channelInfo) {
        log(`  │ Device Info:`);
        log(`  │   Model: ${channelInfo.typeInfo || "N/A"}`);
        log(`  │   Firmware: ${channelInfo.firmVer || "N/A"}`);
        log(`  │   Board Info: ${channelInfo.boardInfo || "N/A"}`);
      }

      const enc = device.enc;
      if (enc) {
        const encData = enc.Enc;
        log(`  │ Encoding:`);
        if (encData) {
          log(
            `  │   Main Stream: ${encData.mainStream?.vType || "N/A"} ${encData.mainStream?.vSize || ""}`,
          );
          log(
            `  │   Sub Stream: ${encData.subStream?.vType || "N/A"} ${encData.subStream?.vSize || ""}`,
          );
        }
      }

      const ai = device.ai;
      if (ai) {
        log(`  │ AI Detection:`);
        const aiKeys = Object.keys(ai).filter((k) => k !== "channel");
        if (aiKeys.length > 0) {
          for (const key of aiKeys) {
            const state = (ai as any)[key];
            if (state?.support === 1) {
              log(
                `  │   ${key}: ${state.alarm_state === 1 ? "Enabled" : "Disabled"}`,
              );
            }
          }
        } else {
          log(`  │   No AI detection available`);
        }
      }

      const abilities = device.abilities;
      if (abilities) {
        log(`  │ Capabilities:`);
        log(`  │   Battery: ${(abilities as any).battery ? "Yes" : "No"}`);
        log(`  │   PTZ: ${(abilities as any).ptz ? "Yes" : "No"}`);
        log(`  │   Floodlight: ${(abilities as any).ledCtrl ? "Yes" : "No"}`);
        log(`  │   PIR: ${(abilities as any).pirAlarm ? "Yes" : "No"}`);
      }

      // Events
      const eventsInfo = diagnostics.eventsInfo as
        | DiagnosticsCollectorResult<any>
        | undefined;
      if (eventsInfo?.ok) {
        const events = eventsInfo.value.parsed?.[channel];
        if (events) {
          log(`  │ Events:`);
          log(`  │   Motion: ${events.motion ? "Yes" : "No"}`);
          log(
            `  │   Detected Objects: ${events.objects?.join(", ") || "None"}`,
          );
        }
      }

      // Battery
      const batteryInfo = diagnostics.batteryInfo as
        | DiagnosticsCollectorResult<any>
        | undefined;
      if (batteryInfo?.ok) {
        const battery = batteryInfo.value.batteryInfoData?.[channel];
        if (battery) {
          log(`  │ Battery:`);
          log(`  │   Level: ${battery.batteryLevel}%`);
          log(`  │   Sleeping: ${battery.sleeping ? "Yes" : "No"}`);
        }
      }

      // Status
      const statusInfo = diagnostics.statusInfo as
        | DiagnosticsCollectorResult<any>
        | undefined;
      if (statusInfo?.ok) {
        const status = statusInfo.value.deviceStatusData?.[channel];
        if (status) {
          log(`  │ Status:`);
          if (status.osd) log(`  │   OSD: Configured`);
          if (status.floodlightEnabled !== undefined) {
            log(`  │   Floodlight: ${status.floodlightEnabled ? "On" : "Off"}`);
          }
          if (status.pirEnabled !== undefined) {
            log(`  │   PIR: ${status.pirEnabled ? "Enabled" : "Disabled"}`);
          }
          if (status.ptzPresets) {
            log(`  │   PTZ Presets: ${status.ptzPresets.length}`);
          }
        }
      }

      // Per-channel details
      const perChannelDetails = diagnostics.perChannelDetails as
        | Record<number, Record<string, unknown>>
        | undefined;
      if (perChannelDetails?.[channel]) {
        const details = perChannelDetails[channel];
        log(`  │ Additional Details:`);
        if (details.localLink) {
          const ll = details.localLink as any;
          log(`  │   Connection: ${ll.activeLink || "N/A"}`);
          log(
            `  │   WiFi Signal: ${ll.wifiSignal !== undefined ? `${ll.wifiSignal}/4` : "N/A"}`,
          );
        }
        if (details.siren) {
          const siren = details.siren as any;
          log(`  │   Siren: ${siren.enabled ? "Enabled" : "Disabled"}`);
        }
      }

      log(
        `  └────────────────────────────────────────────────────────────────────`,
      );
    }
  }

  log("\n" + "=".repeat(80));
}

/**
 * Test all available streams for a specific channel.
 * Tests RTSP, RTMP, and native Baichuan streams with all profiles (main, sub, ext).
 *
 * @param params - Parameters for stream testing
 * @returns Test results for all stream types and profiles
 */
export async function testChannelStreams(params: {
  api: ReolinkBaichuanApi;
  channel: number;
  logger?: Logger;
}): Promise<Record<string, unknown>> {
  const { api, channel, logger } = params;
  const log = (msg: string, data?: unknown) => {
    if (logger?.log) {
      if (data !== undefined) logger.log(msg, data);
      else logger.log(msg);
    } else {
      console.log(msg);
      if (data !== undefined) console.log(JSON.stringify(data, null, 2));
    }
  };

  const result: Record<string, unknown> = {
    kind: "channel_stream_test",
    channel,
    collectedAt: new Date().toISOString(),
    streams: {},
  };

  log("=".repeat(80));
  log(`STREAM TEST - Channel ${channel}`);
  log("=".repeat(80));

  // Get all available stream options
  log(`\n[1/3] Getting available stream options for channel ${channel}...`);

  // Get raw XML from GetEnc to inspect what streams are actually available
  const encXmlResult = await tryCall(() => api.getEncXml(channel));
  if (encXmlResult.ok) {
    // Check what stream tags are present in the XML
    const xml = encXmlResult.value;
    const tagsPresent = {
      mainStream: /<mainStream\b/.test(xml),
      subStream: /<subStream\b/.test(xml),
      extStream: /<extStream\b/.test(xml),
      thirdStream: /<thirdStream\b/.test(xml),
      externStream: /<externStream\b/.test(xml),
      extraStream: /<extraStream\b/.test(xml),
    };
    log(`  Raw GetEnc XML stream tags present: ${JSON.stringify(tagsPresent)}`);

    // Log a preview of the XML (first 2000 chars)
    const xmlPreview =
      xml.length > 2000
        ? xml.substring(0, 2000) +
          `\n... (truncated, total length: ${xml.length})`
        : xml;
    log(`  GetEnc XML preview:\n${xmlPreview}`);

    // Also get parsed metadata to see what streams were detected
    const metadataResult = await tryCall(() => api.getStreamMetadata(channel));
    if (metadataResult.ok) {
      const detectedProfiles = metadataResult.value.streams.map(
        (s) => s.profile,
      );
      log(
        `  Parsed streams from metadata: ${detectedProfiles.join(", ")} (${detectedProfiles.length} total)`,
      );
      result.rawEncXml = xml;
      result.encXmlTagsPresent = tagsPresent;
      result.parsedStreamProfiles = detectedProfiles;
    }
  }

  const streamOptionsResult = await tryCall(() =>
    api.buildVideoStreamOptions({ channel }),
  );
  if (!streamOptionsResult.ok) {
    log(`✗ Failed to get stream options: ${streamOptionsResult.error}`);
    result.error = streamOptionsResult.error;
    return result;
  }

  const { nativeStreams, rtspStreams, rtmpStreams } = streamOptionsResult.value;
  log(
    `✓ Found ${nativeStreams.length} native, ${rtspStreams.length} RTSP, ${rtmpStreams.length} RTMP stream(s)`,
  );

  // Log detailed breakdown of profiles found
  const nativeProfiles = nativeStreams.map((s) => s.profile).join(", ");
  const rtspProfiles = rtspStreams.map((s) => s.profile).join(", ");
  const rtmpProfiles = rtmpStreams.map((s) => s.profile).join(", ");
  log(`  Native profiles: [${nativeProfiles || "none"}]`);
  log(`  RTSP profiles: [${rtspProfiles || "none"}]`);
  log(`  RTMP profiles: [${rtmpProfiles || "none"}]`);

  // Test each stream type
  const streamTests: Record<string, Record<string, unknown>> = {};

  // Test RTSP streams with ffmpeg
  log(`\n[2/3] Testing RTSP streams with ffmpeg...`);
  for (const stream of rtspStreams) {
    const key = `rtsp_${stream.profile}`;
    log(`  Testing RTSP ${stream.profile}...`);

    const testResult: Record<string, unknown> = {
      available: false,
      profile: stream.profile,
      container: stream.container,
      url: stream.url,
      urlWithAuth: stream.urlWithAuth,
      metadata: stream.metadata,
    };

    // Test with ffmpeg - short session (2 seconds)
    const testUrl = stream.urlWithAuth;
    const ffmpegTest = await testStreamWithFfmpeg({
      url: testUrl,
      kind: "rtsp",
      durationSeconds: 2,
    });

    if (ffmpegTest.ok) {
      testResult.available = true;
      testResult.ffmpegSuccess = true;
      if (stream.metadata) {
        testResult.codec = stream.metadata.videoEncType;
        testResult.width = stream.metadata.width;
        testResult.height = stream.metadata.height;
        testResult.fps = stream.metadata.frameRate;
        testResult.bitRate = stream.metadata.bitRate;
        testResult.audio = stream.metadata.audio === 1;
        log(
          `    ✓ Available: ${stream.metadata.width}x${stream.metadata.height} @ ${stream.metadata.frameRate}fps, ${stream.metadata.videoEncType}`,
        );
      } else {
        log(`    ✓ Available (ffmpeg test passed)`);
      }
    } else {
      testResult.available = false;
      testResult.error = ffmpegTest.error;
      log(`    ✗ Not available: ${ffmpegTest.error}`);
    }

    streamTests[key] = testResult;
  }

  // Test RTMP streams with ffmpeg
  log(`\n[3/4] Testing RTMP streams with ffmpeg...`);
  for (const stream of rtmpStreams) {
    const key = `rtmp_${stream.profile}`;
    log(`  Testing RTMP ${stream.profile}...`);

    const testResult: Record<string, unknown> = {
      available: false,
      profile: stream.profile,
      container: stream.container,
      url: stream.url,
      urlWithAuth: stream.urlWithAuth,
      metadata: stream.metadata,
    };

    // Test with ffmpeg - short session (2 seconds)
    const testUrl = stream.urlWithAuth;
    const ffmpegTest = await testStreamWithFfmpeg({
      url: testUrl,
      kind: "rtmp",
      durationSeconds: 2,
    });

    if (ffmpegTest.ok) {
      testResult.available = true;
      testResult.ffmpegSuccess = true;
      if (stream.metadata) {
        testResult.codec = stream.metadata.videoEncType;
        testResult.width = stream.metadata.width;
        testResult.height = stream.metadata.height;
        testResult.fps = stream.metadata.frameRate;
        testResult.bitRate = stream.metadata.bitRate;
        testResult.audio = stream.metadata.audio === 1;
        log(
          `    ✓ Available: ${stream.metadata.width}x${stream.metadata.height} @ ${stream.metadata.frameRate}fps, ${stream.metadata.videoEncType}`,
        );
      } else {
        log(`    ✓ Available (ffmpeg test passed)`);
      }
    } else {
      testResult.available = false;
      testResult.error = ffmpegTest.error;
      log(`    ✗ Not available: ${ffmpegTest.error}`);
    }

    streamTests[key] = testResult;
  }

  // Test native Baichuan streams with short session
  log(`\n[4/4] Testing native Baichuan streams...`);
  for (const stream of nativeStreams) {
    const variant = (stream.nativeVariant ?? "default") as any;
    const key =
      variant === "default"
        ? `native_${stream.profile}`
        : `native_${stream.profile}_${variant}`;
    log(
      `  Testing native ${stream.profile}${variant === "default" ? "" : ` (${variant})`}...`,
    );

    const testResult: Record<string, unknown> = {
      available: false,
      profile: stream.profile,
      container: stream.container,
      metadata: stream.metadata,
    };

    // Test with short session - subscribe and wait for at least one frame
    try {
      await api.startVideoStream(
        channel,
        stream.profile,
        variant === "default" ? undefined : { variant },
      );

      // Wait for at least one video frame (max 5 seconds)
      const framePromise = new Promise<boolean>((resolve) => {
        let frameReceived = false;
        const timeout = setTimeout(() => {
          api.client.off("push", onFrame);
          resolve(frameReceived);
        }, 5000);

        const onFrame = (frame: BaichuanFrame) => {
          // Check if it's a video frame (cmd_id 3)
          if (frame?.header?.cmdId === BC_CMD_ID_VIDEO) {
            frameReceived = true;
            clearTimeout(timeout);
            api.client.off("push", onFrame);
            resolve(true);
          }
        };

        api.client.on("push", onFrame);
      });

      const frameReceived = await framePromise;

      if (frameReceived) {
        testResult.available = true;
        testResult.frameReceived = true;

        if (stream.metadata) {
          testResult.codec = stream.metadata.videoEncType;
          testResult.width = stream.metadata.width;
          testResult.height = stream.metadata.height;
          testResult.fps = stream.metadata.frameRate;
          testResult.bitRate = stream.metadata.bitRate;
          testResult.audio = stream.metadata.audio === 1;
          log(
            `    ✓ Available: ${stream.metadata.width}x${stream.metadata.height} @ ${stream.metadata.frameRate}fps, ${stream.metadata.videoEncType}`,
          );
        } else {
          log(`    ✓ Available (frame received)`);
        }
      } else {
        testResult.available = false;
        testResult.error = "Timeout waiting for video frame";
        log(`    ✗ Not available: timeout waiting for video frame`);
      }

      // Stop the stream
      await api.stopVideoStream(
        channel,
        stream.profile,
        variant === "default" ? undefined : { variant },
      );
    } catch (error) {
      testResult.available = false;
      testResult.error = safeStringifyError(error);
      log(`    ✗ Not available: ${testResult.error}`);
    }

    streamTests[key] = testResult;
  }

  result.streams = streamTests;

  // Summary
  log("\n" + "=".repeat(80));
  log("STREAM TEST SUMMARY");
  log("=".repeat(80));
  const available = Object.values(streamTests).filter(
    (s: any) => s.available === true,
  ).length;
  const total = Object.keys(streamTests).length;
  log(`Available streams: ${available}/${total}`);
  for (const [key, test] of Object.entries(streamTests)) {
    const t = test as any;
    log(
      `  ${key}: ${t.available ? "✓" : "✗"} ${t.codec || "N/A"} ${t.width || ""}x${t.height || ""}`,
    );
  }
  log("=".repeat(80));

  return result;
}

/**
 * Comprehensive diagnostics for multi-focal devices.
 * Tests all channels and all available streams for each channel.
 *
 * @param params - Parameters for multi-focal diagnostics (see inline types for property descriptions)
 * @returns Complete diagnostics for all channels and streams
 */
export async function collectMultifocalDiagnostics(params: {
  /** ReolinkBaichuanApi instance */
  api: ReolinkBaichuanApi;
  /** Optional logger for output */
  logger: Logger;
}): Promise<Record<string, unknown>> {
  const { api, logger } = params;
  const log = (msg: string, data?: unknown) => {
    if (logger?.log) {
      if (data !== undefined) logger.log(msg, data);
      else logger.log(msg);
    } else {
      console.log(msg);
      if (data !== undefined) console.log(JSON.stringify(data, null, 2));
    }
  };

  const result: Record<string, unknown> = {
    kind: "multifocal_diagnostics",
    collectedAt: new Date().toISOString(),
  };

  log("=".repeat(80));
  log("MULTI-FOCAL DEVICE DIAGNOSTICS - Starting comprehensive analysis");
  log("=".repeat(80));

  // Check if device is multi-focal
  log("\n[1/4] Checking device capabilities...");
  const capabilitiesResult = await tryCall(() => api.getDeviceCapabilities());
  if (!capabilitiesResult.ok) {
    log(`✗ Failed to get device capabilities: ${capabilitiesResult.error}`);
    result.error = capabilitiesResult.error;
    return result;
  }

  const support = capabilitiesResult.value.support;
  const channelNum = support?.channelNum ?? 1;

  log(`✓ Device channelNum: ${channelNum}`);

  if (channelNum !== 2 && channelNum !== 3) {
    log(
      `⚠ Warning: channelNum is ${channelNum}, expected 2 or 3 for multi-focal device`,
    );
    result.warning = `channelNum is ${channelNum}, expected 2 or 3`;
  }

  result.channelNum = channelNum;
  result.deviceInfo = await tryCall(() => api.getInfo());

  // Get device info
  log("\n[2/4] Getting device information...");
  const deviceInfoResult = await tryCall(() => api.getInfo());
  if (deviceInfoResult.ok) {
    log(`✓ Device: ${deviceInfoResult.value.type || "N/A"}`);
    result.deviceInfo = deviceInfoResult.value;
  }

  // Test all channels
  log(`\n[3/4] Testing all ${channelNum} channel(s)...`);
  const channelResults: Record<number, Record<string, unknown>> = {};

  for (let ch = 0; ch < channelNum; ch++) {
    log(`\n--- Channel ${ch} ---`);
    const channelTest = await testChannelStreams({
      api,
      channel: ch,
      logger,
    });
    channelResults[ch] = channelTest;
  }

  result.channels = channelResults;

  // Summary
  log("\n" + "=".repeat(80));
  log("MULTI-FOCAL DIAGNOSTICS SUMMARY");
  log("=".repeat(80));
  log(`Total Channels: ${channelNum}`);
  for (let ch = 0; ch < channelNum; ch++) {
    const channelData = channelResults[ch];
    if (channelData?.streams) {
      const streams = channelData.streams as Record<string, any>;
      const available = Object.values(streams).filter(
        (s: any) => s.available === true,
      ).length;
      const total = Object.keys(streams).length;
      log(`  Channel ${ch}: ${available}/${total} streams available`);
    }
  }
  log("=".repeat(80));

  return result;
}

export interface RunMultifocalDiagnosticsConsecutivelyParams {
  api: ReolinkBaichuanApi;
  /** Base output directory. A timestamped subfolder will be created for each run. */
  outDir: string;
  host: string;
  username: string;
  password: string;
  /** NVR/HUB channel (0-based). */
  channel: number;
  /** Clip length to record per OK stream. */
  durationSeconds: number;
  /** Which RTMP apps to probe. Default: ["bcs","live","vod"]. */
  rtmpApps?: Array<"bcs" | "live" | "vod">;
  /** If true, probes a wider set of RTSP/RTMP candidates (may take longer). Default: false */
  probeFull?: boolean;
  /** Treat the target as NVR/Hub channel mapping (0-based). Default: true */
  onNvr?: boolean;
  /**
   * Maximum number of standalone channels to probe (0..N-1). Useful for
   * uncatalogued multi-imager cameras (e.g. OMVI-style triple-lens devices)
   * where the firmware advertises a single channel but actually responds to
   * stream subscriptions on extra channelIds. Default 2 (TrackMix shape);
   * `probeFull` raises the default to 4 so the standard "deep" diagnostic
   * sweep catches any extra imager without the caller having to opt in by
   * hand.
   */
  maxStandaloneChannels?: number;
  logger?: Logger;
}

export async function runMultifocalDiagnosticsConsecutively(
  params: RunMultifocalDiagnosticsConsecutivelyParams,
): Promise<{ runDir: string; resultsPath: string; streamsDir: string }> {
  const logger = params.logger;
  const log = (
    level: "log" | "warn" | "error",
    msg: string,
    extra?: unknown,
  ) => {
    const fn = (logger?.[level] ?? logger?.log) as
      | ((...args: any[]) => void)
      | undefined;
    if (fn) {
      if (extra !== undefined) fn.call(logger, msg, extra);
      else fn.call(logger, msg);
      return;
    }

    // Fallback for non-logger callers.
    // Keep output minimal but informative.
    if (extra !== undefined) console.log(msg, extra);
    else console.log(msg);
  };

  // NOTE: user requested diagnostics to be written directly in the provided root folder.
  // We still keep `streams/` and `logs/` subfolders inside that root.
  const runDir = params.outDir;
  const streamsDir = join(runDir, "streams");
  const logsDir = join(runDir, "logs");
  mkdirp(runDir);
  mkdirp(streamsDir);
  mkdirp(logsDir);

  const redact = (s: string) =>
    s
      .replaceAll(encodeURIComponent(params.password), "***")
      .replaceAll(params.password, "***");

  log("log", "[MultifocalDiagnostics] starting run", {
    outDir: params.outDir,
    runDir,
    host: params.host,
    channel: params.channel,
    durationSeconds: params.durationSeconds,
    rtmpApps: params.rtmpApps ?? ["bcs", "live", "vod"],
    probeFull: params.probeFull === true,
    onNvr: params.onNvr !== false,
  });

  const results: any = {
    kind: "multifocal_diagnostics_run",
    collectedAt: new Date().toISOString(),
    host: params.host,
    channel: params.channel,
    durationSeconds: params.durationSeconds,
    ok: [] as any[],
    failed: [] as any[],
  };

  const channelStr2 = String(params.channel + 1).padStart(2, "0");
  const userEnc = encodeURIComponent(params.username);
  const passEnc = encodeURIComponent(params.password);

  const rtspCandidates = (() => {
    const base = [
      `/Preview_${channelStr2}_main`,
      `/Preview_${channelStr2}_sub`,
      `/Preview_${channelStr2}_autotrack`,
      `/h264Preview_${channelStr2}_main`,
      `/h264Preview_${channelStr2}_sub`,
      `/h264Preview_${channelStr2}_autotrack`,
      `/h265Preview_${channelStr2}_main`,
      `/h265Preview_${channelStr2}_sub`,
      `/h265Preview_${channelStr2}_autotrack`,
    ];

    if (params.probeFull) {
      base.unshift(
        `/rtsp/Preview_${channelStr2}_main`,
        `/rtsp/Preview_${channelStr2}_sub`,
        `/rtsp/Preview_${channelStr2}_mobile`,
        `/rtsp/Preview_${channelStr2}_autotrack`,
      );
      base.push(
        `/Preview_${channelStr2}_mobile`,
        `/Preview_${channelStr2}_autotrack_main`,
        `/Preview_${channelStr2}_autotrack_sub`,
      );
    }

    return [...new Set(base)];
  })();

  const rtmpApps = params.rtmpApps ?? ["bcs", "live", "vod"];
  const rtmpCandidates = (() => {
    const minimalStreams = ["sub", "mobile", "autotrack_sub", "telephoto_sub"];
    const fullStreams = [
      "main",
      "sub",
      "mobile",
      "autotrack",
      "autotrack_main",
      "autotrack_sub",
      "telephoto_main",
      "telephoto_sub",
    ];
    const streams = params.probeFull ? fullStreams : minimalStreams;
    const out: Array<{ app: string; streamName: string; url: string }> = [];
    for (const app of rtmpApps) {
      for (const streamName of streams) {
        const streamType =
          streamName.includes("sub") ||
          streamName === "sub" ||
          streamName === "mobile"
            ? 1
            : 0;
        const path = `/${app}/channel${params.channel}_${streamName}.bcs`;
        const u = new URL(`rtmp://${params.host}:1935${path}`);
        u.searchParams.set("channel", params.channel.toString());
        u.searchParams.set("stream", streamType.toString());
        u.searchParams.set("user", params.username);
        u.searchParams.set("password", params.password);
        out.push({ app, streamName, url: u.toString() });
      }
    }
    return out;
  })();

  const okLine = (entry: any) => {
    const wh =
      entry.width && entry.height ? `${entry.width}x${entry.height}` : "?";
    const codec = entry.codec ?? entry.codecName ?? "";
    return `${entry.kind} ${entry.id} ${wh} ${codec}`.trim();
  };

  log("log", "[MultifocalDiagnostics] probing RTSP", {
    candidates: rtspCandidates.length,
  });
  for (const pathCandidate of rtspCandidates) {
    const urlWithAuth = `rtsp://${userEnc}:${passEnc}@${params.host}:554${pathCandidate}`;
    const id = `rtsp:${pathCandidate}`;
    const baseName = `${nowIsoCompact()}_${id}`.replace(
      /[^a-zA-Z0-9._-]+/g,
      "_",
    );
    const outPath = join(streamsDir, `${baseName}.mkv`);
    const probeLog = join(logsDir, `${baseName}.ffprobe.log`);
    const recLog = join(logsDir, `${baseName}.ffmpeg.log`);

    const probe = await probeVideoInfo({
      url: urlWithAuth,
      kind: "rtsp",
      logPath: probeLog,
    });
    if (!probe.ok) {
      results.failed.push({
        kind: "rtsp",
        id,
        url: redact(urlWithAuth),
        error: probe.error,
      });
      continue;
    }

    const rec = await recordRtspOrRtmpToFile({
      kind: "rtsp",
      url: urlWithAuth,
      outputPath: outPath,
      durationSeconds: params.durationSeconds,
      logPath: recLog,
    });
    if (!rec.ok) {
      results.failed.push({
        kind: "rtsp",
        id,
        url: redact(urlWithAuth),
        error: rec.error,
      });
      continue;
    }

    const entry = {
      kind: "rtsp",
      id: pathCandidate,
      url: redact(urlWithAuth),
      clipPath: outPath,
      ...probe.info,
    };
    results.ok.push(entry);
    log("log", "[MultifocalDiagnostics] clip saved", {
      kind: "rtsp",
      id: pathCandidate,
      clipPath: outPath,
      width: probe.info.width,
      height: probe.info.height,
      codec: probe.info.codecName,
    });
    log("log", `[MultifocalDiagnostics] OK ${okLine(entry)}`);
  }

  log("log", "[MultifocalDiagnostics] probing RTMP", {
    candidates: rtmpCandidates.length,
  });
  for (const cand of rtmpCandidates) {
    const id = `rtmp:${cand.app}:${cand.streamName}`;
    const baseName = `${nowIsoCompact()}_${id}`.replace(
      /[^a-zA-Z0-9._-]+/g,
      "_",
    );
    const outPath = join(streamsDir, `${baseName}.mkv`);
    const probeLog = join(logsDir, `${baseName}.ffprobe.log`);
    const recLog = join(logsDir, `${baseName}.ffmpeg.log`);

    const probe = await probeVideoInfo({
      url: cand.url,
      kind: "rtmp",
      logPath: probeLog,
    });
    if (!probe.ok) {
      results.failed.push({
        kind: "rtmp",
        id,
        url: redact(cand.url),
        error: probe.error,
      });
      continue;
    }

    const rec = await recordRtspOrRtmpToFile({
      kind: "rtmp",
      url: cand.url,
      outputPath: outPath,
      durationSeconds: params.durationSeconds,
      logPath: recLog,
    });
    if (!rec.ok) {
      results.failed.push({
        kind: "rtmp",
        id,
        url: redact(cand.url),
        error: rec.error,
      });
      continue;
    }

    const entry = {
      kind: "rtmp",
      id,
      url: redact(cand.url),
      clipPath: outPath,
      app: cand.app,
      streamName: cand.streamName,
      ...probe.info,
    };
    results.ok.push(entry);
    log("log", "[MultifocalDiagnostics] clip saved", {
      kind: "rtmp",
      id,
      clipPath: outPath,
      width: probe.info.width,
      height: probe.info.height,
      codec: probe.info.codecName,
    });
    log("log", `[MultifocalDiagnostics] OK ${okLine(entry)}`);
  }

  // Native probing: do NOT rely solely on buildVideoStreamOptions.
  // Probe a matrix of (mode nvr/standalone, channel, profile, variant) and save rich artifacts.
  log("log", "[MultifocalDiagnostics] probing native streams", {
    channel: params.channel,
    onNvr: params.onNvr !== false,
    probeFull: params.probeFull === true,
  });

  // Keep buildVideoStreamOptions output for reference (debugging what the API thinks).
  results.nativeStreamOptions = await tryCall(() =>
    params.api.buildVideoStreamOptions({
      channel: params.channel,
      onNvr: params.onNvr !== false,
    }),
  );

  // Decide how many standalone channels to probe. Default 2 (the historical
  // TrackMix/Duo shape) so existing callers see no behaviour change; bump
  // to 4 in probeFull mode so the "deep" diagnostic catches a third or
  // fourth imager on uncatalogued cameras without an explicit opt-in.
  const maxStandaloneChannels = Math.max(
    1,
    params.maxStandaloneChannels ?? (params.probeFull ? 4 : 2),
  );

  // Per-channel capability pre-probe. For each candidate channel in
  // standalone mode, ask the camera the three "what do you describe for
  // this channel?" metadata calls. This is the cleanest evidence to tell
  // apart a real second imager (each channel describes its own Compression
  // XML / Support block) from a channelId that just echoes another. The
  // entries land under `channelProbe[ch]` in the results JSON so anyone
  // reading the dump can diff channels at a glance — without having to
  // open the Annex-B clips.
  const candidateChannels: number[] = [];
  for (let i = 0; i < maxStandaloneChannels; i++) candidateChannels.push(i);
  if (
    Number.isFinite(params.channel) &&
    params.channel >= 0 &&
    !candidateChannels.includes(params.channel)
  ) {
    candidateChannels.push(params.channel);
  }
  results.channelProbe = {} as Record<string, unknown>;
  for (const ch of candidateChannels) {
    const probe: Record<string, unknown> = { channel: ch };
    probe.getDeviceCapabilities = await tryCall(() =>
      params.api.getDeviceCapabilities(ch),
    );
    probe.getEncXml = await tryCall(() => params.api.getEncXml(ch));
    probe.getStreamMetadata = await tryCall(() =>
      params.api.getStreamMetadata(ch),
    );
    // Heuristic: a channel is "described" by the firmware if at least one
    // of the three calls returned a non-null OK payload. Useful summary
    // when channelN responds to stream subscriptions but the camera's
    // metadata layer claims it doesn't exist (e.g. echo channels).
    const described =
      ((probe.getDeviceCapabilities as { ok?: boolean })?.ok ?? false) ||
      ((probe.getEncXml as { ok?: boolean })?.ok ?? false) ||
      ((probe.getStreamMetadata as { ok?: boolean })?.ok ?? false);
    probe.describedByMetadata = described;
    (results.channelProbe as Record<string, unknown>)[String(ch)] = probe;
  }

  const nativeModes: Array<"nvr" | "standalone"> =
    params.onNvr === false && !params.probeFull
      ? ["standalone"]
      : ["nvr", "standalone"];

  const uniqNums = (arr: number[]) =>
    [...new Set(arr)].filter((n) => Number.isFinite(n) && n >= 0);
  const channelsForMode = (mode: "nvr" | "standalone"): number[] => {
    if (mode === "nvr") return [params.channel];
    const range: number[] = [];
    for (let i = 0; i < maxStandaloneChannels; i++) range.push(i);
    return uniqNums([...range, params.channel]);
  };

  const nativeProfiles: StreamProfile[] = params.probeFull
    ? ["main", "sub", "ext"]
    : ["main", "sub"];
  const nativeVariants: NativeVideoStreamVariant[] = params.probeFull
    ? ["default", "autotrack", "telephoto"]
    : ["default"];

  const expectedStreamTypesFor = (
    profile: StreamProfile,
    variant: NativeVideoStreamVariant,
  ): Set<number> => {
    if (profile === "sub") {
      return new Set([variant === "default" ? 1 : 3]);
    }
    if (profile === "main") {
      return new Set([variant === "default" ? 0 : 2]);
    }
    // ext
    return new Set([0]);
  };

  for (const mode of nativeModes) {
    for (const chNative of channelsForMode(mode)) {
      for (const profile of nativeProfiles) {
        for (const variant of nativeVariants) {
          if (profile === "ext" && variant !== "default") {
            results.failed.push({
              kind: "native",
              id: `native:${mode}:ch${chNative}:${profile}:${variant}`,
              error: "invalid (ext does not support variant)",
            });
            continue;
          }

          const id = `native:${mode}:ch${chNative}:${profile}:${variant}`;
          const baseName = `${nowIsoCompact()}_${id}`.replace(
            /[^a-zA-Z0-9._-]+/g,
            "_",
          );
          const baseDir = join(
            streamsDir,
            "native",
            mode,
            `ch${chNative}`,
            profile,
            variant,
          );
          const rawDir = join(baseDir, "raw_frames");
          const snapsDir = join(baseDir, "snapshots");
          const logsBase = join(logsDir, baseName);
          mkdirp(rawDir);
          mkdirp(snapsDir);

          const eventsPath = join(baseDir, "events.ndjson");
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_begin",
            id,
            mode,
            channel: chNative,
            profile,
            variant,
          });
          log("log", "[MultifocalDiagnostics] native begin", { id });

          const expectedStreamTypes = expectedStreamTypesFor(profile, variant);
          const maxRawFrames = 400;
          const maxRawBytes = 50 * 1024 * 1024;
          let rawFrames = 0;
          let rawBytes = 0;
          let lockedChannelId: number | undefined;
          let lockedMsgNum: number | undefined;
          // Fingerprint of the FIRST keyframe of this (mode, ch, profile,
          // variant) tuple — SHA-256 over the keyframe Annex-B bytes plus
          // length. Cheap to compute, very effective at telling apart
          // "channelN is a real second imager" (distinct fingerprints) from
          // "channelN echoes channel0" (identical fingerprints). Surfaced
          // in the per-clip JSON and rolled up into the run's summary.
          let firstKeyframeSha: string | undefined;
          let firstKeyframeBytes: number | undefined;

          const onPush = (frame: BaichuanFrame) => {
            if (!frame?.header) return;
            if (frame.header.cmdId !== 3) return;
            if (!expectedStreamTypes.has(frame.header.streamType)) return;

            // Lock to first observed channelId/msgNum for this combination.
            if (lockedChannelId === undefined)
              lockedChannelId = frame.header.channelId;
            if (lockedMsgNum === undefined) lockedMsgNum = frame.header.msgNum;
            if (frame.header.channelId !== lockedChannelId) return;
            if (frame.header.msgNum !== lockedMsgNum) return;

            if (rawFrames >= maxRawFrames) return;
            const payload: Buffer =
              Buffer.isBuffer(frame.payload) && frame.payload.length
                ? frame.payload
                : frame.body;
            if (!Buffer.isBuffer(payload) || payload.length === 0) return;
            if (rawBytes + payload.length > maxRawBytes) return;

            rawFrames++;
            rawBytes += payload.length;
            const idx = String(rawFrames).padStart(6, "0");
            const binPath = join(rawDir, `frame_${idx}.bin`);
            try {
              fs.writeFileSync(binPath, payload);
            } catch {
              // ignore
            }

            if (rawFrames === 1) {
              try {
                writeJson(
                  join(baseDir, "first_frame_header.json"),
                  frame.header,
                );
              } catch {
                // ignore
              }
            }

            appendNdjson(eventsPath, {
              t: Date.now(),
              type: "native_raw_frame",
              id,
              bytes: payload.length,
              header: frame.header,
              bodyLen: frame.body?.length ?? 0,
              payloadLen: frame.payload?.length ?? 0,
            });
          };

          const clipBase = join(baseDir, `clip_${nowIsoCompact()}`);
          const clipAnnexBPath = clipBase + ".annexb";
          const clipAudioPath = clipBase + ".audio.bin";
          const clipInfoPath = clipBase + ".json";
          const ffmpegMuxLog = logsBase + ".ffmpeg_mux.log";

          const videoOut = fs.createWriteStream(clipAnnexBPath, { flags: "w" });
          const audioOut = fs.createWriteStream(clipAudioPath, { flags: "w" });

          let firstVideoType: "H264" | "H265" | undefined;
          let firstKeyframeAtMs: number | null = null;
          let startedAtMs: number | null = null;
          let videoAUs = 0;
          let audioFrames = 0;
          let lastSnapshotAtMs = 0;

          const client: any = params.api.client as any;

          const videoStream = new BaichuanVideoStream({
            client,
            // Intentionally omit `api`: we will manually issue start/stop VIDEO requests
            // to probe different streamType + Preview XML combinations.
            channel: chNative,
            profile,
            ...(variant !== "default" ? { variant } : {}),
            ...(logger ? { logger } : {}),
          } as any);

          const onAU = (u: any) => {
            if (!u || !Buffer.isBuffer(u.data)) return;
            if (!firstVideoType) firstVideoType = u.videoType;
            videoAUs++;
            try {
              videoOut.write(u.data);
            } catch {
              // ignore
            }

            if (u.isKeyframe && firstKeyframeAtMs == null)
              firstKeyframeAtMs = Date.now();
            if (u.isKeyframe && firstKeyframeSha === undefined) {
              firstKeyframeBytes = u.data.length;
              firstKeyframeSha = createHash("sha256")
                .update(u.data)
                .digest("hex");
            }

            const nalTypes = nalTypesSummary(u.videoType, u.data);
            appendNdjson(eventsPath, {
              t: Date.now(),
              type: "native_access_unit",
              id,
              isKeyframe: !!u.isKeyframe,
              videoType: u.videoType,
              microseconds: u.microseconds,
              bytes: u.data.length,
              nalTypes,
            });

            const now = Date.now();
            if (u.isKeyframe && now - lastSnapshotAtMs >= 2_000) {
              lastSnapshotAtMs = now;
              const snapId = nowIsoCompact();
              const snapAnnex = join(
                snapsDir,
                `snap_${snapId}.${u.videoType === "H265" ? "h265" : "h264"}`,
              );
              try {
                fs.writeFileSync(snapAnnex, u.data);
                appendNdjson(eventsPath, {
                  t: Date.now(),
                  type: "native_snapshot_saved",
                  id,
                  path: snapAnnex,
                });
                const snapJpeg = join(snapsDir, `snap_${snapId}.jpg`);
                void tryJpegFromAnnexB({
                  videoType: u.videoType,
                  snapshotAnnexBPath: snapAnnex,
                  outputJpegPath: snapJpeg,
                  logPath: join(baseDir, "ffmpeg_snapshot.log"),
                });
              } catch {
                // ignore
              }
            }
          };

          const onAudio = (buf: Buffer) => {
            if (!Buffer.isBuffer(buf) || buf.length === 0) return;
            audioFrames++;
            try {
              audioOut.write(buf);
            } catch {
              // ignore
            }
            appendNdjson(eventsPath, {
              t: Date.now(),
              type: "native_audio",
              id,
              bytes: buf.length,
            });
          };

          videoStream.on("videoAccessUnit" as any, onAU as any);
          videoStream.on("audioFrame" as any, onAudio as any);
          videoStream.on("error", (e: any) => {
            appendNdjson(eventsPath, {
              t: Date.now(),
              type: "native_error",
              id,
              error: safeStringifyError(e),
            });
            log("warn", "[MultifocalDiagnostics] native stream error", {
              id,
              error: safeStringifyError(e),
            });
          });

          const uniq = <T>(arr: T[]) => [...new Set(arr)];

          const baseStreamName =
            profile === "main"
              ? "mainStream"
              : profile === "sub"
                ? "subStream"
                : "externStream";
          const headerStreamTypeCandidates =
            profile === "sub" ? [1, 3] : profile === "main" ? [0, 2] : [0];

          // Candidate channelId tags (some firmwares use 0-based, others 1-based).
          const channelIdTagCandidates = uniq(
            [chNative, chNative + 1].filter(
              (n) => Number.isFinite(n) && n >= 0,
            ),
          );

          const messageClassCandidates = params.probeFull
            ? [BC_CLASS_MODERN_24, BC_CLASS_MODERN_24_ALT]
            : [BC_CLASS_MODERN_24];
          const extensionXmlCandidates = params.probeFull
            ? ["", buildChannelExtensionXml(chNative)]
            : [buildChannelExtensionXml(chNative)];

          type NativeStartAttempt = {
            attemptId: string;
            messageClass: number;
            streamTypeHeader: number;
            payloadXml: string;
            payloadVersion: "v10" | "v11";
            channelIdTag: number | undefined;
            handle: number;
            previewStreamType: string;
            extensionXml: string;
          };

          const attempts: NativeStartAttempt[] = [];

          for (const messageClass of messageClassCandidates) {
            for (const streamTypeHeader of headerStreamTypeCandidates) {
              for (const extensionXml of extensionXmlCandidates) {
                // Preview v1.0: try both with and without channelId.
                const v10ChannelIdTags = params.probeFull
                  ? [undefined, ...channelIdTagCandidates]
                  : [undefined, chNative];
                for (const channelIdTag of uniq(v10ChannelIdTags)) {
                  const handle =
                    profile === "main" ? 0 : profile === "sub" ? 256 : 1024;
                  attempts.push({
                    attemptId: `v10:${baseStreamName}:h${handle}:cid${channelIdTag ?? "none"}:st${streamTypeHeader}:ext${extensionXml ? "1" : "0"}:mc${messageClass}`,
                    messageClass,
                    streamTypeHeader,
                    payloadXml: buildPreviewXml(
                      handle,
                      baseStreamName,
                      channelIdTag,
                    ),
                    payloadVersion: "v10",
                    channelIdTag,
                    handle,
                    previewStreamType: baseStreamName,
                    extensionXml,
                  });
                }

                // Preview v1.1: always includes channelId; also try tele PCAP variants.
                for (const channelIdTag of channelIdTagCandidates) {
                  const handle =
                    profile === "main" ? 0 : profile === "sub" ? 256 : 1024;
                  attempts.push({
                    attemptId: `v11:${baseStreamName}:h${handle}:cid${channelIdTag}:st${streamTypeHeader}:ext${extensionXml ? "1" : "0"}:mc${messageClass}`,
                    messageClass,
                    streamTypeHeader,
                    payloadXml: buildPreviewXmlV11({
                      channelId: channelIdTag,
                      handle,
                      streamType: baseStreamName,
                    }),
                    payloadVersion: "v11",
                    channelIdTag,
                    handle,
                    previewStreamType: baseStreamName,
                    extensionXml,
                  });

                  if (variant === "telephoto") {
                    const telePreviewStreamType =
                      profile === "main"
                        ? "externStream"
                        : profile === "sub"
                          ? "mobileStream"
                          : undefined;
                    const teleHandleBase =
                      profile === "main"
                        ? 1024
                        : profile === "sub"
                          ? 512
                          : undefined;
                    if (telePreviewStreamType && teleHandleBase !== undefined) {
                      const teleHandle = teleHandleBase + channelIdTag;
                      // Empirically: Hub tele often requires header streamType=0.
                      attempts.push({
                        attemptId: `v11tele:${telePreviewStreamType}:h${teleHandle}:cid${channelIdTag}:st0:ext${extensionXml ? "1" : "0"}:mc${messageClass}`,
                        messageClass,
                        streamTypeHeader: 0,
                        payloadXml: buildPreviewXmlV11({
                          channelId: channelIdTag,
                          handle: teleHandle,
                          streamType: telePreviewStreamType,
                        }),
                        payloadVersion: "v11",
                        channelIdTag,
                        handle: teleHandle,
                        previewStreamType: telePreviewStreamType,
                        extensionXml,
                      });
                    }
                  }
                }
              }
            }
          }

          // Capture raw frames (cmd_id=3) concurrently.
          client.on("push", onPush);

          let lastAttemptOk: NativeStartAttempt | undefined;
          let lastStartMsgNum: number | undefined;

          try {
            for (const attempt of attempts) {
              appendNdjson(eventsPath, {
                t: Date.now(),
                type: "native_attempt_begin",
                id,
                attemptId: attempt.attemptId,
              });
              videoAUs = 0;
              audioFrames = 0;
              firstVideoType = undefined;
              firstKeyframeAtMs = null;
              startedAtMs = null;
              lockedChannelId = undefined;
              lockedMsgNum = undefined;
              rawFrames = 0;
              rawBytes = 0;

              const msgNum = client.reserveNextMsgNum();
              lastStartMsgNum = msgNum;
              try {
                client.subscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
              } catch {
                // ignore
              }

              // Force msgNum filtering in BaichuanVideoStream.
              try {
                (videoStream as any).activeMsgNum = msgNum;
              } catch {
                // ignore
              }

              try {
                await videoStream.start();
                const resp = await client.sendFrame({
                  cmdId: BC_CMD_ID_VIDEO,
                  channel: chNative,
                  channelIdOverride: chNative,
                  msgNumOverride: msgNum,
                  extensionXml: attempt.extensionXml,
                  payloadXml: attempt.payloadXml,
                  messageClass: attempt.messageClass,
                  streamType: attempt.streamTypeHeader,
                  timeoutMs: 20_000,
                });

                if (resp?.header?.responseCode !== 200) {
                  throw new Error(
                    `response_code ${resp?.header?.responseCode}`,
                  );
                }

                startedAtMs = Date.now();
                while (
                  Date.now() - startedAtMs <
                  Math.max(250, Math.round(params.durationSeconds * 1000))
                ) {
                  await sleepMs(200);
                }

                // Consider it OK only if we got at least some media.
                if (videoAUs > 0) {
                  lastAttemptOk = attempt;
                  appendNdjson(eventsPath, {
                    t: Date.now(),
                    type: "native_attempt_ok",
                    id,
                    attemptId: attempt.attemptId,
                    msgNum,
                  });
                  break;
                }
                appendNdjson(eventsPath, {
                  t: Date.now(),
                  type: "native_attempt_no_media",
                  id,
                  attemptId: attempt.attemptId,
                  msgNum,
                });
              } catch (e) {
                appendNdjson(eventsPath, {
                  t: Date.now(),
                  type: "native_attempt_failed",
                  id,
                  attemptId: attempt.attemptId,
                  error: safeStringifyError(e),
                });
              } finally {
                try {
                  // Best-effort stop: some firmwares keep streaming unless a stop is sent.
                  const stopXml =
                    attempt.payloadVersion === "v11" &&
                    attempt.channelIdTag !== undefined
                      ? buildPreviewStopXmlV11({
                          channelId: attempt.channelIdTag,
                          handle: attempt.handle,
                        })
                      : buildPreviewStopXml(
                          attempt.handle,
                          attempt.channelIdTag,
                        );
                  await client.sendFrame({
                    cmdId: BC_CMD_ID_VIDEO,
                    channel: chNative,
                    channelIdOverride: chNative,
                    msgNumOverride: msgNum,
                    extensionXml: attempt.extensionXml,
                    payloadXml: stopXml,
                    messageClass: attempt.messageClass,
                    streamType: attempt.streamTypeHeader,
                    timeoutMs: 5_000,
                  });
                } catch {
                  // ignore
                }
                try {
                  client.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
                } catch {
                  // ignore
                }
                try {
                  await videoStream.stop();
                } catch {
                  // ignore
                }
              }
            }

            if (!lastAttemptOk) {
              throw new Error("no working native start attempt produced media");
            }
          } catch (e) {
            results.failed.push({
              kind: "native",
              id,
              error: safeStringifyError(e),
            });
            appendNdjson(eventsPath, {
              t: Date.now(),
              type: "native_failed",
              id,
              error: safeStringifyError(e),
            });
            continue;
          } finally {
            client.removeListener("push", onPush);
            try {
              videoOut.end();
            } catch {
              // ignore
            }
            try {
              audioOut.end();
            } catch {
              // ignore
            }
          }

          const mkvPath = clipBase + ".mkv";
          if (firstVideoType) {
            const fmt = firstVideoType === "H265" ? "hevc" : "h264";
            const muxArgs = [
              "-hide_banner",
              "-loglevel",
              "warning",
              "-stats",
              "-f",
              fmt,
              "-i",
              clipAnnexBPath,
              "-c",
              "copy",
              "-y",
              mkvPath,
            ];
            const muxRes = await spawnFfmpeg(muxArgs, ffmpegMuxLog);
            appendNdjson(eventsPath, {
              t: Date.now(),
              type: "native_mux",
              id,
              ok: muxRes.ok,
            });
          }

          const info: any = {
            kind: "native",
            id,
            mode,
            channel: chNative,
            profile,
            variant,
            durationSeconds: params.durationSeconds,
            nativeAttempt: lastAttemptOk,
            nativeMsgNum: lastStartMsgNum,
            videoAccessUnits: videoAUs,
            audioFrames,
            videoType: firstVideoType,
            firstKeyframeLatencyMs:
              firstKeyframeAtMs == null || startedAtMs == null
                ? null
                : Math.max(0, firstKeyframeAtMs - startedAtMs),
            rawFrames,
            rawBytes,
            lockedChannelId,
            lockedMsgNum,
            firstKeyframeSha: firstKeyframeSha ?? null,
            firstKeyframeBytes: firstKeyframeBytes ?? null,
            annexbPath: clipAnnexBPath,
            audioPath: clipAudioPath,
            mkvPath: fs.existsSync(mkvPath) ? mkvPath : undefined,
          };

          // Derive resolution/codec from the saved MKV if available.
          if (info.mkvPath) {
            const p = await spawnFfprobeJson(
              [
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_streams",
                "-select_streams",
                "v:0",
                info.mkvPath,
              ],
              logsBase + ".ffprobe_file.log",
            );
            if (p.ok) {
              const streams = Array.isArray(p.json?.streams)
                ? p.json.streams
                : [];
              const s0 = streams[0] ?? undefined;
              info.width = typeof s0?.width === "number" ? s0.width : undefined;
              info.height =
                typeof s0?.height === "number" ? s0.height : undefined;
              info.codecName =
                typeof s0?.codec_name === "string" ? s0.codec_name : undefined;
            }
          }

          writeJson(clipInfoPath, info);
          appendNdjson(eventsPath, {
            t: Date.now(),
            type: "native_done",
            ...info,
          });

          const entry = {
            kind: "native",
            id,
            clipPath: info.mkvPath ?? clipAnnexBPath,
            width: info.width,
            height: info.height,
            codec:
              info.codecName ??
              (firstVideoType === "H265"
                ? "hevc"
                : firstVideoType === "H264"
                  ? "h264"
                  : undefined),
            profile,
            nativeVariant: variant,
            mode,
            channel: chNative,
          };
          results.ok.push(entry);
          log("log", "[MultifocalDiagnostics] clip saved", {
            kind: "native",
            id,
            clipPath: entry.clipPath,
            width: entry.width,
            height: entry.height,
            codec: entry.codec,
            rawFrames,
            rawBytes,
            videoAccessUnits: videoAUs,
          });
          log("log", `[MultifocalDiagnostics] OK ${okLine(entry)}`);
        }
      }
    }
  }

  const okIds = (results.ok as any[]).map((x) => ({
    kind: x.kind,
    id: x.id,
    clipPath: x.clipPath,
    width: x.width,
    height: x.height,
  }));

  // Per-(mode, profile, variant) channel comparison summary. Groups the
  // native OK entries by their first-keyframe SHA-256 so a reader can tell
  // at a glance whether channel N is a real distinct imager (different
  // sha) or an echo of channel 0 (identical sha). Indispensable on
  // uncatalogued multi-imager cameras (OMVI-class triple-lens devices)
  // where the firmware advertises one channel but responds on several.
  type ChannelGroup = {
    mode: string;
    profile: string;
    variant: string;
    fingerprints: Record<string, number[]>; // sha → channels
  };
  const groups = new Map<string, ChannelGroup>();
  for (const x of results.ok as any[]) {
    if (x.kind !== "native") continue;
    const sha: string | null = x.firstKeyframeSha ?? null;
    if (!sha) continue;
    const key = `${x.mode}::${x.profile}::${x.variant}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        mode: x.mode,
        profile: x.profile,
        variant: x.variant,
        fingerprints: {},
      };
      groups.set(key, g);
    }
    const bucket = g.fingerprints[sha] ?? [];
    bucket.push(x.channel);
    g.fingerprints[sha] = bucket;
  }
  results.channelComparison = Array.from(groups.values()).map((g) => {
    const buckets = Object.entries(g.fingerprints).map(([sha, channels]) => ({
      sha,
      channels: [...channels].sort((a, b) => a - b),
    }));
    return {
      mode: g.mode,
      profile: g.profile,
      variant: g.variant,
      distinct: buckets.length > 1,
      buckets,
    };
  });

  log("log", "[MultifocalDiagnostics] summary", {
    ok: results.ok.length,
    failed: results.failed.length,
    streamsDir,
    channelProbeChannels: Object.keys(results.channelProbe ?? {}),
    channelComparison: results.channelComparison,
    okStreams: okIds,
  });
  const resultsPath = join(runDir, "multifocal_diagnostics.json");
  writeJson(resultsPath, results);
  return { runDir, resultsPath, streamsDir };
}

/**
 * Parameters for running all diagnostics consecutively.
 */
export interface RunAllDiagnosticsConsecutivelyParams {
  /** ReolinkBaichuanApi instance */
  api: ReolinkBaichuanApi;
  /** Base output directory. A timestamped subfolder will be created for each run. */
  outDir: string;
  channel?: number;
  /** Stream sampling duration. */
  durationSeconds: number;
  /** Snapshot interval used for RTSP/RTMP snapshots. Default: 2 seconds. */
  snapshotIntervalSeconds?: number;
  /** Which kinds/profiles to sample. */
  selection: StreamSamplingSelection;

  /** Enable CGI diagnostics. `true` uses the same host/creds as the Baichuan client. */
  cgi?: boolean | Partial<ReolinkHttpClientOptions>;
  /** Enable RTSP sampling. `true` uses the same host/creds as the Baichuan client. */
  rtsp?: boolean | Partial<NonNullable<StreamSamplingOptions["rtsp"]>>;
  /** Optional RTMP URLs for each profile. */
  rtmp?: StreamSamplingOptions["rtmp"];
  /** Optional dump limits (native raw frames). */
  limits?: StreamSamplingOptions["limits"];

  /** Extra user-provided metadata written into diagnostics.json */
  extra?: Record<string, unknown>;
  /** Logger for progress messages */
  logger?: Logger;
  /** Host for CGI/RTSP (if not provided in cgi/rtsp options) */
  host: string;
  /** Username for CGI/RTSP (if not provided in cgi/rtsp options) */
  username: string;
  /** Password for CGI/RTSP (if not provided in cgi/rtsp options) */
  password: string;
}

/**
 * Run all diagnostics consecutively: collect diagnostics bundle, sample streams, and create zip archive.
 *
 * @param params - Configuration parameters
 * @returns Results including run directory, zip path, diagnostics path, and streams directory
 */
export async function runAllDiagnosticsConsecutively(
  params: RunAllDiagnosticsConsecutivelyParams,
): Promise<{
  runDir: string;
  zipPath: string;
  diagnosticsPath: string;
  streamsDir: string;
}> {
  const { api, logger, host, username, password } = params;
  const channel = params.channel ?? 0;
  const log = (msg: string, data?: unknown) => {
    if (logger?.log) {
      if (data !== undefined) logger.log(msg, data);
      else logger.log(msg);
    } else {
      console.log(msg);
      if (data !== undefined) console.log(JSON.stringify(data, null, 2));
    }
  };

  const baseOutDir = params.outDir;
  const runDirName = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(baseOutDir, runDirName);

  log("[Diagnostics] starting run", {
    outDir: baseOutDir,
    runDir,
    channel,
    durationSeconds: params.durationSeconds,
    selection: params.selection,
  });

  const cgiEnabled =
    params.cgi === true ||
    (typeof params.cgi === "object" && params.cgi != null);
  const cgiApi = cgiEnabled
    ? new ReolinkCgiApiImpl({
        host:
          (typeof params.cgi === "object" ? params.cgi.host : undefined) ??
          host,
        username:
          (typeof params.cgi === "object" ? params.cgi.username : undefined) ??
          username,
        password:
          (typeof params.cgi === "object" ? params.cgi.password : undefined) ??
          password,
        ...(logger ? { logger } : {}),
        ...(api.client.getDebugConfig?.()
          ? { debugConfig: api.client.getDebugConfig?.() }
          : {}),
        ...(typeof params.cgi === "object" && params.cgi.port != null
          ? { port: params.cgi.port }
          : {}),
        ...(typeof params.cgi === "object" && params.cgi.useHttps != null
          ? { useHttps: params.cgi.useHttps }
          : {}),
        ...(typeof params.cgi === "object" && params.cgi.insecureTLS != null
          ? { insecureTLS: params.cgi.insecureTLS }
          : {}),
        ...(typeof params.cgi === "object" && params.cgi.timeoutMs != null
          ? { timeoutMs: params.cgi.timeoutMs }
          : {}),
      })
    : undefined;

  const diagnosticsRes = await createDiagnosticsBundle({
    outDir: runDir,
    native: { api, channel },
    ...(cgiApi ? { cgi: { cgi: cgiApi, channel } } : {}),
    ...(params.extra ? { extra: params.extra } : {}),
  });

  log("[Diagnostics] diagnostics bundle collected", {
    diagnosticsPath: diagnosticsRes.diagnosticsPath,
    runDir: diagnosticsRes.outDir,
    cgiEnabled,
  });

  const streamsDir = join(runDir, "streams");
  const rtspEnabled =
    params.rtsp === true ||
    (typeof params.rtsp === "object" && params.rtsp != null);
  const rtspCfg: StreamSamplingOptions["rtsp"] | undefined = rtspEnabled
    ? {
        host:
          (typeof params.rtsp === "object" ? params.rtsp.host : undefined) ??
          host,
        username:
          (typeof params.rtsp === "object"
            ? params.rtsp.username
            : undefined) ?? username,
        password:
          (typeof params.rtsp === "object"
            ? params.rtsp.password
            : undefined) ?? password,
        ...(typeof params.rtsp === "object" && params.rtsp.port != null
          ? { port: params.rtsp.port }
          : {}),
      }
    : undefined;

  await sampleStreams({
    outDir: streamsDir,
    durationSeconds: params.durationSeconds,
    ...(params.snapshotIntervalSeconds != null
      ? { snapshotIntervalSeconds: params.snapshotIntervalSeconds }
      : {}),
    channel,
    selection: params.selection,
    ...(rtspCfg ? { rtsp: rtspCfg } : {}),
    ...(params.rtmp ? { rtmp: params.rtmp } : {}),
    native: { api },
    ...(params.limits ? { limits: params.limits } : {}),
    ...(logger ? { logger } : {}),
  });

  log("[Diagnostics] stream sampling completed", { streamsDir });

  const zipPath = join(baseOutDir, `${runDirName}.zip`);

  log("[Diagnostics] creating zip bundle", { zipPath });
  await zipDirectory({ sourceDir: runDir, zipPath });
  log("[Diagnostics] zip bundle created", { zipPath });

  return {
    runDir: diagnosticsRes.outDir,
    zipPath,
    diagnosticsPath: diagnosticsRes.diagnosticsPath,
    streamsDir,
  };
}

// ---------------------------------------------------------------------------
// Model Fixture Capture — dump all API responses for a device/channel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sensitive data sanitization for fixtures
// ---------------------------------------------------------------------------

/** Keys whose values are always fully masked. */
const REDACT_KEYS = new Set([
  "password", "pass", "token", "secret", "apiKey", "api_key",
]);

/** Keys whose values are partially masked (show type/length hint). */
const MASK_KEYS = new Set([
  "serialNumber", "serial", "uid", "mac", "ssid", "wifiPassword",
  "userName", "username", "user",
]);

/** Regex for IPv4 addresses (private ranges we want to mask). */
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/** Regex for MAC addresses. */
const MAC_RE = /\b([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g;

function maskIp(ip: string): string {
  // Keep the first octet, mask the rest: 192.x.x.x → 192.***.***.***
  const parts = ip.split(".");
  return `${parts[0]}.***.***.***`;
}

function maskMac(mac: string): string {
  const sep = mac.includes("-") ? "-" : ":";
  const parts = mac.split(/[:-]/);
  return `${parts[0]}${sep}${parts[1]}${sep}**${sep}**${sep}**${sep}**`;
}

function maskSerial(val: string): string {
  if (val.length <= 4) return "****";
  return val.slice(0, 2) + "*".repeat(val.length - 4) + val.slice(-2);
}

function sanitizeString(s: string): string {
  let out = s;
  // Mask credentials in URLs: ://user:pass@ → ://***:***@
  out = out.replace(/:\/\/([^:@]+):([^@]+)@/g, "://***:***@");
  // Mask password= query params
  out = out.replace(/(password=)[^&\s]*/gi, "$1***");
  // Mask user= query params
  out = out.replace(/(user=)[^&\s]*/gi, "$1***");
  // Mask IPs
  out = out.replace(IPV4_RE, (match) => maskIp(match));
  // Mask MACs
  out = out.replace(MAC_RE, (match) => maskMac(match));
  return out;
}

/**
 * Deep-clone and sanitize a value, masking passwords, IPs, MACs, serial numbers, etc.
 */
export function sanitizeFixtureData(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeFixtureData);
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const kLower = k.toLowerCase();
      if (REDACT_KEYS.has(kLower)) {
        out[k] = "***";
      } else if (MASK_KEYS.has(kLower) || kLower === "serialnumber") {
        out[k] = typeof v === "string" ? maskSerial(v) : "***";
      } else if (kLower === "mac") {
        out[k] = typeof v === "string" ? maskMac(v) : "***";
      } else if (kLower === "ip" || kLower === "ipaddress" || kLower === "host") {
        out[k] = typeof v === "string" ? maskIp(v) : v;
      } else if (kLower === "name" && typeof v === "string" && k !== "name") {
        // Don't mask device/camera "name" — only mask if it looks like a hostname
        out[k] = v;
      } else {
        out[k] = sanitizeFixtureData(v);
      }
    }
    return out;
  }

  return value;
}

/**
 * Compute the expected stream socket compatibility matrix for a device.
 *
 * This is a pure function (no I/O) that encodes the Baichuan protocol rules:
 * - streamType: main=0, sub=1, ext=0 (default variant)
 * - Two streams with the same streamType on one socket → only one gets frames
 * - Multifocal: camera rejects same profile from different channels (error 430)
 *
 * Use this to validate live test results or to generate expected results for
 * cameras that are not physically available for testing.
 */
export function computeExpectedStreamCompatibility(params: {
  /** Number of stream channels (1 for single-lens, 2 for multifocal). */
  channelCount: number;
  /** Profiles available on each channel. */
  profiles?: Array<"main" | "sub" | "ext">;
}): Array<{
  pair: [string, string];
  expectedOk: boolean;
  reason: string;
}> {
  const { channelCount } = params;
  const profiles = params.profiles ?? (["main", "sub", "ext"] as const);
  const expectedStreamType: Record<string, number> = { main: 0, sub: 1, ext: 0 };

  type StreamId = { ch: number; profile: string; label: string };
  const allStreams: StreamId[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    for (const p of profiles) {
      allStreams.push({ ch, profile: p, label: channelCount > 1 ? `ch${ch}_${p}` : p });
    }
  }

  const results: Array<{ pair: [string, string]; expectedOk: boolean; reason: string }> = [];
  for (let i = 0; i < allStreams.length; i++) {
    for (let j = i + 1; j < allStreams.length; j++) {
      const a = allStreams[i]!;
      const b = allStreams[j]!;
      const stA = expectedStreamType[a.profile] ?? 0;
      const stB = expectedStreamType[b.profile] ?? 0;
      const sameChannel = a.ch === b.ch;

      let expectedOk: boolean;
      let reason: string;

      if (sameChannel && stA === stB) {
        expectedOk = false;
        reason = `same streamType (${stA}) on same channel`;
      } else if (!sameChannel && a.profile === b.profile) {
        expectedOk = false;
        reason = `multifocal rejects same profile (${a.profile}) across channels`;
      } else if (!sameChannel && stA === stB) {
        expectedOk = false;
        reason = `same streamType (${stA}) across channels`;
      } else {
        expectedOk = true;
        reason = `different streamTypes (${stA} vs ${stB})`;
      }

      results.push({ pair: [a.label, b.label], expectedOk, reason });
    }
  }
  return results;
}

export interface ModelFixtureCaptureResult {
  /** Per-call results: command name → ok/error */
  calls: Record<string, { ok: true; value?: unknown } | { ok: false; error: string }>;
  /** Output directory where fixtures were written */
  outDir: string;
  /** Summary counters */
  summary: { total: number; ok: number; failed: number; errors: string[] };
}

/**
 * Capture all relevant API responses from a single device (or NVR channel)
 * and write them as JSON/XML fixtures into `outDir`.
 *
 * This is the library-level building block used by both:
 *   - `test/capture-model-fixtures.ts` (CLI)
 *   - the Scrypted plugin's "Dump Model Fixtures" setting action
 *
 * For NVR/Hub devices, call once per active channel.
 */
export async function captureModelFixtures(params: {
  api: ReolinkBaichuanApi;
  channel: number;
  outDir: string;
  /** Logger (defaults to console) */
  log?: (...args: unknown[]) => void;
  /** Skip the stream combination test (useful for NVR channels where the test should be done separately per-camera) */
  skipStreamCombinationTest?: boolean;
}): Promise<ModelFixtureCaptureResult> {
  const { api, channel, outDir } = params;
  const log = params.log ?? console.log;

  mkdirp(outDir);

  // Sanitized writers — mask passwords, IPs, MACs, serial numbers before persisting
  const writeJsonSafe = (filePath: string, data: unknown) =>
    writeJson(filePath, sanitizeFixtureData(data));
  const writeTextSafe = (filePath: string, text: string) =>
    writeText(filePath, sanitizeString(text));

  const calls: ModelFixtureCaptureResult["calls"] = {};
  const errors: string[] = [];

  async function capture<T>(
    name: string,
    fn: () => Promise<T>,
    writer?: (value: T) => void,
  ): Promise<T | undefined> {
    try {
      const value = await fn();
      calls[name] = { ok: true, value };
      if (writer && value !== undefined && value !== null) {
        writer(value);
      }
      log(`  ✓ ${name}`);
      return value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      calls[name] = { ok: false, error: msg };
      errors.push(`${name}: ${msg}`);
      log(`  ✗ ${name}: ${msg}`);
      return undefined;
    }
  }

  // ── Device Info ──────────────────────────────────────────────────────────
  //
  // We capture BOTH the channel-specific DevInfo (cmd_id 318) and the
  // device-wide DevInfo (cmd_id 80). On some cameras the channel-specific
  // call returns an empty payload (e.g. Reolink Duo 3 WiFi and the latest
  // Video Doorbell firmwares — see PRs #22 / #23 / #24) even though the
  // device-wide one returns the full type / firmwareVersion / itemNo. Saving
  // the richer of the two prevents the fixture from ending up with
  // `model: "unknown"`, `firmwareVersion: "unknown"` and downstream parsers
  // (e.g. `getDualLensChannelInfo`, capability fallbacks) misclassifying the
  // model.
  const channelInfo = (await capture(
    "getInfo",
    () => api.getInfo(channel),
  )) as Record<string, unknown> | undefined;
  const baseInfo = (await capture(
    "getInfoBase",
    () => api.getInfo(),
  )) as Record<string, unknown> | undefined;

  // Merge baseInfo and channelInfo, taking the channel-specific value only
  // when it's actually non-empty so a sparse cmd_318 response never blanks
  // out richer cmd_80 fields.
  const mergedInfo: Record<string, unknown> = { ...(baseInfo ?? {}) };
  for (const [k, v] of Object.entries(channelInfo ?? {})) {
    if (v !== undefined && v !== null && v !== "") mergedInfo[k] = v;
  }
  const info: Record<string, unknown> | undefined =
    Object.keys(mergedInfo).length > 0 ? mergedInfo : undefined;
  if (info) writeJsonSafe(path.join(outDir, "device-info.json"), info);

  // ── Support Info ─────────────────────────────────────────────────────────
  const support = await capture("getSupportInfo", () => api.getSupportInfo(), (v) =>
    writeJsonSafe(path.join(outDir, "support-info.json"), v),
  );

  // ── Ability Info ─────────────────────────────────────────────────────────
  const abilities = await capture("getAbilityInfo", () => api.getAbilityInfo(), (v) =>
    writeJsonSafe(path.join(outDir, "ability-info.json"), v),
  );

  // ── Device Capabilities (full, with probe) ───────────────────────────────
  await capture("getDeviceCapabilities", () => api.getDeviceCapabilities(channel), (v) =>
    writeJsonSafe(path.join(outDir, "capabilities.json"), v),
  );

  // ── cmd 289 — White LED / Floodlight (raw XML) ──────────────────────────
  await capture("cmd289-WhiteLed", () => api.sendXml({
    cmdId: BC_CMD_ID_GET_WHITE_LED,
    channel,
    timeoutMs: 3000,
  }), (v) => writeTextSafe(path.join(outDir, "cmd289-white-led.xml"), v as string));

  // ── Stream Metadata (encoding info) ──────────────────────────────────────
  await capture("getStreamMetadata", () => api.getStreamMetadata(channel), (v) =>
    writeJsonSafe(path.join(outDir, "stream-metadata.json"), v),
  );

  // ── Encoding Config (raw XML) ────────────────────────────────────────────
  await capture("getEncXml", () => api.getEncXml(channel), (v) =>
    writeTextSafe(path.join(outDir, "enc-config.xml"), v as string),
  );

  // ── Ports ────────────────────────────────────────────────────────────────
  await capture("getPorts", () => api.getPorts(), (v) =>
    writeJsonSafe(path.join(outDir, "ports.json"), v),
  );

  // ── Talk Ability (intercom) ──────────────────────────────────────────────
  await capture("getTalkAbility", () => api.getTalkAbility(channel), (v) =>
    writeJsonSafe(path.join(outDir, "talk-ability.json"), v),
  );

  // ── Two-Way Audio Config ─────────────────────────────────────────────────
  await capture("getTwoWayAudioConfig", () => api.getTwoWayAudioConfig(channel), (v) =>
    writeJsonSafe(path.join(outDir, "two-way-audio-config.json"), v),
  );

  // ── AI State ─────────────────────────────────────────────────────────────
  await capture("getAiState", () => api.getAiState(channel), (v) =>
    writeJsonSafe(path.join(outDir, "ai-state.json"), v),
  );

  // ── AI Config (autotracking) ─────────────────────────────────────────────
  await capture("getAiCfg", () => api.getAiCfg(channel), (v) =>
    writeJsonSafe(path.join(outDir, "ai-cfg.json"), v),
  );

  // ── OSD ──────────────────────────────────────────────────────────────────
  await capture("getOsd", () => api.getOsd(channel), (v) =>
    writeJsonSafe(path.join(outDir, "osd.json"), v),
  );

  // ── Motion Alarm ─────────────────────────────────────────────────────────
  await capture("getMotionAlarm", () => api.getMotionAlarm(channel), (v) =>
    writeJsonSafe(path.join(outDir, "motion-alarm.json"), v),
  );

  // ── Record Config ────────────────────────────────────────────────────────
  await capture("getRecordCfg", () => api.getRecordCfg(channel), (v) =>
    writeJsonSafe(path.join(outDir, "record-cfg.json"), v),
  );

  // ── Video Input (image settings) ─────────────────────────────────────────
  await capture("getVideoInput", () => api.getVideoInput(channel), (v) =>
    writeJsonSafe(path.join(outDir, "video-input.json"), v),
  );

  // ── PTZ Presets ──────────────────────────────────────────────────────────
  await capture("getPtzPresets", () => api.getPtzPresets(channel), (v) =>
    writeJsonSafe(path.join(outDir, "ptz-presets.json"), v),
  );

  // ── Network Info ─────────────────────────────────────────────────────────
  await capture("getNetworkInfo", () => api.getNetworkInfo(), (v) =>
    writeJsonSafe(path.join(outDir, "network-info.json"), v),
  );

  // ── System General ───────────────────────────────────────────────────────
  await capture("getSystemGeneral", () => api.getSystemGeneral(), (v) =>
    writeJsonSafe(path.join(outDir, "system-general.json"), v),
  );

  // ── WiFi Signal ──────────────────────────────────────────────────────────
  await capture("getWifiSignal", () => api.getWifiSignal(channel), (v) =>
    writeJsonSafe(path.join(outDir, "wifi-signal.json"), v),
  );

  // ── White LED State (parsed) ─────────────────────────────────────────────
  await capture("getWhiteLedState", () => api.getWhiteLedState(channel), (v) =>
    writeJsonSafe(path.join(outDir, "white-led-state.json"), v),
  );

  // ── Floodlight-on-motion ─────────────────────────────────────────────────
  await capture("getFloodlightOnMotion", () => api.getFloodlightOnMotion(channel), (v) =>
    writeJsonSafe(path.join(outDir, "floodlight-on-motion.json"), v),
  );

  // ── Video Stream Options ─────────────────────────────────────────────────
  await capture("buildVideoStreamOptions", () => api.buildVideoStreamOptions({ channel }), (v) =>
    writeJsonSafe(path.join(outDir, "video-stream-options.json"), v),
  );

  // ── Multifocal / Dual-Lens Info ────────────────────────────────────────
  await capture("getDualLensChannelInfo", () => api.getDualLensChannelInfo(channel), (v) =>
    writeJsonSafe(path.join(outDir, "dual-lens-info.json"), v),
  );

  // ── Encoding Options (cmd_id 146) ──────────────────────────────────────
  // Lists every supported resolution / fps / bitrate / GOP combo per profile.
  // Critical for surfacing the full set of values a model accepts — without
  // this the fixture only records the current selection (PR #22 / #23 / #24
  // explicitly flagged this gap).
  await capture("getEncOptions", () => api.getEncOptions(channel), (v) =>
    writeJsonSafe(path.join(outDir, "enc-options.json"), v),
  );

  // ── Encoding Config (parsed) ───────────────────────────────────────────
  // Companion to the raw `enc-config.xml` already captured above. The parsed
  // form is what `setEnc` round-trips through, so it doubles as a fixture
  // for the GOP / keyframe-interval support added in 35dfae4.
  await capture("getEnc", () => api.getEnc(channel), (v) =>
    writeJsonSafe(path.join(outDir, "enc.json"), v),
  );

  // ── Stream Info List ───────────────────────────────────────────────────
  // Alternative source of per-profile stream metadata (cmd 196) used by some
  // legacy code paths.
  await capture("getStreamInfoList", () => api.getStreamInfoList(channel), (v) =>
    writeJsonSafe(path.join(outDir, "stream-info-list.json"), v),
  );

  // ── Autofocus state ────────────────────────────────────────────────────
  // Recent fix (commit 04d6b7e) wired `getAutoFocus` through the
  // channel-extension envelope. Capture so regressions on the envelope are
  // caught by the fixture comparison.
  await capture("getAutoFocus", () => api.getAutoFocus(channel), (v) =>
    writeJsonSafe(path.join(outDir, "autofocus.json"), v),
  );

  // ── LED state (spotlight / status LED) ─────────────────────────────────
  // The Duo 3 WiFi (and several recent doorbells) expose an LED spotlight
  // that's not reflected in `capabilities.json` today — PRs #22 / #23 / #24
  // explicitly flagged it. Capturing `getLedState` here documents what the
  // camera actually reports so the capability detector can be taught.
  await capture("getLedState", () => api.getLedState(channel), (v) =>
    writeJsonSafe(path.join(outDir, "led-state.json"), v),
  );

  // ── IR LEDs ────────────────────────────────────────────────────────────
  await capture("getIrLights", () => api.getIrLights(channel), (v) =>
    writeJsonSafe(path.join(outDir, "ir-lights.json"), v),
  );

  // ── Image / ISP / Day-night ────────────────────────────────────────────
  await capture("getImage", () => api.getImage(channel), (v) =>
    writeJsonSafe(path.join(outDir, "image.json"), v),
  );
  await capture("getIsp", () => api.getIsp(channel), (v) =>
    writeJsonSafe(path.join(outDir, "isp.json"), v),
  );
  await capture("getDayNightThreshold", () => api.getDayNightThreshold(channel), (v) =>
    writeJsonSafe(path.join(outDir, "day-night-threshold.json"), v),
  );

  // ── Privacy mask ───────────────────────────────────────────────────────
  await capture("getMask", () => api.getMask(channel), (v) =>
    writeJsonSafe(path.join(outDir, "mask.json"), v),
  );

  // ── Audio config ───────────────────────────────────────────────────────
  await capture("getAudioCfg", () => api.getAudioCfg(channel), (v) =>
    writeJsonSafe(path.join(outDir, "audio-cfg.json"), v),
  );

  // ── OSD date/time ─────────────────────────────────────────────────────
  await capture("getOsdDatetime", () => api.getOsdDatetime(channel), (v) =>
    writeJsonSafe(path.join(outDir, "osd-datetime.json"), v),
  );

  // ── PTZ position + zoom/focus state ────────────────────────────────────
  await capture("getPtzPosition", () => api.getPtzPosition(channel), (v) =>
    writeJsonSafe(path.join(outDir, "ptz-position.json"), v),
  );
  await capture("getZoomFocus", () => api.getZoomFocus(channel), (v) =>
    writeJsonSafe(path.join(outDir, "zoom-focus.json"), v),
  );

  // ── Stream Combination Test ────────────────────────────────────────────
  // Tests which stream pairs can share a single TCP socket without
  // streamType mismatches.
  //
  // Single-lens: tests all pairs on the same channel (main+sub, main+ext, sub+ext).
  // Multifocal:  also tests cross-channel pairs (ch0_main+ch1_sub, etc.) since
  //              multifocal cameras have strict constraints on which stream
  //              combinations are allowed per socket (see resolveSocketTag).
  //
  // Skipped when skipStreamCombinationTest is true (e.g. NVR channels where
  // the caller manages per-camera stream testing separately).
  if (!params.skipStreamCombinationTest) await capture("streamCombinationTest", async () => {
    // Detect multifocal
    let dualLensInfo: any;
    try { dualLensInfo = await api.getDualLensChannelInfo(channel); } catch { /* ignore */ }
    const isMultifocal = dualLensInfo?.isDualLens === true;
    const channelCount: number = dualLensInfo?.streamChannelCount ?? 1;

    // Build list of stream identifiers: { channel, profile, label }
    type StreamId = { ch: number; profile: StreamProfile; label: string };
    const allStreams: StreamId[] = [];
    const profiles: StreamProfile[] = ["main", "sub", "ext"];
    for (let ch = 0; ch < channelCount; ch++) {
      for (const p of profiles) {
        const label = channelCount > 1 ? `ch${ch}_${p}` : p;
        allStreams.push({ ch, profile: p, label });
      }
    }

    // Generate all unique pairs
    const pairs: Array<[StreamId, StreamId]> = [];
    for (let i = 0; i < allStreams.length; i++) {
      for (let j = i + 1; j < allStreams.length; j++) {
        pairs.push([allStreams[i]!, allStreams[j]!]);
      }
    }

    // Expected compatibility based on protocol rules:
    // - streamType: main=0, sub=1, ext=0 (default variant)
    // - Two streams with the same streamType on the same socket → only one produces frames
    // - Multifocal: camera rejects two "main" or two "sub" from different channels (error 430)
    const expectedStreamType: Record<StreamProfile, number> = { main: 0, sub: 1, ext: 0 };

    const expectedCompat: Array<{ pair: [string, string]; expectedOk: boolean; reason: string }> = [];
    for (const [a, b] of pairs) {
      const stA = expectedStreamType[a.profile]!;
      const stB = expectedStreamType[b.profile]!;
      const sameChannel = a.ch === b.ch;

      let expectedOk: boolean;
      let reason: string;

      if (sameChannel && stA === stB) {
        // Same channel, same streamType → conflict (ext=0 clashes with main=0)
        expectedOk = false;
        reason = `same streamType (${stA}) on same channel`;
      } else if (!sameChannel && a.profile === b.profile) {
        // Cross-channel, same profile → multifocal rejects this (error 430)
        expectedOk = false;
        reason = `multifocal rejects same profile (${a.profile}) across channels`;
      } else if (!sameChannel && stA === stB) {
        // Cross-channel, different profiles but same streamType
        // e.g., ch0_main (st=0) + ch1_ext (st=0) → conflict
        expectedOk = false;
        reason = `same streamType (${stA}) across channels`;
      } else {
        expectedOk = true;
        reason = `different streamTypes (${stA} vs ${stB})`;
      }

      expectedCompat.push({ pair: [a.label, b.label], expectedOk, reason });
    }

    // Run live tests
    interface ComboResult {
      pair: [string, string];
      ok: boolean;
      framesA: number;
      framesB: number;
      mismatches: number;
      error?: string;
      durationMs: number;
      expectedOk: boolean;
      expectedReason: string;
      matchesExpected: boolean;
    }
    const results: ComboResult[] = [];
    const TEST_DURATION_MS = 4000;

    for (let pairIdx = 0; pairIdx < pairs.length; pairIdx++) {
      const [a, b] = pairs[pairIdx]!;
      const expected = expectedCompat[pairIdx]!;
      log(`    testing ${a.label}+${b.label} on shared socket...`);

      let session: { client: any; release: () => Promise<void> } | undefined;
      try {
        session = await api.createDedicatedSession(
          `test:combo:${a.label}_${b.label}`,
        );
      } catch (e) {
        const result: ComboResult = {
          pair: [a.label, b.label],
          ok: false, framesA: 0, framesB: 0, mismatches: 0,
          error: `session: ${e instanceof Error ? e.message : String(e)}`,
          durationMs: 0,
          expectedOk: expected.expectedOk,
          expectedReason: expected.reason,
          matchesExpected: !expected.expectedOk, // failed as expected if we expected failure
        };
        results.push(result);
        continue;
      }

      const testClient = session.client;
      let framesA = 0;
      let framesB = 0;
      let mismatches = 0;
      const start = Date.now();

      const stTypes: Record<StreamProfile, Set<number>> = {
        main: new Set([0, 2]), sub: new Set([1, 3]), ext: new Set([0, 2]),
      };
      const setA = stTypes[a.profile]!;
      const setB = stTypes[b.profile]!;

      const onFrame = (frame: any) => {
        if (frame.header?.cmdId !== BC_CMD_ID_VIDEO) return;
        const st = frame.header.streamType;
        if (setA.has(st)) framesA++;
        else if (setB.has(st)) framesB++;
        else mismatches++;
      };
      testClient.on("frame", onFrame);

      let error: string | undefined;
      try {
        await api.startVideoStream(a.ch, a.profile, { client: testClient });
        await api.startVideoStream(b.ch, b.profile, { client: testClient });
        await new Promise((r) => setTimeout(r, TEST_DURATION_MS));
        await api.stopVideoStream(a.ch, a.profile, { client: testClient }).catch(() => {});
        await api.stopVideoStream(b.ch, b.profile, { client: testClient }).catch(() => {});
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        testClient.removeListener("frame", onFrame);
        await session.release().catch(() => {});
      }

      const elapsed = Date.now() - start;
      const ok = !error && framesA > 0 && framesB > 0 && mismatches === 0;

      const result: ComboResult = {
        pair: [a.label, b.label], ok, framesA, framesB, mismatches,
        ...(error ? { error } : {}),
        durationMs: elapsed,
        expectedOk: expected.expectedOk,
        expectedReason: expected.reason,
        matchesExpected: ok === expected.expectedOk,
      };
      results.push(result);

      const matchStr = result.matchesExpected ? "" : " *** UNEXPECTED ***";
      log(`    ${a.label}+${b.label}: ${ok ? "OK" : "FAIL"} (expected=${expected.expectedOk ? "OK" : "FAIL"}) A=${framesA} B=${framesB} mismatch=${mismatches}${matchStr}`);
    }

    const unexpected = results.filter((r) => !r.matchesExpected);
    return {
      isMultifocal,
      channelCount,
      results,
      summary: {
        total: results.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        matchesExpected: results.filter((r) => r.matchesExpected).length,
        unexpected: unexpected.map((r) => `${r.pair[0]}+${r.pair[1]}: got ${r.ok ? "OK" : "FAIL"}, expected ${r.expectedOk ? "OK" : "FAIL"}`),
      },
    };
  }, (v) => writeJsonSafe(path.join(outDir, "stream-combination-test.json"), v));

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = Object.keys(calls).length;
  const ok = Object.values(calls).filter((c) => c.ok).length;
  const failed = total - ok;

  const summary = { total, ok, failed, errors };
  writeJsonSafe(path.join(outDir, "_summary.json"), {
    collectedAt: new Date().toISOString(),
    model: info?.type ?? "unknown",
    itemNo: (info as any)?.itemNo ?? "unknown",
    firmwareVersion: info?.firmwareVersion ?? "unknown",
    channel,
    ...summary,
    calls: Object.fromEntries(
      Object.entries(calls).map(([k, v]) => [
        k,
        v.ok ? "ok" : `FAILED: ${(v as any).error}`,
      ]),
    ),
  });

  log(`\n  Summary: ${ok}/${total} ok, ${failed} failed`);
  if (errors.length) {
    log(`  Errors:`);
    for (const err of errors) {
      log(`    - ${err}`);
    }
  }

  return { calls, outDir, summary };
}
