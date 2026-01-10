import type { DebugConfig, Logger } from "../../debug/DebugConfig";
import { recordingsTraceLog } from "../../debug/DebugConfig";
import { collectNvrDiagnostics } from "../../debug/DiagnosticsTools";
import { parseRecordingFileName } from "../baichuan/recordingFileName";
import type { EnrichedRecordingFile, RecordingFile } from "../baichuan/types";
import { ReolinkHttpClient, type ReolinkHttpClientOptions } from "../http/ReolinkHttpClient";
import type { ReolinkCmdRequest, ReolinkCmdResponse } from "../http/types";
import type { ReolinkDeviceInfo, ReolinkDeviceInfoTag } from "../types";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type ReolinkCmdResponseExt<TValue = JsonValue> = ReolinkCmdResponse<TValue> & {
  /** Some CGI commands (notably GetEnc) return additional metadata fields. */
  initial?: JsonValue;
  range?: JsonValue;
};

export type CgiChannelStatusEntry = {
  channel: number;
  name?: string;
  online?: number;
  sleep?: number;
  uid?: string;
  typeInfo?: string;
};

export type CgiGetChannelstatusValue = {
  status?: CgiChannelStatusEntry[];
};

export type CgiChnTypeInfoValue = {
  boardInfo?: string;
  firmVer?: string;
  pakSuffix?: string;
  typeInfo?: string;
};

export type CgiDetectionState = {
  alarm_state: number;
  support: number;
};

export type CgiAiKey = "dog_cat" | "face" | "other" | "package" | "people" | "vehicle";

export type CgiAiStateValue = Partial<Record<CgiAiKey, CgiDetectionState>> & {
  channel: number;
};

export type CgiEncStream = {
  bitRate: number;
  frameRate: number;
  gop: number;
  height: number;
  profile: string;
  size: string;
  vType: string;
  width: number;
};

export type CgiEnc = {
  audio: number;
  channel: number;
  mainStream: CgiEncStream;
  subStream: CgiEncStream;
};

export type CgiEncValue = {
  Enc: CgiEnc;
};

export type CgiGetChannelstatusResponse = ReolinkCmdResponseExt<CgiGetChannelstatusValue> & {
  cmd: "GetChannelstatus";
};

export type CgiGetChnTypeInfoResponse = ReolinkCmdResponseExt<CgiChnTypeInfoValue> & {
  cmd: "GetChnTypeInfo";
};

export type CgiGetAiStateResponse = ReolinkCmdResponseExt<CgiAiStateValue> & {
  cmd: "GetAiState";
};

export type CgiGetEncResponse = ReolinkCmdResponseExt<CgiEncValue> & {
  cmd: "GetEnc";
  initial?: CgiEncValue;
  range?: JsonValue;
};

export type CgiGetRtspUrlValue = {
  rtspUrl?: string;
  url?: string;
  RtspUrl?: string;
  rtsp?: string;
} & Record<string, JsonValue>;

export type CgiGetRtspUrlResponse = ReolinkCmdResponseExt<CgiGetRtspUrlValue> & {
  cmd: "GetRtspUrl";
};

export type CgiAbilityLeaf = {
  permit: number;
  ver: number;
};

export type CgiAbilityChn = {
  aiTrack?: CgiAbilityLeaf;
  aiTrackDogCat?: CgiAbilityLeaf;
  alarmAudio?: CgiAbilityLeaf;
  alarmIoIn?: CgiAbilityLeaf;
  alarmIoOut?: CgiAbilityLeaf;
  alarmMd?: CgiAbilityLeaf;
  alarmRf?: CgiAbilityLeaf;
  batAnalysis?: CgiAbilityLeaf;
  battery?: CgiAbilityLeaf;
  cameraMode?: CgiAbilityLeaf;
  channelType?: CgiAbilityLeaf;
  customAudio?: CgiAbilityLeaf;
  disableAutoFocus?: CgiAbilityLeaf;
  enc?: CgiAbilityLeaf;
  floodLight?: CgiAbilityLeaf;
  ftp?: CgiAbilityLeaf;
  image?: CgiAbilityLeaf;
  indicatorLight?: CgiAbilityLeaf;
  isp?: CgiAbilityLeaf;
  isp3Dnr?: CgiAbilityLeaf;
  ispAntiFlick?: CgiAbilityLeaf;
  ispBackLight?: CgiAbilityLeaf;
  ispBright?: CgiAbilityLeaf;
  ispContrast?: CgiAbilityLeaf;
  ispDayNight?: CgiAbilityLeaf;
  ispExposureMode?: CgiAbilityLeaf;
  ispFlip?: CgiAbilityLeaf;
  ispHue?: CgiAbilityLeaf;
  ispMirror?: CgiAbilityLeaf;
  ispSatruation?: CgiAbilityLeaf;
  ispSharpen?: CgiAbilityLeaf;
  ispWhiteBalance?: CgiAbilityLeaf;
  ledControl?: CgiAbilityLeaf;
  lightType?: CgiAbilityLeaf;
  live?: CgiAbilityLeaf;
  mainEncType?: CgiAbilityLeaf;
  mask?: CgiAbilityLeaf;
  mdTriggerAudio?: CgiAbilityLeaf;
  mdTriggerRecord?: CgiAbilityLeaf;
  mdWithPir?: CgiAbilityLeaf;
  osd?: CgiAbilityLeaf;
  powerLed?: CgiAbilityLeaf;
  ptzCtrl?: CgiAbilityLeaf;
  ptzDirection?: CgiAbilityLeaf;
  ptzPatrol?: CgiAbilityLeaf;
  ptzPreset?: CgiAbilityLeaf;
  ptzTattern?: CgiAbilityLeaf;
  ptzType?: CgiAbilityLeaf;
  recCfg?: CgiAbilityLeaf;
  recDownload?: CgiAbilityLeaf;
  recReplay?: CgiAbilityLeaf;
  recSchedule?: CgiAbilityLeaf;
  shelterCfg?: CgiAbilityLeaf;
  snap?: CgiAbilityLeaf;
  supportAIDenoise?: CgiAbilityLeaf;
  supportAITrackLimit?: CgiAbilityLeaf;
  supportAITrackSchedule?: CgiAbilityLeaf;
  supportAfAlgorithmSwitch?: CgiAbilityLeaf;
  supportAi?: CgiAbilityLeaf;
  supportAiAnimal?: CgiAbilityLeaf;
  supportAiDetectConfig?: CgiAbilityLeaf;
  supportAiDogCat?: CgiAbilityLeaf;
  supportAiFace?: CgiAbilityLeaf;
  supportAiPackage?: CgiAbilityLeaf;
  supportAiPeople?: CgiAbilityLeaf;
  supportAiSensitivity?: CgiAbilityLeaf;
  supportAiStayTime?: CgiAbilityLeaf;
  supportAiTargetSize?: CgiAbilityLeaf;
  supportAiTrackClassify?: CgiAbilityLeaf;
  supportAiVehicle?: CgiAbilityLeaf;
  supportAllColors?: CgiAbilityLeaf;
  supportAoAdjust?: CgiAbilityLeaf;
  supportAudioAlarm?: CgiAbilityLeaf;
  supportAudioFileList?: CgiAbilityLeaf;
  supportAutoPt?: CgiAbilityLeaf;
  supportAutoReply?: CgiAbilityLeaf;
  supportAutoTrackStream?: CgiAbilityLeaf;
  supportBinoStitch?: CgiAbilityLeaf;
  supportDigitalZoom?: CgiAbilityLeaf;
  supportDingDongCtrl?: CgiAbilityLeaf;
  supportDoorbellLight?: CgiAbilityLeaf;
  supportDoorbellLightKeepOff?: CgiAbilityLeaf;
  supportEncoderSelect?: CgiAbilityLeaf;
  supportFLBrightness?: CgiAbilityLeaf;
  supportFLIntelligent?: CgiAbilityLeaf;
  supportFLKeepOn?: CgiAbilityLeaf;
  supportFLSchedule?: CgiAbilityLeaf;
  supportFLswitch?: CgiAbilityLeaf;
  supportFishEyeCfg?: CgiAbilityLeaf;
  supportFocus?: CgiAbilityLeaf;
  supportGop?: CgiAbilityLeaf;
  supportGuardPointImage?: CgiAbilityLeaf;
  supportImportExportImage?: CgiAbilityLeaf;
  supportIspBinningModeCfg?: CgiAbilityLeaf;
  supportLightAutoBrightness?: CgiAbilityLeaf;
  supportMd?: CgiAbilityLeaf;
  supportPt?: CgiAbilityLeaf;
  supportPtz3DLocation?: CgiAbilityLeaf;
  supportPtzCalibration?: CgiAbilityLeaf;
  supportPtzPresetImage?: CgiAbilityLeaf;
  supportPtzSpeed?: CgiAbilityLeaf;
  supportQuickReplyPlay?: CgiAbilityLeaf;
  supportThresholdAdjust?: CgiAbilityLeaf;
  supportVisitorLoudspeaker?: CgiAbilityLeaf;
  supportWLLightAlarm?: CgiAbilityLeaf;
  supportWebhook?: CgiAbilityLeaf;
  supportWhiteDark?: CgiAbilityLeaf;
  supportWiFi?: CgiAbilityLeaf;
  supportWiFiSdb?: CgiAbilityLeaf;
  supportZoom?: CgiAbilityLeaf;
  supportZoomAndFocusSliderCfg?: CgiAbilityLeaf;
  talk?: CgiAbilityLeaf;
  videoClip?: CgiAbilityLeaf;
  waterMark?: CgiAbilityLeaf;
  white_balance?: CgiAbilityLeaf;

  [key: string]: CgiAbilityLeaf | undefined;
};

