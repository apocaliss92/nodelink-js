import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import {
  BaichuanRtspServer,
  type BaichuanRtspServerOptions,
} from "../../baichuan/stream/BaichuanRtspServer";
import { BaichuanVideoStream } from "../../baichuan/stream/BaichuanVideoStream";
import {
  BcMediaAnnexBDecoder,
  type BcMediaAudioType,
  type BcMediaVideoType,
} from "../../baichuan/stream/BcMediaAnnexBDecoder";
import {
  BaichuanClient,
  type BaichuanClientOptions,
} from "../../client/BaichuanClient";
import {
  eventTraceLog,
  normalizeDebugOptions,
  recordingsTraceLog,
  type Logger,
} from "../../debug/DebugConfig";
import {
  collectNvrDiagnostics,
  runAllDiagnosticsConsecutively,
  RunAllDiagnosticsConsecutivelyParams,
  runMultifocalDiagnosticsConsecutively,
  RunMultifocalDiagnosticsConsecutivelyParams,
} from "../../debug/DiagnosticsTools";
import { createDebugGateLogger } from "../../logging/logger";
import {
  BC_CLASS_FILE_DOWNLOAD,
  BC_CLASS_MODERN_24,
  BC_CLASS_MODERN_24_ALT,
  BC_CMD_ID_ABILITY_INFO,
  BC_CMD_ID_AUDIO_ALARM_PLAY,
  BC_CMD_ID_CHANNEL_INFO_ALL,
  BC_CMD_ID_CMD_123,
  BC_CMD_ID_CMD_209,
  BC_CMD_ID_CMD_231,
  BC_CMD_ID_CMD_265,
  BC_CMD_ID_CMD_440,
  BC_CMD_ID_FILE_INFO_LIST_DL_VIDEO,
  BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
  BC_CMD_ID_FILE_INFO_LIST_GET,
  BC_CMD_ID_FILE_INFO_LIST_OPEN,
  BC_CMD_ID_FILE_INFO_LIST_REPLAY,
  BC_CMD_ID_FILE_INFO_LIST_STOP,
  BC_CMD_ID_FLOODLIGHT_STATUS_LIST,
  BC_CMD_ID_GET_ABILITY_SUPPORT,
  BC_CMD_ID_GET_ACCESS_USER_LIST,
  BC_CMD_ID_GET_ONLINE_USER_LIST,
  BC_CMD_ID_GET_AI_ALARM,
  BC_CMD_ID_GET_AI_DENOISE,
  BC_CMD_ID_GET_AUDIO_ALARM,
  BC_CMD_ID_GET_AUDIO_CFG,
  BC_CMD_ID_GET_AUDIO_TASK,
  BC_CMD_ID_GET_BATTERY_INFO,
  BC_CMD_ID_GET_BATTERY_INFO_LIST,
  BC_CMD_ID_GET_DAY_NIGHT_THRESHOLD,
  BC_CMD_ID_GET_DAY_RECORDS,
  BC_CMD_ID_GET_EMAIL_TASK,
  BC_CMD_ID_GET_FTP_TASK,
  BC_CMD_ID_GET_HDD_INFO_LIST,
  BC_CMD_ID_GET_KIT_AP_CFG,
  BC_CMD_ID_GET_LED_STATE,
  BC_CMD_ID_GET_MOTION_ALARM,
  BC_CMD_ID_GET_OSD_DATETIME,
  BC_CMD_ID_GET_PIR_INFO,
  BC_CMD_ID_GET_PTZ_POSITION,
  BC_CMD_ID_GET_PTZ_PRESET,
  BC_CMD_ID_GET_REC_ENC_CFG,
  BC_CMD_ID_GET_RECORD,
  BC_CMD_ID_GET_RECORD_CFG,
  BC_CMD_ID_GET_SLEEP_STATE,
  BC_CMD_ID_GET_STREAM_INFO_LIST,
  BC_CMD_ID_GET_TIMELAPSE_CFG,
  BC_CMD_ID_GET_WHITE_LED,
  BC_CMD_ID_GET_WIFI,
  BC_CMD_ID_GET_WIFI_SIGNAL,
  BC_CMD_ID_GET_ZOOM_FOCUS,
  BC_CMD_ID_PING,
  BC_CMD_ID_PTZ_CONTROL,
  BC_CMD_ID_PTZ_CONTROL_PRESET,
  BC_CMD_ID_PUSH_COORDINATE_POINT_LIST,
  BC_CMD_ID_PUSH_DINGDONG_LIST,
  BC_CMD_ID_PUSH_NET_INFO,
  BC_CMD_ID_PUSH_SERIAL,
  BC_CMD_ID_PUSH_SLEEP_STATUS,
  BC_CMD_ID_PUSH_VIDEO_INPUT,
  BC_CMD_ID_SET_AI_ALARM,
  BC_CMD_ID_SET_MOTION_ALARM,
  BC_CMD_ID_SET_PIR_INFO,
  BC_CMD_ID_SET_WHITE_LED_STATE,
  BC_CMD_ID_SET_WHITE_LED_TASK,
  BC_CMD_ID_SET_ZOOM_FOCUS,
  BC_CMD_ID_SUPPORT,
  BC_CMD_ID_TALK_ABILITY,
  BC_CMD_ID_TALK_CONFIG,
  BC_CMD_ID_TALK_RESET,
  BC_CMD_ID_UDP_KEEP_ALIVE,
  BC_CMD_ID_VIDEO,
  BC_CMD_ID_VIDEO_STOP,
} from "../../protocol/constants";
import {
  buildAbilityInfoExtensionXml,
  buildBinaryExtensionXml,
  buildChannelExtensionXml,
  buildPreviewStopXml,
  buildPreviewStopXmlV11,
  buildPreviewXml,
  buildPreviewXmlV11,
  buildPtzControlXml,
  buildPtzPresetXml,
  buildPtzPresetXmlV2,
  buildSirenManualXml,
  buildSirenTimesXml,
  buildStartZoomFocusXml,
  getXmlText,
  xmlEscape,
} from "../../protocol/xml";
import type {
  AIState,
  AiTypesCacheEntry,
  BaichuanCachedPush,
  BaichuanCoordinatePointListPush,
  BaichuanDingdongListPush,
  BaichuanGetOsdDatetimeResult,
  BaichuanLedState,
  BaichuanNetInfoPush,
  BaichuanOsdChannelName,
  BaichuanOsdDatetime,
  BaichuanRecordCfg,
  BaichuanRecordSchedule,
  BaichuanSerialPush,
  BaichuanSettingsPushCacheEntry,
  BaichuanSleepState,
  BaichuanSleepStatusPush,
  BaichuanStreamInfoList,
  BaichuanVideoInputPush,
  BaichuanWifi,
  BaichuanWifiSignal,
  BatteryInfo,
  ChannelPushCacheEntry,
  ChannelPushDataEntry,
  ChannelStreamMetadata,
  DeviceAbilities,
  DeviceCapabilitiesResult,
  DeviceSupportFlags,
  DownloadRecordingParams,
  DualLensChannelAnalysis,
  DualLensChannelInfo,
  Events,
  GetRecordingVideoResult,
  GetRecordingVideoStats,
  GetVideoclipsParams,
  LastSleepProbe,
  NativeVideoStreamVariant,
  NvrChannelsSummaryCacheEntry,
  OsdConfig,
  PirState,
  PlaybackSnapshotStreamInfo,
  PtzCommand,
  PtzPosition,
  PtzPreset,
  RecordingFile,
  RecordingPlaybackUrls,
  RecordingsCacheEntry,
  RecordingsQueueItem,
  RecordingStreamType,
  ReolinkBaichuanChannelIdentity,
  ReolinkBaichuanChannelInfo,
  ReolinkBaichuanNetworkInfo,
  ReolinkBaichuanPorts,
  ReolinkEvent,
  ReolinkNvrDeviceGroupsResult,
  ReolinkNvrDeviceGroupSummary,
  ReolinkSimpleEvent,
  ReolinkSupportedStream,
  ReolinkVideoStreamOptionsResult,
  RtspCreateOptions,
  RunAllDiagnosticsConsecutivelyResult,
  RunMultifocalDiagnosticsConsecutivelyResult,
  SirenState,
  SleepStatus,
  VideoclipThumbnailResult,
  StreamMetadata,
  StreamProfile,
  SupportInfo,
  TwoWayAudioConfig,
  WakeUpOptions,
  WhiteLedState,
  ZoomFocusStatus,
  ZoomFocusTriplet,
} from "./types";
import { parseXmlFragmentToJson, type XmlJsonValue } from "./utils/xml";

import { Jimp, JimpMime } from "jimp";
import type { CompositeStreamPipOptions } from "../../multifocal/compositeStream";
import {
  ReolinkCgiApi,
  VodFile,
  type GetVodUrlParams,
} from "../cgi/ReolinkCgiApi";
import { ReolinkHttpClient } from "../http/ReolinkHttpClient";
import type { ReolinkDeviceInfo, ReolinkDeviceInfoTag } from "../types";
import {
  computeDeviceCapabilities,
  flattenAbilitiesForChannel,
  parseSupportXml,
} from "./capabilities";
import { parseAbilityInfoXml } from "./utils/abilityInfo";
import { getAiStateViaGetAiAlarm } from "./utils/aiState";
import { parseChannelInfoPushBlocks } from "./utils/channelInfoPush";
import {
  buildChannelPushDataLogSnapshot,
  computeChannelPushUpdateFromEntry,
} from "./utils/channelInfoStore";
import { mapToSimpleEvent } from "./utils/events";
import { formatClientIoForLog, formatErrorForLog } from "./utils/logging";
import { parseBoolean01, parseNumber } from "./utils/parsing";
import { calculatePipOverlayPosition, resolvePipMarginPx } from "./utils/pip";
import {
  buildDeletePtzPresetAttempts,
  extractFrameErrorDetails,
  isPresetEffectivelyDeleted,
  resolvePtzDirection,
  resolvePtzSpeed,
  runDeletePtzPresetAttempts,
} from "./utils/ptz";
import {
  parseCoordinatePointListPushXml,
  parseDingdongListPushXml,
  parseNetInfoPushXml,
  parseSerialPushXml,
  parseSleepStatusPushXml,
  parseVideoInputPushXml,
} from "./utils/pushSettings";
import { buildFileInfoListDownloadXml } from "./utils/recordingDownload";
import {
  buildFileInfoListReplayByIdXml,
  buildFileInfoListReplayByNameXml,
  buildFileInfoListStopXml,
  buildReplayStopNameFromFileName,
  type RecordingReplayStreamType,
} from "./utils/recordingReplay";
import { sleepMs } from "./utils/recordings";
import {
  dedupeRecordingFiles,
  downloadRecordingViaFileInfoListPaged,
  listRecordingsViaFileInfoList,
} from "./utils/recordingsFileInfoList";
import { parseChannelStreamMetadataFromGetEncXml } from "./utils/streamMetadata";
import {
  buildTalkSessionInfoFromAbility,
  sendTalkConfigWithReset,
} from "./utils/talkConfig";
import { createBufferedTalkSession } from "./utils/talkSession";
import { discoverPerChannelUidViaCgiChannelstatus } from "./utils/uidDiscovery";
import { getXmlBlocks, getXmlTexts, parseTalkAbilityXml } from "./xmlUtils";

import { parseRecordingFileName } from "./recordingFileName";
import { parseEventsFromGetEventsXml } from "./utils/eventsGetEvents";
import { parsePirInfoFromXml } from "./utils/pir";
import { discoverDeviceUidForRecordings as discoverDeviceUidForRecordingsUtil } from "./utils/uidRecordings";
import {
  applyWhiteLedBrightnessToXml,
  applyWhiteLedOnOffToXml,
  buildWhiteLedManualPayloadXml,
  parseWhiteLedStateFromXml,
} from "./utils/whiteLed";

type TalkAbility = import("./types").TalkAbility;
type TalkAudioConfig = import("./types").TalkAudioConfig;
type TalkConfig = import("./types").TalkConfig;
type TalkSession = import("./types").TalkSession;
type TalkSessionInfo = import("./types").TalkSessionInfo;
type SupportItem = import("./types").SupportItem;

export type {
  NativeVideoStreamVariant,
  ReolinkBaichuanPorts,
  ReolinkNvrChannelInfo,
  ReolinkSupportedStream,
  WakeUpOptions,
} from "./types";

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
  return (
    DUAL_LENS_MODELS.has(model) || model.toLowerCase().includes("trackmix")
  );
};

/**
 * Model patterns that indicate NVR/Hub devices.
 * These devices may report channelNum=1 but actually support multiple channels.
 * Case-insensitive matching is used.
 */
export const NVR_HUB_MODEL_PATTERNS: RegExp[] = [
  /home\s*hub/i, // "Home Hub", "HomeHub"
  /reolink\s*hub/i, // "Reolink Hub"
  /wifi[-\s]*nvr/i, // "WIFI-NVR", "WiFi NVR"
  /^nvr/i, // "NVR8-xxx", "NVR16-xxx"
  /^rlk\d+-\d+/i, // "RLK8-xxx", "RLK16-xxx" (NVR kits)
  /^rlk\d+w/i, // "RLK8W-xxx" (wireless NVR kits)
];

/**
 * Check if a model name indicates an NVR/Hub device.
 * @param model - The device model/type string
 * @returns true if the model matches NVR/Hub patterns
 */
export const isNvrHubModel = (model?: string): boolean => {
  if (!model) return false;
  const normalized = model.trim();
  return NVR_HUB_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
};

export class ReolinkBaichuanApi {
  readonly client: BaichuanClient;
  readonly logger: Logger;
  private readonly httpClient: ReolinkHttpClient;
  private readonly cgiApi: ReolinkCgiApi;
  private readonly nativeOnly: boolean;
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  /**
   * Cached camera UID. May be initially undefined if not provided in the constructor.
   * Will be lazily populated on demand when needed (e.g. for recordings).
   */
  private uid: string | undefined;
  /**
   * Cached channel count from device capabilities.
   * - 1 = standalone camera
   * - >1 = NVR/Hub with multiple channels
   * Set during login or when capabilities are queried.
   */
  private _channelCount: number | undefined;

  private rebootAfterDisconnectionsPerMinute: number | undefined;
  private readonly disconnectStormVoluntaryAtMs: number[] = [];
  private disconnectStormRebootInFlight: Promise<void> | undefined;
  private disconnectStormLastRebootAtMs: number | undefined;
  private readonly simpleEventListeners = new Set<
    (event: ReolinkSimpleEvent) => void | Promise<void>
  >();
  private simpleEventSubscribed = false;
  private simpleEventSubscribeInFlight: Promise<void> | undefined;
  private simpleEventUnsubscribeInFlight: Promise<void> | undefined;
  private simpleEventResubscribeTimer: NodeJS.Timeout | undefined;
  private simpleEventResubscribeInFlight: Promise<void> | undefined;
  private readonly simpleEventResubscribeIntervalMs = 5 * 60_000;
  private statePollingInterval: NodeJS.Timeout | undefined;
  private udpSleepInferenceInterval: NodeJS.Timeout | undefined;
  private readonly udpLastInferredSleepStateByChannel = new Map<
    number,
    SleepStatus["state"]
  >();
  private readonly udpSleepInferenceIntervalMs = 2_000;
  private lastMotionState: boolean | undefined;
  private lastAiState: AIState | undefined;
  private aiStatePollingDisabled = false;
  private aiStatePollingDisabledLogged = false;
  private readonly aiDetectTypesCache = new Map<number, AiTypesCacheEntry>();
  private readonly aiAlarmCandidateTypesCache = new Map<
    number,
    AiTypesCacheEntry
  >();
  private rtspServers = new Set<BaichuanRtspServer>(); // Track all RTSP servers for cleanup
  private readonly activeVideoMsgNums = new Map<string, number>();
  private readonly nvrChannelsSummaryCache = new Map<
    string,
    NvrChannelsSummaryCacheEntry
  >();

  /**
   * Cached per-channel data from cmd_id 145 push (NVR sends this automatically on connection).
   *
   * This unifies identity (name/uid/state) + best-effort flags (sleep/online).
   */
  private channelPushData: Map<number, ChannelPushDataEntry> = new Map();

  /**
   * Best-effort mapping from logical 0-based channel to the Baichuan header channelId used on NVR/Hub.
   *
   * On many NVR firmwares, cmd_id=145 push carries:
   * - <channelId>: a large internal channelId used in Baichuan headers (e.g. 54, 57, ...)
   * - <index>: a small 1-based slot index that often corresponds to the logical channel + 1
   *
   * For standalone cameras (no cmd145 push), this returns undefined.
   */
  private resolveHeaderChannelIdForLogicalChannel(
    channel: number,
  ): number | undefined {
    const ch = Number(channel);
    if (!Number.isFinite(ch)) return undefined;

    // Backward-compatible: if the push cache is keyed by the logical channel already.
    if (this.channelPushData.has(ch)) return ch;

    const wantIndex1 = ch + 1;
    const wantIndex0 = ch;

    let byIndex1: number | undefined;
    let byIndex0: number | undefined;

    for (const [headerChannelId, info] of this.channelPushData.entries()) {
      const idx = info.index;
      if (typeof idx !== "number" || !Number.isFinite(idx)) continue;
      if (idx === wantIndex1) byIndex1 = headerChannelId;
      if (idx === wantIndex0) byIndex0 = headerChannelId;
    }

    return byIndex1 ?? byIndex0;
  }

  private getPushCacheEntryForLogicalChannel(
    channel: number,
  ): ChannelPushDataEntry | undefined {
    const direct = this.channelPushData.get(channel);
    if (direct) return direct;

    const headerCh = this.resolveHeaderChannelIdForLogicalChannel(channel);
    if (headerCh == null) return undefined;
    return this.channelPushData.get(headerCh);
  }

  /** Public helper: best-effort per-logical-channel push cache view. */
  getChannelInfoFromPushCacheByLogicalChannel(
    channel: number,
  ): ChannelPushCacheEntry | undefined {
    const info = this.getPushCacheEntryForLogicalChannel(channel);
    if (!info) return undefined;
    const stateLower = (info.stateLower ?? info.state).toLowerCase();
    if (stateLower === "none") return undefined;
    return {
      name: info.name,
      uid: info.uid,
      state: info.state,
      ...(typeof info.index === "number" ? { index: info.index } : {}),
      ...(info.streamSupport?.length
        ? { streamSupport: info.streamSupport }
        : {}),
      ...(info.wifiState ? { wifiState: info.wifiState } : {}),
      ...(info.networkSegment ? { networkSegment: info.networkSegment } : {}),
      ...(typeof info.changed === "boolean" ? { changed: info.changed } : {}),
      ...(typeof info.abilityChanged === "boolean"
        ? { abilityChanged: info.abilityChanged }
        : {}),
      ...(typeof info.online === "boolean" ? { online: info.online } : {}),
      ...(typeof info.sleeping === "boolean"
        ? { sleeping: info.sleeping }
        : {}),
      ...(info.loginState ? { loginState: info.loginState } : {}),
      ...(typeof info.updatedAtMs === "number"
        ? { updatedAtMs: info.updatedAtMs }
        : {}),
    };
  }

  /** Cache populated from device->client push frames (cmd_id 78/79/464/484/623/723). */
  private readonly settingsPushCache = new Map<
    number,
    BaichuanSettingsPushCacheEntry
  >();

  private lastSleepProbe: LastSleepProbe | undefined;

  /**
   * Local cache for recordings. Key is a composite of channel, start, end, streamType.
   * Value contains the cached enriched recordings and timestamp.
   * Unified cache for both NVR and Device recordings (always enriched).
   */
  private recordingsCache = new Map<string, RecordingsCacheEntry>();

  /**
   * Queue for serializing listRecordings calls to prevent socket crashes from concurrent requests.
   */
  private recordingsQueue: RecordingsQueueItem[] = [];
  private recordingsQueueProcessing = false;

  /**
   * Map for de-duplicating in-flight replay operations.
   * Key is a composite of operation type + fileName, value is the pending promise.
   */
  private pendingReplayOperations = new Map<string, Promise<unknown>>();

  /**
   * Simple async queue for serializing replay operations.
   * Operations are executed one at a time in FIFO order.
   */
  private replayQueue: Array<{
    execute: () => Promise<void>;
  }> = [];
  private replayQueueProcessing = false;

  /** Minimum delay between replay operations to give camera time to reset */
  private readonly REPLAY_COOLDOWN_MS = 500;
  private lastReplayEndTime = 0;

  /**
   * Queue for serializing getVideoclipThumbnail calls.
   * Only one snapshot request can be in-flight at a time since the camera
   * often rejects concurrent CoverPreview requests.
   */
  private videoclipThumbnailInFlight: Promise<VideoclipThumbnailResult> | null =
    null;
  private videoclipThumbnailQueue: Array<{
    params: Parameters<ReolinkBaichuanApi["getVideoclipThumbnail"]>[0];
    resolve: (result: VideoclipThumbnailResult) => void;
    reject: (error: Error) => void;
  }> = [];

  /**
   * Process the replay queue - executes operations one at a time.
   */
  private async processReplayQueue(): Promise<void> {
    if (this.replayQueueProcessing) return;
    this.replayQueueProcessing = true;

    while (this.replayQueue.length > 0) {
      const item = this.replayQueue.shift();
      if (item) {
        // Ensure minimum cooldown between replay operations
        const timeSinceLastReplay = Date.now() - this.lastReplayEndTime;
        if (timeSinceLastReplay < this.REPLAY_COOLDOWN_MS) {
          await new Promise((r) =>
            setTimeout(r, this.REPLAY_COOLDOWN_MS - timeSinceLastReplay),
          );
        }

        await item.execute();

        // Record when this operation ended
        this.lastReplayEndTime = Date.now();
      }
    }

    this.replayQueueProcessing = false;
  }

  /**
   * Enqueue a replay operation with optional de-duplication.
   * If dedupKey is provided and an operation with that key is in progress, returns the existing promise.
   * Operations are serialized - only one runs at a time.
   */
  private enqueueReplayOperation<T>(
    operation: () => Promise<T>,
    dedupKey?: string,
  ): Promise<T> {
    // Check for de-duplication
    if (dedupKey) {
      const existing = this.pendingReplayOperations.get(dedupKey);
      if (existing) {
        this.logger?.debug?.(
          `[ReplayQueue] Reusing existing promise for: ${dedupKey}`,
        );
        return existing as Promise<T>;
      }
    }

    // Create the promise that will be resolved when the operation completes
    let resolvePromise: (value: T) => void;
    let rejectPromise: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // Track for de-duplication if key provided
    if (dedupKey) {
      this.pendingReplayOperations.set(dedupKey, promise);
      promise.finally(() => {
        this.pendingReplayOperations.delete(dedupKey);
      });
    }

    // Add to queue
    this.replayQueue.push({
      execute: async () => {
        try {
          const result = await operation();
          resolvePromise(result);
        } catch (e) {
          rejectPromise(e);
        }
      },
    });

    // Start processing (no-op if already processing)
    void this.processReplayQueue();

    return promise;
  }

  /**
   * Enqueue a streaming replay operation.
   * The queue slot is held until the returned release function is called.
   * This is for operations like createRecordingReplayMp4Stream where the stream
   * continues producing data after the initial setup.
   *
   * @param setup - Function that sets up the stream. Called when it's this operation's turn.
   * @returns Promise that resolves when setup is complete, with the result and a release function.
   */
  private enqueueStreamingReplayOperation<T>(
    setup: () => Promise<T>,
  ): Promise<{ result: T; release: () => void }> {
    let resolvePromise: (value: { result: T; release: () => void }) => void;
    let rejectPromise: (error: unknown) => void;
    const promise = new Promise<{ result: T; release: () => void }>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );

    // Add to queue
    this.replayQueue.push({
      execute: () => {
        return new Promise<void>((releaseSlot) => {
          // Run the setup
          setup()
            .then((result) => {
              // Setup succeeded - resolve with result and release function
              resolvePromise({
                result,
                release: () => releaseSlot(),
              });
            })
            .catch((e) => {
              // Setup failed - reject and release slot
              rejectPromise(e);
              releaseSlot();
            });
        });
      },
    });

    // Start processing (no-op if already processing)
    void this.processReplayQueue();

