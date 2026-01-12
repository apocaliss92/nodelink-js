import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BaichuanRtspServer, type BaichuanRtspServerOptions } from "../../baichuan/stream/BaichuanRtspServer";
import { BaichuanClient, type BaichuanClientOptions } from "../../client/BaichuanClient";
import { recordingsTraceLog, type Logger } from "../../debug/DebugConfig";
import {
  collectNvrDiagnostics,
  runAllDiagnosticsConsecutively,
  RunAllDiagnosticsConsecutivelyParams,
  runMultifocalDiagnosticsConsecutively,
  RunMultifocalDiagnosticsConsecutivelyParams,
} from "../../debug/DiagnosticsTools";
import {
  BC_CLASS_FILE_DOWNLOAD,
  BC_CLASS_MODERN_24,
  BC_CMD_ID_ABILITY_INFO,
  BC_CMD_ID_AUDIO_ALARM_PLAY,
  BC_CMD_ID_CHANNEL_INFO_ALL,
  BC_CMD_ID_FILE_INFO_LIST_CLOSE,
  BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
  BC_CMD_ID_FILE_INFO_LIST_GET,
  BC_CMD_ID_FILE_INFO_LIST_OPEN,
  BC_CMD_ID_FIND_REC_VIDEO_CLOSE,
  BC_CMD_ID_FIND_REC_VIDEO_GET,
  BC_CMD_ID_FIND_REC_VIDEO_OPEN,
  BC_CMD_ID_FLOODLIGHT_STATUS_LIST,
  BC_CMD_ID_GET_AUDIO_ALARM,
  BC_CMD_ID_GET_BATTERY_INFO,
  BC_CMD_ID_GET_BATTERY_INFO_LIST,
  BC_CMD_ID_GET_PIR_INFO,
  BC_CMD_ID_GET_PTZ_POSITION,
  BC_CMD_ID_GET_PTZ_PRESET,
  BC_CMD_ID_GET_WHITE_LED,
  BC_CMD_ID_GET_ZOOM_FOCUS,
  BC_CMD_ID_PTZ_CONTROL,
  BC_CMD_ID_PTZ_CONTROL_PRESET,
  BC_CMD_ID_SET_AI_ALARM,
  BC_CMD_ID_SET_MOTION_ALARM,
  BC_CMD_ID_SET_PIR_INFO,
  BC_CMD_ID_SET_WHITE_LED_STATE,
  BC_CMD_ID_SET_WHITE_LED_TASK,
  BC_CMD_ID_SET_ZOOM_FOCUS,
  BC_CMD_ID_SUPPORT,
  BC_CMD_ID_TALK,
  BC_CMD_ID_TALK_ABILITY,
  BC_CMD_ID_TALK_CONFIG,
  BC_CMD_ID_TALK_RESET,
  BC_CMD_ID_UDP_KEEP_ALIVE,
  BC_CMD_ID_VIDEO,
  BC_CMD_ID_VIDEO_STOP,
} from "../../protocol/constants";
import { buildAbilityInfoExtensionXml, buildBinaryExtensionXml, buildChannelExtensionXml, buildFloodlightManualXml, buildPreviewStopXml, buildPreviewStopXmlV11, buildPreviewXml, buildPreviewXmlV11, buildPtzControlXml, buildPtzPresetXml, buildPtzPresetXmlV2, buildSirenManualXml, buildSirenTimesXml, buildStartZoomFocusXml, getXmlText, xmlEscape } from "../../protocol/xml";
import type {
  AIEvent,
  AIState,
  BatteryInfo,
  ChannelRecordingFile,
  ChannelStreamMetadata,
  DeviceAbilities,
  DeviceCapabilitiesResult,
  DeviceSupportFlags,
  DownloadRecordingParams,
  DualLensChannelAnalysis,
  DualLensChannelInfo,
  EnrichedChannelRecordingFile,
  EnrichedRecordingFile,
  Events,
  ListRecordingsParams,
  OsdConfig,
  PirState,
  PtzCommand,
  PtzPreset,
  RecordingFile,
  RecordingStreamType,
  ReolinkBaichuanDeviceSummary,
  ReolinkBaichuanNetworkInfo,
  ReolinkNvrDeviceGroupSummary,
  ReolinkEvent,
  ReolinkSimpleEvent,
  ReolinkSimpleEventType,
  SleepStatus,
  StreamMetadata,
  StreamProfile,
  SupportInfo,
  TwoWayAudioConfig,
  VideoCodec,
  WhiteLedState
} from "./types";

import { parseRecordingFileName } from "./recordingFileName";

import sharp from "sharp";
import type { CompositeStreamPipOptions } from "../../multifocal/compositeStream";
import {
  ReolinkCgiApi,
  VodFile,
  type GetVodUrlParams,
  type ListNvrRecordingsParams
} from "../cgi/ReolinkCgiApi";
import { ReolinkHttpClient } from "../http/ReolinkHttpClient";
import type { ReolinkCmdResponse } from "../http/types";
import type { ReolinkDeviceInfo, ReolinkDeviceInfoTag } from "../types";
import { computeDeviceCapabilities, flattenAbilitiesForChannel, parseSupportXml } from "./capabilities";

export type ReolinkNvrChannelInfo = {
  channel: number;
  /** Camera model string (Baichuan: <type>, CGI: typeInfo). */
  model?: string;
  /** Camera name (OSD/name). */
  name?: string;
  /** Camera UID (when available via NVR CGI). */
  uid?: string;
  /** Online flag (when available via NVR CGI). */
  online?: boolean;
  /** Sleep flag (when available via NVR CGI, common for battery cams). */
  sleep?: boolean;
  /** Firmware version (Baichuan: firmwareVersion, CGI: firmVer). */
  firmwareVersion?: string;
  /** Board info (CGI: boardInfo). */
  boardInfo?: string;
  /** Where the info came from for this channel. */
  source: "baichuan" | "cgi";
};

function asBool01(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  }
  return undefined;
}

function extractStatusArrayFromGetChannelstatus(rsp: ReolinkCmdResponse[]): any[] {
  if (!rsp || rsp.length === 0) return [];
  const v: any = rsp[0]?.value;
  if (!v) return [];

  // Try different variants of the field name.
  // Note: some NVRs use "status" instead of "Channelstatus".
  let status = v?.status ?? v?.Channelstatus ?? v?.ChannelStatus ?? v?.channelStatus ?? v?.channelstatus;

  // If it's not an array, the value itself might be the array.
  if (!Array.isArray(status)) {
    if (Array.isArray(v)) {
      status = v;
    } else {
      status = v?.channels ?? v?.Channels ?? v?.channel ?? v?.Channel;
      if (!Array.isArray(status)) {
        const channelKeys = Object.keys(v).filter((k) => /^channel\d+$/i.test(k) || /^ch\d+$/i.test(k));
        if (channelKeys.length > 0) {
          status = channelKeys.map((k) => {
            const ch = v[k];
            return typeof ch === "object" && ch !== null ? ch : { channel: parseInt(k.replace(/\D/g, ""), 10) };
          });
        }
      }
    }
  }

  return Array.isArray(status) ? status : [];
}

type TalkAbility = import("./types").TalkAbility;
type TalkAudioConfig = import("./types").TalkAudioConfig;
type TalkConfig = import("./types").TalkConfig;
type TalkSession = import("./types").TalkSession;
type TalkSessionInfo = import("./types").TalkSessionInfo;

export type ReolinkBaichuanPorts = Record<string, Record<string, number>>;

export type NativeVideoStreamVariant = "default" | "autotrack" | "telephoto";

/**
 * Complete media stream options with all available metadata.
 * Includes RTSP, RTMP, and native Baichuan stream information.
 */
export interface ReolinkSupportedStream {
  // Basic identification
  name: string;
  id: string;
  container: "rtsp" | "rtmp" | "rtp";
  channel?: number; // undefined for composite streams (multifocal devices)
  profile: StreamProfile;
  /**
   * Underlying device stream name used by the transport.
   * For RTSP this maps to `/...Preview_<ch>_<streamName>` (e.g. main/sub/autotrack).
   * For RTMP this maps to `/bcs/channel<ch>_<streamName>.bcs`.
   */
  streamName?: string;
  /** Optional lens hint for multifocal devices (TrackMix/Duo). */
  lens?: "wide" | "telephoto" | "composite";
  /** Native-only: request a non-default logical stream (e.g. TrackMix tele on NVR). */
  nativeVariant?: NativeVideoStreamVariant;
  url: string; // URL without authentication credentials
  urlWithAuth: string; // URL with authentication credentials
  streamType?: number; // Stream type: 0 for main/ext, 1 for sub (RTMP)
  path?: string; // Stream path (e.g., /h264Preview_01_main, /bcs/channel0_main.bcs)
  port?: number; // Port number (RTSP/RTMP)
  metadata?: StreamMetadata; // Complete original stream metadata
}

export type WakeUpOptions = {
  /** Timeout per single attempt (default: 20000). */
  timeoutMs?: number;
  /** Number of attempts (default: 3). */
  attempts?: number;
  /** Delay after an attempt that "unlocks" the camera (default: 1500). */
  waitAfterWakeMs?: number;
  /** Delay between failed attempts (default: 1500). */
  backoffMs?: number;
  /**
   * Se true, chiude la connessione e forza un reconnect prima del retry.
   * Default: true for UDP (battery), false for TCP.
   */
  reconnect?: boolean;
};

function getXmlTexts(xml: string, tags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    const v = getXmlText(xml, t);
    if (v !== undefined) out[t] = v;
  }
  return out;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function resolvePipMarginPx(mainWidth: number, mainHeight: number, rawMargin: unknown, defaultPx = 10): number {
  const v = Number(rawMargin);
  if (rawMargin === undefined || rawMargin === null) return defaultPx;
  if (!Number.isFinite(v) || v < 0) return defaultPx;
  // Legacy: values > 1 are treated as pixels.
  if (v > 1) return Math.floor(v);
  // New: treat as fraction (0..1) of output size.
  const base = Math.min(Math.max(1, Math.floor(mainWidth)), Math.max(1, Math.floor(mainHeight)));
  return Math.max(0, Math.floor(base * v));
}

function calculatePipOverlayPosition(params: {
  position: import("../../multifocal/compositeStream").PipPosition;
  mainWidth: number;
  mainHeight: number;
  pipWidth: number;
  pipHeight: number;
  margin: number;
}): { left: number; top: number } {
  const pipW = Math.max(1, Math.floor(params.pipWidth));
  const pipH = Math.max(1, Math.floor(params.pipHeight));
  const m = Math.max(0, Math.floor(params.margin));
  const mw = Math.max(1, Math.floor(params.mainWidth));
  const mh = Math.max(1, Math.floor(params.mainHeight));

  const clamp = (x: number, min: number, max: number) => Math.min(Math.max(x, min), max);
  const maxX = Math.max(0, mw - pipW);
  const maxY = Math.max(0, mh - pipH);

  let left = m;
  let top = m;

  switch (params.position) {
    case "top-left":
      left = m;
      top = m;
      break;
    case "top-right":
      left = mw - pipW - m;
      top = m;
      break;
    case "bottom-left":
      left = m;
      top = mh - pipH - m;
      break;
    case "bottom-right":
      left = mw - pipW - m;
      top = mh - pipH - m;
      break;
    case "center":
      left = Math.floor((mw - pipW) / 2);
      top = Math.floor((mh - pipH) / 2);
      break;
    case "top-center":
      left = Math.floor((mw - pipW) / 2);
      top = m;
      break;
    case "bottom-center":
      left = Math.floor((mw - pipW) / 2);
      top = mh - pipH - m;
      break;
    case "left-center":
      left = m;
      top = Math.floor((mh - pipH) / 2);
      break;
    case "right-center":
      left = mw - pipW - m;
      top = Math.floor((mh - pipH) / 2);
      break;
  }

  return {
    left: clamp(left, 0, maxX),
    top: clamp(top, 0, maxY),
  };
}

function getXmlBlocks(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(xml))) {
    out.push(m[1] ?? "");
  }
  return out;
}

function formatErrorForLog(e: unknown): string {
  if (e instanceof Error) {
    const anyErr = e as any;
    const code = typeof anyErr.code === "string" || typeof anyErr.code === "number" ? ` code=${String(anyErr.code)}` : "";
    return `${e.name}: ${e.message}${code}`;
  }
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    try {
      const keys = Object.keys(e);
      const json = JSON.stringify(e);
      return keys.length ? `object keys=[${keys.join(",")}]: ${json}` : `object: ${json}`;
    } catch {
      return "[unserializable object]";
    }
  }
  return String(e);
}

function formatClientIoForLog(api: { client?: BaichuanClient } | { client: BaichuanClient }): string {
  try {
    const c = (api as any).client as BaichuanClient | undefined;
    if (!c) return "";
    const transport = c.getTransport?.() ?? "unknown";
    const connected = c.isSocketConnected?.() ?? false;
    const loggedIn = (c as any).loggedIn === true;
    const lastTx = c.getLastTxInfo?.();
    const lastRx = c.getLastRxInfo?.();
    const parts: string[] = [
      `transport=${transport}`,
      `connected=${connected}`,
      `loggedIn=${loggedIn}`,
      lastTx?.cmdId != null ? `lastTxCmdId=${lastTx.cmdId}` : "",
      lastTx?.responseCode != null ? `lastTxCode=${lastTx.responseCode}` : "",
      lastRx?.cmdId != null ? `lastRxCmdId=${lastRx.cmdId}` : "",
      lastRx?.responseCode != null ? `lastRxCode=${lastRx.responseCode}` : "",
    ].filter(Boolean);
    return parts.length ? ` (${parts.join(" ")})` : "";
  } catch {
    return "";
  }
}

/**
 * Helper to derive a "global" UID for devices that expose per-channel UIDs (e.g. NVRs).
 * Preference order:
 * - First non-empty channel UID
 * - Fallback to the constructor-provided UID (if any)
 */
function deriveGlobalUidFromChannels(channels: ReolinkNvrChannelInfo[], fallbackUid?: string): string | undefined {
  for (const ch of channels) {
    if (ch.uid && ch.uid.trim()) {
      return ch.uid.trim();
    }
  }
  return fallbackUid;
}

function parseXmlDateTimeBlock(block: string): Date | undefined {
  const year = Number.parseInt(getXmlText(block, "year") ?? "", 10);
  const month = Number.parseInt(getXmlText(block, "month") ?? "", 10);
  const day = Number.parseInt(getXmlText(block, "day") ?? "", 10);
  const hour = Number.parseInt(getXmlText(block, "hour") ?? "", 10);
  const minute = Number.parseInt(getXmlText(block, "minute") ?? "", 10);
  const second = Number.parseInt(getXmlText(block, "second") ?? "", 10);

  if ([year, month, day, hour, minute, second].every(Number.isFinite)) {
    // Treat as UTC to avoid timezone shifts when serializing to JSON.
    // Camera timestamps are typically in local time, but we parse as UTC to preserve
    // the exact values without timezone conversion artifacts.
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }

  // Some firmwares encode the timestamp as plain text instead of nested tags.
  // Examples observed on Reolink devices:
  // - 2026-01-09 08:45:18
  // - 2026/01/09 08:45:18
  // - 2026-01-09T08:45:18
  const text = block.replace(/<[^>]*>/g, "").trim();
  const m = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return undefined;
  const y = Number.parseInt(m[1] ?? "", 10);
  const mo = Number.parseInt(m[2] ?? "", 10);
  const da = Number.parseInt(m[3] ?? "", 10);
  const ho = Number.parseInt(m[4] ?? "0", 10);
  const mi = Number.parseInt(m[5] ?? "0", 10);
  const se = Number.parseInt(m[6] ?? "0", 10);
  if (![y, mo, da, ho, mi, se].every(Number.isFinite)) return undefined;
  return new Date(Date.UTC(y, mo - 1, da, ho, mi, se));
}

function xmlDateTimePayload(tag: "startTime" | "endTime", d: Date): string {
  // Use local time methods - the camera expects dates in local time format
  // This matches the behavior of test-tcp-videoclips.ts which uses setHours(0, 0, 0, 0)
  return `<${tag}><year>${d.getFullYear()}</year><month>${d.getMonth() + 1}</month><day>${d.getDate()}</day><hour>${d.getHours()}</hour><minute>${d.getMinutes()}</minute><second>${d.getSeconds()}</second></${tag}>`;
}

function parseRecordingFilesFromXml(xml: string): RecordingFile[] {
  const out: RecordingFile[] = [];

  // FileInfoList commonly returns <FileInfo> blocks with <name> and/or <Id>.
  // Prefer <Id> (full path) as the identifier for download, but keep <name> when present.
  const fileInfoBlocks = getXmlBlocks(xml, "FileInfo");
  for (const b of fileInfoBlocks) {
    const id = getXmlText(b, "Id") ?? getXmlText(b, "ID") ?? getXmlText(b, "id");
    const name = getXmlText(b, "name") ?? getXmlText(b, "fileName");
    const chosen = (id ?? name)?.trim();
    if (!chosen) continue;
    const item: RecordingFile = { fileName: chosen };
    if (name != null && name.trim()) item.name = name.trim();
    if (id != null && id.trim()) item.id = id.trim();
    const recordType = getXmlText(b, "type") ?? getXmlText(b, "recordType") ?? getXmlText(b, "alarmType");
    if (recordType != null) item.recordType = recordType;
    const sizeText = getXmlText(b, "size") ?? getXmlText(b, "fileSize");
    const sizeBytes = sizeText ? Number.parseInt(sizeText, 10) : undefined;
    if (sizeBytes != null && Number.isFinite(sizeBytes)) item.sizeBytes = sizeBytes;
    const start = getXmlBlocks(b, "startTime")[0];
    const end = getXmlBlocks(b, "endTime")[0];
    const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
    const endDt = end ? parseXmlDateTimeBlock(end) : undefined;
    if (startDt) item.startTime = startDt;
    if (endDt) item.endTime = endDt;

    const parsed = parseRecordingFileName(item.name ?? item.fileName);
    if (parsed) {
      item.parsedFileName = parsed;
      if (!item.startTime) item.startTime = parsed.start;
      if (!item.endTime) item.endTime = parsed.end;
    }
    out.push(item);
  }

  // Preferred: parse <File> blocks (common in many Reolink list responses).
  const fileBlocks = getXmlBlocks(xml, "File");
  for (const b of fileBlocks) {
    const fileName = (getXmlText(b, "fileName") ?? getXmlText(b, "name"))?.trim();
    if (!fileName) continue;
    const sizeText = getXmlText(b, "size") ?? getXmlText(b, "fileSize");
    const sizeBytes = sizeText ? Number.parseInt(sizeText, 10) : undefined;
    const recordType = getXmlText(b, "type") ?? getXmlText(b, "recordType") ?? getXmlText(b, "alarmType");
    const start = getXmlBlocks(b, "startTime")[0];
    const end = getXmlBlocks(b, "endTime")[0];
    const item: RecordingFile = { fileName };
    if (sizeBytes != null && Number.isFinite(sizeBytes)) item.sizeBytes = sizeBytes;
    if (recordType != null) item.recordType = recordType;
    const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
    const endDt = end ? parseXmlDateTimeBlock(end) : undefined;
    if (startDt) item.startTime = startDt;
    if (endDt) item.endTime = endDt;

    const parsed = parseRecordingFileName(item.fileName);
    if (parsed) {
      item.parsedFileName = parsed;
      if (!item.startTime) item.startTime = parsed.start;
      if (!item.endTime) item.endTime = parsed.end;
    }
    out.push(item);
  }

  // Fallback: any <fileName> tags.
  if (out.length === 0) {
    const re = /<fileName>([\s\S]*?)<\/fileName>/g;
    const seenNames = new Set<string>();
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(xml))) {
      const fileName = (m[1] ?? "").trim();
      if (!fileName) continue;
      if (seenNames.has(fileName)) continue;
      seenNames.add(fileName);
      const item: RecordingFile = { fileName };
      const parsed = parseRecordingFileName(fileName);
      if (parsed) {
        item.parsedFileName = parsed;
        item.startTime = parsed.start;
        item.endTime = parsed.end;
      }
      out.push(item);
    }
  }

  // Alarm video list: <alarmVideo><fileName>...</fileName><alarmType>...</alarmType>...</alarmVideo>
  // Some firmwares return <alarmVideo> blocks that contain richer metadata (alarmType + start/end).
  // We always parse and merge these when present, even if other parsing paths already collected fileName(s).
  const alarmBlocks = getXmlBlocks(xml, "alarmVideo");
  if (alarmBlocks.length > 0) {
    const byName = new Map<string, RecordingFile>();
    for (const existing of out) {
      const key = existing.fileName.trim();
      if (!key) continue;
      // Keep the first occurrence so we update the same instance that will survive the final de-dup.
      if (!byName.has(key)) byName.set(key, existing);
    }

    for (const b of alarmBlocks) {
      const fileNameRaw = getXmlText(b, "fileName") ?? getXmlText(b, "name");
      const fileName = fileNameRaw?.trim();
      if (!fileName) continue;

      const alarmType = getXmlText(b, "alarmType")?.trim();
      const start = getXmlBlocks(b, "startTime")[0];
      const end = getXmlBlocks(b, "endTime")[0];
      const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
      const endDt = end ? parseXmlDateTimeBlock(end) : undefined;

      const target = byName.get(fileName) ?? ({ fileName } as RecordingFile);
      if (alarmType) target.recordType = alarmType;
      if (startDt) target.startTime = startDt;
      if (endDt) target.endTime = endDt;

      if (!target.parsedFileName) {
        const parsed = parseRecordingFileName(target.fileName);
        if (parsed) {
          target.parsedFileName = parsed;
          if (!target.startTime) target.startTime = parsed.start;
          if (!target.endTime) target.endTime = parsed.end;
        }
      }

      if (!byName.has(fileName)) {
        out.push(target);
        byName.set(fileName, target);
      }
    }
  }

  // De-dup by fileName.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = f.fileName.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTalkAudioConfig(block: string): TalkAudioConfig | null {
  const audioType = getXmlText(block, "audioType");
  const sampleRate = Number.parseInt(getXmlText(block, "sampleRate") ?? "", 10);
  const samplePrecision = Number.parseInt(getXmlText(block, "samplePrecision") ?? "", 10);
  const lengthPerEncoder = Number.parseInt(getXmlText(block, "lengthPerEncoder") ?? "", 10);
  const soundTrack = getXmlText(block, "soundTrack");
  const priorityText = getXmlText(block, "priority");

  if (!audioType || !Number.isFinite(sampleRate) || !Number.isFinite(samplePrecision) || !Number.isFinite(lengthPerEncoder) || !soundTrack) {
    return null;
  }

  const config: TalkAudioConfig = {
    audioType,
    sampleRate,
    samplePrecision,
    lengthPerEncoder,
    soundTrack,
  };
  if (priorityText !== undefined) {
    const pr = Number.parseInt(priorityText, 10);
    if (Number.isFinite(pr)) config.priority = pr;
  }
  return config;
}

function parseTalkAbilityXml(xml: string): TalkAbility {
  const talkAbilityBlock = getXmlBlocks(xml, "TalkAbility")[0];
  if (!talkAbilityBlock) {
    throw new Error("TalkAbility XML not found in response");
  }

  const duplexListBlocks = getXmlBlocks(talkAbilityBlock, "duplexList");
  const duplexList = duplexListBlocks
    .map((b) => getXmlText(b, "duplex"))
    .filter((v): v is string => !!v);

  const audioStreamModeListBlocks = getXmlBlocks(talkAbilityBlock, "audioStreamModeList");
  const audioStreamModeList = audioStreamModeListBlocks
    .map((b) => getXmlText(b, "audioStreamMode"))
    .filter((v): v is string => !!v);

  // audioConfig blocks are nested under audioConfigList -> audioConfig
  const audioConfigBlocks = getXmlBlocks(talkAbilityBlock, "audioConfig");
  const audioConfigList = audioConfigBlocks
    .map(parseTalkAudioConfig)
    .filter((v): v is TalkAudioConfig => !!v);

  return {
    duplexList,
    audioStreamModeList,
    audioConfigList,
  };
}

// Constants to identify dual lens models (based on reolink_aio/api.py)
export const DUAL_LENS_DUAL_MOTION_MODELS = new Set<string>([
  "Reolink Duo PoE",
  "Reolink Duo WiFi",
]);

export const DUAL_LENS_SINGLE_MOTION_MODELS = new Set<string>([
  "Reolink TrackMix",
  "Reolink TrackMix PoE",
  "Reolink TrackMix WiFi",
  "RLC-81MA",
]);

export const DUAL_LENS_MODELS = new Set<string>([
  ...DUAL_LENS_DUAL_MOTION_MODELS,
  ...DUAL_LENS_SINGLE_MOTION_MODELS,
]);

export const isDualLenseModel = (model: string): boolean => {
  return DUAL_LENS_MODELS.has(model) || model.toLowerCase().includes('trackmix');
}

function mapToSimpleEvent(event: ReolinkEvent): ReolinkSimpleEvent | null {
  const timestamp = event.timestamp ?? Date.now();

  if (event.type === "motion") {
    return { type: "motion", channel: event.channel, timestamp };
  }

  if (event.type === "visitor") {
    // Common use-case: doorbells/visitor notifications.
    return { type: "doorbell", channel: event.channel, timestamp };
  }

  if (event.type === "daynight") {
    return { type: "daynight", channel: event.channel, timestamp };
  }

  if (event.type === "ai") {
    const ai = event.ai;
    const aiType = ai?.type;

    const map: Record<NonNullable<AIEvent["type"]>, ReolinkSimpleEventType> = {
      people: "people",
      vehicle: "vehicle",
      dog_cat: "animal",
      face: "face",
      package: "package",
      other: "other",
    };

    return {
      type: aiType ? map[aiType] : "other",
      channel: event.channel,
      timestamp,
    };
  }

  return null;
}

function buildTalkConfigPayloadXml(config: TalkConfig): string {
  const audio = config.audioConfig;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<TalkConfig version="1.1">
<channelId>${config.channel}</channelId>
<duplex>${xmlEscape(config.duplex)}</duplex>
<audioStreamMode>${xmlEscape(config.audioStreamMode)}</audioStreamMode>
<audioConfig>
<audioType>${xmlEscape(audio.audioType)}</audioType>
<sampleRate>${audio.sampleRate}</sampleRate>
<samplePrecision>${audio.samplePrecision}</samplePrecision>
<lengthPerEncoder>${audio.lengthPerEncoder}</lengthPerEncoder>
<soundTrack>${xmlEscape(audio.soundTrack)}</soundTrack>
</audioConfig>
</TalkConfig>
</body>`;
}

function encodeBcMediaAdpcmBlock(block: Buffer, halfBlockSize: number): Buffer {
  // Matches parseAdpcm in src/baichuan/stream/BcMediaParser.ts
  // magic(4) + payload_size(u16) + payload_size_b(u16) + magic_data(u16=0x0100) + half_block_size(u16) + data + padding
  const magic = 0x62773130; // "bw10"
  const subHeaderSize = 4;
  const payloadSize = subHeaderSize + block.length;
  const headerLen = 12;
  const padSize = payloadSize % 8 === 0 ? 0 : 8 - (payloadSize % 8);
  const totalLen = headerLen + block.length + padSize;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32LE(magic, 0);
  buf.writeUInt16LE(payloadSize, 4);
  buf.writeUInt16LE(payloadSize, 6);
  buf.writeUInt16LE(0x0100, 8);
  buf.writeUInt16LE(halfBlockSize, 10);
  block.copy(buf, 12);

  return buf;
}

export class ReolinkBaichuanApi {
  readonly client: BaichuanClient;
  readonly logger: Logger;
  private readonly httpClient: ReolinkHttpClient;
  private readonly cgiApi: ReolinkCgiApi;
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  /**
   * Cached camera UID. May be initially undefined if not provided in the constructor.
   * Will be lazily populated on demand when needed (e.g. for recordings).
   */
  private uid: string | undefined;

  private rebootAfterDisconnectionsPerMinute: number | undefined;
  private readonly disconnectStormVoluntaryAtMs: number[] = [];
  private disconnectStormRebootInFlight: Promise<void> | undefined;
  private disconnectStormLastRebootAtMs: number | undefined;
  private readonly simpleEventListeners = new Set<(event: ReolinkSimpleEvent) => void | Promise<void>>();
  private simpleEventSubscribed = false;
  private simpleEventSubscribeInFlight: Promise<void> | undefined;
  private simpleEventUnsubscribeInFlight: Promise<void> | undefined;
  private simpleEventResubscribeTimer: NodeJS.Timeout | undefined;
  private simpleEventResubscribeInFlight: Promise<void> | undefined;
  private readonly simpleEventResubscribeIntervalMs = 5 * 60_000;
  private statePollingInterval: NodeJS.Timeout | undefined;
  private lastMotionState: boolean | undefined;
  private lastAiState: AIState | undefined;
  private aiStatePollingDisabled = false;
  private aiStatePollingDisabledLogged = false;
  private rtspServers = new Set<BaichuanRtspServer>(); // Track all RTSP servers for cleanup
  private readonly activeVideoMsgNums = new Map<string, number>();
  private readonly nvrChannelsSummaryCache = new Map<string, {
    channels: number[];
    devices: ReolinkBaichuanDeviceSummary[];
  }>();

  /**
   * Cached per-channel data from cmd_id 145 push (NVR sends this automatically on connection).
   *
   * This unifies identity (name/uid/state) + best-effort flags (sleep/online).
   */
  private channelPushData: Map<number, {
    name: string;
    uid: string;
    state: string;
    /** Channel index (often 1-based camera slot index on hubs/NVRs). */
    index?: number;
    /** Device stream support list, as reported by the hub (e.g. mainStream,subStream,externStream). */
    streamSupport?: string[];
    /** Raw wifi state string when present. */
    wifiState?: string;
    /** Raw network segment string when present (e.g. WAN/LAN). */
    networkSegment?: string;
    /** True when hub reports the channel has changed (0/1). */
    changed?: boolean;
    /** True when hub reports channel abilities changed (0/1). */
    abilityChanged?: boolean;
    /** Lowercased state for convenience (e.g. "connect", "none"). */
    stateLower?: string;
    /** Best-effort online flag derived from state. */
    online?: boolean;
    /** Best-effort sleeping flag derived from loginState/state. */
    sleeping?: boolean;
    /** Raw loginState when present (lowercased). */
    loginState?: string;
    updatedAtMs: number;
  }> = new Map();

  private lastSleepProbe:
    | {
      atMs: number;
      status: SleepStatus;
    }
    | undefined;

  /**
   * Local cache for recordings. Key is a composite of channel, start, end, streamType.
   * Value contains the cached enriched recordings and timestamp.
   * Unified cache for both NVR and Device recordings (always enriched).
   */
  private recordingsCache = new Map<string, {
    recordings: EnrichedRecordingFile[];
    cachedAt: number;
    /** TTL in milliseconds (default 5 minutes) */
    ttlMs: number;
  }>();

  /**
   * Queue for serializing listRecordings calls to prevent socket crashes from concurrent requests.
   */
  private recordingsQueue: Array<{
    resolve: (value: any) => void;
    reject: (error: any) => void;
    operation: () => Promise<any>;
  }> = [];
  private recordingsQueueProcessing = false;

  /**
   * Process recordings queue sequentially to prevent socket crashes from concurrent requests.
   */
  private async processRecordingsQueue(): Promise<void> {
    if (this.recordingsQueueProcessing || this.recordingsQueue.length === 0) {
      return;
    }

    this.recordingsQueueProcessing = true;

    while (this.recordingsQueue.length > 0) {
      const item = this.recordingsQueue.shift()!;
      try {
        const result = await item.operation();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
    }

    this.recordingsQueueProcessing = false;
  }

  /**
   * Enqueue a recordings operation to be processed sequentially.
   */
  private async enqueueRecordingsOperation<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.recordingsQueue.push({
        resolve,
        reject,
        operation,
      });
      this.processRecordingsQueue();
    });
  }

  private recordingsCacheTtlMs = 20 * 60 * 1000;

  private dispatchSimpleEvent(evt: ReolinkSimpleEvent): void {
    for (const cb of this.simpleEventListeners) {
      try {
        const r = cb(evt) as unknown;
        // Support async handlers (common in Scrypted plugins) without unhandled rejections.
        if (typeof (r as any)?.catch === 'function') {
          (r as any).catch((e: unknown) => {
            (this.logger.warn ?? this.logger.error).call(this.logger, "[ReolinkBaichuanApi] onSimpleEvent handler error", e);
          });
        }
      }
      catch (e) {
        // Never allow user handlers to break the Baichuan client's event loop.
        (this.logger.warn ?? this.logger.error).call(this.logger, "[ReolinkBaichuanApi] onSimpleEvent handler error", e);
      }
    }
  }

  constructor(opts: BaichuanClientOptions & {
    /**
     * Reboot the device if there are too many *voluntary* disconnects within 60 seconds.
     *
     * The count is based on `BaichuanClient.close({ reason: ... })` / idle disconnects.
     * Remote/firmware-initiated closes are ignored.
     */
    rebootAfterDisconnectionsPerMinute?: number;
  }) {
    this.logger = opts.logger ?? console;
    this.client = new BaichuanClient(opts);
    this.host = opts.host;
    this.username = opts.username;
    this.password = opts.password;
    this.uid = opts.uid;
    this.httpClient = new ReolinkHttpClient({
      host: opts.host,
      username: opts.username,
      password: opts.password,
      timeoutMs: 600_000,
    });
    this.cgiApi = new ReolinkCgiApi({
      host: opts.host,
      username: opts.username,
      password: opts.password,
      logger: this.logger,
      debugConfig: this.client.getDebugConfig?.(),
    });

    // Dispatch parsed events in a minimal, stable shape.
    this.client.on("event", (event) => {
      const mapped = mapToSimpleEvent(event);
      if (!mapped) return;

      this.dispatchSimpleEvent(mapped);
    });

    // Handle channel info push from NVR (cmd_id 145)
    this.client.on("channelInfo", (xml: string) => {
      try {
        this.parseAndStoreChannelInfo(xml);
      } catch (e: any) {
        this.logger.warn?.("[ReolinkBaichuanApi] Error parsing channel info from push", e?.message);
      }
    });

    const v = opts.rebootAfterDisconnectionsPerMinute;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      this.rebootAfterDisconnectionsPerMinute = Math.floor(v);
      this.client.on("close", () => {
        try {
          void this.maybeRebootOnDisconnectStorm();
        } catch {
          // never throw from close handler
        }
      });
    }
  }

  /**
   * CGI forward: fetch RTSP URL for a channel via `GetRtspUrl`.
   * Request body:
   * `[{"cmd":"GetRtspUrl","action":0,"param":{"channel":<channel>}}]`.
   */
  async getRtspUrl(channel: number): Promise<string> {
    const ch = this.normalizeChannel(channel);
    return await this.cgiApi.getRtspUrl(ch);
  }

  // --------------------
  // Recordings Cache Methods
  // --------------------

  /**
   * Generate a cache key for recordings lookup.
   */
  private getRecordingsCacheKey(channel: number, start: Date, end: Date, streamType: string): string {
    return `${channel}:${start.getTime()}:${end.getTime()}:${streamType}`;
  }

  /**
   * Get cached recordings if available and not expired.
   */
  private getCachedRecordings(channel: number, start: Date, end: Date, streamType: string): EnrichedRecordingFile[] | undefined {
    const key = this.getRecordingsCacheKey(channel, start, end, streamType);
    const cached = this.recordingsCache.get(key);

    if (!cached) return undefined;

    const now = Date.now();
    if (now - cached.cachedAt > cached.ttlMs) {
      // Cache expired, remove it
      this.recordingsCache.delete(key);
      return undefined;
    }

    return cached.recordings;
  }

  /**
   * Cache recordings for future lookups.
   */
  private cacheRecordings(channel: number, start: Date, end: Date, streamType: string, recordings: EnrichedRecordingFile[], ttlMs?: number): void {
    const key = this.getRecordingsCacheKey(channel, start, end, streamType);
    this.recordingsCache.set(key, {
      recordings,
      cachedAt: Date.now(),
      ttlMs: ttlMs ?? this.recordingsCacheTtlMs,
    });
  }

  /**
   * Clear all cached recordings.
   */
  clearRecordingsCache(): void {
    this.recordingsCache.clear();
  }

  /**
   * Clear cached recordings for a specific time range.
   */
  clearRecordingsCacheForRange(channel: number, start: Date, end: Date, streamType: string): void {
    const key = this.getRecordingsCacheKey(channel, start, end, streamType);
    this.recordingsCache.delete(key);
  }

  /**
   * Set the default TTL for recordings cache.
   * @param ttlMs - TTL in milliseconds (default: 5 minutes = 300000ms)
   */
  setRecordingsCacheTtl(ttlMs: number): void {
    this.recordingsCacheTtlMs = ttlMs;
  }

  /**
   * Convenience helper: run all supported diagnostics sequentially into a single output folder.
   *
   * This collects:
   * - Native (Baichuan) diagnostics
   * - Optional CGI diagnostics (if enabled)
   * - Stream sampling (native/rtsp/rtmp, for `selection`)
   *
   * Output layout:
   * - `outDir/<timestamp>/...` contains the raw run artifacts
   * - `outDir/<timestamp>.zip` contains the zipped bundle
   */
  async runAllDiagnosticsConsecutively(params: RunAllDiagnosticsConsecutivelyParams): Promise<{ runDir: string; zipPath: string; diagnosticsPath: string; streamsDir: string }> {
    return await runAllDiagnosticsConsecutively({
      ...params,
      api: this,
      logger: this.logger,
      host: this.host,
      username: this.username,
      password: this.password,
    });
  }

  /**
   * Multifocal/NVR empirical stream diagnostics:
   * probes RTSP/RTMP candidates + native streams, prints discovered resolutions,
   * and saves one clip per working stream into a timestamped folder under outDir.
   */
  async runMultifocalDiagnosticsConsecutively(
    params: Omit<RunMultifocalDiagnosticsConsecutivelyParams, "api" | "host" | "username" | "password" | "logger"> & {
      /** Optional logger from the caller (preferred over the API logger). */
      logger?: RunMultifocalDiagnosticsConsecutivelyParams["logger"];
    },
  ): Promise<{ runDir: string; resultsPath: string; streamsDir: string }> {
    return await runMultifocalDiagnosticsConsecutively({
      ...params,
      api: this,
      logger: params.logger ?? this.logger,
      host: this.host,
      username: this.username,
      password: this.password,
    });
  }

  private async maybeRebootOnDisconnectStorm(): Promise<void> {
    const threshold = this.rebootAfterDisconnectionsPerMinute;
    if (threshold == null) return;

    const info = this.client.getLastDisconnectInfo?.();
    if (!info?.voluntary) return;

    const now = Date.now();
    const windowMs = 60_000;
    const cutoff = now - windowMs;
    while (this.disconnectStormVoluntaryAtMs.length && this.disconnectStormVoluntaryAtMs[0]! < cutoff) {
      this.disconnectStormVoluntaryAtMs.shift();
    }
    this.disconnectStormVoluntaryAtMs.push(now);

    if (this.disconnectStormVoluntaryAtMs.length < threshold) return;

    if (this.disconnectStormRebootInFlight) return;
    const cooldownMs = 10 * 60_000;
    if (this.disconnectStormLastRebootAtMs != null && now - this.disconnectStormLastRebootAtMs < cooldownMs) return;

    this.disconnectStormLastRebootAtMs = now;
    (this.logger.warn ?? this.logger.error).call(this.logger, "[ReolinkBaichuanApi] disconnect storm detected; rebooting device", {
      transport: info.transport,
      reason: info.reason,
      voluntaryDisconnectsInWindow: this.disconnectStormVoluntaryAtMs.length,
      windowMs,
      threshold,
      cooldownMs,
      method: "auto",
    });

    this.disconnectStormRebootInFlight = this.rebootFromDisconnectStorm("auto")
      .catch((e) => {
        (this.logger.warn ?? this.logger.error).call(this.logger, "[ReolinkBaichuanApi] disconnect-storm reboot failed", e);
      })
      .finally(() => {
        this.disconnectStormRebootInFlight = undefined;
      });
  }

  private async rebootFromDisconnectStorm(method: "auto" | "baichuan" | "cgi"): Promise<void> {
    let lastErr: unknown;

    if (method === "auto" || method === "baichuan") {
      try {
        await this.reboot();
        return;
      } catch (e) {
        lastErr = e;
        if (method === "baichuan") throw e;
      }
    }

    if (method === "auto" || method === "cgi") {
      try {
        await this.cgiApi.login();
        await this.cgiApi.Reboot();
        return;
      } catch (e) {
        lastErr = e;
        if (method === "cgi") throw e;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "disconnect-storm reboot failed"));
  }

  /**
   * Subscribe to minimal high-level events.
   * The API manages Baichuan subscribe/unsubscribe automatically.
   */
  async onSimpleEvent(callback: (event: ReolinkSimpleEvent) => void | Promise<void>): Promise<void> {
    this.simpleEventListeners.add(callback);
    await this.ensureSimpleEventSubscribed();
    this.startSimpleEventResubscribeTimer();
  }

  /**
   * Remove one callback, or all callbacks if omitted.
   * When the last listener is removed, the API unsubscribes from Baichuan events.
   */
  async offSimpleEvent(callback?: (event: ReolinkSimpleEvent) => void | Promise<void>): Promise<void> {
    if (callback) {
      this.simpleEventListeners.delete(callback);
    }
    else {
      this.simpleEventListeners.clear();
    }

    if (this.simpleEventListeners.size === 0) {
      this.stopSimpleEventResubscribeTimer();
      await this.ensureSimpleEventUnsubscribed();
    } else {
      // If there are still listeners, keep polling running (TCP only)
      const isUdp = this.client.getTransport?.() === "udp";
      if (!isUdp && this.client.isStatePollingEnabled?.()) {
        this.startStatePolling();
      }
    }
  }

  private startSimpleEventResubscribeTimer(): void {
    if (this.simpleEventResubscribeTimer) return;
    if (this.simpleEventListeners.size === 0) return;

    this.simpleEventResubscribeTimer = setInterval(() => {
      // Best-effort renew: some devices silently drop subscriptions without closing the socket.
      void this.renewSimpleEventSubscription();
    }, this.simpleEventResubscribeIntervalMs);
  }

  private stopSimpleEventResubscribeTimer(): void {
    if (!this.simpleEventResubscribeTimer) return;
    clearInterval(this.simpleEventResubscribeTimer);
    this.simpleEventResubscribeTimer = undefined;
  }

  private async renewSimpleEventSubscription(): Promise<void> {
    if (this.simpleEventListeners.size === 0) return;
    if (this.simpleEventResubscribeInFlight) return await this.simpleEventResubscribeInFlight;

    this.simpleEventResubscribeInFlight = (async () => {
      try {
        await this.subscribeEvents();
        this.simpleEventSubscribed = true;
        (this.logger.debug ?? this.logger.log).call(this.logger, "[ReolinkBaichuanApi] renewed simple event subscription", {
          intervalMs: this.simpleEventResubscribeIntervalMs,
        });
      } catch (e) {
        (this.logger.debug ?? this.logger.log).call(this.logger, "[ReolinkBaichuanApi] failed to renew event subscription", e);
      }
    })().finally(() => {
      this.simpleEventResubscribeInFlight = undefined;
    });

    return await this.simpleEventResubscribeInFlight;
  }

  private async ensureSimpleEventSubscribed(): Promise<void> {
    if (this.simpleEventListeners.size === 0) return;
    if (this.simpleEventSubscribed) return;
    if (this.simpleEventSubscribeInFlight) return await this.simpleEventSubscribeInFlight;

    this.simpleEventSubscribeInFlight = (async () => {
      // If the caller already subscribed (e.g. NVR shared connection using subscribeToAllEvents),
      // don't resubscribe.
      if (!this.client.subscribed) {
        await this.subscribeEvents();
      }
      this.simpleEventSubscribed = true;

      // Only check current state and start polling for TCP connections (not UDP/battery cameras)
      // UDP/battery cameras should rely on event pushes only, not polling
      const isUdp = this.client.getTransport?.() === "udp";
      if (!isUdp && this.client.isStatePollingEnabled?.()) {
        const channel = this.client.getConfiguredChannel?.() ?? 0;
        // Check current state and dispatch events immediately (TCP only)
        await this.checkAndDispatchCurrentState(channel);

        // Start periodic polling if not already running (TCP only)
        this.startStatePolling();
      }
    })().finally(() => {
      this.simpleEventSubscribeInFlight = undefined;
    });

    return await this.simpleEventSubscribeInFlight;
  }

  private async ensureSimpleEventUnsubscribed(): Promise<void> {
    if (!this.simpleEventSubscribed && !this.client.subscribed) return;
    if (this.simpleEventUnsubscribeInFlight) return await this.simpleEventUnsubscribeInFlight;

    if (this.simpleEventSubscribeInFlight) {
      try {
        await this.simpleEventSubscribeInFlight;
      }
      catch {
        // ignore
      }
    }

    this.simpleEventUnsubscribeInFlight = (async () => {
      await this.unsubscribeEvents();
      this.simpleEventSubscribed = false;

      // Stop renew timer when unsubscribed.
      this.stopSimpleEventResubscribeTimer();

      // Stop polling when no more listeners
      this.stopStatePolling();
    })().finally(() => {
      this.simpleEventUnsubscribeInFlight = undefined;
    });

    return await this.simpleEventUnsubscribeInFlight;
  }

  private normalizeChannel(channel?: number | null): number {
    return channel == null ? 0 : channel;
  }

  async login(maxEncryption?: import("../../client/BaichuanClient.js").MaxEncryption): Promise<void> {
    await this.client.login(maxEncryption);
  }

  async close(): Promise<void> {
    // Stop state polling before closing
    this.stopStatePolling();
    // Stop all RTSP servers before closing the client
    await this.cleanup();
    await this.client.close();
  }

  /**
   * Cleanup all RTSP servers and release resources.
   * This should be called when the API instance is being destroyed to prevent memory leaks.
   */
  async cleanup(): Promise<void> {
    const servers = Array.from(this.rtspServers);
    this.rtspServers.clear();

    // Stop all servers in parallel
    await Promise.allSettled(
      servers.map(async (server) => {
        try {
          await server.stop();
        } catch (error) {
          this.logger.error(`[ReolinkBaichuanApi] Error stopping RTSP server during cleanup:`, error);
        }
      })
    );

    if (servers.length > 0) {
      this.logger.info(`[ReolinkBaichuanApi] Cleaned up ${servers.length} RTSP server(s)`);
    }
  }

  /** Generic Baichuan cmd_id call, returns XML (if any). */
  async sendXml(params: Parameters<BaichuanClient["sendXml"]>[0], retry = 3): Promise<string> {
    // Only call login() if not already logged in (avoid recursion if called from login itself)
    if (!this.client.loggedIn) {
      await this.client.login();
    }
    try {
      // Use sendFrame to check responseCode and handle 400 errors with retry
      const frame = await this.client.sendFrame(params);

      // Retry logic for 400 errors.
      // NOTE: several firmwares return responseCode=400 with empty body when the camera is sleeping,
      // waking up, or when the session has expired (not only for bad credentials).
      if (frame.header.responseCode === 400) {
        // Special cases for NVR/Hub firmwares: some commands may return 400 with an empty body
        // when unsupported (not just for auth/session issues). Retrying/login loops can stall tests.
        //
        // - FILE_INFO_LIST_GET with 400+empty body during pagination means "no more pages".
        // - FILE_INFO_LIST_OPEN with 400+empty body often means "FileInfoList unsupported" on NVRs.
        // In both cases, fail fast and let higher-level code fall back to findAlarmVideo/CGI.
        if (
          frame.body.length === 0 &&
          (params.cmdId === BC_CMD_ID_FILE_INFO_LIST_GET || params.cmdId === BC_CMD_ID_FILE_INFO_LIST_OPEN)
        ) {
          throw new Error(
            'Baichuan request failed (responseCode 400, empty body). Possible causes: camera sleeping/waking (battery), expired session, invalid username/password, or unsupported command on NVR/Hub.',
          );
        }

        if (retry > 0) {
          // If the body is empty, try forcing a re-login once before backing off.
          // This helps for expired sessions while staying safe for sleeping cameras.
          // However, avoid re-login if the socket is not connected to prevent disconnection loops
          if (frame.body.length === 0) {
            const isConnected = this.client.isSocketConnected();
            if (isConnected) {
              try {
                this.client.loggedIn = false;
                await this.client.login();
              } catch {
                // ignore; we will still back off and retry
              }
            } else {
              // Socket not connected, don't try to login - wait for reconnection
              const delayMs = 2000;
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return await this.sendXml(params, retry - 1);
            }
          }

          const delayMs = 1500;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return await this.sendXml(params, retry - 1);
        }

        // Out of retries.
        if (frame.body.length === 0) {
          throw new Error(
            'Baichuan request failed (responseCode 400, empty body). Possible causes: camera sleeping/waking (battery), expired session, invalid username/password, or unsupported command on NVR/Hub.',
          );
        }
      }

      // Decrypt and return XML
      if (frame.body.length === 0) return "";
      const xml = this.client.tryDecryptXml(frame.body, frame.header.channelId, this.client.enc);
      return xml;
    } catch (error) {
      // If it's already an Error from sendFrame (timeout, etc.), just throw it
      throw error;
    }
  }

  /**
   * Fetch TalkAbility (cmd_id=10) which describes supported two-way audio formats.
   * Uses MSG_ID_TALKABILITY.
   */
  async getTalkAbility(channel?: number): Promise<TalkAbility> {
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_TALK_ABILITY, ...(channel !== undefined ? { channel } : {}) });
    return parseTalkAbilityXml(xml);
  }

  /**
   * Create a talk (two-way audio) session.
   *
   * Input audio format expected by the camera is ADPCM (DVI4/IMA style) in blocks described
   * by TalkAbility.audioConfigList (typically 16kHz mono, lengthPerEncoder=1024).
   */
  async createTalkSession(channel = 0, options?: { blocksPerPayload?: number }): Promise<TalkSession> {
    if (!this.client.loggedIn) await this.client.login();

    // BCUDP/battery firmwares often expect 0-based header channelId.
    // Talk is particularly sensitive because the binary Extension must be decrypted.
    const isUdp = this.client.getTransport?.() === "udp";
    const channelIdOverride = isUdp ? channel : undefined;

    const ability = await this.getTalkAbility(channel);
    const audioConfig = ability.audioConfigList.find((c) => c.audioType.toLowerCase() === "adpcm") ?? ability.audioConfigList[0];
    if (!audioConfig) {
      throw new Error(`Talk not supported on channel ${channel} (no audioConfig in TalkAbility)`);
    }

    const duplex = ability.duplexList[0] ?? "FDX";
    const audioStreamMode = ability.audioStreamModeList[0] ?? "followVideoStream";

    const talkConfig: TalkConfig = {
      channel,
      duplex,
      audioStreamMode,
      audioConfig,
    };

    const blockSize = Math.floor(audioConfig.lengthPerEncoder / 2);
    const fullBlockSize = blockSize + 4;
    if (blockSize <= 0 || fullBlockSize <= 4) {
      throw new Error(`Invalid talk audio config: lengthPerEncoder=${audioConfig.lengthPerEncoder}`);
    }

    // Send TalkConfig (201) and handle 422 by issuing TalkReset (11) then retry.
    const payloadXml = buildTalkConfigPayloadXml(talkConfig);
    const sendTalkConfig = async (): Promise<void> => {
      const frame = await this.client.sendFrame({
        cmdId: BC_CMD_ID_TALK_CONFIG,
        channel,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
        payloadXml,
        messageClass: BC_CLASS_MODERN_24,
      });

      if (frame.header.responseCode === 422) {
        await this.client.sendFrame({
          cmdId: BC_CMD_ID_TALK_RESET,
          channel,
          ...(channelIdOverride != null ? { channelIdOverride } : {}),
          // TalkReset has no payload; extension is enough.
          payloadXml: "",
          messageClass: BC_CLASS_MODERN_24,
        });
        const retryFrame = await this.client.sendFrame({
          cmdId: BC_CMD_ID_TALK_CONFIG,
          channel,
          ...(channelIdOverride != null ? { channelIdOverride } : {}),
          payloadXml,
          messageClass: BC_CLASS_MODERN_24,
        });
        if (retryFrame.header.responseCode !== 200) {
          throw new Error(`TalkConfig rejected after reset (responseCode ${retryFrame.header.responseCode})`);
        }
        return;
      }

      if (frame.header.responseCode !== 200) {
        throw new Error(`TalkConfig rejected (responseCode ${frame.header.responseCode})`);
      }
    };

    await sendTalkConfig();

    const info: TalkSessionInfo = {
      channel,
      audioConfig,
      blockSize,
      fullBlockSize,
    };

    // Session implementation
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let closed = false;
    let pumping = false;
    let expectedStreamEndMs = Date.now();

    // Use 4 blocks per payload. Lower values reduce end-to-end latency
    // (smaller bursts, earlier first audio) at the cost of more packets.
    const BLOCKS_PER_PAYLOAD = Math.max(1, Math.min(8, Math.floor(options?.blocksPerPayload ?? 1)));

    const sendBlocks = async (blocks: Array<Buffer<ArrayBufferLike>>): Promise<void> => {
      if (blocks.length === 0) return;
      if (blocks.length > BLOCKS_PER_PAYLOAD) {
        throw new Error(`Internal error: too many blocks in payload (${blocks.length})`);
      }

      const parts: Buffer[] = [];
      let samplesSent = 0;
      for (const block of blocks) {
        parts.push(encodeBcMediaAdpcmBlock(block, blockSize));
        // 2 samples per encoded byte + 1 predictor sample in 4-byte header
        samplesSent += Math.max(0, (block.length - 4) * 2 + 1);
      }

      await this.client.sendBinaryPayloadNoReply({
        cmdId: BC_CMD_ID_TALK,
        channel,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
        extensionXml: buildBinaryExtensionXml(channel),
        payload: Buffer.concat(parts),
        messageClass: BC_CLASS_MODERN_24,
      });

      const playLengthMs = (samplesSent / audioConfig.sampleRate) * 1000;

      const now = Date.now();
      if (now > expectedStreamEndMs) expectedStreamEndMs = now + playLengthMs;
      else expectedStreamEndMs += playLengthMs;

      const sleepFor = expectedStreamEndMs - Date.now();
      if (sleepFor > 0) await sleepMs(sleepFor);
    };

    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        while (true) {
          if (buffer.length >= fullBlockSize) {
            const blocks: Array<Buffer<ArrayBufferLike>> = [];
            while (blocks.length < BLOCKS_PER_PAYLOAD && buffer.length >= fullBlockSize) {
              blocks.push(buffer.subarray(0, fullBlockSize) as Buffer<ArrayBufferLike>);
              buffer = buffer.subarray(fullBlockSize) as Buffer<ArrayBufferLike>;
            }
            await sendBlocks(blocks);
            continue;
          }

          if (closed) {
            // pad last partial block to avoid dropping tail
            if (buffer.length > 0) {
              const padded = Buffer.alloc(fullBlockSize, 0xff) as Buffer<ArrayBufferLike>;
              buffer.copy(padded, 0);
              buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
              await sendBlocks([padded]);
            }
            break;
          }

          // Not enough data for a full block yet; exit and wait for more.
          break;
        }
      } finally {
        pumping = false;
      }
    };

    const stop = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await pump();

      // Wait a tiny bit after the expected end to avoid cutting off playback.
      const remaining = expectedStreamEndMs - Date.now();
      if (remaining > 0) await sleepMs(remaining + 100);
      else await sleepMs(100);

      const frame = await this.client.sendFrame({
        cmdId: BC_CMD_ID_TALK_RESET,
        channel,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
        payloadXml: "",
        messageClass: BC_CLASS_MODERN_24,
      });
      if (frame.header.responseCode !== 200) {
        throw new Error(`TalkReset rejected (responseCode ${frame.header.responseCode})`);
      }
    };

    const session: TalkSession = {
      info,
      sendAudio: async (adpcm: Buffer<ArrayBufferLike>) => {
        if (closed) throw new Error("Talk session is closed");
        if (adpcm.length === 0) return;
        buffer = buffer.length === 0 ? adpcm : (Buffer.concat([buffer, adpcm]) as Buffer<ArrayBufferLike>);
        await pump();
      },
      stop,
    };

    return session;
  }

  /** Generic Baichuan cmd_id call, returns binary data (for commands like Snap). */
  async sendBinary(params: Parameters<BaichuanClient["sendBinary"]>[0]): Promise<Buffer> {
    await this.client.login();
    return await this.client.sendBinary(params);
  }

  // --------------------
  // Main operations
  // --------------------

  /** GetNetPort via Baichuan: cmd_id 37 */
  async getNetPort(): Promise<ReolinkBaichuanPorts> {
    const xml = await this.sendXml({ cmdId: 37 });
    // Parser minimale: estrae <RtspPort><enable>...</enable><port>...</port>...
    const ports: ReolinkBaichuanPorts = {};
    const protoBlocks = xml.matchAll(/<([A-Za-z]+)Port[^>]*>([\s\S]*?)<\/\1Port>/g);
    for (const m of protoBlocks) {
      const proto = (m[1] ?? "").toLowerCase();
      const inner = m[2] ?? "";
      const kv: Record<string, number> = {};
      for (const kvp of inner.matchAll(/<([A-Za-z]+)>(-?\d+)<\/\1>/g)) {
        const k = (kvp[1] ?? "").toLowerCase();
        const v = Number(kvp[2]);
        if (Number.isFinite(v)) kv[k] = v;
      }
      if (Object.keys(kv).length) ports[proto] = kv;
    }
    return ports;
  }

  /** Back-compat alias for older API name used by tests/consumers. */
  async getPorts(): Promise<ReolinkBaichuanPorts> {
    return this.getNetPort();
  }

  /** SetNetPort via Baichuan: cmd_id 36 (enable/disable rtsp/rtmp/onvif/http/https) */
  async setPortEnabled(params: { port: "rtsp" | "rtmp" | "onvif" | "http" | "https"; enable: boolean }): Promise<void> {
    const tag = `${params.port[0]!.toUpperCase()}${params.port.slice(1)}Port`;
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<${tag} version="1.1">` +
      `<enable>${params.enable ? 1 : 0}</enable>` +
      `</${tag}>` +
      `</body>`;
    await this.sendXml({ cmdId: 36, payloadXml: xml });
  }

  /** GetDevInfo via Baichuan: host cmd_id 80, channel cmd_id 318 */
  async getInfo(
    channel?: number,
    options?: {
      timeoutMs?: number;
      /** List of XML tags to extract. Defaults to the canonical minimal set. */
      tags?: ReolinkDeviceInfoTag[];
    },
  ): Promise<Partial<ReolinkDeviceInfo>> {
    const req: { cmdId: number; channel?: number; timeoutMs?: number } = { cmdId: channel == null ? 80 : 318 };
    if (channel !== undefined) req.channel = channel;
    if (options?.timeoutMs != null) req.timeoutMs = options.timeoutMs;
    const xml = await this.sendXml(req);
    // Canonical minimal set: type, hardwareVersion, firmwareVersion, itemNo, serialNumber, name
    const tags = options?.tags?.length
      ? options.tags
      : ["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"];
    return getXmlTexts(xml, tags) as Partial<ReolinkDeviceInfo>;
  }

  /**
   * Parse and store channel info from cmd_id 145 push XML.
   * This is called automatically when the NVR sends channel info on connection.
   * 
   * The XML structure is typically:
   * - <ChannelInfoList> with <ChannelInfo> blocks containing <channelId>, <devName>, <state>, <uid>, etc.
   * - <IOTInfoList> with <IOTInfo> blocks (for IoT devices)
   */
  private parseAndStoreChannelInfo(xml: string): void {
    // Parse ChannelInfoList (main camera channels) and IOTInfoList (IoT devices)
    // The XML structure uses <ChannelInfoList><ChannelInfo>...</ChannelInfo></ChannelInfoList>
    // or <IOTInfoList><IOTInfo>...</IOTInfo></IOTInfoList>
    let channelBlocks = getXmlBlocks(xml, "ChannelInfo");
    const iotBlocks = getXmlBlocks(xml, "IOTInfo");

    // Combine both types of blocks
    const allBlocks = [...channelBlocks, ...iotBlocks];

    // Verbose payload; keep it under debug only.
    this.logger.debug?.(`[ReolinkBaichuanApi] cmd_id 145 ChannelInfo push: blocks=${JSON.stringify(allBlocks)}`);

    for (const block of allBlocks) {
      // Extract channel number - cmd_id 145 uses <channelId> not <channel>
      const channelText = getXmlText(block, "channelId") ?? getXmlText(block, "channel") ?? getXmlText(block, "chnID");
      if (!channelText) {
        // this.logger.debug?.(`[ReolinkBaichuanApi] parseAndStoreChannelInfo: block missing channelId, block preview: ${block.substring(0, 200)}`);
        continue;
      }

      const channel = Number.parseInt(channelText, 10);
      if (!Number.isFinite(channel)) {
        // this.logger.debug?.(`[ReolinkBaichuanApi] parseAndStoreChannelInfo: invalid channel number: ${channelText}`);
        continue;
      }

      // Extract fields from ChannelInfo structure
      // Note: cmd_id 145 doesn't include typeInfo/firmVer/boardInfo, but includes devName, uid, state
      const name = (getXmlText(block, "devName") ?? "").trim();
      const uid = (getXmlText(block, "uid") ?? "").trim();
      const state = (getXmlText(block, "state") ?? "").trim();

      const index = (() => {
        const v = (getXmlText(block, "index") ?? "").trim();
        if (!v) return undefined;
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) ? n : undefined;
      })();
      const wifiState = (getXmlText(block, "wifiState") ?? "").trim();
      const networkSegment = (getXmlText(block, "networkSegment") ?? "").trim();
      const changed = (() => {
        const v = (getXmlText(block, "changed") ?? "").trim();
        if (v === "") return undefined;
        const n = Number(v);
        if (Number.isFinite(n)) return n > 0;
        return v !== "0";
      })();
      const abilityChanged = (() => {
        const v = (getXmlText(block, "abilityChanged") ?? "").trim();
        if (v === "") return undefined;
        const n = Number(v);
        if (Number.isFinite(n)) return n > 0;
        return v !== "0";
      })();

      const nowMs = Date.now();
      const existing = this.channelPushData.get(channel);
      const stateLower = state.trim().toLowerCase();

      // Some hubs send a follow-up ChannelInfoList with empty placeholders:
      // <state>none</state> + empty devName/uid + streamSupport=none + index=0.
      // Do NOT let that wipe previously known "connect" entries.
      const loginState = (getXmlText(block, "loginState") ?? "").trim().toLowerCase();
      const streamSupportText = (getXmlText(block, "streamSupport") ?? "").trim().toLowerCase();
      const streamSupport = streamSupportText
        ? streamSupportText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        : undefined;
      const indexText = (getXmlText(block, "index") ?? "").trim();
      const isNonePlaceholder =
        stateLower === "none" &&
        !name &&
        !uid &&
        !loginState &&
        (streamSupportText === "none" || streamSupportText === "") &&
        (indexText === "0" || indexText === "");

      if (isNonePlaceholder) {
        const existingStateLower = (existing?.stateLower ?? existing?.state ?? "").toLowerCase();
        if (existingStateLower === "connect") {
          // Ignore placeholder downgrade.
          continue;
        }
        // Also ignore storing pure placeholders when we have no prior data.
        if (!existing) continue;
      }

      // Online/offline transition (best-effort).
      // Some hubs report connect/none/disconnect; treat connect => online, none/disconnect => offline.
      const inferredOnline: boolean | undefined =
        stateLower === "connect" ? true : stateLower === "none" || stateLower === "disconnect" ? false : undefined;
      if (inferredOnline !== undefined && existing?.online !== inferredOnline) {
        const evt: ReolinkSimpleEvent = {
          type: inferredOnline ? "online" : "offline",
          channel,
          timestamp: nowMs,
        };
        this.dispatchSimpleEvent(evt);
      }

      // Best-effort sleep state.
      // reolink_aio treats cmd_id 145 ChannelInfoList as a sleep status source via <loginState>.
      // Observed: loginState=="standby" => sleeping.
      const prevSleep = existing?.sleeping;

      // Infer sleep from loginState when available, otherwise from state.
      // Observed on some NVR firmwares:
      // - sleeping: state==connect + loginState==standby
      // - awake:    state==connect and loginState omitted
      // - offline/empty slot: state==none
      const inferredSleep: boolean | undefined =
        loginState
          ? loginState === "standby"
          : stateLower === "connect"
            ? false
            : stateLower === "none" || stateLower === "disconnect"
              ? true
              : undefined;

      if (inferredSleep !== undefined) {
        // Forward sleep transitions through the simpleEvent handler.
        // Emit on change (or first observation) to keep noise low.
        if (prevSleep !== inferredSleep) {
          const evt: ReolinkSimpleEvent = {
            type: inferredSleep ? "sleeping" : "awake",
            channel,
            timestamp: nowMs,
          };
          this.dispatchSimpleEvent(evt);
        }
      }

      // this.logger.log('Setting:', channel, name, uid, state, inferredOnline, inferredSleep, loginState);
      this.channelPushData.set(channel, {
        name: name || existing?.name || "",
        uid: uid || existing?.uid || "",
        state: state || existing?.state || "",
        ...(typeof index === "number" ? { index } : existing?.index !== undefined ? { index: existing.index } : {}),
        ...(streamSupport?.length ? { streamSupport } : existing?.streamSupport?.length ? { streamSupport: existing.streamSupport } : {}),
        ...(wifiState ? { wifiState } : existing?.wifiState ? { wifiState: existing.wifiState } : {}),
        ...(networkSegment ? { networkSegment } : existing?.networkSegment ? { networkSegment: existing.networkSegment } : {}),
        ...(typeof changed === "boolean" ? { changed } : existing?.changed !== undefined ? { changed: existing.changed } : {}),
        ...(typeof abilityChanged === "boolean" ? { abilityChanged } : existing?.abilityChanged !== undefined ? { abilityChanged: existing.abilityChanged } : {}),
        ...(stateLower ? { stateLower } : existing?.stateLower ? { stateLower: existing.stateLower } : {}),
        ...(inferredOnline !== undefined ? { online: inferredOnline } : existing?.online !== undefined ? { online: existing.online } : {}),
        ...(inferredSleep !== undefined ? { sleeping: inferredSleep } : existing?.sleeping !== undefined ? { sleeping: existing.sleeping } : {}),
        ...(loginState ? { loginState } : existing?.loginState ? { loginState: existing.loginState } : {}),
        updatedAtMs: nowMs,
      });
    }

    // Only log if we actually stored something new
    if (allBlocks.length > 0) {
      const resultObj: Record<number, any> = {};
      for (const [channel, info] of this.channelPushData.entries()) {
        // keep the log payload small
        if ((info.stateLower ?? info.state).toLowerCase() === "none") continue;
        resultObj[channel] = { name: info.name, uid: info.uid, state: info.state };
      }
      this.logger.debug?.(
        `[ReolinkBaichuanApi] Channel info received by the NVR: ${JSON.stringify({ result: resultObj, storedChannels: Object.keys(resultObj) })}`,
      );
    }
  }

  /**
   * GetChannelInfo via Baichuan: cmd_id 318 (channel-specific DevInfo).
   * 
   * This method extracts channel information similar to CGI GetChnTypeInfo,
   * but using the Baichuan protocol. It returns typeInfo (model), firmwareVersion,
   * and boardInfo if available in the XML response.
   * 
   * Following the Python implementation pattern from reolink_aio.
   */
  async getChannelInfo(
    channel: number,
    options?: {
      timeoutMs?: number;
    },
  ): Promise<{
    typeInfo?: string;
    firmVer?: string;
    firmwareVersion?: string;
    boardInfo?: string;
    pakSuffix?: string;
  }> {
    const req: { cmdId: number; channel: number; timeoutMs?: number } = { cmdId: 318, channel };
    if (options?.timeoutMs != null) req.timeoutMs = options.timeoutMs;
    const xml = await this.sendXml(req);

    // Extract fields similar to CgiChnTypeInfoValue
    // typeInfo can come from <type> tag in Baichuan response
    const typeInfo = getXmlText(xml, "typeInfo") ?? getXmlText(xml, "type");
    const firmVer = getXmlText(xml, "firmVer") ?? getXmlText(xml, "firmwareVersion");
    const firmwareVersion = firmVer || '';
    const boardInfo = getXmlText(xml, "boardInfo");
    const pakSuffix = getXmlText(xml, "pakSuffix");

    return {
      ...(typeInfo ? { typeInfo } : {}),
      ...(firmVer ? { firmVer, firmwareVersion } : {}),
      ...(boardInfo ? { boardInfo } : {}),
      ...(pakSuffix ? { pakSuffix } : {}),
    };
  }

  /**
   * GetAllChannelsInfo via Baichuan: cmd_id 145 (all channels info in a single request).
   * 
   * Note: The NVR sends a message with cmd_id 145 when connecting, but it seems to not allow
   * requesting that id explicitly. This method will return an empty Map, and the caller should
   * fall back to per-channel requests using getChannelInfo (cmd_id 318).
   * 
   * Returns a map of channel number to channel info (typically empty).
   */
  async getAllChannelsInfo(options?: {
    timeoutMs?: number;
  }): Promise<Map<number, {
    typeInfo?: string;
    firmVer?: string;
    firmwareVersion?: string;
    boardInfo?: string;
    pakSuffix?: string;
    name?: string;
  }>> {
    // Try with empty body XML first
    const req: { cmdId: number; payloadXml?: string; timeoutMs?: number } = {
      cmdId: BC_CMD_ID_CHANNEL_INFO_ALL,
      payloadXml: `<?xml version="1.0" encoding="UTF-8" ?><body></body>`
    };
    if (options?.timeoutMs != null) req.timeoutMs = options.timeoutMs;

    let xml = await this.sendXml(req);

    // If empty response, try without body XML
    if (!xml || xml.trim().length === 0) {
      const reqNoBody: { cmdId: number; timeoutMs?: number } = { cmdId: BC_CMD_ID_CHANNEL_INFO_ALL };
      if (options?.timeoutMs != null) reqNoBody.timeoutMs = options.timeoutMs;
      xml = await this.sendXml(reqNoBody);
    }

    // If still empty, the command is likely not supported (NVR sends it but doesn't allow requesting it)
    if (!xml || xml.trim().length === 0) {
      return new Map();
    }

    const result = new Map<number, {
      typeInfo?: string;
      firmVer?: string;
      firmwareVersion?: string;
      boardInfo?: string;
      pakSuffix?: string;
      name?: string;
    }>();

    // The response typically contains multiple channel blocks
    // Try common XML block patterns: <DevInfo>, <ChannelInfo>, <Channel>, etc.
    let channelBlocks = getXmlBlocks(xml, "DevInfo");
    if (channelBlocks.length === 0) {
      channelBlocks = getXmlBlocks(xml, "ChannelInfo");
    }
    if (channelBlocks.length === 0) {
      channelBlocks = getXmlBlocks(xml, "Channel");
    }
    if (channelBlocks.length === 0) {
      channelBlocks = getXmlBlocks(xml, "channel");
    }

    for (const block of channelBlocks) {
      // Try to extract channel number from various possible locations
      const channelText = getXmlText(block, "channel") ??
        getXmlText(block, "channelId") ??
        getXmlText(block, "id");
      const channel = channelText ? Number.parseInt(channelText, 10) : undefined;

      if (channel === undefined || !Number.isFinite(channel)) {
        // If no explicit channel number, try to infer from position or skip
        continue;
      }

      // Extract fields similar to getChannelInfo
      const typeInfo = getXmlText(block, "typeInfo") ?? getXmlText(block, "type");
      const firmVer = getXmlText(block, "firmVer") ?? getXmlText(block, "firmwareVersion");
      const firmwareVersion = firmVer || '';
      const boardInfo = getXmlText(block, "boardInfo");
      const pakSuffix = getXmlText(block, "pakSuffix");
      const name = getXmlText(block, "name");

      result.set(channel, {
        ...(typeInfo ? { typeInfo } : {}),
        ...(firmVer ? { firmVer, firmwareVersion } : {}),
        ...(boardInfo ? { boardInfo } : {}),
        ...(pakSuffix ? { pakSuffix } : {}),
        ...(name ? { name } : {}),
      });
    }

    // If no blocks found with channel numbers, try parsing the XML as a single response
    // and extract channel info from nested structures
    if (result.size === 0) {
      // Fallback: try to find channel info in a different structure
      // Some devices might return a flat structure with channel info embedded
      const allChannels = getXmlBlocks(xml, "body");
      for (const bodyBlock of allChannels) {
        // Look for channel-specific attributes or nested structures
        const channelText = getXmlText(bodyBlock, "channel");
        if (channelText) {
          const channel = Number.parseInt(channelText, 10);
          if (Number.isFinite(channel)) {
            const typeInfo = getXmlText(bodyBlock, "typeInfo") ?? getXmlText(bodyBlock, "type");
            const firmVer = getXmlText(bodyBlock, "firmVer") ?? getXmlText(bodyBlock, "firmwareVersion");
            const firmwareVersion = firmVer || '';
            const boardInfo = getXmlText(bodyBlock, "boardInfo");
            const pakSuffix = getXmlText(bodyBlock, "pakSuffix");
            const name = getXmlText(bodyBlock, "name");

            result.set(channel, {
              ...(typeInfo ? { typeInfo } : {}),
              ...(firmVer ? { firmVer, firmwareVersion } : {}),
              ...(boardInfo ? { boardInfo } : {}),
              ...(pakSuffix ? { pakSuffix } : {}),
              ...(name ? { name } : {}),
            });
          }
        }
      }
    }

    return result;
  }

  /**
   * Convenience helper to get a minimal per-channel identity tuple.
   *
   * Note: the Baichuan DevInfo payload uses <type> as the model string on most firmwares.
   */
  async getChannelIdentity(
    channel: number,
    options?: {
      timeoutMs?: number;
    },
  ): Promise<{ channel: number; model: string; name: string }> {
    const info = await this.getInfo(channel, {
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
      tags: ["type", "name"],
    });
    return {
      channel,
      model: (info.type ?? "").trim(),
      name: (info.name ?? "").trim(),
    };
  }

  /**
   * Read-only snapshot of the cached channel info received via cmd_id 145 push.
   *
   * This cache is populated automatically when the NVR sends channel info on connection.
   */
  getChannelInfoFromPushCache(): Map<number, {
    name: string;
    uid: string;
    state: string;
    index?: number;
    streamSupport?: string[];
    wifiState?: string;
    networkSegment?: string;
    changed?: boolean;
    abilityChanged?: boolean;
    online?: boolean;
    sleeping?: boolean;
    loginState?: string;
    updatedAtMs?: number;
  }> {
    const out = new Map<number, {
      name: string;
      uid: string;
      state: string;
      index?: number;
      streamSupport?: string[];
      wifiState?: string;
      networkSegment?: string;
      changed?: boolean;
      abilityChanged?: boolean;
      online?: boolean;
      sleeping?: boolean;
      loginState?: string;
      updatedAtMs?: number;
    }>();
    for (const [channel, info] of this.channelPushData.entries()) {
      const stateLower = (info.stateLower ?? info.state).toLowerCase();
      if (stateLower === "none") continue;
      out.set(channel, {
        name: info.name,
        uid: info.uid,
        state: info.state,
        ...(typeof info.index === "number" ? { index: info.index } : {}),
        ...(info.streamSupport?.length ? { streamSupport: info.streamSupport } : {}),
        ...(info.wifiState ? { wifiState: info.wifiState } : {}),
        ...(info.networkSegment ? { networkSegment: info.networkSegment } : {}),
        ...(typeof info.changed === "boolean" ? { changed: info.changed } : {}),
        ...(typeof info.abilityChanged === "boolean" ? { abilityChanged: info.abilityChanged } : {}),
        ...(typeof info.online === "boolean" ? { online: info.online } : {}),
        ...(typeof info.sleeping === "boolean" ? { sleeping: info.sleeping } : {}),
        ...(info.loginState ? { loginState: info.loginState } : {}),
        ...(typeof info.updatedAtMs === "number" ? { updatedAtMs: info.updatedAtMs } : {}),
      });
    }
    return out;
  }

  /**
   * Read-only snapshot of the cached sleep state parsed from cmd_id 145 push.
   *
   * Values are boolean when known.
   */
  getChannelSleepFromPushCache(): Map<number, boolean> {
    const out = new Map<number, boolean>();
    for (const [channel, info] of this.channelPushData.entries()) {
      if (typeof info.sleeping === "boolean") out.set(channel, info.sleeping);
    }
    return out;
  }

  /**
   * Minimal per-channel inventory for NVR-connected devices.
   *
   * Intended to be fast: avoids AI/abilities and returns only the common identity + battery hints.
   */
  async getNvrChannelsSummary(options?: {
    channels?: number[];
    timeoutMs?: number;
    source?: "baichuan" | "cgi";
  }): Promise<{
    channels: number[];
    devices: ReolinkBaichuanDeviceSummary[];
  }> {
    const source = options?.source ?? "baichuan";

    const pushInfo = this.getChannelInfoFromPushCache();
    const channels = (options?.channels?.length ? options.channels : Array.from(pushInfo.keys()))
      .map((c) => Number(c))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    const support = await this.getSupportInfo().catch(() => {
      this.logger.error?.("[ReolinkBaichuanApi] getNvrChannelsSummary: failed to get support info");
    });

    const truthyNumberLike = (v: unknown): boolean => {
      if (typeof v === "number") return v > 0;
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n > 0;
        return v.length > 0 && v !== "0";
      }
      return Boolean(v);
    };

    const isBatteryByChannel = new Map<number, boolean>();
    const isDoorbellByChannel = new Map<number, boolean>();
    if (support) {
      for (const ch of channels) {
        const caps = computeDeviceCapabilities({ channel: ch, support });
        isBatteryByChannel.set(ch, Boolean(caps.hasBattery));
        const anySupportDoorbellLight = (support.items ?? []).some(
          (i) => i.chnID === ch && truthyNumberLike((i as any).supportDoorbellLight),
        );
        isDoorbellByChannel.set(ch, Boolean(caps.isDoorbell) || anySupportDoorbellLight);
      }
    }

    const cacheKey = `baichuan:${channels.join(",")}`;
    const cached = this.nvrChannelsSummaryCache.get(cacheKey);
    if (cached) {
      return {
        channels: [...cached.channels],
        devices: cached.devices.map((d) => ({ ...d })),
      };
    }

    const timeoutMs = options?.timeoutMs;
    const infoPerChannel = new Map<number, ReolinkDeviceInfo>();
    const networkInfoPerChannel = new Map<number, ReolinkBaichuanNetworkInfo | undefined>();
    for (const channel of channels) {
      try {
        const info = await this.getInfo(channel, {
          ...(timeoutMs != null ? { timeoutMs } : {}),
          tags: ["type", "name", "serialNumber"],
        });
        infoPerChannel.set(channel, info);

        // const net = await this.getNetworkInfo(channel, {
        //   ...(timeoutMs != null ? { timeoutMs } : {}),
        // });
        // networkInfoPerChannel.set(channel, net);
      } catch {
      }
    }

    const devices = channels.map((channel) => {
      const cached = pushInfo.get(channel);
      const info = infoPerChannel.get(channel);
      const networkInfo = networkInfoPerChannel.get(channel);
      const isBattery = isBatteryByChannel.get(channel) ?? false;
      const isDoorbell = isDoorbellByChannel.get(channel) ?? false;
      const model = info?.type ?? '';

      const normalizedModel = model ? model.trim() : undefined;
      const isMultifocal = normalizedModel ? isDualLenseModel(normalizedModel) : false;

      return {
        channel,
        isBattery,
        isDoorbell,
        isMultifocal,
        model,
        ...(networkInfo?.ip ? { ip: networkInfo.ip } : {}),
        ...(networkInfo?.mac ? { mac: networkInfo.mac } : {}),
        ...(networkInfo?.activeLink ? { activeLink: networkInfo.activeLink } : {}),
        ...(cached?.name ? { name: cached.name } : {}),
        ...(cached?.uid ? { uid: cached.uid } : {}),
        ...(cached?.state ? { state: cached.state } : {}),
        ...(typeof cached?.index === "number" ? { index: cached.index } : {}),
        ...(cached?.streamSupport?.length ? { streamSupport: cached.streamSupport } : {}),
        ...(cached?.wifiState ? { wifiState: cached.wifiState } : {}),
        ...(cached?.networkSegment ? { networkSegment: cached.networkSegment } : {}),
        ...(typeof cached?.changed === "boolean" ? { changed: cached.changed } : {}),
        ...(typeof cached?.abilityChanged === "boolean" ? { abilityChanged: cached.abilityChanged } : {}),
        ...(typeof cached?.online === "boolean" ? { online: cached.online } : {}),
        ...(typeof cached?.sleeping === "boolean" ? { sleeping: cached.sleeping } : {}),
        ...(cached?.loginState ? { loginState: cached.loginState } : {}),
        ...(typeof cached?.updatedAtMs === "number" ? { updatedAtMs: cached.updatedAtMs } : {}),
      };
    });

    const result = { channels, devices };
    this.nvrChannelsSummaryCache.set(cacheKey, {
      channels: [...channels],
      devices: devices.map((d) => ({ ...d })),
    });
    return result;
  }

  /**
   * Group NVR/HUB channels by physical device (best-effort).
   *
   * Heuristics:
   * - Primary key: channel UID from cmd_id 145 push cache.
   * - Secondary key: per-channel serialNumber from getInfo(channel).
   * - Multifocal: group has 2+ channels OR model name matches known dual-lens patterns.
   */
  async getNvrDeviceGroups(options?: {
    channels?: number[];
    timeoutMs?: number;
  }): Promise<{
    channels: number[];
    groups: ReolinkNvrDeviceGroupSummary[];
    /** Map channel -> group key. */
    channelToGroup: Record<number, string>;
  }> {
    const { channels, devices } = await this.getNvrChannelsSummary(options);

    const looksLikeDualLensModel = (model?: string): boolean => {
      const m = (model ?? "").trim();
      if (!m) return false;
      if (DUAL_LENS_MODELS.has(m)) return true;
      const lower = m.toLowerCase();
      // Keyword heuristics (covers variations and suffixes)
      if (lower.includes("trackmix")) return true;
      if (lower.includes("duo")) return true;
      // Some firmwares report generic types; keep this conservative.
      return false;
    };

    type MutableGroup = Omit<ReolinkNvrDeviceGroupSummary, "channels" | "isMultifocal" | "reason"> & {
      channels: number[];
      modelSet: Set<string>;
      nameSet: Set<string>;
    };

    const groupsByKey = new Map<string, MutableGroup>();
    const serialToKey = new Map<string, string>();
    const channelToGroup: Record<number, string> = {};

    const getOrCreate = (key: string): MutableGroup => {
      let g = groupsByKey.get(key);
      if (!g) {
        g = { key, channels: [], modelSet: new Set(), nameSet: new Set() };
        groupsByKey.set(key, g);
      }
      return g;
    };

    for (const d of devices) {
      const uid = (d.uid ?? "").trim() || undefined;
      const serial = (d.serialNumber ?? "").trim() || undefined;
      const model = (d.model ?? "").trim() || undefined;
      const name = (d.name ?? "").trim() || undefined;

      // Prefer grouping by UID, but allow serial to merge channels when UID is missing.
      let key = uid ? `uid:${uid}` : serial ? `sn:${serial}` : `ch:${d.channel}`;
      if (!uid && serial) {
        const existing = serialToKey.get(serial);
        if (existing) key = existing;
      }

      const g = getOrCreate(key);
      if (!g.channels.includes(d.channel)) g.channels.push(d.channel);
      if (!g.uid && uid) g.uid = uid;
      if (!g.serialNumber && serial) g.serialNumber = serial;
      if (model) g.modelSet.add(model);
      if (name) g.nameSet.add(name);

      // If we have a serial and this group is a UID-group, remember it for later merges.
      if (serial) serialToKey.set(serial, key);
      channelToGroup[d.channel] = key;
    }

    const finalizeModel = (g: MutableGroup): string | undefined => {
      if (g.modelSet.size === 1) return Array.from(g.modelSet)[0];
      // Prefer any model that looks like dual lens.
      for (const m of g.modelSet) {
        if (looksLikeDualLensModel(m)) return m;
      }
      return g.modelSet.size ? Array.from(g.modelSet)[0] : undefined;
    };

    const finalizeName = (g: MutableGroup): string | undefined => {
      if (g.nameSet.size === 1) return Array.from(g.nameSet)[0];
      return g.nameSet.size ? Array.from(g.nameSet)[0] : undefined;
    };

    const groups: ReolinkNvrDeviceGroupSummary[] = Array.from(groupsByKey.values())
      .map((g) => {
        g.channels.sort((a, b) => a - b);
        const name = finalizeName(g);
        const model = finalizeModel(g);
        const isMultifocal = g.channels.length > 1 || looksLikeDualLensModel(model);
        const reason =
          g.channels.length > 1
            ? `shared ${g.uid ? "uid" : g.serialNumber ? "serial" : "identity"} across ${g.channels.length} channels`
            : looksLikeDualLensModel(model)
              ? "model match (dual-lens keyword)"
              : "single-channel device";
        return {
          key: g.key,
          ...(g.uid ? { uid: g.uid } : {}),
          ...(g.serialNumber ? { serialNumber: g.serialNumber } : {}),
          ...(name ? { name } : {}),
          ...(model ? { model } : {}),
          channels: g.channels,
          isMultifocal,
          reason,
        };
      })
      .sort((a, b) => (a.channels[0] ?? 0) - (b.channels[0] ?? 0));

    return { channels, groups, channelToGroup };
  }

  /** GetEnc via Baichuan: cmd_id 56 (returns raw XML). */
  async getEncXml(channel?: number, options?: { timeoutMs?: number }): Promise<string> {
    const ch = this.normalizeChannel(channel);
    return await this.sendXml({ cmdId: 56, channel: ch, ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}) });
  }

  /**
   * GetStreamMetadata via Baichuan: cmd_id 56 (GetEnc).
   * Returns metadata for all available streams (main, sub, ext) including:
   * - Video codec (H.264, H.265, etc.)
   * - Resolution (width x height)
   * - Frame rate (FPS)
   * - Bitrate
   * - Audio enabled
   * 
   * Note on extStream:
   * - extStream is only present in the XML response if it's enabled/supported by the camera
   * - If extStream is not present in the XML, it means it's not available for that channel
   * - extStream availability is determined by the camera firmware/model capabilities
   * - There's no explicit "enable" field for extStream in the GetEnc response
   * - extStream is typically available on newer Reolink models that support multiple stream profiles
   */
  async getStreamMetadata(channel?: number): Promise<ChannelStreamMetadata> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.getEncXml(ch);
    const streams: StreamMetadata[] = [];
    let audioEnabled = true;

    const dbg = this.client.getDebugConfig?.();
    const traceNativeStream = dbg?.traceNativeStream === true;

    // Some firmwares include placeholder stream sections (not actually supported)
    // with 0x0 resolution and/or 0 FPS/bitrate. Treat those as unavailable.
    const isPlausibleStream = (s: { width: number; height: number; frameRate: number; bitRate: number }): boolean => {
      return s.width > 0 && s.height > 0 && (s.frameRate > 0 || s.bitRate > 0);
    };

    const logDebugStreamBlock = (tag: string, blockXml: string | undefined) => {
      if (!traceNativeStream) return;

      if (!blockXml) {
        (this.logger.warn ?? this.logger.log).call(this.logger, `[ReolinkBaichuanApi] getStreamMetadata(traceNativeStream): channel=${ch} tag=<${tag}> missing`);
        return;
      }

      const raw = blockXml;
      const widthText = getXmlText(raw, "width") ?? getXmlText(raw, "Width");
      const heightText = getXmlText(raw, "height") ?? getXmlText(raw, "Height");
      const frameText = getXmlText(raw, "frame") ?? getXmlText(raw, "Frame");
      const bitRateText = getXmlText(raw, "bitRate") ?? getXmlText(raw, "BitRate");
      const videoEncTypeText = getXmlText(raw, "videoEncType") ?? getXmlText(raw, "VideoEncType");
      const audioText = getXmlText(raw, "audio") ?? getXmlText(raw, "Audio");
      const enableText = getXmlText(raw, "enable") ?? getXmlText(raw, "Enable");

      const width = Number(widthText ?? "0");
      const height = Number(heightText ?? "0");
      const frameRate = Number(frameText ?? "0");
      const bitRate = Number(bitRateText ?? "0");
      const audio = Number(audioText ?? "0");
      const isEnabled = enableText === undefined || enableText === "1" || enableText === "true";
      const plausible = isEnabled && isPlausibleStream({ width, height, frameRate, bitRate });

      const previewMax = 1400;
      const xmlPreview = raw.length <= previewMax ? raw : raw.slice(0, previewMax) + `\n...truncated (+${raw.length - previewMax} chars)`;

      (this.logger.warn ?? this.logger.log).call(this.logger,
        `[ReolinkBaichuanApi] getStreamMetadata(traceNativeStream): channel=${ch} tag=<${tag}> ` +
        `enabled=${isEnabled} plausible=${plausible} ` +
        `width=${width} height=${height} frame=${frameRate} bitRate=${bitRate} audio=${audio} videoEncType=${videoEncTypeText ?? "?"} ` +
        `rawFields=${JSON.stringify({ widthText, heightText, frameText, bitRateText, videoEncTypeText, audioText, enableText })} ` +
        `blockXml=${JSON.stringify(xmlPreview)}`
      );
    };

    if (traceNativeStream) {
      const headMax = 1600;
      const xmlHead = xml.length <= headMax ? xml : xml.slice(0, headMax) + `\n...truncated (+${xml.length - headMax} chars)`;
      const tagsPresent = {
        mainStream: /<mainStream\b/.test(xml),
        subStream: /<subStream\b/.test(xml),
        extStream: /<extStream\b/.test(xml),
        thirdStream: /<thirdStream\b/.test(xml),
        externStream: /<externStream\b/.test(xml),
        extraStream: /<extraStream\b/.test(xml),
      };
      (this.logger.warn ?? this.logger.log).call(this.logger,
        `[ReolinkBaichuanApi] getStreamMetadata(traceNativeStream): channel=${ch} xmlLen=${xml.length} tagsPresent=${JSON.stringify(tagsPresent)} xmlHead=${JSON.stringify(xmlHead)}`
      );
    }

    // Video encoding type mapping
    const videoCodecMap: Record<number, VideoCodec> = {
      0: "H.264",
      1: "H.265",
      2: "MJPEG",
      3: "MPEG4",
    };

    // Parse mainStream
    const mainMatch = xml.match(/<mainStream[^>]*>([\s\S]*?)<\/mainStream>/);
    if (mainMatch) {
      const mainXml = mainMatch[1] ?? "";
      logDebugStreamBlock("mainStream", mainXml);
      const width = Number(getXmlText(mainXml, "width") ?? "0");
      const height = Number(getXmlText(mainXml, "height") ?? "0");
      const videoEncTypeInt = Number(getXmlText(mainXml, "videoEncType") ?? "0");
      const frameRate = Number(getXmlText(mainXml, "frame") ?? "0");
      const bitRate = Number(getXmlText(mainXml, "bitRate") ?? "0");
      const audio = Number(getXmlText(mainXml, "audio") ?? "0");
      // Check if mainStream has an enable field (some cameras may have this)
      const enabled = getXmlText(mainXml, "enable");
      const isEnabled = enabled === undefined || enabled === "1" || enabled === "true";

      if (isEnabled && isPlausibleStream({ width, height, frameRate, bitRate })) {
        streams.push({
          profile: "main",
          audio,
          width,
          height,
          videoEncType: videoCodecMap[videoEncTypeInt] ?? `Unknown(${videoEncTypeInt})`,
          videoEncTypeInt,
          frameRate,
          bitRate,
          audioCodec: 'aac'
        });
        audioEnabled = audioEnabled && audio === 1;
      }
    }

    // Parse subStream
    const subMatch = xml.match(/<subStream[^>]*>([\s\S]*?)<\/subStream>/);
    if (subMatch) {
      const subXml = subMatch[1] ?? "";
      logDebugStreamBlock("subStream", subXml);
      const width = Number(getXmlText(subXml, "width") ?? "0");
      const height = Number(getXmlText(subXml, "height") ?? "0");
      const videoEncTypeInt = Number(getXmlText(subXml, "videoEncType") ?? "0");
      const frameRate = Number(getXmlText(subXml, "frame") ?? "0");
      const bitRate = Number(getXmlText(subXml, "bitRate") ?? "0");
      const audio = Number(getXmlText(subXml, "audio") ?? "0");
      // Check if subStream has an enable field
      const enabled = getXmlText(subXml, "enable");
      const isEnabled = enabled === undefined || enabled === "1" || enabled === "true";

      if (isEnabled && isPlausibleStream({ width, height, frameRate, bitRate })) {
        streams.push({
          profile: "sub",
          audio,
          width,
          height,
          videoEncType: videoCodecMap[videoEncTypeInt] ?? `Unknown(${videoEncTypeInt})`,
          videoEncTypeInt,
          frameRate,
          bitRate,
          audioCodec: 'aac'
        });
        audioEnabled = audioEnabled && audio === 1;
      }
    }

    // Parse ext-like stream (if available).
    // Some firmwares use <thirdStream> (or other variants) instead of <extStream>.
    // We treat these as an alias for the public "ext" profile.
    const extLikeTags = ["extStream", "thirdStream", "externStream", "extraStream"];
    for (const tag of extLikeTags) {
      const extMatch = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      if (!extMatch) continue;

      const extXml = extMatch[1] ?? "";
      logDebugStreamBlock(tag, extXml);
      const width = Number(getXmlText(extXml, "width") ?? "0");
      const height = Number(getXmlText(extXml, "height") ?? "0");
      const videoEncTypeInt = Number(getXmlText(extXml, "videoEncType") ?? "0");
      const frameRate = Number(getXmlText(extXml, "frame") ?? "0");
      const bitRate = Number(getXmlText(extXml, "bitRate") ?? "0");
      const audio = Number(getXmlText(extXml, "audio") ?? "0");
      const enabled = getXmlText(extXml, "enable");
      const isEnabled = enabled === undefined || enabled === "1" || enabled === "true";

      if (isEnabled && isPlausibleStream({ width, height, frameRate, bitRate })) {
        streams.push({
          profile: "ext",
          audio,
          width,
          height,
          videoEncType: videoCodecMap[videoEncTypeInt] ?? `Unknown(${videoEncTypeInt})`,
          videoEncTypeInt,
          frameRate,
          bitRate,
          audioCodec: 'aac'
        });
        audioEnabled = audioEnabled && audio === 1;
      }

      // Only one ext-like stream is expected; stop after the first match.
      break;
    }

    return {
      channel: ch,
      streams,
      audioEnabled,
    };
  }

  /** SetEnc via Baichuan: cmd_id 57 (sends raw XML). */
  async setEncXml(encXml: string): Promise<void>;
  async setEncXml(channel: number, encXml: string): Promise<void>;
  async setEncXml(channelOrEncXml: number | string, encXmlMaybe?: string): Promise<void> {
    const ch = typeof channelOrEncXml === "number" ? this.normalizeChannel(channelOrEncXml) : 0;
    const encXml = typeof channelOrEncXml === "number" ? encXmlMaybe! : channelOrEncXml;
    await this.sendXml({ cmdId: 57, channel: ch, payloadXml: encXml });
  }

  /**
   * Update the encoder codec for a given stream profile (main/sub/ext).
   *
   * NOTE: This changes the camera configuration.
   * Many models may require a short delay (or stream restart) before the new codec is used.
   */
  async setStreamVideoCodec(profile: StreamProfile, codec: "H.264" | "H.265", channel?: number): Promise<void>;
  async setStreamVideoCodec(channel: number, profile: StreamProfile, codec: "H.264" | "H.265"): Promise<void>;
  async setStreamVideoCodec(
    channelOrProfile: number | StreamProfile,
    profileOrCodec: StreamProfile | ("H.264" | "H.265"),
    codecOrChannel?: ("H.264" | "H.265") | number
  ): Promise<void> {
    const ch = typeof channelOrProfile === "number" ? this.normalizeChannel(channelOrProfile) : this.normalizeChannel(codecOrChannel as number | undefined);
    const profile = typeof channelOrProfile === "number" ? (profileOrCodec as StreamProfile) : channelOrProfile;
    const codec = typeof channelOrProfile === "number" ? (codecOrChannel as "H.264" | "H.265") : (profileOrCodec as "H.264" | "H.265");
    const desired = codec === "H.265" ? 1 : 0;

    const candidateTags =
      profile === "main"
        ? ["mainStream"]
        : profile === "sub"
          ? ["subStream"]
          : ["extStream", "thirdStream", "externStream", "extraStream"];

    const current = await this.getEncXml(ch);

    let updated: string | null = null;
    for (const tag of candidateTags) {
      const sectionRe = new RegExp(`(<${tag}[^>]*>[\\s\\S]*?<videoEncType>)(\\d+)(</videoEncType>)`);
      if (!sectionRe.test(current)) continue;
      const next = current.replace(sectionRe, `$1${desired}$3`);
      if (next !== current) {
        updated = next;
        break;
      }
    }

    if (!updated) {
      throw new Error(
        `Could not find <videoEncType> for profile=${profile} (tags=${candidateTags.join(",")}) in GetEnc XML (channel=${ch}).`,
      );
    }

    await this.setEncXml(ch, updated);
  }

  /** Bulk SetNetPort helper: accepts NetPort with onvifEnable/rtmpEnable/rtspEnable. */
  async setNetPort(netPort: { onvifEnable?: number; rtmpEnable?: number; rtspEnable?: number }): Promise<void> {
    if (netPort.onvifEnable != null) await this.setPortEnabled({ port: "onvif", enable: netPort.onvifEnable === 1 });
    if (netPort.rtmpEnable != null) await this.setPortEnabled({ port: "rtmp", enable: netPort.rtmpEnable === 1 });
    if (netPort.rtspEnable != null) await this.setPortEnabled({ port: "rtsp", enable: netPort.rtspEnable === 1 });
  }

  /** Reboot via Baichuan: cmd_id 23 */
  async reboot(channel?: number): Promise<void> {
    const req: { cmdId: number; channel?: number } = { cmdId: 23 };
    if (channel !== undefined) req.channel = channel;
    await this.sendXml(req);
  }

  /** Ping via Baichuan: cmd_id 93 (header-only / no payload) */
  async ping(): Promise<void> {
    await this.sendXml({ cmdId: 93 });
  }

  /**
   * Best-effort network info via Baichuan.
   *
   * Behavior aligned with common Reolink firmwares:
   * - cmd_id 76 often returns <ip>/<mac> (especially on NVR/Hub)
   * - when querying host (no channel), some firmwares only populate link details after a cmd_id 93 ping
   * - fallback to cmd_id 104 (GetGeneralXml) when 76 is unsupported/empty
   */
  async getNetworkInfo(
    channel?: number,
    options?: {
      timeoutMs?: number;
    },
  ): Promise<ReolinkBaichuanNetworkInfo | undefined> {
    const timeoutMs = options?.timeoutMs ?? 1200;

    const trim = (v: unknown): string | undefined => {
      if (typeof v !== "string") return undefined;
      const t = v.trim();
      return t ? t : undefined;
    };

    const parse = (xml?: string): ReolinkBaichuanNetworkInfo | undefined => {
      if (!xml) return undefined;
      const ip =
        trim(getXmlText(xml, "ip")) ||
        trim(getXmlText(xml, "IP")) ||
        trim(getXmlText(xml, "ipv4")) ||
        trim(getXmlText(xml, "IPv4")) ||
        undefined;
      const mac = trim(getXmlText(xml, "mac")) || trim(getXmlText(xml, "MAC")) || undefined;
      const activeLink =
        trim(getXmlText(xml, "activeLink")) ||
        trim(getXmlText(xml, "type")) ||
        trim(getXmlText(xml, "linkType")) ||
        undefined;
      return ip || mac || activeLink
        ? { ...(ip ? { ip } : {}), ...(mac ? { mac } : {}), ...(activeLink ? { activeLink } : {}) }
        : undefined;
    };

    const merge = (a?: ReolinkBaichuanNetworkInfo, b?: ReolinkBaichuanNetworkInfo): ReolinkBaichuanNetworkInfo | undefined => {
      if (!a && !b) return undefined;
      return {
        ...(a?.ip ? { ip: a.ip } : b?.ip ? { ip: b.ip } : {}),
        ...(a?.mac ? { mac: a.mac } : b?.mac ? { mac: b.mac } : {}),
        ...(a?.activeLink ? { activeLink: a.activeLink } : b?.activeLink ? { activeLink: b.activeLink } : {}),
      };
    };

    if (channel === undefined) {
      // Host-level: cmd 76 then cmd 93 ping (some firmwares only fill link details after ping).
      let xml76: string | undefined;
      let xml93: string | undefined;

      try {
        xml76 = await this.sendXml({ cmdId: 76, timeoutMs });
      } catch {
        // ignore
      }

      try {
        xml93 = await this.sendXml({ cmdId: 93, timeoutMs });
      } catch {
        // ignore
      }

      const merged = merge(parse(xml76), parse(xml93));
      if (merged) return merged;

      try {
        const xml = await this.getGeneralXml();
        return parse(xml);
      } catch {
        return undefined;
      }
    }

    const ch = this.normalizeChannel(channel);
    try {
      const xml = await this.sendXml({ cmdId: 76, channel: ch, timeoutMs });
      const parsed = parse(xml);
      if (parsed) return parsed;
    } catch {
      // ignore
    }

    try {
      const xml = await this.getGeneralXml(ch);
      return parse(xml);
    } catch {
      return undefined;
    }
  }

  /** GetLocalLink via Baichuan: cmd_id 104 (general info) - on many models includes MAC/network info. */
  async getGeneralXml(channel?: number): Promise<string> {
    const req: { cmdId: number; channel?: number } = { cmdId: 104 };
    if (channel !== undefined) req.channel = channel;
    return await this.sendXml(req);
  }

  /** SetGeneralXml via Baichuan: cmd_id 105 */
  async setGeneralXml(xml: string): Promise<void>;
  async setGeneralXml(channel: number | undefined, xml: string): Promise<void>;
  async setGeneralXml(channelOrXml: number | string | undefined, xmlMaybe?: string): Promise<void> {
    const channel = typeof channelOrXml === "number" || channelOrXml === undefined ? channelOrXml : undefined;
    const xml = typeof channelOrXml === "string" ? channelOrXml : xmlMaybe!;
    await this.sendXml({ cmdId: 105, ...(channel === undefined ? {} : { channel }), payloadXml: xml });
  }

  /** Helper to build a channel Extension XML (for payloads that require it). */
  static buildChannelExtensionXml(channel: number): string {
    return `<?xml version="1.0" encoding="UTF-8" ?>` + `<Extension version="1.1"><channelId>${xmlEscape(String(channel))}</channelId></Extension>`;
  }

  // --------------------
  // New API implementations (cmd_id to be identified/tested)
  // --------------------

  /**
   * GetMotionState via Baichuan.
   * cmd_id: 46 (GetMdAlarm)
   * Returns true if motion detection is enabled.
   */
  async getMotionState(channel?: number): Promise<boolean> {
    const cmdId = 46; // GetMdAlarm
    const xml = await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
    // Parse XML to extract motion state from sensInfoNew
    // Expected format: <sensInfoNew><enable>1</enable>...</sensInfoNew>
    const enable = getXmlText(xml, "enable");
    return enable === "1" || enable === "true";
  }

  /**
   * GetOsd via Baichuan.
   * cmd_id: 26 (GetImage - includes OSD settings)
   */
  async getOsd(channel?: number): Promise<OsdConfig> {
    const ch = this.normalizeChannel(channel);
    const cmdId = 26; // GetImage (includes OSD)
    const xml = await this.sendXml({ cmdId, channel: ch });
    // Parse OSD XML structure from VideoInput/OsdChannel and OsdTime
    // This is a placeholder - actual parsing depends on XML structure
    return {
      channel: ch,
      osdChannel: {
        enable: Number(getXmlText(xml, "enable") ?? "0"),
        name: getXmlText(xml, "name") ?? "",
        pos: getXmlText(xml, "pos") ?? "",
      },
      osdTime: {
        enable: Number(getXmlText(xml, "timeEnable") ?? "0"),
        pos: getXmlText(xml, "timePos") ?? "",
      },
      watermark: Number(getXmlText(xml, "watermark") ?? "0"),
    };
  }

  /**
   * SetOsd via Baichuan.
   * cmd_id: 25 (SetImage - includes OSD settings)
   */
  async setOsd(osd: OsdConfig, channel?: number): Promise<void>;
  async setOsd(channel: number, osd: OsdConfig): Promise<void>;
  async setOsd(channelOrOsd: number | OsdConfig, osdMaybe?: OsdConfig | number): Promise<void> {
    const ch = typeof channelOrOsd === "number" ? this.normalizeChannel(channelOrOsd) : this.normalizeChannel(osdMaybe as number | undefined);
    const osd = typeof channelOrOsd === "number" ? (osdMaybe as OsdConfig) : channelOrOsd;
    const cmdId = 25; // SetImage (includes OSD)
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<Osd version="1.1">` +
      `<channel>${ch}</channel>` +
      `<osdChannel>` +
      `<enable>${osd.osdChannel.enable}</enable>` +
      `<name>${xmlEscape(osd.osdChannel.name)}</name>` +
      `<pos>${xmlEscape(osd.osdChannel.pos)}</pos>` +
      `</osdChannel>` +
      `<osdTime>` +
      `<enable>${osd.osdTime.enable}</enable>` +
      `<pos>${xmlEscape(osd.osdTime.pos)}</pos>` +
      `</osdTime>` +
      `<watermark>${osd.watermark}</watermark>` +
      `</Osd>` +
      `</body>`;
    await this.sendXml({ cmdId, channel: ch, payloadXml: xml });
  }

  /**
   * GetAiState via Baichuan.
   * cmd_id: 342 (GetAiAlarm)
   * Note: GetAiAlarm requires ai_type parameter, this is a simplified wrapper
   */
  async getAiState(channel?: number): Promise<AIState> {
    const cmdId = 342; // GetAiAlarm
    const ch = this.normalizeChannel(channel);

    // NOTE: Many firmwares require an explicit ai type for cmd 342.
    // Correct payload: <AiDetectCfg><chn>0-based</chn><type>people</type></AiDetectCfg>
    // NVR/HomeHub firmwares often use 0-based header channel id.
    const candidateTypes = ["people", "vehicle", "dog_cat", "face", "package"]; // best-effort
    let lastErr: unknown;

    const looksLikeConnectionDrop = (e: unknown): boolean => {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as any).message)
          : String(e ?? "");
      return (
        msg.includes("ECONNRESET") ||
        msg.includes("EPIPE") ||
        msg.includes("socket hang up") ||
        msg.includes("Baichuan socket closed") ||
        msg.includes("timeout")
      );
    };

    const tryOnce = async (type: string, channelIdOverride?: number): Promise<string> => {
      const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>` +
        `<body>` +
        `<AiDetectCfg version="1.1">` +
        `<chn>${ch}</chn>` +
        `<type>${xmlEscape(type)}</type>` +
        `</AiDetectCfg>` +
        `</body>`;

      return await this.sendXml({
        cmdId,
        channel: ch,
        payloadXml,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
      }, 0);
    };

    // 1) Try header channelId (0-based) first.
    for (const type of candidateTypes) {
      try {
        const xml = await tryOnce(type, ch);
        if (xml) {
          return {
            channel: ch,
            alarm_state: Number(getXmlText(xml, "alarm_state") ?? "0"),
            support: Number(getXmlText(xml, "support") ?? "0"),
          };
        }
      } catch (e) {
        if (looksLikeConnectionDrop(e)) throw e;
        lastErr = e;
      }
    }

    // 2) Fallback to default client behavior.
    for (const type of candidateTypes) {
      try {
        const xml = await tryOnce(type, undefined);
        if (xml) {
          return {
            channel: ch,
            alarm_state: Number(getXmlText(xml, "alarm_state") ?? "0"),
            support: Number(getXmlText(xml, "support") ?? "0"),
          };
        }
      } catch (e) {
        if (looksLikeConnectionDrop(e)) throw e;
        lastErr = e;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "getAiState failed"));
  }

  /**
   * GetSnapshot via Baichuan (binary response).
   * cmd_id: 109 (snapshot)
   * Returns JPEG image as Buffer.
   * Note: Snapshot uses a special message ID system for binary responses
   */
  async getSnapshot(
    channel?: number,
    options?: {
      /** Native variant for dual-lens models (default=wide; autotrack/telephoto=tele lens). */
      variant?: NativeVideoStreamVariant;
      /** True when behind NVR/Hub (tele lens is exposed via logic-channel/variant). */
      onNvr?: boolean;
      /** Composite snapshot options for multifocal cameras (PiP). Used when channel is undefined. */
      compositeOptions?: CompositeStreamPipOptions;
      /** Snapshot stream type (quality). Default: "main". */
      streamType?: "main" | "sub";
      timeoutMs?: number;
    },
  ): Promise<Buffer> {
    const cmdId = 109;

    // Composite snapshot for multifocal devices: channel=undefined indicates "composite".
    // The plugin passes PiP config via compositeOptions.
    if (channel === undefined) {
      const composite = options?.compositeOptions;
      const widerChannel = composite?.widerChannel ?? 0;
      const teleChannel = composite?.teleChannel ?? 1;
      const pipPosition = composite?.pipPosition ?? "bottom-right";
      const pipSizeRaw = Number(composite?.pipSize ?? 0.25);
      const pipSize = Math.min(0.9, Math.max(0.05, Number.isFinite(pipSizeRaw) ? pipSizeRaw : 0.25));
      const onNvr = (options?.onNvr === true) || (composite?.onNvr === true);
      const streamType: "main" | "sub" = options?.streamType ?? "main";
      const timeoutMs = options?.timeoutMs ?? 15_000;

      // Wide snapshot (always default lens).
      const wide = await this.getSnapshot(widerChannel, {
        onNvr,
        variant: "default",
        streamType,
        timeoutMs,
      });

      // Tele snapshot:
      // - direct device: tele is often exposed as a separate channel
      // - NVR/Hub TrackMix: tele is NOT a separate channel; it is selected via variant/logicChannel
      const teleChannelEffective = onNvr ? widerChannel : teleChannel;
      const tele = await this.getSnapshot(teleChannelEffective, {
        onNvr,
        variant: onNvr ? "telephoto" : "default",
        streamType,
        timeoutMs,
      });

      const wideMeta = await sharp(wide, { failOn: "none" }).metadata();
      const teleMeta = await sharp(tele, { failOn: "none" }).metadata();

      const mainW = wideMeta.width ?? 0;
      const mainH = wideMeta.height ?? 0;
      if (mainW <= 0 || mainH <= 0) {
        // If we can't determine dimensions, return wide snapshot.
        return wide;
      }

      const pipMarginPx = resolvePipMarginPx(mainW, mainH, composite?.pipMargin, 10);

      const teleW = teleMeta.width ?? 0;
      const teleH = teleMeta.height ?? 0;
      const teleAspect = teleW > 0 && teleH > 0 ? teleW / teleH : 16 / 9;

      // PIP size is defined as a fraction of the OUTPUT (wide) snapshot.
      let pipW = Math.max(1, Math.floor(mainW * pipSize));
      let pipH = Math.max(1, Math.floor(pipW / teleAspect));

      // Constrain by height too (keeps consistent visual size).
      const maxPipHeight = Math.max(1, Math.floor(mainH * pipSize));
      if (pipH > maxPipHeight) {
        pipH = maxPipHeight;
        pipW = Math.max(1, Math.floor(pipH * teleAspect));
      }

      // Clamp to image bounds.
      pipW = Math.min(pipW, mainW);
      pipH = Math.min(pipH, mainH);

      const { left, top } = calculatePipOverlayPosition({
        position: pipPosition,
        mainWidth: mainW,
        mainHeight: mainH,
        pipWidth: pipW,
        pipHeight: pipH,
        margin: pipMarginPx,
      });

      const pip = await sharp(tele, { failOn: "none" })
        .resize({ width: pipW, height: pipH, fit: "fill" })
        .toBuffer();

      return await sharp(wide, { failOn: "none" })
        .composite([{ input: pip, left, top }])
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
    }

    // Regular snapshot for single channel
    const ch = channel !== undefined ? this.normalizeChannel(channel) : 0;
    const variant: NativeVideoStreamVariant = options?.variant ?? "default";
    const onNvr = options?.onNvr === true;
    const streamType: "main" | "sub" = options?.streamType ?? "main";
    const timeoutMs = options?.timeoutMs ?? 15_000;

    // On NVR/Hub firmwares, cmd_id=109 is annoyingly inconsistent:
    // - some accept header channelId as the NVR channel (0-based, PCAP-observed)
    // - others only accept a fixed "master" channelId (often 0), and use the XML <channelId> to select the camera
    // - logicChannel meaning varies (sometimes lens index, sometimes the NVR channel itself)
    //
    // To keep snapshots working for channel>1, we try a small prioritized set of combinations on NVR.
    const buildSnapXml = (params: { channelIdTag: number; logicChannel: number }) =>
      `<body><Snap version="1.1"><channelId>${params.channelIdTag}</channelId><logicChannel>${params.logicChannel}</logicChannel><time>0</time><fullFrame>0</fullFrame><streamType>${streamType}</streamType></Snap></body>`;

    await this.client.login();

    // IMPORTANT: the Snap request Extension must NOT include <binaryData>1</binaryData>.
    // The binary chunks in response will have <binaryData>1</binaryData> in their Extension.
    // Delegate to the client binary handler. cmdId=109 (snapshot) is special and is delivered via push frames.
    //
    // NVR/Hub firmware differences:
    // - some expect channelId tags/header channelId to be 0-based (PCAP-observed)
    // - others expect 1-based. Try both when onNvr.
    if (onNvr) {
      const channelIdTagCandidates = [ch, ch + 1];
      const logicChannelCandidates =
        variant === "default"
          ? [ch, 0] // wide: some firmwares want logicChannel == camera channel
          : [1]; // tele/autotrack: generally logicChannel=1

      // Try header overrides in priority order. Many NVRs accept only header channelId=0 for snapshots.
      const headerChannelIdOverrideCandidates: Array<number | undefined> = [0, ch, undefined];

      let lastErr: unknown;
      for (const headerChannelIdOverride of headerChannelIdOverrideCandidates) {
        for (const channelIdTag of channelIdTagCandidates) {
          for (const lc of logicChannelCandidates) {
            try {
              return await this.client.sendBinary({
                cmdId,
                channel: ch,
                ...(headerChannelIdOverride !== undefined ? { channelIdOverride: headerChannelIdOverride } : {}),
                payloadXml: buildSnapXml({ channelIdTag, logicChannel: lc }),
                extensionXml: buildChannelExtensionXml(channelIdTag),
                timeoutMs,
              });
            } catch (e) {
              lastErr = e;
            }
          }
        }
      }

      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "getSnapshot failed"));
    }

    return await this.client.sendBinary({
      cmdId,
      channel: ch,
      payloadXml: buildSnapXml({ channelIdTag: ch, logicChannel: ch }),
      extensionXml: buildChannelExtensionXml(ch),
      timeoutMs,
    });
  }

  /**
   * List camera recordings via Baichuan FileInfoList.
   *
   * Flow:
   * - cmdId=14: open search -> returns <handle>
   * - cmdId=15: get page(s) -> returns file list and optional <bFinished>
   * - cmdId=16: close handle
   */
  async listRecordings(params: ListRecordingsParams): Promise<RecordingFile[]> {
    // Enqueue the operation to prevent concurrent calls that crash the socket
    return await this.enqueueRecordingsOperation(async () => {
      const dbg = this.client.getDebugConfig?.();
      const logger = this.logger;

      try {
        recordingsTraceLog(dbg, logger, "listRecordings", `Init recordings lookup: ${JSON.stringify(params)}`);


        const channel = this.normalizeChannel(params.channel);
        const uid = params.uid;
        const streamType = params.streamType ?? "mainStream";
        const recordType =
          params.recordType ?? "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package";
        const maxIterations = params.maxIterations ?? 50;
        const fallbackToAlarmVideo = params.fallbackToAlarmVideo ?? true;

        recordingsTraceLog(dbg, logger, "listRecordings", `Normalized params: channel=${channel}, uid=${uid}, streamType=${streamType}, maxIterations=${maxIterations}`);

        // Log the date components that will be sent to camera (xmlDateTimePayload uses local time methods)
        const startLocalParts = {
          year: params.start.getFullYear(),
          month: params.start.getMonth() + 1,
          day: params.start.getDate(),
          hour: params.start.getHours(),
          minute: params.start.getMinutes(),
          second: params.start.getSeconds(),
        };
        const endLocalParts = {
          year: params.end.getFullYear(),
          month: params.end.getMonth() + 1,
          day: params.end.getDate(),
          hour: params.end.getHours(),
          minute: params.end.getMinutes(),
          second: params.end.getSeconds(),
        };
        recordingsTraceLog(dbg, logger, "listRecordings", `Date components for camera (local): start=${startLocalParts.year}-${String(startLocalParts.month).padStart(2, '0')}-${String(startLocalParts.day).padStart(2, '0')} ${String(startLocalParts.hour).padStart(2, '0')}:${String(startLocalParts.minute).padStart(2, '0')}:${String(startLocalParts.second).padStart(2, '0')} (UTC: ${params.start.toISOString()}), end=${endLocalParts.year}-${String(endLocalParts.month).padStart(2, '0')}-${String(endLocalParts.day).padStart(2, '0')} ${String(endLocalParts.hour).padStart(2, '0')}:${String(endLocalParts.minute).padStart(2, '0')}:${String(endLocalParts.second).padStart(2, '0')} (UTC: ${params.end.toISOString()})`);

        const openXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<uid>${xmlEscape(uid)}</uid>
<searchAITrack>1</searchAITrack>
<channelId>${channel}</channelId>
<logicChnBitmap>255</logicChnBitmap>
<streamType>${xmlEscape(streamType)}</streamType>
<recordType>${xmlEscape(recordType)}</recordType>
${xmlDateTimePayload("startTime", params.start)}
${xmlDateTimePayload("endTime", params.end)}
</FileInfo>
</FileInfoList>
</body>`;

        const runFindAlarmVideo = async (): Promise<RecordingFile[]> => {
          recordingsTraceLog(dbg, logger, "listRecordings", `FileInfoList unavailable; falling back to findAlarmVideo`);

          // Fallback path: <findAlarmVideo> (cmdId 272/273/274).
          // This often returns "alarm videos" when FileInfoList is unsupported/empty.
          const uidBase = uid.split("_")[0] ?? uid;
          const streamTypeInt = streamType === "subStream" ? 1 : 0;
          const alarmType = "md, pir, io, people, face, vehicle, dog_cat, visitor, other, package, cry, crossline, intrusion, loitering, legacy, loss";

          // NOTE: channelId in the XML payload is 0-based (same as `channel`).
          // The Baichuan transport header uses (channel + 1) internally.
          const xmlChannelId = channel;

          const findOpenXml = (start: Date, end: Date) => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
      <channelId>${xmlChannelId}</channelId>
<uid>${xmlEscape(uidBase)}</uid>
<logicChnBitmap>255</logicChnBitmap>
<streamType>${streamTypeInt}</streamType>
<notSearchVideo>0</notSearchVideo>
${xmlDateTimePayload("startTime", start)}
${xmlDateTimePayload("endTime", end)}
<alarmType>${alarmType}</alarmType>
</findAlarmVideo>
</body>`;

          const findGetXml = (fileHandle: string) => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
      <channelId>${xmlChannelId}</channelId>
<fileHandle>${xmlEscape(fileHandle)}</fileHandle>
</findAlarmVideo>
</body>`;

          const alarmFiles: RecordingFile[] = [];
          let currentStart = params.start;
          for (let i = 0; i < maxIterations; i++) {
            recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo iteration ${i + 1}/${maxIterations}: start=${currentStart.toISOString()}, end=${params.end.toISOString()}`);

            let openResp: string;
            try {
              // Use explicit timeouts for NVR/hub stability.
              openResp = await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_OPEN, channel, payloadXml: findOpenXml(currentStart, params.end), timeoutMs: 15_000 });
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo OPEN response received`);
            } catch (e) {
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo OPEN failed: ${e instanceof Error ? e.message : String(e)}`);
              break;
            }

            const fileHandle = getXmlText(openResp, "fileHandle")?.trim();
            if (!fileHandle) {
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: no fileHandle in response, breaking`);
              break;
            }

            const getXml = findGetXml(fileHandle);
            try {
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: fetching with handle=${fileHandle}`);
              const getResp = await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_GET, channel, payloadXml: getXml, timeoutMs: 15_000 });
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo GET response received`);

              const pageFiles = parseRecordingFilesFromXml(getResp);
              alarmFiles.push(...pageFiles);
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo page ${i + 1}: found ${pageFiles.length} files (total: ${alarmFiles.length})`);

              const bFinishedText = getXmlText(getResp, "bFinished")?.trim();
              const finished = bFinishedText === "1";
              if (finished) {
                recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: finished=true, breaking`);
                break;
              }

              // If not finished, advance start to the last returned event startTime if possible.
              const lastWithStart = [...pageFiles].reverse().find((f) => f.startTime != null);
              if (!lastWithStart?.startTime) {
                recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: no startTime in files, breaking`);
                break;
              }
              // Guard against non-progressing pagination.
              if (currentStart.getTime() === lastWithStart.startTime.getTime()) {
                recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: pagination did not advance (startTime unchanged), breaking to avoid loop`);
                break;
              }
              currentStart = lastWithStart.startTime;
            } finally {
              // Best-effort close.
              try {
                recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: closing handle=${fileHandle}`);
                await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_CLOSE, channel, payloadXml: getXml, timeoutMs: 10_000 });
                recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: closed successfully`);
              } catch (e) {
                recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo CLOSE failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }

          const seenAlarm = new Set<string>();
          const result = alarmFiles.filter((f) => {
            if (seenAlarm.has(f.fileName)) return false;
            seenAlarm.add(f.fileName);
            return true;
          });
          recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo complete: returning ${result.length} unique files`);
          return result;
        };

        recordingsTraceLog(dbg, logger, "listRecordings", `Opening FileInfoList: channel=${channel}, uid=${uid}, streamType=${streamType}`);

        // Check connection state before opening FileInfoList
        const isConnectedBefore = this.client.isSocketConnected();
        const isLoggedInBefore = this.client.loggedIn;
        recordingsTraceLog(dbg, logger, "listRecordings", `Before FILE_INFO_LIST_OPEN: connected=${isConnectedBefore}, loggedIn=${isLoggedInBefore}`);

        // Use explicit timeout for recording operations (15 seconds per request)
        let openResp: string;
        try {
          recordingsTraceLog(dbg, logger, "listRecordings", `Sending FILE_INFO_LIST_OPEN (cmdId=${BC_CMD_ID_FILE_INFO_LIST_OPEN})`);
          openResp = await this.sendXml({ cmdId: BC_CMD_ID_FILE_INFO_LIST_OPEN, channel, payloadXml: openXml, timeoutMs: 15_000 });
          recordingsTraceLog(dbg, logger, "listRecordings", `FILE_INFO_LIST_OPEN successful`);
        } catch (e) {
          const isConnectedAfter = this.client.isSocketConnected();
          const isLoggedInAfter = this.client.loggedIn;
          const msg = e instanceof Error ? e.message : String(e);
          recordingsTraceLog(dbg, logger, "listRecordings", `FILE_INFO_LIST_OPEN failed: ${msg}, connected=${isConnectedAfter}, loggedIn=${isLoggedInAfter}`);

          // NVR/Hub often returns responseCode=400 with empty body for FileInfoList; fall back.
          if (fallbackToAlarmVideo && msg.includes("responseCode 400, empty body")) {
            return await runFindAlarmVideo();
          }

          throw e;
        }
        const handleText = getXmlText(openResp, "handle");
        if (!handleText) {
          throw new Error("FileInfoList open did not return <handle>");
        }

        const handle = Number.parseInt(handleText, 10);
        if (!Number.isFinite(handle)) {
          throw new Error(`FileInfoList open returned invalid handle: ${handleText}`);
        }
        recordingsTraceLog(dbg, logger, "listRecordings", `FileInfoList opened with handle=${handle}`);

        const pageXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${channel}</channelId>
<uid>${xmlEscape(uid)}</uid>
<searchAITrack>1</searchAITrack>
<handle>${handle}</handle>
</FileInfo>
</FileInfoList>
</body>`;

        const files: RecordingFile[] = [];
        // Typical page size for Reolink cameras - if we get this many results, there might be more pages
        const TYPICAL_PAGE_SIZE = 40;

        try {
          let finished = false;
          for (let i = 0; i < maxIterations && !finished; i++) {
            recordingsTraceLog(dbg, logger, "listRecordings", `Fetching page ${i + 1}/${maxIterations} (handle=${handle})`);

            let resp: string;
            try {
              // Use explicit timeout for each pagination request (15 seconds)
              resp = await this.sendXml({ cmdId: BC_CMD_ID_FILE_INFO_LIST_GET, channel, payloadXml: pageXml, timeoutMs: 15_000 });
              recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1} GET response received`);
            } catch (e) {
              // For FILE_INFO_LIST_GET, a 400 with empty body during pagination typically means
              // no more pages available or handle expired - treat as end of pagination
              const errorMsg = e instanceof Error ? e.message : String(e);
              if (errorMsg.includes('responseCode 400, empty body')) {
                recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1} GET returned 400 (empty body) - treating as end of pagination`);
                finished = true;
                break;
              }
              recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1} GET failed: ${errorMsg}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
              throw e;
            }

            const pageFiles = parseRecordingFilesFromXml(resp);
            files.push(...pageFiles);
            recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1}: found ${pageFiles.length} files (total: ${files.length})`);

            const bFinishedText = getXmlText(resp, "bFinished") ?? getXmlText(resp, "finished");
            if (bFinishedText != null) {
              // Explicit finished flag from camera
              finished = bFinishedText.trim() === "1";
              recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1}: bFinished=${bFinishedText}, finished=${finished}`);
            } else {
              // No finished flag in response - use heuristic based on page size
              // If we received a full page (TYPICAL_PAGE_SIZE), there might be more results
              // If we received fewer, we're likely at the end
              if (pageFiles.length >= TYPICAL_PAGE_SIZE) {
                finished = false;
                recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1}: no finished flag, but got ${pageFiles.length} files (>= ${TYPICAL_PAGE_SIZE}), continuing pagination`);
              } else if (pageFiles.length === 0) {
                // Empty page means we're done
                finished = true;
                recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1}: no finished flag and empty page, assuming done`);
              } else {
                // Got some results but less than a full page - likely the last page
                finished = true;
                recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1}: no finished flag, got ${pageFiles.length} files (< ${TYPICAL_PAGE_SIZE}), assuming done`);
              }
            }
          }

          if (!finished) {
            recordingsTraceLog(dbg, logger, "listRecordings", `WARNING: Reached maxIterations (${maxIterations}) without finishing pagination`);
          }
        } catch (e) {
          recordingsTraceLog(dbg, logger, "listRecordings", `Pagination loop failed: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
          throw e;
        } finally {
          // Best-effort close.
          try {
            recordingsTraceLog(dbg, logger, "listRecordings", `Closing FileInfoList handle=${handle}`);
            await this.sendXml({ cmdId: BC_CMD_ID_FILE_INFO_LIST_CLOSE, channel, payloadXml: pageXml, timeoutMs: 5_000 });
            recordingsTraceLog(dbg, logger, "listRecordings", `FileInfoList closed successfully`);
          } catch (e) {
            recordingsTraceLog(dbg, logger, "listRecordings", `FileInfoList CLOSE failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
            // ignore
          }
        }

        // De-dup (pagination can repeat).
        const seen = new Set<string>();
        const unique = files.filter((f) => {
          if (seen.has(f.fileName)) return false;
          seen.add(f.fileName);
          return true;
        });

        recordingsTraceLog(dbg, logger, "listRecordings", `FileInfoList complete: ${unique.length} unique files (from ${files.length} total)`);
        if (unique.length > 0 || !fallbackToAlarmVideo) {
          recordingsTraceLog(dbg, logger, "listRecordings", `Returning ${unique.length} files from FileInfoList`);
          return unique;
        }

        return await runFindAlarmVideo();
      } catch (e) {
        recordingsTraceLog(dbg, logger, "listRecordings", `ERROR: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
        throw e;
      }
    });
  }

  /**
    * Convenience wrapper around listRecordings() that returns only the recording identifiers.
   *
   * Most firmwares return a usable download identifier as a path-like string, e.g.
   * `/mnt/sda/Mp4Record/YYYY-MM-DD/Rec....mp4`.
   */
  async listRecordingFileNames(params: ListRecordingsParams): Promise<string[]> {
    const recs = await this.listRecordings(params);
    return recs.map((r) => r.fileName);
  }

  /**
   * Convenience helper to list recordings in a given time window, optionally limiting the count.
   *
   * This wraps {@link ReolinkBaichuanApi.listRecordings | listRecordings} and post-filters/sorts the results by startTime.
   * Results are cached locally to avoid redundant API calls.
   */
  /**
   * List enriched recordings from Device (camera).
   * Always returns enriched recording files with parsed metadata, detection flags, and timestamps.
   * 
   * @param params - Search parameters
   * @returns Array of enriched recording files
   */
  async listDeviceRecordings(params: {
    /** Logical channel to query. If omitted, uses the client's configured channel (or 0). */
    channel?: number;
    /** UID of the device; if omitted, defaults to this.uid when available. */
    uid?: string;
    start: Date;
    end: Date;
    streamType?: RecordingStreamType;
    /** Comma-separated list of record types, e.g. "manual, sched, io, md, people". */
    recordType?: string;
    /**
     * Maximum number of recordings to return (after filtering/sorting by time).
     * If omitted, all recordings in the window are returned.
     */
    count?: number;
    /** See {@link ListRecordingsParams.fallbackToAlarmVideo}. */
    fallbackToAlarmVideo?: boolean;
    /** See {@link ListRecordingsParams.maxIterations}. */
    maxIterations?: number;
    /**
     * If true (default), try HTTP CGI API fallback when Baichuan API returns no results or fails.
     */
    httpFallback?: boolean;
    /**
     * If true, bypass the cache and fetch fresh data from the camera.
     * Default: false (use cache if available).
     */
    bypassCache?: boolean;
    /**
     * Custom TTL for caching this request's results (in milliseconds).
     * If not provided, uses the default TTL (5 minutes).
     */
    cacheTtlMs?: number;
    /**
     * If true, fetch RTMP playback URLs for each recording.
     * This adds latency as it requires additional API calls.
     * Default: false.
     */
    fetchRtmpUrls?: boolean;
  }): Promise<EnrichedRecordingFile[]> {
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    try {
      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Init: ${JSON.stringify({ params })}`);

      const { channel, uid, start, end, streamType, recordType, count, fallbackToAlarmVideo, maxIterations, httpFallback = true, bypassCache = false, cacheTtlMs, fetchRtmpUrls = false } = params;

      // Fallback to the client's configured channel (or 0) when not explicitly provided.
      const effectiveChannel = channel ?? (this.client.getConfiguredChannel?.() ?? 0);
      const effectiveStreamType = streamType || "mainStream";
      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Effective channel: ${effectiveChannel}`);

      // Check cache first (unless bypassed)
      if (!bypassCache) {
        const cachedRecs = this.getCachedRecordings(effectiveChannel, start, end, effectiveStreamType);
        if (cachedRecs) {
          recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Cache hit: returning ${cachedRecs.length} cached enriched recordings`);

          // Apply count limit if specified
          if (typeof count === "number" && Number.isFinite(count) && count > 0) {
            return cachedRecs.slice(0, count);
          }
          return cachedRecs;
        }
        recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Cache miss: fetching from camera`);
      } else {
        recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Cache bypassed: fetching fresh data`);
      }

      let effectiveUid: string;
      try {
        effectiveUid = await this.ensureUidForRecordings(effectiveChannel, uid);
        recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Effective UID: ${effectiveUid}`);
      } catch (e) {
        recordingsTraceLog(dbg, logger, "listDeviceRecordings", `ensureUidForRecordings failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }

      // Adjust dates for camera API
      // If end time is exactly midnight, it means "end of the previous day"
      // Adjust to 23:59:59 of that day for the search
      const adjustedStart = new Date(start);
      const adjustedEnd = new Date(end);

      if (adjustedEnd.getHours() === 0 && adjustedEnd.getMinutes() === 0 && adjustedEnd.getSeconds() === 0) {
        adjustedEnd.setSeconds(-1); // Go back 1 second to 23:59:59 of previous day
      }

      const listParams: ListRecordingsParams = {
        channel: effectiveChannel,
        uid: effectiveUid,
        start: adjustedStart,
        end: adjustedEnd,
        ...(recordType ? { recordType } : {}),
        ...(fallbackToAlarmVideo !== undefined ? { fallbackToAlarmVideo } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        ...(streamType ? { streamType } : {}),
      };

      let recs: RecordingFile[];

      // If httpFallback is true, use HTTP API directly instead of Baichuan
      if (httpFallback) {
        recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Using HTTP API directly (httpFallback=true)`);
        try {
          // Ensure CGI API is logged in (reuse existing session if already logged in)
          await this.cgiApi.login();

          // Get recordings via HTTP CGI API using "Search" command
          // Format dates according to Reolink API format: { year, mon, day, hour, min, sec }
          // Use local time values since the camera expects times in its local timezone
          const formatReolinkTime = (date: Date) => ({
            year: date.getFullYear(),
            mon: date.getMonth() + 1, // JavaScript months are 0-based, Reolink expects 1-based
            day: date.getDate(),
            hour: date.getHours(),
            min: date.getMinutes(),
            sec: date.getSeconds(),
          });

          const startTimePayload = formatReolinkTime(adjustedStart);
          const endTimePayload = formatReolinkTime(adjustedEnd);
          const searchPayload = {
            Search: {
              channel: effectiveChannel,
              onlyStatus: 0, // 0 = get files, 1 = only status
              streamType: effectiveStreamType,
              StartTime: startTimePayload,
              EndTime: endTimePayload,
            }
          };

          recordingsTraceLog(dbg, logger, "listDeviceRecordings", `HTTP API Search payload: ${JSON.stringify(searchPayload)}`);

          const httpResponse = await this.cgiApi.call('Search', searchPayload, 0);

          recordingsTraceLog(dbg, logger, "listDeviceRecordings", `HTTP API returned response: ${JSON.stringify(httpResponse)}`);

          // Parse HTTP response and convert to RecordingFile format
          recs = [];
          if (Array.isArray(httpResponse) && httpResponse.length > 0) {
            for (const data of httpResponse) {
              if (data.code !== 0) {
                recordingsTraceLog(dbg, logger, "listDeviceRecordings", `HTTP API returned error code ${data.code}`);
                continue;
              }

              // Type-safe access to SearchResult
              const value = data.value;
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                continue;
              }

              const searchResult = (value as Record<string, any>).SearchResult;
              if (!searchResult || typeof searchResult !== 'object') {
                continue;
              }

              // Parse file list from response
              const files = (searchResult as Record<string, any>).File;
              if (Array.isArray(files)) {
                for (const file of files) {
                  // Convert Reolink time format to Date
                  const parseReolinkTime = (t: any): Date => {
                    return new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec);
                  };

                  const fileStartTime = file.StartTime ? parseReolinkTime(file.StartTime) : undefined;
                  const fileEndTime = file.EndTime ? parseReolinkTime(file.EndTime) : undefined;

                  // Build RecordingFile with proper optional property handling
                  const recFile: RecordingFile = {
                    fileName: file.name || '',
                  };
                  if (file.size !== undefined) recFile.sizeBytes = file.size;
                  if (fileStartTime) recFile.startTime = fileStartTime;
                  if (fileEndTime) recFile.endTime = fileEndTime;
                  if (file.type !== undefined) recFile.recordType = file.type;

                  recs.push(recFile);
                }
              }
            }
            recordingsTraceLog(dbg, logger, "listDeviceRecordings", `HTTP API parsed ${recs.length} recordings`);
          }
        } catch (httpError: any) {
          recordingsTraceLog(dbg, logger, "listDeviceRecordings", `HTTP API failed: ${httpError instanceof Error ? httpError.message : String(httpError)}`);
          throw httpError;
        }
      } else {
        // Use Baichuan API (default behavior)
        recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Calling listRecordings with params: channel=${listParams.channel}, uid=${listParams.uid}, start=${listParams.start.toISOString()} (original UTC: ${start.toISOString()}), end=${listParams.end.toISOString()} (original UTC: ${end.toISOString()})`);

        try {
          recs = await this.listRecordings(listParams);
          recordingsTraceLog(dbg, logger, "listDeviceRecordings", `listRecordings returned ${recs.length} recordings`);
        } catch (e) {
          recordingsTraceLog(dbg, logger, "listDeviceRecordings", `listRecordings failed: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
          throw e;
        }
      }

      // Normalize and filter by time window (defensive: some firmwares may return a wider range).
      const startMs = start.getTime();
      const endMs = end.getTime();
      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Filtering recordings: startMs=${startMs}, endMs=${endMs}`);

      const normalized: RecordingFile[] = recs.map((r) => {
        const s = r.startTime ?? r.parsedFileName?.start;
        const e = r.endTime ?? r.parsedFileName?.end;
        // Only set properties when defined to keep optional types happy with exactOptionalPropertyTypes.
        return {
          ...r,
          ...(s ? { startTime: s } : {}),
          ...(e ? { endTime: e } : {}),
        };
      });

      const filtered = normalized
        .filter((r) => {
          if (!r.startTime) return false;
          const t = r.startTime.getTime();
          return t >= startMs && t <= endMs;
        })
        .sort((a, b) => {
          const as = a.startTime?.getTime() ?? 0;
          const bs = b.startTime?.getTime() ?? 0;
          return as - bs;
        });

      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Filtered to ${filtered.length} recordings in time window`);

      // Always enrich the results
      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Enriching ${filtered.length} recordings`);
      const enriched: EnrichedRecordingFile[] = [];

      for (const rec of filtered) {
        let rtmpUrl: string | undefined;

        // Optionally fetch RTMP URL
        if (fetchRtmpUrls) {
          try {
            const playbackParams: Parameters<typeof this.getRecordingPlaybackUrls>[0] = {
              channel: effectiveChannel,
              fileName: rec.fileName,
            };
            if (streamType !== undefined) playbackParams.streamType = streamType;

            const urls = await this.getRecordingPlaybackUrls(playbackParams);
            rtmpUrl = urls.rtmpVodUrl;
          } catch (e) {
            // Silently ignore - not all recordings may have playback URLs available
            recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Failed to get RTMP URL for ${rec.fileName}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        enriched.push(this.enrichRecordingFile(rec, rtmpUrl));
      }

      // Cache the enriched results for future lookups
      this.cacheRecordings(effectiveChannel, start, end, effectiveStreamType, enriched, cacheTtlMs);
      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Cached ${enriched.length} enriched recordings`);

      // Apply count limit if specified
      if (typeof count === "number" && Number.isFinite(count) && count > 0) {
        const result = enriched.slice(0, count);
        recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Returning ${result.length} enriched recordings (limited by count=${count})`);
        return result;
      }

      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `Returning ${enriched.length} enriched recordings`);
      return enriched;
    } catch (e) {
      recordingsTraceLog(dbg, logger, "listDeviceRecordings", `ERROR: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
      throw e;
    }
  }

  /**
   * Parse detection flags from recordType string (e.g. "md,people,dog_cat").
   * This complements the hex-decoded flags from the filename.
   */
  private parseRecordTypeFlags(recordType?: string): {
    hasPerson: boolean;
    hasVehicle: boolean;
    hasAnimal: boolean;
    hasFace: boolean;
    hasMotion: boolean;
    hasSchedule: boolean;
    hasDoorbell: boolean;
    hasPackage: boolean;
    hasRf: boolean;
    hasOther: boolean;
  } {
    const flags = {
      hasPerson: false,
      hasVehicle: false,
      hasAnimal: false,
      hasFace: false,
      hasMotion: false,
      hasSchedule: false,
      hasDoorbell: false,
      hasPackage: false,
      hasRf: false,
      hasOther: false,
    };

    if (!recordType) return flags;

    const types = recordType.toLowerCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

    for (const t of types) {
      if (t === "people" || t === "person") flags.hasPerson = true;
      else if (t === "vehicle" || t === "car") flags.hasVehicle = true;
      else if (t === "dog_cat" || t === "animal" || t === "pet") flags.hasAnimal = true;
      else if (t === "face") flags.hasFace = true;
      else if (t === "md" || t === "motion") flags.hasMotion = true;
      else if (t === "sched" || t === "schedule" || t === "timer") flags.hasSchedule = true;
      else if (t === "visitor" || t === "doorbell") flags.hasDoorbell = true;
      else if (t === "package") flags.hasPackage = true;
      else if (t === "rf" || t === "io" || t === "pir") flags.hasRf = true;
      else if (t === "other" || t === "manual") flags.hasOther = true;
    }

    return flags;
  }

  /**
   * Enrich a RecordingFile with all parsed metadata.
   * Combines filename parsing with recordType parsing to get complete detection flags.
   */
  private enrichRecordingFile(rec: RecordingFile, rtmpUrl?: string): EnrichedRecordingFile {
    // Parse filename if not already parsed
    const parsed = rec.parsedFileName ?? (rec.fileName ? parseRecordingFileName(rec.fileName) : undefined);

    // Get times from various sources
    const startTime = rec.startTime ?? parsed?.start;
    const endTime = rec.endTime ?? parsed?.end;

    const startTimeMs = startTime?.getTime() ?? 0;
    const endTimeMs = endTime?.getTime() ?? startTimeMs;

    // Calculate duration - prefer parsed duration if available and valid
    let durationMs = parsed?.durationMs ?? 0;
    if (durationMs === 0 && endTimeMs > startTimeMs) {
      durationMs = endTimeMs - startTimeMs;
    }

    // Get flags from hex decoding
    const hexFlags = parsed?.flags;

    // Get flags from recordType string
    const typeFlags = this.parseRecordTypeFlags(rec.recordType);

    // Merge flags: OR them together (if either source says true, it's true)
    const hasPerson = (hexFlags?.aiPerson ?? false) || typeFlags.hasPerson;
    const hasVehicle = (hexFlags?.aiVehicle ?? false) || typeFlags.hasVehicle;
    const hasAnimal = (hexFlags?.aiAnimal ?? false) || typeFlags.hasAnimal;
    const hasFace = (hexFlags?.aiFace ?? false) || typeFlags.hasFace;
    const hasMotion = (hexFlags?.motion ?? false) || typeFlags.hasMotion;
    const hasSchedule = (hexFlags?.schedule ?? false) || typeFlags.hasSchedule;
    const hasDoorbell = (hexFlags?.doorbell ?? false) || typeFlags.hasDoorbell;
    const hasPackage = (hexFlags?.package ?? false) || typeFlags.hasPackage;
    const hasRf = (hexFlags?.rf ?? false) || typeFlags.hasRf;
    const hasOther = (hexFlags?.aiOther ?? false) || typeFlags.hasOther;

    const enriched: EnrichedRecordingFile = {
      fileName: rec.fileName,
      id: rec.id ?? rec.fileName,
      startTimeMs,
      endTimeMs,
      durationMs,
      hasPerson,
      hasVehicle,
      hasAnimal,
      hasFace,
      hasMotion,
      hasSchedule,
      hasDoorbell,
      hasPackage,
      hasRf,
      hasOther,
      streamHint: parsed?.streamHint ?? "unknown",
      devType: parsed?.devType ?? "cam",
      raw: rec,
    };

    if (rec.sizeBytes !== undefined) enriched.sizeBytes = rec.sizeBytes;
    if (rec.recordType) enriched.recordType = rec.recordType;
    if (rtmpUrl) enriched.rtmpUrl = rtmpUrl;
    if (parsed) enriched.parsedFileName = parsed;

    return enriched;
  }


  /**
   * Convenience helper to build playback/download URLs for a single recording.
   *
   * Currently returns the RTMP VOD URL (suitable for streaming/export via playback).
     * Use {@link ReolinkBaichuanApi#downloadRecording | downloadRecording} for bit-identical file download.
   */
  async getRecordingPlaybackUrls(params: {
    /** Logical channel to query. If omitted, uses the client's configured channel (or 0). */
    channel?: number;
    fileName: string;
    streamType?: RecordingStreamType;
    /** If true (default), ensure RTMP is enabled before returning the URL. */
    ensureEnabled?: boolean;
  }): Promise<{
    /** RTMP VOD URL for playback/export. */
    rtmpVodUrl: string;
  }> {
    const effectiveChannel = params.channel ?? (this.client.getConfiguredChannel?.() ?? 0);

    const rtmpVodUrl = await this.getVodRtmpUrl({
      channel: effectiveChannel,
      fileName: params.fileName,
      ...(params.streamType ? { streamType: params.streamType } : {}),
      ...(params.ensureEnabled !== undefined ? { ensureEnabled: params.ensureEnabled } : {}),
    });

    return { rtmpVodUrl };
  }

  /**
   * Ensure we have a UID suitable for recording-related operations.
   *
   * If an explicit UID is provided, it is returned as-is.
   * Otherwise, this method returns the cached `this.uid` if already known.
   *
   * No automatic discovery is performed here: callers must ensure that a UID is available
   * either via explicit parameter or via the client configuration.
   */
  private async ensureUidForRecordings(channel: number, explicitUid?: string): Promise<string> {
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Checking UID: explicitUid=${explicitUid}, this.uid=${this.uid}`);

    const isUidLike = (value: string): boolean => {
      const s = value.trim();
      // Typical Reolink UID: uppercase alnum, ~16 chars (e.g. 9527000HZ56U1ORU)
      return /^[0-9A-Z]{12,24}$/.test(s) && /[A-Z]/.test(s);
    };

    if (explicitUid && explicitUid.trim()) {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Using explicit UID: ${explicitUid.trim()}`);
      return explicitUid.trim();
    }

    // If we already saw a per-channel UID via pushes, prefer it.
    const fromPush = this.getUidFromPushCacheForChannel(channel);
    if (fromPush) {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Using per-channel UID from push cache: ${fromPush}`);
      return fromPush;
    }

    // 1) Prefer per-channel UID from CGI GetChannelstatus (NVRs often have different UIDs per channel)
    // This avoids using a global NVR UID for per-channel operations like recordings/alarm searches.
    try {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Attempting per-channel UID discovery via HTTP CGI GetChannelstatus (channel=${channel})`);
      await this.cgiApi.login();
      const chStatus = await this.cgiApi.GetChannelstatus();
      const entry = chStatus
        .flatMap((r) => r.value?.status ?? [])
        .find((s) => typeof s?.channel === "number" && s.channel === channel);

      const uidCandidate = (entry?.uid ?? "").trim();
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `[HTTP CGI] GetChannelstatus channel=${channel} uid=${uidCandidate || "(missing)"}`,
      );

      if (uidCandidate && isUidLike(uidCandidate)) {
        const existing = this.channelPushData.get(channel);
        this.channelPushData.set(channel, {
          ...(existing ?? { channel }),
          uid: uidCandidate,
        } as any);
        recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Using per-channel UID from GetChannelstatus: ${uidCandidate}`);
        return uidCandidate;
      }
    } catch (e) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `[HTTP CGI] GetChannelstatus failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 2) Fall back to configured UID (typical for standalone cameras)
    if (this.uid && this.uid.trim()) {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Using configured UID: ${this.uid.trim()}`);
      return this.uid;
    }

    recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `No UID available, attempting auto-discovery for channel ${channel}`);

    // Try to auto-discover UID using the same logic as test-tcp-uid-discovery
    const extractUidLike = (value: unknown): string | undefined => {
      const seen = new Set<unknown>();
      const walk = (v: unknown): string | undefined => {
        if (v == null) return undefined;
        if (typeof v === "string") {
          const s = v.trim();
          if (isUidLike(s)) return s;
          return undefined;
        }
        if (typeof v !== "object") return undefined;
        if (seen.has(v)) return undefined;
        seen.add(v);

        if (Array.isArray(v)) {
          for (const it of v) {
            const r = walk(it);
            if (r) return r;
          }
          return undefined;
        }

        for (const vv of Object.values(v as Record<string, unknown>)) {
          const r = walk(vv);
          if (r) return r;
        }
        return undefined;
      };
      return walk(value);
    };

    let discoveredUid: string | undefined;

    // 3) Try getInfo() -> serialNumber (device-level)
    try {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Attempting auto-discovery via getInfo()`);
      const info = await this.getInfo(channel);
      const serial = (info.serialNumber ?? "").trim();
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `getInfo().serialNumber: ${serial || "(missing)"}`);
      if (serial && isUidLike(serial)) {
        discoveredUid = serial;
        recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Found UID from serialNumber: ${discoveredUid}`);
      }
    } catch (e) {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `getInfo() failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3) Try HTTP CGI GetP2p / GetDevInfo (device-level)
    if (!discoveredUid) {
      try {
        recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Attempting auto-discovery via HTTP CGI API`);
        await this.cgiApi.login();

        try {
          const p2p = await this.cgiApi.call("GetP2p", {});
          const fromP2p = extractUidLike(p2p);
          recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `[HTTP CGI] GetP2p UID candidate: ${fromP2p || "(none)"}`);
          discoveredUid = discoveredUid ?? fromP2p ?? undefined;
        } catch (e) {
          recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `[HTTP CGI] GetP2p failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        if (!discoveredUid) {
          try {
            const devInfo = await this.cgiApi.GetDevInfo();
            const fromDevInfo = extractUidLike(devInfo);
            recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `[HTTP CGI] GetDevInfo UID candidate: ${fromDevInfo || "(none)"}`);
            discoveredUid = discoveredUid ?? fromDevInfo ?? undefined;
          } catch (e) {
            recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `[HTTP CGI] GetDevInfo failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // NOTE: GetChannelstatus is handled above to support per-channel UIDs.
      } catch (e) {
        recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `[HTTP CGI] Login or requests failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 3) Try Baichuan GetP2p via sendXml(cmdId=114)
    if (!discoveredUid) {
      try {
        recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Attempting auto-discovery via cmdId=114 (GetP2p)`);
        const p2pXml = await this.sendXml({ cmdId: 114, timeoutMs: 10_000 });
        const fromBaichuanP2p = extractUidLike(p2pXml);
        if (fromBaichuanP2p) {
          discoveredUid = fromBaichuanP2p;
          recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Found UID from cmdId=114: ${discoveredUid}`);
        } else {
          recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `cmdId=114 did not return UID`);
        }
      } catch (e) {
        recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `cmdId=114 failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (discoveredUid) {
      // Cache device-level UID for future use
      this.uid = discoveredUid;
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Auto-discovered and cached device UID: ${discoveredUid}`);
      return discoveredUid;
    }

    recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Auto-discovery failed - no UID found`);
    throw new Error(
      "UID is required to access recordings. Provide a UID explicitly or configure the client with a UID.",
    );
  }

  /**
   * Get a video I-frame (keyframe) from a past recording at a specific timestamp.
   * 
   * Uses the Baichuan CoverPreview command (cmd_id=298) to retrieve an I-frame
   * directly from the camera without external dependencies.
   * 
   * The returned data is a raw H.264 or H.265 I-frame. To convert it to JPEG,
   * you can use ffmpeg or a video decoder library.
   * 
   * Inspired by reolink_aio's snapshot_past functionality.
   * 
   * @param params - Parameters for the snapshot
   * @returns Object containing the raw I-frame data and metadata
   */
  async snapshotFromPlayback(params: {
    /** Channel number (0-based) */
    channel?: number;
    /** Timestamp to capture */
    time: Date;
    /** Stream type for snapshot quality ("main" or "sub", default: "sub") */
    snapType?: "main" | "sub";
    /** Timeout in milliseconds (default: 30000) */
    timeoutMs?: number;
  }): Promise<{
    /** Raw I-frame data (H.264 or H.265) */
    frame: Buffer;
    /** Video encoding type detected from frame header */
    encoding: string;
    /** Frame length in bytes */
    frameLength: number;
    /** Frame timestamp (Unix seconds) if available */
    frameTime?: number;
    /** Stream metadata from header */
    streamInfo: {
      width?: number;
      height?: number;
      frameRate?: number;
    };
  }> {
    await this.client.login();

    const channel = this.normalizeChannel(params.channel);
    const snapType = params.snapType ?? "sub";
    const timeoutMs = params.timeoutMs ?? 30_000;
    const time = params.time;

    // CoverPreview requires a time range - use 10 seconds from the target time
    const endTime = new Date(time.getTime() + 10_000);

    // Build CoverPreview XML (cmd_id=298)
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<CoverPreview version="1.1">
<channelId>${channel}</channelId>
<streamType>${snapType}</streamType>
<startTime>
<year>${time.getFullYear()}</year>
<month>${time.getMonth() + 1}</month>
<day>${time.getDate()}</day>
<hour>${time.getHours()}</hour>
<minute>${time.getMinutes()}</minute>
<second>${time.getSeconds()}</second>
</startTime>
<endTime>
<year>${endTime.getFullYear()}</year>
<month>${endTime.getMonth() + 1}</month>
<day>${endTime.getDate()}</day>
<hour>${endTime.getHours()}</hour>
<minute>${endTime.getMinutes()}</minute>
<second>${endTime.getSeconds()}</second>
</endTime>
</CoverPreview>
</body>`;

    // Send the CoverPreview command and receive binary payload
    const payload = await this.client.sendBinaryCoverPreview({
      cmdId: 298,
      channel,
      payloadXml: xml,
      timeoutMs,
    });

    // Parse stream header (first 32 bytes)
    if (payload.length < 32) {
      throw new Error(`CoverPreview payload too short: ${payload.length} bytes`);
    }

    const streamHeader = payload.subarray(0, 32);
    const magic = streamHeader.subarray(0, 4).toString("ascii");

    if (magic !== "1001") {
      throw new Error(`CoverPreview payload did not start with stream header magic '1001' but with '${magic}'`);
    }

    // Parse stream header fields
    const width = streamHeader.readUInt32LE(8);
    const height = streamHeader.readUInt32LE(12);
    const frameRate = streamHeader.length > 17 ? streamHeader[17] : 0;

    // Search for frame magic "00dc" after stream header
    const frameSearchArea = payload.subarray(32);
    const frameMagic = Buffer.from("00dc", "ascii");
    let frameMagicIndex = -1;

    for (let i = 0; i <= frameSearchArea.length - 4; i++) {
      if (
        frameSearchArea[i] === frameMagic[0] &&
        frameSearchArea[i + 1] === frameMagic[1] &&
        frameSearchArea[i + 2] === frameMagic[2] &&
        frameSearchArea[i + 3] === frameMagic[3]
      ) {
        frameMagicIndex = i;
        break;
      }
    }

    if (frameMagicIndex === -1) {
      throw new Error(`CoverPreview frame magic '00dc' not found. First bytes after header: ${frameSearchArea.subarray(0, 30).toString("hex")}`);
    }

    const idx = 32 + frameMagicIndex;

    // Parse frame header
    // Frame header structure:
    // - 0-4: magic "00dc"
    // - 4-8: encoding (e.g., "H264", "H265")
    // - 8-12: frame length
    // - 12-16: additional header length
    // - 16-20: frame microsecond
    // - 24-28: frame time (Unix timestamp)
    const frameHeaderStart = idx;
    const additionalHeaderLen = payload.readUInt32LE(frameHeaderStart + 12);
    const headerLen = 24 + additionalHeaderLen;
    const frameHeader = payload.subarray(frameHeaderStart, frameHeaderStart + headerLen);

    const encoding = frameHeader.subarray(4, 8).toString("ascii").replace(/\0/g, "");
    const frameLen = frameHeader.readUInt32LE(8);
    const frameTime = headerLen >= 28 ? frameHeader.readUInt32LE(24) : undefined;

    // Extract frame data
    const frameStart = frameHeaderStart + headerLen;
    const frameEnd = frameStart + frameLen;

    if (frameEnd > payload.length) {
      throw new Error(`Frame data extends beyond payload: frameEnd=${frameEnd}, payloadLength=${payload.length}`);
    }

    const frame = payload.subarray(frameStart, frameEnd);

    // Build streamInfo conditionally to satisfy exactOptionalPropertyTypes
    const streamInfo: { width?: number; height?: number; frameRate?: number } = {};
    if (width > 0) streamInfo.width = width;
    if (height > 0) streamInfo.height = height;
    const fr = frameRate ?? 0;
    if (fr > 0) streamInfo.frameRate = fr;

    // Build result conditionally for frameTime
    const result: {
      frame: Buffer;
      encoding: string;
      frameLength: number;
      frameTime?: number;
      streamInfo: { width?: number; height?: number; frameRate?: number };
    } = {
      frame,
      encoding,
      frameLength: frameLen,
      streamInfo,
    };
    if (frameTime !== undefined) result.frameTime = frameTime;

    return result;
  }

  /**
   * Get a JPEG snapshot from a specific recording file at a given offset.
   * 
   * This is a lower-level version that takes a fileName directly instead of searching.
   * 
   * @param params - Parameters for the snapshot
   * @returns JPEG image bytes
   */
  async snapshotFromRecording(params: {
    /** Channel number (0-based) */
    channel?: number;
    /** Recording file name/path */
    fileName: string;
    /** Seek position in seconds from the start of the recording (default: 0) */
    seekSeconds?: number;
    /** Stream type ("mainStream" or "subStream", default: "subStream") */
    streamType?: RecordingStreamType;
    /** Path to ffmpeg binary (default: "ffmpeg" from PATH) */
    ffmpegPath?: string;
    /** Timeout in milliseconds for ffmpeg (default: 30000) */
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.client.login();

    const channel = this.normalizeChannel(params.channel);
    const streamType = params.streamType ?? "subStream";
    const ffmpegPath = params.ffmpegPath ?? "ffmpeg";
    const timeoutMs = params.timeoutMs ?? 30_000;
    const seekSeconds = params.seekSeconds ?? 0;

    // Get RTMP VOD URL
    const rtmpUrl = await this.getVodRtmpUrl({
      channel,
      fileName: params.fileName,
      streamType,
      ensureEnabled: true,
    });

    // Use ffmpeg to extract a single frame
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let stderr = "";
      let timedOut = false;

      const ff = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel", "error",
        "-rtmp_live", "live",
        ...(seekSeconds > 0 ? ["-ss", seekSeconds.toFixed(3)] : []),
        "-i", rtmpUrl,
        "-frames:v", "1",
        "-f", "image2",
        "-c:v", "mjpeg",
        "-q:v", "2",
        "pipe:1",
      ]);

      const timeout = setTimeout(() => {
        timedOut = true;
        ff.kill("SIGKILL");
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ff.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      ff.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      ff.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) return;

        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
          return;
        }

        const imageBuffer = Buffer.concat(chunks);
        if (imageBuffer.length === 0) {
          reject(new Error(`ffmpeg produced no output. stderr: ${stderr}`));
          return;
        }

        resolve(imageBuffer);
      });

      ff.on("error", (err) => {
        clearTimeout(timeout);
        if (timedOut) return;
        reject(new Error(`ffmpeg error: ${err.message}`));
      });
    });
  }

  /**
   * Build an RTMP VOD/playback URL for a given recording.
   *
   * This follows the same logic:
   * `rtmp://<host>:<rtmpPort>/vod/<filename-with-"/"->"%20">?channel=<ch>&stream=<type>&user=<u>&password=<p>`
   *
   * Note: this is intended for *export/streaming via playback* (strategy B), not for bit-identical file download.
   */
  async getVodRtmpUrl(params: {
    channel: number;
    fileName: string;
    streamType?: RecordingStreamType;
    /** Ensure RTMP is enabled on the device before returning the URL (default true). */
    ensureEnabled?: boolean;
    /** Override RTMP port if known. */
    rtmpPort?: number;
  }): Promise<string> {
    // Note: login() is not called here to avoid unnecessary reconnections
    // The caller should ensure the client is already connected and logged in via ensureClient()
    const channel = this.normalizeChannel(params.channel);
    const streamType = params.streamType ?? "mainStream";
    const ensureEnabled = params.ensureEnabled ?? true;

    let rtmpPort = params.rtmpPort;
    try {
      const ports = await this.getNetPort();
      const rtmp = ports.rtmp;
      const enable = typeof rtmp?.enable === "number" ? rtmp.enable : undefined;
      const port = typeof rtmp?.port === "number" ? rtmp.port : undefined;
      if (rtmpPort == null && port != null && Number.isFinite(port) && port > 0) rtmpPort = port;
      if (ensureEnabled && enable === 0) {
        await this.setPortEnabled({ port: "rtmp", enable: true });
      }
    } catch {
      // Best-effort: if NetPort is unavailable, assume defaults.
    }

    if (rtmpPort == null) rtmpPort = 1935;

    const streamTypeInt = streamType === "subStream" ? 1 : 0;

    // Most cameras return absolute paths like `/mnt/sda/Mp4Record/...` but RTMP VOD usually
    // expects a path starting at `Mp4Record/...`.
    let source = params.fileName.trim();
    const idx = source.indexOf("Mp4Record/");
    if (idx >= 0) source = source.slice(idx);
    source = source.replace(/^\/+/, "");

    // Replace '/' with '%20' for vod paths.
    const vodPath = source.replace(/\//g, "%20").replace(/ /g, "%20");
    const user = encodeURIComponent(this.username);
    const pass = encodeURIComponent(this.password);

    return `rtmp://${this.host}:${rtmpPort}/vod/${vodPath}?channel=${channel}&stream=${streamTypeInt}&user=${user}&password=${pass}`;
  }

  /**
   * Predownload/export a recording locally as an MP4 file (strategy B).
   *
   * This is intended to be reliable for battery cameras where bit-identical
   * FileInfoList download (class 0x6482) can time out.
   *
   * Requirements:
   * - `ffmpeg` must be available in PATH.
   * - The device must expose an RTMP VOD/playback stream for the given `fileName`.
   */
  async predownloadRecordingMp4(params: {
    channel: number;
    fileName: string;
    outputPath: string;
    streamType?: RecordingStreamType;
    /** If true, attempt to wake a sleeping battery camera before download (default false). */
    ensureAwake?: boolean;
    /** Override ffmpeg binary path (default: "ffmpeg" from PATH). */
    ffmpegPath?: string;
    /** Overwrite outputPath if it already exists (default true). */
    overwrite?: boolean;
  }): Promise<void> {
    await this.client.login();

    const channel = this.normalizeChannel(params.channel);
    const streamType = params.streamType ?? "mainStream";
    const ensureAwake = params.ensureAwake ?? false;
    const ffmpegPath = params.ffmpegPath ?? "ffmpeg";
    const overwrite = params.overwrite ?? true;

    await mkdir(dirname(params.outputPath), { recursive: true });

    const runOnce = async (): Promise<void> => {
      if (ensureAwake) {
        // Best-effort: keep battery cams awake for the heavy transfer.
        await this.wakeUp(channel, { waitAfterWakeMs: 1500, attempts: 3 });
      }

      const rtmpUrl = await this.getVodRtmpUrl({
        channel,
        fileName: params.fileName,
        streamType,
        ensureEnabled: true,
      });

      await new Promise<void>((resolve, reject) => {
        const ff = spawn(ffmpegPath, [
          "-hide_banner",
          "-loglevel",
          "error",
          ...(overwrite ? ["-y"] : []),
          "-rtmp_live",
          "live",
          "-i",
          rtmpUrl,
          "-c",
          "copy",
          "-movflags",
          "frag_keyframe+empty_moov",
          "-f",
          "mp4",
          params.outputPath,
        ]);

        let stderr = "";
        ff.stderr.on("data", (d) => {
          stderr += String(d);
        });

        ff.on("close", (code) => {
          if (code === 0) return resolve();
          reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        });

        ff.on("error", reject);
      });
    };

    try {
      await runOnce();
    } catch (e) {
      // One retry helps with battery cams going to sleep / stale sessions.
      if (ensureAwake) {
        try {
          await this.wakeUp(channel, { waitAfterWakeMs: 3000, attempts: 3, reconnect: true });
        } catch {
          // ignore
        }
      }
      await runOnce();
    }
  }

  /**
   * Generate a single-frame screenshot from a local MP4 file at the given timestamp.
   *
   * Requirements:
   * - `ffmpeg` must be available in PATH, or provide `ffmpegPath`.
   */
  async generateMp4Screenshot(params: {
    inputPath: string;
    outputPath: string;
    atSeconds: number;
    /** Override ffmpeg binary path (default: "ffmpeg" from PATH). */
    ffmpegPath?: string;
  }): Promise<void> {
    const ffmpegPath = params.ffmpegPath ?? "ffmpeg";
    const atSeconds = Number.isFinite(params.atSeconds) && params.atSeconds >= 0 ? params.atSeconds : 0;

    await mkdir(dirname(params.outputPath), { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(atSeconds),
        "-i",
        params.inputPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        params.outputPath,
      ]);

      let stderr = "";
      ff.stderr.on("data", (d) => {
        stderr += String(d);
      });

      ff.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg screenshot exited with code ${code}\n${stderr}`));
      });

      ff.on("error", reject);
    });
  }

  /**
   * Download a recording via Baichuan FileInfoList download (cmdId=13, class=0x6482).
   * Returns raw bytes (often an mp4/flv/ps payload depending on firmware/camera).
   */
  async downloadRecording(params: DownloadRecordingParams): Promise<Buffer> {
    await this.client.login();

    const channel = this.normalizeChannel(params.channel);
    const uid = await this.ensureUidForRecordings(channel, params.uid);
    const fileName = params.fileName;

    const name = fileName.includes("/") ? fileName.split("/").filter(Boolean).at(-1) ?? fileName : fileName;

    const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${channel}</channelId>
<uid>${xmlEscape(uid)}</uid>
<fileName>${xmlEscape(fileName)}</fileName>
<name>${xmlEscape(name)}</name>
<Id>${xmlEscape(fileName)}</Id>
</FileInfo>
</FileInfoList>
</body>`;

    const fallbackToHttp = params.fallbackToHttp ?? false;

    try {
      return await this.client.sendBinary({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
        channel,
        messageClass: BC_CLASS_FILE_DOWNLOAD,
        extensionXml: buildBinaryExtensionXml(channel),
        payloadXml,
        timeoutMs: params.timeoutMs ?? 120_000,
      });
    } catch (e) {
      if (!fallbackToHttp) throw e;

      // Fallback: HTTP CGI Download.
      // Many firmwares expose recordings for download via /cgi-bin/api.cgi?cmd=Download&source=...
      const wantedFilename = fileName.replaceAll("/", "_").replaceAll("\\", "_");
      try {
        // If filename matches Rec* pattern, include `start=YYYYMMDDHHMMSS`
        // to help the firmware locate the clip.
        const m = /Rec(\w{3})(?:_|_DST)(\d{8})_(\d{6})_.*/.exec(fileName);
        const startParam = m ? `${m[2]}${m[3]}` : undefined;

        const candidates: string[] = [];
        const pushUnique = (s: string | undefined) => {
          const v = s?.trim();
          if (!v) return;
          if (!candidates.includes(v)) candidates.push(v);
        };

        pushUnique(fileName);
        // Common FileInfoList Ids look like /mnt/sda/Mp4Record/YYYY-MM-DD/Rec....mp4
        pushUnique(fileName.replace(/^\/mnt\/[a-zA-Z0-9]+\//, ""));
        pushUnique(fileName.replace(/^\//, ""));

        let lastErr: unknown;
        for (const source of candidates) {
          try {
            return await this.httpClient.downloadVod(source, wantedFilename, startParam);
          } catch (ee) {
            lastErr = ee;
            const msg = ee instanceof Error ? ee.message : String(ee);
            // Try next path variant on 404.
            if (msg.startsWith("HTTP 404")) continue;
            throw ee;
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      } catch (e2) {
        const err1 = e instanceof Error ? e.message : String(e);
        const err2 = e2 instanceof Error ? e2.message : String(e2);
        throw new Error(`downloadRecording failed (baichuan then http). baichuanErr=${err1}; httpErr=${err2}`);
      }
    }
  }

  /**
   * Subscribe to events (motion/AI/visitor) via Baichuan.
   * cmd_id: 31 (subscribe_events)
   * After subscribing, events will be emitted via client.on("event", ...)
   */
  async subscribeEvents(): Promise<void> {
    await this.client.login();
    // NOTE: Some battery firmwares reject the old "channelId=251 Extension" approach with responseCode=421.
    // Send MSG_ID 31 with *empty* body and channel_id set to the camera channel (0-based).
    const channel = this.client.getConfiguredChannel?.() ?? 0;

    const attempts: Array<{ label: string; params: Parameters<BaichuanClient["sendFrame"]>[0] }> = [
      {
        label: `channelId=${channel} bodyLen=0`,
        params: { cmdId: 31, channelIdOverride: channel, messageClass: BC_CLASS_MODERN_24 },
      },
      {
        // Use ch_id=251 for push subscription.
        label: "push channelId=251 bodyLen=0",
        params: { cmdId: 31, channelIdOverride: 251, messageClass: BC_CLASS_MODERN_24 },
      },
      {
        label: "host channelId=250 bodyLen=0",
        params: { cmdId: 31, channelIdOverride: 250, messageClass: BC_CLASS_MODERN_24 },
      },
      {
        label: "legacy Extension channelId=251",
        params: {
          cmdId: 31,
          channelIdOverride: 250,
          messageClass: BC_CLASS_MODERN_24,
          extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>251</channelId></Extension>`,
        },
      },
    ];

    let lastCode: number | undefined;
    for (const a of attempts) {
      const frame = await this.client.sendFrame({ ...a.params, timeoutMs: 10_000 });
      lastCode = frame.header.responseCode;
      if (frame.header.responseCode === 200) {
        this.client.subscribed = true;
        this.client.refreshKeepAlive?.();
        return;
      }
      // Keep trying other variants.
      (this.logger.debug ?? this.logger.log).call(this.logger, `[ReolinkBaichuanApi] subscribeEvents rejected (${a.label}) responseCode=${frame.header.responseCode}`);
    }

    this.client.subscribed = false;
    this.client.refreshKeepAlive?.();
    throw new Error(`subscribeEvents failed: camera rejected cmdId=31 (last responseCode=${lastCode ?? "unknown"})`);
  }

  /**
   * Subscribe to events for all "own" channels.
   *
   * Intended for NVR/HomeHub setups where multiple channels share the same host.
   *
   * Implementation notes:
   * - Send cmd_id=31 with empty body and 0-based header channel_id per channel.
   * - some firmwares instead accept a single push subscription (header channelId=251).
   */
  async subscribeToAllEvents(options?: {
    /** Max channels to probe when enumerating (default 16). */
    maxChannels?: number;
    /** Timeout for each subscribe attempt (default 10000ms). */
    timeoutMs?: number;
  }): Promise<void> {
    await this.client.login();

    const maxChannels = options?.maxChannels ?? 16;
    const timeoutMs = options?.timeoutMs ?? 10_000;

    // Prefer channels discovered via cmd_id 145 push.
    // Filter out empty slots (state==none) and cap to maxChannels when present.
    const channels = Array.from(this.channelPushData.entries())
      .filter(([, v]) => (v.stateLower ?? v.state).toLowerCase() !== "none")
      .map(([ch]) => ch)
      .filter((ch) => Number.isFinite(ch))
      .sort((a, b) => a - b)
      .slice(0, maxChannels);

    let okCount = 0;
    let lastCode: number | undefined;
    for (const channel of channels) {
      const frame = await this.client.sendFrame({
        cmdId: 31,
        channelIdOverride: Number(channel),
        messageClass: BC_CLASS_MODERN_24,
        timeoutMs,
      });
      lastCode = frame.header.responseCode;
      if (frame.header.responseCode === 200) {
        okCount++;
      } else {
        (this.logger.debug ?? this.logger.log).call(
          this.logger,
          `[ReolinkBaichuanApi] subscribeToAllEvents rejected (channel=${channel}) responseCode=${frame.header.responseCode}`,
        );
      }
    }

    if (okCount > 0) {
      this.client.subscribed = true;
      this.client.refreshKeepAlive?.();
      return;
    }

    // Fallback for firmwares that only accept a single push subscription.
    try {
      await this.subscribeEvents();
      return;
    } catch {
      // ignore; throw consolidated error below.
    }

    this.client.subscribed = false;
    this.client.refreshKeepAlive?.();
    throw new Error(
      `subscribeToAllEvents failed: camera rejected cmdId=31 for all channels (last responseCode=${lastCode ?? "unknown"})`,
    );
  }

  /**
   * Unsubscribe from events.
   */
  async unsubscribeEvents(): Promise<void> {
    // Note: There's no explicit unsubscribe, but closing connection unsubscribes
    // For now, we just mark as unsubscribed
    this.client.subscribed = false;
    // For BCUDP/battery cameras: allow the camera to sleep when idle.
    this.client.refreshKeepAlive?.();
  }

  /**
   * Check current motion and AI state and dispatch events if state changed.
   * This is called immediately after subscription and periodically during polling.
   */
  private async checkAndDispatchCurrentState(channel: number = 0): Promise<void> {
    try {
      // Check motion state
      let motionState: boolean;
      try {
        motionState = await this.getMotionState(channel);
      } catch (error) {
        // NOTE: Scrypted logger often JSON-stringifies Error -> "{}".
        // Log an explicit message so we can identify failing endpoints (cmdId=46).
        const msg = formatErrorForLog(error);
        (this.logger.warn ?? this.logger.error)?.call(
          this.logger,
          `[ReolinkBaichuanApi] getMotionState failed (cmdId=46 ch=${channel})${formatClientIoForLog(this)}: ${msg}`,
        );
        return;
      }
      if (motionState !== this.lastMotionState) {
        this.lastMotionState = motionState;
        if (motionState) {
          // Dispatch motion event
          const event: ReolinkSimpleEvent = {
            type: "motion",
            channel,
            timestamp: Date.now(),
          };
          this.dispatchSimpleEvent(event);
        }
      }

      // Check AI state (if supported)
      if (!this.aiStatePollingDisabled) {
        try {
          const aiState = await this.getAiState(channel);
          if (aiState && aiState.alarm_state !== undefined) {
            const aiStateChanged =
              !this.lastAiState ||
              this.lastAiState.alarm_state !== aiState.alarm_state ||
              this.lastAiState.support !== aiState.support;

            if (aiStateChanged) {
              this.lastAiState = aiState;

              if (aiState.alarm_state === 1) {
                const event: ReolinkSimpleEvent = {
                  type: "other",
                  channel,
                  timestamp: Date.now(),
                };
                this.dispatchSimpleEvent(event);
              }
            }
          }
        } catch (error) {
          // Some firmwares/NVRs reject cmd 342 and may also tear down the TCP session.
          // To avoid a reconnect loop, disable AI polling after the first failure.
          this.aiStatePollingDisabled = true;

          const msg =
            error && typeof error === "object" && "message" in error
              ? String((error as any).message)
              : String(error);

          if (!msg.includes("not supported") && !msg.includes("unsupported")) {
            (this.logger.debug ?? this.logger.log)?.call(
              this.logger,
              "[ReolinkBaichuanApi] getAiState failed; disabling AI polling",
              error,
            );
          }

          if (!this.aiStatePollingDisabledLogged) {
            this.aiStatePollingDisabledLogged = true;
            this.logger.debug?.(
              "[ReolinkBaichuanApi] AI polling disabled after getAiState failure",
              error,
            );
          }
        }
      }
    } catch (e) {
      // Log but don't throw - state checking should be best-effort
      const msg = formatErrorForLog(e);
      (this.logger.warn ?? this.logger.error)?.call(
        this.logger,
        `[ReolinkBaichuanApi] Error checking current state (ch=${channel})${formatClientIoForLog(this)}: ${msg}`,
      );
    }
  }

  /**
   * Start periodic polling of motion and AI state (every 5 seconds).
   * Only starts if there are listeners and polling is not already running.
   * Polling is disabled for UDP/battery cameras to avoid waking them unnecessarily.
   */
  private startStatePolling(): void {
    // Polling is opt-in: default is push-only.
    // Keep this guard here even if callsites already check it.
    const pollingEnabled = this.client.isStatePollingEnabled?.() ?? false;
    if (!pollingEnabled) {
      this.stopStatePolling();
      return;
    }

    // Only poll if there are listeners
    if (this.simpleEventListeners.size === 0) {
      return;
    }

    // Multi-channel hosts (NVR/Home Hub) should rely on push events. Polling tends to be noisy
    // (and can trigger reconnect loops) especially when some channels are sleeping/offline.
    if (this.channelPushData.size > 1) {
      return;
    }

    // Don't poll for UDP/battery cameras - they should rely on event pushes only
    const isUdp = this.client.getTransport?.() === "udp";
    if (isUdp) {
      return;
    }

    // Don't start if already running
    if (this.statePollingInterval) {
      return;
    }

    // Poll every 5 seconds (TCP only)
    this.statePollingInterval = setInterval(async () => {
      try {
        // Only poll if there are still listeners
        if (this.simpleEventListeners.size === 0) {
          this.stopStatePolling();
          return;
        }

        const channel = this.client.getConfiguredChannel?.() ?? 0;
        await this.checkAndDispatchCurrentState(channel);
      } catch (e) {
        // Never allow polling errors to crash callers.
        const msg = formatErrorForLog(e);
        this.logger.debug?.(`[ReolinkBaichuanApi] state polling tick failed${formatClientIoForLog(this)}: ${msg}`);
      }
    }, 5000);
  }

  /**
   * Stop periodic polling of motion and AI state.
   */
  private stopStatePolling(): void {
    if (this.statePollingInterval) {
      clearInterval(this.statePollingInterval);
      this.statePollingInterval = undefined;
    }
  }

  /**
   * GetEvents via Baichuan (legacy - use subscribeEvents for real-time events).
   * cmd_id: 33 (Motion/AI/Visitor event)
   * Note: Events are typically pushed via cmd_id 33, not requested directly
   * Use subscribeEvents() to receive event pushes
   */
  async getEvents(channel?: number): Promise<Events> {
    // Note: Events are typically pushed, not requested
    // cmd_id 33 is used for event pushes, cmd_id 31 is for subscribing
    // This is a placeholder - actual implementation may need event subscription
    const cmdId = 33; // Event push
    const xml = await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
    const ch = this.normalizeChannel(channel);
    const now = Date.now();

    const out: Events = { channel: ch };

    // Format: AlarmEventList
    if (xml.includes("<AlarmEventList")) {
      const alarmEventMatches = xml.matchAll(/<AlarmEvent\b[^>]*>([\s\S]*?)<\/AlarmEvent>/g);
      for (const match of alarmEventMatches) {
        const alarmXml = match[1] ?? "";
        const channelText = getXmlText(alarmXml, "channelId");
        const eventChannel = channelText !== undefined ? Number(channelText) : ch;
        if (eventChannel !== ch) continue;

        const statusUpper = ((getXmlText(alarmXml, "status") ?? "").trim()).toUpperCase();
        const aiTypeRaw = (getXmlText(alarmXml, "AItype") ?? getXmlText(alarmXml, "aiType") ?? getXmlText(alarmXml, "aitype") ?? "").trim();

        if (statusUpper.includes("MD")) {
          out.motion = { state: 1, timestamp: now, source: "md" };
        }
        if (statusUpper.includes("PIR")) {
          out.motion = { state: 1, timestamp: now, source: "pir" };
        }

        const aiTypeToken = aiTypeRaw
          ? aiTypeRaw
            .split(",")
            .map((t) => t.trim())
            .find((t) => t.length > 0 && t.toLowerCase() !== "none")
          : undefined;
        if (aiTypeToken || statusUpper.includes("AI")) {
          out.ai = {
            channel: ch,
            alarm_state: 1,
            type: aiTypeToken,
          };
        }

        if (statusUpper.includes("VIS")) {
          (out).visitor = { detected: true, timestamp: now };
        }
      }
      return out;
    }

    // Fallback: Event
    const statusUpper = ((getXmlText(xml, "status") ?? "").trim()).toUpperCase();
    const aiTypeRaw = (getXmlText(xml, "AItype") ?? getXmlText(xml, "aiType") ?? getXmlText(xml, "aitype") ?? "").trim();

    if (statusUpper.includes("MD")) out.motion = { state: 1, timestamp: now, source: "md" };
    if (statusUpper.includes("PIR")) out.motion = { state: 1, timestamp: now, source: "pir" };
    if (aiTypeRaw || statusUpper.includes("AI")) out.ai = { channel: ch, alarm_state: 1, type: aiTypeRaw || undefined };
    if (statusUpper.includes("VIS")) (out).visitor = { detected: true, timestamp: now };

    return out;
  }

  /**
   * Get two-way audio capability via Baichuan.
   * cmd_id: 10 (checks if two-way audio is supported)
   * Returns true if two-way audio is available.
   * 
   * Note: Both "mixAudioStream" and "followVideoStream" modes support two-way audio.
   * The difference is how audio is mixed with the video stream.
   */
  async getTwoWayAudioConfig(channel?: number): Promise<TwoWayAudioConfig> {
    const cmdId = 10; // Two-way audio check
    const xml = await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
    // Check for audioStreamMode - both mixAudioStream and followVideoStream support two-way audio
    const audioStreamMode = getXmlText(xml, "audioStreamMode");
    // Both modes support two-way audio, just different mixing strategies
    const enabled = audioStreamMode === "mixAudioStream" || audioStreamMode === "followVideoStream";

    const config: TwoWayAudioConfig = {
      channel: channel ?? 0,
      enabled,
    };
    if (audioStreamMode) {
      config.mode = audioStreamMode;
    }
    return config;
  }

  /**
   * Start video stream via Baichuan protocol.
   * Video stream subscription implementation.
   * 
   * Uses MSG_ID_VIDEO command with Preview XML payload containing:
   * - channelId: Channel ID (1-based)
   * - handle: Stream handle (0 for main, 256 for sub, 1024 for extern)
   * - streamType: Stream name ("mainStream", "subStream", "externStream")
   * 
   * @param channel - Channel number (0-based)
   * @param profile - Stream profile ("main" | "sub" | "ext")
   * @returns Promise that resolves when stream request is sent
   */
  async startVideoStream(
    channel?: number,
    profile: StreamProfile = "sub",
    options?: {
      /** Native-only: request TrackMix tele/autotrack variants (usually on NVR/Hub). */
      variant?: NativeVideoStreamVariant;
    }
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    // Use the same 0-based channel_id everywhere (header, Extension, payload).
    const channelId = ch;

    const variant: NativeVideoStreamVariant = options?.variant ?? "default";

    // Map profile to handle and stream_type values.
    // handle: 0 for main, 256 for sub, 1024 for extern
    // streamType in header:
    // - 0 main/ext (default)
    // - 1 sub (default)
    // - 2 main (autotrack/telephoto)
    // - 3 sub (autotrack/telephoto)
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number; streamName: string }> = {
      main: {
        handle: 0,
        streamType: variant === "default" ? 0 : 2,
        // For preview XML, keep the canonical stream name; the variant is selected via header streamType.
        streamName: "mainStream",
      },
      sub: {
        handle: 256,
        streamType: variant === "default" ? 1 : 3,
        streamName: "subStream",
      },
      ext: { handle: 1024, streamType: 0, streamName: "externStream" },
    };

    if (variant !== "default" && profile === "ext") {
      throw new Error(`Invalid native stream variant for profile: ${profile} (variant=${variant})`);
    }

    const config = profileConfig[profile];
    if (!config) {
      throw new Error(`Invalid stream profile: ${profile}`);
    }
    if (!config.streamName) {
      throw new Error(`Stream name not found for profile: ${profile}, config: ${JSON.stringify(config)}`);
    }

    // Build Preview XML payload
    // BcXml serializes as <body>...</body> with Preview inside
    // IMPORTANT: channelId is NOT in Preview XML - it's handled via channelId in header
    // The working format (response_code 200) is Preview WITHOUT channelId
    const streamName = config.streamName;
    // Debug: verify streamName is defined
    if (typeof streamName !== "string") {
      throw new Error(`streamName is not a string: ${typeof streamName}, value: ${streamName}, config: ${JSON.stringify(config)}`);
    }
    const payloadXml = buildPreviewXml(config.handle, streamName, channelId);

    // PCAP-observed Hub/NVR Preview request for "tele" view uses Preview v1.1 and keeps header streamType=0.
    // We observed two distinct patterns:
    // - Sub tele:  <channelId>CH</channelId> <handle>512+CH</handle>  <streamType>mobileStream</streamType>
    // - Main tele: <channelId>CH</channelId> <handle>1024+CH</handle> <streamType>externStream</streamType>
    // Also, some firmwares appear to use 0-based CH, others 1-based.
    const telePreviewStreamType =
      variant === "telephoto" && profile === "main" ? "externStream" : variant === "telephoto" && profile === "sub" ? "mobileStream" : undefined;
    const teleHandleBase =
      variant === "telephoto" && profile === "main" ? 1024 : variant === "telephoto" && profile === "sub" ? 512 : undefined;
    const teleChannelIdCandidates =
      variant === "telephoto" && telePreviewStreamType && teleHandleBase !== undefined
        ? Array.from(new Set([channelId, channelId + 1].filter((n) => Number.isFinite(n) && n >= 0)))
        : [];

    // Log stream request details for debugging
    // if (this.logger?.log) {
    //   try {
    //     this.logger.log(
    //       `[ReolinkBaichuanApi] startVideoStream REQUEST: channel=${ch}, profile=${profile}, variant=${variant}, streamType=${config.streamType}, handle=${config.handle}, streamName=${streamName}`
    //     );
    //   } catch {
    //     // Ignore logging errors
    //   }
    // }

    // Subscribe (MSG_ID_VIDEO, msg_num) BEFORE sending the command.
    // On some BCUDP/battery models, the start-stream request can sporadically timeout;
    // retry a few times and ensure we unsubscribe on failures.
    const isUdp = this.client.getTransport?.() === "udp";
    const maxAttempts = isUdp ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // NOTE: must be atomic. Two parallel startVideoStream() calls (e.g. composite wider+tele)
      // can otherwise pick the same msgNum and cause stream packet mixups.
      const msgNum = this.client.reserveNextMsgNum();
      this.client.subscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);

      // Optimistically publish msgNum immediately so stream consumers can start filtering
      // even if the NVR/Hub takes a long time to reply to the start request.
      this.activeVideoMsgNums.set(`${ch}:${profile}:${variant}`, msgNum);

      try {
        const baseParams: Parameters<typeof this.client.sendFrame>[0] = {
          cmdId: BC_CMD_ID_VIDEO,
          channel: ch,
          channelIdOverride: channelId,
          msgNumOverride: msgNum,
          extensionXml: buildChannelExtensionXml(channelId),
          payloadXml,
          messageClass: BC_CLASS_MODERN_24,
          streamType: config.streamType,
          // Some NVR firmwares are slow or flaky replying to the VIDEO start command.
          // The stream may still start, but waiting a bit longer reduces false timeouts.
          timeoutMs: 20_000,
        };

        // Try the PCAP-observed tele Preview v1.1 request first (and try both 0-based and 1-based channelId tags),
        // then fall back to the legacy request.
        let frame: Awaited<ReturnType<typeof this.client.sendFrame>> | undefined;
        if (teleChannelIdCandidates.length > 0 && telePreviewStreamType && teleHandleBase !== undefined) {
          for (const teleChannelIdTag of teleChannelIdCandidates) {
            try {
              frame = await this.client.sendFrame({
                ...baseParams,
                // Client traffic shows no Extension XML on VIDEO start.
                extensionXml: "",
                payloadXml: buildPreviewXmlV11({
                  channelId: teleChannelIdTag,
                  handle: teleHandleBase + teleChannelIdTag,
                  streamType: telePreviewStreamType,
                }),
                streamType: 0,
              });
              break;
            } catch {
              // continue
            }
          }
        }
        if (!frame) frame = await this.client.sendFrame(baseParams);

        // if (this.logger?.log) {
        //   try {
        //     this.logger.log(
        //       `[ReolinkBaichuanApi] startVideoStream response: channel=${ch}, profile=${profile}, variant=${variant}, streamType=${config.streamType}, responseCode=${frame.header.responseCode}, msgNum=${frame.header.msgNum}`
        //     );
        //   } catch {
        //     // Ignore logging errors
        //   }
        // }

        if (frame.header.responseCode !== 200) {
          throw new Error(
            `Video stream request rejected (response_code ${frame.header.responseCode}). Expected response_code 200, camera returned ${frame.header.responseCode}`
          );
        }

        // Remember msgNum so we can stop the stream with the same msgNum.
        this.activeVideoMsgNums.set(`${ch}:${profile}:${variant}`, frame.header.msgNum);

        // Success.
        return;
      } catch (error) {
        lastError = error;
        try {
          this.client.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
        } catch {
          // ignore
        }

        // If the request failed, clear the optimistic mapping.
        this.activeVideoMsgNums.delete(`${ch}:${profile}:${variant}`);

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));

    // Success - stream should start and frames will arrive as push events with cmd_id 3

    // Check for response code 200 (success)
    // Expect response_code: 200 in the reply
    // If response_code is not 200, the stream request was rejected
    // Note: sendXml doesn't expose response_code directly, but it throws on 400 errors
    // For video streaming, we might need to check the actual frame response_code
  }

  /**
   * Returns the msgNum associated with an active video stream subscription, if any.
   * This can be used by stream consumers to filter incoming cmd_id=3 frames and
   * avoid mixing multiple concurrent streams on the same Baichuan client.
   */
  getActiveVideoMsgNum(channel?: number, profile: StreamProfile = "sub"): number | undefined {
    const ch = this.normalizeChannel(channel);
    return this.activeVideoMsgNums.get(`${ch}:${profile}:default`);
  }

  getActiveVideoMsgNumWithVariant(
    channel: number,
    profile: StreamProfile,
    variant: NativeVideoStreamVariant = "default",
  ): number | undefined {
    const ch = this.normalizeChannel(channel);
    return this.activeVideoMsgNums.get(`${ch}:${profile}:${variant}`);
  }

  /**
   * Stop video stream via Baichuan protocol.
   * Stop video stream subscription.
   * 
   * Uses MSG_ID_VIDEO_STOP command with Preview XML payload (without stream_type).
   * 
   * @param channel - Channel number (0-based)
   * @param profile - Stream profile ("main" | "sub" | "ext")
   */
  async stopVideoStream(
    channel?: number,
    profile: StreamProfile = "sub",
    options?: {
      /** Native-only: stop TrackMix tele/autotrack variants (must match the started variant). */
      variant?: NativeVideoStreamVariant;
    }
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;

    const variant: NativeVideoStreamVariant = options?.variant ?? "default";

    // Map profile to handle value
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number }> = {
      main: { handle: 0, streamType: variant === "default" ? 0 : 2 },
      sub: { handle: 256, streamType: variant === "default" ? 1 : 3 },
      ext: { handle: 1024, streamType: 0 },
    };

    if (variant !== "default" && profile === "ext") {
      throw new Error(`Invalid native stream variant for profile: ${profile} (variant=${variant})`);
    }

    const config = profileConfig[profile];

    const teleHandleBase =
      variant === "telephoto" && profile === "main" ? 1024 : variant === "telephoto" && profile === "sub" ? 512 : undefined;
    const teleChannelIdCandidates =
      variant === "telephoto" && teleHandleBase !== undefined
        ? Array.from(new Set([channelId, channelId + 1].filter((n) => Number.isFinite(n) && n >= 0)))
        : [];

    const key = `${ch}:${profile}:${variant}`;
    const msgNum = this.activeVideoMsgNums.get(key);
    this.activeVideoMsgNums.delete(key);

    // Send VIDEO_STOP with the same msg_num as VIDEO.
    // Some cameras don't reliably reply; treat this as best-effort with a short timeout.
    try {
      const attempts: Array<{ extensionXml: string; payloadXml: string; streamType: number }> = [];

      // Hub/NVR multifocal tele streams are started with Preview v1.1 + streamType=0 and a handle derived from channelId.
      if (teleChannelIdCandidates.length > 0 && teleHandleBase !== undefined) {
        for (const teleChannelIdTag of teleChannelIdCandidates) {
          const handle = teleHandleBase + teleChannelIdTag;
          attempts.push({
            extensionXml: "",
            payloadXml: buildPreviewStopXmlV11({ channelId: teleChannelIdTag, handle }),
            streamType: 0,
          });
          // Some firmwares accept v1.0 stop with channelId present.
          attempts.push({
            extensionXml: "",
            payloadXml: buildPreviewStopXml(handle, teleChannelIdTag),
            streamType: 0,
          });
        }
      }

      // Legacy stop.
      attempts.push({
        extensionXml: buildChannelExtensionXml(channelId),
        payloadXml: buildPreviewStopXml(config.handle, channelId),
        streamType: config.streamType,
      });

      // If we started tele via the hub path, streamType was 0; try that too.
      if (variant === "telephoto" && profile !== "ext") {
        attempts.push({
          extensionXml: buildChannelExtensionXml(channelId),
          payloadXml: buildPreviewStopXml(config.handle, channelId),
          streamType: 0,
        });
      }

      for (const a of attempts) {
        try {
          await this.client.sendFrame({
            cmdId: BC_CMD_ID_VIDEO_STOP,
            channel: ch,
            channelIdOverride: channelId,
            extensionXml: a.extensionXml,
            payloadXml: a.payloadXml,
            messageClass: BC_CLASS_MODERN_24,
            streamType: a.streamType,
            ...(msgNum !== undefined ? { msgNumOverride: msgNum } : {}),
            timeoutMs: 2000,
          });
          break;
        } catch {
          // continue
        }
      }
    } catch {
      // ignore
    } finally {
      // IMPORTANT: startVideoStream subscribes (MSG_ID_VIDEO=3, msgNum) to filter push frames and
      // to drive keepalive/idle-disconnect decisions in BaichuanClient.
      // Always unsubscribe when stopping the stream, even if VIDEO_STOP times out.
      try {
        if (msgNum !== undefined) this.client.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
      } catch {
        // ignore
      }
    }
  }

  // --------------------
  // PTZ Control APIs
  // --------------------

  /**
   * Get PTZ preset list via Baichuan.
   * cmd_id: 190 (MSG_ID_GET_PTZ_PRESET)
   * 
   * @param channel - Channel number (0-based)
   * @returns Array of PTZ presets
   */
  async getPtzPresets(channel?: number): Promise<PtzPreset[]> {
    const ch = this.normalizeChannel(channel);
    // Use the same channel_id everywhere (header, Extension, payload).
    // This is 0-based.
    const channelId = ch;
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PTZ_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml: buildChannelExtensionXml(channelId),
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    const parsed = this.parsePtzPresetList(xml);
    const presets: PtzPreset[] = parsed
      // Expose only enabled presets (enable="1" or not present). Disabled presets should not show up in UI.
      .filter((p) => p.enable === undefined || p.enable === "1")
      // Treat empty name as deleted/disabled.
      .filter((p) => p.name === undefined || String(p.name).trim() !== "")
      .map((p) => ({
        id: p.id,
        name: p.name ?? `Preset ${p.id}`,
      }));

    return presets;
  }

  private parsePtzPresetList(xml: string): Array<{ id: number; name?: string; enable?: string }> {
    const parsed: Array<{ id: number; name?: string; enable?: string }> = [];
    const presetMatches = xml.matchAll(/<preset\b[^>]*>([\s\S]*?)<\/preset>/gi);
    for (const match of presetMatches) {
      const presetXml = match[1] ?? "";
      const idText = /<id>([^<]*)<\/id>/i.exec(presetXml)?.[1];
      if (!idText) continue;
      const id = Number(idText);
      if (!Number.isFinite(id)) continue;
      const nameMatch = /<name>([^<]*)<\/name>/i.exec(presetXml);
      const enableMatch = /<enable>([^<]*)<\/enable>/i.exec(presetXml);

      const entry: { id: number; name?: string; enable?: string } = { id };
      const name = nameMatch?.[1];
      const enable = enableMatch?.[1];
      if (name !== undefined) entry.name = name;
      if (enable !== undefined) entry.enable = enable;
      parsed.push(entry);
    }
    return parsed;
  }

  private async getPtzPresetsRaw(channel: number): Promise<Array<{ id: number; name?: string; enable?: string }>> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PTZ_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml: buildChannelExtensionXml(channelId),
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });
    return this.parsePtzPresetList(xml);
  }

  /**
   * Send PTZ control command (pan/tilt/zoom).
   * cmd_id: 18 (MSG_ID_PTZ_CONTROL)
   * 
   * @param channel - Channel number (0-based)
   * @param command - PTZ command
   * @returns Promise that resolves when command is sent
   */
  async ptz(command: PtzCommand): Promise<void>;
  async ptz(channel: number, command: PtzCommand): Promise<void>;
  async ptz(channelOrCommand: number | PtzCommand, command?: PtzCommand): Promise<void> {
    const ch = typeof channelOrCommand === "number" ? this.normalizeChannel(channelOrCommand) : 0;
    const resolvedCommand = typeof channelOrCommand === "number" ? command! : channelOrCommand;
    // Use the same channel_id in meta header, Extension and payload XML.
    // This is 0-based.
    const channelId = ch;

    // Support only: "up", "down", "left", "right", "stop" via MSG_ID_PTZ_CONTROL.
    // Zoom/focus are separate messages (e.g. 294/295).
    let direction: "up" | "down" | "left" | "right" | "stop";
    if (resolvedCommand.action === "stop") {
      direction = "stop";
    } else {
      const cmdMap: Record<string, "up" | "down" | "left" | "right"> = {
        Left: "left",
        Right: "right",
        Up: "up",
        Down: "down",
      };
      const mapped = cmdMap[resolvedCommand.command];
      if (!mapped) {
        throw new Error(`Unsupported PTZ command for MSG_ID_PTZ_CONTROL: ${resolvedCommand.command}`);
      }
      direction = mapped;
    }

    // Speed is f32; typical values are ~32.
    // Some integrations provide a normalized 0..1 speed; map that to 0..64.
    let speed: number;
    if (direction === "stop") {
      speed = 0;
    } else {
      const raw = resolvedCommand.speed;
      if (raw === undefined) {
        speed = 32;
      } else if (raw > 0 && raw <= 1) {
        speed = Math.max(1, raw * 64);
      } else {
        speed = raw;
      }
    }

    const payloadXml = buildPtzControlXml(channelId, direction, speed);

    // Include Extension with channel_id for PTZ commands.
    const extensionXml = buildChannelExtensionXml(channelId);

    // Subscribe before sending PTZ commands
    // However, sendFrame already handles the response via pending map using cmdId:messageKey
    // The subscribe is for routing responses, which sendFrame already does
    // So we don't need explicit subscribeVideoStream here

    // Use sendFrame to check response_code (expects 200)
    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_PTZ_CONTROL,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      // Try to get error details from body if available
      let errorDetails = "";
      if (frame.body.length > 0) {
        try {
          // Access private method via type assertion (needed for error details)
          const tryDecryptXml = (this.client).tryDecryptXml;
          if (tryDecryptXml) {
            const errorXml = tryDecryptXml.call(this.client, frame.body, frame.header.channelId, this.client.enc);
            if (errorXml) {
              errorDetails = ` - Error details: ${errorXml.substring(0, 200)}`;
            }
          }
        } catch {
          // Ignore decryption errors.
        }
      }
      throw new Error(`PTZ control rejected (response_code ${frame.header.responseCode})${errorDetails}`);
    }

    // If action is "start", send a stop after a short delay.
    // Some integrations need to tune the movement amount per command.
    if (resolvedCommand.action === "start" && direction !== "stop") {
      const autoStopMs = resolvedCommand.autoStopMs ?? 500;
      if (autoStopMs > 0) {
        setTimeout(() => {
          this.ptz(ch, { action: "stop", command: resolvedCommand.command }).catch(() => {
            // Ignore stop errors
          });
        }, autoStopMs);
      }
    }
  }

  /**
   * Move to PTZ preset position.
   * cmd_id: 19 (MSG_ID_PTZ_CONTROL_PRESET)
   * 
   * @param channel - Channel number (0-based)
   * @param presetId - Preset ID
   */
  async moveToPtzPreset(presetId: number, channel?: number): Promise<void>;
  async moveToPtzPreset(channel: number, presetId: number): Promise<void>;
  async moveToPtzPreset(arg1: number, arg2?: number): Promise<void> {
    // If 2 args are provided, interpret as (channel, presetId).
    const ch = arg2 === undefined ? this.normalizeChannel(undefined) : this.normalizeChannel(arg1);
    const presetId = arg2 === undefined ? arg1 : arg2;
    const channelId = ch;
    const payloadXml = buildPtzPresetXml(channelId, presetId, "toPos");

    // Include extension with channel_id for PTZ preset commands
    const extensionXml = buildChannelExtensionXml(channelId);

    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_PTZ_CONTROL_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      throw new Error(`PTZ preset move rejected (response_code ${frame.header.responseCode})`);
    }
  }

  /**
   * Save current position as PTZ preset.
   * cmd_id: 19 (MSG_ID_PTZ_CONTROL_PRESET)
   * 
   * @param channel - Channel number (0-based)
   * @param presetId - Preset ID
   * @param name - Preset name
   */
  async setPtzPreset(presetId: number, name: string, channel?: number): Promise<void>;
  async setPtzPreset(channel: number, presetId: number, name: string): Promise<void>;
  async setPtzPreset(arg1: number, arg2: number | string, arg3?: string | number): Promise<void> {
    const ch = typeof arg2 === "string" ? this.normalizeChannel(arg3 as number | undefined) : this.normalizeChannel(arg1);
    const presetId = typeof arg2 === "string" ? arg1 : (arg2 as number);
    const name = typeof arg2 === "string" ? arg2 : (arg3 as string);
    const channelId = ch;
    // Important: some firmwares will keep a deleted preset "disabled" (enable=0) and will omit it from cmd190.
    // Sending enable=1 ensures the slot becomes visible again.
    const payloadXml = buildPtzPresetXmlV2(channelId, presetId, "setPos", { name, enable: 1 });

    // Include extension with channel_id for PTZ preset commands
    const extensionXml = buildChannelExtensionXml(channelId);


    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_PTZ_CONTROL_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      throw new Error(`PTZ preset save rejected (response_code ${frame.header.responseCode})`);
    }
  }

  /**
   * Best-effort delete/disable a PTZ preset.
   * 
   * Note: firmware behavior varies. Many cameras include an <enable> flag in the preset list.
   * This method attempts to set enable=0 for the preset.
   */
  async deletePtzPreset(presetId: number, channel?: number): Promise<void>;
  async deletePtzPreset(channel: number, presetId: number): Promise<void>;
  async deletePtzPreset(arg1: number, arg2?: number): Promise<void> {
    // If 2 args are provided, interpret as (channel, presetId).
    const ch = arg2 === undefined ? this.normalizeChannel(undefined) : this.normalizeChannel(arg1);
    const presetId = arg2 === undefined ? arg1 : arg2;
    const channelId = ch;

    const extensionXml = buildChannelExtensionXml(channelId);

    // Grab current name (if any). Some firmwares will only accept disable when the name is preserved.
    let currentName: string | undefined;
    try {
      const before = await this.getPtzPresetsRaw(ch);
      currentName = before.find((p) => p.id === presetId)?.name;
    } catch {
      // ignore
    }

    const attempts: Array<{ payloadXml: string; label: string }> = [
      {
        // Some firmwares support an explicit delete command.
        label: "command=delPos",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "delPos"),
      },
      {
        // Try disable without renaming.
        label: "enable=0 (no name)",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { enable: 0 }),
      },
      {
        // Some firmwares don't support <enable>, but will accept setting an empty name.
        label: "name='' (no enable)",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: "" }),
      },
      {
        label: "enable=0 name=''",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: "", enable: 0 }),
      },
      ...(currentName
        ? [
          {
            label: "enable=0 name=current",
            payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: currentName, enable: 0 }),
          },
        ]
        : []),
      {
        label: "enable=0 name='Preset N'",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: `Preset ${presetId}`, enable: 0 }),
      },
    ];

    let lastError: unknown;
    let any200 = false;
    for (const a of attempts) {
      try {
        const frame = await this.client.sendFrame({
          cmdId: BC_CMD_ID_PTZ_CONTROL_PRESET,
          channel: ch,
          channelIdOverride: channelId,
          extensionXml,
          payloadXml: a.payloadXml,
          messageClass: BC_CLASS_MODERN_24,
          streamType: 0,
        });

        if (frame.header.responseCode !== 200) {
          throw new Error(`PTZ preset delete rejected (response_code ${frame.header.responseCode})`);
        }

        any200 = true;

        // Verify removal/disable. Some firmwares return 200 but do not apply the change.
        // Important: consider enable=0 or empty name as "deleted" even if the slot still exists.
        try {
          const after = await this.getPtzPresetsRaw(ch);
          const entry = after.find((p) => p.id === presetId);
          if (!entry) return;
          const nameEmpty = entry.name !== undefined && String(entry.name).trim() === "";
          const disabled = entry.enable !== undefined && String(entry.enable).trim() === "0";
          if (nameEmpty || disabled) return;
        } catch (e) {
          // If verification fails, treat it as a soft failure and continue attempts.
          lastError = e;
        }
      } catch (e) {
        lastError = e;
      }
    }

    // Many firmwares accept the request (200) but ignore it; don't block the caller.
    // The plugin can still hide the preset by removing it from the enabled list.
    if (any200) {
      this.logger.warn("PTZ presets (baichuan): deletePtzPreset did not take effect (firmware ignored request)", {
        channel: ch,
        channelId,
        presetId,
      });
      return;
    }

    throw lastError instanceof Error ? lastError : new Error("PTZ preset delete failed");
  }

  /**
   * Get current PTZ position.
   * cmd_id: 433 (Get PTZ position)
   * 
   * @param channel - Channel number (0-based)
   * @returns PTZ position (pan and tilt)
   */
  async getPtzPosition(channel?: number): Promise<{ pan?: number; tilt?: number }> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_GET_PTZ_POSITION, channel: ch });

    const panText = getXmlText(xml, "pPos");
    const tiltText = getXmlText(xml, "tPos");

    const result: { pan?: number; tilt?: number } = {};
    if (panText !== undefined) {
      result.pan = Number(panText);
    }
    if (tiltText !== undefined) {
      result.tilt = Number(tiltText);
    }

    return result;
  }

  /**
   * Read zoom/focus min/max/current positions.
   * cmd_id: 294 (MSG_ID_GET_ZOOM_FOCUS)
   */
  async getZoomFocus(channel?: number): Promise<{
    zoom?: { minPos: number; maxPos: number; curPos: number };
    focus?: { minPos: number; maxPos: number; curPos: number };
  }> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_ZOOM_FOCUS,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml: buildChannelExtensionXml(channelId),
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    const parseTriplet = (sectionTag: string): { minPos: number; maxPos: number; curPos: number } | undefined => {
      const sectionMatch = new RegExp(`<${sectionTag}>([\\s\\S]*?)</${sectionTag}>`).exec(xml);
      const sectionXml = sectionMatch?.[1];
      if (!sectionXml) return undefined;
      const maxPos = getXmlText(sectionXml, "maxPos");
      const minPos = getXmlText(sectionXml, "minPos");
      const curPos = getXmlText(sectionXml, "curPos");
      if (maxPos === undefined || minPos === undefined || curPos === undefined) return undefined;
      return { maxPos: Number(maxPos), minPos: Number(minPos), curPos: Number(curPos) };
    };

    const out: {
      zoom?: { minPos: number; maxPos: number; curPos: number };
      focus?: { minPos: number; maxPos: number; curPos: number };
    } = {};
    const zoom = parseTriplet("zoom");
    const focus = parseTriplet("focus");
    if (zoom) out.zoom = zoom;
    if (focus) out.focus = focus;
    return out;
  }

  /**
   * Zoom to a given zoom factor, where 1.0 is normal.
   * Uses movePos where 1000 == 1.0x.
   * cmd_id: 295 (MSG_ID_SET_ZOOM_FOCUS)
   */
  async zoomToFactor(zoomFactor: number, channel?: number): Promise<void>;
  async zoomToFactor(channel: number, zoomFactor: number): Promise<void>;
  async zoomToFactor(arg1: number, arg2?: number): Promise<void> {
    const ch = arg2 === undefined ? 0 : this.normalizeChannel(arg1);
    const zoomFactor = arg2 === undefined ? arg1 : arg2;
    const channelId = ch;
    const current = await this.getZoomFocus(ch);
    const zoom = current.zoom;
    if (!zoom) {
      throw new Error("Camera did not return <zoom> info (zoom may be unsupported)");
    }

    const requestedPos = Math.round(zoomFactor * 1000);
    const movePos = Math.min(zoom.maxPos, Math.max(zoom.minPos, requestedPos));

    const payloadXml = buildStartZoomFocusXml(channelId, movePos);
    const extensionXml = buildChannelExtensionXml(channelId);

    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_SET_ZOOM_FOCUS,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      throw new Error(`Zoom rejected (response_code ${frame.header.responseCode})`);
    }
  }

  // --------------------
  // Battery Info API
  // --------------------

  private parseBatteryInfoXml(xml: string, channel: number): Partial<BatteryInfo> {
    const parseNum = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // Prefer parsing the matching <BatteryInfo> block when a list is returned.
    const batteryInfoBlocks = getXmlBlocks(xml, "BatteryInfo");
    const preferredBlock =
      batteryInfoBlocks.find((b) => getXmlText(b, "channelId") === String(channel)) ??
      batteryInfoBlocks[0] ??
      xml;

    const out: Partial<BatteryInfo> = {};

    const batteryPercent = parseNum(getXmlText(preferredBlock, "batteryPercent"));
    if (batteryPercent !== undefined) out.batteryPercent = batteryPercent;

    const chargeStatus = getXmlText(preferredBlock, "chargeStatus");
    if (chargeStatus !== undefined) out.chargeStatus = chargeStatus;

    const adapterStatus = getXmlText(preferredBlock, "adapterStatus");
    if (adapterStatus !== undefined) out.adapterStatus = adapterStatus;

    const voltage = parseNum(getXmlText(preferredBlock, "voltage"));
    if (voltage !== undefined) out.voltage = voltage;

    const current = parseNum(getXmlText(preferredBlock, "current"));
    if (current !== undefined) out.current = current;

    const temperature = parseNum(getXmlText(preferredBlock, "temperature"));
    if (temperature !== undefined) out.temperature = temperature;

    const lowPower = parseNum(getXmlText(preferredBlock, "lowPower"));
    if (lowPower !== undefined) out.lowPower = lowPower;

    const batteryVersion = parseNum(getXmlText(preferredBlock, "batteryVersion"));
    if (batteryVersion !== undefined) out.batteryVersion = batteryVersion;

    return out;
  }

  /**
   * Best-effort sleeping inference for battery/BCUDP cameras.
   *
   * This method does NOT send any request to the camera.
   * Rule: consider the camera sleeping if, in the last 10 seconds,
   * we only received/sent Baichuan commands that are known to be non-waking.
   */
  getSleepStatus(opts?: {
    /** Window to inspect (ms). Default: 10_000. */
    windowMs?: number;
    /** Back-compat alias for `windowMs`. */
    idleMs?: number;
    channel?: number;
    /** List of cmdIds that do NOT wake the camera. If omitted, uses default values. */
    nonWakingCmdIds?: number[];
    /** Back-compat alias for `nonWakingCmdIds`. */
    ignoreCmdIds?: number[];
  }): SleepStatus {
    const windowMs = opts?.windowMs ?? opts?.idleMs ?? 10_000;
    const nonWakingCmdIds = new Set<number>(
      opts?.nonWakingCmdIds ??
      opts?.ignoreCmdIds ??
      [BC_CMD_ID_UDP_KEEP_ALIVE, BC_CMD_ID_GET_BATTERY_INFO_LIST, BC_CMD_ID_GET_BATTERY_INFO, BC_CMD_ID_FLOODLIGHT_STATUS_LIST]
    );
    const transport = this.client.getTransport?.();
    if (transport !== "udp") {
      return { state: "unknown", reason: "sleep inference supported only for UDP/battery" };
    }

    // If we are actively streaming, treat the device as awake.
    // This check lives in the client and includes cross-client streaming activity within the same process.
    if (this.activeVideoMsgNums.size > 0 || this.rtspServers.size > 0 || this.client.isDeviceStreamingActive?.()) {
      return { state: "awake", reason: "active streaming" };
    }

    const socketConnected = this.client.isSocketConnected?.() ?? false;

    const now = Date.now();
    const cutoff = now - windowMs;

    const rx = (this.client.getRxHistory?.() ?? []).filter((h) => h.atMs >= cutoff);
    const tx = (this.client.getTxHistory?.() ?? []).filter((h) => h.atMs >= cutoff);

    // If we've had absolutely no activity in the window, treat as sleeping (best-effort).
    // This matches the intent: no waking commands observed recently.
    if (rx.length === 0 && tx.length === 0) {
      return {
        state: "sleeping",
        reason: `no rx/tx activity in last ${windowMs}ms${socketConnected ? "" : " (socket disconnected)"}`,
        idleMs: windowMs,
      };
    }

    const firstWakingRx = rx.find((h) => !nonWakingCmdIds.has(h.cmdId));
    if (firstWakingRx) {
      return {
        state: "awake",
        reason: `waking rx cmdId=${firstWakingRx.cmdId} responseCode=${firstWakingRx.responseCode} seen ${now - firstWakingRx.atMs}ms ago`,
        lastRxAtMs: firstWakingRx.atMs,
        idleMs: now - firstWakingRx.atMs,
      };
    }

    const firstWakingTx = tx.find((h) => !nonWakingCmdIds.has(h.cmdId));
    if (firstWakingTx) {
      return {
        state: "awake",
        reason: `waking tx cmdId=${firstWakingTx.cmdId} seen ${now - firstWakingTx.atMs}ms ago`,
        idleMs: now - firstWakingTx.atMs,
      };
    }

    return {
      state: "sleeping",
      reason: `only non-waking cmdIds observed in last ${windowMs}ms (non-waking: ${Array.from(nonWakingCmdIds).join(",")})`,
      idleMs: windowMs,
    };
  }

  /**
   * Active sleep probe using a non-waking command with a short timeout.
   *
   * Why this exists:
   * - Passive inference can be noisy (keepalives, other clients, separate stream paths).
   * - A short-timeout probe answers: "is the camera responding right now?".
   *
   * Important caveats:
   * - If *another* client keeps the camera awake, the probe will return awake (correct: it's awake).
   * - Do NOT call this in a tight loop; it will generate traffic and can prevent sleep.
   */
  async probeSleepStatus(opts?: {
    channel?: number;
    /** Default: 700ms */
    timeoutMs?: number;
    /** Default: 1 */
    attempts?: number;
    /** Default: 5000ms (returns cached status if called more frequently) */
    minIntervalMs?: number;
    /** Override command used for probing. Default: battery info (253). */
    cmdId?: number;
  }): Promise<SleepStatus> {
    const transport = this.client.getTransport?.();
    if (transport !== "udp") {
      return { state: "unknown", reason: "sleep probe supported only for UDP/battery" };
    }

    // If we are actively streaming, treat the device as awake.
    // This check lives in the client and includes cross-client streaming activity within the same process.
    if (this.activeVideoMsgNums.size > 0 || this.rtspServers.size > 0 || this.client.isDeviceStreamingActive?.()) {
      return { state: "awake", reason: "active streaming" };
    }

    const now = Date.now();
    const minIntervalMs = opts?.minIntervalMs ?? 5_000;
    if (this.lastSleepProbe && now - this.lastSleepProbe.atMs < minIntervalMs) {
      return { ...this.lastSleepProbe.status, reason: `${this.lastSleepProbe.status.reason} (cached)` };
    }

    // Avoid implicitly forcing a login/reconnect as part of a "sleep check".
    if (!this.client.isSocketConnected()) {
      const status: SleepStatus = { state: "unknown", reason: "udp socket not connected" };
      this.lastSleepProbe = { atMs: now, status };
      return status;
    }
    if (!this.client.loggedIn) {
      const status: SleepStatus = { state: "unknown", reason: "not logged in" };
      this.lastSleepProbe = { atMs: now, status };
      return status;
    }

    const ch = this.normalizeChannel(opts?.channel);
    const timeoutMs = opts?.timeoutMs ?? 700;
    const attempts = Math.max(1, opts?.attempts ?? 1);
    const cmdId = opts?.cmdId ?? BC_CMD_ID_GET_BATTERY_INFO; // 253

    for (let i = 0; i < attempts; i++) {
      try {
        const frame = await this.client.sendFrame({ cmdId, channel: ch, timeoutMs });
        const status: SleepStatus = {
          state: frame.header.responseCode === 200 ? "awake" : "unknown",
          reason: `probe cmdId=${cmdId} responseCode=${frame.header.responseCode}`,
        };
        this.lastSleepProbe = { atMs: Date.now(), status };
        return status;
      } catch (e) {
        // On timeout, interpret as sleeping (best-effort). Other errors remain unknown.
        const msg = e instanceof Error ? e.message : String(e);
        const isTimeout = msg.includes("Baichuan timeout") || msg.toLowerCase().includes("timeout");
        if (isTimeout) {
          const status: SleepStatus = { state: "sleeping", reason: `probe timeout cmdId=${cmdId} timeoutMs=${timeoutMs}` };
          this.lastSleepProbe = { atMs: Date.now(), status };
          return status;
        }
        // Retry on transient errors if attempts > 1.
        if (i === attempts - 1) {
          const status: SleepStatus = { state: "unknown", reason: `probe error cmdId=${cmdId}: ${msg}` };
          this.lastSleepProbe = { atMs: Date.now(), status };
          return status;
        }
      }
    }

    const fallback: SleepStatus = { state: "unknown", reason: "probe exhausted" };
    this.lastSleepProbe = { atMs: Date.now(), status: fallback };
    return fallback;
  }

  /**
   * Get battery status for battery-powered cameras, including sleep state.
   * This is a comprehensive API that returns battery info AND checks if the camera is sleeping.
    * cmd_id: 253 (MSG_ID_BATTERY_INFO)
   * 
   * @param channel - Channel number (0-based)
   * @returns Battery information including sleep status
   */
  async getBatteryStatus(channel?: number): Promise<BatteryInfo> {
    const ch = this.normalizeChannel(channel);

    // First: no-wake inference. If we're likely sleeping, don't send any request.
    // This avoids the common pitfall where the "sleep check" itself prevents sleep.
    const sleepStatus = this.getSleepStatus({ channel: ch });
    if (sleepStatus.state === "sleeping") {
      return { channel: ch, sleeping: true };
    }

    try {
      // First, try to get battery info
      // If the camera is sleeping, this may timeout or fail
      const xml = await Promise.race([
        this.sendXml({ cmdId: BC_CMD_ID_GET_BATTERY_INFO, channel: ch }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000)
        )
      ]);

      const result: BatteryInfo = {
        channel: ch,
        sleeping: false, // Camera responded, so it's awake
      };

      Object.assign(result, this.parseBatteryInfoXml(xml, ch));

      return result;
    } catch (error) {
      // If the command times out or fails, the camera may be sleeping OR the path is broken.
      const result: BatteryInfo = {
        channel: ch,
      };

      const inferred = this.getSleepStatus({ channel: ch });
      if (inferred.state === "sleeping") result.sleeping = true;

      // If we got an error that's not a timeout, we still don't know the battery status
      // But we can infer it's sleeping if it failed to respond
      if (error instanceof Error && error.message === "Timeout") {
        // Camera didn't respond within 5 seconds, possibly sleeping
        if (result.sleeping == null) result.sleeping = true;
      } else {
        // Other error, but still mark as potentially sleeping
      }

      return result;
    }
  }

  /**
   * Get battery information via Baichuan.
   * cmd_id: 253 (MSG_ID_BATTERY_INFO)
   * 
   * Note: Battery info can be pushed via events (cmd_id 252 BatteryInfoList), but on-demand request
   * is cmd_id 253.
  * For checking sleep state without polling/waking, use getSleepStatus() instead.
   * 
   * @param channel - Channel number (0-based)
   * @returns Battery information
   */
  async getBatteryInfo(channel?: number): Promise<BatteryInfo> {
    const ch = this.normalizeChannel(channel);

    // IMPORTANT (battery/BCUDP): avoid forcing a reconnect/login just to fetch battery info.
    // Many battery cameras will deliberately drop the BCUDP session when sleeping (D2C_DISC).
    // If we auto-login here, the periodic poller will keep waking the camera.
    const transport = this.client.getTransport?.();
    if (transport === "udp") {
      if (!this.client.isSocketConnected?.() || !this.client.loggedIn) {
        return { channel: ch, sleeping: true };
      }
    }

    // Use the raw client call to avoid `ReolinkBaichuanApi.sendXml` auto-login + 400-empty-body relogin loop.
    const xml = await this.client.sendXml({ cmdId: BC_CMD_ID_GET_BATTERY_INFO, channel: ch });

    const result: BatteryInfo = {
      channel: ch,
    };

    Object.assign(result, this.parseBatteryInfoXml(xml, ch));

    return result;
  }

  /**
   * Wake up a sleeping battery camera by sending a "waking command".
   * WAKING_COMMANDS like GetEnc (cmd_id 56) can wake up sleeping cameras.
   * 
   * @param channel - Channel number (0-based)
   * @param waitAfterWake - Optional delay in milliseconds after sending wake command (default: 1500ms)
   */
  async wakeUp(channel?: number, options?: number | WakeUpOptions): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const opts: WakeUpOptions = typeof options === "number" ? { waitAfterWakeMs: options } : (options ?? {});

    const timeoutMs = opts.timeoutMs ?? 20_000;
    const attempts = opts.attempts ?? 3;
    const waitAfterWakeMs = opts.waitAfterWakeMs ?? 1500;
    const backoffMs = opts.backoffMs ?? 1500;

    const isUdp = this.client.getTransport?.() === "udp";
    const reconnect = opts.reconnect ?? isUdp;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Use GetEnc (cmd_id 56) which is a WAKING_COMMAND.
        // If the session is stale (common on battery/BCUDP), this may timeout.
        await this.getEncXml(ch, { timeoutMs });

        if (waitAfterWakeMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitAfterWakeMs));
        }
        return;
      } catch (e) {
        lastError = e;

        // Common cases when the camera is sleeping or the session/socket is stale:
        // - timeout waiting for reply
        // - socket closed
        const msg = e instanceof Error ? e.message : String(e);
        const looksLikeTimeout = msg.includes("Baichuan timeout");
        const looksLikeClosed = msg.toLowerCase().includes("socket closed") || msg.toLowerCase().includes("stream closed");

        if (attempt < attempts) {
          if (reconnect && (looksLikeTimeout || looksLikeClosed)) {
            try {
              // Force a fresh connect+login on next attempt.
              this.client.loggedIn = false;
              await this.client.close();
            } catch {
              // ignore
            }
          }

          if (backoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Check if a camera is sleeping.
   * 
   * This is difficult to determine directly. The method attempts to:
   * 1. Check if we can successfully get battery info (non-waking command)
   * 2. If that fails with timeout or connection error, the camera might be sleeping
   * 
   * Note: GetBatteryInfo is a NONE_WAKING_COMMAND, so it won't wake up the camera.
   * However, if the camera is sleeping, it may timeout or fail to respond.
   * 
   * @param channel - Channel number (0-based)
   * @returns true if camera appears to be sleeping, false otherwise
   */
  async isSleeping(channel?: number): Promise<boolean> {
    const ch = this.normalizeChannel(channel);
    try {
      // Try to get battery info (non-waking command)
      // If camera is sleeping, this should timeout or fail
      await Promise.race([
        this.getBatteryInfo(ch),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000)
        )
      ]);
      // If we got a response, camera is not sleeping
      return false;
    } catch (error) {
      // If we get a timeout or connection error, camera might be sleeping
      // However, it could also be a network issue or camera offline
      // We can't be 100% sure, but a timeout suggests sleeping
      return true;
    }
  }

  // --------------------
  // PIR State APIs
  // --------------------

  /**
   * Get PIR (Passive Infrared) detection settings via Baichuan.
   * cmd_id: 212 (MSG_ID_GET_PIR_ALARM)
   * 
   * @param channel - Channel number (0-based)
   * @returns PIR state information
   */
  async getPirInfo(channel?: number): Promise<PirState> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_GET_PIR_INFO, channel: ch });

    const parseBoolishNumber = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const t = v.trim().toLowerCase();
      if (t === "true") return 1;
      if (t === "false") return 0;
      const n = Number(t);
      return Number.isFinite(n) ? n : undefined;
    };

    const parseEnabled = (v: string | undefined): boolean => {
      if (v === undefined) return false;
      const t = v.trim().toLowerCase();
      return t === "1" || t === "true";
    };

    // Reolink PIR sensitivity is commonly inverted vs the mobile app UI.
    // Observed mapping (also used by other SDKs): app = 101 - sensiValue.
    const mapPirSensitivityToApp = (raw: number): number => {
      const mapped = 101 - raw;
      return Math.trunc(mapped);
    };

    const enable = getXmlText(xml, "enable");
    const sensitive = getXmlText(xml, "sensiValue");
    const reduceAlarm = getXmlText(xml, "reduceFalseAlarm");
    const interval = getXmlText(xml, "interval");
    const intervalMax = getXmlText(xml, "intervalSecMax");

    const state: PirState["state"] = {
      channel: ch,
    };
    if (enable !== undefined) {
      const n = parseBoolishNumber(enable);
      if (n !== undefined) state.enable = n;
    }
    if (sensitive !== undefined) {
      state.sensitive = Number(sensitive);
    }
    if (reduceAlarm !== undefined) {
      const n = parseBoolishNumber(reduceAlarm);
      if (n !== undefined) state.reduceAlarm = n;
    }
    if (interval !== undefined) {
      const n = parseBoolishNumber(interval);
      if (n !== undefined) state.interval = n;
    }
    if (intervalMax !== undefined) {
      const n = parseBoolishNumber(intervalMax);
      if (n !== undefined) state.intervalMax = n;
    }

    return {
      enabled: parseEnabled(enable),
      state,
    };
  }

  /**
   * Set PIR (Passive Infrared) detection settings via Baichuan.
   * cmd_id: 213 (MSG_ID_START_PIR_ALARM)
   * 
   * @param channel - Channel number (0-based)
   * @param params - PIR settings (enable is required)
   */
  async setPirInfo(params: { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }, channel?: number): Promise<void>;
  async setPirInfo(channel: number, params: { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }): Promise<void>;
  async setPirInfo(
    arg1: number | { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number },
    arg2?: number | { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }
  ): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : (arg2 as number | undefined);
    const params = typeof arg1 === "number" ? (arg2 as { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }) : arg1;
    const ch = this.normalizeChannel(channel);

    const toPirSensitivityRaw = (appValue: number): number => {
      // Inverse mapping of getPirInfo(): raw = 101 - app.
      return Math.trunc(101 - appValue);
    };

    const toBoolishNumber = (v: unknown): number | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === "boolean") return v ? 1 : 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // First get current settings to modify
    const currentXml = await this.sendXml({ cmdId: BC_CMD_ID_GET_PIR_INFO, channel: ch });

    // Parse and modify XML
    let modifiedXml = currentXml;

    if (params.enable !== undefined) {
      modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/, `<enable>${params.enable}</enable>`);
    }
    if (params.sensitive !== undefined) {
      const raw = toPirSensitivityRaw(params.sensitive);
      modifiedXml = modifiedXml.replace(/<sensiValue>[^<]*<\/sensiValue>/, `<sensiValue>${raw}</sensiValue>`);
    }
    if (params.reduceAlarm !== undefined) {
      const n = toBoolishNumber(params.reduceAlarm);
      if (n !== undefined) {
        modifiedXml = modifiedXml.replace(/<reduceFalseAlarm>[^<]*<\/reduceFalseAlarm>/, `<reduceFalseAlarm>${n}</reduceFalseAlarm>`);
      }
    }
    if (params.interval !== undefined) {
      modifiedXml = modifiedXml.replace(/<interval>[^<]*<\/interval>/, `<interval>${params.interval}</interval>`);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_PIR_INFO,
      channel: ch,
      payloadXml: modifiedXml,
    });
  }

  // --------------------
  // Motion Detection Set API
  // --------------------

  /**
   * Set motion detection settings via Baichuan.
   * cmd_id: 47 (SetMdAlarm)
   * 
   * @param channel - Channel number (0-based)
   * @param enabled - Enable/disable motion detection
   * @param sensitivity - Sensitivity level (optional)
   */
  async setMotionDetection(enabled: boolean, sensitivity?: number, channel?: number): Promise<void>;
  async setMotionDetection(channel: number, enabled: boolean, sensitivity?: number): Promise<void>;
  async setMotionDetection(arg1: number | boolean, arg2?: boolean | number, arg3?: number): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : arg3;
    const enabled = typeof arg1 === "number" ? (arg2 as boolean) : arg1;
    const sensitivity = typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const ch = this.normalizeChannel(channel);
    // First get current settings
    const currentXml = await this.sendXml({ cmdId: 46, channel: ch }); // GetMdAlarm

    // Parse and modify XML
    // Expected format: <sensInfoNew><enable>...</enable><sensitivityDefault>...</sensitivityDefault></sensInfoNew>
    let modifiedXml = currentXml;

    if (enabled !== undefined) {
      modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/, `<enable>${enabled ? "1" : "0"}</enable>`);
    }
    if (sensitivity !== undefined) {
      modifiedXml = modifiedXml.replace(/<sensitivityDefault>[^<]*<\/sensitivityDefault>/, `<sensitivityDefault>${sensitivity}</sensitivityDefault>`);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_MOTION_ALARM,
      channel: ch,
      payloadXml: modifiedXml,
    });
  }

  // --------------------
  // AI Detection Set API
  // --------------------

  /**
   * Set AI detection settings via Baichuan.
   * cmd_id: 343 (SetAiAlarm)
   * 
   * @param channel - Channel number (0-based)
   * @param aiType - AI type (e.g., "people", "vehicle", "dog_cat", "face", "package")
   * @param sensitivity - Sensitivity level (optional)
   * @param stayTime - Stay time/delay (optional)
   */
  async setAiDetection(aiType: string, sensitivity?: number, stayTime?: number, channel?: number): Promise<void>;
  async setAiDetection(channel: number, aiType: string, sensitivity?: number, stayTime?: number): Promise<void>;
  async setAiDetection(arg1: number | string, arg2?: string | number, arg3?: number, arg4?: number): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : arg4;
    const aiType = typeof arg1 === "number" ? (arg2 as string) : arg1;
    const sensitivity = typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const stayTime = typeof arg1 === "number" ? arg4 : arg3;
    const ch = this.normalizeChannel(channel);
    // First get current settings for this AI type.
    // Correct cmd 342 payload: <AiDetectCfg><chn>0-based</chn><type>people</type></AiDetectCfg>
    const getXml = `<?xml version="1.0" encoding="UTF-8" ?>
  <body>
  <AiDetectCfg version="1.1">
  <chn>${ch}</chn>
  <type>${xmlEscape(aiType)}</type>
  </AiDetectCfg>
  </body>`;

    const currentXml = await this.sendXml({
      cmdId: 342, // GetAiAlarm
      channel: ch,
      payloadXml: getXml,
    });

    // Parse and modify XML
    let modifiedXml = currentXml;

    if (sensitivity !== undefined) {
      modifiedXml = modifiedXml.replace(/<sensitivity>[^<]*<\/sensitivity>/, `<sensitivity>${sensitivity}</sensitivity>`);
    }
    if (stayTime !== undefined) {
      modifiedXml = modifiedXml.replace(/<stayTime>[^<]*<\/stayTime>/, `<stayTime>${stayTime}</stayTime>`);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_AI_ALARM,
      channel: ch,
      payloadXml: modifiedXml,
    });
  }

  // --------------------
  // Siren/Audio Alarm APIs
  // --------------------

  /**
   * Get siren/audio alarm status via Baichuan.
   * cmd_id: 547 (GetAudioAlarm - push event, not a request)
   * 
   * Note: Siren status is typically pushed via events (cmd_id 547), not requested directly.
   * This method attempts to get the status, but it may not work on all cameras.
   * 
   * @param channel - Channel number (0-based)
   * @returns Siren status
   */
  async getSiren(channel?: number): Promise<{ enabled: boolean }> {
    // Note: cmd_id 547 is typically a push event, not a request
    // We try to get it, but it may not work on all cameras
    try {
      const xml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_AUDIO_ALARM,
        ...(channel !== undefined ? { channel } : {}),
      });

      // Parse siren status from XML
      // Expected format: <SirenStatus><status>...</status></SirenStatus>
      const status = getXmlText(xml, "status");
      return {
        enabled: status === "1",
      };
    } catch {
      // If request fails, return default (siren status is typically pushed, not requested)
      return { enabled: false };
    }
  }

  /**
   * Play siren/audio alarm via Baichuan.
   * cmd_id: 263 (MSG_ID_PLAY_AUDIO)
   * 
   * @param channel - Channel number (0-based, optional for hub-level)
   * @param on - Enable/disable siren (for manual mode)
   * @param duration - Number of times to play (for times mode)
   */
  async setSiren(on?: boolean, duration?: number, channel?: number): Promise<void>;
  async setSiren(channel: number | undefined, on?: boolean, duration?: number): Promise<void>;
  async setSiren(arg1?: number | boolean, arg2?: boolean | number, arg3?: number): Promise<void> {
    const channel = typeof arg1 === "boolean" ? (arg3 ?? 0) : (arg1 as number | undefined);
    const on = typeof arg1 === "boolean" ? arg1 : (arg2 as boolean | undefined);
    const duration = typeof arg1 === "boolean" ? (arg2 as number | undefined) : arg3;

    const channelId = channel !== undefined ? channel + 1 : undefined;
    let payloadXml: string;

    if (duration !== undefined) {
      // Times mode: play siren a specific number of times
      payloadXml = buildSirenTimesXml(channelId, duration);
    } else {
      // Manual mode: turn siren on/off
      const enable = on ? 1 : 0;
      payloadXml = buildSirenManualXml(channelId, enable);
    }

    try {
      await this.sendXml({
        cmdId: BC_CMD_ID_AUDIO_ALARM_PLAY,
        ...(channel !== undefined ? { channel } : {}),
        payloadXml,
      });
    } catch (error) {
      // If manual mode fails, try times mode with 2 times
      if (on === true && duration === undefined) {
        payloadXml = buildSirenTimesXml(channelId, 2);
        await this.sendXml({
          cmdId: BC_CMD_ID_AUDIO_ALARM_PLAY,
          ...(channel !== undefined ? { channel } : {}),
          payloadXml,
        });
      } else {
        throw error;
      }
    }
  }

  // --------------------
  // White LED/Floodlight APIs
  // --------------------

  /**
   * Get white LED/floodlight state via Baichuan.
   * cmd_id: 289 (GetWhiteLed/Floodlight)
   * 
   * @param channel - Channel number (0-based)
   * @returns White LED state
   */
  async getWhiteLedState(channel?: number): Promise<WhiteLedState> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_GET_WHITE_LED, channel: ch });

    // Parse state from various known payloads:
    // - FloodlightTask: <enable>1</enable> and/or sometimes <state>
    // - FloodlightManual: <status>1</status>
    const enable = getXmlText(xml, "enable");
    const state = getXmlText(xml, "state");
    const status = getXmlText(xml, "status");
    const brightnessText = getXmlText(xml, "brightness_cur");

    const result: WhiteLedState = {
      enabled: enable === "1" || state === "1" || status === "1",
    };
    if (brightnessText !== undefined) {
      result.brightness = Number(brightnessText);
    }

    return result;
  }

  /**
   * Set white LED/floodlight state via Baichuan.
   * cmd_id: 288 (SetWhiteLed state) or 290 (SetWhiteLed task)
   * 
   * @param channel - Channel number (0-based)
   * @param on - Enable/disable white LED
   * @param brightness - Brightness level (optional)
   */
  async setWhiteLedState(on?: boolean, brightness?: number, channel?: number): Promise<void>;
  async setWhiteLedState(channel: number, on?: boolean, brightness?: number): Promise<void>;
  async setWhiteLedState(arg1?: number | boolean, arg2?: boolean | number, arg3?: number): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : (arg3 ?? 0);
    const on = typeof arg1 === "number" ? (arg2 as boolean | undefined) : (arg1 as boolean | undefined);
    const brightness = typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const ch = this.normalizeChannel(channel);

    // Many firmwares use:
    // - cmd 288: FloodlightManual (write) for manual on/off
    // - cmd 290: FloodlightTask (write) for task config / brightness
    // Historically we sent a <WhiteLed> payload which can yield 400 on many cameras.
    if (on !== undefined) {
      try {
        const payloadXml = buildFloodlightManualXml(ch, on ? 1 : 0, on ? 180 : 0);
        await this.sendXml({
          cmdId: BC_CMD_ID_SET_WHITE_LED_STATE,
          channel: ch,
          payloadXml,
        });
      } catch (e) {
        // Fallback: use task XML returned by cmd 289, update <enable>/<state>/<status> and send with cmd 290.
        const currentXml = await this.sendXml({ cmdId: BC_CMD_ID_GET_WHITE_LED, channel: ch });
        let modifiedXml = currentXml;

        // Some payloads use <enable>, others use <state> or <status>.
        if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
          modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/i, `<enable>${on ? 1 : 0}</enable>`);
        }
        if (/<state>[^<]*<\/state>/i.test(modifiedXml)) {
          modifiedXml = modifiedXml.replace(/<state>[^<]*<\/state>/i, `<state>${on ? 1 : 0}</state>`);
        }
        if (/<status>[^<]*<\/status>/i.test(modifiedXml)) {
          modifiedXml = modifiedXml.replace(/<status>[^<]*<\/status>/i, `<status>${on ? 1 : 0}</status>`);
        }

        await this.sendXml({
          cmdId: BC_CMD_ID_SET_WHITE_LED_TASK,
          channel: ch,
          payloadXml: modifiedXml,
        });
      }
    }

    if (brightness !== undefined) {
      const currentXml = await this.sendXml({ cmdId: BC_CMD_ID_GET_WHITE_LED, channel: ch });
      let modifiedXml = currentXml;
      if (/<brightness_cur>[^<]*<\/brightness_cur>/i.test(modifiedXml)) {
        modifiedXml = modifiedXml.replace(
          /<brightness_cur>[^<]*<\/brightness_cur>/i,
          `<brightness_cur>${brightness}</brightness_cur>`,
        );
      }

      // If a brightness was set, ensure task is enabled.
      if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
        modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/i, `<enable>1</enable>`);
      }

      await this.sendXml({
        cmdId: BC_CMD_ID_SET_WHITE_LED_TASK,
        channel: ch,
        payloadXml: modifiedXml,
      });
    }
  }

  // --------------------
  // Ability Info API
  // --------------------

  /**
   * Get device abilities/capabilities via Baichuan.
   * cmd_id: 151 (MSG_ID_ABILITY_INFO)
   * 
   * Returns a dictionary of device capabilities and their version numbers.
   * This is used to determine what features are supported by the device.
   * 
   * The token used requests all available sections: system, streaming, PTZ, IO, security, 
   * replay, disk, network, alarm, record, video, image.
   * 
   * @param username - Username for the request (required)
   * @returns Dictionary of capability names to version numbers or values, keyed by channel number or "Host"
   */
  async getAbilityInfo(): Promise<Partial<Record<number | "Host", Record<string, number | string | undefined>>>> {
    // Return type matches DeviceAbilities from types.ts
    const user = this.client.username;
    const extensionXml = buildAbilityInfoExtensionXml(user);

    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_ABILITY_INFO,
      extensionXml,
    });

    // Parse AbilityInfo XML
    // Expected format: multiple token sections (system, network, alarm, image, video, security, replay, PTZ, IO, streaming, disk, record)
    // Each section can contain subModule elements with channelId and abilityValue
    // <AbilityInfo>
    //   <system><subModule>...</subModule></system>
    //   <network><subModule>...</subModule></network>
    //   <alarm><subModule>...</subModule></alarm>
    //   <image><subModule><channelId>0</channelId><abilityValue>ispBasic_rw, ledState_rw</abilityValue></subModule></image>
    //   <video><subModule><channelId>0</channelId><abilityValue>osdName_rw, osdTime_rw</abilityValue></subModule></video>
    //   <PTZ><subModule>...</subModule></PTZ>
    //   ... etc
    // </AbilityInfo>
    const abilities: Partial<Record<number | "Host", Record<string, number | string | undefined>>> = {};

    // List of all possible token sections
    const tokenSections = [
      "system", "streaming", "PTZ", "IO", "security", "replay",
      "disk", "network", "alarm", "record", "video", "image"
    ];

    // Parse each token section
    for (const tokenSection of tokenSections) {
      // Use case-insensitive matching and handle both lowercase and mixed case
      const sectionRegex = new RegExp(`<${tokenSection}[^>]*>([\\s\\S]*?)<\\/${tokenSection}>`, "i");
      const sectionMatch = xml.match(sectionRegex);

      if (sectionMatch) {
        const sectionXml = sectionMatch[1] ?? "";
        const subModuleMatches = sectionXml.matchAll(/<subModule[^>]*>([\s\S]*?)<\/subModule>/g);

        for (const match of subModuleMatches) {
          const subModuleXml = match[1] ?? "";
          const channelIdText = getXmlText(subModuleXml, "channelId") || getXmlText(subModuleXml, "chnID");
          const abilityValue = getXmlText(subModuleXml, "abilityValue");

          if (abilityValue) {
            const channelKey: number | "Host" = channelIdText ? Number(channelIdText) : "Host";

            if (!abilities[channelKey]) {
              abilities[channelKey] = {};
            }

            // Parse abilityValue string - contains comma-separated capability names
            // Capabilities already include their full name (e.g., "preview_rw", "general_rw")
            const capabilities = abilityValue.split(",").map(c => c.trim()).filter(Boolean);
            for (const capability of capabilities) {
              // Mark as available (value 1 means supported)
              // Capabilities typically end with _rw (read-write) or _ro (read-only)
              abilities[channelKey]![capability] = 1;
            }
          }
        }
      }
    }

    // Note: The token section parsing above already handles image and video,
    // so we don't need separate parsing for them

    // Also check for top-level AbilityInfo items (host-level metadata like userName)
    const abilityInfoMatch = xml.match(/<AbilityInfo[^>]*>([\s\S]*?)<\/AbilityInfo>/);
    if (abilityInfoMatch) {
      const abilityInfoXml = abilityInfoMatch[1] ?? "";

      // Find direct child elements that aren't image/video/subModule
      const directChildren = abilityInfoXml.matchAll(/<([A-Za-z]+)[^>]*>([^<]*)<\/\1>/g);

      if (!abilities["Host"]) {
        abilities["Host"] = {};
      }

      for (const childMatch of directChildren) {
        const tagName = childMatch[1];
        const textValue = childMatch[2];

        // Only store metadata, not parsed ability values (those are already in channel entries)
        if (tagName && textValue !== undefined && !["image", "video", "subModule"].includes(tagName)) {
          // Skip internal parsing artifacts
          if (tagName !== "channelId" && tagName !== "abilityValue") {
            // Store as string or number
            const numValue = Number(textValue);
            abilities["Host"]![tagName] = Number.isNaN(numValue) ? textValue : numValue;
          }
        }
      }
    }

    // Clean up: remove empty Host entry if it only has metadata
    if (abilities["Host"] && Object.keys(abilities["Host"]).length === 0) {
      delete abilities["Host"];
    }

    return abilities;
  }

  /**
   * Get ability/capability version for a specific capability and channel.
   * This is a convenience method that wraps getAbilityInfo.
   * 
   * @param username - Username for the request
   * @param capability - Capability name (e.g., "reboot", "rtsp", "netPort")
   * @param channel - Channel number (optional, None/null for host-level)
   * @returns Version number (0 = not supported, >0 = supported with that version)
   */
  async getAbilityVersion(capability: string, channel?: number | null): Promise<number> {
    const abilities = await this.getAbilityInfo();
    const channelKey: number | "Host" = channel !== undefined && channel !== null ? channel : "Host";
    const channelAbilities = abilities[channelKey];

    if (!channelAbilities) {
      return 0;
    }

    const value = channelAbilities[capability];
    if (typeof value === "number") {
      return value;
    }

    // If value is a string, try to extract version number
    if (typeof value === "string") {
      const numValue = Number(value);
      return Number.isNaN(numValue) ? 0 : numValue;
    }

    return 0;
  }

  /**
   * Get device support info via Baichuan.
   * cmd_id: 199 (MSG_ID_SUPPORT)
   *
   * Returns host-level support info including ptzMode and per-channel flags (battery, ledCtrl, etc).
   */
  async getSupportInfo(): Promise<SupportInfo | undefined> {
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_SUPPORT });
    return parseSupportXml(xml);
  }

  /**
   * Compute explicit device capabilities (hasZoom/hasPan/hasTilt/hasBattery/...) for a specific channel.
   *
   * This method centralizes capability parsing in the library.
   */
  async getDeviceCapabilities(
    channel?: number,
    options?: {
      /**
       * Enable best-effort probing that may generate additional requests.
       * Defaults to true.
       */
      probe?: boolean;
      /** Enable/disable siren probing (cmd 152/153). Defaults to true. */
      probeSiren?: boolean;
      /** Enable/disable floodlight probing (cmd 289). Defaults to true. */
      probeFloodlight?: boolean;
      /**
       * When the camera is a dual-lens model exposed on a single channel (common behind NVR/Hub),
       * merge lens capabilities so a flag is true if at least one lens supports it.
       *
       * Defaults to true.
       */
      mergeDualLensOnSameChannel?: boolean;
    },
  ): Promise<DeviceCapabilitiesResult> {
    const channelProvided = channel !== undefined && channel !== null;
    const ch = this.normalizeChannel(channel);
    const probeCfg = {
      probe: options?.probe ?? true,
      probeSiren: options?.probeSiren ?? true,
      probeFloodlight: options?.probeFloodlight ?? true,
    };

    const [abilitiesResult, supportResult] = await Promise.allSettled([
      this.getAbilityInfo() as Promise<DeviceAbilities>,
      this.getSupportInfo(),
    ]);

    const abilitiesRaw = abilitiesResult.status === "fulfilled" ? abilitiesResult.value : undefined;
    const supportRaw = supportResult.status === "fulfilled" ? supportResult.value : undefined;

    // If a channel is explicitly requested, filter returned metadata to avoid confusing callers.
    // Capabilities are always computed for `ch` (0-based).
    const abilities: DeviceAbilities | undefined = abilitiesRaw
      ? (
        channelProvided
          ? ({
            ...(typeof (abilitiesRaw).Host === "object" ? { Host: (abilitiesRaw).Host } : {}),
            ...(typeof (abilitiesRaw)[ch] === "object" ? { [ch]: (abilitiesRaw)[ch] } : {}),
          } as DeviceAbilities)
          : abilitiesRaw
      )
      : undefined;

    const support: SupportInfo | undefined = supportRaw
      ? (
        channelProvided
          ? ({
            ...supportRaw,
            items: (supportRaw.items ?? []).filter((i) => i.chnID === ch),
          } satisfies SupportInfo)
          : supportRaw
      )
      : undefined;

    const computeArgs: { channel: number; abilities?: DeviceAbilities; support?: SupportInfo } = { channel: ch };
    if (abilities) computeArgs.abilities = abilities;
    if (support) computeArgs.support = support;
    const capabilities = computeDeviceCapabilities(computeArgs);

    const flat = flattenAbilitiesForChannel(abilities, ch);

    const truthy = (v: unknown): boolean => {
      if (typeof v === "number") return v > 0;
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n > 0;
        return v.length > 0 && v !== "0";
      }
      return Boolean(v);
    };

    const features: DeviceSupportFlags | undefined = support
      ? {
        rtsp: truthy((support).rtsp),
        onvif: truthy((support).onvif),
        wifi: truthy((support).wifi),
        record: truthy((support).record),
        ftp: truthy((support).ftp),
        email: truthy((support).email),
        pushAlarm: truthy((support).pushAlarm),
        audioTalk: truthy((support).audioTalk),
      }
      : undefined;

    // Best-effort siren probe.
    // Some devices support audio alarm but do not advertise it via AbilityInfo/Support.
    // We try a harmless request first, then fall back to sending "off".
    if (probeCfg.probe && probeCfg.probeSiren && !capabilities.hasSiren) {
      const tryGet = async (): Promise<boolean> => {
        try {
          await this.sendXml({
            cmdId: BC_CMD_ID_GET_AUDIO_ALARM,
            channel: ch,
            timeoutMs: 1000,
          });
          return true;
        } catch {
          return false;
        }
      };

      const tryOff = async (): Promise<boolean> => {
        try {
          const channelId = ch + 1;
          const payloadXml = buildSirenManualXml(channelId, 0);
          await this.sendXml({
            cmdId: BC_CMD_ID_AUDIO_ALARM_PLAY,
            channel: ch,
            payloadXml,
            timeoutMs: 1000,
          });
          return true;
        } catch {
          return false;
        }
      };

      const ok = (await tryGet()) || (await tryOff());
      if (ok) {
        capabilities.hasSiren = true;
      }
    }

    // Best-effort floodlight probe.
    // Many firmwares expose only `ledState_rw` (status LED) in AbilityInfo, even when a real floodlight
    // exists and is controllable via Baichuan. The most reliable signal is whether cmd 289 works.
    if (probeCfg.probe && probeCfg.probeFloodlight && !capabilities.hasFloodlight) {
      const channelSupportItems = (support?.items ?? []).filter((i) => i.chnID === ch || i.chnID === ch + 1);

      const parseLightType = (item: any): number | undefined => {
        const v = item?.lightType;
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
      };

      const lightTypes = channelSupportItems
        .map((i) => parseLightType(i))
        .filter((v): v is number => Number.isFinite(v));

      // If firmware explicitly says there is no white LED/floodlight, do not probe.
      // This avoids false positives where cmd289 returns a FloodlightTask-like XML but the device
      // only has IR illumination / status LEDs.
      if (lightTypes.some((v) => v === 0)) {
        // leave as false
      } else if (lightTypes.some((v) => v > 0)) {
        capabilities.hasFloodlight = true;
      } else {
        // No explicit lightType. Probe cmd 289.
        try {
          const xml = await this.sendXml({
            cmdId: BC_CMD_ID_GET_WHITE_LED,
            channel: ch,
            timeoutMs: 1000,
          });

          // Only treat this as floodlight support if the payload clearly looks like floodlight.
          if (/(<FloodlightTask\b|<FloodlightManual\b|<FloodlightStatusList\b|<WhiteLed\b)/i.test(xml)) {
            capabilities.hasFloodlight = true;
          }
        } catch {
          // noop
        }
      }
    }

    // Object-detection capabilities.
    // Always read cmd 299 (AiCfg) and use <detectType> as the single source of truth.
    // This avoids inference/probing variability across firmwares.
    let objects: string[] | undefined;
    try {
      const xml = await this.sendXml({ cmdId: 299, channel: ch, timeoutMs: 1500 });
      const detectTypeRaw = (getXmlText(xml, "detectType") ?? "").trim();
      if (detectTypeRaw) {
        const list = detectTypeRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length > 0) objects = list;
      }
    } catch {
      // noop
    }

    let presets: PtzPreset[] | undefined;
    if (capabilities.hasPresets) {
      const presetsResult = await Promise.allSettled([this.getPtzPresets(ch)]);
      const r0 = presetsResult[0];
      if (r0?.status === "fulfilled") {
        presets = r0.value;
        capabilities.hasPresets = presets.length > 0;
      }
    }

    // Dual-lens capability merge (simple): if the device is multifocal, OR capabilities across all lenses/channels.
    // This is especially important behind NVR/Hub where wide+tele can be exposed on the same channel.
    const mergeDualLens = options?.mergeDualLensOnSameChannel ?? true;
    if (mergeDualLens && channelProvided) {
      try {
        // Best-effort NVR/Hub hint: on NVR channels are typically >= 2.
        const dual = await this.getDualLensChannelInfo(ch, { onNvr: ch >= 2 });
        if (dual.isDualLens && Array.isArray(dual.channels) && dual.channels.length > 0) {
          const anyPan = dual.channels.some((c) => c.hasPan);
          const anyTilt = dual.channels.some((c) => c.hasTilt);
          const anyZoom = dual.channels.some((c) => c.hasZoom);
          const anyPresets = dual.channels.some((c) => c.hasPresets);
          const anyIntercom = dual.channels.some((c) => c.hasIntercom);

          capabilities.hasPan = capabilities.hasPan || anyPan;
          capabilities.hasTilt = capabilities.hasTilt || anyTilt;
          capabilities.hasZoom = capabilities.hasZoom || anyZoom;
          capabilities.hasPresets = capabilities.hasPresets || anyPresets;
          capabilities.hasIntercom = capabilities.hasIntercom || anyIntercom;

          // Keep hasPtz coherent with merged PTZ sub-capabilities.
          capabilities.hasPtz = capabilities.hasPtz || capabilities.hasPan || capabilities.hasTilt || capabilities.hasZoom || capabilities.hasPresets;
        }
      } catch {
        // ignore
      }
    }

    const debug: import("./types").DeviceCapabilitiesDebugInfo = {
      channel: ch,
      channelId1Based: ch + 1,
      transport: this.client.getTransport(),
      encryptionKind: this.client.enc.kind,
      loggedIn: this.client.loggedIn,
      subscribed: this.client.subscribed,
      abilitiesAvailable: Boolean(abilities),
      supportAvailable: Boolean(support),
    };

    if (flat) debug.abilityMergedKeyCount = Object.keys(flat).length;
    if (support?.items) debug.supportItemCount = support.items.length;

    const result: DeviceCapabilitiesResult = { capabilities, debug };
    if (abilities) result.abilities = abilities;
    if (support) result.support = support;
    if (presets) result.presets = presets;
    if (objects) result.objects = objects;
    if (features) result.features = features;
    return result;
  }

  /**
   * Analyzes channel capabilities for dual lens models.
   * Determines which channels support pan, tilt, zoom, motion detection, intercom, presets
   * and which streaming types are available (RTSP, RTMP, Native).
   * 
   * @returns Detailed information about dual lens channels, including which channels support each capability
   * 
   * @example
   * ```typescript
   * const analysis = await api.getDualLensChannelInfo();
   * if (analysis.isDualLens) {
   *   // Get channels that support specific capabilities
   *   const panChannels = analysis.capabilityChannels.pan; // [0, 1]
   *   const zoomChannels = analysis.capabilityChannels.zoom; // [1] for TrackMix
   *   const presetChannels = analysis.capabilityChannels.presets; // [0]
   *   
   *   // Send pan command to first channel that supports it
   *   if (panChannels.length > 0) {
   *     await api.ptzControl(panChannels[0], { pan: 1 });
   *   }
   *   
   *   // Detailed info per channel
   *   for (const ch of analysis.channels) {
   *     console.log(`Channel ${ch.channel}: pan=${ch.hasPan}, tilt=${ch.hasTilt}, zoom=${ch.hasZoom}`);
   *     console.log(`  Motion: ${ch.hasMotion}, Intercom: ${ch.hasIntercom}, Presets: ${ch.hasPresets}`);
   *     console.log(`  Stream: RTSP=${ch.availableStreams.rtsp}, RTMP=${ch.availableStreams.rtmp}, Native=${ch.availableStreams.native}`);
   *   }
   * }
   * ```
   */
  async getDualLensChannelInfo(
    channel: number,
    options?: {
      /** True when the camera is behind an NVR/Hub (tele lens is usually exposed as an autotrack/logic-channel variant). */
      onNvr?: boolean;
    },
  ): Promise<DualLensChannelAnalysis> {

    const onNvr = options?.onNvr === true;
    const baseChannel = this.normalizeChannel(channel);

    // 1. Get device information
    let model: string | undefined;
    let channelNum: number | undefined;
    let supportInfo: SupportInfo | undefined;

    try {
      const deviceInfo = await this.getInfo(channel, { tags: ["type"] });
      model = deviceInfo.type?.trim();
    } catch {
      // ignore
    }

    try {
      const capabilities = await this.getDeviceCapabilities(channel, { mergeDualLensOnSameChannel: false });
      channelNum = capabilities.support?.channelNum;
      supportInfo = capabilities.support;
    } catch {
      // ignore
    }

    // 2. Check if it's a dual lens model
    // Try multiple sources for model name
    let normalizedModel = model ? model.trim() : undefined;

    // If model not found via getInfo, try getDeviceCapabilities or SupportInfo
    if (!normalizedModel && supportInfo) {
      // SupportInfo might have model info in items
      for (const item of supportInfo.items ?? []) {
        if ((item as any).typeInfo) {
          normalizedModel = String((item as any).typeInfo).trim();
          break;
        }
      }
    }

    // More flexible matching: check exact match first, then partial match
    const checkModelMatch = (knownModels: Set<string>, modelToCheck: string): boolean => {
      if (!modelToCheck || modelToCheck.length === 0) return false;
      const lower = modelToCheck.toLowerCase().trim();
      for (const known of knownModels) {
        const knownLower = known.toLowerCase().trim();
        // Exact match (case-insensitive)
        if (lower === knownLower) return true;
        // Partial match: model contains known or known contains model
        // Also check if model starts with known or vice versa
        if (lower.includes(knownLower) || knownLower.includes(lower)) return true;
        // Check for key words: "trackmix" or "duo"
        if (lower.includes("trackmix") && knownLower.includes("trackmix")) return true;
        if (lower.includes("duo") && knownLower.includes("duo")) return true;
      }
      return false;
    };

    const isDualMotionModel = normalizedModel ? checkModelMatch(DUAL_LENS_DUAL_MOTION_MODELS, normalizedModel) : false;
    const isSingleMotionModel = normalizedModel ? checkModelMatch(DUAL_LENS_SINGLE_MOTION_MODELS, normalizedModel) : false;

    // Also check if channelNum suggests dual lens (2-3 channels)
    // Handle both number and string types for channelNum
    const channelNumValue = typeof channelNum === "string" ? Number.parseInt(channelNum, 10) : channelNum;
    const hasDualLensChannelCount = (channelNumValue === 2) && Number.isFinite(channelNumValue);

    // Consider it dual lens if model matches OR if channelNum suggests it
    const isDualLens = isDualMotionModel || isSingleMotionModel || hasDualLensChannelCount;

    if (!isDualLens) {
      return {
        isDualLens: false,
        model: normalizedModel,
        streamChannelCount: channelNum,
        logicalChannelCount: channelNum,
        channels: [],
        capabilityChannels: {
          pan: [],
          tilt: [],
          zoom: [],
          motion: [],
          intercom: [],
          presets: [],
        },
      };
    }

    // 3. Determine dual lens type and available channels
    // If we detected via channelNum but model doesn't match, infer type from model name
    let dualLensType: "dual_motion" | "single_motion" | undefined = isDualMotionModel
      ? "dual_motion"
      : isSingleMotionModel
        ? "single_motion"
        : undefined;

    // If we detected via channelNum but model doesn't match known types exactly,
    // try to infer from model name pattern
    if (!dualLensType && hasDualLensChannelCount) {
      const modelLower = normalizedModel?.toLowerCase() ?? "";
      if (modelLower.includes("trackmix")) {
        dualLensType = "single_motion";
      } else if (modelLower.includes("duo")) {
        dualLensType = "dual_motion";
      } else if (channelNumValue === 2) {
        // Default to single_motion for 2-channel devices (TrackMix behavior)
        dualLensType = "single_motion";
      }
    }

    // For SINGLE_MOTION_MODELS (TrackMix): stream_channels=[0,1] but channels=[0]
    // For DUAL_MOTION_MODELS (Duo): different behavior
    const streamChannels: number[] = [];
    const logicalChannels: number[] = [];

    if (dualLensType === "single_motion") {
      // TrackMix: stream channels 0 and 1, but only channel 0 has motion/controls
      if (onNvr) {
        // NVR/Hub often exposes the tele lens as a variant on the same channel.
        streamChannels.push(baseChannel);
      } else {
        streamChannels.push(0, 1);
      }
      logicalChannels.push(onNvr ? baseChannel : 0);
    } else if (dualLensType === "dual_motion") {
      // Duo: both channels have motion detection
      if (channelNumValue === 2) {
        streamChannels.push(0, 1);
        logicalChannels.push(0, 1);
      } else {
        streamChannels.push(0);
        logicalChannels.push(0);
      }
    } else {
      // Fallback: use channelNum if available
      if (channelNumValue && Number.isFinite(channelNumValue) && channelNumValue >= 2) {
        for (let i = 0; i < channelNumValue; i++) {
          streamChannels.push(i);
          logicalChannels.push(i);
        }
      } else {
        // Default: assume 2 channels
        streamChannels.push(0, 1);
        logicalChannels.push(0);
      }
    }

    // 4. Analyze each channel
    const channelInfos: DualLensChannelInfo[] = [];

    for (const ch of streamChannels) {
      try {
        // Get capabilities for this channel
        const chCapabilities = await this.getDeviceCapabilities(ch, { mergeDualLensOnSameChannel: false });
        const caps = chCapabilities.capabilities;
        const chSupport = chCapabilities.support;
        const chFeatures = chCapabilities.features;

        // Check motion detection
        // For SINGLE_MOTION: only channel 0 has motion
        // For DUAL_MOTION: both channels have motion
        let hasMotion = false;
        if (dualLensType === "single_motion") {
          hasMotion = ch === (onNvr ? baseChannel : 0); // Only main channel for TrackMix
        } else if (dualLensType === "dual_motion") {
          hasMotion = logicalChannels.includes(ch); // All logical channels for Duo
        } else {
          // Fallback: assume channel 0 has motion
          hasMotion = ch === 0;
        }

        // Check available streaming
        const availableStreams = {
          rtsp: false,
          rtmp: false,
          native: true, // Baichuan is always available
        };

        // RTSP: check from support or features
        if (chFeatures?.rtsp || chSupport?.rtsp) {
          availableStreams.rtsp = true;
        } else {
          // Try to verify if RTSP is available
          try {
            // RTSP is generally available if the device supports streaming
            // Based on reolink_aio, RTSP is available if support.rtsp > 0
            if (chSupport && typeof (chSupport as any).rtsp === "number" && (chSupport as any).rtsp > 0) {
              availableStreams.rtsp = true;
            }
          } catch {
            // ignore
          }
        }

        // RTMP: check from support or features
        if (chSupport && typeof (chSupport as any).rtmp === "number" && (chSupport as any).rtmp > 0) {
          availableStreams.rtmp = true;
        }

        const makeLensVariant = (lensType: "wide" | "telephoto"): NativeVideoStreamVariant => {
          if (lensType === "wide") return "default";
          // For Hub/NVR multifocal (TrackMix), the tele lens is requested via the telephoto variant.
          // Autotrack is a separate mode and should not be used to select the tele stream.
          return "telephoto";
        };

        // For TrackMix (single_motion) models, channel 1 (telephoto) has optical zoom
        // even if capabilities don't explicitly report it
        let hasZoom = caps.hasZoom ?? false;
        if (!onNvr && dualLensType === "single_motion" && ch === 1) {
          // Telephoto lens on TrackMix has zoom capability
          hasZoom = true;
        }

        const pushInfo = (lensType?: "wide" | "telephoto"): void => {
          channelInfos.push({
            channel: ch,
            hasPan: caps.hasPan ?? false,
            hasTilt: caps.hasTilt ?? false,
            hasZoom,
            hasMotion,
            hasIntercom: caps.hasIntercom ?? false,
            hasPresets: caps.hasPresets ?? false,
            ...(lensType ? { lensType } : {}),
            ...(lensType ? { variantType: makeLensVariant(lensType) } : {}),
            availableStreams,
          });
        };

        // On NVR/Hub TrackMix (single_motion) the two lenses share the same channel: return both lenses with different variantType.
        if (onNvr && dualLensType === "single_motion" && ch === baseChannel) {
          pushInfo("wide");
          // Tele lens entry: ensure zoom=true (TrackMix tele lens has zoom)
          channelInfos.push({
            channel: ch,
            hasPan: caps.hasPan ?? false,
            hasTilt: caps.hasTilt ?? false,
            hasZoom: true,
            hasMotion,
            hasIntercom: caps.hasIntercom ?? false,
            hasPresets: caps.hasPresets ?? false,
            lensType: "telephoto",
            variantType: makeLensVariant("telephoto"),
            availableStreams,
          });
        } else if (ch === 0) {
          pushInfo("wide");
        } else if (ch === 1) {
          pushInfo("telephoto");
        } else {
          pushInfo(undefined);
        }
      } catch (err) {
        // If it fails for a channel, continue with the others
        (this.logger.warn ?? this.logger.log).call(
          this.logger,
          `[ReolinkBaichuanApi] getDualLensChannelInfo: error in channel ${ch}: ${err}`
        );
      }
    }

    // Build capability channel maps: for each capability, list all channels that support it
    const uniq = (xs: number[]): number[] => Array.from(new Set(xs));
    const capabilityChannels = {
      pan: uniq(channelInfos.filter((ch) => ch.hasPan).map((ch) => ch.channel)),
      tilt: uniq(channelInfos.filter((ch) => ch.hasTilt).map((ch) => ch.channel)),
      zoom: uniq(channelInfos.filter((ch) => ch.hasZoom).map((ch) => ch.channel)),
      motion: uniq(channelInfos.filter((ch) => ch.hasMotion).map((ch) => ch.channel)),
      intercom: uniq(channelInfos.filter((ch) => ch.hasIntercom).map((ch) => ch.channel)),
      presets: uniq(channelInfos.filter((ch) => ch.hasPresets).map((ch) => ch.channel)),
    };

    return {
      isDualLens: true,
      dualLensType,
      model: normalizedModel,
      streamChannelCount: streamChannels.length,
      logicalChannelCount: logicalChannels.length,
      channels: channelInfos,
      capabilityChannels,
    };
  }

  /**
   * Create an RTSP server for a video stream.
   * Automatically detects video codec (H.264 or H.265) and configures ffmpeg accordingly.
   * 
   * @param channel - Channel number (0-based)
   * @param profile - Stream profile ("main", "sub", or "ext")
   * @param options - RTSP server options (port, path, etc.)
   * @returns RTSP server instance
   * 
   * @example
   * ```typescript
   * const rtspServer = await api.createRtspStream(0, "main", { listenPort: 8554 });
   * const rtspUrl = rtspServer.getRtspUrl();
   * console.log(`RTSP stream available at: ${rtspUrl}`);
   * // Use ffmpeg or VLC to connect: ffmpeg -i ${rtspUrl} output.mp4
   * ```
   */
  async createRtspStream(
    profile: StreamProfile,
    options?: {
      listenHost?: string; // Host to listen on (default: "127.0.0.1")
      listenPort?: number; // Port to listen on (default: 8554)
      path?: string; // RTSP path (e.g. "/main" or "/sub")
      /** Native-only: TrackMix tele/autotrack variants (usually on NVR/Hub). */
      variant?: NativeVideoStreamVariant;
    }
  ): Promise<BaichuanRtspServer>;
  async createRtspStream(
    channel: number,
    profile: StreamProfile,
    options?: {
      listenHost?: string; // Host to listen on (default: "127.0.0.1")
      listenPort?: number; // Port to listen on (default: 8554)
      path?: string; // RTSP path (e.g. "/main" or "/sub")
      /** Native-only: TrackMix tele/autotrack variants (usually on NVR/Hub). */
      variant?: NativeVideoStreamVariant;
    }
  ): Promise<BaichuanRtspServer>;
  async createRtspStream(
    channelOrProfile: number | StreamProfile,
    profileOrOptions?:
      | StreamProfile
      | {
        listenHost?: string;
        listenPort?: number;
        path?: string;
        variant?: NativeVideoStreamVariant;
      },
    optionsMaybe?: {
      listenHost?: string;
      listenPort?: number;
      path?: string;
      variant?: NativeVideoStreamVariant;
    }
  ): Promise<BaichuanRtspServer> {
    const ch = typeof channelOrProfile === "number" ? this.normalizeChannel(channelOrProfile) : 0;
    const profile = typeof channelOrProfile === "number" ? (profileOrOptions as StreamProfile) : channelOrProfile;
    const options = typeof channelOrProfile === "number" ? optionsMaybe : (profileOrOptions as typeof optionsMaybe);
    // Get stream metadata to determine codec
    let videoCodec: string | undefined;
    try {
      const metadata = await this.getStreamMetadata(ch);
      if (Array.isArray(metadata)) {
        const stream = metadata.find((s) => s.profile === profile);
        if (stream?.videoEncType) {
          videoCodec = stream.videoEncType;
        }
      } else if (metadata && typeof metadata === "object" && "streams" in metadata) {
        const streams = (metadata).streams;
        if (Array.isArray(streams)) {
          const stream = streams.find((s: any) => s?.profile === profile);
          if (stream?.videoEncType) {
            videoCodec = stream.videoEncType;
          }
        }
      }
    } catch (error) {
      // If metadata fetch fails, codec will be auto-detected from stream
      this.logger.warn(`[ReolinkBaichuanApi] Could not fetch stream metadata, will auto-detect codec: ${error instanceof Error ? error.message : error}`);
    }

    const rtspOptions: BaichuanRtspServerOptions = {
      api: this,
      channel: ch,
      profile,
      ...(options?.variant !== undefined ? { variant: options.variant } : {}),
      ...(options?.listenHost !== undefined ? { listenHost: options.listenHost } : {}),
      ...(options?.listenPort !== undefined ? { listenPort: options.listenPort } : {}),
      ...(options?.path !== undefined ? { path: options.path } : {}),
      logger: this.logger,
    };

    const server = new BaichuanRtspServer(rtspOptions);
    await server.start();

    // Track the server for cleanup
    this.rtspServers.add(server);

    // Remove from tracking when server is stopped
    server.once("close", () => {
      this.rtspServers.delete(server);
    });

    return server;
  }

  /**
   * Build all available video stream options for a channel.
   * Returns RTSP, RTMP, and native Baichuan stream options.
   * 
   * @returns Array of stream options
   */
  async buildVideoStreamOptions(
    options?: {
      channel?: number;
      compositeOnly?: boolean;
      onNvr?: boolean;
      lens?: NativeVideoStreamVariant;
    },
  ): Promise<{
    nativeStreams: ReolinkSupportedStream[];
    rtspStreams: ReolinkSupportedStream[];
    rtmpStreams: ReolinkSupportedStream[];
  }> {
    const onNvr = options?.onNvr === true;
    const channel = options?.channel;
    const compositeOnly = options?.compositeOnly === true;

    const logDebug = (msg: string, data?: unknown): void => {
      const l: any = this.logger as any;
      if (typeof l?.debug === "function") {
        l.debug(msg, data);
        return;
      }
      if (typeof l?.log === "function") {
        l.log(msg, data);
      }
    };

    const lensVariant: NativeVideoStreamVariant = options?.lens ?? "default";
    const wantWide = lensVariant === "default";
    const wantTele = lensVariant !== "default";

    const rtspStreams: ReolinkSupportedStream[] = [];
    const rtmpStreams: ReolinkSupportedStream[] = [];
    const nativeStreams: ReolinkSupportedStream[] = [];

    const ch = this.normalizeChannel(channel);

    // Best-effort: detect TrackMix model for stream variants.
    // TrackMix can expose the tele stream as RTSP `...Preview_<ch>_autotrack` (especially on NVR/Hub).
    let isMultiFocal = false;
    let model: string | undefined;
    let isTrackMix = false;
    try {
      // NOTE: cmd_id 318 (per-channel GetDevInfo) is primarily for NVR channels and may fail on
      // standalone cameras. Prefer host-level cmd_id 80 when not on NVR.
      const info = await this.getInfo(onNvr ? ch : undefined, { tags: ["type"] });
      model = typeof (info as any)?.type === "string" ? String((info as any).type).toLowerCase() : "";
      isMultiFocal = isDualLenseModel(model);
      isTrackMix = model.includes("trackmix");
    } catch (e) {
      logDebug("[ReolinkBaichuanApi] buildVideoStreamOptions: getInfo(type) failed", {
        host: this.host,
        onNvr,
        channel,
        normalizedChannel: ch,
        err: e instanceof Error ? e.message : String(e),
      });
    }

    logDebug("[ReolinkBaichuanApi] buildVideoStreamOptions: inputs", {
      host: this.host,
      onNvr,
      channel,
      normalizedChannel: ch,
      compositeOnly,
      lens: options?.lens ?? "default",
      wantWide,
      wantTele,
      detected: { isMultiFocal, isTrackMix, model },
    });

    // Empirical: TrackMix behind NVR/Hub can expose RTMP (bcs/live/vod) even though
    // standalone multifocal devices often do not. Enable RTMP for multifocal only when onNvr.
    const rtmpEnabledForMultifocal = onNvr;

    // For composite streams (multifocal devices), return composite stream options.
    // IMPORTANT: this branch is only for "composite" (channel-less) streams.
    // Multifocal devices still expose per-channel RTSP/RTMP streams on the NVR.
    if (compositeOnly && !isMultiFocal) {
      logDebug("[ReolinkBaichuanApi] buildVideoStreamOptions: compositeOnly requested but device not detected multifocal; returning empty", {
        host: this.host,
        channel,
        normalizedChannel: ch,
        model,
        isMultiFocal,
      });
      return {
        nativeStreams,
        rtmpStreams,
        rtspStreams,
      };
    }

    if (isMultiFocal && (compositeOnly || channel === undefined)) {
      let widerMetadata: ChannelStreamMetadata | undefined;
      try {
        widerMetadata = await this.getStreamMetadata(0);
      } catch (e) {
        logDebug("[ReolinkBaichuanApi] buildVideoStreamOptions: getStreamMetadata(0) failed", {
          host: this.host,
          err: e instanceof Error ? e.message : String(e),
        });
      }

      const widerStreams = widerMetadata?.streams || [];
      const widerMain = widerStreams.find((s) => s.profile === "main");
      const widerMainIsH264 = typeof widerMain?.videoEncType === "string"
        ? widerMain.videoEncType.toLowerCase().includes("264")
        : false;
      logDebug("[ReolinkBaichuanApi] buildVideoStreamOptions: composite branch metadata", {
        host: this.host,
        widerStreamsCount: widerStreams.length,
        profiles: widerStreams.map((s) => s.profile),
        widerMainIsH264,
      });

      // Expose two composite stream options (main/sub).
      // IMPORTANT:
      // - Default wider lens uses `sub` to reduce drift.
      // - If wider `main` is H.264, allow preferring it for the composite `main` option.
      const widerSubProfile: StreamProfile = widerStreams.some((s) => s.profile === "sub")
        ? "sub"
        : (widerStreams[0]?.profile as StreamProfile ?? "sub");
      const widerMainProfileIfOk: StreamProfile | undefined = widerMainIsH264 && widerStreams.some((s) => s.profile === "main")
        ? "main"
        : undefined;

      const compositeProfiles: StreamProfile[] = ["main", "sub"];
      for (const teleProfile of compositeProfiles) {
        const effectiveWiderProfile: StreamProfile = teleProfile === "main" && widerMainProfileIfOk
          ? widerMainProfileIfOk
          : widerSubProfile;
        const widerSelectedMetadata = widerStreams.find((s) => s.profile === effectiveWiderProfile) ?? widerStreams[0];

        const compositeUrl = new URL(`baichuan://${this.host}/composite/profile/${teleProfile}`);
        const compositeUrlWithAuth = new URL(`baichuan://${this.host}/composite/profile/${teleProfile}`);
        compositeUrlWithAuth.username = this.username;
        compositeUrlWithAuth.password = this.password;

        nativeStreams.push({
          name: `Native composite ${teleProfile}`,
          // streamKey for RFC4571 server: composite_<variant>_<wider>_<tele>
          id: `composite_${lensVariant}_${effectiveWiderProfile}_${teleProfile}`,
          container: "rtp", // Composite streams use RFC4571 (rtp container)
          profile: teleProfile,
          lens: "composite",
          url: compositeUrl.toString(),
          urlWithAuth: compositeUrlWithAuth.toString(),
          ...(widerSelectedMetadata ? { metadata: widerSelectedMetadata } : {}),
        });
      }

      // Note: RTSP and RTMP composite streams are not yet supported
      // They would require combining two RTSP/RTMP streams which is more complex
      // For now, only native composite streams are supported

      logDebug("[ReolinkBaichuanApi] buildVideoStreamOptions: composite branch result", {
        host: this.host,
        nativeStreams: nativeStreams.map((s) => s.id),
      });

      return {
        nativeStreams,
        rtmpStreams,
        rtspStreams,
      };
    }

    const guessRtspEncodingPrefix = (m?: StreamMetadata): "h264" | "h265" => {
      const enc = typeof m?.videoEncType === "string" ? m.videoEncType.toLowerCase() : "";
      if (enc.includes("265")) return "h265";
      if (enc.includes("264")) return "h264";
      return "h264";
    };

    const pushRtsp = (params: {
      channel: number;
      profile: StreamProfile;
      streamName: string;
      metadata?: StreamMetadata;
      lens?: ReolinkSupportedStream["lens"];
      /** Force unprefixed `/Preview_` path (used by autotrack). */
      forceNoEncodingPrefix?: boolean;
    }): void => {
      // RTSP format (Reolink):
      // - /<encoding>Preview_<NN>_<stream>
      // - some firmwares use /Preview_<NN>_<stream> (no encoding prefix)
      const channelStr = String(params.channel + 1).padStart(2, "0");
      const encoding = params.forceNoEncodingPrefix ? "" : guessRtspEncodingPrefix(params.metadata);
      const prefix = encoding ? `${encoding}` : "";
      const rtspId = `${prefix}Preview_${channelStr}_${params.streamName}`;
      const rtspPath = `/${rtspId}`;

      const rtspUrl = new URL(`rtsp://${this.host}:${rtspPort}${rtspPath}`);
      const rtspUrlWithAuth = new URL(`rtsp://${this.host}:${rtspPort}${rtspPath}`);
      rtspUrlWithAuth.username = this.username;
      rtspUrlWithAuth.password = this.password;

      rtspStreams.push({
        name: `RTSP ${params.profile}`,
        id: rtspId,
        container: "rtsp",
        channel: params.channel,
        profile: params.profile,
        streamName: params.streamName,
        ...(params.lens ? { lens: params.lens } : {}),
        url: rtspUrl.toString(),
        urlWithAuth: rtspUrlWithAuth.toString(),
        path: rtspPath,
        port: rtspPort,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      });
    };

    const pushRtmp = (params: {
      channel: number;
      profile: StreamProfile;
      streamName: string;
      metadata?: StreamMetadata;
      lens?: ReolinkSupportedStream["lens"];
    }): void => {
      // RTMP format (Reolink): /bcs/channel<ch>_<stream>.bcs?channel=<ch>&stream=<0|1>&user=...&password=...
      const streamType = params.profile === "sub" ? 1 : 0;
      const rtmpId = `${params.streamName}.bcs`;
      const rtmpPath = `/bcs/channel${params.channel}_${params.streamName}.bcs`;

      const rtmpUrl = new URL(`rtmp://${this.host}:${rtmpPort}${rtmpPath}`);
      rtmpUrl.searchParams.set("channel", params.channel.toString());
      rtmpUrl.searchParams.set("stream", streamType.toString());

      const rtmpUrlWithAuth = new URL(`rtmp://${this.host}:${rtmpPort}${rtmpPath}`);
      rtmpUrlWithAuth.searchParams.set("channel", params.channel.toString());
      rtmpUrlWithAuth.searchParams.set("stream", streamType.toString());
      rtmpUrlWithAuth.searchParams.set("user", this.username);
      rtmpUrlWithAuth.searchParams.set("password", this.password);

      rtmpStreams.push({
        name: `RTMP ${params.profile}`,
        id: rtmpId,
        container: "rtmp",
        channel: params.channel,
        profile: params.profile,
        streamName: params.streamName,
        ...(params.lens ? { lens: params.lens } : {}),
        url: rtmpUrl.toString(),
        urlWithAuth: rtmpUrlWithAuth.toString(),
        path: rtmpPath,
        port: rtmpPort,
        streamType,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      });
    };

    // Get network ports (RTSP/RTMP configuration)
    const netPort = await this.getNetPort();
    const rtspEnabled = netPort.rtsp?.enable === 1;
    const rtmpEnabled = (rtmpEnabledForMultifocal ? true : !isMultiFocal) && netPort.rtmp?.enable === 1;
    const rtspPort = netPort.rtsp?.port ?? 554;
    const rtmpPort = netPort.rtmp?.port ?? 1935;

    // Get stream metadata to build options
    const streamMetadata = await this.getStreamMetadata(ch);
    const streams = streamMetadata?.streams || [];

    // Standalone TrackMix tele lens calls typically come in as channel=1 + lens=telephoto.
    // In that case, `streams` already corresponds to the tele channel, so build directly from it.
    // (Previous logic only fetched tele metadata when ch===0, which made tele-only calls return empty.)
    const isStandaloneTeleRequest = wantTele && isMultiFocal && !onNvr && ch === 1;

    // TrackMix without NVR usually exposes the tele stream as channel 1.
    // For UX, keep a single call useful by adding tele streams when available.
    // On NVR/Hub, channel 1 often doesn't exist; we add the RTSP `autotrack` variant instead.
    let teleStreams: StreamMetadata[] = [];
    if (isMultiFocal && !onNvr && ch === 0) {
      try {
        const teleMetadata = await this.getStreamMetadata(1);
        teleStreams = teleMetadata?.streams || [];
      } catch {
        teleStreams = [];
      }
    }

    const pushNative = (params: {
      channel: number;
      profile: StreamProfile;
      metadata?: StreamMetadata;
      lens: "wide" | "telephoto";
      id: string;
      streamName: string;
      nativeVariant?: Exclude<NativeVideoStreamVariant, "default">;
    }): void => {
      const nativeUrl = new URL(`baichuan://${this.host}/channel/${params.channel}/profile/${params.profile}`);
      const nativeUrlWithAuth = new URL(`baichuan://${this.host}/channel/${params.channel}/profile/${params.profile}`);
      if (params.nativeVariant) {
        nativeUrl.searchParams.set("variant", params.nativeVariant);
        nativeUrlWithAuth.searchParams.set("variant", params.nativeVariant);
      }
      nativeUrlWithAuth.username = this.username;
      nativeUrlWithAuth.password = this.password;

      nativeStreams.push({
        // Keep names stable: when requesting a specific lens, callers expect a single native main/sub.
        name: `Native ${params.profile}`,
        id: params.id,
        container: "rtp",
        channel: params.channel,
        profile: params.profile,
        streamName: params.streamName,
        lens: params.lens,
        ...(params.nativeVariant ? { nativeVariant: params.nativeVariant } : {}),
        url: nativeUrl.toString(),
        urlWithAuth: nativeUrlWithAuth.toString(),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      });
    };

    const buildStandardStreams = (params: {
      lens: "wide" | "telephoto";
      channel: number;
      metadatas: StreamMetadata[];
      includeRtsp: boolean;
      includeRtmp: boolean;
      includeNative: boolean;
      nativeIdPrefix: string;
    }): void => {
      for (const metadata of params.metadatas) {
        const profile = metadata.profile as StreamProfile;

        // Preserve existing behavior: multifocal skips ext (and generally exposes only main/sub).
        if (isMultiFocal && profile === "ext") continue;

        if (params.includeRtsp && profile !== "ext") {
          const streamName = profile === "main" ? "main" : "sub";
          pushRtsp({ channel: params.channel, profile, streamName, metadata, lens: params.lens });
        }

        if (params.includeRtmp) {
          const streamName = profile === "main" ? "main" : profile === "sub" ? "sub" : "ext";
          pushRtmp({ channel: params.channel, profile, streamName, metadata, lens: params.lens });
        }

        if (params.includeNative) {
          if (isMultiFocal && profile !== "main" && profile !== "sub") continue;
          pushNative({
            channel: params.channel,
            profile,
            metadata,
            lens: params.lens,
            // streamKey for RFC4571 server: channel_<ch>_<profile>
            id: `channel_${params.channel}_${profile}`,
            streamName: profile,
          });
        }
      }
    };

    if (wantWide) {
      // For TrackMix behind NVR/Hub, do NOT expose RTMP main by default:
      // empirical probes show `channelX_main.bcs` often does not exist, while sub/mobile do.
      const includeRtmpForWide = rtmpEnabled && !(isMultiFocal && onNvr && isTrackMix);

      buildStandardStreams({
        lens: "wide",
        channel: ch,
        metadatas: streams,
        includeRtsp: rtspEnabled,
        includeRtmp: includeRtmpForWide,
        includeNative: true,
        nativeIdPrefix: "native",
      });

      // Add explicit RTMP sub/mobile for NVR/Hub TrackMix.
      if (rtmpEnabled && isMultiFocal && onNvr && isTrackMix) {
        const subMeta = streams.find((s) => s.profile === "sub") ?? streams[0];
        // Wide sub stream
        pushRtmp({
          channel: ch,
          profile: "sub",
          streamName: "sub",
          ...(subMeta ? { metadata: subMeta } : {}),
          lens: "wide",
        });
      }
    }

    // Tele-only request on standalone (channel 1): build directly from channel 1 metadata.
    if (isStandaloneTeleRequest) {
      buildStandardStreams({
        lens: "telephoto",
        channel: 1,
        metadatas: streams,
        includeRtsp: rtspEnabled,
        includeRtmp: rtmpEnabled,
        includeNative: true,
        nativeIdPrefix: "native",
      });
    }

    // Add TrackMix tele streams when available (direct camera, channel 1).
    // NOTE: skip if we already handled the tele-only request above.
    if (!isStandaloneTeleRequest && wantTele && isMultiFocal && teleStreams.length > 0) {
      buildStandardStreams({
        lens: "telephoto",
        channel: 1,
        metadatas: teleStreams,
        includeRtsp: rtspEnabled,
        includeRtmp: rtmpEnabled,
        includeNative: true,
        // Lens-scoped: keep native IDs stable.
        nativeIdPrefix: "native",
      });
    }

    // Add TrackMix tele stream variant for NVR/Hub.
    // On many NVR/Hub firmwares the tele lens is exposed as RTSP `.../Preview_<NN>_autotrack`.
    if (wantTele && isMultiFocal && onNvr && rtspEnabled) {
      // IMPORTANT: TrackMix behind NVR/Hub often exposes the tele lens as the `autotrack` stream name.
      // Even if the caller conceptually wants "telephoto", the actual RTSP path is typically `_autotrack`.
      const rtspVariant: Exclude<NativeVideoStreamVariant, "default"> =
        // TrackMix behind NVR/Hub often uses RTSP streamName=autotrack for the tele lens.
        // Keep behavior consistent: requesting telephoto maps to autotrack at the RTSP path level.
        isTrackMix ? "autotrack" : lensVariant === "telephoto" ? "telephoto" : "autotrack";
      const mainMeta = streams.find((s) => s.profile === "main") ?? streams[0];
      const subMeta = streams.find((s) => s.profile === "sub") ?? streams[0];

      if (mainMeta) {
        pushRtsp({
          channel: ch,
          profile: "main",
          streamName: rtspVariant,
          metadata: mainMeta,
          lens: "telephoto",
          forceNoEncodingPrefix: true,
        });
      } else {
        pushRtsp({
          channel: ch,
          profile: "main",
          streamName: rtspVariant,
          lens: "telephoto",
          forceNoEncodingPrefix: true,
        });
      }

      // Note: do NOT expose `Preview_<NN>_autotrack_sub` by default.
      // Empirically, Hub/NVR TrackMix RTSP often exposes a single `_autotrack` only.
    }

    if (wantTele && isMultiFocal && onNvr && rtmpEnabled && isTrackMix) {
      // Empirical: Hub/NVR TrackMix RTMP tends to expose VOD-style streams like:
      // - channelX_autotrack_sub.bcs
      // - channelX_telephoto_sub.bcs
      // while `*_main` is often missing.
      const subMeta = streams.find((s) => s.profile === "sub") ?? streams[0];

      // IMPORTANT: do not return multiple RTMP aliases for the same profile.
      // - lens=telephoto -> prefer `telephoto_sub`
      // - lens=autotrack -> prefer `autotrack_sub`
      const teleRtmpName = lensVariant === "telephoto" ? "telephoto_sub" : "autotrack_sub";
      pushRtmp({
        channel: ch,
        profile: "sub",
        streamName: teleRtmpName,
        ...(subMeta ? { metadata: subMeta } : {}),
        lens: "telephoto",
      });
    }

    // Add TrackMix native tele stream variant for NVR/Hub.
    // Many firmwares expose the tele lens via a different Baichuan streamType (2/3).
    if (wantTele && isMultiFocal && onNvr) {
      const mainMeta = streams.find((s) => s.profile === "main") ?? streams[0];
      const subMeta = streams.find((s) => s.profile === "sub") ?? streams[0];

      const variantsToExpose: Array<Exclude<NativeVideoStreamVariant, "default">> = [
        lensVariant === "telephoto" ? "telephoto" : "autotrack",
      ];

      for (const nativeVariant of variantsToExpose) {
        pushNative({
          channel: ch,
          profile: "main",
          ...(mainMeta ? { metadata: mainMeta } : {}),
          lens: "telephoto",
          // streamKey for RFC4571 server: channel_<ch>_<variant>_<profile>
          id: `channel_${ch}_${nativeVariant}_main`,
          streamName: nativeVariant,
          nativeVariant,
        });

        pushNative({
          channel: ch,
          profile: "sub",
          ...(subMeta ? { metadata: subMeta } : {}),
          lens: "telephoto",
          // streamKey for RFC4571 server: channel_<ch>_<variant>_<profile>
          id: `channel_${ch}_${nativeVariant}_sub`,
          streamName: nativeVariant,
          nativeVariant,
        });
      }
    }

    return {
      nativeStreams,
      rtmpStreams,
      rtspStreams,
    };
  }

  /**
   * Test all available streams for a specific channel.
   * Tests RTSP, RTMP, and native Baichuan streams with all profiles (main, sub, ext).
   * 
   * @param channel - Channel number to test (0-based)
   * @param logger - Optional logger for output
   * @returns Test results for all stream types and profiles
   */
  async testChannelStreams(channel?: number, logger?: import("../../debug/DebugConfig").Logger): Promise<Record<string, unknown>> {
    const { testChannelStreams } = await import("../../debug/DiagnosticsTools");
    return await testChannelStreams({
      api: this,
      channel: this.normalizeChannel(channel),
      ...(logger !== undefined ? { logger } : {}),
    });
  }

  /**
   * Comprehensive diagnostics for multi-focal devices.
   * Tests all channels and all available streams for each channel.
   * Checks if support.channelNum is 2 or 3 and iterates all channels.
   * 
   * @param logger - logger for output
   * @returns Complete diagnostics for all channels and streams
   */
  async collectMultifocalDiagnostics(logger: import("../../debug/DebugConfig").Logger): Promise<Record<string, unknown>> {
    const { collectMultifocalDiagnostics } = await import("../../debug/DiagnosticsTools");
    return await collectMultifocalDiagnostics({
      api: this,
      logger,
    });
  }

  // ====================================================================
  // CGI Passthrough Methods
  // These methods delegate to the internal CGI API (useful for NVR/Hub)
  // ====================================================================

  /**
   * Passthrough to ReolinkCgiApi.getAllChannelsEvents.
   * Fetches events/motion/AI state for all channels via CGI and merges results per channel.
   */
  async getAllChannelsEvents(
    options?: Parameters<ReolinkCgiApi["getAllChannelsEvents"]>[0],
  ): ReturnType<ReolinkCgiApi["getAllChannelsEvents"]> {
    await this.cgiApi.login();
    return await this.cgiApi.getAllChannelsEvents(options);
  }

  /**
   * Passthrough to ReolinkCgiApi.getAllChannelsBatteryInfo.
   * Fetches battery info for all channels via CGI (merged with channel status sleep flag).
   */
  async getAllChannelsBatteryInfo(
    options?: Parameters<ReolinkCgiApi["getAllChannelsBatteryInfo"]>[0],
  ): ReturnType<ReolinkCgiApi["getAllChannelsBatteryInfo"]> {
    await this.cgiApi.login();
    return await this.cgiApi.getAllChannelsBatteryInfo(options);
  }

  // ====================================================================
  // NVR/Hub Baichuan helpers
  // ====================================================================

  private getUidFromPushCacheForChannel(channel: number): string | undefined {
    const info = this.channelPushData.get(channel);
    const uid = typeof info?.uid === "string" ? info.uid.trim() : "";
    return uid ? uid : undefined;
  }

  private async listAlarmVideosViaBaichuan(params: {
    channel: number;
    uid: string;
    start: Date;
    end: Date;
    streamType?: RecordingStreamType;
    alarmType?: string;
    maxIterations?: number;
  }): Promise<RecordingFile[]> {
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    const maxIterations = params.maxIterations ?? 50;
    const uidBase = (params.uid.split("_")[0] ?? params.uid).trim();
    const streamTypeInt = params.streamType === "subStream" ? 1 : 0;
    const alarmType =
      params.alarmType ??
      "md, pir, io, people, face, vehicle, dog_cat, visitor, other, package, cry, crossline, intrusion, loitering, legacy, loss";

    // NOTE: channelId in the XML payload is 0-based (same as `params.channel`).
    // The Baichuan transport header uses (channel + 1) internally.
    const xmlChannelId = params.channel;

    const findOpenXml = (start: Date, end: Date) => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
  <channelId>${xmlChannelId}</channelId>
<uid>${xmlEscape(uidBase)}</uid>
<logicChnBitmap>255</logicChnBitmap>
<streamType>${streamTypeInt}</streamType>
<notSearchVideo>0</notSearchVideo>
${xmlDateTimePayload("startTime", start)}
${xmlDateTimePayload("endTime", end)}
<alarmType>${xmlEscape(alarmType)}</alarmType>
</findAlarmVideo>
</body>`;

    const findGetXml = (fileHandle: string) => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
  <channelId>${xmlChannelId}</channelId>
<fileHandle>${xmlEscape(fileHandle)}</fileHandle>
</findAlarmVideo>
</body>`;

    const out: RecordingFile[] = [];
    let currentStart = params.start;

    recordingsTraceLog(
      dbg,
      logger,
      "listAlarmVideosViaBaichuan",
      `init: channel=${params.channel}, uid=${uidBase}, streamType=${streamTypeInt}, start=${params.start.toISOString()}, end=${params.end.toISOString()}, alarmType=${alarmType}`,
    );

    for (let i = 0; i < maxIterations; i++) {
      recordingsTraceLog(
        dbg,
        logger,
        "listAlarmVideosViaBaichuan",
        `findAlarmVideo iteration ${i + 1}/${maxIterations}: channel=${params.channel}, start=${currentStart.toISOString()}, end=${params.end.toISOString()}`,
      );

      const openResp = await this.sendXml({
        cmdId: BC_CMD_ID_FIND_REC_VIDEO_OPEN,
        channel: params.channel,
        payloadXml: findOpenXml(currentStart, params.end),
        timeoutMs: 15_000,
      });

      const fileHandle = getXmlText(openResp, "fileHandle")?.trim();
      if (!fileHandle) {
        const rspCode = getXmlText(openResp, "rspCode")?.trim() ?? getXmlText(openResp, "code")?.trim();
        const msg = getXmlText(openResp, "rspMsg")?.trim() ?? getXmlText(openResp, "message")?.trim();
        const snippet = openResp.length > 800 ? `${openResp.slice(0, 800)}...` : openResp;
        recordingsTraceLog(
          dbg,
          logger,
          "listAlarmVideosViaBaichuan",
          `findAlarmVideo OPEN: missing fileHandle (rspCode=${rspCode ?? "?"} msg=${msg ?? "?"}). resp=${snippet}`,
        );
        break;
      }

      const getXml = findGetXml(fileHandle);
      try {
        const getResp = await this.sendXml({
          cmdId: BC_CMD_ID_FIND_REC_VIDEO_GET,
          channel: params.channel,
          payloadXml: getXml,
          timeoutMs: 15_000,
        });

        const pageFiles = parseRecordingFilesFromXml(getResp);
        if (dbg?.traceRecordings && logger) {
          const withTimes = pageFiles.find((f) => f.startTime != null || f.endTime != null);
          recordingsTraceLog(
            dbg,
            logger,
            "listAlarmVideosViaBaichuan",
            `findAlarmVideo GET parsed sample: ${withTimes ? `${withTimes.fileName} type=${withTimes.recordType ?? "-"} start=${withTimes.startTime?.toISOString() ?? "-"} end=${withTimes.endTime?.toISOString() ?? "-"}` : "(none)"}`,
          );
        }
        out.push(...pageFiles);

        const alarmBlocks = getXmlBlocks(getResp, "alarmVideo");
        const bFinishedText = getXmlText(getResp, "bFinished")?.trim();
        recordingsTraceLog(
          dbg,
          logger,
          "listAlarmVideosViaBaichuan",
          `findAlarmVideo GET: fileHandle=${fileHandle} parsedFiles=${pageFiles.length} alarmVideoBlocks=${alarmBlocks.length} bFinished=${bFinishedText ?? "?"}`,
        );
        if (dbg?.traceRecordings && logger && alarmBlocks.length > 0) {
          const sample = alarmBlocks[0]!.replace(/\s+/g, " ").slice(0, 700);
          const extractedAlarmType = getXmlText(alarmBlocks[0]!, "alarmType")?.trim();
          recordingsTraceLog(
            dbg,
            logger,
            "listAlarmVideosViaBaichuan",
            `findAlarmVideo GET sample alarmVideo[0]=${sample} (extracted alarmType=${extractedAlarmType ?? "-"})`,
          );
        }
        if (bFinishedText === "1") break;

        // If not finished, advance start to the last returned event startTime if possible.
        // NOTE: startTime is parsed as UTC to preserve camera-provided numeric components.
        // For requests, we must send those same numeric components back (local time methods),
        // so we re-create a local Date from the UTC components.
        const lastWithStart = [...pageFiles].reverse().find((f) => f.startTime != null);
        if (!lastWithStart?.startTime) break;
        const s = lastWithStart.startTime;
        currentStart = new Date(
          s.getUTCFullYear(),
          s.getUTCMonth(),
          s.getUTCDate(),
          s.getUTCHours(),
          s.getUTCMinutes(),
          s.getUTCSeconds(),
        );
      } finally {
        // Best-effort close.
        try {
          await this.sendXml({
            cmdId: BC_CMD_ID_FIND_REC_VIDEO_CLOSE,
            channel: params.channel,
            payloadXml: getXml,
            timeoutMs: 5_000,
          });
        } catch {
          // ignore
        }
      }
    }

    const seen = new Set<string>();
    return out.filter((f) => {
      if (seen.has(f.fileName)) return false;
      seen.add(f.fileName);
      return true;
    });
  }

  /**
   * List "alarm video" events directly from an NVR/Hub via Baichuan.
   *
   * This uses the Baichuan <findAlarmVideo> flow (cmdId 272/273/274), which is the closest
   * Baichuan-side equivalent to an "events list" coming from the hub.
   *
   * Returned items include timestamps and an alarmType string (stored in RecordingFile.recordType).
   */
  async listNvrAlarmEventsViaBaichuan(params: {
    start: Date;
    end: Date;
    /** Channels to query. If omitted, best-effort discovery is used. */
    channels?: number[];
    /** Stream type hint for the request (default: mainStream). */
    streamType?: RecordingStreamType;
    /** Comma-separated alarmType list (Reolink XML format). */
    alarmType?: string;
    /** Safety limit for pagination/iterations per channel (default 50). */
    maxIterations?: number;
  }): Promise<ChannelRecordingFile[]> {
    const requestedChannels = params.channels?.length
      ? [...params.channels]
      : [...this.channelPushData.keys()];

    let channels = requestedChannels
      .map((c) => this.normalizeChannel(c))
      .filter((n, i, a) => a.indexOf(n) === i)
      .sort((a, b) => a - b);

    // If we can read channelNum, use it as a hard upper bound.
    // Some NVRs/hubs expose placeholder channels in cmd_id 145 that will reject recording queries.
    try {
      const support = await this.getSupportInfo().catch(() => undefined);
      const chNum = (support as any)?.channelNum;
      if (typeof chNum === "number" && Number.isFinite(chNum) && chNum > 0) {
        channels = channels.filter((c) => c >= 0 && c < chNum);
      }
    } catch {
      // ignore
    }

    // Best-effort fallback when we couldn't infer any channel list.
    if (channels.length === 0) {
      const support = await this.getSupportInfo().catch(() => undefined);
      const chNum = (support as any)?.channelNum;
      if (typeof chNum === "number" && Number.isFinite(chNum) && chNum > 0) {
        for (let i = 0; i < chNum; i++) channels.push(i);
      } else {
        channels.push(this.normalizeChannel(undefined));
      }
    }

    const results: ChannelRecordingFile[] = [];
    for (const channel of channels) {
      try {
        const uid =
          this.getUidFromPushCacheForChannel(channel) ??
          (await this.ensureUidForRecordings(channel, undefined));

        const files = await this.listAlarmVideosViaBaichuan({
          channel,
          uid,
          start: params.start,
          end: params.end,
          ...(params.streamType !== undefined ? { streamType: params.streamType } : {}),
          ...(params.alarmType !== undefined ? { alarmType: params.alarmType } : {}),
          ...(params.maxIterations !== undefined ? { maxIterations: params.maxIterations } : {}),
        });

        for (const f of files) results.push({ channel, uid, ...f });
      } catch (e) {
        // Some NVRs expose placeholder channels (or reject certain commands on some channels).
        // Don't fail the whole request if one channel fails.
        const msg = e instanceof Error ? e.message : String(e);
        this.logger?.log?.(`[listNvrAlarmEventsViaBaichuan] channel ${channel} failed: ${msg}`);
      }
    }

    return results;
  }

  /**
   * Like {@link ReolinkBaichuanApi#listNvrAlarmEventsViaBaichuan | listNvrAlarmEventsViaBaichuan},
   * but returns enriched items (detection flags, ms timestamps, etc.).
   */
  async listNvrAlarmEventsEnrichedViaBaichuan(params: {
    start: Date;
    end: Date;
    /** Channels to query. If omitted, best-effort discovery is used. */
    channels?: number[];
    /** Stream type hint for the request (default: mainStream). */
    streamType?: RecordingStreamType;
    /** Comma-separated alarmType list (Reolink XML format). */
    alarmType?: string;
    /** Safety limit for pagination/iterations per channel (default 50). */
    maxIterations?: number;
  }): Promise<EnrichedChannelRecordingFile[]> {
    const events = await this.listNvrAlarmEventsViaBaichuan(params);
    return events.map((ev) => {
      const { channel, uid, ...rec } = ev;
      const enriched = this.enrichRecordingFile(rec);
      return { ...enriched, channel, ...(uid ? { uid } : {}) };
    });
  }

  /**
   * List "alarm-like" events from an NVR/Hub via CGI VOD search.
   *
   * This is the pragmatic fallback when Baichuan <findAlarmVideo> returns no entries on some
   * NVR/HomeHub firmwares.
   *
   * The output is filtered to items that look like events:
   * - motion OR any AI detection OR doorbell/package
   */
  async listNvrAlarmEventsEnrichedViaCgi(params: {
    start: Date;
    end: Date;
    channels?: number[];
    /** Stream type hint (default: mainStream -> CGI "main"). */
    streamType?: RecordingStreamType;
    /** If true (default), use day-by-day status table when available for better completeness. */
    autoSearchByDay?: boolean;
  }): Promise<EnrichedChannelRecordingFile[]> {
    const streamType = params.streamType === "subStream" ? "sub" : "main";
    const autoSearchByDay = params.autoSearchByDay ?? true;

    // Determine channels (prefer explicit list; else use support.channelNum)
    let channels: number[] = [];
    if (params.channels?.length) {
      channels = [...new Set(params.channels.map((c) => this.normalizeChannel(c)))].sort((a, b) => a - b);
    } else {
      const support = await this.getSupportInfo().catch(() => undefined);
      const chNum = (support as any)?.channelNum;
      if (typeof chNum === "number" && Number.isFinite(chNum) && chNum > 0) {
        channels = Array.from({ length: chNum }, (_, i) => i);
      } else {
        channels = [this.normalizeChannel(undefined)];
      }
    }

    await this.cgiApi.login();

    const out: EnrichedChannelRecordingFile[] = [];
    for (const channel of channels) {
      const recs = await this.cgiApi.listNvrRecordings({
        channel,
        start: params.start,
        end: params.end,
        streamType,
        autoSearchByDay,
      });

      for (const r of recs) {
        const isEvent =
          r.hasMotion ||
          r.hasPerson ||
          r.hasVehicle ||
          r.hasAnimal ||
          r.hasFace ||
          r.hasDoorbell ||
          r.hasPackage ||
          r.hasRf ||
          r.hasOther;
        if (!isEvent) continue;
        out.push({ ...r, channel });
      }
    }

    return out;
  }

  // ====================================================================
  // VOD (Video On Demand) Passthrough Methods
  // These methods delegate to the internal CGI API for NVR/Hub VOD operations
  // ====================================================================

  /**
   * List enriched recordings from NVR/Hub.
   * 
   * Supports multiple sources:
   * - source="baichuan" (default): uses Baichuan FileInfoList + fallback findAlarmVideo, then enriches.
   * - source="cgi": passthrough to ReolinkCgiApi.listNvrRecordings.
   * 
   * This method allows you to list enriched recordings from NVR/Hub devices using the same interface
   * as the Baichuan API, but delegates to the CGI API internally.
   * Always returns enriched recording files with parsed metadata, detection flags, and timestamps.
   * 
   * @param params - Search parameters
   * @returns Array of enriched recording files
   */
  async listNvrRecordings(
    params: ListNvrRecordingsParams & { source?: "baichuan" | "cgi" },
  ): Promise<Array<EnrichedRecordingFile>> {
    const { source = "baichuan", ...rest } = params;

    if (source === "cgi") {
      await this.cgiApi.login();
      return await this.cgiApi.listNvrRecordings(rest);
    }

    const channel = this.normalizeChannel(rest.channel);
    const uid =
      this.getUidFromPushCacheForChannel(channel) ??
      (await this.ensureUidForRecordings(channel, undefined));

    // Map CGI-ish streamType names to Baichuan stream types.
    // CGI commonly uses: main/sub/autotrack_main/autotrack_sub/telephoto_main/telephoto_sub.
    const streamTypeLower = (rest.streamType ?? "main").toLowerCase();
    const streamType: RecordingStreamType = streamTypeLower.includes("sub") ? "subStream" : "mainStream";

    // IMPORTANT: listNvrRecordings is expected to list *actual VOD recordings*.
    // On some NVR/Hub firmwares, Baichuan FileInfoList (cmdId 14/15/16) is unsupported (400 empty body).
    // The Baichuan <findAlarmVideo> flow (cmdId 272/273/274) is *alarm/event-like* and can legitimately
    // return 0 items for a whole day if there were no events, even though VOD recordings exist.
    // Therefore, when FileInfoList is unavailable (or for long ranges where Baichuan returns empty), we
    // fall back to CGI Search for completeness.
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    let enriched: EnrichedRecordingFile[] = [];
    let usedCgiFallback = false;
    try {
      const recs = await this.listRecordings({
        channel,
        uid,
        start: rest.start,
        end: rest.end,
        streamType,
        // Do NOT fall back to <findAlarmVideo> here; that would change semantics to “events only”.
        fallbackToAlarmVideo: false,
      });
      enriched = recs.map((r) => this.enrichRecordingFile(r));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordingsTraceLog(dbg, logger, "listNvrRecordings", `Baichuan VOD listing failed (${msg}); falling back to CGI Search`);
      await this.cgiApi.login();
      enriched = await this.cgiApi.listNvrRecordings({ ...rest, channel });
      usedCgiFallback = true;
    }

    // If Baichuan returned nothing for a long range, do a best-effort CGI search before returning.
    // This prevents confusing “0 clips” results when VOD exists but Baichuan is incomplete.
    const rangeMs = rest.end.getTime() - rest.start.getTime();
    if (enriched.length === 0 && Number.isFinite(rangeMs) && rangeMs >= 6 * 60 * 60 * 1000) {
      recordingsTraceLog(dbg, logger, "listNvrRecordings", `Baichuan returned 0 clips for rangeMs=${rangeMs}; trying CGI Search for completeness`);
      await this.cgiApi.login();
      const cgiRecs = await this.cgiApi.listNvrRecordings({ ...rest, channel });
      if (cgiRecs.length > 0) {
        enriched = cgiRecs;
        usedCgiFallback = true;
      }
    }

    // VOD has priority. When we had to use CGI for completeness (or Baichuan is incomplete), try to
    // recover best-effort alarm/detection flags using Baichuan <findAlarmVideo>.
    // If we cannot find any alarm for the window, mark clips as motion (simple fallback), without
    // failing the VOD listing.
    if (usedCgiFallback && enriched.length > 0) {
      const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
        if (!Number.isFinite(ms) || ms <= 0) return p;
        return (await Promise.race([
          p,
          new Promise<T>((_, reject) => {
            const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${label})`)), ms);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (t as any).unref?.();
          }),
        ])) as T;
      };

      const isEventLike = (r: Pick<EnrichedRecordingFile, "hasMotion" | "hasPerson" | "hasVehicle" | "hasAnimal" | "hasFace" | "hasDoorbell" | "hasPackage" | "hasRf" | "hasOther">): boolean =>
        Boolean(
          r.hasMotion ||
          r.hasPerson ||
          r.hasVehicle ||
          r.hasAnimal ||
          r.hasFace ||
          r.hasDoorbell ||
          r.hasPackage ||
          r.hasRf ||
          r.hasOther,
        );

      const mergeRecordTypes = (a?: string, b?: string): string | undefined => {
        const toks = new Set<string>();
        const add = (s?: string) => {
          if (!s) return;
          for (const t of s
            .toLowerCase()
            .split(/[,\s]+/)
            .map((x) => x.trim())
            .filter(Boolean)) {
            toks.add(t);
          }
        };
        add(a);
        add(b);
        return toks.size ? Array.from(toks).join(",") : undefined;
      };

      try {
        const events = await withTimeout(
          this.listNvrAlarmEventsEnrichedViaBaichuan({
            start: rest.start,
            end: rest.end,
            channels: [channel],
            streamType,
          }),
          20_000,
          "listNvrAlarmEventsEnrichedViaBaichuan",
        );

        const byChannel = events.filter((e) => e.channel === channel);

        if (byChannel.length === 0) {
          // No alarms at all -> simple fallback requested: mark as motion.
          // Avoid overriding schedule clips when CGI provides schedule info.
          let marked = 0;
          for (const clip of enriched) {
            const rt = (clip.recordType ?? "").toLowerCase();
            const isSchedule = Boolean(clip.hasSchedule || rt.includes("sched") || rt.includes("schedule"));
            if (isSchedule) continue;

            // If CGI flagged everything as `other` on some firmwares, normalize to `motion`.
            if (!isEventLike(clip) || (clip.hasOther && !clip.hasMotion && !clip.hasPerson && !clip.hasVehicle && !clip.hasAnimal && !clip.hasFace && !clip.hasDoorbell && !clip.hasPackage && !clip.hasRf)) {
              clip.hasOther = false;
              clip.hasMotion = true;
              marked++;
            }
          }
          recordingsTraceLog(dbg, logger, "listNvrRecordings", `No Baichuan alarms found; marked ${marked}/${enriched.length} VOD clips as motion`);
        } else {
          // Best-effort: detect a systematic offset and overlay alarm flags onto the closest clips.
          const offsetBucketMs = (() => {
            const bucketSizeMs = 60_000;
            const maxAbsMs = 24 * 60 * 60 * 1000;
            const counts = new Map<number, number>();

            for (const ev of byChannel) {
              for (const c of enriched) {
                const raw = (c.startTimeMs ?? 0) - (ev.startTimeMs ?? 0);
                const bucket = Math.round(raw / bucketSizeMs) * bucketSizeMs;
                if (!Number.isFinite(bucket) || Math.abs(bucket) > maxAbsMs) continue;
                counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
              }
            }

            let bestBucket = 0;
            let bestCount = 0;
            for (const [bucket, count] of counts.entries()) {
              if (count > bestCount) {
                bestCount = count;
                bestBucket = bucket;
              }
            }

            return bestCount >= 2 ? bestBucket : 0;
          })();

          if (offsetBucketMs !== 0) {
            recordingsTraceLog(dbg, logger, "listNvrRecordings", `Detected Baichuan-events<->VOD time offset bucket: ${offsetBucketMs}ms`);
          }

          let augmented = 0;
          for (const clip of enriched) {
            const cStart = clip.startTimeMs ?? 0;
            const cEnd = clip.endTimeMs ?? 0;

            let matchedAny = false;
            for (const ev of byChannel) {
              const eStart = (ev.startTimeMs ?? 0) + offsetBucketMs;
              const eEnd = (ev.endTimeMs ?? 0) + offsetBucketMs;

              const startMax = Math.max(cStart, eStart);
              const endMin = Math.min(cEnd, eEnd);
              const overlap = Math.max(0, endMin - startMax);
              if (overlap <= 0) continue;

              matchedAny = true;
              clip.hasPerson ||= ev.hasPerson;
              clip.hasVehicle ||= ev.hasVehicle;
              clip.hasAnimal ||= ev.hasAnimal;
              clip.hasFace ||= ev.hasFace;
              clip.hasMotion ||= ev.hasMotion;
              clip.hasDoorbell ||= ev.hasDoorbell;
              clip.hasPackage ||= ev.hasPackage;
              clip.hasRf ||= ev.hasRf;
              clip.hasOther ||= ev.hasOther;
              {
                const merged = mergeRecordTypes(clip.recordType, ev.recordType);
                if (merged !== undefined) clip.recordType = merged;
              }
            }

            if (matchedAny) augmented++;
          }

          recordingsTraceLog(dbg, logger, "listNvrRecordings", `Overlayed Baichuan alarms onto ${augmented}/${enriched.length} VOD clips`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        recordingsTraceLog(dbg, logger, "listNvrRecordings", `Alarm overlay failed (ignored): ${msg}`);

        // If alarm overlay fails entirely, still honor the request: default to motion (best-effort).
        let marked = 0;
        for (const clip of enriched) {
          const rt = (clip.recordType ?? "").toLowerCase();
          const isSchedule = Boolean(clip.hasSchedule || rt.includes("sched") || rt.includes("schedule"));
          if (isSchedule) continue;
          if (!isEventLike(clip)) {
            clip.hasMotion = true;
            marked++;
          }
        }
        if (marked > 0) recordingsTraceLog(dbg, logger, "listNvrRecordings", `Alarm overlay failed; marked ${marked}/${enriched.length} VOD clips as motion`);
      }
    }

    // IMPORTANT: Keep `id` stable and CGI-compatible.
    // CGI VOD search returns `/mnt/...` identifiers, while Baichuan <findAlarmVideo> often returns
    // numeric-ish ids (e.g. "012026...") that are not compatible with downstream consumers that
    // expect CGI-style file paths.
    //
    // When we detect non-/mnt ids, attempt to map each Baichuan item to the closest CGI item by
    // (start,end) timestamps and replace `id` with the CGI identifier.
    const needsCgiIdMapping = enriched.some((r) => typeof r.id === "string" && !r.id.startsWith("/mnt/"));
    if (needsCgiIdMapping) {
      try {
        await this.cgiApi.login();
        const cgiRecs = await this.cgiApi.listNvrRecordings({ ...rest, channel });

        // Fast-path mapping for numeric-ish Baichuan ids: many NVR/Hub firmwares return
        // an identifier like "01YYYYMMDDHHMMSS". CGI VOD filenames include the same timestamp as
        // ".../Rec..._YYYYMMDD_HHMMSS_...".
        const cgiByStartStamp = new Map<string, EnrichedRecordingFile>();
        {
          const re = /Rec\w*_(\d{8})_(\d{6})_/;
          for (const c of cgiRecs) {
            const m = re.exec(c.id ?? "");
            if (!m) continue;
            const k = `${m[1]}_${m[2]}`;
            if (!cgiByStartStamp.has(k)) cgiByStartStamp.set(k, c);
          }
        }

        // Baichuan XML times are sometimes parsed as UTC to preserve the camera-provided numeric
        // components, while CGI uses local time components. This can introduce a constant offset
        // between the two timelines. Detect the best offset (bucketed to minutes) to improve
        // matching robustness.
        const offsetBucketMs = (() => {
          const bucketSizeMs = 60_000;
          const maxAbsMs = 24 * 60 * 60 * 1000;
          const counts = new Map<number, number>();

          for (const b of enriched) {
            for (const c of cgiRecs) {
              const raw = (c.startTimeMs ?? 0) - (b.startTimeMs ?? 0);
              const bucket = Math.round(raw / bucketSizeMs) * bucketSizeMs;
              if (!Number.isFinite(bucket) || Math.abs(bucket) > maxAbsMs) continue;
              counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
            }
          }

          let bestBucket = 0;
          let bestCount = 0;
          for (const [bucket, count] of counts.entries()) {
            if (count > bestCount) {
              bestCount = count;
              bestBucket = bucket;
            }
          }

          // Only apply if it looks like a real systematic offset (needs some support).
          return bestCount >= 2 ? bestBucket : 0;
        })();

        if (offsetBucketMs !== 0) {
          recordingsTraceLog(dbg, logger, "listNvrRecordings", `Detected Baichuan<->CGI time offset bucket: ${offsetBucketMs}ms`);
        }

        const usedCgiIds = new Set<string>();
        const isMntPath = (s: string | undefined): s is string => typeof s === "string" && s.startsWith("/mnt/");

        let mapped = 0;
        for (const b of enriched) {
          if (isMntPath(b.id)) continue;

          // 1) Deterministic mapping by timestamp embedded in Baichuan id/fileName.
          // Example: "0120260109083717" -> "20260109_083717".
          if (typeof b.fileName === "string" && /^\d{16}$/.test(b.fileName)) {
            const digits = b.fileName.slice(2); // drop leading "01"
            if (/^\d{14}$/.test(digits)) {
              const k = `${digits.slice(0, 8)}_${digits.slice(8, 14)}`;
              const direct = cgiByStartStamp.get(k);
              if (direct && isMntPath(direct.id) && !usedCgiIds.has(direct.id)) {
                b.id = direct.id;
                b.raw.id = direct.id;
                usedCgiIds.add(direct.id);
                mapped++;
                continue;
              }
            }
          }

          // Find best candidate by overlap / closeness.
          let best: EnrichedRecordingFile | undefined;
          let bestScore = Number.POSITIVE_INFINITY;

          for (const c of cgiRecs) {
            if (!isMntPath(c.id)) continue;
            if (usedCgiIds.has(c.id)) continue;

            const bStart = (b.startTimeMs ?? 0) + offsetBucketMs;
            const bEnd = (b.endTimeMs ?? 0) + offsetBucketMs;

            const ds = Math.abs((c.startTimeMs ?? 0) - bStart);
            const de = Math.abs((c.endTimeMs ?? 0) - bEnd);

            const startMax = Math.max(c.startTimeMs ?? 0, bStart);
            const endMin = Math.min(c.endTimeMs ?? 0, bEnd);
            const overlap = Math.max(0, endMin - startMax);
            const union = Math.max(c.endTimeMs ?? 0, bEnd) - Math.min(c.startTimeMs ?? 0, bStart);
            const overlapRatio = union > 0 ? overlap / union : 0;

            // Quick reject when they're clearly unrelated.
            // Allow some slack: alarm events can be slightly shorter/longer than VOD clips.
            if (overlapRatio < 0.5 && ds > 10_000) continue;

            // Lower is better; reward overlap.
            const score = ds + de - overlapRatio * 5_000;
            if (score < bestScore) {
              bestScore = score;
              best = c;
            }
          }

          if (best && isMntPath(best.id)) {
            b.id = best.id;
            // Keep a copy on the raw object for callers that prefer pulling the CGI id from there.
            b.raw.id = best.id;
            usedCgiIds.add(best.id);
            mapped++;
          }
        }

        recordingsTraceLog(dbg, logger, "listNvrRecordings", `Mapped ${mapped}/${enriched.length} Baichuan ids to CGI /mnt paths`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        recordingsTraceLog(dbg, logger, "listNvrRecordings", `CGI id mapping skipped/failed: ${msg}`);
        // Best-effort only: keep Baichuan ids when CGI mapping is unavailable.
      }
    }

    enriched.sort((a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0));
    return enriched;
  }

  /**
   * Prepare NVR VOD download by requesting file list for a time range.
   * Passthrough to ReolinkCgiApi.prepareNvrVodDownload for NVR/Hub support.
   * 
   * @param channel - Channel number (0-based)
   * @param startTime - Start time object
   * @param endTime - End time object
   * @param streamType - Stream type (default: "main")
   * @param options - Optional parameters
   * @returns Filename for the prepared VOD file
   */
  async prepareNvrVodDownload(
    channel: number,
    startTime: {
      year: number;
      mon: number;
      day: number;
      hour: number;
      min: number;
      sec: number;
    },
    endTime: {
      year: number;
      mon: number;
      day: number;
      hour: number;
      min: number;
      sec: number;
    },
    streamType: string = "main",
    options?: {
      /** For multifocal cameras: logical channel (0 or 1) */
      iLogicChannel?: number;
    }
  ): Promise<string> {
    await this.cgiApi.login();
    return await this.cgiApi.prepareNvrVodDownload(channel, startTime, endTime, streamType, options);
  }

  /**
   * Get URL for VOD playback, download, or streaming.
   * Passthrough to ReolinkCgiApi.getVodUrl for NVR/Hub support.
   * 
   * @param filenameOrVodFile - Filename string or VodFile object from listNvrRecordings
   * @param channel - Channel number (0-based)
   * @param options - Optional parameters
   * @returns URL string
   */
  async getVodUrl(
    filenameOrVodFile: string | VodFile,
    channel: number,
    options?: GetVodUrlParams
  ): Promise<string> {
    await this.cgiApi.login();
    return await this.cgiApi.getVodUrl(filenameOrVodFile, channel, options);
  }


  /**
   * Download a VOD file.
   * Passthrough to ReolinkCgiApi.downloadVod for NVR/Hub support.
   * 
   * @param filename - Filename from listNvrRecordings or prepareNvrVodDownload
   * @param options - Optional download parameters
   * @returns Buffer containing the video file
   */
  async downloadVod(
    filename: string,
    options?: {
      /** Output filename */
      output?: string;
      /** Start time string */
      start?: string;
    }
  ): Promise<Buffer> {
    await this.cgiApi.login();
    return await this.cgiApi.downloadVod(filename, options);
  }

  /**
   * Comprehensive NVR/HUB diagnostics.
   * Calls collectNvrDiagnostics directly from DiagnosticsTools.
   * Automatically prints diagnostics after collection using the provided logger.
   * 
   * @param options - Configuration object with logger property for progress messages
   * @returns Complete diagnostics data including NVR info, channels, and per-channel details
   */
  async collectNvrDiagnostics(options: { logger: Logger }): Promise<Record<string, unknown>> {
    const diagnostics = await collectNvrDiagnostics({
      cgi: this.cgiApi,
      logger: options.logger,
    });
    return diagnostics;
  }
}

