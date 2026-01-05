import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { ReolinkCgiApi, DeviceInputData } from "../reolink/cgi/ReolinkCgiApi";
import { BaichuanVideoStream } from "../baichuan/stream/BaichuanVideoStream";
import type { StreamProfile } from "../reolink/baichuan/types";
import { buildRtspUrl } from "../rtsp/urls";
import { splitAnnexBToNalPayloads } from "../baichuan/stream/H264Converter";
import { getH265NalType, splitAnnexBToNalPayloads as splitH265AnnexBToNalPayloads } from "../baichuan/stream/H265Converter";
import type { Logger } from "./DebugConfig";
import { BC_CMD_ID_VIDEO } from "../protocol/constants";
import type { BaichuanFrame } from "../protocol/framing";

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

async function tryCall<T>(fn: () => Promise<T>): Promise<DiagnosticsCollectorResult<T>> {
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

function nalTypesSummary(videoType: "H264" | "H265", accessUnitAnnexB: Buffer): number[] {
  if (videoType === "H264") {
    const nals = splitAnnexBToNalPayloads(accessUnitAnnexB);
    return nals.map((n) => (n[0] ?? 0) & 0x1f);
  }
  const nals = splitH265AnnexBToNalPayloads(accessUnitAnnexB);
  return nals
    .map((nal: Buffer) => getH265NalType(nal))
    .filter((t: number | null): t is number => typeof t === "number");
}

function normalizeProfiles(p: Array<string | undefined | null> | undefined): StreamProfile[] {
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

  const [info, ports, streamMetadata, abilities, capabilities, talkAbility, twoWayAudio] = await Promise.all([
    tryCall(() => api.getInfo(channel)),
    tryCall(() => api.getPorts()),
    tryCall(() => api.getStreamMetadata(channel)),
    tryCall(() => api.getAbilityInfo()),
    tryCall(() => api.getDeviceCapabilities(channel, { probe: false })),
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
      audioStreamMode: Array.isArray(v.audioStreamModeList) ? v.audioStreamModeList[0] : undefined,
      audioConfig: Array.isArray(v.audioConfigList) ? v.audioConfigList[0] : undefined,
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

  const [info, netPort, ability, enc, chStatus, chnType, aiState] = await Promise.all([
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
}): Promise<{ outDir: string; diagnosticsPath: string }>{
  const outDir = params.outDir;
  mkdirp(outDir);

  const [native, cgi] = await Promise.all([
    params.native ? tryCall(() => collectNativeDiagnostics(params.native!)) : Promise.resolve(undefined),
    params.cgi ? tryCall(() => collectCgiDiagnostics(params.cgi!)) : Promise.resolve(undefined),
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
    /([a-z]+:\/\/)([^:@\/\s]+):([^@\/\s]+)@/gi,
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
      logStream.write(`ffmpeg spawn error: ${e instanceof Error ? e.message : String(e)}\n`);
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
      if (s.includes("Stream #0") || s.includes("Video:") || s.includes("Audio:") || s.includes("Duration:")) {
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

export async function sampleStreams(opts: StreamSamplingOptions): Promise<void> {
  const channel = opts.channel ?? 0;
  const durationMs = Math.max(250, Math.round(opts.durationSeconds * 1000));
  const snapshotIntervalSeconds = opts.snapshotIntervalSeconds ?? 2;

  const logger = opts.logger;
  const log = (level: "log" | "warn" | "error", msg: string, extra?: unknown) => {
    const fn = (logger?.[level] ?? logger?.log) as ((...args: any[]) => void) | undefined;
    if (!fn) return;
    if (extra !== undefined) fn.call(logger, msg, extra);
    else fn.call(logger, msg);
  };

  const profiles = normalizeProfiles(opts.selection.profiles) as StreamProfile[];
  const selectedProfiles: StreamProfile[] = profiles.length ? profiles : ["main", "sub", "ext"];

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

      appendNdjson(eventsPath, { t: Date.now(), type: "stream_begin", kind, profile, channel });
      log("log", "[Diagnostics] stream begin", { kind, profile, channel });

      if (kind === "native") {
        const api = opts.native?.api;
        if (!api) {
          appendNdjson(eventsPath, { t: Date.now(), type: "stream_skip", kind, profile, reason: "native api missing" });
          log("warn", "[Diagnostics] stream skip (native api missing)", { kind, profile, channel });
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
          const payload: Buffer = Buffer.isBuffer(frame.payload) && frame.payload.length ? frame.payload : frame.body;
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

        const videoStream = new BaichuanVideoStream({ client: api.client as any, api: api as any, channel, profile });

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
          if (u.isKeyframe && now - lastSnapshotAtMs >= snapshotIntervalSeconds * 1000) {
            lastSnapshotAtMs = now;
            const snapId = nowIsoCompact();
            const snapAnnex = path.join(snapsDir, `snap_${snapId}.${u.videoType === "H265" ? "h265" : "h264"}`);
            try {
              fs.writeFileSync(snapAnnex, u.data);
              appendNdjson(eventsPath, { t: Date.now(), type: "native_snapshot_saved", kind, profile, path: snapAnnex });

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
          appendNdjson(eventsPath, { t: Date.now(), type: "native_audio", kind, profile, bytes: buf.length });
        };

        videoStream.on("videoAccessUnit" as any, onAU as any);
        videoStream.on("audioFrame" as any, onAudio as any);
        videoStream.on("error", (e: any) => {
          appendNdjson(eventsPath, { t: Date.now(), type: "native_error", kind, profile, error: safeStringifyError(e) });
        });

        try {
          await videoStream.start();
          appendNdjson(eventsPath, { t: Date.now(), type: "native_started", kind, profile });

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
              firstKeyframeAtMs == null || startedAtMs == null ? null : Math.max(0, firstKeyframeAtMs - startedAtMs),
            rawFrames,
            rawBytes,
          };
          writeJson(clipInfoPath, clipInfo);

          appendNdjson(eventsPath, { t: Date.now(), type: "native_done", ...clipInfo });
          log("log", "[Diagnostics] stream done", clipInfo);
        }

        continue;
      }

      if (kind === "rtsp") {
        if (!opts.rtsp) {
          appendNdjson(eventsPath, { t: Date.now(), type: "stream_skip", kind, profile, reason: "rtsp config missing" });
          log("warn", "[Diagnostics] stream skip (rtsp config missing)", { kind, profile, channel });
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

        appendNdjson(eventsPath, { t: Date.now(), type: "rtsp_url", kind, profile, url });

        const [recordRes, snapsRes] = await Promise.all([
          recordRtspOrRtmp({ kind: "rtsp", url, outputMp4: mp4Path, durationSeconds: opts.durationSeconds, logPath }),
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
          appendNdjson(eventsPath, { t: Date.now(), type: "stream_skip", kind, profile, reason: "rtmp url missing" });
          log("warn", "[Diagnostics] stream skip (rtmp url missing)", { kind, profile, channel });
          continue;
        }

        const mp4Path = path.join(baseDir, `clip_${nowIsoCompact()}.mp4`);
        const logPath = path.join(baseDir, "ffmpeg_record.log");
        const snapsDir = path.join(baseDir, "snapshots");
        mkdirp(snapsDir);
        const snapsPattern = path.join(snapsDir, "snap_%05d.jpg");

        appendNdjson(eventsPath, { t: Date.now(), type: "rtmp_url", kind, profile, url });

        const [recordRes, snapsRes] = await Promise.all([
          recordRtspOrRtmp({ kind: "rtmp", url, outputMp4: mp4Path, durationSeconds: opts.durationSeconds, logPath }),
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
  const channelsResult = await tryCall(() => cgi.getChannels({ useChannelNumFallback: true }));
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
  const devicesInfo = await tryCall(() => cgi.getDevicesInfo({ useChannelNumFallback: true }));
  result.devicesInfo = devicesInfo;
  if (devicesInfo.ok) {
    log(`✓ Devices info collected for ${Object.keys(devicesInfo.value.devicesData).length} channel(s)`);
    for (const [channel, device] of Object.entries(devicesInfo.value.devicesData)) {
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
  const eventsInfo = await tryCall(() => cgi.getAllChannelsEvents({ useChannelNumFallback: true }));
  result.eventsInfo = eventsInfo;
  if (eventsInfo.ok) {
    log(`✓ Events info collected for ${Object.keys(eventsInfo.value.parsed).length} channel(s)`);
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
  const batteryInfo = await tryCall(() => cgi.getAllChannelsBatteryInfo({ useChannelNumFallback: true }));
  result.batteryInfo = batteryInfo;
  if (batteryInfo.ok) {
    log(`✓ Battery info collected for ${Object.keys(batteryInfo.value.batteryInfoData).length} channel(s)`);
    for (const [channel, battery] of Object.entries(batteryInfo.value.batteryInfoData)) {
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
        hasBattery: battery?.batteryLevel !== undefined && battery.batteryLevel > 0,
        hasPirEvents: !!(abilities as any)?.pirAlarm,
        hasFloodlight: !!(abilities as any)?.ledCtrl,
        hasPtz: !!(abilities as any)?.ptz,
        sleeping: battery?.sleeping ?? false,
      });
    }
    log(`✓ Built capabilities map for ${channelsMap.size} channel(s)`);
  }

  // 7. Status Information (OSD, Floodlight, PIR, PTZ Presets)
  log("\n[7/7] Collecting status information (OSD, Floodlight, PIR, PTZ) for all channels...");
  const statusInfo = await tryCall(() => cgi.getStatusInfo(channelsMap));
  result.statusInfo = statusInfo;
  if (statusInfo.ok) {
    log(`✓ Status info collected for ${Object.keys(statusInfo.value.deviceStatusData).length} channel(s)`);
    for (const [channel, status] of Object.entries(statusInfo.value.deviceStatusData)) {
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
    log(`  Channel ${channel}: collected ${Object.keys(channelDetails).length} detail(s)`);
  }
  
  result.perChannelDetails = perChannelDetails;
  log(`✓ Additional details collected for ${Object.keys(perChannelDetails).length} channel(s)`);

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
  log(`Per-Channel Details: ✓ (${Object.keys(perChannelDetails).length} channels)`);
  log("=".repeat(80));

  return result;
}

/**
 * Print NVR/HUB diagnostics in a human-readable format.
 */
export function printNvrDiagnostics(diagnostics: Record<string, unknown>, logger?: Logger): void {
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
  const nvrInfo = diagnostics.nvrInfo as DiagnosticsCollectorResult<any> | undefined;
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
  const devicesInfo = diagnostics.devicesInfo as DiagnosticsCollectorResult<any> | undefined;
  if (devicesInfo?.ok) {
    for (const channel of channels) {
      const device = devicesInfo.value.devicesData?.[channel];
      if (!device) continue;

      log(`\n  ┌─ Channel ${channel} ────────────────────────────────────────────────────`);
      
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
          log(`  │   Main Stream: ${encData.mainStream?.vType || "N/A"} ${encData.mainStream?.vSize || ""}`);
          log(`  │   Sub Stream: ${encData.subStream?.vType || "N/A"} ${encData.subStream?.vSize || ""}`);
        }
      }

      const ai = device.ai;
      if (ai) {
        log(`  │ AI Detection:`);
        const aiKeys = Object.keys(ai).filter(k => k !== "channel");
        if (aiKeys.length > 0) {
          for (const key of aiKeys) {
            const state = (ai as any)[key];
            if (state?.support === 1) {
              log(`  │   ${key}: ${state.alarm_state === 1 ? "Enabled" : "Disabled"}`);
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
      const eventsInfo = diagnostics.eventsInfo as DiagnosticsCollectorResult<any> | undefined;
      if (eventsInfo?.ok) {
        const events = eventsInfo.value.parsed?.[channel];
        if (events) {
          log(`  │ Events:`);
          log(`  │   Motion: ${events.motion ? "Yes" : "No"}`);
          log(`  │   Detected Objects: ${events.objects?.join(", ") || "None"}`);
        }
      }

      // Battery
      const batteryInfo = diagnostics.batteryInfo as DiagnosticsCollectorResult<any> | undefined;
      if (batteryInfo?.ok) {
        const battery = batteryInfo.value.batteryInfoData?.[channel];
        if (battery) {
          log(`  │ Battery:`);
          log(`  │   Level: ${battery.batteryLevel}%`);
          log(`  │   Sleeping: ${battery.sleeping ? "Yes" : "No"}`);
        }
      }

      // Status
      const statusInfo = diagnostics.statusInfo as DiagnosticsCollectorResult<any> | undefined;
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
      const perChannelDetails = diagnostics.perChannelDetails as Record<number, Record<string, unknown>> | undefined;
      if (perChannelDetails?.[channel]) {
        const details = perChannelDetails[channel];
        log(`  │ Additional Details:`);
        if (details.localLink) {
          const ll = details.localLink as any;
          log(`  │   Connection: ${ll.activeLink || "N/A"}`);
          log(`  │   WiFi Signal: ${ll.wifiSignal !== undefined ? `${ll.wifiSignal}/4` : "N/A"}`);
        }
        if (details.siren) {
          const siren = details.siren as any;
          log(`  │   Siren: ${siren.enabled ? "Enabled" : "Disabled"}`);
        }
      }

      log(`  └────────────────────────────────────────────────────────────────────`);
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
    const xmlPreview = xml.length > 2000 ? xml.substring(0, 2000) + `\n... (truncated, total length: ${xml.length})` : xml;
    log(`  GetEnc XML preview:\n${xmlPreview}`);
    
    // Also get parsed metadata to see what streams were detected
    const metadataResult = await tryCall(() => api.getStreamMetadata(channel));
    if (metadataResult.ok) {
      const detectedProfiles = metadataResult.value.streams.map((s) => s.profile);
      log(`  Parsed streams from metadata: ${detectedProfiles.join(", ")} (${detectedProfiles.length} total)`);
      result.rawEncXml = xml;
      result.encXmlTagsPresent = tagsPresent;
      result.parsedStreamProfiles = detectedProfiles;
    }
  }
  
  const streamOptionsResult = await tryCall(() => api.buildVideoStreamOptions(channel));
  if (!streamOptionsResult.ok) {
    log(`✗ Failed to get stream options: ${streamOptionsResult.error}`);
    result.error = streamOptionsResult.error;
    return result;
  }

  const { nativeStreams, rtspStreams, rtmpStreams } = streamOptionsResult.value;
  log(`✓ Found ${nativeStreams.length} native, ${rtspStreams.length} RTSP, ${rtmpStreams.length} RTMP stream(s)`);
  
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
        log(`    ✓ Available: ${stream.metadata.width}x${stream.metadata.height} @ ${stream.metadata.frameRate}fps, ${stream.metadata.videoEncType}`);
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
        log(`    ✓ Available: ${stream.metadata.width}x${stream.metadata.height} @ ${stream.metadata.frameRate}fps, ${stream.metadata.videoEncType}`);
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
    const key = `native_${stream.profile}`;
    log(`  Testing native ${stream.profile}...`);
    
    const testResult: Record<string, unknown> = {
      available: false,
      profile: stream.profile,
      container: stream.container,
      metadata: stream.metadata,
    };

    // Test with short session - subscribe and wait for at least one frame
    try {
      await api.startVideoStream(channel, stream.profile);
      
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
          log(`    ✓ Available: ${stream.metadata.width}x${stream.metadata.height} @ ${stream.metadata.frameRate}fps, ${stream.metadata.videoEncType}`);
        } else {
          log(`    ✓ Available (frame received)`);
        }
      } else {
        testResult.available = false;
        testResult.error = "Timeout waiting for video frame";
        log(`    ✗ Not available: timeout waiting for video frame`);
      }

      // Stop the stream
      await api.stopVideoStream(channel, stream.profile);
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
  const available = Object.values(streamTests).filter((s: any) => s.available === true).length;
  const total = Object.keys(streamTests).length;
  log(`Available streams: ${available}/${total}`);
  for (const [key, test] of Object.entries(streamTests)) {
    const t = test as any;
    log(`  ${key}: ${t.available ? "✓" : "✗"} ${t.codec || "N/A"} ${t.width || ""}x${t.height || ""}`);
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
    log(`⚠ Warning: channelNum is ${channelNum}, expected 2 or 3 for multi-focal device`);
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
      const available = Object.values(streams).filter((s: any) => s.available === true).length;
      const total = Object.keys(streams).length;
      log(`  Channel ${ch}: ${available}/${total} streams available`);
    }
  }
  log("=".repeat(80));

  return result;
}