export type CgiAbility = {
  Ability: ({ abilityChn?: CgiAbilityChn[] } & Record<string, JsonValue>);
};

export type CgiGetAbilityValue = CgiAbility;

export type CgiGetAbilityResponse = ReolinkCmdResponseExt<CgiGetAbilityValue> & {
  cmd: "GetAbility";
};

export type CgiDevInfo = {
  B485?: number;
  IOInputNum?: number;
  IOOutputNum?: number;
  audioNum?: number;
  buildDay?: string;
  cfgVer?: string;
  channelNum?: number;
  detail?: string;
  diskNum?: number;
  exactType?: string;
  firmVer?: string;
  frameworkVer?: number;
  hardVer?: string;
  model?: string;
  name?: string;
  pakSuffix?: string;
  serial?: string;
  type?: string;
  wifi?: number;
};

export type CgiGetDevInfoValue = {
  DevInfo: CgiDevInfo;
};

export type CgiGetDevInfoResponse = ReolinkCmdResponseExt<CgiGetDevInfoValue> & {
  cmd: "GetDevInfo";
};

export type CgiOsd = {
  channel: number;
  osdChannel?: number;
  osdTime?: number;
} & Record<string, JsonValue>;

export type CgiGetOsdValue = {
  Osd?: CgiOsd;
} & Record<string, JsonValue>;

export type CgiSetOsdParam = {
  Osd: {
    channel: number;
    osdChannel?: number;
    osdTime?: number;
  };
};

export type CgiWhiteLed = {
  channel: number;
  state?: number;
  bright?: number;
} & Record<string, JsonValue>;

export type CgiSetWhiteLedParam = {
  WhiteLed: CgiWhiteLed;
};

export type CgiPirInfo = {
  channel: number;
  enable: number;
} & Record<string, JsonValue>;

export type CgiSetPirInfoParam = {
  pirInfo: CgiPirInfo;
};

export type CgiPtzPreset = {
  enable?: number;
} & Record<string, JsonValue>;

export type CgiAudioAlarmPlayParam =
  | ({ channel: number } & { alarm_mode: "times"; times: number })
  | ({ channel: number } & { alarm_mode: "manul"; manual_switch: number });

export type CgiNetPort = Record<string, JsonValue>;

export type CgiBattery = {
  batteryPercent?: number;
} & Record<string, JsonValue>;

export type CgiDeviceInfoEntries = [
  CgiGetChnTypeInfoResponse | undefined,
  CgiGetAiStateResponse | undefined,
  CgiGetEncResponse | undefined,
];

export type DeviceInputData = {
  hasBattery: boolean;
  hasPirEvents: boolean;
  hasFloodlight: boolean;
  hasPtz: boolean;
  sleeping: boolean;
};

export type EventsResponse = {
  motion: boolean;
  objects: string[];
  entries: Array<ReolinkCmdResponseExt<JsonValue> | undefined>;
};

export type DeviceInfoResponse = {
  channelStatus?: CgiChannelStatusEntry;
  abilities?: CgiAbilityChn;
  ai?: CgiAiStateValue;
  channelInfo?: CgiChnTypeInfoValue;
  enc?: CgiEncValue;
  entries: CgiDeviceInfoEntries;
};

export type BatteryInfoResponse = {
  batteryLevel: number;
  sleeping: boolean;
  entries: [CgiBattery | undefined, CgiChannelStatusEntry | undefined];
};

export type DeviceStatusResponse = {
  floodlightEnabled?: boolean;
  pirEnabled?: boolean;
  ptzPresets?: CgiPtzPreset[];
  osd?: ReolinkCmdResponseExt<CgiGetOsdValue>;
  entries: Array<ReolinkCmdResponseExt<JsonValue>>;
};

// VOD (Video On Demand) types for hub/NVR recordings
export type VodSearchStatus = {
  year: number;
  mon: number;
  /** Bitmap string indicating which days of the month have recordings (e.g., "1111111100000000000000000000000") */
  table?: string;
  /** Legacy field - may not be present */
  day?: number;
  /** Legacy field - may not be present */
  month?: number;
};

export type VodFile = {
  type: string;
  StartTime: {
    year: number;
    mon: number;
    day: number;
    hour: number;
    min: number;
    sec: number;
  };
  EndTime: {
    year: number;
    mon: number;
    day: number;
    hour: number;
    min: number;
    sec: number;
  };
  PlaybackTime: {
    year: number;
    mon: number;
    day: number;
    hour: number;
    min: number;
    sec: number;
  };
  name: string;
  size: number;
};

export type VodSearchResult = {
  SearchResult?: {
    Status?: VodSearchStatus[];
    File?: VodFile[];
  };
};

export type VodSearchResponse = ReolinkCmdResponseExt<VodSearchResult> & {
  cmd: "Search";
};

type RecordingsCacheKey = string;

type RecordingsCacheEntry = {
  data: Array<EnrichedRecordingFile>;
  expiresAt: number;
};

/**
 * Parameters for listing enriched recordings from NVR/Hub.
 */
export interface ListNvrRecordingsParams {
  /** Channel number (0-based) */
  channel: number;
  /** Start date/time for search */
  start: Date;
  /** End date/time for search */
  end: Date;
  /** Stream type: "main" (default), "sub", "autotrack_main", "autotrack_sub", "telephoto_main", "telephoto_sub" */
  streamType?: string;
  /** For multifocal cameras: logical channel (0 or 1) */
  iLogicChannel?: number;
  /** If true, automatically search day-by-day when Status table is available (default: false) */
  autoSearchByDay?: boolean;
  /** If true, bypass cache and fetch fresh data (default: false) */
  bypassCache?: boolean;
  /**
   * If true, fetch streaming URLs for each recording.
   * This adds latency as it requires additional API calls.
   * Default: false.
   */
  fetchStreamUrls?: boolean;
  /** Stream URL type (only when fetchStreamUrls=true): "FLV" (default), "RTMP", "Playback" */
  streamUrlType?: "FLV" | "RTMP" | "Playback";
}

/**
 * Options for collecting NVR diagnostics.
 */
export interface CollectNvrDiagnosticsOptions {
  /** Logger for progress messages */
  logger: Logger;
}

/**
 * Parameters for getting VOD URL for playback, download, or streaming.
 */
export interface GetVodUrlParams {
  /** Request type: "Playback" (default), "Download", "FLV", "RTMP", "NVR_DOWNLOAD" */
  requestType?: "Playback" | "Download" | "FLV" | "RTMP" | "NVR_DOWNLOAD";
  /** Stream type for FLV/RTMP: "main" (default), "sub" */
  streamType?: string;
  /** Video stream type (alias for streamType, used when preparing from VodFile) */
  videoStreamType?: string;
  /** Start time string for Playback/Download */
  startTime?: string;
  /** Start time as JavaScript Date (for NVR preparation, will be converted to Reolink format) */
  startTimeObj?: Date;
  /** End time as JavaScript Date (for NVR preparation, will be converted to Reolink format) */
  endTimeObj?: Date;
  /** If true, automatically prepare file for NVR/Hub when VodFile is provided (default: true for Playback) */
  prepare?: boolean;
  /** Seek position in seconds (for FLV) */
  seek?: number;
}

export class ReolinkCgiApi {
  readonly client: ReolinkHttpClient;
  private logger: Logger = console;
  private debugConfig: DebugConfig = {
    general: false,
    debugRtsp: false,
    traceStream: false,
    traceRecordings: false,
    traceEvents: false,
    traceTalk: false,
    debugH264: false,
    debugParamSets: false,
    dumpEnabled: false,
    dumpDir: "",
    dumpBcMedia: false,
    dumpNals: false
  };

  // Recordings cache: key -> { data, expiresAt }
  // Unified cache for both NVR and Device recordings (always enriched)
  private recordingsCache = new Map<RecordingsCacheKey, RecordingsCacheEntry>();

  // Default cache TTL: 5 minutes
  private recordingsCacheTtlMs = 5 * 60 * 1000;

  constructor(opts: ReolinkHttpClientOptions & { logger?: Logger; debugConfig?: DebugConfig }) {
    this.client = new ReolinkHttpClient(opts);
    if (opts.logger) {
      this.logger = opts.logger;
    }
    if (opts.debugConfig) {
      this.debugConfig = opts.debugConfig;
    }
  }

  /**
   * Set logger for debug output
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Set debug config for trace logging
   */
  setDebugConfig(debugConfig: DebugConfig): void {
    this.debugConfig = debugConfig;
  }

  /**
   * Set recordings cache TTL (time to live) in milliseconds.
   * Default: 5 minutes (300000 ms)
   */
  setRecordingsCacheTtl(ttlMs: number): void {
    this.recordingsCacheTtlMs = Math.max(0, ttlMs);
  }

  /**
   * Clear all recordings cache entries.
   */
  clearRecordingsCache(): void {
    this.recordingsCache.clear();
  }

