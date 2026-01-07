import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BaichuanRtspServer, type BaichuanRtspServerOptions } from "../../baichuan/stream/BaichuanRtspServer";
import { BaichuanClient, type BaichuanClientOptions } from "../../client/BaichuanClient";
import { type Logger, recordingsTraceLog } from "../../debug/DebugConfig";
import type { CompositeStreamPipOptions } from "../../multifocal/compositeStream";
import { createDiagnosticsBundle, sampleStreams, type StreamSamplingSelection, type StreamSamplingOptions } from "../../debug/DiagnosticsTools";
import { zipDirectory } from "../../debug/zip";
import {
  BC_CLASS_FILE_DOWNLOAD,
  BC_CLASS_MODERN_24,
  BC_CMD_ID_ABILITY_INFO,
  BC_CMD_ID_AUDIO_ALARM_PLAY,
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
import { buildAbilityInfoExtensionXml, buildBinaryExtensionXml, buildChannelExtensionXml, buildFloodlightManualXml, buildPreviewStopXml, buildPreviewXml, buildPtzControlXml, buildPtzPresetXml, buildPtzPresetXmlV2, buildSirenManualXml, buildSirenTimesXml, buildStartZoomFocusXml, getXmlText, xmlEscape } from "../../protocol/xml";
import {
  type AIEvent,
  type AIState,
  type BatteryInfo,
  type ChannelStreamMetadata,
  type DeviceAbilities,
  type DeviceCapabilitiesResult,
  type DeviceSupportFlags,
  type DownloadRecordingParams,
  type DualLensChannelAnalysis,
  type DualLensChannelInfo,
  type Events,
  type ListRecordingsParams,
  type OsdConfig,
  type PirState,
  type PtzCommand,
  type PtzPreset,
  type RecordingFile,
  type RecordingStreamType,
  type ReolinkEvent,
  type ReolinkSimpleEvent,
  type ReolinkSimpleEventType,
  type SleepStatus,
  type StreamMetadata,
  type StreamProfile,
  type SupportInfo,
  type TwoWayAudioConfig,
  type VideoCodec,
  type WhiteLedState
} from "./types";

import { parseRecordingFileName } from "./recordingFileName";

import { ReolinkCgiApi } from "../cgi/ReolinkCgiApi";
import type { ReolinkDeviceInfo, ReolinkDeviceInfoTag } from "../types";
import { ReolinkHttpClient, type ReolinkHttpClientOptions } from "../http/ReolinkHttpClient";
import type { ReolinkCmdResponse } from "../http/types";
import { computeDeviceCapabilities, flattenAbilitiesForChannel, parseSupportXml } from "./capabilities";
import sharp from "sharp";

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

function extractChannelSummariesFromChannelStatus(rsp: ReolinkCmdResponse[]): Array<{
  channel: number;
  online?: boolean;
  sleep?: boolean;
  name?: string;
  uid?: string;
  typeInfo?: string;
}> {
  const status = extractStatusArrayFromGetChannelstatus(rsp);
  if (!status.length) return [];

  const out: Array<{
    channel: number;
    online?: boolean;
    sleep?: boolean;
    name?: string;
    uid?: string;
    typeInfo?: string;
  }> = [];

  for (const ch of status) {
    if (typeof ch !== "object" || ch === null) continue;

    const channel = ch?.channel ?? ch?.id ?? ch?.channelId ?? ch?.Channel ?? ch?.ID ?? ch?.ChannelId;
    if (typeof channel !== "number" || !Number.isFinite(channel)) continue;

    const name = typeof ch?.name === "string" ? ch.name : undefined;
    const uid = typeof ch?.uid === "string" ? ch.uid : undefined;
    const typeInfo = typeof ch?.typeInfo === "string" ? ch.typeInfo : undefined;
    const online = asBool01(ch?.online);
    const sleep = asBool01(ch?.sleep);

    out.push({
      channel,
      ...(online !== undefined ? { online } : {}),
      ...(sleep !== undefined ? { sleep } : {}),
      ...(name ? { name } : {}),
      ...(uid ? { uid } : {}),
      ...(typeInfo ? { typeInfo } : {}),
    });
  }

  out.sort((a, b) => a.channel - b.channel);
  return out;
}

type TalkAbility = import("./types").TalkAbility;
type TalkAudioConfig = import("./types").TalkAudioConfig;
type TalkConfig = import("./types").TalkConfig;
type TalkSession = import("./types").TalkSession;
type TalkSessionInfo = import("./types").TalkSessionInfo;

export type ReolinkBaichuanPorts = Record<string, Record<string, number>>;

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
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return undefined;
  // Treat as UTC to avoid timezone shifts when serializing to JSON.
  // Camera timestamps are typically in local time, but we parse as UTC to preserve
  // the exact values without timezone conversion artifacts.
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
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
    const fileName = getXmlText(b, "fileName") ?? getXmlText(b, "name");
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
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(xml))) {
      const fileName = (m[1] ?? "").trim();
      if (!fileName) continue;
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
  // Some firmwares use this API instead of FileInfoList for recordings.
  if (out.length === 0) {
    const alarmBlocks = getXmlBlocks(xml, "alarmVideo");
    for (const b of alarmBlocks) {
      const fileName = getXmlText(b, "fileName") ?? getXmlText(b, "name");
      if (!fileName) continue;
      const item: RecordingFile = { fileName };
      const alarmType = getXmlText(b, "alarmType");
      if (alarmType != null) item.recordType = alarmType;
      const start = getXmlBlocks(b, "startTime")[0];
      const end = getXmlBlocks(b, "endTime")[0];
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
  }

  // De-dup by fileName.
  const seen = new Set<string>();
  return out.filter((f) => {
    if (seen.has(f.fileName)) return false;
    seen.add(f.fileName);
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
  private readonly simpleEventListeners = new Set<(event: ReolinkSimpleEvent) => void>();
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

  private lastSleepProbe:
    | {
      atMs: number;
      status: SleepStatus;
    }
    | undefined;

  /**
   * Local cache for recordings. Key is a composite of channel, start, end, streamType.
   * Value contains the cached recordings and timestamp.
   */
  private recordingsCache = new Map<string, {
    recordings: RecordingFile[];
    cachedAt: number;
    /** TTL in milliseconds (default 5 minutes) */
    ttlMs: number;
  }>();
  
  /** Default TTL for recordings cache (5 minutes) */
  private recordingsCacheTtlMs = 5 * 60 * 1000;

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
    });

    // Dispatch parsed events in a minimal, stable shape.
    this.client.on("event", (event) => {
      const mapped = mapToSimpleEvent(event);
      if (!mapped) return;

      for (const cb of this.simpleEventListeners) {
        try {
          cb(mapped);
        }
        catch (e) {
          // Never allow user handlers to break the Baichuan client's event loop.
          (this.logger.warn ?? this.logger.error).call(this.logger, "[ReolinkBaichuanApi] onSimpleEvent handler error", e);
        }
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
  private getCachedRecordings(channel: number, start: Date, end: Date, streamType: string): RecordingFile[] | undefined {
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
  private cacheRecordings(channel: number, start: Date, end: Date, streamType: string, recordings: RecordingFile[], ttlMs?: number): void {
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
  async runAllDiagnosticsConsecutively(params: {
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
  }): Promise<{ runDir: string; zipPath: string; diagnosticsPath: string; streamsDir: string }> {
    const channel = params.channel ?? 0;

    const baseOutDir = params.outDir;
    const runDirName = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = join(baseOutDir, runDirName);

    (this.logger.log ?? console.log).call(this.logger, "[Diagnostics] starting run", {
      outDir: baseOutDir,
      runDir,
      channel,
      durationSeconds: params.durationSeconds,
      selection: params.selection,
    });

    const cgiEnabled = params.cgi === true || (typeof params.cgi === "object" && params.cgi != null);
    const cgiApi = cgiEnabled
      ? new ReolinkCgiApi({
        host: (typeof params.cgi === "object" ? params.cgi.host : undefined) ?? this.host,
        username: (typeof params.cgi === "object" ? params.cgi.username : undefined) ?? this.username,
        password: (typeof params.cgi === "object" ? params.cgi.password : undefined) ?? this.password,
        ...(typeof params.cgi === "object" && params.cgi.port != null ? { port: params.cgi.port } : {}),
        ...(typeof params.cgi === "object" && params.cgi.useHttps != null ? { useHttps: params.cgi.useHttps } : {}),
        ...(typeof params.cgi === "object" && params.cgi.insecureTLS != null ? { insecureTLS: params.cgi.insecureTLS } : {}),
        ...(typeof params.cgi === "object" && params.cgi.timeoutMs != null ? { timeoutMs: params.cgi.timeoutMs } : {}),
      })
      : undefined;

    const diagnosticsRes = await createDiagnosticsBundle({
      outDir: runDir,
      native: { api: this, channel },
      ...(cgiApi ? { cgi: { cgi: cgiApi, channel } } : {}),
      ...(params.extra ? { extra: params.extra } : {}),
    });

    (this.logger.log ?? console.log).call(this.logger, "[Diagnostics] diagnostics bundle collected", {
      diagnosticsPath: diagnosticsRes.diagnosticsPath,
      runDir: diagnosticsRes.outDir,
      cgiEnabled,
    });

    const streamsDir = join(runDir, "streams");
    const rtspEnabled = params.rtsp === true || (typeof params.rtsp === "object" && params.rtsp != null);
    const rtspCfg: StreamSamplingOptions["rtsp"] | undefined = rtspEnabled
      ? {
        host: (typeof params.rtsp === "object" ? params.rtsp.host : undefined) ?? this.host,
        username: (typeof params.rtsp === "object" ? params.rtsp.username : undefined) ?? this.username,
        password: (typeof params.rtsp === "object" ? params.rtsp.password : undefined) ?? this.password,
        ...(typeof params.rtsp === "object" && params.rtsp.port != null ? { port: params.rtsp.port } : {}),
      }
      : undefined;

    await sampleStreams({
      outDir: streamsDir,
      durationSeconds: params.durationSeconds,
      ...(params.snapshotIntervalSeconds != null ? { snapshotIntervalSeconds: params.snapshotIntervalSeconds } : {}),
      channel,
      selection: params.selection,
      ...(rtspCfg ? { rtsp: rtspCfg } : {}),
      ...(params.rtmp ? { rtmp: params.rtmp } : {}),
      native: { api: this },
      ...(params.limits ? { limits: params.limits } : {}),
      logger: this.logger,
    });

    (this.logger.log ?? console.log).call(this.logger, "[Diagnostics] stream sampling completed", { streamsDir });

    const zipPath = join(baseOutDir, `${runDirName}.zip`);

    (this.logger.log ?? console.log).call(this.logger, "[Diagnostics] creating zip bundle", { zipPath });
    await zipDirectory({ sourceDir: runDir, zipPath });
    (this.logger.log ?? console.log).call(this.logger, "[Diagnostics] zip bundle created", { zipPath });

    return { runDir: diagnosticsRes.outDir, zipPath, diagnosticsPath: diagnosticsRes.diagnosticsPath, streamsDir };
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
  async onSimpleEvent(callback: (event: ReolinkSimpleEvent) => void): Promise<void> {
    this.simpleEventListeners.add(callback);
    await this.ensureSimpleEventSubscribed();
    this.startSimpleEventResubscribeTimer();
  }

  /**
   * Remove one callback, or all callbacks if omitted.
   * When the last listener is removed, the API unsubscribes from Baichuan events.
   */
  async offSimpleEvent(callback?: (event: ReolinkSimpleEvent) => void): Promise<void> {
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
      if (!isUdp) {
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
      if (!isUdp) {
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
        if (retry > 0) {
          // If the body is empty, try forcing a re-login once before backing off.
          // This helps for expired sessions while staying safe for sleeping cameras.
          if (frame.body.length === 0) {
            try {
              this.client.loggedIn = false;
              await this.client.login();
            } catch {
              // ignore; we will still back off and retry
            }
          }

          const delayMs = 1500;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return await this.sendXml(params, retry - 1);
        }

        // Out of retries.
        if (frame.body.length === 0) {
          throw new Error(
            'Baichuan request failed (responseCode 400, empty body). Possible causes: camera sleeping/waking (battery), expired session, or invalid username/password.',
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
   * NVR/HomeHub helper: get a per-channel overview (model/name/uid/online/sleep).
   *
   * The method supports two sources:
   * - `source: "cgi"` (default): uses CGI only (GetChannelstatus + GetChnTypeInfo)
   * - `source: "baichuan"`: uses Baichuan only (AbilityInfo + per-channel DevInfo)
   */
  async getNvrChannelsInfo(options?: {
    /** Which source to use. Default: "cgi". */
    source?: "baichuan" | "cgi";
    /** Per-request timeout for Baichuan channel probes (default: 3500ms). */
    timeoutMs?: number;
    /** Max channels to probe if enumeration is not available (default: 16). */
    maxChannels?: number;
    /** CGI timeout (default: 30000ms). */
    cgiTimeoutMs?: number;
  }): Promise<ReolinkNvrChannelInfo[]> {
    const source = options?.source ?? "cgi";
    const timeoutMs = options?.timeoutMs ?? 3500;
    const maxChannels = options?.maxChannels ?? 16;
    const cgiTimeoutMs = options?.cgiTimeoutMs ?? 30_000;

    if (source === "cgi") {
      try {
        await this.cgiApi.login();

        // Single HTTP request: batch GetChannelstatus + GetChnTypeInfo(0..maxChannels-1)
        // We intentionally rely on response order to map each GetChnTypeInfo response to its channel.
        const n = Number.isFinite(maxChannels) && maxChannels > 0 ? maxChannels : 16;
        const batch = [
          { cmd: "GetChannelstatus", action: 0 },
          ...Array.from({ length: n }, (_, i) => ({ cmd: "GetChnTypeInfo", action: 0, param: { channel: i } })),
        ];
        const rsp = await this.cgiApi.callMany<any>(batch);

        const statusRsp = rsp.length ? [rsp[0]!] : [];
        const summaries = extractChannelSummariesFromChannelStatus(statusRsp);
        const summaryByChannel = new Map<number, (typeof summaries)[number]>();
        for (const s of summaries) summaryByChannel.set(s.channel, s);

        const channelsFromCgi = summaries.map((s) => s.channel);
        const channels = channelsFromCgi.length
          ? [...new Set(channelsFromCgi)].sort((a, b) => a - b)
          : Array.from({ length: n }, (_, i) => i);

        const out: ReolinkNvrChannelInfo[] = [];
        for (const channel of channels) {
          const s = summaryByChannel.get(channel);

          let model: string | undefined;
          let firmwareVersion: string | undefined;
          let boardInfo: string | undefined;

          // In the batch, index 1..n correspond to channel 0..n-1
          if (channel >= 0 && channel < n) {
            const typeRsp = rsp[1 + channel];
            const value = (typeRsp)?.value;
            if (value && typeof value === "object") {
              if (typeof (value).typeInfo === "string" && (value).typeInfo.trim()) model = (value).typeInfo.trim();
              if (typeof (value).firmVer === "string" && (value).firmVer.trim()) firmwareVersion = (value).firmVer.trim();
              if (typeof (value).boardInfo === "string" && (value).boardInfo.trim()) boardInfo = (value).boardInfo.trim();
            }
          }

          const name = s?.name?.trim();
          const finalModel = (model ?? s?.typeInfo)?.trim();
          const uid = s?.uid?.trim();

          out.push({
            channel,
            ...(finalModel ? { model: finalModel } : {}),
            ...(name ? { name } : {}),
            ...(uid ? { uid } : {}),
            ...(s?.online !== undefined ? { online: s.online } : {}),
            ...(s?.sleep !== undefined ? { sleep: s.sleep } : {}),
            ...(firmwareVersion ? { firmwareVersion } : {}),
            ...(boardInfo ? { boardInfo } : {}),
            source: "cgi",
          });
        }

        return out;
      } finally {
        // Intentionally do not logout here.
        // Keeping the CGI token alive reduces session churn and avoids hitting max-session limits.
      }
    }

    // source === "baichuan"
    // 1) Enumerate channels via Baichuan AbilityInfo when available.
    let channels: number[] = [];
    try {
      const abilityInfo = await this.getAbilityInfo();
      const keys = Object.keys(abilityInfo ?? {}).filter((k) => k !== "Host");
      channels = keys
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    } catch {
      // ignore
    }

    if (channels.length === 0) {
      const n = Number.isFinite(maxChannels) && maxChannels > 0 ? maxChannels : 16;
      channels = Array.from({ length: n }, (_, i) => i);
    }

    // 2) Try Baichuan per-channel DevInfo.
    const baichuanRows: ReolinkNvrChannelInfo[] = [];
    for (const channel of channels) {
      try {
        const info = await this.getInfo(channel, {
          timeoutMs,
          tags: ["type", "name", "firmwareVersion"],
        });
        const model = (info.type ?? "").trim();
        const name = (info.name ?? "").trim();
        const firmwareVersion = (info.firmwareVersion ?? "").trim();

        const hasAny = !!(model || name || firmwareVersion);
        if (!hasAny) continue;

        baichuanRows.push({
          channel,
          ...(model ? { model } : {}),
          ...(name ? { name } : {}),
          ...(firmwareVersion ? { firmwareVersion } : {}),
          source: "baichuan",
        });
      } catch {
        // ignore
      }
    }

    return baichuanRows.sort((a, b) => a.channel - b.channel);
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
    const debugParamSets = dbg?.debugParamSets === true;

    // Some firmwares include placeholder stream sections (not actually supported)
    // with 0x0 resolution and/or 0 FPS/bitrate. Treat those as unavailable.
    const isPlausibleStream = (s: { width: number; height: number; frameRate: number; bitRate: number }): boolean => {
      return s.width > 0 && s.height > 0 && (s.frameRate > 0 || s.bitRate > 0);
    };

    const logDebugStreamBlock = (tag: string, blockXml: string | undefined) => {
      if (!debugParamSets) return;

      if (!blockXml) {
        (this.logger.warn ?? this.logger.log).call(this.logger, `[ReolinkBaichuanApi] getStreamMetadata(debugParamSets): channel=${ch} tag=<${tag}> missing`);
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
        `[ReolinkBaichuanApi] getStreamMetadata(debugParamSets): channel=${ch} tag=<${tag}> ` +
        `enabled=${isEnabled} plausible=${plausible} ` +
        `width=${width} height=${height} frame=${frameRate} bitRate=${bitRate} audio=${audio} videoEncType=${videoEncTypeText ?? "?"} ` +
        `rawFields=${JSON.stringify({ widthText, heightText, frameText, bitRateText, videoEncTypeText, audioText, enableText })} ` +
        `blockXml=${JSON.stringify(xmlPreview)}`
      );
    };

    if (debugParamSets) {
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
        `[ReolinkBaichuanApi] getStreamMetadata(debugParamSets): channel=${ch} xmlLen=${xml.length} tagsPresent=${JSON.stringify(tagsPresent)} xmlHead=${JSON.stringify(xmlHead)}`
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
  async getSnapshot(channel?: number, compositeOptions?: CompositeStreamPipOptions): Promise<Buffer> {
    const cmdId = 109;

    // If composite options are provided, combine wider and tele snapshots with PIP
    if (compositeOptions) {
      const widerChannel = compositeOptions.widerChannel ?? 0;
      const teleChannel = compositeOptions.teleChannel ?? 1;
      const pipPosition = compositeOptions.pipPosition ?? "bottom-right";
      const pipSize = compositeOptions.pipSize ?? 0.25;
      const pipMargin = compositeOptions.pipMargin ?? 10;

      // Get snapshots from both channels in parallel
      const [widerSnapshot, teleSnapshot] = await Promise.all([
        this.getSnapshot(widerChannel),
        this.getSnapshot(teleChannel),
      ]);

      // Combine snapshots using sharp
      try {
        // Load both images
        const widerImage = sharp(widerSnapshot);
        const teleImage = sharp(teleSnapshot);

        // Get dimensions
        const widerMetadata = await widerImage.metadata();
        const teleMetadata = await teleImage.metadata();

        const mainWidth = widerMetadata.width ?? 1920;
        const mainHeight = widerMetadata.height ?? 1080;
        const teleWidth = teleMetadata.width ?? 1920;
        const teleHeight = teleMetadata.height ?? 1080;

        // Calculate PIP dimensions and position
        const pipWidth = Math.floor(mainWidth * pipSize);
        const pipHeight = Math.floor((teleHeight / teleWidth) * pipWidth); // Maintain aspect ratio

        // Calculate overlay position using the same logic as CompositeStream
        const { x, y } = this.calculateSnapshotOverlayPosition(
          pipPosition,
          mainWidth,
          mainHeight,
          pipWidth,
          pipHeight,
          pipMargin
        );

        // Resize tele image to PIP size and composite onto wider image
        const compositeBuffer = await widerImage
          .composite([
            {
              input: await teleImage.resize(pipWidth, pipHeight).toBuffer(),
              left: x,
              top: y,
            },
          ])
          .jpeg()
          .toBuffer();

        return compositeBuffer;
      } catch (error) {
        if (error instanceof Error && error.message.includes("Cannot find module 'sharp'")) {
          throw new Error("sharp library is required for composite snapshots. Install it with: npm install sharp");
        }
        throw error;
      }
    }

    // Regular snapshot for single channel
    const ch = channel !== undefined ? this.normalizeChannel(channel) : 0;

    // 1. Send Snap request (XML)
    // Snap XML: <Snap version="1.1"><channelId>...</channelId><logicChannel>...</logicChannel><time>0</time><fullFrame>0</fullFrame><streamType>main</streamType></Snap>
    // Must be wrapped in <body>
    const xml = `<body><Snap version="1.1"><channelId>${ch}</channelId><logicChannel>${ch}</logicChannel><time>0</time><fullFrame>0</fullFrame><streamType>main</streamType></Snap></body>`;

    await this.client.login();

    // IMPORTANT: the Snap request Extension must NOT include <binaryData>1</binaryData>.
    // The binary chunks in response will have <binaryData>1</binaryData> in their Extension.
    // Delegate to the client binary handler. cmdId=109 (snapshot) is special and is delivered via push frames
    // on many firmwares; BaichuanClient.sendBinary handles that.
    return await this.client.sendBinary({
      cmdId,
      channel: ch,
      payloadXml: xml,
      extensionXml: buildChannelExtensionXml(ch),
      timeoutMs: 15_000,
    });
  }

  /**
   * Calculate overlay position for composite snapshot (same logic as CompositeStream)
   */
  private calculateSnapshotOverlayPosition(
    position: import("../../multifocal/compositeStream").PipPosition,
    mainWidth: number,
    mainHeight: number,
    pipWidth: number,
    pipHeight: number,
    margin: number
  ): { x: number; y: number } {
    const pipW = Math.floor(pipWidth);
    const pipH = Math.floor(pipHeight);
    const m = margin;

    switch (position) {
      case "top-left":
        return { x: m, y: m };
      case "top-right":
        return { x: mainWidth - pipW - m, y: m };
      case "bottom-left":
        return { x: m, y: mainHeight - pipH - m };
      case "bottom-right":
        return { x: mainWidth - pipW - m, y: mainHeight - pipH - m };
      case "center":
        return { x: Math.floor((mainWidth - pipW) / 2), y: Math.floor((mainHeight - pipH) / 2) };
      case "top-center":
        return { x: Math.floor((mainWidth - pipW) / 2), y: m };
      case "bottom-center":
        return { x: Math.floor((mainWidth - pipW) / 2), y: mainHeight - pipH - m };
      case "left-center":
        return { x: m, y: Math.floor((mainHeight - pipH) / 2) };
      case "right-center":
        return { x: mainWidth - pipW - m, y: Math.floor((mainHeight - pipH) / 2) };
      default:
        return { x: m, y: m };
    }
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
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    try {
      recordingsTraceLog(dbg, logger, "listRecordings", `Init recordings lookup: ${JSON.stringify(params)}`);

      try {
        await this.client.login();
        recordingsTraceLog(dbg, logger, "listRecordings", `Login successful`);
      } catch (e) {
        recordingsTraceLog(dbg, logger, "listRecordings", `Login failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }

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

      recordingsTraceLog(dbg, logger, "listRecordings", `Opening FileInfoList: channel=${channel}, uid=${uid}, streamType=${streamType}`);
    // Use explicit timeout for recording operations (15 seconds per request)
    const openResp = await this.sendXml({ cmdId: BC_CMD_ID_FILE_INFO_LIST_OPEN, channel, payloadXml: openXml, timeoutMs: 15_000 });
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
            recordingsTraceLog(dbg, logger, "listRecordings", `Page ${i + 1} GET failed: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
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

    recordingsTraceLog(dbg, logger, "listRecordings", `FileInfoList returned no files, falling back to findAlarmVideo`);
    // Fallback path: <findAlarmVideo> (cmdId 272/273/274).
    // This often returns "alarm videos" when FileInfoList is unsupported/empty.
    const uidBase = uid.split("_")[0] ?? uid;
    const streamTypeInt = streamType === "subStream" ? 1 : 0;
    const alarmType = "md, pir, io, people, face, vehicle, dog_cat, visitor, other, package, cry, crossline, intrusion, loitering, legacy, loss";

    const findOpenXml = (start: Date, end: Date) => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
<channelId>${channel}</channelId>
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
<channelId>${channel}</channelId>
<fileHandle>${xmlEscape(fileHandle)}</fileHandle>
</findAlarmVideo>
</body>`;

      const alarmFiles: RecordingFile[] = [];
      let currentStart = params.start;
      try {
        for (let i = 0; i < maxIterations; i++) {
          recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo iteration ${i + 1}/${maxIterations}: start=${currentStart.toISOString()}, end=${params.end.toISOString()}`);
          
          let openResp: string;
          try {
            openResp = await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_OPEN, channel, payloadXml: findOpenXml(currentStart, params.end) });
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
            
            let getResp: string;
            try {
              getResp = await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_GET, channel, payloadXml: getXml });
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo GET response received`);
            } catch (e) {
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo GET failed: ${e instanceof Error ? e.message : String(e)}`);
              throw e;
            }
            
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
            currentStart = lastWithStart.startTime;
          } finally {
            // Best-effort close.
            try {
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: closing handle=${fileHandle}`);
              await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_CLOSE, channel, payloadXml: getXml });
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo: closed successfully`);
            } catch (e) {
              recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo CLOSE failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
              // ignore
            }
          }
        }
      } catch (e) {
        recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo loop failed: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
        throw e;
      }

      const seenAlarm = new Set<string>();
      const result = alarmFiles.filter((f) => {
        if (seenAlarm.has(f.fileName)) return false;
        seenAlarm.add(f.fileName);
        return true;
      });
      recordingsTraceLog(dbg, logger, "listRecordings", `findAlarmVideo complete: returning ${result.length} unique files`);
      return result;
    } catch (e) {
      recordingsTraceLog(dbg, logger, "listRecordings", `ERROR: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
      throw e;
    }
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
  async listRecordingsByTime(params: {
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
  }): Promise<RecordingFile[]> {
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    try {
      recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Init: ${JSON.stringify({ params })}`);

      const { channel, uid, start, end, streamType, recordType, count, fallbackToAlarmVideo, maxIterations, httpFallback = true, bypassCache = false, cacheTtlMs } = params;

      // Fallback to the client's configured channel (or 0) when not explicitly provided.
      const effectiveChannel = channel ?? (this.client.getConfiguredChannel?.() ?? 0);
      const effectiveStreamType = streamType || "mainStream";
      recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Effective channel: ${effectiveChannel}`);

      // Check cache first (unless bypassed)
      if (!bypassCache) {
        const cachedRecs = this.getCachedRecordings(effectiveChannel, start, end, effectiveStreamType);
        if (cachedRecs) {
          recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Cache hit: returning ${cachedRecs.length} cached recordings`);
          
          // Apply count limit if specified
          if (typeof count === "number" && Number.isFinite(count) && count > 0) {
            return cachedRecs.slice(0, count);
          }
          return cachedRecs;
        }
        recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Cache miss: fetching from camera`);
      } else {
        recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Cache bypassed: fetching fresh data`);
      }

      let effectiveUid: string;
      try {
        effectiveUid = await this.ensureUidForRecordings(effectiveChannel, uid);
        recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Effective UID: ${effectiveUid}`);
      } catch (e) {
        recordingsTraceLog(dbg, logger, "listRecordingsByTime", `ensureUidForRecordings failed: ${e instanceof Error ? e.message : String(e)}`);
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
        recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Using HTTP API directly (httpFallback=true)`);
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
          
          recordingsTraceLog(dbg, logger, "listRecordingsByTime", `HTTP API Search payload: ${JSON.stringify(searchPayload)}`);

          const httpResponse = await this.cgiApi.call('Search', searchPayload, 0);

          recordingsTraceLog(dbg, logger, "listRecordingsByTime", `HTTP API returned response: ${JSON.stringify(httpResponse)}`);

          // Parse HTTP response and convert to RecordingFile format
          recs = [];
          if (Array.isArray(httpResponse) && httpResponse.length > 0) {
            for (const data of httpResponse) {
              if (data.code !== 0) {
                recordingsTraceLog(dbg, logger, "listRecordingsByTime", `HTTP API returned error code ${data.code}`);
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
            recordingsTraceLog(dbg, logger, "listRecordingsByTime", `HTTP API parsed ${recs.length} recordings`);
          }
        } catch (httpError: any) {
          recordingsTraceLog(dbg, logger, "listRecordingsByTime", `HTTP API failed: ${httpError instanceof Error ? httpError.message : String(httpError)}`);
          throw httpError;
        }
      } else {
        // Use Baichuan API (default behavior)
        recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Calling listRecordings with params: channel=${listParams.channel}, uid=${listParams.uid}, start=${listParams.start.toISOString()} (original UTC: ${start.toISOString()}), end=${listParams.end.toISOString()} (original UTC: ${end.toISOString()})`);
        
        try {
          recs = await this.listRecordings(listParams);
          recordingsTraceLog(dbg, logger, "listRecordingsByTime", `listRecordings returned ${recs.length} recordings`);
        } catch (e) {
          recordingsTraceLog(dbg, logger, "listRecordingsByTime", `listRecordings failed: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
          throw e;
        }
      }

      // Normalize and filter by time window (defensive: some firmwares may return a wider range).
      const startMs = start.getTime();
      const endMs = end.getTime();
      recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Filtering recordings: startMs=${startMs}, endMs=${endMs}`);
      
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

      recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Filtered to ${filtered.length} recordings in time window`);

      // Cache the filtered results for future lookups
      this.cacheRecordings(effectiveChannel, start, end, effectiveStreamType, filtered, cacheTtlMs);
      recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Cached ${filtered.length} recordings`);

      if (typeof count === "number" && Number.isFinite(count) && count > 0) {
        const result = filtered.slice(0, count);
        recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Returning ${result.length} recordings (limited by count=${count})`);
        return result;
      }

      recordingsTraceLog(dbg, logger, "listRecordingsByTime", `Returning ${filtered.length} recordings`);
      return filtered;
    } catch (e) {
      recordingsTraceLog(dbg, logger, "listRecordingsByTime", `ERROR: ${e instanceof Error ? e.message : String(e)}, stack: ${e instanceof Error ? e.stack : 'no stack'}`);
      throw e;
    }
  }

  /**
   * Convenience helper to build playback/download URLs for a single recording.
   *
   * Currently returns the RTMP VOD URL (suitable for streaming/export via playback).
   * Use {@link ReolinkBaichuanApi.downloadRecording | downloadRecording} for bit-identical file download.
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
    
    if (explicitUid && explicitUid.trim()) {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Using explicit UID: ${explicitUid.trim()}`);
      return explicitUid.trim();
    }

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
          // Typical Reolink UID: uppercase alnum, ~16 chars (e.g. 9527000HZ56U1ORU)
          if (/^[0-9A-Z]{12,24}$/.test(s) && /[A-Z]/.test(s)) return s;
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

    // 1) Try getInfo() -> serialNumber
    try {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Attempting auto-discovery via getInfo()`);
      const info = await this.getInfo(channel);
      const serial = (info.serialNumber ?? "").trim();
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `getInfo().serialNumber: ${serial || "(missing)"}`);
      if (serial && /^[0-9A-Z]{12,24}$/.test(serial) && /[A-Z]/.test(serial)) {
        discoveredUid = serial;
        recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Found UID from serialNumber: ${discoveredUid}`);
      }
    } catch (e) {
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `getInfo() failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2) Try HTTP CGI GetP2p / GetDevInfo / GetChannelstatus
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

        if (!discoveredUid) {
          try {
            const ch = await this.cgiApi.GetChannelstatus();
            const fromChannelStatus = extractUidLike(ch);
            recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `[HTTP CGI] GetChannelstatus UID candidate: ${fromChannelStatus || "(none)"}`);
            discoveredUid = discoveredUid ?? fromChannelStatus ?? undefined;
          } catch (e) {
            recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `[HTTP CGI] GetChannelstatus failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
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
      // Cache the discovered UID for future use
      this.uid = discoveredUid;
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Auto-discovered and cached UID: ${discoveredUid}`);
      return discoveredUid;
    }

    recordingsTraceLog(dbg, logger, "ensureUidForRecordings", `Auto-discovery failed - no UID found`);
    throw new Error(
      "UID is required to access recordings. Provide a UID explicitly or configure the client with a UID.",
    );
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
    await this.client.login();

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
    /** Prefer CGI enumeration (default true). */
    preferCgi?: boolean;
    /** Max channels to probe when enumerating (default 16). */
    maxChannels?: number;
    /** Timeout for each subscribe attempt (default 10000ms). */
    timeoutMs?: number;
  }): Promise<void> {
    await this.client.login();

    const preferCgi = options?.preferCgi ?? true;
    const maxChannels = options?.maxChannels ?? 16;
    const timeoutMs = options?.timeoutMs ?? 10_000;

    let channels: number[] = [];
    try {
      const info = await this.getNvrChannelsInfo({
        source: preferCgi ? "cgi" : "baichuan",
        maxChannels,
      });

      // Filter out empty channels when we can. (Keep online/sleeping channels.)
      const filtered = info
        .filter((c) => Boolean((c.uid ?? "").trim()) || Boolean((c.name ?? "").trim()) || c.online === true || c.sleep === true)
        .map((c) => c.channel)
        .filter((c) => Number.isInteger(c) && c >= 0);

      channels = (filtered.length ? filtered : info.map((c) => c.channel))
        .filter((c) => Number.isInteger(c) && c >= 0)
        .slice(0, maxChannels);
    } catch {
      // ignore: fallback below
    }

    if (!channels.length) {
      const configured = this.client.getConfiguredChannel?.() ?? 0;
      channels = [configured];
    }

    channels = [...new Set(channels)].sort((a, b) => a - b);

    let okCount = 0;
    let lastCode: number | undefined;
    for (const channel of channels) {
      const frame = await this.client.sendFrame({
        cmdId: 31,
        channelIdOverride: channel,
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
      const motionState = await this.getMotionState(channel);
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
      (this.logger.warn ?? this.logger.error)?.call(this.logger, "[ReolinkBaichuanApi] Error checking current state", e);
    }
  }

  /**
   * Dispatch a simple event to all listeners.
   */
  private dispatchSimpleEvent(event: ReolinkSimpleEvent): void {
    for (const cb of this.simpleEventListeners) {
      try {
        cb(event);
      } catch (e) {
        // Never allow user handlers to break the event loop
        (this.logger.warn ?? this.logger.error)?.call(
          this.logger,
          "[ReolinkBaichuanApi] onSimpleEvent handler error",
          e,
        );
      }
    }
  }

  /**
   * Start periodic polling of motion and AI state (every 5 seconds).
   * Only starts if there are listeners and polling is not already running.
   * Polling is disabled for UDP/battery cameras to avoid waking them unnecessarily.
   */
  private startStatePolling(): void {
    // Only poll if there are listeners
    if (this.simpleEventListeners.size === 0) {
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
        this.logger.debug?.("[ReolinkBaichuanApi] state polling tick failed", e);
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
   * Start two-way audio session via Baichuan.
   * cmd_id: 10 (two-way audio)
   * Uses cmd_id 10 with audioStreamMode = "mixAudioStream"
   * 
   * Note: After starting, audio frames are received via push events with streamType indicating audio.
   * Audio is typically G.711 (alaw/ulaw) at 8kHz sample rate.
   */
  async startTwoWayAudio(channel?: number): Promise<void> {
    const cmdId = 10; // Two-way audio
    // Start two-way audio with mixAudioStream mode
    // cmd_id 10 enables two-way audio
    await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
  }

  /**
   * Send audio data via Baichuan protocol.
   * Audio is sent via cmd_id 10 with binary audio data.
   * 
   * Audio Format Requirements:
   * - Format: G.711 A-law (pcm_alaw)
   * - Sample Rate: 8000 Hz
   * - Channels: 1 (mono)
   * - Bitrate: 64k (typical)
   * 
   * Note: Audio data should already be in G.711 A-law format (from ffmpeg).
   *       No encoding is performed - data is sent directly to the camera.
   * 
   * @param audioData - G.711 A-law encoded audio data (from ffmpeg)
   * @param channel - Channel number (optional)
   */
  async sendAudioData(audioData: Buffer, channel?: number): Promise<void> {
    const cmdId = 10; // Two-way audio command
    // Audio data is sent as binary payload with cmd_id 10
    // streamType in header may indicate audio stream (typically 1 for audio)
    // Note: Actual implementation may need to use sendBinary or a specialized method
    // For now, this is a placeholder - needs testing with real device
    // 
    // Note: sendBinary expects XML payload, but audio is binary
    // This may need a specialized method or modification to sendBinary
    // For now, we'll use sendBinary with empty XML and note that audio data
    // should be sent via a different mechanism (possibly raw socket write)
    const params: Parameters<typeof this.client.sendBinary>[0] = {
      cmdId,
      payloadXml: "", // Audio data is binary, not XML
    };
    if (channel !== undefined) {
      params.channel = channel;
    }
    // Note: This is a placeholder - actual audio sending may require
    // direct socket writes or a specialized audio streaming method
    await this.client.sendBinary(params);
  }

  /**
   * Stop two-way audio session.
   * Stopping typically involves closing the audio stream or sending stop command.
   */
  async stopTwoWayAudio(channel?: number): Promise<void> {
    // Note: May need specific cmd_id or parameters to stop
    // Stopping may involve:
    // - Closing the audio stream connection
    // - Sending a stop command (if supported)
    // For now, this is a placeholder - needs testing with real device
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
  async startVideoStream(channel?: number, profile: StreamProfile = "sub"): Promise<void> {
    const ch = this.normalizeChannel(channel);
    // Use the same 0-based channel_id everywhere (header, Extension, payload).
    const channelId = ch;

    // Map profile to handle and stream_type values
    // handle: 0 for main, 256 for sub, 1024 for extern
    // stream_type in header: 0 for main, 1 for sub, 0 for extern
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number; streamName: string }> = {
      main: { handle: 0, streamType: 0, streamName: "mainStream" },
      sub: { handle: 256, streamType: 1, streamName: "subStream" },
      ext: { handle: 1024, streamType: 0, streamName: "externStream" },
    };

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

    // Subscribe (MSG_ID_VIDEO, msg_num) BEFORE sending the command.
    // On some BCUDP/battery models, the start-stream request can sporadically timeout;
    // retry a few times and ensure we unsubscribe on failures.
    const isUdp = this.client.getTransport?.() === "udp";
    const maxAttempts = isUdp ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const msgNum = this.client.peekNextMsgNum();
      this.client.subscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);

      try {
        const frameParams: Parameters<typeof this.client.sendFrame>[0] = {
          cmdId: BC_CMD_ID_VIDEO,
          channel: ch,
          channelIdOverride: channelId,
          extensionXml: buildChannelExtensionXml(channelId),
          payloadXml,
          messageClass: BC_CLASS_MODERN_24,
          streamType: config.streamType,
        };
        const frame = await this.client.sendFrame(frameParams);

        if (frame.header.responseCode !== 200) {
          throw new Error(
            `Video stream request rejected (response_code ${frame.header.responseCode}). Expected response_code 200, camera returned ${frame.header.responseCode}`
          );
        }

        // Remember msgNum so we can stop the stream with the same msgNum.
        this.activeVideoMsgNums.set(`${ch}:${profile}`, frame.header.msgNum);

        // Success.
        return;
      } catch (error) {
        lastError = error;
        try {
          this.client.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
        } catch {
          // ignore
        }
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
    return this.activeVideoMsgNums.get(`${ch}:${profile}`);
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
  async stopVideoStream(channel?: number, profile: StreamProfile = "sub"): Promise<void> {
    const ch = this.normalizeChannel(channel);
    // Use the same 0-based channel_id everywhere (header, Extension, payload).
    const channelId = ch;

    // Map profile to handle value
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number }> = {
      main: { handle: 0, streamType: 0 },
      sub: { handle: 256, streamType: 1 },
      ext: { handle: 1024, streamType: 0 },
    };

    const config = profileConfig[profile];

    // Build Preview XML payload for stop (without stream_type)
    // channelId is NOT in Preview XML - it's handled via channelId in header
    const payloadXml = buildPreviewStopXml(config.handle, channelId);

    const key = `${ch}:${profile}`;
    const msgNum = this.activeVideoMsgNums.get(key);
    this.activeVideoMsgNums.delete(key);

    // Send VIDEO_STOP with the same msg_num as VIDEO.
    // Some cameras don't reliably reply; treat this as best-effort with a short timeout.
    try {
      await this.client.sendFrame({
        cmdId: BC_CMD_ID_VIDEO_STOP,
        channel: ch,
        channelIdOverride: channelId,
        extensionXml: buildChannelExtensionXml(channelId),
        payloadXml,
        messageClass: BC_CLASS_MODERN_24,
        streamType: config.streamType,
        ...(msgNum !== undefined ? { msgNumOverride: msgNum } : {}),
        timeoutMs: 2000,
      });
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
  async getDualLensChannelInfo(): Promise<DualLensChannelAnalysis> {

    // 1. Get device information
    let model: string | undefined;
    let channelNum: number | undefined;
    let supportInfo: SupportInfo | undefined;

    try {
      const deviceInfo = await this.getInfo(0, { tags: ["type"] });
      model = deviceInfo.type?.trim();
    } catch {
      // ignore
    }

    try {
      const capabilities = await this.getDeviceCapabilities(0);
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

    // Check against known dual lens models (case-insensitive and partial match)
    const modelLower = normalizedModel?.toLowerCase().trim() ?? "";

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
    const hasDualLensChannelCount = (channelNumValue === 2 || channelNumValue === 3) && Number.isFinite(channelNumValue);

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
      streamChannels.push(0, 1);
      logicalChannels.push(0);
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
        const chCapabilities = await this.getDeviceCapabilities(ch);
        const caps = chCapabilities.capabilities;
        const chSupport = chCapabilities.support;
        const chFeatures = chCapabilities.features;

        // Check motion detection
        // For SINGLE_MOTION: only channel 0 has motion
        // For DUAL_MOTION: both channels have motion
        let hasMotion = false;
        if (dualLensType === "single_motion") {
          hasMotion = ch === 0; // Only channel 0 for TrackMix
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

        // Determine lens type
        let lensType: "wide" | "telephoto" | undefined;
        if (ch === 0) {
          lensType = "wide";
        } else if (ch === 1) {
          lensType = "telephoto";
        }

        // For TrackMix (single_motion) models, channel 1 (telephoto) has optical zoom
        // even if capabilities don't explicitly report it
        let hasZoom = caps.hasZoom ?? false;
        if (dualLensType === "single_motion" && ch === 1 && lensType === "telephoto") {
          // Telephoto lens on TrackMix has zoom capability
          hasZoom = true;
        }

        channelInfos.push({
          channel: ch,
          hasPan: caps.hasPan ?? false,
          hasTilt: caps.hasTilt ?? false,
          hasZoom,
          hasMotion,
          hasIntercom: caps.hasIntercom ?? false,
          hasPresets: caps.hasPresets ?? false,
          lensType,
          availableStreams,
        });
      } catch (err) {
        // If it fails for a channel, continue with the others
        (this.logger.warn ?? this.logger.log).call(
          this.logger,
          `[ReolinkBaichuanApi] getDualLensChannelInfo: error in channel ${ch}: ${err}`
        );
      }
    }

    // Build capability channel maps: for each capability, list all channels that support it
    const capabilityChannels = {
      pan: channelInfos.filter((ch) => ch.hasPan).map((ch) => ch.channel),
      tilt: channelInfos.filter((ch) => ch.hasTilt).map((ch) => ch.channel),
      zoom: channelInfos.filter((ch) => ch.hasZoom).map((ch) => ch.channel),
      motion: channelInfos.filter((ch) => ch.hasMotion).map((ch) => ch.channel),
      intercom: channelInfos.filter((ch) => ch.hasIntercom).map((ch) => ch.channel),
      presets: channelInfos.filter((ch) => ch.hasPresets).map((ch) => ch.channel),
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
    }
  ): Promise<BaichuanRtspServer>;
  async createRtspStream(
    channel: number,
    profile: StreamProfile,
    options?: {
      listenHost?: string; // Host to listen on (default: "127.0.0.1")
      listenPort?: number; // Port to listen on (default: 8554)
      path?: string; // RTSP path (e.g. "/main" or "/sub")
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
      },
    optionsMaybe?: {
      listenHost?: string;
      listenPort?: number;
      path?: string;
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
   * @param channel - Channel number (0-based)
   * @returns Array of stream options
   */
  async buildVideoStreamOptions(
    channel?: number,
    options?: {
      /** If true, the `url` field will contain the URL with authentication credentials embedded.
       * If false or undefined, `url` will not include credentials (use `urlWithAuth` for authenticated URLs).
       * Default: false
       */
      includeAuth?: boolean;
    },
  ): Promise<{
    nativeStreams: ReolinkSupportedStream[];
    rtspStreams: ReolinkSupportedStream[];
    rtmpStreams: ReolinkSupportedStream[];
  }> {
    const includeAuth = options?.includeAuth;
    const isComposite = channel === undefined;

    const rtspStreams: ReolinkSupportedStream[] = [];
    const rtmpStreams: ReolinkSupportedStream[] = [];
    const nativeStreams: ReolinkSupportedStream[] = [];

    // For composite streams (multifocal devices), return composite stream options
    if (isComposite) {
      // Get stream metadata from wider channel (channel 0) for composite stream metadata
      const widerMetadata = await this.getStreamMetadata(0);
      const widerStreams = widerMetadata?.streams || [];

      for (const metadata of widerStreams) {
        const profile = metadata.profile as StreamProfile;

        // Build composite native stream option
        // Composite streams combine wider (channel 0) and tele (channel 1) with PIP
        const compositeUrl = new URL(`baichuan://${this.host}/composite/profile/${profile}`);
        const compositeUrlWithAuth = new URL(`baichuan://${this.host}/composite/profile/${profile}`);
        compositeUrlWithAuth.username = this.username;
        compositeUrlWithAuth.password = this.password;

        nativeStreams.push({
          name: `Composite ${profile}`,
          id: `composite_${profile}`,
          container: "rtp", // Composite streams use RFC4571 (rtp container)
          profile,
          url: compositeUrl.toString(),
          urlWithAuth: compositeUrlWithAuth.toString(),
          metadata,
        });
      }

      // Note: RTSP and RTMP composite streams are not yet supported
      // They would require combining two RTSP/RTMP streams which is more complex
      // For now, only native composite streams are supported

      return {
        nativeStreams,
        rtmpStreams,
        rtspStreams,
      };
    }

    // Regular stream building for specific channel
    const ch = this.normalizeChannel(channel);

    // Get network ports (RTSP/RTMP configuration)
    const netPort = await this.getNetPort();
    const rtspEnabled = netPort.rtsp?.enable === 1;
    const rtmpEnabled = netPort.rtmp?.enable === 1;
    const rtspPort = netPort.rtsp?.port ?? 554;
    const rtmpPort = netPort.rtmp?.port ?? 1935;

    // Get stream metadata to build options
    const streamMetadata = await this.getStreamMetadata(ch);
    const streams = streamMetadata?.streams || [];

    for (const metadata of streams) {
      const profile = metadata.profile as StreamProfile;

      // Build RTSP URL if enabled (RTSP doesn't support ext stream, only main and sub)
      if (rtspEnabled && profile !== "ext") {
        // RTSP format: rtsp://ip:port/h264Preview_XX_profile
        // XX is 1-based channel with 2-digit padding
        const channelStr = String(ch + 1).padStart(2, "0");
        const profileStr = profile === "main" ? "main" : "sub";
        const rtspPath = `/h264Preview_${channelStr}_${profileStr}`;
        const rtspId = `h264Preview_${channelStr}_${profileStr}`;

        const rtspUrl = new URL(`rtsp://${this.host}:${rtspPort}${rtspPath}`);
        const rtspUrlWithAuth = new URL(`rtsp://${this.host}:${rtspPort}${rtspPath}`);
        rtspUrlWithAuth.username = this.username;
        rtspUrlWithAuth.password = this.password;

        rtspStreams.push({
          name: `RTSP ${rtspId}`,
          id: rtspId,
          container: "rtsp",
          channel: ch,
          profile,
          url: rtspUrl.toString(),
          urlWithAuth: rtspUrlWithAuth.toString(),
          path: rtspPath,
          port: rtspPort,
          metadata,
        });
      }

      // Build RTMP URL if enabled (RTMP supports main, sub, and ext streams)
      if (rtmpEnabled) {
        // RTMP format: /bcs/channelX_stream.bcs?channel=X&stream=stream_type&user=username&password=password
        // Based on reolink_aio api.py:
        // - stream in path is "main", "sub", or "ext" (not "main.bcs")
        // - stream_type in query: 0 for main/ext, 1 for sub
        // - credentials: user and password as query parameters
        const streamName = profile === "main" ? "main" : profile === "sub" ? "sub" : "ext";
        const streamType = profile === "sub" ? 1 : 0; // 0 for main/ext, 1 for sub
        const rtmpId = `${streamName}.bcs`; // ID (main.bcs, sub.bcs, ext.bcs)

        // Use channel directly (0-based) in path, matching reolink_aio behavior
        const rtmpPath = `/bcs/channel${ch}_${streamName}.bcs`;

        // URL without authentication
        const rtmpUrl = new URL(`rtmp://${this.host}:${rtmpPort}${rtmpPath}`);
        const params = rtmpUrl.searchParams;
        params.set("channel", ch.toString());
        params.set("stream", streamType.toString());

        // URL with authentication
        const rtmpUrlWithAuth = new URL(`rtmp://${this.host}:${rtmpPort}${rtmpPath}`);
        const paramsWithAuth = rtmpUrlWithAuth.searchParams;
        paramsWithAuth.set("channel", ch.toString());
        paramsWithAuth.set("stream", streamType.toString());
        paramsWithAuth.set("user", this.username);
        paramsWithAuth.set("password", this.password);

        rtmpStreams.push({
          name: `RTMP ${rtmpId}`,
          id: rtmpId,
          container: "rtmp",
          channel: ch,
          profile,
          url: includeAuth ? rtmpUrlWithAuth.toString() : rtmpUrl.toString(),
          urlWithAuth: rtmpUrlWithAuth.toString(),
          path: rtmpPath,
          port: rtmpPort,
          streamType,
          metadata,
        });
      }

      // Build native Baichuan stream option
      // Native streams use BaichuanVideoStream and are identified by profile
      const nativeUrl = new URL(`baichuan://${this.host}/channel/${ch}/profile/${profile}`);
      const nativeUrlWithAuth = new URL(`baichuan://${this.host}/channel/${ch}/profile/${profile}`);
      nativeUrlWithAuth.username = this.username;
      nativeUrlWithAuth.password = this.password;

      nativeStreams.push({
        name: `Native ${profile}`,
        id: `native_${profile}`,
        container: "rtp", // Special container type for native Baichuan streams
        channel: ch,
        profile,
        url: nativeUrl.toString(),
        urlWithAuth: nativeUrlWithAuth.toString(),
        metadata,
      });
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
}