    return promise;
  }

  /**
   * Determine streamType from fileName automatically.
   * Checks if there's an 'S' in the first 10 characters of the basename,
   * which indicates subStream (e.g., RecS03_, RecS_).
   */
  private determineStreamTypeFromFileName(
    fileName: string,
  ): RecordingReplayStreamType {
    // Extract basename (last part of path)
    const basename = fileName.split("/").pop() ?? fileName;
    // Check first 10 characters for 'S' (case-insensitive)
    const prefix = basename.substring(0, 10).toUpperCase();
    return prefix.includes("S") ? "subStream" : "mainStream";
  }

  /**
   * Cache for buildVideoStreamOptions.
   *
   * IMPORTANT: only the first non-empty result is cached per key.
   * Empty results are considered transient (common on NVR/Hub) and won't overwrite a good cache.
   */
  private readonly videoStreamOptionsCache = new Map<
    string,
    ReolinkVideoStreamOptionsResult
  >();

  /**
   * Process recordings queue sequentially to prevent socket crashes from concurrent requests.
   */
  private async processRecordingsQueue(): Promise<void> {
    if (this.recordingsQueueProcessing || this.recordingsQueue.length === 0) {
      return;
    }

    this.recordingsQueueProcessing = true;

    while (this.recordingsQueue.length > 0) {
      const item = this.recordingsQueue.shift();
      if (!item) break;
      await item.run();
    }

    this.recordingsQueueProcessing = false;
  }

  /**
   * Enqueue a recordings operation to be processed sequentially.
   */
  private async enqueueRecordingsOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.recordingsQueue.push({
        run: async () => {
          try {
            resolve(await operation());
          } catch (e) {
            reject(e);
          }
        },
      });
      void this.processRecordingsQueue();
    });
  }

  private recordingsCacheTtlMs = 20 * 60 * 1000;

  private dispatchSimpleEvent(evt: ReolinkSimpleEvent): void {
    const debugCfg = this.client.getDebugConfig?.();
    if (debugCfg) {
      const sid = this.client.getSocketSessionId?.();
      const tag = sid ? `ReolinkSimpleEvent sid=${sid}` : "ReolinkSimpleEvent";
      eventTraceLog(
        debugCfg,
        this.logger,
        tag,
        `dispatch type=${evt.type} channel=${evt.channel} timestamp=${evt.timestamp}`,
      );
    }

    for (const cb of this.simpleEventListeners) {
      try {
        // Support async handlers (common in Scrypted plugins) without unhandled rejections.
        void Promise.resolve(cb(evt)).catch((e: unknown) => {
          (this.logger.warn ?? this.logger.error).call(
            this.logger,
            "[ReolinkBaichuanApi] onSimpleEvent handler error",
            formatErrorForLog(e),
          );
        });
      } catch (e) {
        // Never allow user handlers to break the Baichuan client's event loop.
        (this.logger.warn ?? this.logger.error).call(
          this.logger,
          "[ReolinkBaichuanApi] onSimpleEvent handler error",
          formatErrorForLog(e),
        );
      }
    }
  }

  constructor(
    opts: BaichuanClientOptions & {
      /**
       * Reboot the device if there are too many *voluntary* disconnects within 60 seconds.
       *
       * The count is based on `BaichuanClient.close({ reason: ... })` / idle disconnects.
       * Remote/firmware-initiated closes are ignored.
       */
      rebootAfterDisconnectionsPerMinute?: number;
      /** If true, avoid using HTTP/CGI fallbacks and discovery paths (native Baichuan only). */
      nativeOnly?: boolean;
    },
  ) {
    const dbg = normalizeDebugOptions(opts.debugOptions);
    // Centralized verbosity control: treat `.debug()` as opt-in.
    this.logger = createDebugGateLogger(
      opts.logger,
      dbg.general ||
        dbg.traceNativeStream ||
        dbg.traceRecordings ||
        dbg.traceTalk ||
        dbg.traceEvents ||
        dbg.debugRtsp,
    );
    this.client = new BaichuanClient(opts);
    this.host = opts.host;
    this.username = opts.username;
    this.password = opts.password;
    this.uid = opts.uid;
    this.nativeOnly = opts.nativeOnly ?? false;
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
      } catch (e: unknown) {
        this.logger.warn?.(
          "[ReolinkBaichuanApi] Error parsing channel info from push",
          formatErrorForLog(e),
        );
      }
    });

    // Parse and cache additional push frames observed in settings PCAPs.
    this.client.on("push", (frame) => {
      const cmdId = frame.header.cmdId;
      if (
        cmdId !== BC_CMD_ID_PUSH_VIDEO_INPUT &&
        cmdId !== BC_CMD_ID_PUSH_SERIAL &&
        cmdId !== BC_CMD_ID_PUSH_NET_INFO &&
        cmdId !== BC_CMD_ID_PUSH_DINGDONG_LIST &&
        cmdId !== BC_CMD_ID_PUSH_SLEEP_STATUS &&
        cmdId !== BC_CMD_ID_PUSH_COORDINATE_POINT_LIST
      ) {
        return;
      }

      try {
        if (frame.body.length === 0) return;
        const xml = this.client.tryDecryptXml(
          frame.body,
          frame.header.channelId,
          this.client.enc,
        );
        if (!xml || !xml.startsWith("<?xml")) return;
        this.parseAndStoreSettingsPush(cmdId, xml, frame.header.channelId);
      } catch (e: unknown) {
        this.logger.debug?.(
          "[ReolinkBaichuanApi] Error parsing settings push",
          formatErrorForLog(e),
        );
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
  private getRecordingsCacheKey(
    channel: number,
    start: Date,
    end: Date,
    streamType: string,
  ): string {
    return `${channel}:${start.getTime()}:${end.getTime()}:${streamType}`;
  }

  /**
   * Get cached recordings if available and not expired.
   */
  private getCachedRecordings(
    channel: number,
    start: Date,
    end: Date,
    streamType: string,
  ): RecordingFile[] | undefined {
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
  private cacheRecordings(
    channel: number,
    start: Date,
    end: Date,
    streamType: string,
    recordings: RecordingFile[],
    ttlMs?: number,
  ): void {
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
  clearRecordingsCacheForRange(
    channel: number,
    start: Date,
    end: Date,
    streamType: string,
  ): void {
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
  async runAllDiagnosticsConsecutively(
    params: RunAllDiagnosticsConsecutivelyParams,
  ): Promise<RunAllDiagnosticsConsecutivelyResult> {
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
    params: Omit<
      RunMultifocalDiagnosticsConsecutivelyParams,
      "api" | "host" | "username" | "password" | "logger"
    > & {
      /** Optional logger from the caller (preferred over the API logger). */
      logger?: RunMultifocalDiagnosticsConsecutivelyParams["logger"];
    },
  ): Promise<RunMultifocalDiagnosticsConsecutivelyResult> {
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
    while (
      this.disconnectStormVoluntaryAtMs.length &&
      this.disconnectStormVoluntaryAtMs[0]! < cutoff
    ) {
      this.disconnectStormVoluntaryAtMs.shift();
    }
    this.disconnectStormVoluntaryAtMs.push(now);

    if (this.disconnectStormVoluntaryAtMs.length < threshold) return;

    if (this.disconnectStormRebootInFlight) return;
    const cooldownMs = 10 * 60_000;
    if (
      this.disconnectStormLastRebootAtMs != null &&
      now - this.disconnectStormLastRebootAtMs < cooldownMs
    )
      return;

    this.disconnectStormLastRebootAtMs = now;
    (this.logger.warn ?? this.logger.error).call(
      this.logger,
      "[ReolinkBaichuanApi] disconnect storm detected; rebooting device",
      {
        transport: info.transport,
        reason: info.reason,
        voluntaryDisconnectsInWindow: this.disconnectStormVoluntaryAtMs.length,
        windowMs,
        threshold,
        cooldownMs,
        method: "auto",
      },
    );

    this.disconnectStormRebootInFlight = this.rebootFromDisconnectStorm("auto")
      .catch((e) => {
        (this.logger.warn ?? this.logger.error).call(
          this.logger,
          "[ReolinkBaichuanApi] disconnect-storm reboot failed",
          e,
        );
      })
      .finally(() => {
        this.disconnectStormRebootInFlight = undefined;
      });
  }

  private async rebootFromDisconnectStorm(
    method: "auto" | "baichuan" | "cgi",
  ): Promise<void> {
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

    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "disconnect-storm reboot failed"));
  }

  /**
   * Subscribe to minimal high-level events.
   * The API manages Baichuan subscribe/unsubscribe automatically.
   */
  async onSimpleEvent(
    callback: (event: ReolinkSimpleEvent) => void | Promise<void>,
  ): Promise<void> {
    this.simpleEventListeners.add(callback);
    await this.ensureSimpleEventSubscribed();
    this.startSimpleEventResubscribeTimer();
  }

  /**
   * Remove one callback, or all callbacks if omitted.
   * When the last listener is removed, the API unsubscribes from Baichuan events.
   */
  async offSimpleEvent(
    callback?: (event: ReolinkSimpleEvent) => void | Promise<void>,
  ): Promise<void> {
    if (callback) {
      this.simpleEventListeners.delete(callback);
    } else {
      this.simpleEventListeners.clear();
    }

    if (this.simpleEventListeners.size === 0) {
      this.stopSimpleEventResubscribeTimer();
      this.stopUdpSleepInference();
      await this.ensureSimpleEventUnsubscribed();
    } else {
      // If there are still listeners, keep polling running (TCP only)
      const isUdp = this.client.getTransport?.() === "udp";
      if (isUdp) {
        this.startUdpSleepInference();
      } else if (this.client.isStatePollingEnabled?.()) {
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
    if (this.simpleEventResubscribeInFlight)
      return await this.simpleEventResubscribeInFlight;

    this.simpleEventResubscribeInFlight = (async () => {
      try {
        await this.subscribeEvents();
        this.simpleEventSubscribed = true;
        (this.logger.debug ?? this.logger.log).call(
          this.logger,
          "[ReolinkBaichuanApi] renewed simple event subscription",
          {
            intervalMs: this.simpleEventResubscribeIntervalMs,
          },
        );
      } catch (e) {
        (this.logger.debug ?? this.logger.log).call(
          this.logger,
          "[ReolinkBaichuanApi] failed to renew event subscription",
          e,
        );
      }
    })().finally(() => {
      this.simpleEventResubscribeInFlight = undefined;
    });

    return await this.simpleEventResubscribeInFlight;
  }

  private async ensureSimpleEventSubscribed(): Promise<void> {
    if (this.simpleEventListeners.size === 0) return;
    if (this.simpleEventSubscribed) return;
    if (this.simpleEventSubscribeInFlight)
      return await this.simpleEventSubscribeInFlight;

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
      if (isUdp) {
        // Passive sleep inference for UDP/battery cameras.
        // This does not send any requests and restores sleeping/awake events.
        this.startUdpSleepInference();
      } else if (this.client.isStatePollingEnabled?.()) {
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
    if (this.simpleEventUnsubscribeInFlight)
      return await this.simpleEventUnsubscribeInFlight;

    if (this.simpleEventSubscribeInFlight) {
      try {
        await this.simpleEventSubscribeInFlight;
      } catch {
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

      // Stop UDP sleep inference when unsubscribed.
      this.stopUdpSleepInference();
    })().finally(() => {
      this.simpleEventUnsubscribeInFlight = undefined;
    });

    return await this.simpleEventUnsubscribeInFlight;
  }

  private normalizeChannel(channel?: number | null): number {
    return channel == null ? 0 : channel;
  }

  /**
   * Returns the cached channel count, or fetches it from device capabilities if not cached.
   * - 1 = standalone camera
   * - >1 = NVR/Hub with multiple channels
   */
  async getChannelCount(): Promise<number> {
    if (this._channelCount !== undefined) {
      return this._channelCount;
    }

    try {
      const support = await this.getAbilitySupport(0);
      const channelNum =
        (support as Record<string, unknown>)?.AbilitySupport &&
        typeof (support as Record<string, unknown>).AbilitySupport === "object"
          ? ((support as Record<string, Record<string, unknown>>).AbilitySupport
              ?.channelNum as number | string | undefined)
          : undefined;

      if (channelNum !== undefined) {
        this._channelCount =
          typeof channelNum === "string"
            ? Number.parseInt(channelNum, 10)
            : channelNum;
      }
    } catch {
      // Ignore errors - will default to 1
    }

    // Default to 1 (standalone camera) if not determinable
    if (
      this._channelCount === undefined ||
      !Number.isFinite(this._channelCount)
    ) {
      this._channelCount = 1;
    }

    return this._channelCount;
  }

  /**
   * Determines if this device is an NVR/Hub (multiple channels) vs a standalone camera.
   * Checks:
   * 1. Channel count > 1 (typical NVR detection)
   * 2. Device model matches NVR/Hub patterns (for devices like Home Hub that report channelNum=1)
   */
  async isNvrDevice(): Promise<boolean> {
    const channelCount = await this.getChannelCount();
    if (channelCount > 1) return true;

    // Fallback: check device model for NVR/Hub patterns
    // Some devices (e.g., Home Hub) report channelNum=1 but are actually NVR/Hub
    try {
      const info = await this.getInfo(undefined, {
        tags: ["type"],
        timeoutMs: 5000,
      });
      if (info.type && isNvrHubModel(info.type)) {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] isNvrDevice: model "${info.type}" matches NVR/Hub pattern`,
        );
        return true;
      }
    } catch {
      // Ignore errors - model check is best-effort
    }

    return false;
  }

  async login(
    maxEncryption?: import("../../client/BaichuanClient.js").MaxEncryption,
  ): Promise<void> {
    await this.client.login(maxEncryption);
  }

  async close(options?: { reason?: string }): Promise<void> {
    // Stop state polling before closing
    this.stopStatePolling();
    this.stopUdpSleepInference();
    // Stop all RTSP servers before closing the client
    await this.cleanup();
    await this.client.close(
      options?.reason ? { reason: options.reason } : undefined,
    );
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
          this.logger.error(
            `[ReolinkBaichuanApi] Error stopping RTSP server during cleanup:`,
            error,
          );
        }
      }),
    );

    if (servers.length > 0) {
      this.logger.info(
        `[ReolinkBaichuanApi] Cleaned up ${servers.length} RTSP server(s)`,
      );
    }
  }

  /** Generic Baichuan cmd_id call, returns XML (if any). */
  async sendXml(
    params: Parameters<BaichuanClient["sendXml"]>[0],
    retry = 3,
  ): Promise<string> {
    // Only call login() if not already logged in (avoid recursion if called from login itself)
    if (!this.client.loggedIn) {
      await this.client.login();
    }

    // Use sendFrame to check responseCode and handle 400 errors with retry
    const frame = await this.client.sendFrame(params);
    if (frame.header.responseCode === 400) {
      return await this.handleSendXml400(params, frame, retry);
    }

    // Decrypt and return XML
    if (frame.body.length === 0) return "";
    return this.client.tryDecryptXml(
      frame.body,
      frame.header.channelId,
      this.client.enc,
    );
  }

  private isSendXmlFailFast400(
    params: Parameters<BaichuanClient["sendXml"]>[0],
    bodyLen: number,
  ): boolean {
    // Special cases for NVR/Hub firmwares: some commands may return 400 with an empty body
    // when unsupported (not just for auth/session issues). Retrying/login loops can stall tests.
    //
    // - FILE_INFO_LIST_GET with 400+empty body during pagination means "no more pages".
    // - FILE_INFO_LIST_OPEN with 400+empty body often means "FileInfoList unsupported" on NVRs.
    // In both cases, fail fast and let higher-level code fall back to findAlarmVideo/CGI.
    return (
      bodyLen === 0 &&
      (params.cmdId === BC_CMD_ID_FILE_INFO_LIST_GET ||
        params.cmdId === BC_CMD_ID_FILE_INFO_LIST_OPEN ||
        // Non-PTZ cameras commonly return 400+empty body for PTZ preset APIs.
        // Treat it as "unsupported" rather than triggering relogin loops.
        params.cmdId === BC_CMD_ID_GET_PTZ_PRESET)
    );
  }

  private async handleSendXml400(
    params: Parameters<BaichuanClient["sendXml"]>[0],
    frame: Awaited<ReturnType<BaichuanClient["sendFrame"]>>,
    retry: number,
  ): Promise<string> {
    const emptyBody = frame.body.length === 0;
    const emptyBody400Msg =
      "Baichuan request failed (responseCode 400, empty body). Possible causes: camera sleeping/waking (battery), expired session, invalid username/password, or unsupported command on NVR/Hub.";

    if (this.isSendXmlFailFast400(params, frame.body.length)) {
      throw new Error(emptyBody400Msg);
    }

    // Retry logic for 400 errors.
    // NOTE: several firmwares return responseCode=400 with empty body when the camera is sleeping,
    // waking up, or when the session has expired (not only for bad credentials).
    if (retry > 0) {
      // If the body is empty, try forcing a re-login once before backing off.
      // This helps for expired sessions while staying safe for sleeping cameras.
      // However, avoid re-login if the socket is not connected to prevent disconnection loops
      if (emptyBody) {
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
          await sleepMs(2000);
          return await this.sendXml(params, retry - 1);
        }
      }

      await sleepMs(1500);
      return await this.sendXml(params, retry - 1);
    }

    // Out of retries.
    if (emptyBody) {
      throw new Error(emptyBody400Msg);
    }

    // Some firmwares still send a body even with responseCode=400.
    return this.client.tryDecryptXml(
      frame.body,
      frame.header.channelId,
      this.client.enc,
    );
  }

  /**
   * Fetch TalkAbility (cmd_id=10) which describes supported two-way audio formats.
   * Uses MSG_ID_TALKABILITY.
   */
  async getTalkAbility(channel?: number): Promise<TalkAbility> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_TALK_ABILITY,
      ...(channel !== undefined ? { channel } : {}),
    });
    return parseTalkAbilityXml(xml);
  }

  /**
   * TalkReset via Baichuan: cmd_id 11 (MSG_ID_TALKRESET).
   * Mostly useful for recovering from responseCode=422 after TalkConfig.
   */
  async talkReset(
    channel = 0,
    options?: { channelIdOverride?: number },
  ): Promise<void> {
    await this.client.login();
    const ch = this.normalizeChannel(channel);

    const isUdp = this.client.getTransport?.() === "udp";
    const channelIdOverride =
      options?.channelIdOverride ?? (isUdp ? ch : undefined);

    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_TALK_RESET,
      channel: ch,
      ...(channelIdOverride != null ? { channelIdOverride } : {}),
      payloadXml: "",
      messageClass: BC_CLASS_MODERN_24,
    });

    if (frame.header.responseCode !== 200) {
      throw new Error(
        `TalkReset rejected (responseCode ${frame.header.responseCode})`,
      );
    }
  }

  /**
   * TalkConfig via Baichuan: cmd_id 201 (MSG_ID_TALKCONFIG).
   * Performs a TalkReset retry when the device responds with 422.
   */
  async talkConfig(
    payloadXml: string,
    channel = 0,
    options?: { channelIdOverride?: number },
  ): Promise<void> {
    await this.client.login();
    const ch = this.normalizeChannel(channel);

    const isUdp = this.client.getTransport?.() === "udp";
    const channelIdOverride =
      options?.channelIdOverride ?? (isUdp ? ch : undefined);

    const trySend = async (): Promise<number> => {
      const frame = await this.client.sendFrame({
        cmdId: BC_CMD_ID_TALK_CONFIG,
        channel: ch,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
        payloadXml,
        messageClass: BC_CLASS_MODERN_24,
      });
      return frame.header.responseCode;
    };

    const code = await trySend();
    if (code === 422) {
      await this.talkReset(
        ch,
        channelIdOverride != null ? { channelIdOverride } : undefined,
      );
      const retryCode = await trySend();
      if (retryCode !== 200) {
        throw new Error(
          `TalkConfig rejected after reset (responseCode ${retryCode})`,
        );
      }
      return;
    }

    if (code !== 200) {
      throw new Error(`TalkConfig rejected (responseCode ${code})`);
    }
  }

  /**
   * Create a talk (two-way audio) session.
   *
   * Input audio format expected by the camera is ADPCM (DVI4/IMA style) in blocks described
   * by TalkAbility.audioConfigList (typically 16kHz mono, lengthPerEncoder=1024).
   */
  async createTalkSession(
    channel = 0,
    options?: {
      blocksPerPayload?: number;
      /** Close the underlying socket when stop() completes (recommended for dedicated sessions). */
      closeSocketOnStop?: boolean;
    },
  ): Promise<TalkSession> {
    if (!this.client.loggedIn) await this.client.login();

    // BCUDP/battery firmwares often expect 0-based header channelId.
    // Talk is particularly sensitive because the binary Extension must be decrypted.
    const isUdp = this.client.getTransport?.() === "udp";
    const channelIdOverride = isUdp ? channel : undefined;

    const ability = await this.getTalkAbility(channel);
    const { payloadXml, info } = buildTalkSessionInfoFromAbility({
      channel,
      ability,
    });
    await sendTalkConfigWithReset({
      client: this.client,
      channel,
      payloadXml,
      ...(channelIdOverride != null ? { channelIdOverride } : {}),
    });

    return createBufferedTalkSession({
      client: this.client,
      channel,
      ...(channelIdOverride != null ? { channelIdOverride } : {}),
      info,
      ...(options?.blocksPerPayload != null
        ? { blocksPerPayload: options.blocksPerPayload }
        : {}),
      ...(options?.closeSocketOnStop != null
        ? { closeSocketOnStop: options.closeSocketOnStop }
        : {}),
    });
  }

  /** Generic Baichuan cmd_id call, returns binary data (for commands like Snap). */
  async sendBinary(
    params: Parameters<BaichuanClient["sendBinary"]>[0],
  ): Promise<Buffer> {
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
    const protoBlocks = xml.matchAll(
      /<([A-Za-z]+)Port[^>]*>([\s\S]*?)<\/\1Port>/g,
    );
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
  async setPortEnabled(params: {
    port: "rtsp" | "rtmp" | "onvif" | "http" | "https";
    enable: boolean;
  }): Promise<void> {
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
      /** Optional message class override for older firmwares (e.g. 0x6614). */
      messageClass?: number;
      /** List of XML tags to extract. Defaults to the canonical minimal set. */
      tags?: ReolinkDeviceInfoTag[];
    },
  ): Promise<Partial<ReolinkDeviceInfo>> {
    const req: {
      cmdId: number;
      channel?: number;
      timeoutMs?: number;
      messageClass?: number;
    } = { cmdId: channel == null ? 80 : 318 };
    if (channel !== undefined) req.channel = channel;
    if (options?.timeoutMs != null) req.timeoutMs = options.timeoutMs;
    if (options?.messageClass != null) req.messageClass = options.messageClass;
    const xml = await this.sendXml(req);
    // Canonical minimal set: type, hardwareVersion, firmwareVersion, itemNo, serialNumber, name
    const tags = options?.tags?.length
      ? options.tags
      : [
          "type",
          "hardwareVersion",
          "firmwareVersion",
          "itemNo",
          "serialNumber",
          "name",
        ];
    return getXmlTexts(xml, tags);
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
    const channelBlocks = getXmlBlocks(xml, "ChannelInfo");
    const iotBlocks = getXmlBlocks(xml, "IOTInfo");
    const allBlocks = [...channelBlocks, ...iotBlocks];

    this.logger.debug?.(
      `[ReolinkBaichuanApi] cmd_id 145 ChannelInfo push: blocks=${JSON.stringify(allBlocks)}`,
    );

    const entries = parseChannelInfoPushBlocks(allBlocks);
    const nowMs = Date.now();

    for (const entry of entries) {
      const existing = this.channelPushData.get(entry.channel);
      const { shouldSkip, next, events } = computeChannelPushUpdateFromEntry({
        entry,
        existing,
        nowMs,
      });
      if (shouldSkip || !next) continue;

      for (const evt of events) {
        this.dispatchSimpleEvent(evt);
      }
      this.channelPushData.set(entry.channel, next);
    }

    if (entries.length > 0) {
      const snap = buildChannelPushDataLogSnapshot(this.channelPushData);
      this.logger.debug?.(
        `[ReolinkBaichuanApi] Channel info received by the NVR: ${JSON.stringify(snap)}`,
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
  ): Promise<ReolinkBaichuanChannelInfo> {
    const req: { cmdId: number; channel: number; timeoutMs?: number } = {
      cmdId: 318,
      channel,
    };
    if (options?.timeoutMs != null) req.timeoutMs = options.timeoutMs;
    const xml = await this.sendXml(req);

    // Extract fields similar to CgiChnTypeInfoValue
    // typeInfo can come from <type> tag in Baichuan response
    const typeInfo = getXmlText(xml, "typeInfo") ?? getXmlText(xml, "type");
    const firmVer =
      getXmlText(xml, "firmVer") ?? getXmlText(xml, "firmwareVersion");
    const firmwareVersion = firmVer || "";
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
  }): Promise<Map<number, ReolinkBaichuanChannelInfo>> {
    // Try with empty body XML first
    const req: { cmdId: number; payloadXml?: string; timeoutMs?: number } = {
      cmdId: BC_CMD_ID_CHANNEL_INFO_ALL,
      payloadXml: `<?xml version="1.0" encoding="UTF-8" ?><body></body>`,
    };
    if (options?.timeoutMs != null) req.timeoutMs = options.timeoutMs;

    let xml = await this.sendXml(req);

    // If empty response, try without body XML
    if (!xml || xml.trim().length === 0) {
      const reqNoBody: { cmdId: number; timeoutMs?: number } = {
        cmdId: BC_CMD_ID_CHANNEL_INFO_ALL,
      };
      if (options?.timeoutMs != null) reqNoBody.timeoutMs = options.timeoutMs;
      xml = await this.sendXml(reqNoBody);
    }

    // If still empty, the command is likely not supported (NVR sends it but doesn't allow requesting it)
    if (!xml || xml.trim().length === 0) {
      return new Map();
    }

    const result = new Map<number, ReolinkBaichuanChannelInfo>();

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
      const channelText =
        getXmlText(block, "channel") ??
        getXmlText(block, "channelId") ??
        getXmlText(block, "id");
      const channel = channelText
        ? Number.parseInt(channelText, 10)
        : undefined;

      if (channel === undefined || !Number.isFinite(channel)) {
        // If no explicit channel number, try to infer from position or skip
        continue;
      }

      // Extract fields similar to getChannelInfo
      const typeInfo =
        getXmlText(block, "typeInfo") ?? getXmlText(block, "type");
      const firmVer =
        getXmlText(block, "firmVer") ?? getXmlText(block, "firmwareVersion");
      const firmwareVersion = firmVer || "";
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
            const typeInfo =
              getXmlText(bodyBlock, "typeInfo") ??
              getXmlText(bodyBlock, "type");
            const firmVer =
              getXmlText(bodyBlock, "firmVer") ??
              getXmlText(bodyBlock, "firmwareVersion");
            const firmwareVersion = firmVer || "";
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
  ): Promise<ReolinkBaichuanChannelIdentity> {
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
  getChannelInfoFromPushCache(): Map<number, ChannelPushCacheEntry> {
    const out = new Map<number, ChannelPushCacheEntry>();
    for (const [channel, info] of this.channelPushData.entries()) {
      const stateLower = (info.stateLower ?? info.state).toLowerCase();
      if (stateLower === "none") continue;
      out.set(channel, {
        name: info.name,
        uid: info.uid,
        state: info.state,
        ...(typeof info.index === "number" ? { index: info.index } : {}),
        ...(info.streamSupport?.length
          ? { streamSupport: info.streamSupport }
          : {}),
        ...(info.wifiState ? { wifiState: info.wifiState } : {}),
        ...(info.networkSegment ? { networkSegment: info.networkSegment } : {}),
        ...(typeof info.changed === "boolean" ? { changed: info.changed } : {}),
        ...(typeof info.abilityChanged === "boolean"
          ? { abilityChanged: info.abilityChanged }
          : {}),
        ...(typeof info.online === "boolean" ? { online: info.online } : {}),
        ...(typeof info.sleeping === "boolean"
          ? { sleeping: info.sleeping }
          : {}),
        ...(info.loginState ? { loginState: info.loginState } : {}),
        ...(typeof info.updatedAtMs === "number"
          ? { updatedAtMs: info.updatedAtMs }
          : {}),
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
  }): Promise<NvrChannelsSummaryCacheEntry> {
    const source = options?.source ?? "baichuan";

    const pushInfo = this.getChannelInfoFromPushCache();
    const channels = (
      options?.channels?.length ? options.channels : Array.from(pushInfo.keys())
    )
      .map((c) => Number(c))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    const support = await this.getSupportInfo().catch(() => {
      this.logger.error?.(
        "[ReolinkBaichuanApi] getNvrChannelsSummary: failed to get support info",
      );
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
          (i) => i.chnID === ch && truthyNumberLike(i["supportDoorbellLight"]),
        );
        isDoorbellByChannel.set(
          ch,
          Boolean(caps.isDoorbell) || anySupportDoorbellLight,
        );
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
    const networkInfoPerChannel = new Map<
      number,
      ReolinkBaichuanNetworkInfo | undefined
    >();
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
      } catch {}
    }

    const devices = channels.map((channel) => {
      const cached = pushInfo.get(channel);
      const info = infoPerChannel.get(channel);
      const networkInfo = networkInfoPerChannel.get(channel);
      const isBattery = isBatteryByChannel.get(channel) ?? false;
      const model = info?.type ?? "";
      const isDoorbell =
        (isDoorbellByChannel.get(channel) ?? false) || /doorbell/i.test(model);

      const normalizedModel = model ? model.trim() : undefined;
      const isMultifocal = normalizedModel
        ? isDualLenseModel(normalizedModel)
        : false;

      return {
        channel,
        isBattery,
        isDoorbell,
        isMultifocal,
        model,
        ...(networkInfo?.ip ? { ip: networkInfo.ip } : {}),
        ...(networkInfo?.mac ? { mac: networkInfo.mac } : {}),
        ...(networkInfo?.activeLink
          ? { activeLink: networkInfo.activeLink }
          : {}),
        ...(cached?.name ? { name: cached.name } : {}),
        ...(cached?.uid ? { uid: cached.uid } : {}),
        ...(cached?.state ? { state: cached.state } : {}),
        ...(typeof cached?.index === "number" ? { index: cached.index } : {}),
        ...(cached?.streamSupport?.length
          ? { streamSupport: cached.streamSupport }
          : {}),
        ...(cached?.wifiState ? { wifiState: cached.wifiState } : {}),
        ...(cached?.networkSegment
          ? { networkSegment: cached.networkSegment }
          : {}),
        ...(typeof cached?.changed === "boolean"
          ? { changed: cached.changed }
          : {}),
        ...(typeof cached?.abilityChanged === "boolean"
          ? { abilityChanged: cached.abilityChanged }
          : {}),
        ...(typeof cached?.online === "boolean"
          ? { online: cached.online }
          : {}),
        ...(typeof cached?.sleeping === "boolean"
          ? { sleeping: cached.sleeping }
          : {}),
        ...(cached?.loginState ? { loginState: cached.loginState } : {}),
        ...(typeof cached?.updatedAtMs === "number"
          ? { updatedAtMs: cached.updatedAtMs }
          : {}),
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
  }): Promise<ReolinkNvrDeviceGroupsResult> {
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

    type MutableGroup = Omit<
      ReolinkNvrDeviceGroupSummary,
      "channels" | "isMultifocal" | "reason"
    > & {
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
      let key = uid
        ? `uid:${uid}`
        : serial
          ? `sn:${serial}`
          : `ch:${d.channel}`;
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

    const groups: ReolinkNvrDeviceGroupSummary[] = Array.from(
      groupsByKey.values(),
    )
      .map((g) => {
        g.channels.sort((a, b) => a - b);
        const name = finalizeName(g);
        const model = finalizeModel(g);
        const isMultifocal =
          g.channels.length > 1 || looksLikeDualLensModel(model);
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
  async getEncXml(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<string> {
    const ch = this.normalizeChannel(channel);
    return await this.sendXml({
      cmdId: 56,
      channel: ch,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
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
    const dbg = this.client.getDebugConfig?.();
    return parseChannelStreamMetadataFromGetEncXml({
      channel: ch,
      xml,
      logger: this.logger,
      traceNativeStream: dbg?.traceNativeStream === true,
    });
  }

  /** SetEnc via Baichuan: cmd_id 57 (sends raw XML). */
  async setEncXml(encXml: string): Promise<void>;
  async setEncXml(channel: number, encXml: string): Promise<void>;
  async setEncXml(
    channelOrEncXml: number | string,
    encXmlMaybe?: string,
  ): Promise<void> {
    const ch =
      typeof channelOrEncXml === "number"
        ? this.normalizeChannel(channelOrEncXml)
        : 0;
    const encXml =
      typeof channelOrEncXml === "number" ? encXmlMaybe! : channelOrEncXml;
    await this.sendXml({ cmdId: 57, channel: ch, payloadXml: encXml });
  }

  /**
   * Update the encoder codec for a given stream profile (main/sub/ext).
   *
   * NOTE: This changes the camera configuration.
   * Many models may require a short delay (or stream restart) before the new codec is used.
   */
  async setStreamVideoCodec(
    profile: StreamProfile,
    codec: "H.264" | "H.265",
    channel?: number,
  ): Promise<void>;
  async setStreamVideoCodec(
    channel: number,
    profile: StreamProfile,
    codec: "H.264" | "H.265",
  ): Promise<void>;
  async setStreamVideoCodec(
    channelOrProfile: number | StreamProfile,
    profileOrCodec: StreamProfile | ("H.264" | "H.265"),
    codecOrChannel?: ("H.264" | "H.265") | number,
  ): Promise<void> {
    const ch =
      typeof channelOrProfile === "number"
        ? this.normalizeChannel(channelOrProfile)
        : this.normalizeChannel(codecOrChannel as number | undefined);
    const profile =
      typeof channelOrProfile === "number"
        ? (profileOrCodec as StreamProfile)
        : channelOrProfile;
    const codec =
      typeof channelOrProfile === "number"
        ? (codecOrChannel as "H.264" | "H.265")
        : (profileOrCodec as "H.264" | "H.265");
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
      const sectionRe = new RegExp(
        `(<${tag}[^>]*>[\\s\\S]*?<videoEncType>)(\\d+)(</videoEncType>)`,
      );
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
  async setNetPort(netPort: {
    onvifEnable?: number;
    rtmpEnable?: number;
    rtspEnable?: number;
  }): Promise<void> {
    if (netPort.onvifEnable != null)
      await this.setPortEnabled({
        port: "onvif",
        enable: netPort.onvifEnable === 1,
      });
    if (netPort.rtmpEnable != null)
      await this.setPortEnabled({
        port: "rtmp",
        enable: netPort.rtmpEnable === 1,
      });
    if (netPort.rtspEnable != null)
      await this.setPortEnabled({
        port: "rtsp",
        enable: netPort.rtspEnable === 1,
      });
  }

  /** Reboot via Baichuan: cmd_id 23 */
  async reboot(channel?: number): Promise<void> {
    const req: { cmdId: number; channel?: number } = { cmdId: 23 };
    if (channel !== undefined) req.channel = channel;
    await this.sendXml(req);
  }

  /** Ping via Baichuan: cmd_id 93 (header-only / no payload) */
  async ping(): Promise<void> {
    await this.sendXml({ cmdId: BC_CMD_ID_PING });
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
      const mac =
        trim(getXmlText(xml, "mac")) ||
        trim(getXmlText(xml, "MAC")) ||
        undefined;
      const activeLink =
        trim(getXmlText(xml, "activeLink")) ||
        trim(getXmlText(xml, "type")) ||
        trim(getXmlText(xml, "linkType")) ||
        undefined;
      return ip || mac || activeLink
        ? {
            ...(ip ? { ip } : {}),
            ...(mac ? { mac } : {}),
            ...(activeLink ? { activeLink } : {}),
          }
        : undefined;
    };

    const merge = (
      a?: ReolinkBaichuanNetworkInfo,
      b?: ReolinkBaichuanNetworkInfo,
    ): ReolinkBaichuanNetworkInfo | undefined => {
      if (!a && !b) return undefined;
      return {
        ...(a?.ip ? { ip: a.ip } : b?.ip ? { ip: b.ip } : {}),
        ...(a?.mac ? { mac: a.mac } : b?.mac ? { mac: b.mac } : {}),
        ...(a?.activeLink
          ? { activeLink: a.activeLink }
          : b?.activeLink
            ? { activeLink: b.activeLink }
            : {}),
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
  async setGeneralXml(
    channelOrXml: number | string | undefined,
    xmlMaybe?: string,
  ): Promise<void> {
    const channel =
      typeof channelOrXml === "number" || channelOrXml === undefined
        ? channelOrXml
        : undefined;
    const xml = typeof channelOrXml === "string" ? channelOrXml : xmlMaybe!;
    await this.sendXml({
      cmdId: 105,
      ...(channel === undefined ? {} : { channel }),
      payloadXml: xml,
    });
  }

  /** Helper to build a channel Extension XML (for payloads that require it). */
  static buildChannelExtensionXml(channel: number): string {
    return (
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<Extension version="1.1"><channelId>${xmlEscape(String(channel))}</channelId></Extension>`
    );
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
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_MOTION_ALARM,
      ...(channel !== undefined ? { channel } : {}),
    });
    // Parse XML to extract motion state from sensInfoNew
    // Expected format: <sensInfoNew><enable>1</enable>...</sensInfoNew>
    const enable = getXmlText(xml, "enable");
    return enable === "1" || enable === "true";
  }

  /**
   * GetMdAlarm via Baichuan.
   * cmd_id: 46 (GetMdAlarm)
   * Returns the response parsed as JSON (no XML exposure).
   */
  async getMotionAlarm(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_MOTION_ALARM,
      ...(channel !== undefined ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  /**
   * SetMdAlarm via Baichuan.
   * cmd_id: 47 (SetMdAlarm)
   * Alias of `setMotionDetection()`.
   */
  async setMotionAlarm(
    enabled: boolean,
    sensitivity?: number,
    channel?: number,
  ): Promise<void>;
  async setMotionAlarm(
    channel: number,
    enabled: boolean,
    sensitivity?: number,
  ): Promise<void>;
  async setMotionAlarm(
    arg1: number | boolean,
    arg2?: boolean | number,
    arg3?: number,
  ): Promise<void> {
    // Delegate to preserve the existing logic (read-modify-write using GetMdAlarm + SetMdAlarm).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.setMotionDetection as any)(
      arg1 as any,
      arg2 as any,
      arg3 as any,
    );
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
  async setOsd(
    channelOrOsd: number | OsdConfig,
    osdMaybe?: OsdConfig | number,
  ): Promise<void> {
    const ch =
      typeof channelOrOsd === "number"
        ? this.normalizeChannel(channelOrOsd)
        : this.normalizeChannel(osdMaybe as number | undefined);
    const osd =
      typeof channelOrOsd === "number" ? (osdMaybe as OsdConfig) : channelOrOsd;
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
    const ch = this.normalizeChannel(channel);
    const candidateTypes = await this.getAiAlarmCandidateTypes(ch);
    return await getAiStateViaGetAiAlarm({
      sendXml: (p, retry) => this.sendXml(p, retry),
      channel: ch,
      ...(candidateTypes && candidateTypes.length > 0
        ? { candidateTypes }
        : {}),
    });
  }

  /** Alias for `getAiState()` (cmd_id 342, GetAiAlarm). */
  async getAiAlarm(channel?: number): Promise<AIState> {
    return await this.getAiState(channel);
  }

  /**
   * Raw GetAiAlarm (cmd_id 342) returning parsed JSON.
   * Useful to inspect full payload without exposing XML.
   */
  async getAiAlarmRaw(
    channel: number,
    aiType: string,
    options?: { timeoutMs?: number; channelIdOverride?: number },
  ): Promise<XmlJsonValue> {
    const ch = this.normalizeChannel(channel);
    const payloadXml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<AiDetectCfg version="1.1">` +
      `<chn>${ch}</chn>` +
      `<type>${xmlEscape(aiType)}</type>` +
      `</AiDetectCfg>` +
      `</body>`;

    const xml = await this.sendXml(
      {
        cmdId: BC_CMD_ID_GET_AI_ALARM,
        channel: ch,
        payloadXml,
        ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.channelIdOverride != null
          ? { channelIdOverride: options.channelIdOverride }
          : {}),
      },
      0,
    );

    return parseXmlFragmentToJson(xml);
  }

  private normalizeAiDetectTypeForGetAiAlarm(type: string): string[] {
    const raw = (type ?? "").trim();
    if (!raw) return [];

    const t = raw.toLowerCase();
    if (!t || t === "none") return [];

    // cmd 299 (<detectType>) and cmd 342 (<type>) are not always identical across firmwares.
    // Keep a small, safe normalization map and still try the original token.
    const canonicalMap: Record<string, string> = {
      person: "people",
      people: "people",
      car: "vehicle",
      vehicle: "vehicle",
      pet: "dog_cat",
      animal: "dog_cat",
      dog_cat: "dog_cat",
      face: "face",
      package: "package",
    };

    const canonical = canonicalMap[t] ?? t;
    if (canonical === t) return [canonical];
    return [canonical, t];
  }

  private async getAiDetectTypesCached(
    channel: number,
  ): Promise<string[] | undefined> {
    const now = Date.now();
    const cached = this.aiDetectTypesCache.get(channel);
    // Avoid hammering cmd 299; cache both success and "unknown" briefly.
    if (cached && now - cached.updatedAtMs < 5 * 60_000) {
      return cached.types;
    }

    const detectTypes = await this.getAiDetectTypes(channel, {
      timeoutMs: 1500,
    });
    this.aiDetectTypesCache.set(
      channel,
      detectTypes != null
        ? { types: detectTypes, updatedAtMs: now }
        : { updatedAtMs: now },
    );

    return detectTypes;
  }

  private async resolveAiTypeForSetAiDetection(
    channel: number,
    requestedAiType: string,
  ): Promise<string> {
    const req = (requestedAiType ?? "").trim();
    if (!req) return "people";

    const requestedCandidates = this.normalizeAiDetectTypeForGetAiAlarm(req);
    const detectTypes = await this.getAiDetectTypesCached(channel);

    if (detectTypes && detectTypes.length > 0) {
      const supported = new Set(
        detectTypes
          .flatMap((t) => this.normalizeAiDetectTypeForGetAiAlarm(t))
          .map((t) => t.toLowerCase()),
      );

      for (const c of requestedCandidates) {
        if (supported.has(c.toLowerCase())) return c;
      }
    }

    // Fall back to canonical requested candidate (still better than raw).
    return requestedCandidates[0] ?? req;
  }

  private async getAiAlarmCandidateTypes(
    channel: number,
  ): Promise<string[] | undefined> {
    const now = Date.now();
    const cached = this.aiAlarmCandidateTypesCache.get(channel);
    // Avoid hammering during polling; cache both success and "unknown" briefly.
    if (cached && now - cached.updatedAtMs < 5 * 60_000) {
      return cached.types;
    }

    const detectTypes = await this.getAiDetectTypesCached(channel);
    const fromDetectTypes = (detectTypes ?? []).flatMap((t) =>
      this.normalizeAiDetectTypeForGetAiAlarm(t),
    );

    // Always keep a conservative fallback list at the end.
    const fallback = ["people", "vehicle", "dog_cat", "face", "package"];
    const all = [...fromDetectTypes, ...fallback]
      .map((s) => s.trim())
      .filter(Boolean);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const t of all) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(t);
    }

    const types = deduped.length > 0 ? deduped : undefined;
    this.aiAlarmCandidateTypesCache.set(
      channel,
      types != null ? { types, updatedAtMs: now } : { updatedAtMs: now },
    );
    return types;
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
      const pipSize = Math.min(
        0.9,
        Math.max(0.05, Number.isFinite(pipSizeRaw) ? pipSizeRaw : 0.25),
      );
      const onNvr = options?.onNvr === true || composite?.onNvr === true;
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

      let wideImg: Awaited<ReturnType<typeof Jimp.read>>;
      let teleImg: Awaited<ReturnType<typeof Jimp.read>>;
      try {
        wideImg = await Jimp.read(wide);
      } catch {
        // If we can't determine dimensions, return wide snapshot.
        return wide;
      }

      try {
        teleImg = await Jimp.read(tele);
      } catch {
        // If tele cannot be decoded, fall back to wide.
        return wide;
      }

      const mainW = wideImg.bitmap.width;
      const mainH = wideImg.bitmap.height;
      const teleW = teleImg.bitmap.width;
      const teleH = teleImg.bitmap.height;

      const pipMarginPx = resolvePipMarginPx(
        mainW,
        mainH,
        composite?.pipMargin,
        10,
      );

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

      // Resize to exact PiP bounds (we already computed aspect-aware sizes).
      teleImg.resize({ w: pipW, h: pipH });

      wideImg.composite(teleImg, left, top);
      return await wideImg.getBuffer(JimpMime.jpeg, { quality: 80 });
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
    const buildSnapXml = (params: {
      channelIdTag: number;
      logicChannel: number;
    }) =>
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
      const headerChannelIdOverrideCandidates: Array<number | undefined> = [
        0,
        ch,
        undefined,
      ];

      let lastErr: unknown;
      for (const headerChannelIdOverride of headerChannelIdOverrideCandidates) {
        for (const channelIdTag of channelIdTagCandidates) {
          for (const lc of logicChannelCandidates) {
            try {
              return await this.client.sendBinary({
                cmdId,
                channel: ch,
                ...(headerChannelIdOverride !== undefined
                  ? { channelIdOverride: headerChannelIdOverride }
                  : {}),
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

      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr ?? "getSnapshot failed"));
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
   * Get videoclips via Baichuan FileInfoList.
   *
   * This unified method works for both NVR and standalone cameras.
   * - For NVR: channel is required, UID is obtained from push cache
   * - For standalone cameras: channel defaults to 0, UID is discovered via getInfo()
   *
   * The method automatically detects whether a channel-specific UID is available
   * (NVR mode) or falls back to device-level UID discovery (standalone mode).
   *
   * Flow:
   * - cmdId=14: open search -> returns <handle>
   * - cmdId=15: get pages -> returns file list and optional <bFinished>
   * - cmdId=16: close handle
   *
   * @example
   * ```ts
   * // NVR usage (channel required)
   * const clips = await api.getVideoclips({
   *   channel: 0,
   *   start: new Date(Date.now() - 24 * 60 * 60 * 1000),
   *   end: new Date(),
   * });
   *
   * // Standalone camera (channel optional, defaults to 0)
   * const clips = await api.getVideoclips({
   *   start: new Date(Date.now() - 24 * 60 * 60 * 1000),
   *   end: new Date(),
   * });
   * ```
   */
  async getVideoclips(params: GetVideoclipsParams): Promise<RecordingFile[]> {
    return await this.enqueueRecordingsOperation(async () => {
      const dbg = this.client.getDebugConfig?.();
      const logger = this.logger;

      const channel = this.normalizeChannel(params.channel ?? 0);

      // Discover UID: try explicit -> channel-specific (NVR) -> device-level (standalone)
      const uid = await this.ensureUidForRecordings(channel, params.uid);

      // Reolink cameras organize recordings per-day.
      // Ensure start and end are always on the same day by forcing end to 23:59:59 of start's day.
      const start = params.start;
      const endOfStartDay = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate(),
        23,
        59,
        59,
        999,
      );
      // Use the earlier of params.end or end-of-start-day
      const end =
        params.end.getTime() > endOfStartDay.getTime()
          ? endOfStartDay
          : params.end;

      recordingsTraceLog(
        dbg,
        logger,
        "getVideoclips",
        `Query: start=${start.toISOString()}, end=${end.toISOString()} (forced same day)`,
      );

      recordingsTraceLog(
        dbg,
        logger,
        "getVideoclips",
        `Using UID for channel ${channel}: ${uid}`,
      );

      const streamType = params.streamType ?? "subStream";
      const recordType =
        params.recordType ??
        "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package";
      const maxIterations = params.maxIterations ?? 50;

      const headerChannelIdOverride =
        this.resolveHeaderChannelIdForLogicalChannel(channel);

      const files = await listRecordingsViaFileInfoList({
        sendXml: (p) =>
          this.sendXml({
            ...p,
            ...(headerChannelIdOverride != null && p.channel != null
              ? { channelIdOverride: headerChannelIdOverride }
              : {}),
          }),
        channel,
        uid,
        streamType,
        recordType,
        start,
        end,
        maxIterations,
        ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
      });

      const unique = dedupeRecordingFiles(files);
      recordingsTraceLog(
        dbg,
        logger,
        "getVideoclips",
        `FileInfoList complete: ${unique.length} unique files (from ${files.length} total)`,
      );
      return unique;
    });
  }

  /**
   * Start a recording replay stream over Baichuan push frames.
   *
   * Socket-based equivalent of a “clip playback”: the device will push BcMedia frames
   * on cmdId=5, and you must stop it with cmdId=7.
   */
  /**
   * Start a recording replay stream for STANDALONE cameras (non-NVR).
   * Uses exact parameters from PCAP analysis:
   * - Uses hostChannelId (header channelId) - do NOT force 0
   * - msgClass = BC_CLASS_MODERN_24 (0x6414)
   * - streamType = 0
   * - NO extensionXml
   */
  private async startRecordingReplayStreamStandalone(params: {
    channel: number;
    fileName: string;
    streamType: RecordingReplayStreamType;
    timeoutMs: number;
    logger?: Logger;
  }): Promise<{
    msgNum: number;
    stream: BaichuanVideoStream;
    stop: () => Promise<void>;
  }> {
    const channel = params.channel;
    const streamType = params.streamType;

    // Get UID for the recording (like download does)
    const uid = await this.ensureUidForRecordings(channel, undefined);

    // Build payload XML - standalone uses filename (name attribute)
    // Include UID like the working download method does
    // For standalone cameras, use xmlChannelId=0 explicitly
    const payloadXml = buildFileInfoListReplayByNameXml({
      channel,
      xmlChannelId: 0, // PCAP-verified: xmlChannelId=0 for standalone
      name: params.fileName,
      uid,
      streamType,
    });

    // Use msgNum=0 like the working download method
    const msgNum = 0;
    this.client.subscribeVideoStream(BC_CMD_ID_FILE_INFO_LIST_REPLAY, msgNum);

    const profile: StreamProfile = streamType === "subStream" ? "sub" : "main";
    const stream = new BaichuanVideoStream({
      client: this.client,
      channel,
      profile,
      variant: "default",
      cmdId: BC_CMD_ID_FILE_INFO_LIST_REPLAY,
      msgNum,
      acceptAnyStreamType: true,
      logger: params.logger ?? this.logger,
    });

    let started = false;
    try {
      await stream.start();

      // PCAP-verified parameters (192.168.1.170, 192.168.50.226):
      // - channelIdOverride should be a session counter (incrementing), not 0 or channel+1
      // - Some H265 cameras reject channelId=0 with responseCode=400
      // - messageClass = BC_CLASS_MODERN_24 (0x6414)
      // - NO extensionXml
      const sessionCounter = this.client.reserveNextMsgNum();
      const frame = await this.client.sendFrame({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_REPLAY,
        channel,
        channelIdOverride: sessionCounter,
        payloadXml,
        messageClass: BC_CLASS_MODERN_24,
        msgNumOverride: 0,
        timeoutMs: params.timeoutMs,
        internal: true,
      });

      if (frame.header.responseCode !== 200) {
        throw new Error(
          `Standalone replay rejected (response_code=${frame.header.responseCode})`,
        );
      }

      started = true;
    } catch (e) {
      try {
        await stream.stop();
      } catch {
        // ignore
      }
      try {
        this.client.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }
      throw e;
    }

    const stop = async (): Promise<void> => {
      const stopName = buildReplayStopNameFromFileName(params.fileName);
      if (started && stopName) {
        try {
          const stopXml = buildFileInfoListStopXml({
            channel,
            name: stopName,
            streamType,
          });

          await this.client.sendXml({
            cmdId: BC_CMD_ID_FILE_INFO_LIST_STOP,
            channel,
            payloadXml: stopXml,
            messageClass: BC_CLASS_MODERN_24,
            timeoutMs: 10_000,
            internal: true,
          });
        } catch {
          // ignore
        }
      }

      try {
        this.client.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }

      await stream.stop();
    };

    return { msgNum, stream, stop };
  }

  /**
   * Start a recording replay stream for NVR devices.
   * Uses exact parameters from PCAP analysis (192.168.1.161):
   * - channelIdOverride = 0 (header channelId)
   * - msgClass = BC_CLASS_MODERN_24 (0x6414)
   * - streamType = 0
   * - NO extensionXml
   * - Uses id (path) in XML payload, not name
   * - Requires UID for channel mapping
   */
  private async startRecordingReplayStreamNvr(params: {
    channel: number;
    fileName: string;
    streamType: RecordingReplayStreamType;
    timeoutMs: number;
    logger?: Logger;
  }): Promise<{
    msgNum: number;
    stream: BaichuanVideoStream;
    stop: () => Promise<void>;
  }> {
    const channel = params.channel;
    const streamType = params.streamType;

    // NVR needs UID for channel mapping
    let uid: string | undefined;
    try {
      uid = await this.ensureUidForRecordings(channel, undefined);
    } catch {
      // Continue without UID
    }

    // Resolve header channel ID for NVR (like download does)
    const headerChannelIdOverride =
      this.resolveHeaderChannelIdForLogicalChannel(channel);

    // Build payload XML - NVR uses id (path) attribute
    // PCAP (fileInfoListReplayBinaryDownload): xmlChannelId=0 works for NVR
    const payloadXml = buildFileInfoListReplayByIdXml({
      channel,
      xmlChannelId: 0, // PCAP-verified: xmlChannelId=0 works for NVR
      id: params.fileName,
      ...(uid ? { uid } : {}),
      streamType,
    });

    // PCAP-verified: NVR replay uses msgNum=0 (like download)
    const msgNum = 0;
    this.client.subscribeVideoStream(BC_CMD_ID_FILE_INFO_LIST_REPLAY, msgNum);

    const profile: StreamProfile = streamType === "subStream" ? "sub" : "main";
    const stream = new BaichuanVideoStream({
      client: this.client,
      channel,
      profile,
      variant: "default",
      cmdId: BC_CMD_ID_FILE_INFO_LIST_REPLAY,
      msgNum,
      acceptAnyStreamType: true,
      logger: params.logger ?? this.logger,
    });

    let started = false;
    try {
      await stream.start();

      // For NVR, use the resolved headerChannelId or 82.
      // For standalone cameras, use a session counter (like CoverPreview does).
      // PCAP analysis shows some cameras (e.g. H265) reject channelId=0 or channel+1.
      const isNvr = headerChannelIdOverride != null;
      const channelIdOverride = isNvr
        ? (headerChannelIdOverride ?? 82)
        : this.client.reserveNextMsgNum();

      const frame = await this.client.sendFrame({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_REPLAY,
        channel,
        channelIdOverride,
        payloadXml,
        // PCAP-verified: NO extension XML for NVR replay (payloadOffset=0)
        extensionXml: "",
        messageClass: BC_CLASS_MODERN_24,
        msgNumOverride: msgNum,
        timeoutMs: params.timeoutMs,
        internal: true,
      });

      if (frame.header.responseCode !== 200) {
        throw new Error(
          `NVR replay rejected (response_code=${frame.header.responseCode}) channelIdOverride=${channelIdOverride}`,
        );
      }

      started = true;
    } catch (e) {
      try {
        await stream.stop();
      } catch {
        // ignore
      }
      try {
        this.client.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }
      throw e;
    }

    const stop = async (): Promise<void> => {
      const stopName = buildReplayStopNameFromFileName(params.fileName);
      if (started && stopName) {
        try {
          const stopXml = buildFileInfoListStopXml({
            channel,
            name: stopName,
            streamType,
          });

          await this.client.sendXml({
            cmdId: BC_CMD_ID_FILE_INFO_LIST_STOP,
            channel,
            payloadXml: stopXml,
            messageClass: BC_CLASS_MODERN_24,
            timeoutMs: 10_000,
            internal: true,
          });
        } catch {
          // ignore
        }
      }

      try {
        this.client.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }

      await stream.stop();
    };

    return { msgNum, stream, stop };
  }

  /**
   * Start a recording replay stream.
   * Dispatches to the appropriate method based on fileName format:
   * - NVR recordings have "/" in the path (e.g., "/mnt/...")
   * - Standalone recordings are just filenames
   *
   * NOTE: Only one replay stream can be active at a time on a single socket connection.
   * Use enqueueReplayOperation() to serialize access.
   */
  async startRecordingReplayStream(params: {
    /** Channel number. Optional for standalone cameras (defaults to 0). Required for NVR. */
    channel?: number;
    fileName: string;
    timeoutMs?: number;
    logger?: Logger;
    /**
     * Force NVR mode (uses id-based XML with UID) or standalone mode (name-based XML).
     * If not specified, the library will detect based on device channel count:
     * - channelCount=1 → standalone camera
     * - channelCount>1 → NVR/Hub
     * NOTE: A path containing "/" does NOT indicate NVR - standalone cameras also return full paths.
     */
    isNvr?: boolean;
  }): Promise<{
    msgNum: number;
    stream: BaichuanVideoStream;
    stop: () => Promise<void>;
  }> {
    await this.client.login();

    // For standalone, default to channel 0. For NVR, channel is required.
    const channel = this.normalizeChannel(params.channel ?? 0);
    // Auto-detect streamType from fileName
    const streamType = this.determineStreamTypeFromFileName(params.fileName);
    const timeoutMs = params.timeoutMs ?? 20_000;

    // Determine NVR vs standalone mode:
    // - If explicitly specified, use that
    // - Otherwise, detect based on device channel count (channelCount>1 = NVR)
    // NOTE: Do NOT use fileName.includes("/") - standalone cameras also return full paths like /mnt/sda/...
    const isNvr = params.isNvr ?? (await this.isNvrDevice());

    const commonParams = {
      channel,
      fileName: params.fileName,
      streamType,
      timeoutMs,
      ...(params.logger != null ? { logger: params.logger } : {}),
    };

    const result = isNvr
      ? await this.startRecordingReplayStreamNvr(commonParams)
      : await this.startRecordingReplayStreamStandalone(commonParams);

    return result;
  }

  /** Legacy FileInfoList DL Video (cmdId=8). Returns response parsed as JSON. */
  async fileInfoListDownloadVideo(params?: {
    channel?: number;
    payloadXml?: string;
    timeoutMs?: number;
  }): Promise<XmlJsonValue> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_FILE_INFO_LIST_DL_VIDEO,
      ...(params?.channel != null ? { channel: params.channel } : {}),
      ...(params?.payloadXml != null ? { payloadXml: params.payloadXml } : {}),
      ...(params?.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
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
  }): Promise<RecordingPlaybackUrls> {
    const effectiveChannel =
      params.channel ?? this.client.getConfiguredChannel?.() ?? 0;

    const rtmpVodUrl = await this.getVodRtmpUrl({
      channel: effectiveChannel,
      fileName: params.fileName,
      ...(params.streamType ? { streamType: params.streamType } : {}),
      ...(params.ensureEnabled !== undefined
        ? { ensureEnabled: params.ensureEnabled }
        : {}),
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
  private async ensureUidForRecordings(
    channel: number,
    explicitUid?: string,
  ): Promise<string> {
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    recordingsTraceLog(
      dbg,
      logger,
      "ensureUidForRecordings",
      `Checking UID: explicitUid=${explicitUid}, this.uid=${this.uid}`,
    );

    const trimmedExplicit = explicitUid?.trim();
    if (trimmedExplicit) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `Using explicit UID: ${trimmedExplicit}`,
      );
      return trimmedExplicit;
    }

    const perChannel = await this.discoverUidForRecordingsForChannel(channel);
    if (perChannel) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `Using per-channel UID: ${perChannel}`,
      );
      return perChannel;
    }

    const configured = this.uid?.trim();
    if (configured) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `Using configured UID: ${configured}`,
      );
      return configured;
    }

    if (this.nativeOnly) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `Native-only: no UID available (channel=${channel})`,
      );
      throw new Error(
        "UID is required to access recordings in native-only mode. Provide a UID explicitly, configure the client with a UID, or wait for cmd_id=145 push cache to populate per-channel UIDs.",
      );
    }

    recordingsTraceLog(
      dbg,
      logger,
      "ensureUidForRecordings",
      `No UID available, attempting device auto-discovery (ch=${channel})`,
    );
    const discovered = await this.discoverDeviceUidForRecordings(channel);
    if (discovered) return discovered;

    recordingsTraceLog(
      dbg,
      logger,
      "ensureUidForRecordings",
      `Auto-discovery failed - no UID found`,
    );
    throw new Error(
      "UID is required to access recordings. Provide a UID explicitly or configure the client with a UID.",
    );
  }

  private cacheChannelUid(channel: number, uid: string): void {
    const existing = this.channelPushData.get(channel);
    const now = Date.now();
    const base = existing ?? { name: "", uid: "", state: "", updatedAtMs: now };
    this.channelPushData.set(channel, { ...base, uid, updatedAtMs: now });
  }

  private async discoverUidForRecordingsForChannel(
    channel: number,
  ): Promise<string | undefined> {
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    const fromPush = this.getUidFromPushCacheForChannel(channel);
    if (fromPush) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `Using per-channel UID from push cache: ${fromPush}`,
      );
      return fromPush;
    }

    if (this.nativeOnly) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `Native-only: skipping per-channel UID discovery via HTTP/CGI (channel=${channel})`,
      );
      return undefined;
    }

    try {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `Attempting per-channel UID discovery via HTTP CGI GetChannelstatus (channel=${channel})`,
      );
      const uidCandidate = await discoverPerChannelUidViaCgiChannelstatus({
        channel,
        login: () => this.cgiApi.login(),
        getChannelstatus: () => this.cgiApi.GetChannelstatus(),
      });

      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `[HTTP CGI] GetChannelstatus channel=${channel} uid=${uidCandidate || "(missing)"}`,
      );

      if (uidCandidate) {
        this.cacheChannelUid(channel, uidCandidate);
        recordingsTraceLog(
          dbg,
          logger,
          "ensureUidForRecordings",
          `Using per-channel UID from GetChannelstatus: ${uidCandidate}`,
        );
        return uidCandidate;
      }
    } catch (e) {
      recordingsTraceLog(
        dbg,
        logger,
        "ensureUidForRecordings",
        `[HTTP CGI] GetChannelstatus failed: ${formatErrorForLog(e)}`,
      );
    }

    return undefined;
  }

  private async discoverDeviceUidForRecordings(
    channel: number,
  ): Promise<string | undefined> {
    if (this.nativeOnly) return undefined;
    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;

    const trace = (message: string): void =>
      recordingsTraceLog(dbg, logger, "ensureUidForRecordings", message);

    const discoveredUid = await discoverDeviceUidForRecordingsUtil({
      channel,
      // For standalone cameras, use getInfo() without channel (cmdId=80) as cmdId=318 returns empty
      getInfo: () => this.getInfo(),
      cgiLogin: () => this.cgiApi.login(),
      cgiGetP2p: () => this.cgiApi.call("GetP2p", {}),
      cgiGetDevInfo: () => this.cgiApi.GetDevInfo(),
      sendXml: (p) => this.sendXml(p),
      trace,
    });

    if (discoveredUid) {
      this.uid = discoveredUid;
      trace(`Auto-discovered and cached device UID: ${discoveredUid}`);
      return discoveredUid;
    }

    return undefined;
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
   * NOTE: Requests are queued and processed one at a time. The camera often
   * rejects concurrent CoverPreview requests, so this serialization prevents
   * unnecessary failures and retries.
   *
   * @param params - Parameters for the snapshot
   * @returns Object containing the raw I-frame data and metadata
   */
  async getVideoclipThumbnail(params: {
    /** Channel number (0-based) */
    channel?: number;
    /** Timestamp to capture (start time) */
    time: Date;
    /** Optional end time. If omitted, uses time + 10 seconds. For best results, use the full recording range. */
    endTime?: Date;
    /** Stream type for snapshot quality ("main" or "sub", default: "sub") */
    snapType?: "main" | "sub";
    /** Optional UID for the camera (required for NVR). If omitted, will be discovered. */
    uid?: string;
    /** Timeout in milliseconds (default: 30000) */
    timeoutMs?: number;
    /** Explicitly specify if this is an NVR device. If omitted, auto-detects. */
    isNvr?: boolean;
  }): Promise<VideoclipThumbnailResult> {
    // If no request in flight, execute immediately
    if (!this.videoclipThumbnailInFlight) {
      this.videoclipThumbnailInFlight = this._getVideoclipThumbnailImpl(params);
      try {
        return await this.videoclipThumbnailInFlight;
      } finally {
        this.videoclipThumbnailInFlight = null;
        // Process next queued request if any
        this._processVideoclipThumbnailQueue();
      }
    }

    // Otherwise, queue the request and return a promise
    return new Promise<VideoclipThumbnailResult>((resolve, reject) => {
      this.videoclipThumbnailQueue.push({ params, resolve, reject });
    });
  }

  /**
   * Process the next item in the thumbnail queue.
   */
  private _processVideoclipThumbnailQueue(): void {
    const next = this.videoclipThumbnailQueue.shift();
    if (!next) return;

    this.videoclipThumbnailInFlight = this._getVideoclipThumbnailImpl(
      next.params,
    );
    this.videoclipThumbnailInFlight
      .then((result) => {
        next.resolve(result);
      })
      .catch((error) => {
        next.reject(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.videoclipThumbnailInFlight = null;
        this._processVideoclipThumbnailQueue();
      });
  }

  /**
   * Internal implementation of getVideoclipThumbnail.
   * This is the actual work - the public method handles queueing.
   */
  private async _getVideoclipThumbnailImpl(params: {
    channel?: number;
    time: Date;
    endTime?: Date;
    snapType?: "main" | "sub";
    uid?: string;
    timeoutMs?: number;
    isNvr?: boolean;
  }): Promise<VideoclipThumbnailResult> {
    await this.client.login();

    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;
    const trace = (message: string): void =>
      recordingsTraceLog(dbg, logger, "getVideoclipThumbnail", message);

    const channel = this.normalizeChannel(params.channel);
    const snapType = params.snapType ?? "sub";
    // reolink_aio uses "{stream}Stream" format, e.g. "subStream" or "mainStream"
    const snapStreamType = snapType === "main" ? "mainStream" : "subStream";
    const timeoutMs = params.timeoutMs ?? 30_000;
    const time = params.time;

    // Determine if this is an NVR (multiple channels).
    // For NVR, we need to use hostChannelId (250) or push-cache channelId.
    // For standalone cameras, use session counter.
    // Allow explicit override via params.isNvr for cases where auto-detection fails.
    const isNvr = params.isNvr ?? (await this.isNvrDevice());
    const headerChannelIdOverride = isNvr
      ? (this.resolveHeaderChannelIdForLogicalChannel(channel) ?? 250)
      : undefined;

    // CoverPreview requires a time range
    // PCAP shows the app uses the full recording range, not just time + 10 seconds
    const endTime = params.endTime ?? new Date(time.getTime() + 10_000);

    // For NVR devices, we need to include the camera UID in the CoverPreview XML.
    // PCAP analysis shows: NVR requests always include <uid> element after <channelId>.
    // The UID is the device identifier of the sub-camera connected to the NVR.
    let uidForXml: string | undefined;
    if (isNvr) {
      // First check if UID was provided in params
      uidForXml = params.uid;
      // Otherwise, get it from the push cache
      if (!uidForXml) {
        const pushInfo = this.getChannelInfoFromPushCache();
        const channelInfo = pushInfo.get(channel);
        uidForXml = channelInfo?.uid;
      }
      if (uidForXml) {
        trace(
          `CoverPreview: using UID ${uidForXml} for NVR channel ${channel}`,
        );
      } else {
        trace(
          `CoverPreview: no UID found for NVR channel ${channel}, omitting from XML`,
        );
      }
    }

    // Build CoverPreview XML exactly as seen in working PCAP capture:
    // - <channelId> = logical channel (0-based)
    // - <uid> = device identifier (required for NVR, omit for standalone cameras)
    // - NO <desc> tag (PCAP shows it's not present in working requests!)
    // - streamType = "subStream" or "mainStream"
    // NOTE: uses LOCAL time (not UTC) for timestamps
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<CoverPreview version="1.1">
<channelId>${channel}</channelId>${
      isNvr && uidForXml
        ? `
<uid>${uidForXml}</uid>`
        : ""
    }
<streamType>${snapStreamType}</streamType>
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
<frameList>
<frameNo>1</frameNo>
</frameList>
</CoverPreview>
</body>`;

    trace(
      `CoverPreview: channel=${channel} snapStreamType=${snapStreamType} time=${time.toISOString()} timeoutMs=${timeoutMs} isNvr=${isNvr} headerChId=${headerChannelIdOverride} uid=${uidForXml ?? "N/A"}`,
    );
    trace(`CoverPreview XML:\n${xml}`);

    // reolink_aio calls: send_payload(cmd_id=298, body=xml)
    // - message_class="1464" (0x6414) → BC_CLASS_MODERN_24
    // - No extension XML
    //
    // For NVR: use the resolved headerChannelId from push cache (like FileInfoList).
    // For standalone cameras: use session counter (let client handle it).
    //
    // NOTE: Retry logic is handled inside sendBinaryCoverPreview.
    // PCAP analysis shows the camera often rejects first few requests with 400 before accepting.
    let payload: Buffer;
    try {
      payload = await this.client.sendBinaryCoverPreview({
        cmdId: 298,
        // For NVR: use push-cache channelId. For standalone: let client use session counter.
        ...(isNvr && headerChannelIdOverride != null
          ? { channelIdOverride: headerChannelIdOverride }
          : {}),
        // PCAP shows: msgNum=0 for all CoverPreview requests
        msgNumOverride: 0,
        messageClass: BC_CLASS_MODERN_24,
        streamType: 0,
        payloadXml: xml,
        timeoutMs,
        // Retry parameters - camera often rejects first few requests
        maxRetries: 8,
        retryDelayMs: 1500,
      });
      trace(`CoverPreview succeeded`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace(`CoverPreview failed: ${msg}`);
      throw e;
    }

    // Parse stream header
    if (payload.length < 32) {
      throw new Error(
        `CoverPreview payload too short: ${payload.length} bytes`,
      );
    }

    const magic = payload.subarray(0, 4).toString("ascii");
    const supportedMagics = new Set(["1001", "1002"]);

    // Some NVRs return the AVI frame directly without a stream header.
    // Detect this case by checking for "00dc" magic at the start.
    if (magic === "00dc") {
      trace(
        `CoverPreview: payload starts with '00dc' (AVI frame marker), parsing directly`,
      );
      // The payload is the raw AVI-style frame, no stream header present.
      // Frame format: "00dc" (4 bytes) + frame_len (4 bytes little-endian) + frame_data
      const frameLen = payload.readUInt32LE(4);
      const frame = payload.subarray(8, 8 + frameLen);

      const detectEncoding = (buf: Buffer): string => {
        const maxScan = Math.min(buf.length - 6, 64 * 1024);
        let start = -1;
        let scLen = 0;
        for (let i = 0; i < maxScan; i++) {
          if (buf[i] !== 0x00 || buf[i + 1] !== 0x00) continue;
          if (buf[i + 2] === 0x01) {
            start = i;
            scLen = 3;
            break;
          }
          if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
            start = i;
            scLen = 4;
            break;
          }
        }

        if (start < 0) return "unknown";
        const nalHeaderIndex = start + scLen;
        if (nalHeaderIndex >= buf.length) return "unknown";

        const b0 = buf[nalHeaderIndex];
        if (b0 === undefined) return "unknown";
        const h264Type = b0 & 0x1f;
        const h265Type = (b0 >> 1) & 0x3f;

        if ([7, 8, 5, 1].includes(h264Type)) return "H264";
        if ([32, 33, 34, 19, 20].includes(h265Type)) return "H265";

        return "unknown";
      };

      const encoding = detectEncoding(frame);

      return {
        frame,
        encoding,
        frameLength: frame.length,
        streamInfo: {},
      };
    }

    if (!supportedMagics.has(magic)) {
      throw new Error(
        `CoverPreview payload did not start with a supported stream header magic ('1001'/'1002') but with '${magic}'`,
      );
    }

    // Most captures show a u32le header length at offset 4 (often 32). Be defensive.
    let streamHeaderLen = 32;
    try {
      const candidate = payload.readUInt32LE(4);
      if (
        Number.isFinite(candidate) &&
        candidate >= 16 &&
        candidate <= 4096 &&
        candidate <= payload.length
      ) {
        streamHeaderLen = candidate;
      }
    } catch {
      // ignore
    }

    const streamHeader = payload.subarray(0, streamHeaderLen);

    // Parse stream header fields
    const width = streamHeader.readUInt32LE(8);
    const height = streamHeader.readUInt32LE(12);
    const frameRate = streamHeader.length > 17 ? streamHeader[17] : 0;

    // Search for frame magic "00dc" after stream header
    const frameSearchArea = payload.subarray(streamHeaderLen);
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
      // Some firmwares appear to return a raw Annex-B payload without the AVI-like "00dc" wrapper.
      // Fall back to returning everything after the stream header as the frame payload.
      const frame = payload.subarray(streamHeaderLen);
      if (frame.length === 0) {
        throw new Error(
          `CoverPreview frame marker '00dc' not found and no payload after header. First bytes after header: ${frameSearchArea.subarray(0, 30).toString("hex")}`,
        );
      }

      const detectEncoding = (buf: Buffer): string => {
        // Find the first Annex-B startcode (0x000001 or 0x00000001)
        const maxScan = Math.min(buf.length - 6, 64 * 1024);
        let start = -1;
        let scLen = 0;
        for (let i = 0; i < maxScan; i++) {
          if (buf[i] !== 0x00 || buf[i + 1] !== 0x00) continue;
          if (buf[i + 2] === 0x01) {
            start = i;
            scLen = 3;
            break;
          }
          if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
            start = i;
            scLen = 4;
            break;
          }
        }

        if (start < 0) return "unknown";
        const nalHeaderIndex = start + scLen;
        if (nalHeaderIndex >= buf.length) return "unknown";

        const b0 = buf[nalHeaderIndex];
        if (b0 === undefined) return "unknown";
        const h264Type = b0 & 0x1f;
        const h265Type = (b0 >> 1) & 0x3f;

        // H.264 common NAL unit types: 7(SPS),8(PPS),5(IDR),1(non-IDR)
        if ([7, 8, 5, 1].includes(h264Type)) return "H264";
        // H.265 common NAL unit types: 32(VPS),33(SPS),34(PPS),19/20(IDR)
        if ([32, 33, 34, 19, 20].includes(h265Type)) return "H265";

        return "unknown";
      };

      const encoding = detectEncoding(frame);

      const streamInfo: PlaybackSnapshotStreamInfo = {};
      if (width > 0) streamInfo.width = width;
      if (height > 0) streamInfo.height = height;
      const fr = frameRate ?? 0;
      if (fr > 0) streamInfo.frameRate = fr;

      return {
        frame,
        encoding,
        frameLength: frame.length,
        streamInfo,
      };
    }

    const idx = streamHeaderLen + frameMagicIndex;

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
    const frameHeader = payload.subarray(
      frameHeaderStart,
      frameHeaderStart + headerLen,
    );

    const encoding = frameHeader
      .subarray(4, 8)
      .toString("ascii")
      .replace(/\0/g, "");
    const frameLen = frameHeader.readUInt32LE(8);
    const frameTime =
      headerLen >= 28 ? frameHeader.readUInt32LE(24) : undefined;

    // Extract frame data
    const frameStart = frameHeaderStart + headerLen;
    const frameEnd = frameStart + frameLen;

    if (frameEnd > payload.length) {
      throw new Error(
        `Frame data extends beyond payload: frameEnd=${frameEnd}, payloadLength=${payload.length}`,
      );
    }

    const frame = payload.subarray(frameStart, frameEnd);

    // Build streamInfo conditionally to satisfy exactOptionalPropertyTypes
    const streamInfo: PlaybackSnapshotStreamInfo = {};
    if (width > 0) streamInfo.width = width;
    if (height > 0) streamInfo.height = height;
    const fr = frameRate ?? 0;
    if (fr > 0) streamInfo.frameRate = fr;

    // Build result conditionally for frameTime
    const result: VideoclipThumbnailResult = {
      frame,
      encoding,
      frameLength: frameLen,
      streamInfo,
    };
    if (frameTime !== undefined) result.frameTime = frameTime;

    return result;
  }

  /**
   * Like {@link ReolinkBaichuanApi#getVideoclipThumbnail | getVideoclipThumbnail}, but returns a JPEG.
   *
   * Uses `ffmpeg` to decode the CoverPreview I-frame.
   */
  async getVideoclipThumbnailJpeg(params: {
    channel?: number;
    time: Date;
    endTime?: Date;
    snapType?: "main" | "sub";
    timeoutMs?: number;
    ffmpegPath?: string;
    /** Explicitly specify if this is an NVR device. If omitted, auto-detects. */
    isNvr?: boolean;
  }): Promise<Buffer> {
    const timeoutMs = params.timeoutMs ?? 30_000;
    const ffmpegPath = params.ffmpegPath ?? "ffmpeg";

    const snapParams: {
      channel?: number;
      time: Date;
      endTime?: Date;
      snapType?: "main" | "sub";
      timeoutMs?: number;
      isNvr?: boolean;
    } = {
      time: params.time,
      timeoutMs,
    };
    if (params.channel !== undefined) snapParams.channel = params.channel;
    if (params.endTime !== undefined) snapParams.endTime = params.endTime;
    if (params.snapType !== undefined) snapParams.snapType = params.snapType;
    if (params.isNvr !== undefined) snapParams.isNvr = params.isNvr;

    const snap = await this.getVideoclipThumbnail(snapParams);

    return this.decodeCoverPreviewFrameToJpeg({
      frame: snap.frame,
      encoding: snap.encoding,
      ffmpegPath,
      timeoutMs,
    });
  }

  private async decodeCoverPreviewFrameToJpeg(params: {
    frame: Buffer;
    encoding: string;
    ffmpegPath: string;
    timeoutMs: number;
  }): Promise<Buffer> {
    const encodingUpper = params.encoding.toUpperCase();
    const fmts: string[] = [];
    if (encodingUpper.includes("265") || encodingUpper.includes("HEVC")) {
      fmts.push("hevc", "h264");
    } else {
      fmts.push("h264", "hevc");
    }

    const tryDecode = (fmt: string): Promise<Buffer> => {
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let stderr = "";
        let timedOut = false;

        const ff = spawn(params.ffmpegPath, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          fmt,
          "-i",
          "pipe:0",
          "-frames:v",
          "1",
          "-f",
          "image2",
          "-c:v",
          "mjpeg",
          "-q:v",
          "2",
          "pipe:1",
        ]);

        const timeout = setTimeout(() => {
          timedOut = true;
          ff.kill("SIGKILL");
          reject(new Error(`ffmpeg timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs);

        ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        ff.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

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

        ff.stdin.end(params.frame);
      });
    };

    let lastErr: unknown;
    for (const fmt of fmts) {
      try {
        return await tryDecode(fmt);
      } catch (e) {
        lastErr = e;
      }
    }

    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
      `Failed to decode CoverPreview frame to JPEG (encoding=${params.encoding}). Last error: ${msg}`,
    );
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
        "-loglevel",
        "error",
        "-rtmp_live",
        "live",
        ...(seekSeconds > 0 ? ["-ss", seekSeconds.toFixed(3)] : []),
        "-i",
        rtmpUrl,
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "-q:v",
        "2",
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
      if (rtmpPort == null && port != null && Number.isFinite(port) && port > 0)
        rtmpPort = port;
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
          await this.wakeUp(channel, {
            waitAfterWakeMs: 3000,
            attempts: 3,
            reconnect: true,
          });
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
    const atSeconds =
      Number.isFinite(params.atSeconds) && params.atSeconds >= 0
        ? params.atSeconds
        : 0;

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
        reject(
          new Error(`ffmpeg screenshot exited with code ${code}\n${stderr}`),
        );
      });

      ff.on("error", reject);
    });
  }

  /**
   * Download a recording via Baichuan FileInfoList download (cmdId=13, class=0x6482).
   * Returns raw bytes (often an mp4/flv/ps payload depending on firmware/camera).
   */
  async fileInfoListDownload(params: {
    channel: number;
    fileName: string;
    /** Optional UID; if omitted, the library will attempt to infer/discover it. */
    uid?: string;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.client.login();

    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;
    const trace = (message: string): void =>
      recordingsTraceLog(dbg, logger, "fileInfoListDownload", message);

    const channel = this.normalizeChannel(params.channel);
    const uid = await this.ensureUidForRecordings(channel, params.uid);
    const headerChannelIdOverride =
      this.resolveHeaderChannelIdForLogicalChannel(channel);

    const headerChannelCandidates = [
      headerChannelIdOverride,
      channel + 1,
      undefined,
      250,
      0,
      251,
    ].filter((v, i, a) => a.indexOf(v) === i);
    const xmlChannelIdCandidates = [
      channel,
      channel + 1,
      headerChannelIdOverride,
      0,
      1,
    ]
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .filter((v, i, a) => a.indexOf(v) === i);

    const totalTimeoutMs = params.timeoutMs ?? 120_000;
    const startedAt = Date.now();
    const streamTypeCandidates = [0, 2];
    let lastErr: unknown;
    let attempts = 0;
    const maxAttempts = 12;

    trace(
      `attempt budget: channel=${channel} uid=${uid || "(missing)"} headerChannelId=[${headerChannelCandidates.map((v) => (v == null ? "(default)" : String(v))).join(",")}] xmlChannelId=[${xmlChannelIdCandidates.join(",")}] headerStreamType=[${streamTypeCandidates.join(",")}] totalTimeoutMs=${totalTimeoutMs} maxAttempts=${maxAttempts}`,
    );

    for (const xmlCh of xmlChannelIdCandidates) {
      const payloadXml = buildFileInfoListDownloadXml({
        channel,
        uid,
        fileName: params.fileName,
        xmlChannelId: xmlCh,
      });

      for (const chId of headerChannelCandidates) {
        for (const st of streamTypeCandidates) {
          const remaining = totalTimeoutMs - (Date.now() - startedAt);
          if (remaining <= 0) break;
          if (attempts >= maxAttempts) break;
          attempts++;
          const attemptTimeoutMs = Math.min(5_000, remaining);
          trace(
            `attempt=${attempts}/${maxAttempts} file=${params.fileName} xmlCh=${xmlCh} headerCh=${chId == null ? "(default)" : chId} headerStreamType=${st} attemptTimeoutMs=${attemptTimeoutMs}`,
          );
          try {
            return await this.client.sendBinary({
              cmdId: BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
              channel,
              ...(typeof chId === "number" ? { channelIdOverride: chId } : {}),
              messageClass: BC_CLASS_FILE_DOWNLOAD,
              extensionXml: buildBinaryExtensionXml(channel),
              payloadXml,
              streamType: st,
              timeoutMs: attemptTimeoutMs,
            });
          } catch (e) {
            lastErr = e;
            const msg = e instanceof Error ? e.message : String(e);
            trace(`attempt=${attempts} failed: ${msg}`);
            // Timeouts can be variant-dependent; continue while within budget.
            if (msg.includes("timeout")) continue;
            if (
              !msg.includes("rejected") &&
              !msg.includes("responseCode=400")
            ) {
              break;
            }
          }
        }
        if (attempts >= maxAttempts) break;
      }
      if (attempts >= maxAttempts) break;
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "FileInfoList download failed"));
  }

  /**
   * Download a recording via paged FileInfoList (cmdId=14 OPEN, 15 GET, 16 CLOSE).
   * This method is used by some cameras (e.g., TrackMix PoE) where cmdId=5/13 return empty.
   * It opens the file, retrieves data in chunks, and closes the session.
   */
  async fileInfoListPagedDownload(params: {
    channel: number;
    fileName: string;
    uid?: string;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.client.login();

    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;
    const trace = (message: string): void =>
      recordingsTraceLog(dbg, logger, "fileInfoListPagedDownload", message);

    const channel = this.normalizeChannel(params.channel);
    const uid = await this.ensureUidForRecordings(channel, params.uid);

    trace(
      `Starting paged download: channel=${channel}, uid=${uid}, fileName=${params.fileName}`,
    );

    const sendXml = async (p: {
      cmdId: number;
      payloadXml?: string;
      timeoutMs?: number;
    }): Promise<string> => {
      return await this.client.sendXml({
        cmdId: p.cmdId,
        ...(p.payloadXml != null ? { payloadXml: p.payloadXml } : {}),
        ...(p.timeoutMs != null ? { timeoutMs: p.timeoutMs } : {}),
      });
    };

    const sendBinary = async (p: {
      cmdId: number;
      payloadXml?: string;
      timeoutMs?: number;
    }): Promise<Buffer> => {
      return await this.client.sendBinary({
        cmdId: p.cmdId,
        ...(p.payloadXml != null ? { payloadXml: p.payloadXml } : {}),
        ...(p.timeoutMs != null ? { timeoutMs: p.timeoutMs } : {}),
      });
    };

    const result = await downloadRecordingViaFileInfoListPaged({
      sendXml,
      sendBinary,
      channel,
      uid,
      fileName: params.fileName,
      timeoutMs: params.timeoutMs ?? 120_000,
    });

    trace(`Paged download completed: ${result.length} bytes`);
    return result;
  }

  /**
   * Download a recording via FileInfoList replay (cmdId=5) using the PCAP-observed binary chunk flow.
   * This is native-only and does NOT involve CGI/HTTP.
   */
  async fileInfoListReplayBinaryDownload(params: {
    channel: number;
    fileName: string;
    /** Optional UID; if omitted, the library will attempt to infer/discover it. */
    uid?: string;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.client.login();

    const dbg = this.client.getDebugConfig?.();
    const logger = this.logger;
    const trace = (message: string): void =>
      recordingsTraceLog(
        dbg,
        logger,
        "fileInfoListReplayBinaryDownload",
        message,
      );

    const channel = this.normalizeChannel(params.channel);
    const headerChannelIdOverride =
      this.resolveHeaderChannelIdForLogicalChannel(channel);
    const ident = params.fileName;
    // Auto-detect streamType from fileName
    const streamType = this.determineStreamTypeFromFileName(params.fileName);

    // For NVR, use the resolved headerChannelId or 82.
    // For standalone cameras, do NOT override channelId - let sendBinary use the
    // host channelId (typically 250). PCAP analysis shows some cameras (e.g. H265)
    // reject channelId=0 with responseCode=400, but accept the hostChannelId.
    const isNvr = headerChannelIdOverride != null;

    // PCAP Analysis (2025-06): The Reolink app does NOT include <uid> in the XML
    // for standalone cameras. Including it causes responseCode=400 on some H265 cameras.
    // Only get/require UID for NVR configurations where it's required.
    let uid: string | undefined;
    if (isNvr) {
      uid = await this.ensureUidForRecordings(channel, params.uid);
    }

    // PCAP Analysis (2025-06): The Reolink app uses the standard FileInfoList format with
    // <FileInfo><Id>...</Id><supportSub>0</supportSub><playSpeed>1</playSpeed><streamType>mainStream</streamType></FileInfo>
    // For standalone cameras (non-NVR), do NOT include <uid> in the XML.
    const payloadXml = ident.includes("/")
      ? buildFileInfoListReplayByIdXml({
          channel,
          xmlChannelId: 0, // PCAP-verified: xmlChannelId=0 works
          id: ident,
          ...(uid ? { uid } : {}),
          streamType,
        })
      : buildFileInfoListReplayByNameXml({
          channel,
          xmlChannelId: 0,
          name: ident,
          ...(uid ? { uid } : {}),
          streamType,
        });

    const timeoutMs = params.timeoutMs ?? 120_000;

    trace(
      `download: channel=${channel} uid=${uid || "(missing)"} ident=${ident} streamType=${streamType} isNvr=${isNvr} timeoutMs=${timeoutMs}`,
    );

    try {
      return await this.client.sendBinary({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_REPLAY,
        channel,
        ...(isNvr ? { channelIdOverride: headerChannelIdOverride ?? 82 } : {}),
        msgNumOverride: 0,
        messageClass: BC_CLASS_MODERN_24,
        payloadXml,
        streamType: 0,
        timeoutMs,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace(`download failed: ${msg}`);
      throw e;
    }
  }

  async downloadRecording(params: DownloadRecordingParams): Promise<Buffer> {
    // Use replay queue to serialize all download operations on this socket
    return this.enqueueReplayOperation(async () => {
      await this.client.login();

      const channel = this.normalizeChannel(params.channel);
      const uid = await this.ensureUidForRecordings(channel, params.uid);
      const fileName = params.fileName;

      let replayErr: unknown;
      try {
        return await this.fileInfoListReplayBinaryDownload({
          channel,
          uid,
          fileName,
          ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
        });
      } catch (e) {
        replayErr = e;
      }

      let downloadErr: unknown;
      try {
        return await this.fileInfoListDownload({
          channel,
          uid,
          fileName,
          ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
        });
      } catch (e) {
        downloadErr = e;
      }

      // Third fallback: paged download via cmdId=14/15/16
      // This works for TrackMix PoE and other cameras where cmdId=5/13 return empty
      try {
        const result = await this.fileInfoListPagedDownload({
          channel,
          uid,
          fileName,
          ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
        });
        if (result.length > 0) {
          return result;
        }
      } catch (e) {
        // Fall through to error
      }

      const replayMsg =
        replayErr instanceof Error
          ? replayErr.message
          : replayErr != null
            ? String(replayErr)
            : "";
      const dlMsg =
        downloadErr instanceof Error
          ? downloadErr.message
          : downloadErr != null
            ? String(downloadErr)
            : "";
      // Native-only: do not fall back to HTTP/CGI.
      throw new Error(
        `Baichuan download failed (native-only). replay(cmdId=${BC_CMD_ID_FILE_INFO_LIST_REPLAY}) err=${replayMsg || "(unknown)"}; download(cmdId=${BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD}) err=${dlMsg}`,
      );
    });
  }

  /**
   * Download a recording and demux it to Annex-B format.
   *
   * The raw Baichuan download returns BcMedia-formatted data which needs to be
   * demuxed to extract the video frames. This method downloads the recording
   * and demuxes it into a single Annex-B buffer that can be played by ffmpeg
   * or converted to MP4.
   *
   * Example usage:
   * ```ts
   * const result = await api.downloadRecordingDemuxed({ fileName, channel });
   * // Save as .h264 or .h265 file
   * await fs.writeFile("recording.h264", result.annexB);
   * // Convert to MP4 with ffmpeg:
   * // ffmpeg -i recording.h264 -c copy recording.mp4
   * ```
   *
   * @param params - Download parameters
   * @returns Demuxed recording with Annex-B video data and stats
   */
  async downloadRecordingDemuxed(params: DownloadRecordingParams): Promise<{
    /** Concatenated video frames in Annex-B format (H.264 or H.265) */
    annexB: Buffer;
    /** Detected video codec */
    videoType: BcMediaVideoType | null;
    /** Statistics about the demuxed recording */
    stats: {
      bytesIn: number;
      bytesOut: number;
      packets: number;
      videoPackets: number;
      audioPackets: number;
      keyframes: number;
    };
  }> {
    const raw = await this.downloadRecording(params);

    const frames: Buffer[] = [];
    const decoder = new BcMediaAnnexBDecoder({
      strict: false,
      logger: this.logger,
      onVideoAccessUnit: ({ annexB }) => {
        frames.push(annexB);
      },
    });

    decoder.push(raw);

    const stats = decoder.getStats();

    return {
      annexB: Buffer.concat(frames),
      videoType: stats.videoType,
      stats: {
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        packets: stats.packets,
        videoPackets: stats.videoPackets,
        audioPackets: stats.audioPackets,
        keyframes: stats.keyframes,
      },
    };
  }

  /**
   * Get a recording as a ready-to-play MP4 file with video and audio muxed together.
   *
   * This method downloads a recording via Baichuan protocol, demuxes it, and uses
   * ffmpeg to mux video+audio into a single MP4 file.
   *
   * Example usage:
   * ```ts
   * const { mp4, stats } = await api.getRecordingVideo({
   *   channel: 0,
   *   fileName: "/mnt/sda/Mp4Record/2026-01-22/Rec_20260122_000320.mp4"
   * });
   *
   * // Save directly as playable MP4
   * await fs.writeFile("recording.mp4", mp4);
   * ```
   *
   * @param params - Download parameters
   * @returns MP4 buffer with muxed video+audio and statistics
   */
  async getRecordingVideo(
    params: DownloadRecordingParams & {
      /** Path to ffmpeg binary (default: "ffmpeg" from PATH) */
      ffmpegPath?: string;
    },
  ): Promise<GetRecordingVideoResult> {
    const raw = await this.downloadRecording(params);

    const videoFrames: { annexB: Buffer; microseconds: number }[] = [];
    const audioFrames: Buffer[] = [];
    let audioCodec: BcMediaAudioType | null = null;

    const decoder = new BcMediaAnnexBDecoder({
      strict: false,
      logger: this.logger,
      onVideoAccessUnit: ({ annexB, microseconds }) => {
        videoFrames.push({ annexB, microseconds });
      },
      onAudioFrame: ({ audioType, data }) => {
        if (audioCodec == null) audioCodec = audioType;
        audioFrames.push(data);
      },
    });

    decoder.push(raw);

    const decoderStats = decoder.getStats();
    const videoCodec = decoderStats.videoType ?? "H264";

    // Determine FPS - prefer timestamps over info FPS for correct audio sync
    // The info FPS tells what the camera records at, but the actual frames transmitted
    // may be subsampled (e.g., 30fps recording -> 15fps transmission for bandwidth)
    // Using timestamps ensures video duration matches audio duration
    let fps: number;
    let durationSeconds: number;

    if (videoFrames.length >= 2) {
      const firstTs = videoFrames[0]!.microseconds;
      const lastTs = videoFrames[videoFrames.length - 1]!.microseconds;
      const durationUs = lastTs - firstTs;

      if (durationUs > 0) {
        // Calculate from timestamps - most reliable for A/V sync
        durationSeconds = durationUs / 1_000_000;
        fps = (videoFrames.length - 1) / durationSeconds;
      } else {
        // Fallback to info FPS if timestamps are invalid
        const infoFps = decoderStats.infos[0]?.fps;
        fps = infoFps && infoFps > 0 ? infoFps : 15;
        durationSeconds = videoFrames.length / fps;
      }
    } else {
      // Not enough frames, use info FPS
      const infoFps = decoderStats.infos[0]?.fps;
      fps = infoFps && infoFps > 0 ? infoFps : 15;
      durationSeconds = videoFrames.length / fps;
    }

    // Round FPS to common values if close
    if (fps > 14 && fps < 16) fps = 15;
    else if (fps > 23 && fps < 26) fps = 25;
    else if (fps > 29 && fps < 31) fps = 30;
    else fps = Math.round(fps * 100) / 100;

    const videoData = Buffer.concat(videoFrames.map((f) => f.annexB));
    const audioData =
      audioFrames.length > 0 ? Buffer.concat(audioFrames) : null;
    const hasAudio = audioData != null && audioData.length > 0;

    // Mux video+audio with ffmpeg
    const mp4 = await this.muxToMp4({
      videoData,
      videoCodec,
      audioData,
      audioCodec,
      fps,
      durationHint: durationSeconds,
      ...(params.ffmpegPath ? { ffmpegPath: params.ffmpegPath } : {}),
    });

    return {
      mp4,
      stats: {
        bytesIn: decoderStats.bytesIn,
        videoBytesOut: decoderStats.bytesOut,
        audioBytesOut: decoderStats.audioBytesOut,
        videoPackets: decoderStats.videoPackets,
        audioPackets: decoderStats.audioPackets,
        keyframes: decoderStats.keyframes,
        fps,
        durationSeconds,
        videoCodec,
        audioCodec,
        hasAudio,
      },
    };
  }

  /**
   * Get a JPEG thumbnail from a recording file.
   *
   * This method uses the playback snapshot protocol to extract a frame from the
   * beginning of a recording and converts it to JPEG. Requests are queued with
   * limited concurrency (max 2 simultaneous) to avoid overwhelming the camera.
   *
   * Example usage:
   * ```ts
   * const jpeg = await api.getRecordingThumbnail({
   *   channel: 0,
   *   fileName: "/mnt/sda/Mp4Record/2026-01-22/Rec_20260122_000320.mp4"
   * });
   *
   * // Save as JPEG file
   * await fs.writeFile("thumbnail.jpg", jpeg);
   * ```
   *
   * @param params - Thumbnail parameters
   * @returns JPEG buffer
   */
  async getRecordingThumbnail(params: {
    /** Channel number (default: 0) */
    channel?: number;
    /** Recording file name/path */
    fileName: string;
    /** Timeout in ms (default: 15000) */
    timeoutMs?: number;
    /** Path to ffmpeg binary (default: "ffmpeg") */
    ffmpegPath?: string;
  }): Promise<Buffer> {
    const channel = this.normalizeChannel(params.channel ?? 0);
    // Auto-detect streamType from fileName
    const streamType = this.determineStreamTypeFromFileName(params.fileName);
    const timeoutMs = params.timeoutMs ?? 15_000;
    const ffmpegPath = params.ffmpegPath ?? "ffmpeg";

    // Use de-duplication key for this thumbnail request
    const dedupKey = `thumbnail:${channel}:${params.fileName}`;

    // Enqueue with de-duplication - if same request is in progress, returns existing promise
    return this.enqueueReplayOperation(async () => {
      this.logger?.debug?.(
        `[getRecordingThumbnail] Extracting thumbnail via streaming: channel=${channel}, file=${params.fileName}, streamType=${streamType}`,
      );

      // Start replay stream to capture first keyframe
      const { stream, stop } = await this.startRecordingReplayStream({
        channel,
        fileName: params.fileName,
        timeoutMs,
      });

      try {
        // Wait for first keyframe that contains parameter sets (SPS/PPS for H.264, VPS/SPS/PPS for H.265)
        const keyframe = await new Promise<{
          data: Buffer;
          videoType: BcMediaVideoType;
        }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(
              new Error("Timeout waiting for keyframe with parameter sets"),
            );
          }, timeoutMs);

          const hasH264ParamSets = (data: Buffer): boolean => {
            // Look for SPS (NAL type 7) and PPS (NAL type 8) in Annex-B stream
            let hasSps = false;
            let hasPps = false;
            let i = 0;
            while (i < data.length - 4) {
              // Find start code (00 00 00 01 or 00 00 01)
              if (data[i] === 0 && data[i + 1] === 0) {
                let nalStart = -1;
                if (data[i + 2] === 0 && data[i + 3] === 1) {
                  nalStart = i + 4;
                } else if (data[i + 2] === 1) {
                  nalStart = i + 3;
                }
                if (nalStart >= 0 && nalStart < data.length) {
                  const nalByte = data[nalStart];
                  if (nalByte !== undefined) {
                    const nalType = nalByte & 0x1f;
                    if (nalType === 7) hasSps = true;
                    if (nalType === 8) hasPps = true;
                    if (hasSps && hasPps) return true;
                  }
                  i = nalStart;
                  continue;
                }
              }
              i++;
            }
            return hasSps && hasPps;
          };

          const hasH265ParamSets = (data: Buffer): boolean => {
            // Look for VPS (32), SPS (33), PPS (34) in Annex-B stream
            let hasVps = false;
            let hasSps = false;
            let hasPps = false;
            let i = 0;
            while (i < data.length - 4) {
              if (data[i] === 0 && data[i + 1] === 0) {
                let nalStart = -1;
                if (data[i + 2] === 0 && data[i + 3] === 1) {
                  nalStart = i + 4;
                } else if (data[i + 2] === 1) {
                  nalStart = i + 3;
                }
                if (nalStart >= 0 && nalStart < data.length) {
                  const nalByte = data[nalStart];
                  if (nalByte !== undefined) {
                    const nalType = (nalByte >> 1) & 0x3f;
                    if (nalType === 32) hasVps = true;
                    if (nalType === 33) hasSps = true;
                    if (nalType === 34) hasPps = true;
                    if (hasVps && hasSps && hasPps) return true;
                  }
                  i = nalStart;
                  continue;
                }
              }
              i++;
            }
            return hasVps && hasSps && hasPps;
          };

          const onFrame = (au: {
            data: Buffer;
            isKeyframe: boolean;
            videoType: "H264" | "H265";
          }) => {
            if (!au.isKeyframe) return;

            // Verify the keyframe contains parameter sets
            const hasParams =
              au.videoType === "H265"
                ? hasH265ParamSets(au.data)
                : hasH264ParamSets(au.data);

            if (!hasParams) {
              // Log but keep waiting for a complete keyframe
              this.logger?.debug?.(
                `[getRecordingThumbnail] Keyframe missing parameter sets, waiting for next: codec=${au.videoType}, size=${au.data.length}`,
              );
              return;
            }

            clearTimeout(timeout);
            stream.off("videoAccessUnit", onFrame);
            resolve({
              data: au.data,
              videoType: au.videoType,
            });
          };

          stream.on("videoAccessUnit", onFrame);
          stream.once("error", (err) => {
            clearTimeout(timeout);
            stream.off("videoAccessUnit", onFrame);
            reject(err);
          });
          stream.once("close", () => {
            clearTimeout(timeout);
            stream.off("videoAccessUnit", onFrame);
            reject(new Error("Stream closed before keyframe received"));
          });
        });

        this.logger?.debug?.(
          `[getRecordingThumbnail] Got keyframe with params: ${keyframe.data.length} bytes, codec=${keyframe.videoType}`,
        );

        // Convert keyframe to JPEG using ffmpeg
        const jpeg = await this.convertFrameToJpeg({
          frameData: keyframe.data,
          videoCodec: keyframe.videoType,
          ffmpegPath,
        });

        this.logger?.debug?.(
          `[getRecordingThumbnail] Thumbnail extracted: ${jpeg.length} bytes`,
        );

        return jpeg;
      } finally {
        await stop().catch(() => {});
      }
    }, dedupKey);
  }

  /**
   * Convert a raw video keyframe to JPEG using ffmpeg.
   */
  private async convertFrameToJpeg(params: {
    frameData: Buffer;
    videoCodec: BcMediaVideoType;
    ffmpegPath?: string;
  }): Promise<Buffer> {
    const { spawn } = await import("node:child_process");
    const ffmpeg = params.ffmpegPath ?? "ffmpeg";
    const inputFormat = params.videoCodec === "H265" ? "hevc" : "h264";

    return new Promise<Buffer>((resolve, reject) => {
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        inputFormat,
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "-q:v",
        "2",
        "pipe:1",
      ];

      const proc = spawn(ffmpeg, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0 || chunks.length === 0) {
          reject(
            new Error(
              `ffmpeg failed to convert frame to JPEG (code=${code}): ${stderr}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(chunks));
      });

      proc.on("error", reject);

      proc.stdin.write(params.frameData);
      proc.stdin.end();
    });
  }

  /**
   * Get a recording as MP4 by streaming it frame-by-frame.
   *
   * This is an alternative to getRecordingVideo() that uses the replay streaming
   * protocol instead of bulk download. Useful for cameras that don't support
   * the download protocol (cmdId=5/13) but support streaming playback.
   *
   * @param params - Streaming parameters
   * @returns MP4 buffer with video (audio not supported in streaming mode)
   */
  async getRecordingVideoViaStreaming(params: {
    channel?: number;
    fileName: string;
    /** Maximum streaming duration in ms (default: 300000 = 5 min) */
    maxDurationMs?: number;
    /** Idle timeout - stop if no frames received for this duration (default: 10000ms) */
    idleTimeoutMs?: number;
    /** Path to ffmpeg binary (default: "ffmpeg" from PATH) */
    ffmpegPath?: string;
  }): Promise<{
    mp4: Buffer;
    stats: {
      videoPackets: number;
      keyframes: number;
      fps: number;
      durationSeconds: number;
      videoCodec: BcMediaVideoType;
    };
  }> {
    const channel = this.normalizeChannel(params.channel ?? 0);
    const maxDurationMs = params.maxDurationMs ?? 300_000; // 5 min max
    const idleTimeoutMs = params.idleTimeoutMs ?? 10_000; // 10s idle timeout

    this.logger?.info?.(
      `[getRecordingVideoViaStreaming] Starting stream: channel=${channel}, file=${params.fileName}`,
    );

    const { stream, stop } = await this.startRecordingReplayStream({
      channel,
      fileName: params.fileName,
      timeoutMs: 30_000,
    });

    const videoFrames: Buffer[] = [];
    let videoCodec: BcMediaVideoType = "H264";
    let keyframes = 0;
    let lastFrameAt = Date.now();
    const startedAt = Date.now();

    // Collect frames until stream ends or timeout
    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(checkInterval);
        resolve();
      };

      // Handle video frames
      stream.on("videoAccessUnit", (frame) => {
        lastFrameAt = Date.now();
        videoFrames.push(frame.data);
        videoCodec = frame.videoType;
        if (frame.isKeyframe) keyframes++;

        // Log progress
        if (videoFrames.length % 100 === 0) {
          this.logger?.debug?.(
            `[getRecordingVideoViaStreaming] Collected ${videoFrames.length} frames (${keyframes} keyframes)`,
          );
        }
      });

      // Handle stream close (end of recording)
      stream.on("close", () => {
        this.logger?.info?.(
          `[getRecordingVideoViaStreaming] Stream closed after ${videoFrames.length} frames`,
        );
        finish();
      });

      // Handle errors
      stream.on("error", (err) => {
        this.logger?.warn?.(
          `[getRecordingVideoViaStreaming] Stream error: ${err.message}`,
        );
        finish();
      });

      // Check for timeout/idle periodically
      const checkInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = now - startedAt;
        const idleTime = now - lastFrameAt;

        // Max duration exceeded
        if (elapsed > maxDurationMs) {
          this.logger?.info?.(
            `[getRecordingVideoViaStreaming] Max duration reached (${elapsed}ms)`,
          );
          finish();
          return;
        }

        // Idle timeout - no frames for a while means recording ended
        if (videoFrames.length > 0 && idleTime > idleTimeoutMs) {
          this.logger?.info?.(
            `[getRecordingVideoViaStreaming] Idle timeout (${idleTime}ms with no frames)`,
          );
          finish();
          return;
        }
      }, 1000);
    });

    // Stop the stream
    try {
      await stop();
    } catch {
      // Ignore stop errors
    }

    if (videoFrames.length === 0) {
      throw new Error(
        "No video frames received from streaming - recording may be empty or streaming not supported",
      );
    }

    // Estimate FPS from frame count and duration
    const streamDuration = (Date.now() - startedAt) / 1000;
    const estimatedFps =
      streamDuration > 0 ? Math.round(videoFrames.length / streamDuration) : 15;
    // Use common FPS values
    const fps =
      estimatedFps >= 28
        ? 30
        : estimatedFps >= 23
          ? 25
          : estimatedFps >= 13
            ? 15
            : 10;

    this.logger?.info?.(
      `[getRecordingVideoViaStreaming] Collected ${videoFrames.length} frames, ${keyframes} keyframes, estimated ${fps} fps`,
    );

    const videoData = Buffer.concat(videoFrames);
    const durationSeconds = videoFrames.length / fps;

    // Mux to MP4 (no audio in streaming mode)
    const mp4 = await this.muxToMp4({
      videoData,
      videoCodec,
      audioData: null,
      audioCodec: null,
      fps,
      ...(params.ffmpegPath ? { ffmpegPath: params.ffmpegPath } : {}),
    });

    return {
      mp4,
      stats: {
        videoPackets: videoFrames.length,
        keyframes,
        fps,
        durationSeconds,
        videoCodec,
      },
    };
  }

  /**
   * Internal helper to mux video+audio into MP4 using ffmpeg.
   */
  private async muxToMp4(params: {
    videoData: Buffer;
    videoCodec: BcMediaVideoType;
    audioData: Buffer | null;
    audioCodec: BcMediaAudioType | null;
    fps: number;
    durationHint?: number;
    ffmpegPath?: string;
  }): Promise<Buffer> {
    const { spawn } = await import("node:child_process");
    const { randomUUID } = await import("node:crypto");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const ffmpeg = params.ffmpegPath ?? "ffmpeg";
    const tmpDir = os.tmpdir();
    const id = randomUUID();

    const videoFormat = params.videoCodec === "H265" ? "hevc" : "h264";
    const videoPath = path.join(tmpDir, `reolink-${id}.${videoFormat}`);
    const outputPath = path.join(tmpDir, `reolink-${id}.mp4`);

    let audioPath: string | null = null;
    if (params.audioData && params.audioData.length > 0 && params.audioCodec) {
      const audioExt = params.audioCodec === "Aac" ? "aac" : "raw";
      audioPath = path.join(tmpDir, `reolink-${id}.${audioExt}`);
    }

    try {
      // Write temp files
      await fs.writeFile(videoPath, params.videoData);
      if (audioPath && params.audioData) {
        await fs.writeFile(audioPath, params.audioData);
      }

      // Build ffmpeg args
      const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];

      // Video input with framerate
      // Using -r on input tells ffmpeg to interpret the raw stream at this rate
      if (params.fps > 0) {
        args.push("-r", String(params.fps));
      }
      args.push("-f", videoFormat, "-i", videoPath);

      // Audio input (if present)
      if (audioPath && params.audioCodec) {
        if (params.audioCodec === "Aac") {
          // AAC ADTS has its own timestamps, ffmpeg will read them
          args.push("-f", "aac", "-i", audioPath);
        } else {
          // ADPCM: s16le format, mono, 8000Hz sample rate
          args.push("-f", "s16le", "-ar", "8000", "-ac", "1", "-i", audioPath);
        }
      }

      // Output options: copy codecs, fragmented MP4 for streaming compatibility
      args.push("-c:v", "copy");
      if (audioPath && params.audioCodec) {
        if (params.audioCodec === "Aac") {
          // AAC in ADTS format needs bitstream filter for MP4 muxing
          args.push("-c:a", "copy", "-bsf:a", "aac_adtstoasc");
        } else {
          // ADPCM needs transcoding to AAC
          args.push("-c:a", "aac");
        }
        // NOTE: Do NOT use -shortest as it can drop audio when video has no timestamps
      }

      // Set output framerate to match input
      if (params.fps > 0) {
        args.push("-r", String(params.fps));
      }

      args.push(
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        outputPath,
      );

      // Run ffmpeg
      await new Promise<void>((resolve, reject) => {
        const p = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";

        p.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });

        p.on("error", (e) => {
          reject(new Error(`ffmpeg spawn error: ${e.message}`));
        });

        p.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`,
              ),
            );
          }
        });
      });

      // Read output
      return await fs.readFile(outputPath);
    } finally {
      // Cleanup temp files
      await fs.unlink(videoPath).catch(() => {});
      if (audioPath) await fs.unlink(audioPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
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

    const attempts: Array<{
      label: string;
      params: Parameters<BaichuanClient["sendFrame"]>[0];
    }> = [
      {
        label: `channelId=${channel} bodyLen=0`,
        params: {
          cmdId: 31,
          channelIdOverride: channel,
          messageClass: BC_CLASS_MODERN_24,
        },
      },
      {
        // Use ch_id=251 for push subscription.
        label: "push channelId=251 bodyLen=0",
        params: {
          cmdId: 31,
          channelIdOverride: 251,
          messageClass: BC_CLASS_MODERN_24,
        },
      },
      {
        label: "host channelId=250 bodyLen=0",
        params: {
          cmdId: 31,
          channelIdOverride: 250,
          messageClass: BC_CLASS_MODERN_24,
        },
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
      const frame = await this.client.sendFrame({
        ...a.params,
        timeoutMs: 10_000,
      });
      lastCode = frame.header.responseCode;
      if (frame.header.responseCode === 200) {
        this.client.subscribed = true;
        this.client.refreshKeepAlive?.();
        return;
      }
      // Keep trying other variants.
      (this.logger.debug ?? this.logger.log).call(
        this.logger,
        `[ReolinkBaichuanApi] subscribeEvents rejected (${a.label}) responseCode=${frame.header.responseCode}`,
      );
    }

    this.client.subscribed = false;
    this.client.refreshKeepAlive?.();
    throw new Error(
      `subscribeEvents failed: camera rejected cmdId=31 (last responseCode=${lastCode ?? "unknown"})`,
    );
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
  private async checkAndDispatchCurrentState(
    channel: number = 0,
  ): Promise<void> {
    try {
      await this.checkAndDispatchMotionState(channel);
      await this.checkAndDispatchAiState(channel);
    } catch (e) {
      // Log but don't throw - state checking should be best-effort
      const msg = formatErrorForLog(e);
      (this.logger.warn ?? this.logger.error)?.call(
        this.logger,
        `[ReolinkBaichuanApi] Error checking current state (ch=${channel})${formatClientIoForLog(this)}: ${msg}`,
      );
    }
  }

  private async checkAndDispatchMotionState(channel: number): Promise<void> {
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
        const event: ReolinkSimpleEvent = {
          type: "motion",
          channel,
          timestamp: Date.now(),
        };
        this.dispatchSimpleEvent(event);
      }
    }
  }

  private async checkAndDispatchAiState(channel: number): Promise<void> {
    if (this.aiStatePollingDisabled) return;

    try {
      const aiState = await this.getAiState(channel);
      if (!aiState || aiState.alarm_state === undefined) return;

      const aiStateChanged =
        !this.lastAiState ||
        this.lastAiState.alarm_state !== aiState.alarm_state ||
        this.lastAiState.support !== aiState.support;

      if (!aiStateChanged) return;

      this.lastAiState = aiState;
      if (aiState.alarm_state === 1) {
        const event: ReolinkSimpleEvent = {
          type: "other",
          channel,
          timestamp: Date.now(),
        };
        this.dispatchSimpleEvent(event);
      }
    } catch (error) {
      // Some firmwares/NVRs reject cmd 342 and may also tear down the TCP session.
      // To avoid a reconnect loop, disable AI polling after the first failure.
      this.aiStatePollingDisabled = true;

      const msg = formatErrorForLog(error);
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
        this.logger.debug?.(
          `[ReolinkBaichuanApi] state polling tick failed${formatClientIoForLog(this)}: ${msg}`,
        );
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
   * UDP/battery cameras don't support safe active polling, but we still want sleeping/awake events.
   * This timer uses getSleepStatus() which is purely passive (no network requests).
   */
  private startUdpSleepInference(): void {
    if (this.simpleEventListeners.size === 0) {
      this.stopUdpSleepInference();
      return;
    }

    const isUdp = this.client.getTransport?.() === "udp";
    if (!isUdp) {
      this.stopUdpSleepInference();
      return;
    }

    if (this.udpSleepInferenceInterval) return;

    const pollOnce = () => {
      // Stop if transport changed or listeners are gone.
      if (
        this.simpleEventListeners.size === 0 ||
        this.client.getTransport?.() !== "udp"
      ) {
        this.stopUdpSleepInference();
        return;
      }

      const channel = this.client.getConfiguredChannel?.() ?? 0;
      const status = this.getSleepStatus({ channel });
      if (status.state === "unknown") return;

      const prev = this.udpLastInferredSleepStateByChannel.get(channel);
      this.udpLastInferredSleepStateByChannel.set(channel, status.state);

      // On first observation, only emit if sleeping (awake is the default and would be noisy).
      if (prev === undefined) {
        if (status.state === "sleeping") {
          this.dispatchSimpleEvent({
            type: "sleeping",
            channel,
            timestamp: Date.now(),
          });
        }
        return;
      }

      if (prev !== status.state) {
        this.dispatchSimpleEvent({
          type: status.state === "sleeping" ? "sleeping" : "awake",
          channel,
          timestamp: Date.now(),
        });
      }
    };

    // Run immediately for quicker feedback.
    pollOnce();

    this.udpSleepInferenceInterval = setInterval(() => {
      try {
        pollOnce();
      } catch (e) {
        // Never let inference crash callers.
        this.logger.debug?.(
          `[ReolinkBaichuanApi] udp sleep inference tick failed${formatClientIoForLog(this)}: ${formatErrorForLog(e)}`,
        );
      }
    }, this.udpSleepInferenceIntervalMs);
  }

  private stopUdpSleepInference(): void {
    if (this.udpSleepInferenceInterval) {
      clearInterval(this.udpSleepInferenceInterval);
      this.udpSleepInferenceInterval = undefined;
    }
    this.udpLastInferredSleepStateByChannel.clear();
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
    const xml = await this.sendXml({
      cmdId,
      ...(channel !== undefined ? { channel } : {}),
    });
    const ch = this.normalizeChannel(channel);
    const nowMs = Date.now();

    return parseEventsFromGetEventsXml({ xml, channel: ch, nowMs });
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
    const xml = await this.sendXml({
      cmdId,
      ...(channel !== undefined ? { channel } : {}),
    });
    // Check for audioStreamMode - both mixAudioStream and followVideoStream support two-way audio
    const audioStreamMode = getXmlText(xml, "audioStreamMode");
    // Both modes support two-way audio, just different mixing strategies
    const enabled =
      audioStreamMode === "mixAudioStream" ||
      audioStreamMode === "followVideoStream";

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
    },
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
    const profileConfig: Record<
      StreamProfile,
      { handle: number; streamType: number; streamName: string }
    > = {
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
      throw new Error(
        `Invalid native stream variant for profile: ${profile} (variant=${variant})`,
      );
    }

    const config = profileConfig[profile];
    if (!config) {
      throw new Error(`Invalid stream profile: ${profile}`);
    }
    if (!config.streamName) {
      throw new Error(
        `Stream name not found for profile: ${profile}, config: ${JSON.stringify(config)}`,
      );
    }

    // Build Preview XML payload
    // BcXml serializes as <body>...</body> with Preview inside
    // IMPORTANT: channelId is NOT in Preview XML - it's handled via channelId in header
    // The working format (response_code 200) is Preview WITHOUT channelId
    const streamName = config.streamName;
    // Debug: verify streamName is defined
    if (typeof streamName !== "string") {
      throw new Error(
        `streamName is not a string: ${typeof streamName}, value: ${streamName}, config: ${JSON.stringify(config)}`,
      );
    }
    const payloadXml = buildPreviewXml(config.handle, streamName, channelId);

    // PCAP-observed Hub/NVR Preview request for "tele" view uses Preview v1.1 and keeps header streamType=0.
    // We observed two distinct patterns:
    // - Sub tele:  <channelId>CH</channelId> <handle>512+CH</handle>  <streamType>mobileStream</streamType>
    // - Main tele: <channelId>CH</channelId> <handle>1024+CH</handle> <streamType>externStream</streamType>
    // Also, some firmwares appear to use 0-based CH, others 1-based.
    const telePreviewStreamType =
      variant === "telephoto" && profile === "main"
        ? "externStream"
        : variant === "telephoto" && profile === "sub"
          ? "mobileStream"
          : undefined;
    const teleHandleBase =
      variant === "telephoto" && profile === "main"
        ? 1024
        : variant === "telephoto" && profile === "sub"
          ? 512
          : undefined;
    const teleChannelIdCandidates =
      variant === "telephoto" &&
      telePreviewStreamType &&
      teleHandleBase !== undefined
        ? Array.from(
            new Set(
              [channelId, channelId + 1].filter(
                (n) => Number.isFinite(n) && n >= 0,
              ),
            ),
          )
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
        let frame:
          | Awaited<ReturnType<typeof this.client.sendFrame>>
          | undefined;
        if (
          teleChannelIdCandidates.length > 0 &&
          telePreviewStreamType &&
          teleHandleBase !== undefined
        ) {
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
            `Video stream request rejected (response_code ${frame.header.responseCode}). Expected response_code 200, camera returned ${frame.header.responseCode}`,
          );
        }

        // Remember msgNum so we can stop the stream with the same msgNum.
        this.activeVideoMsgNums.set(
          `${ch}:${profile}:${variant}`,
          frame.header.msgNum,
        );

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
  getActiveVideoMsgNum(
    channel?: number,
    profile: StreamProfile = "sub",
  ): number | undefined {
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
    },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;

    const variant: NativeVideoStreamVariant = options?.variant ?? "default";

    // Map profile to handle value
    const profileConfig: Record<
      StreamProfile,
      { handle: number; streamType: number }
    > = {
      main: { handle: 0, streamType: variant === "default" ? 0 : 2 },
      sub: { handle: 256, streamType: variant === "default" ? 1 : 3 },
      ext: { handle: 1024, streamType: 0 },
    };

    if (variant !== "default" && profile === "ext") {
      throw new Error(
        `Invalid native stream variant for profile: ${profile} (variant=${variant})`,
      );
    }

    const config = profileConfig[profile];

    const teleHandleBase =
      variant === "telephoto" && profile === "main"
        ? 1024
        : variant === "telephoto" && profile === "sub"
          ? 512
          : undefined;
    const teleChannelIdCandidates =
      variant === "telephoto" && teleHandleBase !== undefined
        ? Array.from(
            new Set(
              [channelId, channelId + 1].filter(
                (n) => Number.isFinite(n) && n >= 0,
              ),
            ),
          )
        : [];

    const key = `${ch}:${profile}:${variant}`;
    const msgNum = this.activeVideoMsgNums.get(key);
    this.activeVideoMsgNums.delete(key);

    // Send VIDEO_STOP with the same msg_num as VIDEO.
    // Some cameras don't reliably reply; treat this as best-effort with a short timeout.
    try {
      const attempts: Array<{
        extensionXml: string;
        payloadXml: string;
        streamType: number;
      }> = [];

      // Hub/NVR multifocal tele streams are started with Preview v1.1 + streamType=0 and a handle derived from channelId.
      if (teleChannelIdCandidates.length > 0 && teleHandleBase !== undefined) {
        for (const teleChannelIdTag of teleChannelIdCandidates) {
          const handle = teleHandleBase + teleChannelIdTag;
          attempts.push({
            extensionXml: "",
            payloadXml: buildPreviewStopXmlV11({
              channelId: teleChannelIdTag,
              handle,
            }),
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
        if (msgNum !== undefined)
          this.client.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
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
    let xml = "";
    try {
      xml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_PTZ_PRESET,
        channel: ch,
        channelIdOverride: channelId,
        extensionXml: buildChannelExtensionXml(channelId),
        messageClass: BC_CLASS_MODERN_24,
        streamType: 0,
      });
    } catch (e) {
      // Non-PTZ cameras commonly respond with `responseCode=400` and empty body.
      // Treat that as "unsupported" and return an empty list so higher-level flows
      // (e.g. device add / capability probing) can continue.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("responseCode 400, empty body")) return [];
      throw e;
    }

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

  private parsePtzPresetList(
    xml: string,
  ): Array<{ id: number; name?: string; enable?: string }> {
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

  private async getPtzPresetsRaw(
    channel: number,
  ): Promise<Array<{ id: number; name?: string; enable?: string }>> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;
    let xml = "";
    try {
      xml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_PTZ_PRESET,
        channel: ch,
        channelIdOverride: channelId,
        extensionXml: buildChannelExtensionXml(channelId),
        messageClass: BC_CLASS_MODERN_24,
        streamType: 0,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("responseCode 400, empty body")) return [];
      throw e;
    }
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
  async ptz(
    channelOrCommand: number | PtzCommand,
    command?: PtzCommand,
  ): Promise<void> {
    const ch =
      typeof channelOrCommand === "number"
        ? this.normalizeChannel(channelOrCommand)
        : 0;
    const resolvedCommand =
      typeof channelOrCommand === "number" ? command! : channelOrCommand;
    // Use the same channel_id in meta header, Extension and payload XML.
    // This is 0-based.
    const channelId = ch;

    const direction = resolvePtzDirection(resolvedCommand);
    const speed = resolvePtzSpeed(direction, resolvedCommand.speed);

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
      const errorDetails = extractFrameErrorDetails({
        client: this.client,
        frame,
      });
      throw new Error(
        `PTZ control rejected (response_code ${frame.header.responseCode})${errorDetails}`,
      );
    }

    // If action is "start", send a stop after a short delay.
    // Some integrations need to tune the movement amount per command.
    if (resolvedCommand.action === "start" && direction !== "stop") {
      const autoStopMs = resolvedCommand.autoStopMs ?? 500;
      if (autoStopMs > 0) {
        setTimeout(() => {
          this.ptz(ch, {
            action: "stop",
            command: resolvedCommand.command,
          }).catch(() => {
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
    const ch =
      arg2 === undefined
        ? this.normalizeChannel(undefined)
        : this.normalizeChannel(arg1);
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
      throw new Error(
        `PTZ preset move rejected (response_code ${frame.header.responseCode})`,
      );
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
  async setPtzPreset(
    presetId: number,
    name: string,
    channel?: number,
  ): Promise<void>;
  async setPtzPreset(
    channel: number,
    presetId: number,
    name: string,
  ): Promise<void>;
  async setPtzPreset(
    arg1: number,
    arg2: number | string,
    arg3?: string | number,
  ): Promise<void> {
    const ch =
      typeof arg2 === "string"
        ? this.normalizeChannel(arg3 as number | undefined)
        : this.normalizeChannel(arg1);
    const presetId = typeof arg2 === "string" ? arg1 : (arg2 as number);
    const name = typeof arg2 === "string" ? arg2 : (arg3 as string);
    const channelId = ch;
    // Important: some firmwares will keep a deleted preset "disabled" (enable=0) and will omit it from cmd190.
    // Sending enable=1 ensures the slot becomes visible again.
    const payloadXml = buildPtzPresetXmlV2(channelId, presetId, "setPos", {
      name,
      enable: 1,
    });

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
      throw new Error(
        `PTZ preset save rejected (response_code ${frame.header.responseCode})`,
      );
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
    const ch =
      arg2 === undefined
        ? this.normalizeChannel(undefined)
        : this.normalizeChannel(arg1);
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

    const attempts = buildDeletePtzPresetAttempts({
      channelId,
      presetId,
      ...(currentName ? { currentName } : {}),
    });

    const { any200, lastError } = await runDeletePtzPresetAttempts({
      attempts,
      send: async (payloadXml, _label) => {
        const frame = await this.client.sendFrame({
          cmdId: BC_CMD_ID_PTZ_CONTROL_PRESET,
          channel: ch,
          channelIdOverride: channelId,
          extensionXml,
          payloadXml,
          messageClass: BC_CLASS_MODERN_24,
          streamType: 0,
        });

        return { responseCode: frame.header.responseCode };
      },
      verify: async () => {
        // Verify removal/disable. Some firmwares return 200 but do not apply the change.
        // Important: consider enable=0 or empty name as "deleted" even if the slot still exists.
        const after = await this.getPtzPresetsRaw(ch);
        const entry = after.find((p) => p.id === presetId);
        return isPresetEffectivelyDeleted(entry);
      },
    });

    // Many firmwares accept the request (200) but ignore it; don't block the caller.
    // The plugin can still hide the preset by removing it from the enabled list.
    if (any200) {
      this.logger.warn(
        "PTZ presets (baichuan): deletePtzPreset did not take effect (firmware ignored request)",
        {
          channel: ch,
          channelId,
          presetId,
        },
      );
      return;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("PTZ preset delete failed");
  }

  /**
   * Get current PTZ position.
   * cmd_id: 433 (Get PTZ position)
   *
   * @param channel - Channel number (0-based)
   * @returns PTZ position (pan and tilt)
   */
  async getPtzPosition(channel?: number): Promise<PtzPosition> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PTZ_POSITION,
      channel: ch,
    });

    const panText = getXmlText(xml, "pPos");
    const tiltText = getXmlText(xml, "tPos");

    const result: PtzPosition = {};
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
  async getZoomFocus(channel?: number): Promise<ZoomFocusStatus> {
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

    const parseTriplet = (sectionTag: string): ZoomFocusTriplet | undefined => {
      const sectionMatch = new RegExp(
        `<${sectionTag}>([\\s\\S]*?)</${sectionTag}>`,
      ).exec(xml);
      const sectionXml = sectionMatch?.[1];
      if (!sectionXml) return undefined;
      const maxPos = getXmlText(sectionXml, "maxPos");
      const minPos = getXmlText(sectionXml, "minPos");
      const curPos = getXmlText(sectionXml, "curPos");
      if (maxPos === undefined || minPos === undefined || curPos === undefined)
        return undefined;
      return {
        maxPos: Number(maxPos),
        minPos: Number(minPos),
        curPos: Number(curPos),
      };
    };

    const out: ZoomFocusStatus = {};
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
      throw new Error(
        "Camera did not return <zoom> info (zoom may be unsupported)",
      );
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
      throw new Error(
        `Zoom rejected (response_code ${frame.header.responseCode})`,
      );
    }
  }

  // --------------------
  // Battery Info API
  // --------------------

  private parseBatteryInfoXml(
    xml: string,
    channel: number,
  ): Partial<BatteryInfo> {
    const parseNum = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // Prefer parsing the matching <BatteryInfo> block when a list is returned.
    const batteryInfoBlocks = getXmlBlocks(xml, "BatteryInfo");
    const preferredBlock =
      batteryInfoBlocks.find(
        (b) => getXmlText(b, "channelId") === String(channel),
      ) ??
      batteryInfoBlocks[0] ??
      xml;

    const out: Partial<BatteryInfo> = {};

    const batteryPercent = parseNum(
      getXmlText(preferredBlock, "batteryPercent"),
    );
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

    const batteryVersion = parseNum(
      getXmlText(preferredBlock, "batteryVersion"),
    );
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
        opts?.ignoreCmdIds ?? [
          BC_CMD_ID_UDP_KEEP_ALIVE,
          BC_CMD_ID_GET_BATTERY_INFO_LIST,
          BC_CMD_ID_GET_BATTERY_INFO,
          BC_CMD_ID_FLOODLIGHT_STATUS_LIST,
        ],
    );
    const transport = this.client.getTransport?.();
    if (transport !== "udp") {
      return {
        state: "unknown",
        reason: "sleep inference supported only for UDP/battery",
      };
    }

    // If we are actively streaming, treat the device as awake.
    // This check lives in the client and includes cross-client streaming activity within the same process.
    if (
      this.activeVideoMsgNums.size > 0 ||
      this.rtspServers.size > 0 ||
      this.client.isDeviceStreamingActive?.()
    ) {
      return { state: "awake", reason: "active streaming" };
    }

    const socketConnected = this.client.isSocketConnected?.() ?? false;

    const now = Date.now();
    const cutoff = now - windowMs;

    const rx = (this.client.getRxHistory?.() ?? []).filter(
      (h) => h.atMs >= cutoff,
    );
    const tx = (this.client.getTxHistory?.() ?? []).filter(
      (h) => h.atMs >= cutoff,
    );

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
      return {
        state: "unknown",
        reason: "sleep probe supported only for UDP/battery",
      };
    }

    // If we are actively streaming, treat the device as awake.
    // This check lives in the client and includes cross-client streaming activity within the same process.
    if (
      this.activeVideoMsgNums.size > 0 ||
      this.rtspServers.size > 0 ||
      this.client.isDeviceStreamingActive?.()
    ) {
      return { state: "awake", reason: "active streaming" };
    }

    const now = Date.now();
    const minIntervalMs = opts?.minIntervalMs ?? 5_000;
    if (this.lastSleepProbe && now - this.lastSleepProbe.atMs < minIntervalMs) {
      return {
        ...this.lastSleepProbe.status,
        reason: `${this.lastSleepProbe.status.reason} (cached)`,
      };
    }

    // Avoid implicitly forcing a login/reconnect as part of a "sleep check".
    if (!this.client.isSocketConnected()) {
      const status: SleepStatus = {
        state: "unknown",
        reason: "udp socket not connected",
      };
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
        const frame = await this.client.sendFrame({
          cmdId,
          channel: ch,
          timeoutMs,
        });
        const status: SleepStatus = {
          state: frame.header.responseCode === 200 ? "awake" : "unknown",
          reason: `probe cmdId=${cmdId} responseCode=${frame.header.responseCode}`,
        };
        this.lastSleepProbe = { atMs: Date.now(), status };
        return status;
      } catch (e) {
        // On timeout, interpret as sleeping (best-effort). Other errors remain unknown.
        const msg = e instanceof Error ? e.message : String(e);
        const isTimeout =
          msg.includes("Baichuan timeout") ||
          msg.toLowerCase().includes("timeout");
        if (isTimeout) {
          const status: SleepStatus = {
            state: "sleeping",
            reason: `probe timeout cmdId=${cmdId} timeoutMs=${timeoutMs}`,
          };
          this.lastSleepProbe = { atMs: Date.now(), status };
          return status;
        }
        // Retry on transient errors if attempts > 1.
        if (i === attempts - 1) {
          const status: SleepStatus = {
            state: "unknown",
            reason: `probe error cmdId=${cmdId}: ${msg}`,
          };
          this.lastSleepProbe = { atMs: Date.now(), status };
          return status;
        }
      }
    }

    const fallback: SleepStatus = {
      state: "unknown",
      reason: "probe exhausted",
    };
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
          setTimeout(() => reject(new Error("Timeout")), 5000),
        ),
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
    const xml = await this.client.sendXml({
      cmdId: BC_CMD_ID_GET_BATTERY_INFO,
      channel: ch,
    });

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
  async wakeUp(
    channel?: number,
    options?: number | WakeUpOptions,
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const opts: WakeUpOptions =
      typeof options === "number"
        ? { waitAfterWakeMs: options }
        : (options ?? {});

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

        if (waitAfterWakeMs > 0) await sleepMs(waitAfterWakeMs);
        return;
      } catch (e) {
        lastError = e;

        // Common cases when the camera is sleeping or the session/socket is stale:
        // - timeout waiting for reply
        // - socket closed
        const msg = e instanceof Error ? e.message : String(e);
        const looksLikeTimeout = msg.includes("Baichuan timeout");
        const looksLikeClosed =
          msg.toLowerCase().includes("socket closed") ||
          msg.toLowerCase().includes("stream closed");

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

          if (backoffMs > 0) await sleepMs(backoffMs);
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
          setTimeout(() => reject(new Error("Timeout")), 5000),
        ),
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
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PIR_INFO,
      channel: ch,
    });
    return parsePirInfoFromXml({ xml, channel: ch });
  }

  /**
   * Set PIR (Passive Infrared) detection settings via Baichuan.
   * cmd_id: 213 (MSG_ID_START_PIR_ALARM)
   *
   * @param channel - Channel number (0-based)
   * @param params - PIR settings (enable is required)
   */
  async setPirInfo(
    params: {
      enable: number;
      sensitive?: number;
      reduceAlarm?: number;
      interval?: number;
    },
    channel?: number,
  ): Promise<void>;
  async setPirInfo(
    channel: number,
    params: {
      enable: number;
      sensitive?: number;
      reduceAlarm?: number;
      interval?: number;
    },
  ): Promise<void>;
  async setPirInfo(
    arg1:
      | number
      | {
          enable: number;
          sensitive?: number;
          reduceAlarm?: number;
          interval?: number;
        },
    arg2?:
      | number
      | {
          enable: number;
          sensitive?: number;
          reduceAlarm?: number;
          interval?: number;
        },
  ): Promise<void> {
    const channel =
      typeof arg1 === "number" ? arg1 : (arg2 as number | undefined);
    const params =
      typeof arg1 === "number"
        ? (arg2 as {
            enable: number;
            sensitive?: number;
            reduceAlarm?: number;
            interval?: number;
          })
        : arg1;
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
    const currentXml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PIR_INFO,
      channel: ch,
    });

    // Parse and modify XML
    let modifiedXml = currentXml;

    if (params.enable !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<enable>[^<]*<\/enable>/,
        `<enable>${params.enable}</enable>`,
      );
    }
    if (params.sensitive !== undefined) {
      const raw = toPirSensitivityRaw(params.sensitive);
      modifiedXml = modifiedXml.replace(
        /<sensiValue>[^<]*<\/sensiValue>/,
        `<sensiValue>${raw}</sensiValue>`,
      );
    }
    if (params.reduceAlarm !== undefined) {
      const n = toBoolishNumber(params.reduceAlarm);
      if (n !== undefined) {
        modifiedXml = modifiedXml.replace(
          /<reduceFalseAlarm>[^<]*<\/reduceFalseAlarm>/,
          `<reduceFalseAlarm>${n}</reduceFalseAlarm>`,
        );
      }
    }
    if (params.interval !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<interval>[^<]*<\/interval>/,
        `<interval>${params.interval}</interval>`,
      );
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
  async setMotionDetection(
    enabled: boolean,
    sensitivity?: number,
    channel?: number,
  ): Promise<void>;
  async setMotionDetection(
    channel: number,
    enabled: boolean,
    sensitivity?: number,
  ): Promise<void>;
  async setMotionDetection(
    arg1: number | boolean,
    arg2?: boolean | number,
    arg3?: number,
  ): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : arg3;
    const enabled = typeof arg1 === "number" ? (arg2 as boolean) : arg1;
    const sensitivity =
      typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const ch = this.normalizeChannel(channel);
    // First get current settings
    const currentXml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_MOTION_ALARM,
      channel: ch,
    });

    // Parse and modify XML
    // Expected format: <sensInfoNew><enable>...</enable><sensitivityDefault>...</sensitivityDefault></sensInfoNew>
    let modifiedXml = currentXml;

    if (enabled !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<enable>[^<]*<\/enable>/,
        `<enable>${enabled ? "1" : "0"}</enable>`,
      );
    }
    if (sensitivity !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<sensitivityDefault>[^<]*<\/sensitivityDefault>/,
        `<sensitivityDefault>${sensitivity}</sensitivityDefault>`,
      );
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
  async setAiDetection(
    aiType: string,
    sensitivity?: number,
    stayTime?: number,
    channel?: number,
  ): Promise<void>;
  async setAiDetection(
    channel: number,
    aiType: string,
    sensitivity?: number,
    stayTime?: number,
  ): Promise<void>;
  async setAiDetection(
    arg1: number | string,
    arg2?: string | number,
    arg3?: number,
    arg4?: number,
  ): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : arg4;
    const aiType = typeof arg1 === "number" ? (arg2 as string) : arg1;
    const sensitivity =
      typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const stayTime = typeof arg1 === "number" ? arg4 : arg3;
    const ch = this.normalizeChannel(channel);

    const resolvedAiType = await this.resolveAiTypeForSetAiDetection(
      ch,
      aiType,
    );

    // First get current settings for this AI type.
    // Correct cmd 342 payload: <AiDetectCfg><chn>0-based</chn><type>people</type></AiDetectCfg>
    const getXml = `<?xml version="1.0" encoding="UTF-8" ?>
  <body>
  <AiDetectCfg version="1.1">
  <chn>${ch}</chn>
  <type>${xmlEscape(resolvedAiType)}</type>
  </AiDetectCfg>
  </body>`;

    const currentXml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_AI_ALARM,
      channel: ch,
      payloadXml: getXml,
    });

    // Parse and modify XML
    let modifiedXml = currentXml;

    if (sensitivity !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<sensitivity>[^<]*<\/sensitivity>/,
        `<sensitivity>${sensitivity}</sensitivity>`,
      );
    }
    if (stayTime !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<stayTime>[^<]*<\/stayTime>/,
        `<stayTime>${stayTime}</stayTime>`,
      );
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
  async getSiren(channel?: number): Promise<SirenState> {
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
  async setSiren(
    on?: boolean,
    duration?: number,
    channel?: number,
  ): Promise<void>;
  async setSiren(
    channel: number | undefined,
    on?: boolean,
    duration?: number,
  ): Promise<void>;
  async setSiren(
    arg1?: number | boolean,
    arg2?: boolean | number,
    arg3?: number,
  ): Promise<void> {
    const channel =
      typeof arg1 === "boolean" ? (arg3 ?? 0) : (arg1 as number | undefined);
    const on = typeof arg1 === "boolean" ? arg1 : (arg2 as boolean | undefined);
    const duration =
      typeof arg1 === "boolean" ? (arg2 as number | undefined) : arg3;

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
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_WHITE_LED,
      channel: ch,
    });
    return parseWhiteLedStateFromXml(xml);
  }

  /**
   * Set white LED/floodlight state via Baichuan.
   * cmd_id: 288 (SetWhiteLed state) or 290 (SetWhiteLed task)
   *
   * @param channel - Channel number (0-based)
   * @param on - Enable/disable white LED
   * @param brightness - Brightness level (optional)
   */
  async setWhiteLedState(
    on?: boolean,
    brightness?: number,
    channel?: number,
  ): Promise<void>;
  async setWhiteLedState(
    channel: number,
    on?: boolean,
    brightness?: number,
  ): Promise<void>;
  async setWhiteLedState(
    arg1?: number | boolean,
    arg2?: boolean | number,
    arg3?: number,
  ): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : (arg3 ?? 0);
    const on =
      typeof arg1 === "number"
        ? (arg2 as boolean | undefined)
        : (arg1 as boolean | undefined);
    const brightness =
      typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const ch = this.normalizeChannel(channel);

    // Many firmwares use:
    // - cmd 288: FloodlightManual (write) for manual on/off
    // - cmd 290: FloodlightTask (write) for task config / brightness
    // Historically we sent a <WhiteLed> payload which can yield 400 on many cameras.
    if (on !== undefined) {
      try {
        const payloadXml = buildWhiteLedManualPayloadXml(ch, on);
        await this.sendXml({
          cmdId: BC_CMD_ID_SET_WHITE_LED_STATE,
          channel: ch,
          payloadXml,
        });
      } catch {
        // Fallback: use task XML returned by cmd 289, update <enable>/<state>/<status> and send with cmd 290.
        const currentXml = await this.sendXml({
          cmdId: BC_CMD_ID_GET_WHITE_LED,
          channel: ch,
        });
        const modifiedXml = applyWhiteLedOnOffToXml(currentXml, on);

        await this.sendXml({
          cmdId: BC_CMD_ID_SET_WHITE_LED_TASK,
          channel: ch,
          payloadXml: modifiedXml,
        });
      }
    }

    if (brightness !== undefined) {
      const currentXml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_WHITE_LED,
        channel: ch,
      });
      const modifiedXml = applyWhiteLedBrightnessToXml(currentXml, brightness);

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
  async getAbilityInfo(): Promise<
    Partial<
      Record<number | "Host", Record<string, number | string | undefined>>
    >
  > {
    // Return type matches DeviceAbilities from types.ts
    const user = this.client.username;
    const extensionXml = buildAbilityInfoExtensionXml(user);

    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_ABILITY_INFO,
      extensionXml,
    });

    return parseAbilityInfoXml(xml);
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
  async getAbilityVersion(
    capability: string,
    channel?: number | null,
  ): Promise<number> {
    const abilities = await this.getAbilityInfo();
    const channelKey: number | "Host" =
      channel !== undefined && channel !== null ? channel : "Host";
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
  async getSupportInfo(options?: {
    timeoutMs?: number;
    messageClass?: number;
  }): Promise<SupportInfo | undefined> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_SUPPORT,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.messageClass != null
        ? { messageClass: options.messageClass }
        : {}),
    });
    return parseSupportXml(xml);
  }

  /**
   * Best-effort floodlight support probe via cmd 289 (GetWhiteLed/Floodlight).
   *
   * Note: this probes ONLY the provided channel (no ch+1 fallback).
   */
  async probeFloodlightSupportByCmd289(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<boolean> {
    const ch = this.normalizeChannel(channel);
    // cmd 289 can be slow behind NVR/Hub; avoid false negatives due to timeouts.
    const timeoutMs = options?.timeoutMs ?? 2500;

    try {
      const xml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_WHITE_LED,
        channel: ch,
        timeoutMs,
      });
      this.logger.debug(
        `probeFloodlightSupportByCmd289: received XML for channel ${ch}:\n${xml}`,
      );

      return /(<FloodlightTask\b|<FloodlightManual\b|<FloodlightStatusList\b|<WhiteLed\b)/i.test(
        xml,
      );
    } catch {
      return false;
    }
  }

  /**
   * Returns AI object-detection types for a channel via cmd 299 (AiCfg).
   *
   * Uses <detectType> as the source of truth and returns a normalized string list.
   */
  async getAiDetectTypes(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<string[] | undefined> {
    const ch = this.normalizeChannel(channel);
    const timeoutMs = options?.timeoutMs ?? 1500;

    try {
      const xml = await this.sendXml({ cmdId: 299, channel: ch, timeoutMs });
      const detectTypeRaw = (getXmlText(xml, "detectType") ?? "").trim();
      if (!detectTypeRaw) return undefined;

      const list = detectTypeRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      return list.length > 0 ? list : undefined;
    } catch {
      return undefined;
    }
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

    const infoPromise: Promise<Partial<ReolinkDeviceInfo> | undefined> =
      channelProvided
        ? this.getInfo(ch, { tags: ["type"] })
        : Promise.resolve(undefined);

    const [abilitiesResult, supportResult, infoResult] =
      await Promise.allSettled([
        this.getAbilityInfo() as Promise<DeviceAbilities>,
        this.getSupportInfo(),
        infoPromise,
      ] as const);

    const abilitiesRaw =
      abilitiesResult.status === "fulfilled"
        ? abilitiesResult.value
        : undefined;
    const supportRaw =
      supportResult.status === "fulfilled" ? supportResult.value : undefined;
    const model =
      infoResult.status === "fulfilled" ? infoResult.value?.type : undefined;

    // If a channel is explicitly requested, filter returned metadata to avoid confusing callers.
    // Capabilities are always computed for `ch` (0-based).
    const abilities: DeviceAbilities | undefined = abilitiesRaw
      ? channelProvided
        ? ({
            ...(typeof abilitiesRaw.Host === "object"
              ? { Host: abilitiesRaw.Host }
              : {}),
            ...(typeof abilitiesRaw[ch] === "object"
              ? { [ch]: abilitiesRaw[ch] }
              : {}),
          } as DeviceAbilities)
        : abilitiesRaw
      : undefined;

    const support: SupportInfo | undefined = supportRaw
      ? channelProvided
        ? ({
            ...supportRaw,
            items: (supportRaw.items ?? []).filter((i) => i.chnID === ch),
          } satisfies SupportInfo)
        : supportRaw
      : undefined;

    const computeArgs: {
      channel: number;
      model?: string;
      abilities?: DeviceAbilities;
      support?: SupportInfo;
    } = { channel: ch };
    if (typeof model === "string" && model) computeArgs.model = model;
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
          rtsp: truthy(support.rtsp),
          onvif: truthy(support.onvif),
          wifi: truthy(support.wifi),
          record: truthy(support.record),
          ftp: truthy(support.ftp),
          email: truthy(support.email),
          pushAlarm: truthy(support.pushAlarm),
          audioTalk: truthy(support.audioTalk),
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
    // NOTE: Some firmwares/NVRs report `lightType=0` even when cmd289 returns Floodlight* payloads,
    // so we should not treat `lightType=0` as authoritative.
    if (probeCfg.probe && probeCfg.probeFloodlight && channelProvided) {
      const channelSupportItems = (support?.items ?? []).filter(
        (i) => i.chnID === ch || i.chnID === ch + 1,
      );

      const parseLightType = (item: SupportItem): number | undefined => {
        const v = item["lightType"];
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

      // If firmware explicitly says there is a light, trust that.
      if (lightTypes.some((v) => v > 0)) {
        capabilities.hasFloodlight = true;
      }

      // Always probe cmd 289 (even if lightType==0/unknown), as some devices/NVRs misreport it.
      // This is additive: once true, keep it true.
      const probed = await this.probeFloodlightSupportByCmd289(ch, {
        timeoutMs: 2500,
      });
      capabilities.hasFloodlight = capabilities.hasFloodlight || probed;
    }

    // Object-detection capabilities.
    // Always read cmd 299 (AiCfg) and use <detectType> as the single source of truth.
    // This avoids inference/probing variability across firmwares.
    const objects = await this.getAiDetectTypes(ch, { timeoutMs: 1500 });

    let presets: PtzPreset[] | undefined;
    // PTZ preset list (cmd 190) can return responseCode=400 with empty body on non-PTZ cameras.
    // AbilityInfo sometimes leaks legacy/host PTZ keys and can cause false positives.
    // If SupportInfo is available, require an explicit per-channel `ptzPreset` signal before probing.
    const pickBestSupportItemForChannel = (
      s: SupportInfo,
      chn: number,
    ): SupportItem | undefined => {
      const items = Array.isArray(s.items) ? s.items : [];
      const candidates = items.filter((i) => i.chnID === chn);
      if (!candidates.length) return undefined;

      const score = (item: SupportItem): number => {
        const anyItem = item as any;
        let result = 0;
        if (anyItem.name == null) result += 2;
        const capabilityKeys = [
          "ptzType",
          "ptzControl",
          "ptzPreset",
          "ledCtrl",
          "lightType",
          "battery",
          "audioVersion",
          "motion",
          "encCtrl",
          "newIspCfg",
          "remoteAbility",
        ];
        for (const k of capabilityKeys) {
          if (anyItem[k] !== undefined) result += 3;
        }
        result += Math.min(10, Math.max(0, Object.keys(anyItem).length - 1));
        return result;
      };

      return candidates.slice().sort((a, b) => score(b) - score(a))[0];
    };

    const supportItemForPresets = support
      ? pickBestSupportItemForChannel(support, ch)
      : undefined;
    const supportSaysPresets = supportItemForPresets
      ? truthy((supportItemForPresets as any).ptzPreset)
      : false;
    const shouldProbePresets =
      capabilities.hasPresets && (!support || supportSaysPresets);

    if (!shouldProbePresets && capabilities.hasPresets && support) {
      // If SupportInfo is present and doesn't explicitly advertise presets, treat it as not supported.
      capabilities.hasPresets = false;
    }

    if (shouldProbePresets) {
      const presetsResult = await this.getPtzPresets(ch);
      presets = presetsResult;
      capabilities.hasPresets = presets.length > 0;
    }

    // Dual-lens capability merge (simple): if the device is multifocal, OR capabilities across all lenses/channels.
    // This is especially important behind NVR/Hub where wide+tele can be exposed on the same channel.
    const mergeDualLens = options?.mergeDualLensOnSameChannel ?? true;
    if (mergeDualLens && channelProvided) {
      try {
        // Best-effort NVR/Hub hint: on NVR channels are typically >= 2.
        const dual = await this.getDualLensChannelInfo(ch, { onNvr: ch >= 2 });
        if (
          dual.isDualLens &&
          Array.isArray(dual.channels) &&
          dual.channels.length > 0
        ) {
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
          capabilities.hasPtz =
            capabilities.hasPtz ||
            capabilities.hasPan ||
            capabilities.hasTilt ||
            capabilities.hasZoom ||
            capabilities.hasPresets;
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
      const capabilities = await this.getDeviceCapabilities(channel, {
        mergeDualLensOnSameChannel: false,
      });
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
        const typeInfo = item["typeInfo"];
        if (typeof typeInfo === "string" && typeInfo.trim()) {
          normalizedModel = typeInfo.trim();
          break;
        }
      }
    }

    // More flexible matching: check exact match first, then partial match
    const checkModelMatch = (
      knownModels: Set<string>,
      modelToCheck: string,
    ): boolean => {
      if (!modelToCheck || modelToCheck.length === 0) return false;
      const lower = modelToCheck.toLowerCase().trim();
      for (const known of knownModels) {
        const knownLower = known.toLowerCase().trim();
        // Exact match (case-insensitive)
        if (lower === knownLower) return true;
        // Partial match: model contains known or known contains model
        // Also check if model starts with known or vice versa
        if (lower.includes(knownLower) || knownLower.includes(lower))
          return true;
        // Check for key words: "trackmix" or "duo"
        if (lower.includes("trackmix") && knownLower.includes("trackmix"))
          return true;
        if (lower.includes("duo") && knownLower.includes("duo")) return true;
      }
      return false;
    };

    const isDualMotionModel = normalizedModel
      ? checkModelMatch(DUAL_LENS_DUAL_MOTION_MODELS, normalizedModel)
      : false;
    const isSingleMotionModel = normalizedModel
      ? checkModelMatch(DUAL_LENS_SINGLE_MOTION_MODELS, normalizedModel)
      : false;

    // Also check if channelNum suggests dual lens (2-3 channels)
    // Handle both number and string types for channelNum
    const channelNumValue =
      typeof channelNum === "string"
        ? Number.parseInt(channelNum, 10)
        : channelNum;
    const hasDualLensChannelCount =
      channelNumValue === 2 && Number.isFinite(channelNumValue);

    // Consider it dual lens if model matches OR if channelNum suggests it
    const isDualLens =
      isDualMotionModel || isSingleMotionModel || hasDualLensChannelCount;

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
    let dualLensType: "dual_motion" | "single_motion" | undefined =
      isDualMotionModel
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
      if (
        channelNumValue &&
        Number.isFinite(channelNumValue) &&
        channelNumValue >= 2
      ) {
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
        const chCapabilities = await this.getDeviceCapabilities(ch, {
          mergeDualLensOnSameChannel: false,
        });
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
            const rtspVersion = chSupport?.rtsp;
            if (typeof rtspVersion === "number" && rtspVersion > 0) {
              availableStreams.rtsp = true;
            }
          } catch {
            // ignore
          }
        }

        // RTMP: check from support or features
        const rtmpRaw = chSupport ? chSupport["rtmp"] : undefined;
        if (typeof rtmpRaw === "number" && rtmpRaw > 0) {
          availableStreams.rtmp = true;
        }

        const makeLensVariant = (
          lensType: "wide" | "telephoto",
        ): NativeVideoStreamVariant => {
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
          `[ReolinkBaichuanApi] getDualLensChannelInfo: error in channel ${ch}: ${err}`,
        );
      }
    }

    // Build capability channel maps: for each capability, list all channels that support it
    const uniq = (xs: number[]): number[] => Array.from(new Set(xs));
    const capabilityChannels = {
      pan: uniq(channelInfos.filter((ch) => ch.hasPan).map((ch) => ch.channel)),
      tilt: uniq(
        channelInfos.filter((ch) => ch.hasTilt).map((ch) => ch.channel),
      ),
      zoom: uniq(
        channelInfos.filter((ch) => ch.hasZoom).map((ch) => ch.channel),
      ),
      motion: uniq(
        channelInfos.filter((ch) => ch.hasMotion).map((ch) => ch.channel),
      ),
      intercom: uniq(
        channelInfos.filter((ch) => ch.hasIntercom).map((ch) => ch.channel),
      ),
      presets: uniq(
        channelInfos.filter((ch) => ch.hasPresets).map((ch) => ch.channel),
      ),
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
    options?: RtspCreateOptions,
  ): Promise<BaichuanRtspServer>;
  async createRtspStream(
    channel: number,
    profile: StreamProfile,
    options?: RtspCreateOptions,
  ): Promise<BaichuanRtspServer>;
  async createRtspStream(
    channelOrProfile: number | StreamProfile,
    profileOrOptions?: StreamProfile | RtspCreateOptions,
    optionsMaybe?: RtspCreateOptions,
  ): Promise<BaichuanRtspServer> {
    const isChannelOverload = typeof channelOrProfile === "number";
    const ch = isChannelOverload ? this.normalizeChannel(channelOrProfile) : 0;

    let profile: StreamProfile;
    let options: RtspCreateOptions | undefined;
    if (isChannelOverload) {
      if (typeof profileOrOptions !== "string") {
        throw new Error(
          "createRtspStream(channel, profile, options): missing or invalid profile",
        );
      }
      profile = profileOrOptions;
      options = optionsMaybe;
    } else {
      profile = channelOrProfile;
      options =
        typeof profileOrOptions === "object" && profileOrOptions !== null
          ? profileOrOptions
          : undefined;
    }

    // Get stream metadata to determine codec
    let videoCodec: string | undefined;
    try {
      const metadata = await this.getStreamMetadata(ch);
      const stream = metadata.streams.find((s) => s.profile === profile);
      if (stream?.videoEncType) videoCodec = stream.videoEncType;
    } catch (error) {
      // If metadata fetch fails, codec will be auto-detected from stream
      this.logger.warn(
        `[ReolinkBaichuanApi] Could not fetch stream metadata, will auto-detect codec: ${error instanceof Error ? error.message : error}`,
      );
    }

    const rtspOptions: BaichuanRtspServerOptions = {
      api: this,
      channel: ch,
      profile,
      ...(options?.variant !== undefined ? { variant: options.variant } : {}),
      ...(options?.listenHost !== undefined
        ? { listenHost: options.listenHost }
        : {}),
      ...(options?.listenPort !== undefined
        ? { listenPort: options.listenPort }
        : {}),
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
  async buildVideoStreamOptions(options?: {
    channel?: number;
    compositeOnly?: boolean;
    onNvr?: boolean;
    lens?: NativeVideoStreamVariant;
  }): Promise<ReolinkVideoStreamOptionsResult> {
    const onNvr = options?.onNvr === true;
    const channel = options?.channel;
    const compositeOnly = options?.compositeOnly === true;

    const lensVariant: NativeVideoStreamVariant = options?.lens ?? "default";
    const cacheKey = JSON.stringify({
      channel: channel ?? null,
      onNvr,
      compositeOnly,
      lens: lensVariant,
    });

    const cached = this.videoStreamOptionsCache.get(cacheKey);

    const isNonEmpty = (r: ReolinkVideoStreamOptionsResult) =>
      r.nativeStreams.length > 0 ||
      r.rtspStreams.length > 0 ||
      r.rtmpStreams.length > 0;

    const cacheOrFallback = (result: ReolinkVideoStreamOptionsResult) => {
      // Never overwrite a good cached value with empty/transient results.
      if (isNonEmpty(result)) {
        this.videoStreamOptionsCache.set(cacheKey, result);
        return result;
      }

      if (cached && isNonEmpty(cached)) {
        return cached;
      }

      return result;
    };

    const logDebug = (msg: string, data?: unknown): void => {
      this.logger.debug(msg, data);
    };

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
      const info = await this.getInfo(onNvr ? ch : undefined, {
        tags: ["type"],
      });
      model = typeof info.type === "string" ? info.type.toLowerCase() : "";
      isMultiFocal = isDualLenseModel(model);
      isTrackMix = model.includes("trackmix");
    } catch (e) {
      logDebug(
        "[ReolinkBaichuanApi] buildVideoStreamOptions: getInfo(type) failed",
        {
          host: this.host,
          onNvr,
          channel,
          normalizedChannel: ch,
          err: e instanceof Error ? e.message : String(e),
        },
      );
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
      logDebug(
        "[ReolinkBaichuanApi] buildVideoStreamOptions: compositeOnly requested but device not detected multifocal; returning empty",
        {
          host: this.host,
          channel,
          normalizedChannel: ch,
          model,
          isMultiFocal,
        },
      );
      const result = {
        nativeStreams,
        rtmpStreams,
        rtspStreams,
      };

      return cacheOrFallback(result);
    }

    if (isMultiFocal && (compositeOnly || channel === undefined)) {
      let widerMetadata: ChannelStreamMetadata | undefined;
      try {
        widerMetadata = await this.getStreamMetadata(0);
      } catch (e) {
        logDebug(
          "[ReolinkBaichuanApi] buildVideoStreamOptions: getStreamMetadata(0) failed",
          {
            host: this.host,
            err: e instanceof Error ? e.message : String(e),
          },
        );
      }

      const widerStreams = widerMetadata?.streams || [];
      const widerMain = widerStreams.find((s) => s.profile === "main");
      const widerMainIsH264 =
        typeof widerMain?.videoEncType === "string"
          ? widerMain.videoEncType.toLowerCase().includes("264")
          : false;
      logDebug(
        "[ReolinkBaichuanApi] buildVideoStreamOptions: composite branch metadata",
        {
          host: this.host,
          widerStreamsCount: widerStreams.length,
          profiles: widerStreams.map((s) => s.profile),
          widerMainIsH264,
        },
      );

      // Expose two composite stream options (main/sub).
      // IMPORTANT:
      // - Default wider lens uses `sub` to reduce drift.
      // - If wider `main` is H.264, allow preferring it for the composite `main` option.
      const widerSubProfile: StreamProfile = widerStreams.some(
        (s) => s.profile === "sub",
      )
        ? "sub"
        : ((widerStreams[0]?.profile as StreamProfile) ?? "sub");
      const widerMainProfileIfOk: StreamProfile | undefined =
        widerMainIsH264 && widerStreams.some((s) => s.profile === "main")
          ? "main"
          : undefined;

      const compositeProfiles: StreamProfile[] = ["main", "sub"];
      for (const teleProfile of compositeProfiles) {
        const effectiveWiderProfile: StreamProfile =
          teleProfile === "main" && widerMainProfileIfOk
            ? widerMainProfileIfOk
            : widerSubProfile;
        const widerSelectedMetadata =
          widerStreams.find((s) => s.profile === effectiveWiderProfile) ??
          widerStreams[0];

        const compositeUrl = new URL(
          `baichuan://${this.host}/composite/profile/${teleProfile}`,
        );
        const compositeUrlWithAuth = new URL(
          `baichuan://${this.host}/composite/profile/${teleProfile}`,
        );
        compositeUrlWithAuth.username = this.username;
        compositeUrlWithAuth.password = this.password;

        // Explicit source ids:
        // - composite-native-<variant>-<wider>-<tele>
        // - composite-rtsp-<variant>-<wider>-<tele>
        nativeStreams.push({
          name: `Native composite ${teleProfile}`,
          id: `composite-native-${lensVariant}-${effectiveWiderProfile}-${teleProfile}`,
          container: "rtp",
          profile: teleProfile,
          lens: "composite",
          url: compositeUrl.toString(),
          urlWithAuth: compositeUrlWithAuth.toString(),
          ...(widerSelectedMetadata ? { metadata: widerSelectedMetadata } : {}),
        });

        // Only advertise RTSP-input composite when:
        // - RTSP is enabled on the device
        // - and the selected profiles are likely H.264
        let rtspEnabled = false;
        try {
          const netPort = await this.getNetPort();
          rtspEnabled = netPort.rtsp?.enable === 1;
        } catch {
          rtspEnabled = false;
        }

        // (The server will enforce H.264-only anyway; this avoids listing known-bad combos.)
        // On NVR/Hub TrackMix, tele RTSP is often exposed only as `main` (e.g. Preview_XX_autotrack).
        // In that case, the *output* composite profile can still be `sub`, while the tele *input* profile is `main`.
        const teleRtspInputProfile: StreamProfile =
          onNvr && isTrackMix && teleProfile === "sub" ? "main" : teleProfile;

        const widerIsH264 =
          !!widerSelectedMetadata &&
          String(widerSelectedMetadata.videoEncType ?? "")
            .toLowerCase()
            .includes("264");
        // Gate only on the *selected* wide stream encoding (main may be H.265 while sub is H.264).
        // The server will still enforce constraints; this just avoids hiding valid combos.
        const canRtsp = widerIsH264;
        if (rtspEnabled && canRtsp) {
          nativeStreams.push({
            name: `RTSP composite ${teleProfile}`,
            id: `composite-rtsp-${lensVariant}-${effectiveWiderProfile}-${teleRtspInputProfile}`,
            container: "rtp",
            profile: teleProfile,
            lens: "composite",
            url: compositeUrl.toString(),
            urlWithAuth: compositeUrlWithAuth.toString(),
            ...(widerSelectedMetadata
              ? { metadata: widerSelectedMetadata }
              : {}),
          });
        }
      }

      // Note: composite output is still "native" (baichuan://), but it can optionally use RTSP as *inputs*.

      logDebug(
        "[ReolinkBaichuanApi] buildVideoStreamOptions: composite branch result",
        {
          host: this.host,
          nativeStreams: nativeStreams.map((s) => s.id),
        },
      );

      return {
        nativeStreams,
        rtmpStreams,
        rtspStreams,
      };
    }

    const guessRtspEncodingPrefix = (m?: StreamMetadata): "h264" | "h265" => {
      const enc =
        typeof m?.videoEncType === "string" ? m.videoEncType.toLowerCase() : "";
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
      const encoding = params.forceNoEncodingPrefix
        ? ""
        : guessRtspEncodingPrefix(params.metadata);
      const prefix = encoding ? `${encoding}` : "";
      const rtspId = `${prefix}Preview_${channelStr}_${params.streamName}`;
      const rtspPath = `/${rtspId}`;

      const rtspUrl = new URL(`rtsp://${this.host}:${rtspPort}${rtspPath}`);
      const rtspUrlWithAuth = new URL(
        `rtsp://${this.host}:${rtspPort}${rtspPath}`,
      );
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

      const rtmpUrlWithAuth = new URL(
        `rtmp://${this.host}:${rtmpPort}${rtmpPath}`,
      );
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
    const rtmpEnabled =
      (rtmpEnabledForMultifocal ? true : !isMultiFocal) &&
      netPort.rtmp?.enable === 1;
    const rtspPort = netPort.rtsp?.port ?? 554;
    const rtmpPort = netPort.rtmp?.port ?? 1935;

    // Get stream metadata to build options
    const streamMetadata = await this.getStreamMetadata(ch);
    const streams = streamMetadata?.streams || [];

    // Standalone TrackMix tele lens calls typically come in as channel=1 + lens=telephoto.
    // In that case, `streams` already corresponds to the tele channel, so build directly from it.
    // (Previous logic only fetched tele metadata when ch===0, which made tele-only calls return empty.)
    const isStandaloneTeleRequest =
      wantTele && isMultiFocal && !onNvr && ch === 1;

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
      const nativeUrl = new URL(
        `baichuan://${this.host}/channel/${params.channel}/profile/${params.profile}`,
      );
      const nativeUrlWithAuth = new URL(
        `baichuan://${this.host}/channel/${params.channel}/profile/${params.profile}`,
      );
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
        ...(params.nativeVariant
          ? { nativeVariant: params.nativeVariant }
          : {}),
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
          pushRtsp({
            channel: params.channel,
            profile,
            streamName,
            metadata,
            lens: params.lens,
          });
        }

        if (params.includeRtmp) {
          const streamName =
            profile === "main" ? "main" : profile === "sub" ? "sub" : "ext";
          pushRtmp({
            channel: params.channel,
            profile,
            streamName,
            metadata,
            lens: params.lens,
          });
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
      const includeRtmpForWide =
        rtmpEnabled && !(isMultiFocal && onNvr && isTrackMix);

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
    if (
      !isStandaloneTeleRequest &&
      wantTele &&
      isMultiFocal &&
      teleStreams.length > 0
    ) {
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
        isTrackMix
          ? "autotrack"
          : lensVariant === "telephoto"
            ? "telephoto"
            : "autotrack";
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
      const teleRtmpName =
        lensVariant === "telephoto" ? "telephoto_sub" : "autotrack_sub";
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

      const variantsToExpose: Array<
        Exclude<NativeVideoStreamVariant, "default">
      > = [lensVariant === "telephoto" ? "telephoto" : "autotrack"];

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

    const result = {
      nativeStreams,
      rtmpStreams,
      rtspStreams,
    };

    return cacheOrFallback(result);
  }

  /**
   * Test all available streams for a specific channel.
   * Tests RTSP, RTMP, and native Baichuan streams with all profiles (main, sub, ext).
   *
   * @param channel - Channel number to test (0-based)
   * @param logger - Optional logger for output
   * @returns Test results for all stream types and profiles
   */
  async testChannelStreams(
    channel?: number,
    logger?: import("../../debug/DebugConfig").Logger,
  ): Promise<Record<string, unknown>> {
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
  async collectMultifocalDiagnostics(
    logger: import("../../debug/DebugConfig").Logger,
  ): Promise<Record<string, unknown>> {
    const { collectMultifocalDiagnostics } =
      await import("../../debug/DiagnosticsTools");
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
    const info = this.getPushCacheEntryForLogicalChannel(channel);
    const uid = typeof info?.uid === "string" ? info.uid.trim() : "";
    return uid ? uid : undefined;
  }

  // ====================================================================
  // VOD (Video On Demand) Passthrough Methods
  // These methods delegate to the internal CGI API for NVR/Hub VOD operations
  // ====================================================================

  /**

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
    },
  ): Promise<string> {
    await this.cgiApi.login();
    return await this.cgiApi.prepareNvrVodDownload(
      channel,
      startTime,
      endTime,
      streamType,
      options,
    );
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
    options?: GetVodUrlParams,
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
    },
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
  async collectNvrDiagnostics(options: {
    logger: Logger;
  }): Promise<Record<string, unknown>> {
    const diagnostics = await collectNvrDiagnostics({
      cgi: this.cgiApi,
      logger: options.logger,
    });
    return diagnostics;
  }

  // --------------------
  // PCAP-derived settings pushes
  // --------------------

  private parseAndStoreSettingsPush(
    cmdId: number,
    xml: string,
    headerChannelId: number,
  ): void {
    const now = Date.now();
    const configuredChannel = this.client.getConfiguredChannel?.() ?? 0;
    const channelFromHeader =
      headerChannelId >= 250
        ? configuredChannel
        : Math.max(0, headerChannelId - 1);

    const normalizePushChannel = (
      candidate: number | undefined,
    ): number | undefined => {
      if (candidate == null) return undefined;
      // Heuristic for NVR/Hub firmwares that emit 1-based <channelId> tags.
      // If the push channel matches the configured channel + 1, normalize to 0-based.
      if (candidate === configuredChannel + 1) return configuredChannel;
      return candidate;
    };

    const getEntry = (channel: number): BaichuanSettingsPushCacheEntry => {
      const existing = this.settingsPushCache.get(channel);
      if (existing) return existing;
      const created: BaichuanSettingsPushCacheEntry = { channel };
      this.settingsPushCache.set(channel, created);
      return created;
    };

    if (cmdId === BC_CMD_ID_PUSH_VIDEO_INPUT) {
      const value = parseVideoInputPushXml(xml);
      const channel =
        normalizePushChannel(value.channelId) ?? channelFromHeader;
      getEntry(channel).videoInput = { updatedAtMs: now, value };
      return;
    }

    if (cmdId === BC_CMD_ID_PUSH_SERIAL) {
      const value = parseSerialPushXml(xml);
      const channel =
        normalizePushChannel(value.channelId) ?? channelFromHeader;
      getEntry(channel).serial = { updatedAtMs: now, value };
      return;
    }

    if (cmdId === BC_CMD_ID_PUSH_NET_INFO) {
      const value = parseNetInfoPushXml(xml);
      getEntry(channelFromHeader).netInfo = {
        updatedAtMs: now,
        value,
      };
      return;
    }

    if (cmdId === BC_CMD_ID_PUSH_DINGDONG_LIST) {
      const value = parseDingdongListPushXml(xml);
      const channel = normalizePushChannel(value.channel) ?? channelFromHeader;
      getEntry(channel).dingdongList = { updatedAtMs: now, value };
      return;
    }

    if (cmdId === BC_CMD_ID_PUSH_SLEEP_STATUS) {
      const value = parseSleepStatusPushXml(xml);
      getEntry(channelFromHeader).sleepStatus = {
        updatedAtMs: now,
        value,
      };
      return;
    }

    if (cmdId === BC_CMD_ID_PUSH_COORDINATE_POINT_LIST) {
      const value = parseCoordinatePointListPushXml(xml);
      getEntry(channelFromHeader).coordinatePointList = {
        updatedAtMs: now,
        value,
      };
      return;
    }
  }

  /** Read-only snapshot of cached settings pushes (cmd_id 78/79/464/484/623/723). */
  getSettingsPushCacheSnapshot(): Map<number, BaichuanSettingsPushCacheEntry> {
    const out = new Map<number, BaichuanSettingsPushCacheEntry>();
    for (const [channel, entry] of this.settingsPushCache.entries()) {
      out.set(channel, {
        channel: entry.channel,
        ...(entry.videoInput
          ? {
              videoInput: {
                ...entry.videoInput,
                value: { ...entry.videoInput.value },
              },
            }
          : {}),
        ...(entry.serial
          ? { serial: { ...entry.serial, value: { ...entry.serial.value } } }
          : {}),
        ...(entry.netInfo
          ? { netInfo: { ...entry.netInfo, value: { ...entry.netInfo.value } } }
          : {}),
        ...(entry.dingdongList
          ? {
              dingdongList: {
                ...entry.dingdongList,
                value: { ...entry.dingdongList.value },
              },
            }
          : {}),
        ...(entry.sleepStatus
          ? {
              sleepStatus: {
                ...entry.sleepStatus,
                value: { ...entry.sleepStatus.value },
              },
            }
          : {}),
        ...(entry.coordinatePointList
          ? {
              coordinatePointList: {
                ...entry.coordinatePointList,
                value: { ...entry.coordinatePointList.value },
              },
            }
          : {}),
      });
    }
    return out;
  }

  getVideoInputFromPushCache(
    channel = 0,
  ): BaichuanCachedPush<BaichuanVideoInputPush> | undefined {
    return this.settingsPushCache.get(channel)?.videoInput;
  }
  getSerialFromPushCache(
    channel = 0,
  ): BaichuanCachedPush<BaichuanSerialPush> | undefined {
    return this.settingsPushCache.get(channel)?.serial;
  }
  getNetInfoFromPushCache(
    channel = 0,
  ): BaichuanCachedPush<BaichuanNetInfoPush> | undefined {
    return this.settingsPushCache.get(channel)?.netInfo;
  }
  getDingdongListFromPushCache(
    channel = -1,
  ): BaichuanCachedPush<BaichuanDingdongListPush> | undefined {
    return this.settingsPushCache.get(channel)?.dingdongList;
  }
  getSleepStatusFromPushCache(
    channel = 0,
  ): BaichuanCachedPush<BaichuanSleepStatusPush> | undefined {
    return this.settingsPushCache.get(channel)?.sleepStatus;
  }

  getCoordinatePointListFromPushCache(
    channel = 0,
  ): BaichuanCachedPush<BaichuanCoordinatePointListPush> | undefined {
    return this.settingsPushCache.get(channel)?.coordinatePointList;
  }

  // --------------------
  // PCAP-derived settings getters (typed wrappers)
  // --------------------

  private isNvrLikeDevice(): boolean {
    const configuredChannel = this.client.getConfiguredChannel?.() ?? 0;
    // If the client is configured with a non-zero channel, we are almost certainly talking to an NVR/Hub.
    if (configuredChannel > 0) return true;
    // NVRs send cmd_id 145 channel info pushes which populate this cache.
    return this.channelPushData.size > 0;
  }

  private async sendPcapDerivedSettingsGetXml(params: {
    cmdId: number;
    channel?: number;
    timeoutMs?: number;
  }): Promise<string> {
    const ch =
      params.channel != null
        ? this.normalizeChannel(params.channel)
        : undefined;

    const onNvr = this.isNvrLikeDevice();

    if (ch == null || !onNvr) {
      return await this.sendXml({
        cmdId: params.cmdId,
        ...(ch != null ? { channel: ch } : {}),
        ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
      });
    }

    const candidates: Array<{
      label: string;
      p: Parameters<ReolinkBaichuanApi["sendXml"]>[0];
    }> = [
      {
        label: "direct",
        p: { cmdId: params.cmdId, channel: ch },
      },
      {
        // Common on NVR/Hub: header channelId must be the host (250), while Extension selects the camera.
        label: "hostHeader ext0",
        p: { cmdId: params.cmdId, channel: ch, channelIdOverride: 250 },
      },
      {
        label: "hostHeader ext1",
        p: {
          cmdId: params.cmdId,
          channel: ch,
          channelIdOverride: 250,
          extensionXml: buildChannelExtensionXml(ch + 1),
        },
      },
      {
        label: "hostHeader noChannel ext0",
        p: {
          cmdId: params.cmdId,
          channelIdOverride: 250,
          extensionXml: buildChannelExtensionXml(ch),
        },
      },
      {
        label: "hostHeader noChannel ext1",
        p: {
          cmdId: params.cmdId,
          channelIdOverride: 250,
          extensionXml: buildChannelExtensionXml(ch + 1),
        },
      },
    ];

    let lastErr: unknown;
    for (const c of candidates) {
      try {
        const xml = await this.sendXml({
          ...c.p,
          ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
        });
        if (xml !== "") return xml;
        // Empty body: try next NVR candidate.
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(
          `PCAP-derived settings GET failed for cmdId=${params.cmdId}: ${String(lastErr)}`,
        );
  }

  async getOsdDatetime(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanGetOsdDatetimeResult> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_OSD_DATETIME,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });

    const osdBlock = getXmlBlocks(rawXml, "OsdDatetime")[0];
    const nameBlock = getXmlBlocks(rawXml, "OsdChannelName")[0];

    const osdDatetime: BaichuanOsdDatetime | undefined = osdBlock
      ? (() => {
          const channelId = parseNumber(getXmlText(osdBlock, "channelId"));
          const enable = parseBoolean01(getXmlText(osdBlock, "enable"));
          const topLeftX = parseNumber(getXmlText(osdBlock, "topLeftX"));
          const topLeftY = parseNumber(getXmlText(osdBlock, "topLeftY"));
          const width = parseNumber(getXmlText(osdBlock, "width"));
          const height = parseNumber(getXmlText(osdBlock, "height"));
          const language = getXmlText(osdBlock, "language")?.trim();

          return {
            ...(channelId != null ? { channelId } : {}),
            ...(enable != null ? { enable } : {}),
            ...(topLeftX != null ? { topLeftX } : {}),
            ...(topLeftY != null ? { topLeftY } : {}),
            ...(width != null ? { width } : {}),
            ...(height != null ? { height } : {}),
            ...(language ? { language } : {}),
          };
        })()
      : undefined;

    const osdChannelName: BaichuanOsdChannelName | undefined = nameBlock
      ? (() => {
          const channelId = parseNumber(getXmlText(nameBlock, "channelId"));
          const name = getXmlText(nameBlock, "name")?.trim();
          const enable = parseBoolean01(getXmlText(nameBlock, "enable"));
          const topLeftX = parseNumber(getXmlText(nameBlock, "topLeftX"));
          const topLeftY = parseNumber(getXmlText(nameBlock, "topLeftY"));
          const enWatermark = parseBoolean01(
            getXmlText(nameBlock, "enWatermark"),
          );
          const enBgcolor = parseBoolean01(getXmlText(nameBlock, "enBgcolor"));

          return {
            ...(channelId != null ? { channelId } : {}),
            ...(name ? { name } : {}),
            ...(enable != null ? { enable } : {}),
            ...(topLeftX != null ? { topLeftX } : {}),
            ...(topLeftY != null ? { topLeftY } : {}),
            ...(enWatermark != null ? { enWatermark } : {}),
            ...(enBgcolor != null ? { enBgcolor } : {}),
          };
        })()
      : undefined;

    return {
      ...(osdDatetime ? { osdDatetime } : {}),
      ...(osdChannelName ? { osdChannelName } : {}),
    };
  }

  async getRecordCfg(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanRecordCfg> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_RECORD_CFG,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });

    const block = getXmlBlocks(rawXml, "RecordCfg")[0];
    const cycleListBlock = block
      ? getXmlBlocks(block, "cyclelist")[0]
      : undefined;
    const cycleList = cycleListBlock
      ? getXmlBlocks(cycleListBlock, "item")
          .map((t) => parseNumber(t.trim()))
          .filter((n): n is number => n != null)
      : undefined;

    const value: BaichuanRecordCfg = block
      ? (() => {
          const channelId = parseNumber(getXmlText(block, "channelId"));
          const cycle = parseNumber(getXmlText(block, "cycle"));
          const recordAbility = parseNumber(getXmlText(block, "recordAbility"));
          const smartRecord = parseNumber(getXmlText(block, "smartRecord"));
          const recordDelayTime = parseNumber(
            getXmlText(block, "recordDelayTime"),
          );
          const preRecordTime = parseNumber(getXmlText(block, "preRecordTime"));
          const packageTime = parseNumber(getXmlText(block, "packageTime"));

          return {
            ...(channelId != null ? { channelId } : {}),
            ...(cycle != null ? { cycle } : {}),
            ...(recordAbility != null ? { recordAbility } : {}),
            ...(smartRecord != null ? { smartRecord } : {}),
            ...(recordDelayTime != null ? { recordDelayTime } : {}),
            ...(preRecordTime != null ? { preRecordTime } : {}),
            ...(packageTime != null ? { packageTime } : {}),
            ...(cycleList && cycleList.length ? { cycleList } : {}),
          };
        })()
      : {};

    return value;
  }

  async getRecordSchedule(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanRecordSchedule> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_RECORD,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });

    const block = getXmlBlocks(rawXml, "Record")[0];
    const listBlock = block
      ? getXmlBlocks(block, "typeScheduleList")[0]
      : undefined;
    const items = listBlock
      ? getXmlBlocks(listBlock, "item")
          .map((b) => {
            const type = (getXmlText(b, "type") ?? "").trim();
            const valueTable = (getXmlText(b, "valueTable") ?? "").trim();
            if (!type || !valueTable) return undefined;
            return { type, valueTable };
          })
          .filter((i): i is { type: string; valueTable: string } => i != null)
      : undefined;

    const value: BaichuanRecordSchedule = block
      ? (() => {
          const channelId = parseNumber(getXmlText(block, "channelId"));
          const enable = parseBoolean01(getXmlText(block, "enable"));
          return {
            ...(channelId != null ? { channelId } : {}),
            ...(enable != null ? { enable } : {}),
            ...(items && items.length ? { typeScheduleList: items } : {}),
          };
        })()
      : {};

    return value;
  }

  async getWifiSignal(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanWifiSignal> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_WIFI_SIGNAL,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    const signal = parseNumber(getXmlText(rawXml, "signal"));
    return {
      ...(signal != null ? { signal } : {}),
    };
  }

  async getWifi(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanWifi> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_WIFI,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    const protocol = parseNumber(getXmlText(rawXml, "protocol"));
    const mode = getXmlText(rawXml, "mode")?.trim();
    const ssid = getXmlText(rawXml, "ssid")?.trim();
    const key = getXmlText(rawXml, "key")?.trim();
    const wifiChannel = parseNumber(getXmlText(rawXml, "channel"));
    const isNVRSsid = parseNumber(getXmlText(rawXml, "isNVRSsid"));

    return {
      ...(protocol != null ? { protocol } : {}),
      ...(mode ? { mode } : {}),
      ...(ssid ? { ssid } : {}),
      ...(key ? { key } : {}),
      ...(wifiChannel != null ? { channel: wifiChannel } : {}),
      ...(isNVRSsid != null ? { isNVRSsid } : {}),
    };
  }

  async getStreamInfoList(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanStreamInfoList> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_STREAM_INFO_LIST,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });

    const listBlock = getXmlBlocks(rawXml, "StreamInfoList")[0] ?? rawXml;
    const streamBlocks = getXmlBlocks(listBlock, "StreamInfo");

    const parseCsvNums = (s: string | undefined): number[] | undefined => {
      const raw = (s ?? "").trim();
      if (!raw) return undefined;
      const nums = raw
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n));
      return nums.length ? nums : undefined;
    };

    const streams = streamBlocks.map((sb) => {
      const channelBits = parseNumber(getXmlText(sb, "channelBits"));
      const encBlocks = getXmlBlocks(sb, "encodeTable");
      const encodeTables = encBlocks.map((eb) => {
        const res = getXmlBlocks(eb, "resolution")[0];
        const width = res ? parseNumber(getXmlText(res, "width")) : undefined;
        const height = res ? parseNumber(getXmlText(res, "height")) : undefined;

        const encTypeListBlock = getXmlBlocks(eb, "videoEncTypeList")[0];
        const videoEncTypeList = encTypeListBlock
          ? getXmlBlocks(encTypeListBlock, "videoEncType")
              .map((t) => parseNumber(t.trim()))
              .filter((n): n is number => n != null)
          : undefined;

        const fr = parseCsvNums(getXmlText(eb, "framerateTable"));
        const br = parseCsvNums(getXmlText(eb, "bitrateTable"));

        const type = getXmlText(eb, "type")?.trim();
        const videoEncType = parseNumber(getXmlText(eb, "videoEncType"));
        const defaultFramerate = parseNumber(
          getXmlText(eb, "defaultFramerate"),
        );
        const defaultBitrate = parseNumber(getXmlText(eb, "defaultBitrate"));
        const defaultGop = parseNumber(getXmlText(eb, "defaultGop"));

        return {
          ...(type ? { type } : {}),
          ...(width != null ? { width } : {}),
          ...(height != null ? { height } : {}),
          ...(videoEncType != null ? { videoEncType } : {}),
          ...(videoEncTypeList && videoEncTypeList.length
            ? { videoEncTypeList }
            : {}),
          ...(defaultFramerate != null ? { defaultFramerate } : {}),
          ...(defaultBitrate != null ? { defaultBitrate } : {}),
          ...(fr ? { framerateTable: fr } : {}),
          ...(br ? { bitrateTable: br } : {}),
          ...(defaultGop != null ? { defaultGop } : {}),
        };
      });

      return {
        ...(channelBits != null ? { channelBits } : {}),
        encodeTables,
      };
    });

    return { streams };
  }

  async getLedState(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanLedState> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_LED_STATE,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    const block = getXmlBlocks(rawXml, "LedState")[0];
    const value: BaichuanLedState = block
      ? (() => {
          const channelId = parseNumber(getXmlText(block, "channelId"));
          const ledVersion = parseNumber(getXmlText(block, "ledVersion"));
          const state = getXmlText(block, "state")?.trim();
          const lightState = getXmlText(block, "lightState")?.trim();
          return {
            ...(channelId != null ? { channelId } : {}),
            ...(ledVersion != null ? { ledVersion } : {}),
            ...(state ? { state } : {}),
            ...(lightState ? { lightState } : {}),
          };
        })()
      : {};
    return value;
  }

  async getSleepState(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<BaichuanSleepState> {
    const rawXml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_SLEEP_STATE,
      channel,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    const block = getXmlBlocks(rawXml, "sleepState")[0];
    const value: BaichuanSleepState = block
      ? (() => {
          const sleep = parseNumber(getXmlText(block, "sleep"));
          const mode = parseNumber(getXmlText(block, "mode"));
          const panPos = parseNumber(getXmlText(block, "panPos"));
          const tiltPos = parseNumber(getXmlText(block, "tiltPos"));
          const imageName = getXmlText(block, "imageName")?.trim();
          return {
            ...(sleep != null ? { sleep } : {}),
            ...(mode != null ? { mode } : {}),
            ...(panPos != null ? { panPos } : {}),
            ...(tiltPos != null ? { tiltPos } : {}),
            ...(imageName ? { imageName } : {}),
          };
        })()
      : {};
    return value;
  }

  // Remaining PCAP-derived cmdIds: expose as JSON (XML parsed client-side).
  async getAbilitySupport(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_ABILITY_SUPPORT,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getFtpTask(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_FTP_TASK,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getHddInfoList(options?: {
    timeoutMs?: number;
  }): Promise<XmlJsonValue> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_HDD_INFO_LIST,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getDayRecords(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_DAY_RECORDS,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getEmailTask(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_EMAIL_TASK,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getAudioTask(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AUDIO_TASK,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getAudioCfg(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AUDIO_CFG,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getDayNightThreshold(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_DAY_NIGHT_THRESHOLD,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getTimelapseCfg(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_TIMELAPSE_CFG,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getAiDenoise(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AI_DENOISE,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getKitApCfg(options?: { timeoutMs?: number }): Promise<XmlJsonValue> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_KIT_AP_CFG,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getRecEncCfg(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_REC_ENC_CFG,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getAccessUserList(options?: {
    timeoutMs?: number;
  }): Promise<XmlJsonValue> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_ACCESS_USER_LIST,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  /**
   * Get list of active/online user sessions (cmdId=120).
   * Returns information about currently connected users/sessions on the device.
   */
  async getOnlineUserList(options?: {
    timeoutMs?: number;
  }): Promise<XmlJsonValue> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_ONLINE_USER_LIST,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  // Placeholder cmdIds seen in PCAPs but without XML samples yet.
  // Expose as JSON (parsed from XML) for easy inspection.
  async getCmd123(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_CMD_123,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getCmd209(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_CMD_209,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getCmd231(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_CMD_231,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getCmd265(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_CMD_265,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  async getCmd440(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_CMD_440,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  /**
   * Convenience helper: convert CoverPreview (cmdId=298) snapshot to a JPEG.
   *
   * Implementation detail: uses `ffmpeg` from PATH (same dependency already used by endpoints-server VOD streaming).
   */
  async getVideoclipThumbnailJpegRaw(params: {
    channel?: number;
    time: Date;
    snapType?: "main" | "sub";
    timeoutMs?: number;
    /** 2..31 (lower = better quality). Default: 2 */
    jpegQuality?: number;
  }): Promise<{
    jpeg: Buffer;
    snapshot: VideoclipThumbnailResult;
  }> {
    const snapshot = await this.getVideoclipThumbnail(params);
    const enc = String(snapshot.encoding || "").toUpperCase();
    const demux = enc.includes("265") || enc.includes("HEVC") ? "hevc" : "h264";
    const q = params.jpegQuality ?? 2;

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts",
      "-f",
      demux,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-q:v",
      String(q),
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    ff.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    ff.stderr.on("data", (d) => (stderr += String(d)));

    ff.stdin.write(snapshot.frame);
    ff.stdin.end();

    const exitCode: number = await new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => resolve(code ?? 0));
    });

    if (exitCode !== 0) {
      throw new Error(
        `ffmpeg failed converting CoverPreview I-frame to JPEG (exit=${exitCode}): ${stderr}`,
      );
    }

    const jpeg = Buffer.concat(chunks);
    if (jpeg.length < 16) {
      throw new Error(
        `ffmpeg produced an empty JPEG buffer (${jpeg.length} bytes)`,
      );
    }

    return { jpeg, snapshot };
  }

  /**
   * Stream a recording replay (cmdId=5) as a fragmented MP4 (streamable over HTTP).
   *
   * The duration is automatically extracted from the filename timestamps.
   * Falls back to 300 seconds if parsing fails.
   *
   * Notes:
   * - This is video-only (audio is currently not muxed).
   * - Uses `ffmpeg` from PATH.
   * - Operations are serialized via the replay queue.
   */
  async createRecordingReplayMp4Stream(params: {
    /** Channel number (0-based). Required. */
    channel: number;
    /** Full path to the recording file. Required. Duration is extracted from filename. */
    fileName: string;
    /**
     * Force NVR mode (uses id-based XML with UID) or standalone mode (name-based XML).
     * If not specified, the library will detect based on device channel count.
     */
    isNvr?: boolean;
  }): Promise<{
    mp4: Readable;
    stop: () => Promise<void>;
  }> {
    // Extract duration and framerate from filename timestamps
    const parsed = parseRecordingFileName(params.fileName);
    const durationMs = parsed?.durationMs ?? 300_000; // Fallback: 5 minutes
    // Use framerate from filename hex flags, fallback to 15 fps (common for recordings)
    const fps =
      parsed?.framerate && parsed.framerate > 0 ? parsed.framerate : 15;
    // Add 10% buffer to ensure we get the complete clip
    const seconds = Math.ceil((durationMs / 1000) * 1.1);

    const startParams: Parameters<
      ReolinkBaichuanApi["startRecordingReplayStream"]
    >[0] = {
      channel: params.channel,
      fileName: params.fileName,
      logger: this.logger,
      ...(params.isNvr != null ? { isNvr: params.isNvr } : {}),
    };

    // Use streaming queue - holds the slot until release() is called
    const { result: replayResult, release: releaseQueueSlot } =
      await this.enqueueStreamingReplayOperation(() =>
        this.startRecordingReplayStream(startParams),
      );

    const { stream, stop: stopReplay } = replayResult;

    const input = new PassThrough();
    const output = new PassThrough();

    const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);

    let ff: ReturnType<typeof spawn> | null = null;
    let ended = false;

    const startFfmpeg = (videoType: "H264" | "H265") => {
      if (ff) return;
      const demux = videoType === "H265" ? "hevc" : "h264";
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts",
        "-r",
        String(fps),
        "-f",
        demux,
        "-i",
        "pipe:0",
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
      ];

      ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
      if (!ff.stdin || !ff.stdout || !ff.stderr) {
        throw new Error("ffmpeg stdio streams not available");
      }
      input.pipe(ff.stdin);
      ff.stdout.pipe(output);

      let stderr = "";
      ff.stderr.on("data", (d) => (stderr += String(d)));
      ff.on("close", (code) => {
        if (ended) return;
        ended = true;
        // Best-effort: surface ffmpeg errors to consumers.
        if ((code ?? 0) !== 0 && stderr.trim()) {
          output.destroy(
            new Error(`ffmpeg exited with code ${code ?? 0}: ${stderr}`),
          );
        } else {
          output.end();
        }
      });
    };

    const stopAll = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      try {
        await stopReplay();
      } catch {
        // ignore
      }
      try {
        await stream.stop();
      } catch {
        // ignore
      }
      try {
        input.end();
      } catch {
        // ignore
      }
      try {
        ff?.kill("SIGKILL");
      } catch {
        // ignore
      }
      try {
        output.end();
      } catch {
        // ignore
      }
      // Release queue slot when stream ends
      releaseQueueSlot();
    };

    const timer = setTimeout(
      () => {
        void stopAll();
      },
      Math.max(1, seconds) * 1000,
    );

    output.on("close", () => {
      clearTimeout(timer);
      void stopAll();
    });

    stream.on("error", (e) => {
      output.destroy(e);
      void stopAll();
    });

    stream.on("videoAccessUnit", ({ data, videoType }) => {
      if (ended) return;
      startFfmpeg(videoType);
      if (videoType === "H264") input.write(H264_AUD);
      input.write(data);
    });

    return {
      mp4: output,
      stop: stopAll,
    };
  }

  /**
   * Download a recording (cmdId=13) and convert it to a fragmented MP4 stream.
   *
   * This is an alternative to `createRecordingReplayMp4Stream()` for cameras that
   * don't support streaming replay (cmdId=5). It downloads the entire recording first,
   * demuxes it to Annex-B format, then pipes through ffmpeg to create a streamable MP4.
   *
   * Advantages over replay streaming:
   * - Works on all cameras that support download (cmdId=13)
   * - More reliable for standalone cameras like E1 Outdoor PoE
   *
   * Disadvantages:
   * - Downloads the entire file before streaming starts (not truly real-time)
   * - Higher memory usage for large recordings
   *
   * Notes:
   * - This is video-only (audio is currently not muxed).
   * - Uses `ffmpeg` from PATH.
   *
   * @example
   * ```ts
   * const { mp4, stop } = await api.createRecordingDownloadMp4Stream({
   *   channel: 0,
   *   fileName: "/mnt/sda/Mp4Record/2026-01-25/RecS03_20260125_120000_120100_ABC.mp4",
   * });
   * mp4.pipe(response); // Pipe to HTTP response
   * ```
   */
  async createRecordingDownloadMp4Stream(params: {
    /** Channel number (0-based). Required. */
    channel: number;
    /** Full path to the recording file. Required. */
    fileName: string;
    /** Download timeout in ms. Default: 120000 (2 minutes). */
    timeoutMs?: number;
  }): Promise<{
    mp4: Readable;
    stop: () => Promise<void>;
  }> {
    const timeoutMs = params.timeoutMs ?? 120_000;

    // Extract framerate from filename hex flags, fallback to 15 fps (common for recordings)
    const parsed = parseRecordingFileName(params.fileName);
    const fps =
      parsed?.framerate && parsed.framerate > 0 ? parsed.framerate : 15;

    // Get UID for the channel (required for download)
    const channel = this.normalizeChannel(params.channel);
    const uid = await this.ensureUidForRecordings(channel);

    // Download and demux the recording
    const { annexB, videoType } = await this.downloadRecordingDemuxed({
      channel,
      uid,
      fileName: params.fileName,
      timeoutMs,
    });

    if (annexB.length === 0) {
      throw new Error("Downloaded recording is empty");
    }

    const input = new PassThrough();
    const output = new PassThrough();

    let ff: ReturnType<typeof spawn> | null = null;
    let ended = false;

    const stopAll = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      try {
        input.end();
      } catch {
        // ignore
      }
      try {
        ff?.kill("SIGKILL");
      } catch {
        // ignore
      }
      try {
        output.end();
      } catch {
        // ignore
      }
    };

    // Determine demuxer based on video type
    const demux = videoType === "H265" ? "hevc" : "h264";
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts",
      "-r",
      String(fps),
      "-f",
      demux,
      "-i",
      "pipe:0",
      "-c",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov",
      "-f",
      "mp4",
      "pipe:1",
    ];

    ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    if (!ff.stdin || !ff.stdout || !ff.stderr) {
      throw new Error("ffmpeg stdio streams not available");
    }

    input.pipe(ff.stdin);
    ff.stdout.pipe(output);

    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += String(d)));
    ff.on("close", (code) => {
      if (ended) return;
      ended = true;
      if ((code ?? 0) !== 0 && stderr.trim()) {
        output.destroy(
          new Error(`ffmpeg exited with code ${code ?? 0}: ${stderr}`),
        );
      } else {
        output.end();
      }
    });

    // Add AUD NAL units for H.264 to help ffmpeg with frame boundaries
    const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);

    // Write the entire Annex-B data to ffmpeg
    // For better streaming, we could split by NAL units, but for simplicity we write all at once
    if (videoType === "H264") {
      input.write(H264_AUD);
    }
    input.write(annexB);
    input.end();

    return {
      mp4: output,
      stop: stopAll,
    };
  }

  // ============================================================
  // STANDALONE CAMERA METHODS
  // ============================================================
  // These methods are specifically designed for standalone cameras
  // (non-NVR) connected via TCP. They provide a simplified interface
  // for common operations like listing recordings, streaming playback,
  // downloading clips, and getting thumbnails.
  // ============================================================

  /**
   * List recordings from a standalone camera.
   *
   * This method is optimized for standalone cameras (non-NVR) and uses
   * the native Baichuan protocol to list recorded files.
   *
   * @example
   * ```ts
   * const api = new ReolinkBaichuanApi({ host: '192.168.1.100', ... });
   * await api.login();
   *
   * const recordings = await api.standaloneListRecordings({
   *   start: new Date('2024-01-20T00:00:00'),
   *   end: new Date('2024-01-21T23:59:59'),
   * });
   *
   * for (const file of recordings) {
   *   console.log(file.fileName, file.startTime, file.endTime);
   * }
   * ```
   */
  async standaloneListRecordings(params: {
    /** Start time for the search range */
    start: Date;
    /** End time for the search range */
    end: Date;
    /** Stream type to search for (default: mainStream) */
    streamType?: "mainStream" | "subStream";
    /** Maximum number of files to return (default: 100) */
    count?: number;
    /** Timeout in ms (default: 15000) */
    timeoutMs?: number;
  }): Promise<RecordingFile[]> {
    const channel = 0; // Standalone cameras always use channel 0
    const streamType =
      params.streamType === "mainStream" ? "mainStream" : "subStream";
    const timeoutMs = params.timeoutMs ?? 15_000;

    return await this.getVideoclips({
      channel,
      start: params.start,
      end: params.end,
      streamType,
      timeoutMs,
    });
  }

  /**
   * Start a streaming replay of a recorded file from a standalone camera.
   *
   * Returns a video stream that emits frames in real-time. The stream can be
   * used for live playback or forwarded to media players.
   *
   * @example
   * ```ts
   * const api = new ReolinkBaichuanApi({ host: '192.168.1.100', ... });
   * await api.login();
   *
   * const recordings = await api.standaloneListRecordings({ ... });
   * const { stream, stop } = await api.standaloneStartReplayStream({
   *   fileName: recordings[0].fileName,
   * });
   *
   * stream.on('videoFrame', (data) => {
   *   console.log('Video frame:', data.length, 'bytes');
   * });
   *
   * stream.on('audioFrame', (data) => {
   *   console.log('Audio frame:', data.length, 'bytes');
   * });
   *
   * // Stop after 10 seconds
   * setTimeout(() => stop(), 10000);
   * ```
   */
  async standaloneStartReplayStream(params: {
    /** Full path to the recording file (from listRecordings) */
    fileName: string;
    /** Stream type (default: mainStream) */
    streamType?: "mainStream" | "subStream";
    /** Timeout in ms for starting the stream (default: 20000) */
    timeoutMs?: number;
  }): Promise<{
    /** Message number for this stream */
    msgNum: number;
    /** The video stream that emits frames */
    stream: BaichuanVideoStream;
    /** Stop the replay stream */
    stop: () => Promise<void>;
  }> {
    const channel = 0; // Standalone cameras always use channel 0
    const streamType = params.streamType ?? "mainStream";
    const timeoutMs = params.timeoutMs ?? 20_000;

    await this.client.login();

    // IMPORTANT: Always use standalone method for standalone cameras,
    // regardless of whether fileName contains "/" (full path).
    // The NVR vs Standalone distinction in startRecordingReplayStream
    // is based on path format, but standalone cameras can have full paths too.
    return await this.startRecordingReplayStreamStandalone({
      channel,
      fileName: params.fileName,
      streamType,
      timeoutMs,
    });
  }

  /**
   * Download a recorded file from a standalone camera as MP4.
   *
   * Returns a readable stream of MP4 data that can be piped to a file
   * or sent over HTTP.
   *
   * @example
   * ```ts
   * import { createWriteStream } from 'fs';
   *
   * const api = new ReolinkBaichuanApi({ host: '192.168.1.100', ... });
   * await api.login();
   *
   * const recordings = await api.standaloneListRecordings({ ... });
   * const { mp4, stop } = await api.standaloneDownloadRecording({
   *   fileName: recordings[0].fileName,
   * });
   *
   * // Save to file
   * const file = createWriteStream('recording.mp4');
   * mp4.pipe(file);
   *
   * mp4.on('end', () => {
   *   console.log('Download complete');
   * });
   * ```
   */
  async standaloneDownloadRecording(params: {
    /** Full path to the recording file (from listRecordings) */
    fileName: string;
    /** Timeout in ms (default: 120000) */
    timeoutMs?: number;
  }): Promise<{
    /** Readable stream of MP4 data */
    mp4: Readable;
    /** Stop the download */
    stop: () => Promise<void>;
  }> {
    const channel = 0; // Standalone cameras always use channel 0
    const timeoutMs = params.timeoutMs ?? 120_000;

    return await this.createRecordingDownloadMp4Stream({
      channel,
      fileName: params.fileName,
      timeoutMs,
    });
  }

  /**
   * Get a thumbnail (I-frame) from a recorded file on a standalone camera.
   *
   * Returns a raw H.264/H.265 I-frame that can be converted to JPEG using ffmpeg.
   *
   * @example
   * ```ts
   * const api = new ReolinkBaichuanApi({ host: '192.168.1.100', ... });
   * await api.login();
   *
   * const recordings = await api.standaloneListRecordings({ ... });
   * const thumbnail = await api.standaloneGetThumbnail({
   *   time: recordings[0].startTime,
   * });
   *
   * console.log('Encoding:', thumbnail.encoding); // 'H264' or 'H265'
   * console.log('Resolution:', thumbnail.streamInfo.width, 'x', thumbnail.streamInfo.height);
   * console.log('Frame size:', thumbnail.frame.length, 'bytes');
   *
   * // Save raw frame (can be converted to JPEG with ffmpeg)
   * fs.writeFileSync('thumbnail.h264', thumbnail.frame);
   * ```
   */
  async standaloneGetThumbnail(params: {
    /** Timestamp to capture (use startTime from a recording file) */
    time: Date;
    /** Snapshot quality: 'main' for full res, 'sub' for smaller (default: sub) */
    snapType?: "main" | "sub";
    /** Timeout in ms (default: 30000) */
    timeoutMs?: number;
  }): Promise<VideoclipThumbnailResult> {
    const channel = 0; // Standalone cameras always use channel 0
    const snapType = params.snapType ?? "sub";
    const timeoutMs = params.timeoutMs ?? 30_000;

    return await this.getVideoclipThumbnail({
      channel,
      time: params.time,
      snapType,
      timeoutMs,
    });
  }

  /**
   * Subscribe to real-time events from a standalone camera.
   *
   * Events include motion detection, AI detection (person, vehicle, pet, etc.),
   * and other sensor triggers.
   *
   * @example
   * ```ts
   * const api = new ReolinkBaichuanApi({ host: '192.168.1.100', ... });
   * await api.login();
   *
   * const { unsubscribe } = await api.standaloneSubscribeEvents({
   *   onEvent: (event) => {
   *     console.log('Event:', event.type, event.channel);
   *     if (event.type === 'ai') {
   *       console.log('AI detection:', event.ai);
   *     }
   *   },
   * });
   *
   * // Later, stop receiving events
   * await unsubscribe();
   * ```
   */
  async standaloneSubscribeEvents(params: {
    /** Callback for each event received */
    onEvent: (event: ReolinkEvent) => void;
  }): Promise<{
    /** Unsubscribe from events */
    unsubscribe: () => Promise<void>;
  }> {
    // Register the event handler
    this.client.on("event", params.onEvent);

    // Subscribe to events
    await this.subscribeEvents();

    return {
      unsubscribe: async () => {
        await this.unsubscribeEvents();
        this.client.off("event", params.onEvent);
      },
    };
  }

  /**
   * Start a live video stream from a standalone camera.
   *
   * Returns a video stream that emits frames in real-time from the camera's
   * current view (not a recording).
   *
   * @example
   * ```ts
   * const api = new ReolinkBaichuanApi({ host: '192.168.1.100', ... });
   * await api.login();
   *
   * const { stream, stop } = await api.standaloneStartLiveStream({
   *   profile: 'main', // or 'sub' for lower quality
   * });
   *
   * stream.on('videoFrame', (data) => {
   *   console.log('Live frame:', data.length, 'bytes');
   * });
   *
   * // Stop after 30 seconds
   * setTimeout(() => stop(), 30000);
   * ```
   */
  async standaloneStartLiveStream(params?: {
    /** Stream profile: 'main' for high quality, 'sub' for low quality (default: main) */
    profile?: "main" | "sub";
    /** Timeout in ms for starting the stream (default: 20000) */
    timeoutMs?: number;
  }): Promise<{
    /** Stop the live stream */
    stop: () => Promise<void>;
  }> {
    const channel = 0; // Standalone cameras always use channel 0
    const profile = params?.profile ?? "main";

    // Start the video stream (this subscribes to frames)
    await this.startVideoStream(channel, profile);

    return {
      stop: async () => {
        await this.stopVideoStream(channel, profile);
      },
    };
  }

  /**
   * Get a live snapshot (JPEG) from a standalone camera.
   *
   * @example
   * ```ts
   * import { writeFileSync } from 'fs';
   *
   * const api = new ReolinkBaichuanApi({ host: '192.168.1.100', ... });
   * await api.login();
   *
   * const jpeg = await api.standaloneGetSnapshot();
   * writeFileSync('snapshot.jpg', jpeg);
   * ```
   */
  async standaloneGetSnapshot(): Promise<Buffer> {
    const channel = 0; // Standalone cameras always use channel 0
    return await this.getSnapshot(channel);
  }
}