  /**
   * Get recordings cache statistics.
   */
  getRecordingsCacheStats(): {
    size: number;
    ttlMs: number;
    entries: Array<{ key: string; expiresAt: number; expired: boolean }>;
  } {
    const now = Date.now();
    const entries: Array<{ key: string; expiresAt: number; expired: boolean }> = [];
    for (const [key, entry] of this.recordingsCache.entries()) {
      entries.push({
        key,
        expiresAt: entry.expiresAt,
        expired: entry.expiresAt < now,
      });
    }
    return {
      size: this.recordingsCache.size,
      ttlMs: this.recordingsCacheTtlMs,
      entries,
    };
  }

  /**
   * Clear expired recordings cache entries.
   */
  private cleanRecordingsCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.recordingsCache.entries()) {
      if (entry.expiresAt < now) {
        this.recordingsCache.delete(key);
      }
    }
  }

  /**
   * Generate cache key for NVR recordings search.
   */
  private getNvrRecordingsCacheKey(
    channel: number,
    startTime: { year: number; mon: number; day: number; hour: number; min: number; sec: number },
    endTime: { year: number; mon: number; day: number; hour: number; min: number; sec: number },
    streamType: string,
    iLogicChannel: number,
    autoSearchByDay: boolean
  ): RecordingsCacheKey {
    return `nvr:${channel}:${startTime.year}-${startTime.mon}-${startTime.day}-${startTime.hour}-${startTime.min}-${startTime.sec}:${endTime.year}-${endTime.mon}-${endTime.day}-${endTime.hour}-${endTime.min}-${endTime.sec}:${streamType}:${iLogicChannel}:${autoSearchByDay ? 1 : 0}`;
  }

  async login(): Promise<void> {
    await this.client.login();
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  async call<TValue = JsonValue, TParam = JsonValue>(cmd: string, param?: TParam, action = 0): Promise<ReolinkCmdResponse<TValue>[]> {
    // Avoid `param: undefined` with exactOptionalPropertyTypes
    if (param === undefined) return await this.client.call<TValue, TParam>(cmd, { action });
    return await this.client.call<TValue, TParam>(cmd, { action, param });
  }

  async callMany<TValue = JsonValue>(cmds: ReolinkCmdRequest[]): Promise<ReolinkCmdResponse<TValue>[]> {
    return await this.client.callMany<TValue>(cmds);
  }

  private static findFirstRtspUrl(v: unknown, depth = 0): string | undefined {
    if (depth > 6) return undefined;
    if (typeof v === "string") {
      const s = v.trim();
      return s.startsWith("rtsp://") ? s : undefined;
    }
    if (!v || typeof v !== "object") return undefined;
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = ReolinkCgiApi.findFirstRtspUrl(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }

    const obj = v as Record<string, unknown>;
    const directKeys = ["rtspUrl", "RtspUrl", "rtsp", "url"];
    for (const k of directKeys) {
      const found = ReolinkCgiApi.findFirstRtspUrl(obj[k], depth + 1);
      if (found) return found;
    }
    for (const k of Object.keys(obj)) {
      const found = ReolinkCgiApi.findFirstRtspUrl(obj[k], depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  // Common wrappers
  async GetDevInfo(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiGetDevInfoValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetDevInfo", param);
  }

  /**
   * CGI equivalent of Baichuan `getInfo()`.
   *
   * Uses `GetDevInfo` and returns a minimal normalized map compatible with the Baichuan helper:
   * - type
   * - hardwareVersion
   * - firmwareVersion
   * - itemNo
   * - serialNumber
   * - name
   */
  async getInfo(
    channel?: number,
    options?: {
      /** List of normalized fields to return. Defaults to the canonical minimal set used by Baichuan getInfo(). */
      tags?: ReolinkDeviceInfoTag[];
    },
  ): Promise<Partial<ReolinkDeviceInfo>> {
    const rsp = await this.GetDevInfo(channel);
    const devInfo = (rsp as any)?.[0]?.value?.DevInfo as CgiDevInfo | undefined;

    const normalized: Partial<ReolinkDeviceInfo> = {};
    const type = (devInfo?.type ?? devInfo?.model ?? devInfo?.exactType) as string | undefined;
    const itemNo = (devInfo?.exactType ?? devInfo?.model ?? devInfo?.detail) as string | undefined;
    if (typeof type === "string") normalized.type = type;
    if (typeof devInfo?.hardVer === "string") normalized.hardwareVersion = devInfo.hardVer;
    if (typeof devInfo?.firmVer === "string") normalized.firmwareVersion = devInfo.firmVer;
    if (typeof itemNo === "string") normalized.itemNo = itemNo;
    if (typeof devInfo?.serial === "string") normalized.serialNumber = devInfo.serial;
    if (typeof devInfo?.name === "string") normalized.name = devInfo.name;

    const tags: ReolinkDeviceInfoTag[] = options?.tags?.length
      ? options.tags
      : (["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"] satisfies ReolinkDeviceInfoTag[]);

    const out: Partial<ReolinkDeviceInfo> = {};
    for (const t of tags) {
      const v = normalized[t];
      if (typeof v === "string") out[t] = v;
    }
    return out;
  }

  async GetChnTypeInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetChnTypeInfo", param);
  }

  async GetChannelstatus(): Promise<Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>> {
    return await this.call("GetChannelstatus", undefined, 0);
  }

  async GetLocalLink(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetLocalLink", param);
  }

  async GetWifiSignal(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetWifiSignal", param);
  }

  async GetOsd(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiGetOsdValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetOsd", param, 1);
  }

  async SetOsd(osd: CgiSetOsdParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetOsd", osd, 0);
  }

  async GetEnc(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiEncValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetEnc", param, 1);
  }

  /**
   * Return an RTSP URL for the given channel (NVR-side).
   * Uses the exact request body shape:
   * `[{"cmd":"GetRtspUrl","action":0,"param":{"channel":<channel>}}]`.
   */
  async GetRtspUrl(channel: number): Promise<Array<CgiGetRtspUrlResponse>> {
    const body: ReolinkCmdRequest[] = [{ cmd: "GetRtspUrl", action: 0, param: { channel } }];
    return (await this.callMany(body)) as Array<CgiGetRtspUrlResponse>;
  }

  /** Convenience helper: extracts the first `rtsp://...` from GetRtspUrl response. */
  async getRtspUrl(channel: number): Promise<string> {
    const rsp = await this.GetRtspUrl(channel);
    const value = rsp?.[0]?.value;
    const url = ReolinkCgiApi.findFirstRtspUrl(value);
    if (!url) {
      throw new Error(`GetRtspUrl: RTSP URL not found in response (channel=${channel})`);
    }
    return url;
  }

  async GetAiState(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiAiStateValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetAiState", param, 0);
  }

  async GetMdState(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetMdState", param, 0);
  }

  async GetEvents(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetEvents", param, 0);
  }

  async GetBatteryInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetBatteryInfo", param, 0);
  }

  async GetWhiteLed(channel?: number): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetWhiteLed", param, 0);
  }

  async SetWhiteLed(whiteLed: CgiSetWhiteLedParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetWhiteLed", whiteLed, 0);
  }

  async GetPirInfo(channel?: number): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetPirInfo", param, 0);
  }

  async SetPirInfo(pirInfo: CgiSetPirInfoParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetPirInfo", pirInfo, 0);
  }

  async GetPtzPreset(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetPtzPreset", param, 1);
  }

  async GetAudioAlarmV20(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetAudioAlarmV20", param, 0);
  }

  async AudioAlarmPlay(params: CgiAudioAlarmPlayParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("AudioAlarmPlay", params, 0);
  }

  async GetNetPort(): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("GetNetPort", {});
  }

  async SetNetPort(netPort: CgiNetPort): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetNetPort", { NetPort: netPort });
  }

  async Reboot(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("Reboot", param);
  }

  async GetAbility(): Promise<Array<ReolinkCmdResponseExt<CgiAbility>>> {
    const username = this.client.getUsername();
    return await this.call("GetAbility", {
      User: {
        userName: username,
      },
    });
  }

  // --------------------
  // High-level helpers (batch-oriented)
  // --------------------

  /** Returns the list of channels that have a non-empty UID (typically the connected cameras on NVR/Home Hub). */
  async getChannels(options?: { useChannelNumFallback?: boolean }): Promise<{ channels: number[]; channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>> }> {
    const channelsResponse = await this.GetChannelstatus();
    const status = channelsResponse?.[0]?.value?.status;
    let channels = (status ?? [])
      .filter((s) => !!s?.uid)
      .map((s) => Number(s?.channel))
      .filter((n) => Number.isFinite(n));

    // Fallback for multi-focal cameras: if no channels found and fallback is enabled, use channelNum from GetDevInfo
    if (channels.length === 0 && options?.useChannelNumFallback) {
      try {
        const devInfoRsp = await this.GetDevInfo();
        const devInfo = (devInfoRsp as any)?.[0]?.value?.DevInfo as CgiDevInfo | undefined;
        const channelNum = devInfo?.channelNum;
        if (channelNum != null && channelNum > 0) {
          channels = Array.from({ length: channelNum }, (_, i) => i);
        }
      } catch (error) {
        // Ignore errors when trying to get channelNum fallback
      }
    }

    return { channels, channelsResponse };
  }

  async getNvrInfo(): Promise<{ abilities: CgiAbility | undefined; nvrData: CgiGetDevInfoValue | undefined; devInfo: CgiDevInfo | undefined; response: Array<ReolinkCmdResponseExt<JsonValue>> }> {
    const username = this.client.getUsername();
    const body: ReolinkCmdRequest[] = [
      { cmd: "GetAbility", action: 0, param: { User: { userName: username } } },
      { cmd: "GetDevInfo", action: 0, param: {} },
    ];

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;
    const abilities = response.find((item: any) => item?.cmd === "GetAbility")?.value as CgiAbility | undefined;
    const nvrData = response.find((item: any) => item?.cmd === "GetDevInfo")?.value as CgiGetDevInfoValue | undefined;
    const devInfo = nvrData?.DevInfo;

    return { abilities, nvrData, devInfo, response };
  }

  async getDevicesInfo(options?: { useChannelNumFallback?: boolean }): Promise<{
    devicesData: Record<number, DeviceInfoResponse>;
    response: Array<ReolinkCmdResponseExt<JsonValue>>;
    channels: number[];
    channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>;
    requestBody: ReolinkCmdRequest[];
  }> {
    const { channels, channelsResponse } = await this.getChannels(options);

    const username = this.client.getUsername();

    const body: ReolinkCmdRequest[] = [];

    body.push({ cmd: "GetAbility", action: 0, param: { User: { userName: username } } });

    for (const channel of channels) {
      body.push(
        { cmd: "GetChnTypeInfo", action: 0, param: { channel } },
        { cmd: "GetAiState", action: 0, param: { channel } },
        { cmd: "GetEnc", action: 1, param: { channel } },
      );
    }

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;

    const abilities = (response[0] as CgiGetAbilityResponse | undefined)?.value;
    const abilitiesChn = abilities?.Ability?.abilityChn;

    const ret: Record<number, DeviceInfoResponse> = {};
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i]!;
      const base = 1 + i * 3;
      const chnInfoItem = response[base] as CgiGetChnTypeInfoResponse | undefined;
      const aiItem = response[base + 1] as CgiGetAiStateResponse | undefined;
      const encItem = response[base + 2] as CgiGetEncResponse | undefined;

      const channelStatus = channelsResponse?.[0]?.value?.status?.find((item) => item?.channel === channel);

      const device: DeviceInfoResponse = {
        entries: [chnInfoItem, aiItem, encItem],
      };
      if (channelStatus) device.channelStatus = channelStatus;
      const perChannelAbilities = abilitiesChn?.[channel];
      if (perChannelAbilities) device.abilities = perChannelAbilities;

      if (!(chnInfoItem as any)?.error) device.channelInfo = (chnInfoItem as any)?.value as CgiChnTypeInfoValue;
      if (!(aiItem as any)?.error) device.ai = (aiItem as any)?.value as CgiAiStateValue;
      if (!(encItem as any)?.error) device.enc = (encItem as any)?.value as CgiEncValue;

      ret[channel] = device;
    }

    return { devicesData: ret, response, channels, channelsResponse, requestBody: body };
  }

  async getAllChannelsEvents(options?: { useChannelNumFallback?: boolean }): Promise<{
    parsed: Record<number, EventsResponse>;
    response: ReolinkCmdResponse[];
    channels: number[];
    channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>;
    requestBody: ReolinkCmdRequest[];
  }> {
    const { channels, channelsResponse } = await this.getChannels(options);

    // Always call all relevant endpoints per channel and merge.
    const body: ReolinkCmdRequest[] = [];
    const index: Record<number, { events?: number; motion?: number; ai?: number }> = {};

    for (const channel of channels) {
      index[channel] = {};
      body.push({ cmd: "GetEvents", action: 0, param: { channel } });
      index[channel].events = body.length - 1;
      body.push({ cmd: "GetMdState", action: 0, param: { channel } });
      index[channel].motion = body.length - 1;
      body.push({ cmd: "GetAiState", action: 0, param: { channel } });
      index[channel].ai = body.length - 1;
    }

    const response = await this.callMany(body);

    const processDetections = (aiResponse: any): string[] => {
      const classes: string[] = [];
      for (const key of Object.keys(aiResponse ?? {})) {
        if (key === "channel") continue;
        const alarmState = aiResponse?.[key]?.alarm_state;
        if (alarmState) classes.push(key);
      }
      return classes;
    };

    const parsed: Record<number, EventsResponse> = {};
    for (const channel of channels) {
      const { events, motion, ai } = index[channel] ?? {};
      const eventsEntry = events != null ? response[events] : undefined;
      const motionEntry = motion != null ? response[motion] : undefined;
      const aiEntry = ai != null ? response[ai] : undefined;

      const classes = new Set<string>();
      for (const c of processDetections((aiEntry as any)?.value)) classes.add(c);
      for (const c of processDetections((eventsEntry as any)?.value?.ai ?? (eventsEntry as any)?.value)) classes.add(c);

      const list = Array.from(classes);
      const objects = list.filter((cl) => cl !== "other");
      const hasMotion = !!(motionEntry as any)?.value?.state || list.length > 0;

      parsed[channel] = {
        motion: hasMotion,
        objects,
        entries: [eventsEntry as any, motionEntry as any, aiEntry as any],
      };
    }

    return { parsed, response, channels, channelsResponse, requestBody: body };
  }

  async getAllChannelsBatteryInfo(options?: { useChannelNumFallback?: boolean }): Promise<{
    batteryInfoData: Record<number, BatteryInfoResponse>;
    response: Array<ReolinkCmdResponseExt<JsonValue>>;
    channels: number[];
    channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>;
    requestBody: ReolinkCmdRequest[];
  }> {
    const { channels, channelsResponse } = await this.getChannels(options);

    // Always call battery info for every channel and merge with Channelstatus.
    const body: ReolinkCmdRequest[] = [{ cmd: "GetChannelstatus" }];
    const index: Record<number, number> = {};
    for (const channel of channels) {
      body.push({ cmd: "GetBatteryInfo", action: 0, param: { channel } });
      index[channel] = body.length - 1;
    }

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;
    const channelStatusData = response[0];

    const batteryInfoData: Record<number, BatteryInfoResponse> = {};
    for (const channel of channels) {
      const batteryInfoEntry = ((response[index[channel]!] as any)?.value?.Battery ?? undefined) as CgiBattery | undefined;
      const channelStatusEntry = (channelStatusData as any)?.value?.status?.find((elem: any) => elem?.channel === channel) as CgiChannelStatusEntry | undefined;
      batteryInfoData[channel] = {
        entries: [batteryInfoEntry, channelStatusEntry],
        batteryLevel: Number(batteryInfoEntry?.batteryPercent ?? 0),
        sleeping: channelStatusEntry?.sleep === 1,
      };
    }

    return { batteryInfoData, response, channels, channelsResponse, requestBody: body };
  }

  async getStatusInfo(channelsMap: Map<number, DeviceInputData>): Promise<{
    deviceStatusData: Record<number, DeviceStatusResponse>;
    response: Array<ReolinkCmdResponseExt<JsonValue>>;
  }> {
    const body: ReolinkCmdRequest[] = [];
    const index: Record<number, { osd?: number; floodlight?: number; pir?: number; presets?: number }> = {};

    for (const [channel, info] of channelsMap.entries()) {
      index[channel] = {};
      if (info.sleeping) continue;

      body.push({ cmd: "GetOsd", action: 1, param: { channel } });
      index[channel].osd = body.length - 1;

      if (info.hasFloodlight) {
        body.push({ cmd: "GetWhiteLed", action: 0, param: { channel } });
        index[channel].floodlight = body.length - 1;
      }

      if (info.hasPirEvents) {
        body.push({ cmd: "GetPirInfo", action: 0, param: { channel } });
        index[channel].pir = body.length - 1;
      }

      if (info.hasPtz) {
        body.push({ cmd: "GetPtzPreset", action: 1, param: { channel } });
        index[channel].presets = body.length - 1;
      }
    }

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;

    const deviceStatusData: Record<number, DeviceStatusResponse> = {};
    for (const [channel, info] of channelsMap.entries()) {
      const { osd, floodlight, pir, presets } = index[channel] ?? {};
      deviceStatusData[channel] = { entries: [] };

      if (osd != null) {
        const osdEntry = response[osd]!;
        deviceStatusData[channel].osd = osdEntry as ReolinkCmdResponseExt<CgiGetOsdValue>;
        deviceStatusData[channel].entries.push(osdEntry);
      }

      if (info.hasFloodlight && floodlight != null) {
        const floodlightEntry = response[floodlight]!;
        deviceStatusData[channel].floodlightEnabled = (floodlightEntry as any)?.value?.WhiteLed?.state === 1;
        deviceStatusData[channel].entries.push(floodlightEntry);
      }

      if (info.hasPirEvents && pir != null) {
        const pirEntry = response[pir]!;
        deviceStatusData[channel].pirEnabled = (pirEntry as any)?.value?.pirInfo?.enable === 1;
        deviceStatusData[channel].entries.push(pirEntry);
      }

      if (info.hasPtz && presets != null) {
        const ptzPresetsEntry = response[presets]!;
        const list = (ptzPresetsEntry as any)?.value?.PtzPreset;
        deviceStatusData[channel].ptzPresets = Array.isArray(list) ? (list.filter((p: any) => p?.enable === 1) as CgiPtzPreset[]) : [];
        deviceStatusData[channel].entries.push(ptzPresetsEntry);
      }
    }

    return { deviceStatusData, response };
  }

  /** Convenience wrapper returning raw OSD response for a channel. */
  async getOsd(channel: number): Promise<ReolinkCmdResponseExt<CgiGetOsdValue> | undefined> {
    const rsp = await this.GetOsd(channel);
    return rsp?.[0];
  }

  /** Set channel OSD. Accepts either a full `Osd` object or a minimal `{ Osd: ... }` payload. */
  async setOsd(channel: number, osd: any): Promise<void> {
    const valueOsd = osd?.value?.Osd ?? osd?.Osd;
    const osdChannel = valueOsd?.osdChannel ?? osd?.osdChannel;
    const osdTime = valueOsd?.osdTime ?? osd?.osdTime;

    const payload = {
      Osd: {
        channel,
        osdChannel,
        osdTime,
      },
    };

    await this.call("SetOsd", payload, 0);
  }

  async getEncoderConfiguration(channel: number): Promise<CgiEnc | undefined> {
    const rsp = await this.GetEnc(channel);
    return (rsp as any)?.[0]?.value?.Enc as CgiEnc | undefined;
  }

  /** CGI snapshot via `cmd=Snap` (binary JPEG). */
  async jpegSnapshot(
    channel: number,
    opts?: {
      timeoutMs?: number;
      snapType?: "main" | "sub";
      iLogicChannel?: number;
    },
  ): Promise<Buffer> {
    return await this.client.snap(channel, {
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.snapType !== undefined ? { snapType: opts.snapType } : {}),
      ...(opts?.iLogicChannel !== undefined ? { iLogicChannel: opts.iLogicChannel } : {}),
    });
  }

  async getSiren(channel: number): Promise<{ enabled: boolean }> {
    const rsp = await this.GetAudioAlarmV20(channel);
    return { enabled: (rsp as any)?.[0]?.value?.Audio?.enable === 1 };
  }

  async setSiren(channel: number, on: boolean, duration?: number): Promise<{ value: JsonValue | undefined; data: Array<ReolinkCmdResponseExt<JsonValue>> }> {
    const params: CgiAudioAlarmPlayParam = duration
      ? { channel, alarm_mode: "times", times: duration }
      : { channel, alarm_mode: "manul", manual_switch: on ? 1 : 0 };

    const rsp = await this.AudioAlarmPlay(params);
    return { value: (rsp as any)?.[0]?.value ?? (rsp as any)?.value, data: rsp };
  }

  async setWhiteLedState(channel: number, on?: boolean, brightness?: number): Promise<void> {
    const settings: any = { channel };
    if (on !== undefined) settings.state = on ? 1 : 0;
    if (brightness !== undefined) settings.bright = brightness;
    await this.SetWhiteLed({ WhiteLed: settings });
  }

  async getPirState(channel: number): Promise<{ enabled: boolean; state: CgiPirInfo | undefined }> {
    const rsp = await this.GetPirInfo(channel);
    const state = (rsp as any)?.[0]?.value?.pirInfo as CgiPirInfo | undefined;
    return { enabled: state?.enable === 1, state };
  }

  async setPirState(channel: number, on: boolean): Promise<void> {
    const current = await this.getPirState(channel);
    const newState = on ? 1 : 0;
    const currentEnable = (current?.state as any)?.enable;
    if (currentEnable === newState) return;

    const pirInfo = {
      ...(current?.state && typeof current.state === "object" ? current.state : {}),
      channel,
      enable: newState,
    };
    await this.SetPirInfo({ pirInfo });
  }

  async getLocalLink(channel: number): Promise<{ activeLink: string | undefined; wifiSignal: number | undefined; isWifi: boolean }> {
    const body: ReolinkCmdRequest[] = [
      { cmd: "GetLocalLink", action: 0, param: {} },
      { cmd: "GetWifiSignal", action: 0, param: { channel } },
    ];
    const rsp = await this.callMany(body);
    const activeLink = (rsp as any).find((e: any) => e?.cmd === "GetLocalLink")?.value?.LocalLink?.activeLink as string | undefined;
    const wifiSignal = (rsp as any).find((e: any) => e?.cmd === "GetWifiSignal")?.value?.wifiSignal as number | undefined;

    let isWifi = false;
    if (wifiSignal !== undefined) {
      isWifi = wifiSignal >= 0 && wifiSignal <= 4;
    }
    if (!isWifi && activeLink) {
      isWifi = activeLink !== "LAN";
    }

    return { activeLink, wifiSignal, isWifi };
  }

  /**
   * Comprehensive NVR/HUB diagnostics.
   * Collects and returns all available information about the NVR/HUB device and all its channels.
   * Automatically prints diagnostics after collection using the provided logger.
   * 
   * @param options - Configuration object with logger property for progress messages
   * @returns Complete diagnostics data including NVR info, channels, and per-channel details
   */
  async collectNvrDiagnostics(options: CollectNvrDiagnosticsOptions): Promise<Record<string, unknown>> {
    const diagnostics = await collectNvrDiagnostics({
      cgi: this,
      logger: options.logger,
    });
    return diagnostics;
  }

  // --------------------
  // VOD (Video On Demand) methods for hub/NVR
  // --------------------

  /**
   * List enriched recordings from NVR/Hub.
   * This command does NOT wake up battery cameras connected to the hub.
   * 
   * Always returns enriched recording files with parsed metadata, detection flags, and timestamps.
   * Note: For best results, use autoSearchByDay=true to automatically search day-by-day when Status table is available.
   * 
   * @param params - Search parameters
   * @returns Array of enriched recording files
   */
  async listNvrRecordings(params: ListNvrRecordingsParams): Promise<Array<EnrichedRecordingFile>> {
    const { channel, start, end } = params;
    const streamType = params.streamType ?? "main";
    const iLogicChannel = params.iLogicChannel ?? 0;
    const autoSearchByDay = params.autoSearchByDay ?? false;
    const bypassCache = params.bypassCache ?? false;

    // Convert Date to Reolink time format
    let startTime = this.dateToReolinkTime(start);
    let endTime = this.dateToReolinkTime(end);

    // Sanitize end date: if it's midnight (00:00:00) of the next day, cap it to 23:59:59 of the same day as start
    // This ensures we search until the end of the requested day, not the beginning of the next day
    if (endTime.hour === 0 && endTime.min === 0 && endTime.sec === 0) {
      // Check if end is on a different day than start
      const startDateKey = `${startTime.year}-${startTime.mon}-${startTime.day}`;
      const endDateKey = `${endTime.year}-${endTime.mon}-${endTime.day}`;

      if (endDateKey !== startDateKey) {
        // End is on the next day at midnight, so cap it to the end of start day (23:59:59)
        endTime = {
          year: startTime.year,
          mon: startTime.mon,
          day: startTime.day,
          hour: 23,
          min: 59,
          sec: 59,
        };
      }
    }

    // Log date conversion for debugging (using both general debug and recordings trace)
    // debugLog(this.debugConfig, this.logger, "listNvrRecordings", 
    //   `Date conversion: start=${start.toISOString()} (local: ${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}:${String(start.getSeconds()).padStart(2, '0')}) -> ReolinkTime=${JSON.stringify(startTime)}, ` +
    //   `end=${end.toISOString()} (local: ${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')} ${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}:${String(end.getSeconds()).padStart(2, '0')}) -> ReolinkTime=${JSON.stringify(endTime)}`
    // );
    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "listNvrRecordings",
      `Date conversion: start=${start.toISOString()} -> ReolinkTime=${JSON.stringify(startTime)}, end=${end.toISOString()} -> ReolinkTime=${JSON.stringify(endTime)}`
    );

    // Check cache first (unless bypassing)
    if (!bypassCache) {
      this.cleanRecordingsCache();
      const cacheKey = this.getNvrRecordingsCacheKey(channel, startTime, endTime, streamType, iLogicChannel, autoSearchByDay);
      const cached = this.recordingsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        recordingsTraceLog(
          this.debugConfig,
          this.logger,
          "listNvrRecordings",
          `Cache hit: returning ${cached.data.length} cached enriched recordings`
        );
        return cached.data;
      }
    }

    // If autoSearchByDay is enabled, first get status to find days with recordings
    if (autoSearchByDay) {
      const startMs = start.getTime();
      const endMs = end.getTime();

      const clampDateToWindow = (d: Date): Date => {
        const t = d.getTime();
        if (!Number.isFinite(t)) return d;
        if (t < startMs) return new Date(startMs);
        if (t > endMs) return new Date(endMs);
        return d;
      };

      const statusParam: any = {
        Search: {
          channel,
          onlyStatus: 1,
          streamType,
          StartTime: startTime,
          EndTime: endTime,
        },
      };
      if (iLogicChannel > 0) {
        statusParam.Search.iLogicChannel = iLogicChannel;
      }

      const statusResponse = await this.call<VodSearchResult>("Search", statusParam, 0);
      const allResults: Array<VodSearchResponse> = [];

      // Parse Status table to find days with recordings
      for (const statusResult of statusResponse) {
        if (statusResult.code === 0 && statusResult.value?.SearchResult?.Status) {
          for (const status of statusResult.value.SearchResult.Status) {
            if (status.table) {
              // Find days with recordings from bitmap
              const daysWithRecordings: number[] = [];
              for (let i = 0; i < status.table.length; i++) {
                if (status.table[i] === "1") {
                  daysWithRecordings.push(i + 1); // Days are 1-indexed
                }
              }

              // Search each day individually
              for (const day of daysWithRecordings) {
                const year = status.year;
                const month = status.mon || status.month || 1;

                // IMPORTANT: Status table is typically per-month, and may include days outside the
                // requested window. Restrict queries to days that overlap [start,end], and clamp
                // the per-day query range to the window.
                const dayStartDate = new Date(year, month - 1, day, 0, 0, 0, 0);
                const dayEndDate = new Date(year, month - 1, day, 23, 59, 59, 999);

                // Skip days completely outside the requested window.
                if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
                  if (dayEndDate.getTime() < startMs || dayStartDate.getTime() > endMs) continue;
                }

                const queryStartDate = clampDateToWindow(dayStartDate.getTime() < startMs ? new Date(startMs) : dayStartDate);
                const queryEndDate = clampDateToWindow(dayEndDate.getTime() > endMs ? new Date(endMs) : dayEndDate);
                if (queryStartDate.getTime() > queryEndDate.getTime()) continue;

                const dayStart = this.dateToReolinkTime(queryStartDate);
                const dayEnd = this.dateToReolinkTime(queryEndDate);

                const dayParam: any = {
                  Search: {
                    channel,
                    onlyStatus: 0,
                    streamType,
                    StartTime: dayStart,
                    EndTime: dayEnd,
                  },
                };
                if (iLogicChannel > 0) {
                  dayParam.Search.iLogicChannel = iLogicChannel;
                }

                const dayResponse = await this.call<VodSearchResult>("Search", dayParam, 0);
                // Log raw API response for debugging
                if (dayResponse && dayResponse.length > 0) {
                  const firstResult = dayResponse[0];
                  if (firstResult && firstResult.code === 0 && firstResult.value?.SearchResult?.File) {
                    const files = firstResult.value.SearchResult.File;
                    if (files.length > 0 && files[0]) {
                      recordingsTraceLog(
                        this.debugConfig,
                        this.logger,
                        "listNvrRecordings",
                        `Raw API response for day ${day}/${month}/${year}: ${JSON.stringify({
                          fileCount: files.length,
                          sampleFile: {
                            name: files[0].name,
                            type: files[0].type,
                            size: files[0].size,
                            StartTime: files[0].StartTime,
                            EndTime: files[0].EndTime,
                          },
                        })}`
                      );
                    }
                  }
                }
                allResults.push(...(dayResponse as Array<VodSearchResponse>));
              }
            }
          }
        }
      }

      if (allResults.length > 0) {
        // Collect all files from search results and enrich them
        const allFiles: VodFile[] = [];
        for (const res of allResults) {
          if (res.code === 0) {
            const searchResult = res.value?.SearchResult;
            if (searchResult?.File) {
              allFiles.push(...searchResult.File);
            }
          }
        }

        // Enrich all files
        const enriched: EnrichedRecordingFile[] = [];
        const fetchStreamUrls = params.fetchStreamUrls === true;
        const streamUrlType = params.streamUrlType ?? "FLV";

        for (const vodFile of allFiles) {
          let streamUrl: string | undefined;

          // Optionally fetch streaming URL
          if (fetchStreamUrls) {
            try {
              const url = await this.getVodUrl(vodFile, channel, {
                requestType: streamUrlType,
                videoStreamType: streamType,
                prepare: true,
              });
              streamUrl = url;
            } catch (e) {
              // Silently ignore - not all recordings may have streaming URLs available
            }
          }

          enriched.push(this.enrichVodFile(vodFile, channel, streamUrl));
        }

        recordingsTraceLog(
          this.debugConfig,
          this.logger,
          "listNvrRecordings",
          `Returning ${enriched.length} enriched recording files from autoSearchByDay`
        );

        // Cache enriched results
        if (!bypassCache) {
          const cacheKey = this.getNvrRecordingsCacheKey(channel, startTime, endTime, streamType, iLogicChannel, autoSearchByDay);
          this.recordingsCache.set(cacheKey, {
            data: enriched,
            expiresAt: Date.now() + this.recordingsCacheTtlMs,
          });
        }

        return enriched;
      }
      // Fall through to normal search if no status found
    }

    // Normal search: if range spans multiple days, split into day-by-day queries
    const allResults: Array<VodSearchResponse> = [];
    const dayRanges = this.generateDayRanges(startTime, endTime);

    if (dayRanges.length === 0) {
      // No valid range, return empty
      return [];
    }

    if (dayRanges.length === 1) {
      // Single day range, use original start/end times
      const range = dayRanges[0];
      if (!range) {
        return [];
      }
      const param: any = {
        Search: {
          channel,
          onlyStatus: 0,
          streamType,
          StartTime: range.start,
          EndTime: range.end,
        },
      };

      if (iLogicChannel > 0) {
        param.Search.iLogicChannel = iLogicChannel;
      }

      const response = await this.call<VodSearchResult>("Search", param, 0);
      allResults.push(...(response as Array<VodSearchResponse>));
    } else {
      // Multiple days: query each day separately
      recordingsTraceLog(
        this.debugConfig,
        this.logger,
        "listNvrRecordings",
        `Range spans ${dayRanges.length} days, splitting into separate day queries`
      );

      for (const range of dayRanges) {
        const param: any = {
          Search: {
            channel,
            onlyStatus: 0,
            streamType,
            StartTime: range.start,
            EndTime: range.end,
          },
        };

        if (iLogicChannel > 0) {
          param.Search.iLogicChannel = iLogicChannel;
        }

        recordingsTraceLog(
          this.debugConfig,
          this.logger,
          "listNvrRecordings",
          `Querying day: ${range.start.year}-${range.start.mon}-${range.start.day} (${range.start.hour}:${range.start.min}:${range.start.sec} to ${range.end.hour}:${range.end.min}:${range.end.sec})`
        );

        const response = await this.call<VodSearchResult>("Search", param, 0);
        allResults.push(...(response as Array<VodSearchResponse>));
      }
    }

    const result = allResults;

    // Log raw API response for debugging
    if (result && result.length > 0) {
      const firstResult = result[0];
      if (firstResult && firstResult.code === 0 && firstResult.value?.SearchResult?.File) {
        const files = firstResult.value.SearchResult.File;
        if (files.length > 0 && files[0]) {
          recordingsTraceLog(
            this.debugConfig,
            this.logger,
            "listNvrRecordings",
            `Raw API response (normal search): ${JSON.stringify({
              fileCount: files.length,
              sampleFile: {
                name: files[0].name,
                type: files[0].type,
                size: files[0].size,
                StartTime: files[0].StartTime,
                EndTime: files[0].EndTime,
              },
            })}`
          );
        }
      }
    }

    // Collect all files from search results
    const allFiles: VodFile[] = [];
    for (const res of result) {
      if (res.code === 0) {
        const searchResult = res.value?.SearchResult;
        if (searchResult?.File) {
          allFiles.push(...searchResult.File);
        }
      }
    }

    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "listNvrRecordings",
      `Collected ${allFiles.length} raw VodFiles from API search results`
    );
    if (allFiles.length > 0) {
      // Log first few files as sample
      const sampleSize = Math.min(3, allFiles.length);
      for (let i = 0; i < sampleSize; i++) {
        const file = allFiles[i];
        if (file) {
          recordingsTraceLog(
            this.debugConfig,
            this.logger,
            "listNvrRecordings",
            `Sample file ${i + 1}/${allFiles.length}: ${JSON.stringify({
              name: file.name,
              type: file.type,
              size: file.size,
              StartTime: file.StartTime,
              EndTime: file.EndTime,
            })}`
          );
        }
      }
    }

    // Enrich each file
    const enriched: EnrichedRecordingFile[] = [];
    const fetchStreamUrls = params.fetchStreamUrls === true;
    const streamUrlType = params.streamUrlType ?? "FLV";

    for (const vodFile of allFiles) {
      let streamUrl: string | undefined;

      // Optionally fetch streaming URL
      if (fetchStreamUrls) {
        try {
          const url = await this.getVodUrl(vodFile, channel, {
            requestType: streamUrlType,
            videoStreamType: streamType,
            prepare: true,
          });
          streamUrl = url;
        } catch (e) {
          // Silently ignore - not all recordings may have streaming URLs available
        }
      }

      enriched.push(this.enrichVodFile(vodFile, channel, streamUrl));
    }

    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "listNvrRecordings",
      `Returning ${enriched.length} enriched recording files`
    );

    // Cache enriched results
    if (!bypassCache) {
      const cacheKey = this.getNvrRecordingsCacheKey(channel, startTime, endTime, streamType, iLogicChannel, autoSearchByDay);
      this.recordingsCache.set(cacheKey, {
        data: enriched,
        expiresAt: Date.now() + this.recordingsCacheTtlMs,
      });
    }

    return enriched;
  }

  /**
   * Prepare a VOD file for download on NVR/Hub.
   * This is required before downloading VOD files from NVR/Hub.
   * This command does NOT wake up battery cameras connected to the hub.
   * 
   * @param channel - Channel number (0-based)
   * @param startTime - Start time for the recording
   * @param endTime - End time for the recording
   * @param streamType - Stream type: "main" (default), "sub", etc.
   * @param options - Optional parameters
   * @returns Prepared filename for download
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
    const iLogicChannel = options?.iLogicChannel ?? 0;

    // Build param exactly like reolink_aio does
    // Ensure time format matches exactly (year, mon, day, hour, min, sec)
    const param = {
      NvrDownload: {
        channel,
        iLogicChannel,
        streamType,
        StartTime: {
          year: startTime.year,
          mon: startTime.mon,
          day: startTime.day,
          hour: startTime.hour,
          min: startTime.min,
          sec: startTime.sec,
        },
        EndTime: {
          year: endTime.year,
          mon: endTime.mon,
          day: endTime.day,
          hour: endTime.hour,
          min: endTime.min,
          sec: endTime.sec,
        },
      },
    };

    const body = [
      {
        cmd: "NvrDownload",
        action: 1,
        param: param,
      },
    ];

    // Log the request for debugging
    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "prepareNvrVodDownload",
      `Request body: ${JSON.stringify(body)}`
    );

    try {
      // Use callMany to send the request exactly as reolink_aio does
      const response = await this.callMany<{ fileList: Array<{ fileName: string; fileSize: number }> }>(body);

      // Log the response for debugging
      recordingsTraceLog(
        this.debugConfig,
        this.logger,
        "prepareNvrVodDownload",
        `Response: ${JSON.stringify(response)}`
      );

      const first = response[0];
      if (!first || first.code !== 0 || !first.value?.fileList) {
        throw new Error(`NvrDownload failed: ${JSON.stringify(response)}`);
      }

      // Return the filename of the largest file
      let maxFilesize = 0;
      let filename = "";
      for (const file of first.value.fileList) {
        const filesize = Number(file.fileSize);
        if (filesize > maxFilesize) {
          maxFilesize = filesize;
          filename = file.fileName;
        }
      }

      if (!filename) {
        throw new Error(`NvrDownload: no files found in response`);
      }

      return filename;
    } catch (error) {
      // Log error for debugging
      recordingsTraceLog(
        this.debugConfig,
        this.logger,
        "prepareNvrVodDownload",
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Get URL for VOD playback, download, or streaming.
   * Supports automatic file preparation for NVR/Hub when needed.
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
    await this.login();
    const requestType = options?.requestType ?? "Playback";
    const streamType = options?.streamType ?? options?.videoStreamType ?? "main";
    const videoStreamType = options?.videoStreamType ?? streamType;
    const seek = options?.seek ?? 0;
    const shouldPrepare = options?.prepare ?? (requestType === "Playback");
    let startTime = options?.startTime ?? "";

    // Extract filename from VodFile or use string directly
    let filename = typeof filenameOrVodFile === "string" ? filenameOrVodFile : filenameOrVodFile.name;
    const vodFile = typeof filenameOrVodFile === "string" ? undefined : filenameOrVodFile;

    // For NVR and Playback/Download, prepare the file first if needed
    if (shouldPrepare && (requestType === "Playback" || requestType === "Download" || requestType === "NVR_DOWNLOAD")) {
      // Try to prepare from startTimeObj/endTimeObj first
      if (options?.startTimeObj && options?.endTimeObj) {
        try {
          // Convert Date to Reolink time format
          const startTimeReolink = this.dateToReolinkTime(options.startTimeObj);
          const endTimeReolink = this.dateToReolinkTime(options.endTimeObj);

          filename = await this.prepareNvrVodDownload(
            channel,
            startTimeReolink,
            endTimeReolink,
            streamType
          );
          // Extract start time from prepared filename if not provided
          if (!startTime) {
            const timeMatch = filename.match(/Rec\w{3}(?:_|_DST)?(\d{8})_(\d{6})_/);
            if (timeMatch) {
              startTime = `${timeMatch[1]}${timeMatch[2]}`;
            }
          }
        } catch (error) {
          // If preparation fails, continue with original filename
        }
      }
      // Otherwise, try to prepare from VodFile if available
      else if (vodFile && vodFile.StartTime && vodFile.EndTime) {
        try {
          filename = await this.prepareNvrVodDownload(
            channel,
            vodFile.StartTime,
            vodFile.EndTime,
            videoStreamType
          );
        } catch (error) {
          // If preparation fails, continue with original filename
        }
      }
    }

    const token = this.client.getToken();
    if (!token && (requestType === "Playback" || requestType === "Download" || requestType === "NVR_DOWNLOAD")) {
      throw new Error("Not logged in. Call login() first.");
    }

    // Get base URL from client (using private method access pattern)
    const clientAny = this.client as any;
    const scheme = clientAny.useHttps ? "https" : "http";
    const port = clientAny.port ?? (clientAny.useHttps ? 443 : 80);
    const host = clientAny.host;
    const rtmpPort = 1935; // Default RTMP port

    // Encode filename: replace spaces with %20, but keep '/' as-is (many firmwares expect raw paths)
    const encodedFilename = filename.replaceAll(" ", "%20");

    // Map stream type to numeric value for FLV/RTMP
    let streamTypeNum = 0; // main
    if (videoStreamType === "sub") {
      streamTypeNum = 1;
    } else if (videoStreamType.startsWith("autotrack_") || videoStreamType.startsWith("telephoto_")) {
      streamTypeNum = videoStreamType.includes("sub") ? 3 : 2;
    }

    let url: string;

    if (requestType === "FLV") {
      // FLV streaming URL - uses username/password authentication
      const username = encodeURIComponent(clientAny.username ?? "");
      const password = encodeURIComponent(clientAny.password ?? "");
      url = `${scheme}://${host}:${port}/flv?port=${rtmpPort}&app=bcs&stream=playback.bcs&channel=${channel}&type=${streamTypeNum}&start=${encodedFilename}&seek=${seek}&user=${username}&password=${password}`;
    } else if (requestType === "RTMP") {
      // RTMP streaming URL - uses username/password authentication
      const username = encodeURIComponent(clientAny.username ?? "");
      const password = encodeURIComponent(clientAny.password ?? "");
      url = `rtmp://${host}:${rtmpPort}/vod/${encodedFilename}?channel=${channel}&stream=${streamTypeNum}&user=${username}&password=${password}`;
    } else {
      // Playback, Download, or NVR_DOWNLOAD
      const cmd = requestType === "NVR_DOWNLOAD" ? "Download" : requestType;

      // Extract time_start from filename (like reolink_aio does)
      // Pattern: RecXXX_YYYYMMDD_HHMMSS_... or RecXXX_DST_YYYYMMDD_HHMMSS_...
      let timeStart = "";
      let startTimeParam = "";
      const timeMatch = filename.match(/Rec\w{3}(?:_|_DST)?(\d{8})_(\d{6})_/);
      if (timeMatch) {
        timeStart = `${timeMatch[1]}${timeMatch[2]}`;
        startTimeParam = `&start=${timeStart}`;
      } else if (startTime) {
        // Fallback: use provided startTime
        timeStart = startTime;
        startTimeParam = `&start=${startTime}`;
      }

      // Build output filename: ha_playback_{time_start}.mp4
      const outputFilename = `ha_playback_${timeStart || Date.now()}.mp4`;

      // Construct URL: {scheme}://{host}:{port}/cgi-bin/api.cgi?cmd={cmd}&source={filename}&output={output}&start={time_start}&token={token}
      // Note: filename spaces are replaced with %20, but '/' stays as-is
      // Note: start parameter is NOT URL-encoded (just the raw time string)
      url = `${scheme}://${host}:${port}/cgi-bin/api.cgi?cmd=${cmd}&source=${encodedFilename}&output=${outputFilename}${startTimeParam}&token=${encodeURIComponent(token ?? "")}`;
    }

    return url;
  }


  /**
   * Download a VOD file.
   * For NVR/Hub, use prepareNvrVodDownload first to get the filename.
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
    return await this.client.downloadVod(filename, options?.output, options?.start);
  }

  /**
   * Parse recordType string to extract detection flags.
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

    const types = recordType.toLowerCase().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

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
   * Generate day-by-day ranges from startTime to endTime.
   * Each range covers exactly one day (00:00:00 to 23:59:59), except the first and last day
   * which use the original start/end times.
   * 
   * @param startTime - Start time in Reolink format
   * @param endTime - End time in Reolink format
   * @returns Array of day ranges, each with \{start, end\} in Reolink time format
   */
  private generateDayRanges(
    startTime: { year: number; mon: number; day: number; hour: number; min: number; sec: number },
    endTime: { year: number; mon: number; day: number; hour: number; min: number; sec: number }
  ): Array<{ start: { year: number; mon: number; day: number; hour: number; min: number; sec: number }; end: { year: number; mon: number; day: number; hour: number; min: number; sec: number } }> {
    const ranges: Array<{ start: { year: number; mon: number; day: number; hour: number; min: number; sec: number }; end: { year: number; mon: number; day: number; hour: number; min: number; sec: number } }> = [];

    // Convert to Date objects to calculate day differences
    const startDate = new Date(startTime.year, startTime.mon - 1, startTime.day, startTime.hour, startTime.min, startTime.sec);
    const endDate = new Date(endTime.year, endTime.mon - 1, endTime.day, endTime.hour, endTime.min, endTime.sec);

    if (endDate < startDate) {
      // Invalid range, return empty
      return [];
    }

    // Check if same day
    const startDayKey = `${startTime.year}-${startTime.mon}-${startTime.day}`;
    const endDayKey = `${endTime.year}-${endTime.mon}-${endTime.day}`;

    if (startDayKey === endDayKey) {
      // Same day: single range with original times
      return [{ start: startTime, end: endTime }];
    }

    // Multiple days: generate ranges for each day
    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const currentYear = currentDate.getFullYear();
      const currentMonth = currentDate.getMonth() + 1;
      const currentDay = currentDate.getDate();
      const currentDayKey = `${currentYear}-${currentMonth}-${currentDay}`;

      if (currentDayKey === startDayKey) {
        // First day: use original start time, end at 23:59:59
        ranges.push({
          start: startTime,
          end: {
            year: currentYear,
            mon: currentMonth,
            day: currentDay,
            hour: 23,
            min: 59,
            sec: 59,
          },
        });
      } else if (currentDayKey === endDayKey) {
        // Last day: start at 00:00:00, use original end time
        ranges.push({
          start: {
            year: currentYear,
            mon: currentMonth,
            day: currentDay,
            hour: 0,
            min: 0,
            sec: 0,
          },
          end: endTime,
        });
      } else {
        // Middle day: full day (00:00:00 to 23:59:59)
        ranges.push({
          start: {
            year: currentYear,
            mon: currentMonth,
            day: currentDay,
            hour: 0,
            min: 0,
            sec: 0,
          },
          end: {
            year: currentYear,
            mon: currentMonth,
            day: currentDay,
            hour: 23,
            min: 59,
            sec: 59,
          },
        });
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
      currentDate.setHours(0, 0, 0, 0);
    }

    return ranges;
  }

  /**
   * Convert Reolink time object to Date.
   */
  private reolinkTimeToDate(time: { year: number; mon: number; day: number; hour: number; min: number; sec: number }): Date {
    return new Date(time.year, time.mon - 1, time.day, time.hour, time.min, time.sec);
  }

  /**
   * Convert Date to Reolink time object.
   * IMPORTANT: Uses LOCAL TIME values because the Reolink API interprets time values as local time
   * (matching the timezone of the camera/NVR). This ensures that when we pass time values to the API,
   * they match the values stored in filenames (e.g., "20260106_072650" means 6 January 2026, 07:26:50 local time).
   * 
   * To ensure correct extraction of local time values, we create a new Date object from the local time
   * components, similar to how it's done in test files: `new Date().setHours(0, 0, 0, 0)`.
   * This normalizes the Date to represent the exact local time moment, avoiding any UTC conversion issues.
   */
  private dateToReolinkTime(date: Date): { year: number; mon: number; day: number; hour: number; min: number; sec: number } {
    // Extract local time components first (these are what we want to pass to the API)
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const hour = date.getHours();
    const minute = date.getMinutes();
    const second = date.getSeconds();

    // Create a new Date object from these local time values to normalize it
    // This ensures we're working with a Date that represents the exact local time moment
    const normalizedDate = new Date(year, month, day, hour, minute, second);

    // Extract again from normalized date to be absolutely sure we have local time values
    // (This should be the same, but ensures consistency)
    return {
      year: normalizedDate.getFullYear(),
      mon: normalizedDate.getMonth() + 1,
      day: normalizedDate.getDate(),
      hour: normalizedDate.getHours(),
      min: normalizedDate.getMinutes(),
      sec: normalizedDate.getSeconds(),
    };
  }

  /**
   * Enrich a VodFile into EnrichedRecordingFile.
   */
  private enrichVodFile(vodFile: VodFile, channel: number, streamUrl?: string): EnrichedRecordingFile {
    // Log raw VodFile data from API (log entire object to see if there are hidden fields)
    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "enrichVodFile",
      `RAW VodFile from API: ${JSON.stringify({
        name: vodFile.name,
        type: vodFile.type,
        size: vodFile.size,
        StartTime: vodFile.StartTime,
        EndTime: vodFile.EndTime,
        PlaybackTime: vodFile.PlaybackTime,
        fullVodFile: JSON.parse(JSON.stringify(vodFile)),
      })}`
    );

    // Parse filename
    const parsed = parseRecordingFileName(vodFile.name);

    // Extract hex value from filename for debugging
    const filenameParts = vodFile.name.split('_');
    const hexValueFromFilename = filenameParts.length >= 8 ? filenameParts[filenameParts.length - 2] : 'unknown';
    // For version 4, the last part (hash) might contain detection info
    const hashPart = filenameParts.length >= 9 ? filenameParts[filenameParts.length - 1]?.replace('.mp4', '') : null;

    // Debug: analyze hex value bit by bit
    let hexAnalysis: any = null;
    if (hexValueFromFilename && hexValueFromFilename !== 'unknown' && /^[0-9a-fA-F]+$/.test(hexValueFromFilename)) {
      const bitLen = hexValueFromFilename.length * 4;
      const hexInt = BigInt(`0x${hexValueFromFilename}`);
      const bin = hexInt.toString(2).padStart(bitLen, "0");
      const revBin = bin.split("").reverse().join("");

      // For Hub v4, analyze all bit ranges to find where detection flags might be
      const bitRanges: Record<string, string> = {};
      for (let start = 0; start < Math.min(bitLen, 64); start += 8) {
        const end = Math.min(start + 8, bitLen);
        bitRanges[`bits${start}to${end}`] = revBin.slice(start, end);
      }

      hexAnalysis = {
        hexValue: hexValueFromFilename,
        hexInt: hexInt.toString(),
        binary: bin,
        reversedBinary: revBin,
        bitLength: bitLen,
        // Show bits 17-27 which should contain detection flags (for older versions)
        bits17to27: revBin.slice(17, 28),
        // Show all 8-bit ranges for comprehensive analysis
        allBitRanges: bitRanges,
        // Show specific ranges that might contain detection flags for v4
        bits0to16: revBin.slice(0, 17),
        bits17to32: revBin.slice(17, 33),
        bits33to48: revBin.slice(33, 49),
        bits49to56: revBin.slice(49, 56),
      };
    }

    // Debug: analyze hash part (might contain detection info for version 4)
    let hashAnalysis: any = null;
    if (hashPart && /^[0-9a-fA-F]+$/i.test(hashPart)) {
      const hashBitLen = hashPart.length * 4;
      const hashHexInt = BigInt(`0x${hashPart}`);
      const hashBin = hashHexInt.toString(2).padStart(hashBitLen, "0");
      const hashRevBin = hashBin.split("").reverse().join("");
      hashAnalysis = {
        hashValue: hashPart,
        hashHexInt: hashHexInt.toString(),
        hashBinary: hashBin,
        hashReversedBinary: hashRevBin,
        hashBitLength: hashBitLen,
        // Show first 16 bits which might contain detection flags
        hashBits0to15: hashRevBin.slice(0, 16),
      };
    }

    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "enrichVodFile",
      `Parsed filename: ${JSON.stringify({
        fileName: vodFile.name,
        filenameParts: filenameParts,
        hexValueFromFilename: hexValueFromFilename,
        hashPart: hashPart,
        hexAnalysis: hexAnalysis,
        hashAnalysis: hashAnalysis,
        parsed: parsed ? {
          start: parsed.start?.toISOString(),
          end: parsed.end?.toISOString(),
          durationMs: parsed.durationMs,
          flags: parsed.flags,
          rawFlags: parsed.rawFlags,
          streamHint: parsed.streamHint,
          devType: parsed.devType,
          version: parsed.version,
        } : null,
      })}`
    );

    // Get times from various sources
    const startTime = parsed?.start ?? this.reolinkTimeToDate(vodFile.StartTime);
    const endTime = parsed?.end ?? this.reolinkTimeToDate(vodFile.EndTime);

    const startTimeMs = startTime.getTime();
    const endTimeMs = endTime.getTime();

    // Calculate duration
    let durationMs = parsed?.durationMs ?? 0;
    if (durationMs === 0 && endTimeMs > startTimeMs) {
      durationMs = endTimeMs - startTimeMs;
    }

    // Get flags from hex decoding (from parsed filename)
    const hexFlags = parsed?.flags;

    // For Hub v4, check if hex value is constant (suggests detection info might not be in filename)
    if (parsed?.devType === "hub" && parsed?.version === 4) {
      if (hexValueFromFilename && hexValueFromFilename !== 'unknown') {
        recordingsTraceLog(
          this.debugConfig,
          this.logger,
          "enrichVodFile",
          `WARNING: Hub v4 hex value "${hexValueFromFilename}" appears to be constant across files. Detection flags are likely NOT encoded in filename for this version. Detection information may need to be retrieved via a separate API call or may not be available.`
        );
        recordingsTraceLog(
          this.debugConfig,
          this.logger,
          "enrichVodFile",
          `NOTE: For Hub v4, the API response only provides 'type' field which is "${vodFile.type}". No detection-specific fields are available in the Search API response.`
        );
      }
    }

    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "enrichVodFile",
      `Hex flags from filename: ${JSON.stringify(hexFlags)}`
    );

    // Get flags from recordType string (if available in VodFile)
    // Note: VodFile from HTTP API doesn't have recordType, but we can try to infer from triggers
    const typeFlags = this.parseRecordTypeFlags(vodFile.type);
    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "enrichVodFile",
      `Type flags from recordType "${vodFile.type}": ${JSON.stringify(typeFlags)}`
    );

    // Merge flags: OR them together
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

    recordingsTraceLog(
      this.debugConfig,
      this.logger,
      "enrichVodFile",
      `Final merged flags: ${JSON.stringify({
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
      })}`
    );

    // Create RecordingFile for raw reference
    const raw: RecordingFile = {
      fileName: vodFile.name,
      sizeBytes: vodFile.size,
      startTime,
      endTime,
      recordType: vodFile.type,
    };
    if (parsed) {
      raw.parsedFileName = parsed;
    }

    const enriched: EnrichedRecordingFile = {
      fileName: vodFile.name,
      id: vodFile.name,
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
      devType: parsed?.devType ?? "hub",
      raw,
    };

    if (vodFile.size !== undefined) enriched.sizeBytes = vodFile.size;
    if (vodFile.type) enriched.recordType = vodFile.type;
    if (streamUrl) enriched.rtmpUrl = streamUrl;
    if (parsed) enriched.parsedFileName = parsed;

    return enriched;
  }

}

