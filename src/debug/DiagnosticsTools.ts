import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { ReolinkCgiApi } from "../reolink/cgi/ReolinkCgiApi";
import { BaichuanVideoStream } from "../baichuan/stream/BaichuanVideoStream";
import type { StreamProfile } from "../reolink/baichuan/types";
import { buildRtspUrl } from "../rtsp/urls";
import { splitAnnexBToNalPayloads } from "../baichuan/stream/H264Converter";
import { getH265NalType, splitAnnexBToNalPayloads as splitH265AnnexBToNalPayloads } from "../baichuan/stream/H265Converter";
import type { Logger } from "./DebugConfig";

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
      logStream.write(s);
    });

    p.on("close", (code) => {
      logStream.end();
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, error: `ffmpeg exited with code ${code}\n${stderr.slice(-4000)}` });
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
