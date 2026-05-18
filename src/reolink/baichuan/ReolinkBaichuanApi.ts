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
import { MpegTsMuxer } from "../../baichuan/stream/MpegTsMuxer";
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
  BC_CMD_ID_ABILITY_INFO,
  BC_CMD_ID_AUDIO_ALARM_PLAY,
  BC_CMD_ID_CHANNEL_INFO_ALL,
  BC_CMD_ID_CMD_123,
  BC_CMD_ID_CMD_209,
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
  BC_CMD_ID_GET_AI_ALARM,
  BC_CMD_ID_GET_AI_CFG,
  BC_CMD_ID_SET_AI_CFG,
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
  BC_CMD_ID_GET_ONLINE_USER_LIST,
  BC_CMD_ID_GET_OSD_DATETIME,
  BC_CMD_ID_SET_OSD_DATETIME,
  BC_CMD_ID_GET_PIR_INFO,
  BC_CMD_ID_GET_PTZ_POSITION,
  BC_CMD_ID_GET_PTZ_PRESET,
  BC_CMD_ID_GET_REC_ENC_CFG,
  BC_CMD_ID_GET_RECORD,
  BC_CMD_ID_GET_VERSION_INFO,
  BC_CMD_ID_GET_RECORD_CFG,
  BC_CMD_ID_GET_SIREN_STATUS,
  BC_CMD_ID_GET_SLEEP_STATE,
  BC_CMD_ID_GET_STREAM_INFO_LIST,
  BC_CMD_ID_GET_SUPPORT,
  BC_CMD_ID_GET_SYSTEM_GENERAL,
  BC_CMD_ID_GET_TIMELAPSE_CFG,
  BC_CMD_ID_GET_VIDEO_INPUT,
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
  BC_CMD_ID_SET_AI_DENOISE,
  BC_CMD_ID_SET_AUDIO_CFG,
  BC_CMD_ID_SET_AUDIO_TASK,
  BC_CMD_ID_SET_AUTO_FOCUS,
  BC_CMD_ID_GET_AUTO_FOCUS,
  BC_CMD_ID_SET_DAY_NIGHT_THRESHOLD,
  BC_CMD_ID_SET_LED_STATE,
  BC_CMD_ID_SET_MOTION_ALARM,
  BC_CMD_ID_SET_PIR_INFO,
  BC_CMD_ID_SET_PRIVACY_MASK,
  BC_CMD_ID_GET_PRIVACY_MASK,
  BC_CMD_ID_SET_VIDEO_INPUT,
  BC_CMD_ID_GET_ENC,
  BC_CMD_ID_SET_ENC,
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
  BC_CMD_ID_DING_DONG_CTRL,
  BC_CMD_ID_GET_DING_DONG_LIST,
  BC_CMD_ID_DING_DONG_OPT,
  BC_CMD_ID_GET_DING_DONG_CFG,
  BC_CMD_ID_SET_DING_DONG_CFG,
  BC_CMD_ID_QUICK_REPLY_PLAY,
  BC_CMD_ID_GET_DING_DONG_SILENT,
  BC_CMD_ID_SET_DING_DONG_SILENT,
  BC_CMD_ID_GET_EMAIL,
  BC_CMD_ID_SET_EMAIL,
  BC_CMD_ID_TEST_EMAIL,
  BC_CMD_ID_SET_EMAIL_TASK,
  BC_CMD_ID_GET_NTP,
  BC_CMD_ID_SET_NTP,
  BC_CMD_ID_SET_SYSTEM_GENERAL,
  BC_CMD_ID_GET_DST,
  BC_CMD_ID_SET_DST,
  BC_CMD_ID_GET_AUTO_REBOOT,
  BC_CMD_ID_SET_AUTO_REBOOT,
} from "../../protocol/constants";
import {
  applyStreamPatch,
  applyXmlTagPatch,
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
  ensureXmlHeader,
  getXmlText,
  normalizeDayNightMode,
  normalizeOpenClose,
  patchNestedTag,
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
  DeviceCapabilitiesCacheEntry,
  DeviceCapabilitiesDebugInfo,
  DeviceCapabilitiesResult,
  DeviceSupportFlags,
  DownloadRecordingParams,
  DualLensChannelAnalysis,
  DualLensChannelInfo,
  Events,
  GetRecordingVideoResult,
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
  ReolinkDetectionEvent,
  ReolinkSimpleEvent,
  ReolinkSupportedStream,
  ReolinkVideoStreamOptionsResult,
  RtspCreateOptions,
  RunAllDiagnosticsConsecutivelyResult,
  RunMultifocalDiagnosticsConsecutivelyResult,
  SirenState,
  SleepStatus,
  StreamMetadata,
  StreamProfile,
  SupportInfo,
  TwoWayAudioConfig,
  VideoclipThumbnailResult,
  WakeUpOptions,
  WhiteLedState,
  ZoomFocusStatus,
  ZoomFocusTriplet,
  AudioTaskConfig,
  FloodlightTaskConfig,
  WhiteLedConfig,
  PirConfig,
  AiConfig,
  AudioCfgConfig,
  DayNightThresholdConfig,
  AiDenoiseConfig,
  EncOptions,
  EncStreamOptions,
  EncStreamPatch,
  CompressionStream,
  RecEncConfig,
  MotionAlarmConfig,
  AiAlarmConfig,
  VideoInputConfig,
  EncConfig,
  IspConfig,
  IrLightsConfig,
  MaskConfig,
  AudioNoiseConfig,
  AutoFocusConfig,
  SystemGeneralConfig,
  SupportConfig,
  SirenStatusConfig,
  FtpTaskConfig,
  EmailTaskConfig,
  HddInfoListConfig,
  TimelapseCfgConfig,
  AccessUserListConfig,
  OnlineUserListConfig,
  ChimeDevice,
  ChimeParams,
  ChimeCfg,
  HardwiredChimeState,
  WirelessChimeSilentState,
  EmailConfig,
  EmailConfigPatch,
  NtpConfig,
  NtpConfigPatch,
  DstConfig,
  DstConfigPatch,
  SystemGeneralPatch,
  AutoRebootConfig,
  AutoRebootConfigPatch,
} from "./types";
import { parseXmlFragmentToJson, type XmlJsonValue } from "./utils/xml";
import {
  buildEmailScheduleValueTable,
  buildSetEmailTaskXml,
  buildSetEmailXml,
  parseEmailConfigFromXml,
  parseEmailTaskFromXml,
} from "./utils/email";
import { buildSetNtpXml, parseNtpConfigFromXml } from "./utils/ntp";
import { buildSetDstXml, parseDstConfigFromXml } from "./utils/dst";
import {
  buildSetAutoRebootXml,
  parseAutoRebootFromXml,
} from "./utils/autoReboot";
import {
  buildSetSystemGeneralXml,
  parseSystemGeneralFromXml,
} from "./utils/systemGeneral";

import { Jimp, JimpMime } from "jimp";
import type { CompositeStreamPipOptions } from "../../multifocal/compositeStream";
import {
  ReolinkCgiApi,
  VodFile,
  type CgiGetVideoclipsParams,
  type GetVodUrlParams,
} from "../cgi/ReolinkCgiApi";
import { ReolinkHttpClient } from "../http/ReolinkHttpClient";
import type { ReolinkDeviceInfo, ReolinkDeviceInfoTag } from "../types";
import { computeDeviceCapabilities, getSupportItemForChannel, parseSupportXml, xmlIndicatesFloodlight } from "./capabilities";
import { parseAbilityInfoXml } from "./utils/abilityInfo";
import { parseVersionInfo, type BaichuanVersionInfo } from "./utils/versionInfo";
import { getAiStateViaGetAiAlarm } from "./utils/aiState";
import { decideSleepInferenceTransition } from "./utils/sleepInference";
import { parseChannelInfoPushBlocks } from "./utils/channelInfoPush";
import {
  buildChannelPushDataLogSnapshot,
  computeChannelPushUpdateFromEntry,
} from "./utils/channelInfoStore";
import { decodeDetectionHeader } from "./utils/detection";
import { buildEncOptions } from "./utils/encOptions";
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
import {
  buildDingDongGetParamsXml,
  buildDingDongSetParamsXml,
  buildDingDongRingXml,
  buildSetDingDongCfgXml,
  buildGetDingDongCtrlXml,
  buildSetDingDongCtrlXml,
  buildQuickReplyPlayXml,
  buildGetDingDongSilentXml,
  buildSetDingDongSilentXml,
  parseDingDongListFromXml,
  parseDingDongParamsFromXml,
  parseDingDongCfgFromXml,
  parseHardwiredChimeFromXml,
  parseWirelessChimeSilentFromXml,
} from "./utils/chime";
import { parseEventsFromGetEventsXml } from "./utils/eventsGetEvents";
import { parsePirInfoFromXml } from "./utils/pir";
import { discoverDeviceUidForRecordings as discoverDeviceUidForRecordingsUtil } from "./utils/uidRecordings";
import type { FloodlightTaskState } from "./utils/whiteLed";
import {
  applyFloodlightOnMotionToXml,
  applyFloodlightSettingsToXml,
  applyWhiteLedBrightnessToXml,
  applyWhiteLedOnOffToXml,
  buildWhiteLedManualPayloadXml,
  parseFloodlightTaskFromXml,
  parseWhiteLedStateFromXml,
} from "./utils/whiteLed";

type TalkAbility = import("./types").TalkAbility;
type TalkSession = import("./types").TalkSession;
type SupportItem = import("./types").SupportItem;

export type {
  NativeVideoStreamVariant,
  ReolinkBaichuanPorts,
  ReolinkNvrChannelInfo,
  ReolinkSupportedStream,
  WakeUpOptions,
} from "./types";

// Constants to identify dual lens models
export const DUAL_LENS_DUAL_MOTION_MODELS = new Set<string>([
  "Reolink Duo PoE",
  "Reolink Duo WiFi",
  // Duo 2 family
  "Reolink Duo 2 PoE",
  "Reolink Duo 2 WiFi",
  // Duo 3 family — physically dual-sensor, marketed as a stitched 16MP feed
  // (the firmware exposes a single logical channel, so callers should still
  // check `getDualLensChannelInfo` for the actual channel topology).
  "Reolink Duo 3 PoE",
  "Reolink Duo 3 WiFi",
]);

export const DUAL_LENS_SINGLE_MOTION_MODELS = new Set<string>([
  "Reolink TrackMix",
  "Reolink TrackMix PoE",
  "Reolink TrackMix WiFi",
  "RLC-81MA",
  "TrackFlex Floodlight WiFi",
]);

export const DUAL_LENS_MODELS = new Set<string>([
  ...DUAL_LENS_DUAL_MOTION_MODELS,
  ...DUAL_LENS_SINGLE_MOTION_MODELS,
]);

export const isDualLenseModel = (model: string): boolean => {
  const lower = model.toLowerCase();
  if (Array.from(DUAL_LENS_MODELS).some((m) => m.toLowerCase() === lower)) {
    return true;
  }
  // Substring fallback so future variants (e.g. "Reolink Duo 4 ...") and the
  // assorted spellings cameras report for the TrackMix / TrackFlex / Duo
  // families are picked up without code changes. Mirrors the `checkModelMatch`
  // helper inside `getDualLensChannelInfo`.
  return (
    lower.includes("trackmix") ||
    lower.includes("trackflex") ||
    /\bduo\b/.test(lower)
  );
};

/**
 * Exact type values that indicate NVR/Hub devices.
 * These are checked with exact case-insensitive match.
 */
export const NVR_HUB_EXACT_TYPES: string[] = ["NVR", "WIFI_NVR", "HOMEHUB"];

/**
 * Model patterns that indicate NVR/Hub devices.
 * These devices may report channelNum=1 but actually support multiple channels.
 * Case-insensitive matching is used.
 */
export const NVR_HUB_MODEL_PATTERNS: RegExp[] = [
  /home\s*hub/i, // "Home Hub", "HomeHub", "Reolink Home Hub"
  /reolink\s*hub/i, // "Reolink Hub"
  /wifi[-_\s]*nvr/i, // "WIFI-NVR", "WiFi NVR", "WIFI_NVR"
  /^nvr/i, // "NVR8-xxx", "NVR16-xxx"
  /^rlk\d+-\d+/i, // "RLK8-xxx", "RLK16-xxx" (NVR kits)
  /^rlk\d+w/i, // "RLK8W-xxx" (wireless NVR kits)
];

/**
 * Check if a model/type name indicates an NVR/Hub device.
 * Checks both exact type matches and regex patterns.
 * @param model - The device model/type string
 * @returns true if the model matches NVR/Hub patterns
 */
export const isNvrHubModel = (model?: string): boolean => {
  if (!model) return false;
  const normalized = model.trim();
  const upper = normalized.toUpperCase();

  // Check exact type matches first
  if (NVR_HUB_EXACT_TYPES.includes(upper)) return true;

  // Check regex patterns
  return NVR_HUB_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
};

export class ReolinkBaichuanApi {
  readonly logger: Logger;
  private readonly httpClient: ReolinkHttpClient;
  private readonly cgiApi: ReolinkCgiApi;
  private readonly nativeOnly: boolean;
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;

  /**
   * Set to `true` after `close()` is called.
   * Once closed, the API instance should not be reused.
   */
  private _closed = false;

  // ─────────────────────────────────────────────────────────────────────────────
  // SOCKET POOL - Tag-based socket management
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Socket pool with tag-based allocation strategy.
   * Tags determine which sockets are shared vs dedicated:
   *
   * For standalone camera (channelCount=1):
   * - "general" - commands, events, ext stream (all share one socket)
   * - "streaming" - main + sub streams (share one socket)
   * - "replay:XXX" - dedicated per replay session
   *
   * For NVR (channelCount>1):
   * - "general" - commands, events (shared socket)
   * - "streaming:chN" - main + sub for channel N (one socket per channel)
   * - "replay:XXX" - dedicated per replay session
   */
  private readonly socketPool = new Map<
    string,
    {
      client: BaichuanClient;
      /** Promise for socket that is being created (login in progress) */
      pendingPromise?: Promise<BaichuanClient>;
      /** Number of active consumers of this socket */
      refCount: number;
      createdAt: number;
      lastUsedAt: number;
      /** Timer to auto-close idle sockets (mainly for replay) */
      idleCloseTimer: ReturnType<typeof setTimeout> | undefined;
      /**
       * Release function for the permit held on the "general" client.
       * When a streaming/replay socket is active, it acquires a permit on the
       * general client to prevent it from idle-disconnecting and cascading a
       * full API teardown.
       */
      generalPermitRelease: (() => void) | undefined;
    }
  >();

  /**
   * Consecutive stream-start (cmdId=3) timeout counter per socket tag.
   * When a streaming socket has N consecutive timeouts, the socket is force-closed
   * so the next attempt creates a fresh connection. Resets on success.
   */
  private readonly consecutiveStreamTimeouts = new Map<string, number>();
  private static readonly MAX_CONSECUTIVE_STREAM_TIMEOUTS = 3;

  /** BaichuanClientOptions to use when creating new sockets */
  private readonly clientOptions: BaichuanClientOptions;

  /**
   * Get the primary "general" socket. This is the default socket for commands and events.
   * Lazily created on first access if not already initialized.
   *
   * This getter maintains backward compatibility with existing code that uses `this.client`.
   */
  get client(): BaichuanClient {
    const entry = this.socketPool.get("general");
    if (!entry) {
      if (this._closed) {
        throw new Error(
          "[ReolinkBaichuanApi] API has been closed — create a new instance to reconnect",
        );
      }
      throw new Error("[ReolinkBaichuanApi] General socket not initialized");
    }
    return entry.client;
  }

  /**
   * `true` after `close()` has been called. A closed API should not be reused;
   * the consumer should create a new instance.
   */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * `true` when the API is usable: not closed, general socket exists, socket
   * is connected and the client is logged in.
   *
   * This is the recommended way for consumers to check whether the API is
   * still valid before issuing commands, instead of directly accessing
   * `api.client.isSocketConnected()` / `api.client.loggedIn` (which throws
   * if the socket pool was already destroyed).
   */
  get isReady(): boolean {
    if (this._closed) return false;
    const entry = this.socketPool.get("general");
    if (!entry) return false;
    try {
      return entry.client.isSocketConnected() && entry.client.loggedIn;
    } catch {
      return false;
    }
  }

  /** Promise tracking an in-flight reconnection from `ensureConnected()`. */
  private _ensureConnectedPromise: Promise<void> | undefined;

  /**
   * Ensure the "general" socket is connected and logged in.
   * If the socket is disconnected or the pool entry was destroyed, a new
   * general socket is created, logged in, and all event/push/guard listeners
   * are re-attached automatically.
   *
   * This is a **no-op** when the API is already {@link isReady}.
   *
   * @throws If `close()` was called — the API is permanently closed and a new
   *         instance must be created.
   */
  async ensureConnected(): Promise<void> {
    if (this._closed) {
      throw new Error(
        "[ReolinkBaichuanApi] API has been closed — create a new instance to reconnect",
      );
    }

    if (this.isReady) return;

    // Prevent concurrent reconnections — second caller reuses the same promise
    if (this._ensureConnectedPromise) {
      return this._ensureConnectedPromise;
    }

    this._ensureConnectedPromise = this.reconnectGeneralSocket();
    try {
      await this._ensureConnectedPromise;
    } finally {
      this._ensureConnectedPromise = undefined;
    }
  }

  /**
   * Internal: destroy the current general socket (if any), create a new one,
   * login, and re-attach all listeners.
   */
  private async reconnectGeneralSocket(): Promise<void> {
    // --- tear down old general socket ---
    const oldEntry = this.socketPool.get("general");
    if (oldEntry) {
      oldEntry.client.removeAllListeners();
      if (oldEntry.idleCloseTimer) clearTimeout(oldEntry.idleCloseTimer);
      if (oldEntry.generalPermitRelease) {
        try {
          oldEntry.generalPermitRelease();
        } catch {
          /* ignore */
        }
      }
      this.socketPool.delete("general");
      try {
        await oldEntry.client.close({ reason: "reconnect", skipLogout: true });
      } catch {
        // ignore close errors
      }
    }

    // --- create new general socket ---
    const newClient = new BaichuanClient(this.clientOptions);
    this.attachD2cDiscListener(newClient);
    this.socketPool.set("general", {
      client: newClient,
      refCount: 1, // general socket is always "in use"
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      idleCloseTimer: undefined,
      generalPermitRelease: undefined,
    });

    // Attach listeners *before* login — some events fire during the login handshake
    this.setupGeneralClientListeners();

    // Login with the new socket
    await this.client.login();

    this.logger.log?.(
      "[ReolinkBaichuanApi] General socket reconnected successfully",
    );

    // Re-subscribe to events if there are registered listeners.
    // After reconnection the old subscription is gone (old socket destroyed),
    // so we need to re-send the subscribe command on the new socket.
    // This handles camera reboots and transient disconnections transparently,
    // without requiring the consumer to track subscription intent.
    if (this.simpleEventListeners.size > 0) {
      this.simpleEventSubscribed = false;
      this.simpleEventWatchdogRecoveryAttempts = 0;
      this.simpleEventWatchdogLastRecoveryAt = 0;
      try {
        await this.ensureSimpleEventSubscribed();
        this.simpleEventLastReceivedAt = Date.now();
        this.logger.log?.(
          `[ReolinkBaichuanApi] Events re-subscribed after reconnection (listeners=${this.simpleEventListeners.size})`,
        );
      } catch (e: unknown) {
        // Non-fatal: the watchdog will retry with exponential backoff.
        (this.logger.debug ?? this.logger.log).call(
          this.logger,
          `[ReolinkBaichuanApi] Event re-subscribe after reconnection failed, watchdog will retry`,
          formatErrorForLog(e),
        );
      }
    }
  }

  /**
   * Attach event, push, channelInfo, and guard listeners to the current
   * "general" client.  Called from the constructor and from
   * {@link reconnectGeneralSocket}.
   */
  private setupGeneralClientListeners(): void {
    const client = this.client; // cache to avoid repeated getter look-ups

    // Dispatch parsed events in a minimal, stable shape.
    client.on("event", (event) => {
      const mapped = mapToSimpleEvent(event);
      if (!mapped) return;
      this.dispatchSimpleEvent(mapped);
    });

    // Handle battery info push (cmd_id 252 = BatteryInfoList).
    // Cameras emit these repeatedly while streaming (often every few
    // seconds). Deduplicate: only forward when percent/charge/adapter
    // actually changes, so downstream consumers (SSE, MQTT, UI event
    // log) don't get flooded.
    client.on("batteryPush", (frame) => {
      try {
        const xml = this.client.tryDecryptXml(
          frame.body,
          frame.header.channelId,
          this.client.enc,
        );
        if (!xml) return;
        const channel = frame.header.channelId;
        const battery = this.parseBatteryInfoXml(xml, channel);
        if (
          battery.batteryPercent === undefined &&
          battery.chargeStatus === undefined &&
          battery.adapterStatus === undefined
        ) {
          return;
        }
        const key = `${battery.batteryPercent ?? ""}|${battery.chargeStatus ?? ""}|${battery.adapterStatus ?? ""}`;
        if (this.lastBatteryPushKey.get(channel) === key) {
          return;
        }
        this.lastBatteryPushKey.set(channel, key);
        this.dispatchSimpleEvent({
          type: "battery",
          channel,
          timestamp: Date.now(),
          battery,
        });
      } catch (e: unknown) {
        this.logger.debug?.(
          "[ReolinkBaichuanApi] Error parsing battery push",
          formatErrorForLog(e),
        );
      }
    });

    // Handle channel info push from NVR (cmd_id 145)
    client.on("channelInfo", (xml: string) => {
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
    client.on("push", (frame) => {
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
        const xml = client.tryDecryptXml(
          frame.body,
          frame.header.channelId,
          client.enc,
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

    // Disconnect storm guard
    if (this.rebootAfterDisconnectionsPerMinute > 0) {
      client.on("close", () => {
        try {
          void this.maybeRebootOnDisconnectStorm();
        } catch {
          // never throw from close handler
        }
      });
    }

    // ECONNRESET storm guard
    if (this.rebootAfterConsecutiveEconnreset > 0) {
      client.on("close", () => {
        try {
          void this.maybeRebootOnEconnresetStorm();
        } catch {
          // never throw from close handler
        }
      });
    }

    // Session guard: start periodic check after first push.
    // Opt-in via `enableSessionGuard: true` constructor option. When
    // disabled (default) we still log the active sessions once on startup
    // (purely informational, single call) but skip the recurring 60s poll
    // — see issue #18 for why this matters on battery cameras.
    if (!this.sessionGuardIntervalTimer) {
      client.once("push", () => {
        void this.logActiveSessionsOnStartup();
        if (this.sessionGuardEnabled) {
          this.sessionGuardIntervalTimer = setInterval(() => {
            void this.maybeRebootOnTooManySessions();
          }, 60_000);
        }
      });
    }
  }

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

  /**
   * Cached NVR/Hub detection result.
   * - true = NVR/Hub with multiple channels
   * - false = standalone camera
   * Set via setIsNvr() from the plugin or auto-detected via isNvrDevice().
   */
  private _isNvr: boolean | undefined;

  /**
   * Cached multi-focal detection result.
   * - true = dual-lens camera (e.g., TrackMix, TrackFlex) with multiple channels on a single device
   * - false = single-lens camera
   * Multi-focal cameras reject concurrent streaming TCP connections (response_code 430),
   * so all channels must multiplex on the same streaming socket.
   */
  private _isMultiFocal: boolean | undefined;

  /** Maximum dedicated sessions allowed before triggering a reboot (default: 7). */
  private maxDedicatedSessionsBeforeReboot: number | undefined;
  /**
   * Opt-in: when `false` (default), the lib never starts the 60s periodic
   * `getOnlineUserList` poll and never schedules an automatic reboot based
   * on the session count. The post-socket-create probe at line ~1859 is
   * also skipped. Consumers that want the legacy behaviour can pass
   * `enableSessionGuard: true` to the constructor.
   *
   * Rationale: on BCUDP (battery cameras) the periodic poll wakes the
   * camera every minute and triggers a perpetual sleeping↔awake cycle —
   * see issue #18. Even on AC cameras the auto-reboot side effect is
   * surprising; making it explicit avoids astonishment.
   */
  private sessionGuardEnabled: boolean = false;
  private sessionGuardRebootInFlight: Promise<void> | undefined;
  private sessionGuardLastRebootAtMs: number | undefined;
  /** Track last known session count and IDs for change detection. */
  private lastKnownSessionCount: number | undefined;
  private lastKnownSessionIds: Set<number> = new Set();

  /** Reboot if too many voluntary disconnections per minute (default: 15). */
  private rebootAfterDisconnectionsPerMinute: number = 15;
  private readonly disconnectStormVoluntaryAtMs: number[] = [];
  private disconnectStormRebootInFlight: Promise<void> | undefined;
  private disconnectStormLastRebootAtMs: number | undefined;

  /**
   * ECONNRESET storm guard: reboot if too many consecutive ECONNRESET errors.
   * Default threshold: 10 consecutive ECONNRESET within 60 seconds.
   */
  private rebootAfterConsecutiveEconnreset: number = 10;
  private consecutiveEconnresetCount: number = 0;
  private consecutiveEconnresetFirstAtMs: number | undefined;
  private econnresetStormRebootInFlight: Promise<void> | undefined;
  private econnresetStormLastRebootAtMs: number | undefined;

  /** Periodic session check interval (every 60 seconds). */
  private sessionGuardIntervalTimer: NodeJS.Timeout | undefined;

  private readonly simpleEventListeners = new Set<
    (event: ReolinkSimpleEvent) => void | Promise<void>
  >();
  private simpleEventSubscribed = false;

  // Detection events are sourced from BcMedia additionalHeader on active video
  // streams. Unlike simpleEvent, no Baichuan subscribe command is needed — the
  // data flows whenever a stream is open. Active streams register themselves via
  // _registerVideoStreamForDetection (called from BaichuanVideoStream.start).
  private readonly detectionEventListeners = new Set<
    (event: ReolinkDetectionEvent) => void | Promise<void>
  >();
  private readonly detectionEventStreamHooks = new Map<
    object,
    () => void
  >();
  // Auto-managed substreams for `onObjectDetections` listeners. One entry per
  // `(channel, profile)` tuple — required for NVR/Hub setups where AI boxes
  // live on a specific channel, and for callers that need detections off a
  // profile other than the default `sub`. The substream is opened on the first
  // listener of a tuple and torn down when the last one for that tuple leaves.
  private readonly objectDetectionSubs = new Map<
    string,
    {
      channel: number;
      profile: "main" | "sub" | "ext";
      listeners: Set<
        (event: ReolinkDetectionEvent) => void | Promise<void>
      >;
      stream?: { stop: () => Promise<void>; release: () => Promise<void> };
      startInFlight?: Promise<void>;
    }
  >();
  // Single bridge installed into `detectionEventListeners` while at least one
  // object-detection subscription is active. It routes events to the correct
  // tuple's listener set based on `event.channel` / `event.profile`.
  private objectDetectionInternalListener:
    | ((event: ReolinkDetectionEvent) => void)
    | undefined;
  private simpleEventSubscribeInFlight: Promise<void> | undefined;
  private simpleEventUnsubscribeInFlight: Promise<void> | undefined;
  private simpleEventResubscribeTimer: NodeJS.Timeout | undefined;
  private simpleEventResubscribeInFlight: Promise<void> | undefined;
  private readonly simpleEventResubscribeIntervalMs = 5 * 60_000;

  // Event watchdog: auto-recovery when events stop flowing or subscription fails
  private simpleEventWatchdogTimer: NodeJS.Timeout | undefined;
  private simpleEventLastReceivedAt: number = 0;
  private simpleEventWatchdogRecoveryAttempts: number = 0;
  private simpleEventWatchdogLastRecoveryAt: number = 0;
  private readonly simpleEventWatchdogIntervalMs = 10_000; // check every 10s
  private readonly simpleEventWatchdogSilenceThresholdMs = 5 * 60_000; // 5 min without events
  private statePollingInterval: NodeJS.Timeout | undefined;
  private udpSleepInferenceInterval: NodeJS.Timeout | undefined;
  private readonly udpLastInferredSleepStateByChannel = new Map<
    number,
    SleepStatus["state"]
  >();
  /**
   * Per-channel pending sleep-state candidate for hysteresis.
   * When the inference flips to a new state we require N consecutive polls
   * of that same state before committing it — this filters out transient
   * flapping caused by non-waking traffic drifting in/out of the 10 s
   * getSleepStatus() observation window during stream teardown.
   */
  private readonly udpPendingSleepStateByChannel = new Map<
    number,
    { state: SleepStatus["state"]; count: number }
  >();
  private readonly udpSleepInferenceIntervalMs = 2_000;
  /** Consecutive inference polls required to commit a new sleeping/awake state. */
  private readonly udpSleepInferenceHysteresisPolls = 2;
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

  // ─── D2C_DISC cooldown & storm detection ────────────────────────────────────
  // Tracked on the API instance (survives BaichuanClient recreation).
  /** Timestamp of the most recent D2C_DISC from any client for this device. */
  private lastD2cDiscAtMs = 0;
  /** Sliding window of recent D2C_DISC timestamps for storm detection. */
  private readonly d2cDiscTimestamps: number[] = [];
  /** Immediate cooldown (ms) applied to socket pool on every D2C_DISC.
   *  Prevents reconnect attempts while the camera is transitioning to sleep. */
  private static readonly D2C_DISC_IMMEDIATE_COOLDOWN_MS = 10_000;
  /** Number of D2C_DISCs within the storm window to trigger extended cooldown. */
  private static readonly D2C_DISC_STORM_THRESHOLD = 3;
  /** Sliding window size (ms) for storm detection. */
  private static readonly D2C_DISC_STORM_WINDOW_MS = 60_000;
  /** Extended cooldown (ms) applied to socket pool when a D2C_DISC storm is detected. */
  private static readonly D2C_DISC_STORM_COOLDOWN_MS = 120_000;

  private readonly nvrChannelsSummaryCache = new Map<
    string,
    NvrChannelsSummaryCacheEntry
  >();

  /**
   * Cached device capabilities per channel.
   * Cache is invalidated on reconnect or after TTL (5 minutes).
   */
  private readonly deviceCapabilitiesCache = new Map<
    number,
    DeviceCapabilitiesCacheEntry
  >();
  private static readonly CAPABILITIES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Dedupe key for battery push events (cmd_id 252), per channel.
   * Cameras emit BatteryInfoList frequently while streaming (every few
   * seconds). We only forward an event when the meaningful fields change
   * (percent, chargeStatus, adapterStatus) to avoid flooding SSE/MQTT
   * consumers and the UI event log.
   */
  private readonly lastBatteryPushKey = new Map<number, string>();

  // ─────────────────────────────────────────────────────────────────────────────
  // SOCKET POOL CONSTANTS
  // ─────────────────────────────────────────────────────────────────────────────

  /** Keep replay/streaming sockets warm briefly to reduce clip switch latency. */
  private static readonly SOCKET_POOL_KEEPALIVE_MS = 10_000;

  /**
   * Cooldown tracking to prevent session spam when login repeatedly fails.
   * Key: host address (since camera session limits are per-device, not per-sessionKey)
   * Value: object with failureCount, lastFailureAt, cooldownUntil
   */
  private readonly socketPoolCooldowns = new Map<
    string,
    {
      failureCount: number;
      lastFailureAt: number;
      cooldownUntil: number;
    }
  >();

  /** Base cooldown duration (ms) for socket failures. */
  private static readonly SOCKET_POOL_BASE_COOLDOWN_MS = 5_000;
  /** Max cooldown duration (ms) - caps exponential backoff. */
  private static readonly SOCKET_POOL_MAX_COOLDOWN_MS = 120_000;
  /** Failure count threshold before entering cooldown. */
  private static readonly SOCKET_POOL_FAILURE_THRESHOLD = 2;
  /** Time window (ms) to reset failure count if no failures occur. */
  private static readonly SOCKET_POOL_FAILURE_WINDOW_MS = 60_000;

  /**
   * Get a summary of currently active sockets in the pool.
   * Useful for debugging/logging to see how many sockets are open.
   */
  getSocketPoolSummary(): { count: number; tags: string[] } {
    return {
      count: this.socketPool.size,
      tags: Array.from(this.socketPool.keys()),
    };
  }

  /**
   * @deprecated Use getSocketPoolSummary() instead.
   */
  getDedicatedSessionsSummary(): { count: number; keys: string[] } {
    const summary = this.getSocketPoolSummary();
    return {
      count: summary.count,
      keys: summary.tags,
    };
  }

  /**
   * Get cooldown status for socket pool connections.
   * Useful for debugging when connections are being rate-limited.
   */
  getSocketPoolCooldownStatus(): {
    host: string;
    inCooldown: boolean;
    failureCount: number;
    cooldownRemainingMs: number;
    cooldownUntil: Date | null;
  } | null {
    const entry = this.socketPoolCooldowns.get(this.host);
    if (!entry) return null;

    const now = Date.now();
    const inCooldown = now < entry.cooldownUntil;
    return {
      host: this.host,
      inCooldown,
      failureCount: entry.failureCount,
      cooldownRemainingMs: inCooldown ? entry.cooldownUntil - now : 0,
      cooldownUntil: inCooldown ? new Date(entry.cooldownUntil) : null,
    };
  }

  /**
   * @deprecated Use getSocketPoolCooldownStatus() instead.
   */
  getDedicatedClientCooldownStatus(): ReturnType<
    ReolinkBaichuanApi["getSocketPoolCooldownStatus"]
  > {
    return this.getSocketPoolCooldownStatus();
  }

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

  /**
   * Abort controller for the currently active replay stream.
   * When a new clip is requested, we signal the current one to stop.
   */
  private activeReplayAbortController: AbortController | null = null;

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
    if (this.replayQueueProcessing) {
      this.logger?.debug?.(
        `[ReplayQueue] Already processing, queue length: ${this.replayQueue.length}`,
      );
      return;
    }
    this.replayQueueProcessing = true;

    this.logger?.debug?.(
      `[ReplayQueue] Starting queue processing, items: ${this.replayQueue.length}`,
    );

    while (this.replayQueue.length > 0) {
      const item = this.replayQueue.shift();
      if (item) {
        // Ensure minimum cooldown between replay operations
        const timeSinceLastReplay = Date.now() - this.lastReplayEndTime;
        if (timeSinceLastReplay < this.REPLAY_COOLDOWN_MS) {
          const waitTime = this.REPLAY_COOLDOWN_MS - timeSinceLastReplay;
          this.logger?.debug?.(`[ReplayQueue] Waiting ${waitTime}ms cooldown`);
          await new Promise((r) => setTimeout(r, waitTime));
        }

        this.logger?.debug?.(
          `[ReplayQueue] Executing item, remaining: ${this.replayQueue.length}`,
        );
        await item.execute();

        // Record when this operation ended
        this.lastReplayEndTime = Date.now();
        this.logger?.debug?.(`[ReplayQueue] Item completed`);
      }
    }

    this.replayQueueProcessing = false;
    this.logger?.debug?.(`[ReplayQueue] Queue processing complete`);
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
   *                 Receives an AbortSignal that will be triggered if a new clip is requested.
   * @returns Promise that resolves when setup is complete, with the result, release function, and abort signal.
   */
  private enqueueStreamingReplayOperation<T>(
    setup: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<{ result: T; release: () => void; abortSignal: AbortSignal }> {
    // Signal the currently active replay stream to stop (if any)
    if (this.activeReplayAbortController) {
      this.logger?.debug?.(
        "[ReplayQueue] Signaling current replay stream to abort for new clip",
      );
      this.activeReplayAbortController.abort();
      this.activeReplayAbortController = null;
    }

    let resolvePromise: (value: {
      result: T;
      release: () => void;
      abortSignal: AbortSignal;
    }) => void;
    let rejectPromise: (error: unknown) => void;
    const promise = new Promise<{
      result: T;
      release: () => void;
      abortSignal: AbortSignal;
    }>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // Add to queue
    this.replayQueue.push({
      execute: () => {
        return new Promise<void>((releaseSlot) => {
          let released = false;
          const safeRelease = () => {
            if (released) return;
            released = true;
            // Clear the active abort controller when this stream ends
            if (
              this.activeReplayAbortController &&
              this.activeReplayAbortController === abortController
            ) {
              this.activeReplayAbortController = null;
            }
            releaseSlot();
          };

          // Create abort controller for this stream
          const abortController = new AbortController();
          this.activeReplayAbortController = abortController;

          // Safety timeout: release slot if not released within 10 minutes
          // This prevents queue deadlocks from stuck streams
          const safetyTimeout = setTimeout(
            () => {
              if (!released) {
                this.logger?.warn?.(
                  "[ReplayQueue] Safety timeout: releasing queue slot after 10 minutes",
                );
                abortController.abort();
                safeRelease();
              }
            },
            10 * 60 * 1000,
          );

          // Run the setup
          setup(abortController.signal)
            .then((result) => {
              // Setup succeeded - resolve with result, release function, and abort signal
              resolvePromise({
                result,
                release: () => {
                  clearTimeout(safetyTimeout);
                  safeRelease();
                },
                abortSignal: abortController.signal,
              });
            })
            .catch((e) => {
              // Setup failed - reject and release slot
              clearTimeout(safetyTimeout);
              rejectPromise(e);
              safeRelease();
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
   * Stream profiles that the device explicitly rejected (response_code 400).
   * Keyed by `"ch:profile"` (e.g. `"0:ext"`). Once a profile is in this set
   * it is excluded from `buildVideoStreamOptions()` results and no further
   * start attempts are made until the API instance is recreated.
   */
  private readonly _rejectedStreamProfiles = new Set<string>();

  /**
   * Check whether a stream profile was rejected by the device at runtime
   * (e.g. ext returned response_code 400).
   */
  isStreamProfileRejected(channel: number, profile: StreamProfile): boolean {
    return this._rejectedStreamProfiles.has(`${channel}:${profile}`);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // SOCKET POOL MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Determine the socket tag for a given sessionKey.
   * This implements the tag-based allocation strategy:
   *
   * - "general" - commands, events, ext on ch0
   * - "streaming:ch{N}" - main + sub for channel N (NVR/standalone single-lens)
   * - "streaming:ch{N}:ext" - ext for channel N (NVR/standalone, N>0)
   * - "streaming:a" - ch0 main + ch1 sub (multi-focal dedicated socket)
   * - "general" also carries ch1 main + ch0 sub for multi-focal (merged with commands/events)
   * - "replay:deviceId:ch{N}" - dedicated per device+channel for replay
   *
   * Multi-focal cameras (TrackMix, TrackFlex, Duo) reject two main or two sub
   * streams on the same TCP connection (response_code 430). Cross-channel pairing
   * ensures each socket always has a valid M+S combination using only 2 TCP connections.
   *
   * @param sessionKey - The session key (e.g., "live:device:ch0:main", "replay:device:ch1:file")
   * @returns The socket pool tag to use
   */
  private resolveSocketTag(sessionKey: string): string {
    // Replay keys: replay:deviceId:ch{N}:filename or replay:deviceId
    // Use dedicated socket per device+channel to allow concurrent replay from multiple users
    const replayMatch = sessionKey.match(/^replay:([^:]+)(?::ch(\d+))?/);
    if (replayMatch) {
      const deviceId = replayMatch[1];
      const channel = replayMatch[2] ?? "0";
      return `replay:${deviceId}:ch${channel}`;
    }

    // Parse live stream keys: live:deviceId:ch{N}:{profile}
    const liveMatch = sessionKey.match(/^live:[^:]+:ch(\d+):(\w+)$/);
    if (liveMatch && liveMatch[1] && liveMatch[2]) {
      const channel = parseInt(liveMatch[1], 10);
      const profile = liveMatch[2].toLowerCase();

      // ext on channel 0 goes to general socket
      // ext on other channels needs its own socket
      if (profile === "ext") {
        if (channel === 0) {
          return "general";
        }
        // Multi-focal: ext goes to general (rarely used, avoid opening extra sockets)
        if (this._isMultiFocal) {
          return "general";
        }
        // NVR/Hub: per-channel ext socket
        return this._isNvr ? `streaming:ch${channel}:ext` : `streaming:ch${channel}:ext`;
      }
      // Multi-focal (TrackMix, TrackFlex, Duo): cross-channel pairing.
      // The camera rejects two main or two sub streams on the same TCP connection (response_code 430).
      // Socket A (dedicated) = ch0 main + ch1 sub
      // General socket        = commands + events + ch1 main + ch0 sub
      // This ensures each socket always has a valid M+S combination (2 TCP connections total).
      if (this._isMultiFocal) {
        const isSocketA = (channel === 0 && profile === "main") || (channel === 1 && profile === "sub");
        return isSocketA ? "streaming:a" : "general";
      }
      // NVR/Hub: per-channel socket for each camera
      // Standalone single-lens: per-channel socket (only ch0 exists anyway)
      return this._isNvr ? `streaming:ch${channel}` : `streaming:ch${channel}`;
    }

    // Unknown keys go to general socket
    return "general";
  }

  /**
   * Attach a D2C_DISC listener to a BaichuanClient so that the API-level
   * grace period and storm detection are updated regardless of which
   * pool socket receives the disconnect.
   */
  private attachD2cDiscListener(client: BaichuanClient): void {
    client.on("d2c_disc", () => this.notifyD2cDisc());
    // Safety-net "error" listener: Node's EventEmitter throws if "error" is
    // emitted with no listeners. Sockets routinely receive ECONNRESET / EPIPE
    // (camera reboot, WiFi drop, scheduled wake) and consumer-side error
    // listeners may be temporarily detached during cleanup. Without this the
    // unhandled error crashes the host process. Real diagnostics still flow
    // through the consumer's own listener; this one only swallows the leak.
    client.on("error", () => {
      // Swallow — the underlying close/cleanup paths handle the disconnect.
    });
  }

  /**
   * Acquire a socket from the pool by tag.
   * Creates a new socket if needed, or reuses an existing one.
   *
   * @param tag - The socket pool tag (from resolveSocketTag)
   * @param logger - Optional logger for debug output
   * @returns The socket and a release function
   */
  private async acquirePooledSocket(
    tag: string,
    logger?: Logger,
  ): Promise<{
    client: BaichuanClient;
    release: () => Promise<void>;
  }> {
    const log = logger ?? this.logger;
    const now = Date.now();

    // ─── Cooldown check: prevent session spam (login failures or D2C_DISC) ───
    const cooldownEntry = this.socketPoolCooldowns.get(this.host);
    if (cooldownEntry) {
      // Reset failure count if enough time has passed since last failure
      if (
        now - cooldownEntry.lastFailureAt >
        ReolinkBaichuanApi.SOCKET_POOL_FAILURE_WINDOW_MS
      ) {
        this.socketPoolCooldowns.delete(this.host);
        log?.debug?.(
          `[SocketPool] Cooldown reset for host=${this.host} (no failures for ${ReolinkBaichuanApi.SOCKET_POOL_FAILURE_WINDOW_MS}ms)`,
        );
      } else if (now < cooldownEntry.cooldownUntil) {
        // Still in cooldown - reject immediately
        const remainingMs = cooldownEntry.cooldownUntil - now;
        const isD2cDisc =
          this.lastD2cDiscAtMs > 0 &&
          now - this.lastD2cDiscAtMs < 120_000;
        const reason = isD2cDisc
          ? "D2C_DISC (camera sleeping)"
          : "repeated login failures";
        const error = new Error(
          `[SocketPool] Host ${this.host} is in cooldown for ${Math.ceil(remainingMs / 1000)}s due to ${reason}. tag=${tag}`,
        );
        log?.debug?.(error.message);
        throw error;
      }
    }

    // Check for existing socket with this tag
    const existing = this.socketPool.get(tag);
    if (existing) {
      // Cancel any pending idle close timer
      if (existing.idleCloseTimer) {
        clearTimeout(existing.idleCloseTimer);
        existing.idleCloseTimer = undefined;
      }

      // If socket is being created, wait for it
      if (existing.pendingPromise) {
        const client = await existing.pendingPromise;
        existing.refCount++;
        existing.lastUsedAt = Date.now();
        log?.debug?.(
          `[SocketPool] Waited for pending socket creation for tag=${tag} (refCount=${existing.refCount})`,
        );
        return {
          client,
          release: () => this.releasePooledSocket(tag, logger),
        };
      }

      // Try to reuse existing socket
      if (existing.refCount === 0) {
        // Socket is idle, try to reuse it
        existing.refCount = 1;
        existing.lastUsedAt = Date.now();
        log?.debug?.(`[SocketPool] Reusing idle socket for tag=${tag}`);

        // Best-effort: ensure logged in
        try {
          if (!existing.client.loggedIn) {
            await existing.client.login();
          }
        } catch {
          // If login fails, fall through to recreate socket
        }

        // If still usable, return it
        if (existing.client.loggedIn) {
          return {
            client: existing.client,
            release: () => this.releasePooledSocket(tag, logger),
          };
        }
      } else {
        // Socket is in use - for replay tags, we need to preempt
        if (tag.startsWith("replay:")) {
          log?.debug?.(
            `[SocketPool] Preempting active replay socket for tag=${tag}`,
          );
          // Fall through to recreate
        } else {
          // For shared sockets (general, streaming), just reuse
          existing.refCount++;
          existing.lastUsedAt = Date.now();
          log?.debug?.(
            `[SocketPool] Reusing active socket for tag=${tag} (refCount=${existing.refCount})`,
          );
          return {
            client: existing.client,
            release: () => this.releasePooledSocket(tag, logger),
          };
        }
      }

      // Close the existing unusable/preempted socket
      log?.debug?.(
        `[SocketPool] Closing existing socket for tag=${tag} (recreating)`,
      );
      this.socketPool.delete(tag);
      // Release the general-client permit if this socket held one.
      if (existing.generalPermitRelease) {
        try {
          existing.generalPermitRelease();
        } catch {
          // ignore
        }
        existing.generalPermitRelease = undefined;
      }
      try {
        await existing.client.close({
          reason: "socket pool recreation",
          skipLogout: true,
        });
      } catch (e) {
        log?.warn?.(
          `[SocketPool] Error closing old socket for tag=${tag}: ${e}`,
        );
      }
    }

    // Create a new socket
    log?.log?.(`[SocketPool] Creating new socket for tag=${tag}`);

    const entry: {
      client: BaichuanClient;
      pendingPromise?: Promise<BaichuanClient>;
      refCount: number;
      createdAt: number;
      lastUsedAt: number;
      idleCloseTimer: ReturnType<typeof setTimeout> | undefined;
      generalPermitRelease: (() => void) | undefined;
    } = {
      client: undefined as unknown as BaichuanClient, // Will be set after login
      refCount: 0,
      createdAt: now,
      lastUsedAt: now,
      idleCloseTimer: undefined,
      generalPermitRelease: undefined,
    };

    // Create the socket with a pending promise
    entry.pendingPromise = (async () => {
      try {
        // Create with logger from the caller if provided
        const clientOpts = log
          ? { ...this.clientOptions, logger: log }
          : this.clientOptions;
        const newClient = new BaichuanClient(clientOpts);
        this.attachD2cDiscListener(newClient);

        // Always attach an "error" listener — Node's EventEmitter throws if
        // an "error" event has no listener, and pooled streaming sockets
        // routinely receive ECONNRESET / EPIPE when the device drops the
        // connection (camera reboot, scheduled wake-up, WiFi loss). Without
        // this listener the unhandled error crashes the host process.
        newClient.on("error", (err: unknown) => {
          log?.debug?.(
            `[SocketPool] tag=${tag} client error: ${(err as { message?: string })?.message ?? err}`,
          );
        });

        await newClient.login();

        // Success: clear login-failure cooldown, but preserve D2C_DISC storm cooldown.
        // D2C_DISC storms succeed at login but disconnect shortly after — clearing
        // the cooldown would allow immediate re-creation and perpetuate the storm.
        const existingCooldown = this.socketPoolCooldowns.get(this.host);
        if (existingCooldown) {
          const isStormCooldown =
            existingCooldown.failureCount >=
            ReolinkBaichuanApi.D2C_DISC_STORM_THRESHOLD;
          if (!isStormCooldown) {
            log?.debug?.(
              `[SocketPool] Clearing cooldown for host=${this.host} after successful login`,
            );
            this.socketPoolCooldowns.delete(this.host);
          } else {
            log?.debug?.(
              `[SocketPool] Preserving D2C_DISC storm cooldown for host=${this.host} (expires in ${Math.ceil((existingCooldown.cooldownUntil - Date.now()) / 1000)}s)`,
            );
          }
        }

        entry.client = newClient;
        entry.refCount = 1;
        entry.lastUsedAt = Date.now();
        delete entry.pendingPromise;

        log?.log?.(`[SocketPool] Socket connected for tag=${tag}`);

        // When a non-general socket is created, acquire a permit on the
        // general client to prevent it from idle-disconnecting (which would
        // cascade a full API teardown and kill all active streams).
        if (tag !== "general") {
          try {
            const generalEntry = this.socketPool.get("general");
            if (generalEntry?.client) {
              entry.generalPermitRelease = generalEntry.client.acquirePermit(
                0, // indefinite — released when the streaming socket closes
                `streaming-peer:${tag}`,
              );
            }
          } catch {
            // best-effort
          }
        }

        // Check session count after creating new socket (opt-in via
        // `enableSessionGuard`). See `sessionGuardEnabled` field doc for
        // why the default is `false`.
        if (this.sessionGuardEnabled) {
          void this.maybeRebootOnTooManySessions();
        }

        return newClient;
      } catch (loginError) {
        // Record the failure and calculate cooldown
        const prevCooldown = this.socketPoolCooldowns.get(this.host);
        const failureCount = (prevCooldown?.failureCount ?? 0) + 1;
        const now = Date.now();

        // Calculate exponential backoff cooldown
        let cooldownUntil = now;
        if (failureCount >= ReolinkBaichuanApi.SOCKET_POOL_FAILURE_THRESHOLD) {
          const backoffMs = Math.min(
            ReolinkBaichuanApi.SOCKET_POOL_BASE_COOLDOWN_MS *
              Math.pow(
                2,
                failureCount - ReolinkBaichuanApi.SOCKET_POOL_FAILURE_THRESHOLD,
              ),
            ReolinkBaichuanApi.SOCKET_POOL_MAX_COOLDOWN_MS,
          );
          cooldownUntil = now + backoffMs;
          log?.warn?.(
            `[SocketPool] Login failed for host=${this.host} (failure #${failureCount}). ` +
              `Entering cooldown for ${Math.ceil(backoffMs / 1000)}s. tag=${tag}`,
          );
        } else {
          log?.warn?.(
            `[SocketPool] Login failed for host=${this.host} (failure #${failureCount}/${ReolinkBaichuanApi.SOCKET_POOL_FAILURE_THRESHOLD} before cooldown). tag=${tag}`,
          );
        }

        this.socketPoolCooldowns.set(this.host, {
          failureCount,
          lastFailureAt: now,
          cooldownUntil,
        });

        // Remove the failed entry from pool
        this.socketPool.delete(tag);

        throw loginError;
      }
    })();

    this.socketPool.set(tag, entry);

    const client = await entry.pendingPromise;
    return {
      client,
      release: () => this.releasePooledSocket(tag, logger),
    };
  }

  /**
   * Release a socket back to the pool.
   * For shared sockets (general, streaming), just decrements refCount.
   * For replay sockets, schedules idle close.
   */
  private async releasePooledSocket(
    tag: string,
    logger?: Logger,
  ): Promise<void> {
    const log = logger ?? this.logger;
    const entry = this.socketPool.get(tag);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = Date.now();

    log?.debug?.(
      `[SocketPool] Released socket for tag=${tag} (refCount=${entry.refCount})`,
    );

    if (entry.refCount > 0) return;

    // Determine socket type for cleanup behavior
    const isReplayTag = tag.startsWith("replay:");
    const isStreamingTag = tag.startsWith("streaming:");
    const isGeneralTag = tag === "general";

    if (isGeneralTag) {
      // General socket stays open - it's used for commands/events
      // Will be cleaned up when API closes
      return;
    }

    if (isStreamingTag) {
      // Streaming sockets close when no streams are active
      // Use a short delay to handle quick stream restarts
      if (entry.idleCloseTimer) return; // Already scheduled

      entry.idleCloseTimer = setTimeout(async () => {
        const current = this.socketPool.get(tag);
        if (!current) return;
        if (current.refCount > 0) return;

        this.socketPool.delete(tag);
        // Release the permit held on the general client.
        if (current.generalPermitRelease) {
          try {
            current.generalPermitRelease();
          } catch {
            // ignore
          }
          current.generalPermitRelease = undefined;
        }
        log?.log?.(`[SocketPool] Closing idle streaming socket for tag=${tag}`);
        try {
          await current.client.close({
            reason: "streaming idle close",
            skipLogout: true,
          });
        } catch {
          // ignore
        }
      }, 5000); // 5 second grace period for stream restarts
      return;
    }

    if (isReplayTag) {
      // Keep replay sockets warm briefly to reduce startup latency between clips
      if (entry.idleCloseTimer) return; // Already scheduled

      entry.idleCloseTimer = setTimeout(async () => {
        const current = this.socketPool.get(tag);
        if (!current) return;
        if (current.refCount > 0) return;

        this.socketPool.delete(tag);
        log?.debug?.(
          `[SocketPool] Closing idle replay socket for tag=${tag} (keepalive expired)`,
        );
        try {
          await current.client.close({
            reason: "replay idle keepalive expired",
            skipLogout: true,
          });
        } catch {
          // ignore
        }
      }, ReolinkBaichuanApi.SOCKET_POOL_KEEPALIVE_MS);
      return;
    }

    // Unknown tags: close immediately
    this.socketPool.delete(tag);
    try {
      await entry.client.close({
        reason: "socket pool release",
        skipLogout: true,
      });
      log?.log?.(`[SocketPool] Closed socket for tag=${tag}`);
    } catch (e) {
      log?.warn?.(`[SocketPool] Error closing socket for tag=${tag}: ${e}`);
    }
  }

  /**
   * Force-close a socket by tag.
   * Used to preempt existing connections before acquiring a new one.
   */
  private async forceClosePooledSocket(
    tag: string,
    logger?: Logger,
  ): Promise<boolean> {
    const log = logger ?? this.logger;
    const entry = this.socketPool.get(tag);
    if (!entry) return false;

    if (entry.idleCloseTimer) {
      clearTimeout(entry.idleCloseTimer);
      entry.idleCloseTimer = undefined;
    }

    // Release the general-client permit if this socket held one.
    if (entry.generalPermitRelease) {
      try {
        entry.generalPermitRelease();
      } catch {
        // ignore
      }
      entry.generalPermitRelease = undefined;
    }

    log?.debug?.(`[SocketPool] Force-closing socket for tag=${tag}`);
    this.socketPool.delete(tag);

    try {
      await entry.client.close({
        reason: "force closed",
        skipLogout: true,
      });
      log?.log?.(`[SocketPool] Force-closed socket for tag=${tag}`);
    } catch (e) {
      log?.warn?.(`[SocketPool] Error during force-close for tag=${tag}: ${e}`);
    }

    return true;
  }

  /**
   * Cleanup all sockets in the pool. Called during API close.
   */
  private async cleanupSocketPool(): Promise<void> {
    const entries = Array.from(this.socketPool.entries());
    this.socketPool.clear();

    await Promise.allSettled(
      entries.map(async ([tag, entry]) => {
        try {
          if (entry.idleCloseTimer) {
            clearTimeout(entry.idleCloseTimer);
          }
          // Release the general-client permit if this socket held one.
          if (entry.generalPermitRelease) {
            try {
              entry.generalPermitRelease();
            } catch {
              // ignore
            }
            entry.generalPermitRelease = undefined;
          }
          this.logger?.debug?.(`[SocketPool] Cleanup: closing tag=${tag}`);
          await entry.client.close({ reason: "API cleanup", skipLogout: true });
        } catch {
          // ignore
        }
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC SESSION API (backward compatible)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a dedicated Baichuan client session for streaming.
   * This is useful for consumers that need isolated socket connections per stream.
   *
   * @param sessionKey - Unique key for this session (e.g., `live:\$\{deviceId\}:\$\{channel\}:\$\{profile\}`)
   * @param logger - Optional logger for debug output
   * @returns Object with `client` (the dedicated BaichuanClient) and `release` function to call when done
   *
   * Session keys are automatically mapped to socket pool tags:
   * - `live:device:ch0:ext` → "general" socket (shared with commands/events)
   * - `live:device:ch0:main` → "streaming" socket (standalone) or "streaming:ch0" (NVR)
   * - `live:device:ch0:sub` → "streaming" socket (standalone) or "streaming:ch0" (NVR)
   * - `replay:device:...` → dedicated per-replay socket
   *
   * @example
   * ```typescript
   * const { client, release } = await api.createDedicatedSession('live:device123:ch0:main');
   * try {
   *   // Use client for streaming...
   * } finally {
   *   await release();
   * }
   * ```
   */
  async createDedicatedSession(
    sessionKey: string,
    logger?: Logger,
  ): Promise<{
    client: BaichuanClient;
    release: () => Promise<void>;
  }> {
    const tag = this.resolveSocketTag(sessionKey);
    const log = logger ?? this.logger;
    log?.debug?.(
      `[SocketPool] createDedicatedSession sessionKey=${sessionKey} → tag=${tag}`,
    );
    return await this.acquirePooledSocket(tag, logger);
  }

  /**
   * @deprecated Use forceClosePooledSocket via createDedicatedSession instead.
   * Force-close a dedicated client if it exists.
   */
  private async forceCloseDedicatedClient(
    sessionKey: string,
    logger?: Logger,
  ): Promise<boolean> {
    const tag = this.resolveSocketTag(sessionKey);
    return await this.forceClosePooledSocket(tag, logger);
  }

  /**
   * @deprecated Cleanup handled by cleanupSocketPool now.
   */
  private async cleanupDedicatedClients(): Promise<void> {
    // No-op: handled by cleanupSocketPool
  }

  private dispatchSimpleEvent(evt: ReolinkSimpleEvent): void {
    // Track last event time for watchdog
    this.simpleEventLastReceivedAt = Date.now();
    // Reset recovery state on successful event delivery
    if (this.simpleEventWatchdogRecoveryAttempts > 0) {
      (this.logger.info ?? this.logger.log).call(
        this.logger,
        `[ReolinkBaichuanApi] event watchdog: events flowing again after ${this.simpleEventWatchdogRecoveryAttempts} recovery attempt(s)`,
      );
      this.simpleEventWatchdogRecoveryAttempts = 0;
    }

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
       * Reboot the device if the number of sessions from our IP reaches this threshold.
       * Default: dynamic, calculated as `(1 + ourDedicatedSessions) * 2`.
       * Set to a specific number to override the dynamic default.
       */
      maxDedicatedSessionsBeforeReboot?: number;
      /**
       * Reboot the device if there are too many voluntary disconnects within 60 seconds.
       * Default: 15. Set to 0 or negative to disable.
       */
      rebootAfterDisconnectionsPerMinute?: number;
      /**
       * Reboot the device if there are too many consecutive ECONNRESET errors within 60 seconds.
       * This guards against camera saturation where the device refuses all new connections.
       * Default: 10. Set to 0 or negative to disable.
       */
      rebootAfterConsecutiveEconnreset?: number;
      /** If true, avoid using HTTP/CGI fallbacks and discovery paths (native Baichuan only). */
      nativeOnly?: boolean;
      /**
       * Enable the periodic session-count guard: every 60s the lib polls
       * `getOnlineUserList` (cmd_id 120) and triggers a device reboot if
       * sessions from our IP exceed `maxDedicatedSessionsBeforeReboot`.
       *
       * Default: `false`. The poll wakes battery cameras on every tick and
       * its only side effect — an automatic reboot — is a heavy-hand fix
       * for a problem that rarely materialises in practice. Set to `true`
       * only if you specifically need the legacy auto-recovery behaviour;
       * even then the lib skips the poll on UDP transport.
       */
      enableSessionGuard?: boolean;
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

    // Store client options for creating new sockets in the pool.
    // All transport-related fields must be forwarded so that pooled sockets
    // use the same transport (tcp/udp/auto) as the primary "general" socket.
    // Only include optional fields if they're defined to satisfy exactOptionalPropertyTypes.
    this.clientOptions = {
      host: opts.host,
      username: opts.username,
      password: opts.password,
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.debugOptions ? { debugOptions: opts.debugOptions } : {}),
      ...(opts.uid ? { uid: opts.uid } : {}),
      ...(opts.transport ? { transport: opts.transport } : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.udpDiscoveryMethod
        ? { udpDiscoveryMethod: opts.udpDiscoveryMethod }
        : {}),
      ...(opts.idleDisconnect !== undefined
        ? { idleDisconnect: opts.idleDisconnect }
        : {}),
      ...(opts.idleDisconnectTimeoutMs !== undefined
        ? { idleDisconnectTimeoutMs: opts.idleDisconnectTimeoutMs }
        : {}),
      ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
    };

    // Create the "general" socket in the pool (primary socket for commands/events)
    const generalClient = new BaichuanClient(opts);
    this.attachD2cDiscListener(generalClient);
    this.socketPool.set("general", {
      client: generalClient,
      refCount: 1, // Always keep general socket "in use"
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      idleCloseTimer: undefined,
      generalPermitRelease: undefined,
    });

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
      debugConfig: generalClient.getDebugConfig?.(),
    });

    // Session guard: reboot if too many dedicated sessions are open.
    // Opt-in (see field doc on `sessionGuardEnabled`).
    this.sessionGuardEnabled = opts.enableSessionGuard === true;
    const maxSessions = opts.maxDedicatedSessionsBeforeReboot;
    if (
      typeof maxSessions === "number" &&
      Number.isFinite(maxSessions) &&
      maxSessions > 0
    ) {
      this.maxDedicatedSessionsBeforeReboot = Math.floor(maxSessions);
    }

    // Disconnect storm guard threshold (field only — listener in setupGeneralClientListeners)
    const disconnectThreshold = opts.rebootAfterDisconnectionsPerMinute;
    if (
      typeof disconnectThreshold === "number" &&
      Number.isFinite(disconnectThreshold)
    ) {
      this.rebootAfterDisconnectionsPerMinute = Math.floor(disconnectThreshold);
    }

    // ECONNRESET storm guard threshold (field only — listener in setupGeneralClientListeners)
    const econnresetThreshold = opts.rebootAfterConsecutiveEconnreset;
    if (
      typeof econnresetThreshold === "number" &&
      Number.isFinite(econnresetThreshold)
    ) {
      this.rebootAfterConsecutiveEconnreset = Math.floor(econnresetThreshold);
    }

    // Attach event, push, channelInfo, and guard listeners on the general client.
    // Extracted to a helper so ensureConnected() can re-attach them after reconnecting.
    this.setupGeneralClientListeners();
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

  /**
   * Log active sessions on the device at startup for debugging purposes.
   */
  private async logActiveSessionsOnStartup(): Promise<void> {
    const localSessionCount = this.socketPool.size;
    try {
      const ourIp = this.client.getLocalAddress?.();
      const onlineUsers = await this.getOnlineUserList({ timeoutMs: 5000 });

      // Support both legacy (item) and current (OnlineUser) formats
      // Note: XML parsing may return a single object instead of array when there's only 1 item
      const rawLegacy = onlineUsers.body?.OnlineUserList?.item;
      const rawCurrent = onlineUsers.body?.OnlineUserList?.OnlineUser;
      const legacyItems = Array.isArray(rawLegacy)
        ? rawLegacy
        : rawLegacy
          ? [rawLegacy]
          : [];
      const currentItems = Array.isArray(rawCurrent)
        ? rawCurrent
        : rawCurrent
          ? [rawCurrent]
          : [];

      // Normalize to common format
      const allItems =
        currentItems.length > 0
          ? currentItems.map((u) => ({
              ip: u.ipAddress,
              userName: u.userName,
              level: u.userLevel,
              sessionId: u.sessionId,
            }))
          : legacyItems.map((u) => ({
              ip: u.ip,
              userName: u.userName,
              level: u.level,
              sessionId: undefined as number | undefined,
            }));

      const ourSessions = ourIp
        ? allItems.filter((item) => item.ip === ourIp)
        : allItems;

      // Warn if device reports 0 but we have local sessions
      const deviceReportsZero = allItems.length === 0 && localSessionCount > 0;

      this.logger.log?.(
        `[ReolinkBaichuanApi] Startup session check: ${ourSessions.length} device session(s) from our IP (${ourIp ?? "unknown"}), ${allItems.length} total on device, ${localSessionCount} local${deviceReportsZero ? " [device may not support OnlineUserList]" : ""}`,
        {
          host: this.host,
          ourIp,
          localSessionCount,
          deviceReportsZero,
          ourSessions: ourSessions.map((s) => ({
            user: s.userName,
            ip: s.ip,
            sessionId: s.sessionId,
          })),
          allSessions: allItems.map((s) => ({
            user: s.userName,
            ip: s.ip,
            sessionId: s.sessionId,
          })),
        },
      );
    } catch (e) {
      this.logger.debug?.(
        "[ReolinkBaichuanApi] Could not query sessions at startup",
        e,
      );
    }
  }

  /**
   * Check if too many sessions are open on the device and trigger a reboot if needed.
   * Called when acquiring a new dedicated client.
   * Uses the native Baichuan API to get the actual session count from the device.
   * Only counts sessions from our own IP address.
   */
  private async maybeRebootOnTooManySessions(): Promise<void> {
    // Skip if the socket is not connected (e.g. battery camera after idle disconnect).
    // The timer remains running so it can check again on the next tick, but we must
    // not call getOnlineUserList because that would trigger ensureConnected() and
    // wake the camera unnecessarily.
    if (!this.client.isSocketConnected?.()) return;

    // Skip on BCUDP (battery cameras): the socket stays "connected" at the
    // transport level even when the camera is in deep sleep, so the
    // isSocketConnected guard above doesn't fire. Every getOnlineUserList
    // (cmd_id 120) we send wakes the camera — and because we send it every
    // 60s, the result is a perpetual sleeping↔awake cycle (issue #18).
    //
    // For a single client (the common case for battery cams) the session
    // count is always 1, so the periodic check has no actionable signal.
    // If a multi-session situation arises on UDP it will be diagnosed via
    // explicit `getOnlineUserList()` calls, not by silent periodic polling.
    if (this.client.getTransport?.() === "udp") return;

    // Calculate threshold: use explicit value or default to 10 sessions
    const threshold = this.maxDedicatedSessionsBeforeReboot ?? 10;

    // Already rebooting?
    if (this.sessionGuardRebootInFlight) return;

    // Cooldown: don't reboot more than once every 10 minutes
    const cooldownMs = 10 * 60_000;
    const now = Date.now();
    if (
      this.sessionGuardLastRebootAtMs != null &&
      now - this.sessionGuardLastRebootAtMs < cooldownMs
    ) {
      return;
    }

    // Get our local IP address (the IP the camera sees us as)
    const ourIp = this.client.getLocalAddress?.();

    // Query the device for actual online sessions
    const ourDedicatedSessions = this.socketPool.size;
    let sessionCount: number;
    let sessionItems: unknown[] = [];
    let ourSessionCount = 0;
    let usedLocalFallback = false;
    try {
      const onlineUsers = await this.getOnlineUserList({ timeoutMs: 5000 });

      // Support both legacy (item) and current (OnlineUser) formats
      // Note: XML parsing may return a single object instead of array when there's only 1 item
      const rawLegacy = onlineUsers.body?.OnlineUserList?.item;
      const rawCurrent = onlineUsers.body?.OnlineUserList?.OnlineUser;
      const legacyItems = Array.isArray(rawLegacy)
        ? rawLegacy
        : rawLegacy
          ? [rawLegacy]
          : [];
      const currentItems = Array.isArray(rawCurrent)
        ? rawCurrent
        : rawCurrent
          ? [rawCurrent]
          : [];

      // Normalize to common format: use OnlineUser if available, fallback to item
      const allItems =
        currentItems.length > 0
          ? currentItems.map((u) => ({
              ip: u.ipAddress,
              name: u.userName,
              level: u.userLevel,
              sessionId: u.sessionId,
            }))
          : legacyItems.map((u) => ({
              ip: u.ip,
              name: u.userName,
              level: u.level,
              sessionId: (u as { sessionId?: number }).sessionId,
            }));
      sessionItems = allItems;

      // Log all sessions reported by camera for debugging
      this.logger.debug?.(
        `[ReolinkBaichuanApi] Session guard: camera reports ${allItems.length} sessions, ourIp=${ourIp ?? "unknown"}`,
        {
          ourIp,
          sessions: allItems,
        },
      );

      if (ourIp) {
        // Filter sessions to only count those from our IP
        const ourSessions = allItems.filter((item) => item.ip === ourIp);
        ourSessionCount = ourSessions.length;
        sessionCount = ourSessionCount;

        // Track session changes - detect new sessions appearing
        const currentSessionIds = new Set(
          ourSessions.map((s) => s.sessionId).filter((id) => id != null),
        );
        if (this.lastKnownSessionCount !== undefined) {
          const newIds = [...currentSessionIds].filter(
            (id) => !this.lastKnownSessionIds.has(id),
          );
          const removedIds = [...this.lastKnownSessionIds].filter(
            (id) => !currentSessionIds.has(id),
          );
          if (newIds.length > 0 || removedIds.length > 0) {
            this.logger.log?.(
              `[ReolinkBaichuanApi] Session change detected: ${this.lastKnownSessionCount} -> ${ourSessionCount} sessions`,
              {
                newSessionIds: newIds,
                removedSessionIds: removedIds,
                currentSessions: ourSessions.map((s) => ({
                  id: s.sessionId,
                  ip: s.ip,
                })),
                localDedicatedSessions: Array.from(this.socketPool.keys()),
              },
            );
          }
        }
        this.lastKnownSessionCount = ourSessionCount;
        this.lastKnownSessionIds = currentSessionIds;

        // Log filtered results
        if (allItems.length > 0) {
          this.logger.debug?.(
            `[ReolinkBaichuanApi] Session guard: ${ourSessionCount}/${allItems.length} sessions match ourIp=${ourIp}`,
          );
        }
      } else {
        // Can't determine our IP, use total count
        sessionCount = onlineUsers.body?.OnlineUserList?.itemNum ?? 0;
        ourSessionCount = sessionCount;
      }

      // If device reports 0 sessions but we have local sessions, the device
      // may not support OnlineUserList properly - fall back to local count
      if (sessionCount === 0 && ourDedicatedSessions > 0) {
        sessionCount = ourDedicatedSessions;
        ourSessionCount = ourDedicatedSessions;
        usedLocalFallback = true;
        this.logger.debug?.(
          `[ReolinkBaichuanApi] Session guard: camera reports 0 sessions but we have ${ourDedicatedSessions} local dedicated sessions, using local fallback`,
        );
      }
    } catch (e) {
      // If we can't query the device, fall back to local count
      this.logger.debug?.(
        "[ReolinkBaichuanApi] Session guard: failed to query online users, using local count",
        e,
      );
      sessionCount = this.socketPool.size;
      ourSessionCount = sessionCount;
      usedLocalFallback = true;
    }

    if (sessionCount < threshold) return;

    this.sessionGuardLastRebootAtMs = now;
    const localSessions = Array.from(this.socketPool.keys());
    const thresholdIsDefault = this.maxDedicatedSessionsBeforeReboot == null;
    (this.logger.warn ?? this.logger.log).call(
      this.logger,
      `[ReolinkBaichuanApi] Too many sessions from our IP (${ourIp ?? "unknown"}) on device host=${this.host} (${sessionCount} >= ${threshold}${thresholdIsDefault ? " [default]" : ""}${usedLocalFallback ? " [local fallback]" : ""}); rebooting device`,
      {
        host: this.host,
        ourIp,
        ourSessionCount,
        threshold,
        usedLocalFallback,
        thresholdFormula: thresholdIsDefault ? "default (10)" : "explicit",
        localDedicatedSessions: localSessions,
        allDeviceSessions: sessionItems,
      },
    );

    this.sessionGuardRebootInFlight = this.rebootFromSessionGuard()
      .catch((e) => {
        (this.logger.warn ?? this.logger.error).call(
          this.logger,
          "[ReolinkBaichuanApi] Session guard reboot failed",
          e,
        );
      })
      .finally(() => {
        this.sessionGuardRebootInFlight = undefined;
      });
  }

  private async rebootFromSessionGuard(): Promise<void> {
    // Try Baichuan first, then CGI as fallback
    try {
      await this.reboot();
      return;
    } catch (e) {
      this.logger.debug?.(
        "[ReolinkBaichuanApi] Baichuan reboot failed, trying CGI",
        e,
      );
    }

    try {
      await this.cgiApi.login();
      await this.cgiApi.Reboot();
    } catch (e) {
      throw e instanceof Error
        ? e
        : new Error(String(e ?? "session guard reboot failed"));
    }
  }

  /**
   * Check if there are too many voluntary disconnections and trigger a reboot if needed.
   * Called on every socket close event.
   */
  private async maybeRebootOnDisconnectStorm(): Promise<void> {
    const threshold = this.rebootAfterDisconnectionsPerMinute;
    if (threshold <= 0) return;

    // Check if client is available (may not be during autodetect or early close)
    const entry = this.socketPool.get("general");
    if (!entry) return;

    const info = entry.client.getLastDisconnectInfo?.();
    if (!info?.voluntary) return;

    const now = Date.now();
    const windowMs = 60_000;
    const cutoff = now - windowMs;

    // Remove old entries outside the window
    while (
      this.disconnectStormVoluntaryAtMs.length &&
      this.disconnectStormVoluntaryAtMs[0]! < cutoff
    ) {
      this.disconnectStormVoluntaryAtMs.shift();
    }
    this.disconnectStormVoluntaryAtMs.push(now);

    if (this.disconnectStormVoluntaryAtMs.length < threshold) return;

    // Already rebooting?
    if (this.disconnectStormRebootInFlight) return;

    // Cooldown: don't reboot more than once every 10 minutes
    const cooldownMs = 10 * 60_000;
    if (
      this.disconnectStormLastRebootAtMs != null &&
      now - this.disconnectStormLastRebootAtMs < cooldownMs
    ) {
      return;
    }

    this.disconnectStormLastRebootAtMs = now;
    (this.logger.warn ?? this.logger.log).call(
      this.logger,
      `[ReolinkBaichuanApi] Disconnect storm detected for host=${this.host} (${this.disconnectStormVoluntaryAtMs.length} voluntary disconnects in 60s >= ${threshold}); rebooting device`,
      {
        host: this.host,
        transport: info.transport,
        reason: info.reason,
        voluntaryDisconnectsInWindow: this.disconnectStormVoluntaryAtMs.length,
        threshold,
        windowMs,
        cooldownMs,
      },
    );

    this.disconnectStormRebootInFlight = this.rebootFromSessionGuard()
      .catch((e) => {
        (this.logger.warn ?? this.logger.error).call(
          this.logger,
          "[ReolinkBaichuanApi] Disconnect storm reboot failed",
          e,
        );
      })
      .finally(() => {
        this.disconnectStormRebootInFlight = undefined;
      });
  }

  /**
   * Check if there are too many consecutive ECONNRESET errors and trigger a reboot if needed.
   * This guards against camera saturation where the device refuses all new connections.
   * Called on every socket close event.
   */
  private async maybeRebootOnEconnresetStorm(): Promise<void> {
    const threshold = this.rebootAfterConsecutiveEconnreset;
    if (threshold <= 0) return;

    // Check if client is available (may not be during autodetect or early close)
    const entry = this.socketPool.get("general");
    if (!entry) return;

    const info = entry.client.getLastDisconnectInfo?.();
    const isEconnreset = info?.errorCode === "ECONNRESET";

    if (!isEconnreset) {
      // Not an ECONNRESET - reset the consecutive counter
      this.consecutiveEconnresetCount = 0;
      this.consecutiveEconnresetFirstAtMs = undefined;
      return;
    }

    const now = Date.now();
    const windowMs = 60_000;

    // If this is the first ECONNRESET in a new window, start tracking
    if (this.consecutiveEconnresetFirstAtMs == null) {
      this.consecutiveEconnresetFirstAtMs = now;
    }

    // If the window has expired, reset the counter
    if (now - this.consecutiveEconnresetFirstAtMs > windowMs) {
      this.consecutiveEconnresetCount = 1;
      this.consecutiveEconnresetFirstAtMs = now;
    } else {
      this.consecutiveEconnresetCount++;
    }

    if (this.consecutiveEconnresetCount < threshold) return;

    // Already rebooting?
    if (this.econnresetStormRebootInFlight) return;

    // Cooldown: don't reboot more than once every 10 minutes
    const cooldownMs = 10 * 60_000;
    if (
      this.econnresetStormLastRebootAtMs != null &&
      now - this.econnresetStormLastRebootAtMs < cooldownMs
    ) {
      return;
    }

    this.econnresetStormLastRebootAtMs = now;
    (this.logger.warn ?? this.logger.log).call(
      this.logger,
      `[ReolinkBaichuanApi] ECONNRESET storm detected for host=${this.host} (${this.consecutiveEconnresetCount} consecutive ECONNRESET in 60s >= ${threshold}); rebooting device`,
      {
        host: this.host,
        consecutiveEconnreset: this.consecutiveEconnresetCount,
        threshold,
        windowMs,
        cooldownMs,
      },
    );

    // Reset counter after triggering reboot
    this.consecutiveEconnresetCount = 0;
    this.consecutiveEconnresetFirstAtMs = undefined;

    // Use standard reboot (tries Baichuan first, then CGI as fallback)
    this.econnresetStormRebootInFlight = this.rebootFromSessionGuard()
      .catch((e) => {
        (this.logger.warn ?? this.logger.error).call(
          this.logger,
          "[ReolinkBaichuanApi] ECONNRESET storm reboot failed",
          e,
        );
      })
      .finally(() => {
        this.econnresetStormRebootInFlight = undefined;
      });
  }

  /**
   * Subscribe to minimal high-level events.
   * The API manages Baichuan subscribe/unsubscribe automatically.
   * Includes built-in watchdog: if no events arrive for 5 minutes while
   * the connection is alive, the subscription is automatically renewed.
   */
  async onSimpleEvent(
    callback: (event: ReolinkSimpleEvent) => void | Promise<void>,
  ): Promise<void> {
    this.simpleEventListeners.add(callback);
    this.logger.debug?.(
      `[ReolinkBaichuanApi] onSimpleEvent: registering listener (total=${this.simpleEventListeners.size})`,
    );
    try {
      await this.ensureSimpleEventSubscribed();
      this.logger.debug?.(
        `[ReolinkBaichuanApi] onSimpleEvent: initial subscribe succeeded, simpleEventSubscribed=${this.simpleEventSubscribed}`,
      );
    } catch (e: unknown) {
      // Initial subscription failed — the watchdog will handle auto-recovery.
      // Do NOT propagate: the caller should not see this as a fatal error.
      (this.logger.debug ?? this.logger.log).call(
        this.logger,
        `[ReolinkBaichuanApi] onSimpleEvent: initial subscribe failed, simpleEventSubscribed=${this.simpleEventSubscribed}, watchdog will retry`,
        formatErrorForLog(e),
      );
    }
    this.simpleEventLastReceivedAt = Date.now();
    this.startSimpleEventResubscribeTimer();
    this.startSimpleEventWatchdog();
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
      this.stopSimpleEventWatchdog();
      this.stopUdpSleepInference();
      await this.ensureSimpleEventUnsubscribed();
    } else {
      // If there are still listeners, keep polling running (TCP only).
      // Guard: socket pool may already be destroyed during disconnect cleanup.
      const generalEntry = this.socketPool.get("general");
      if (generalEntry) {
        const isUdp = generalEntry.client.getTransport?.() === "udp";
        if (isUdp) {
          this.startUdpSleepInference();
        } else if (generalEntry.client.isStatePollingEnabled?.()) {
          this.startStatePolling();
        }
      }
    }
  }

  /**
   * Subscribe to per-frame detection events sourced from the BcMedia
   * `additionalHeader` block on active video streams.
   *
   * Mirrors {@link onSimpleEvent} but is fed by the streaming side-channel:
   * one event fires for every I-frame / P-frame that carries an overlay block.
   * Coordinates are reported in normalized [0, 1] fractions of the source
   * frame, so the same box renders correctly on mainStream, subStream, and
   * externStream.
   *
   * Unlike `onSimpleEvent`, no Baichuan subscribe command is involved — events
   * only flow while a video stream is open. The library hooks every
   * `BaichuanVideoStream` created via this API for the listener's lifetime.
   */
  onDetection(
    callback: (event: ReolinkDetectionEvent) => void | Promise<void>,
  ): void {
    this.detectionEventListeners.add(callback);
  }

  /**
   * Remove a single detection callback, or all of them if `callback` is omitted.
   */
  offDetection(
    callback?: (event: ReolinkDetectionEvent) => void | Promise<void>,
  ): void {
    if (callback) {
      this.detectionEventListeners.delete(callback);
    } else {
      this.detectionEventListeners.clear();
    }
  }

  /**
   * Subscribe to AI object detections (people / vehicle / animal / face boxes
   * with class label and confidence) without managing a video stream yourself.
   *
   * Mirrors {@link onSimpleEvent} end-to-end: on the first listener for a given
   * `(channel, profile)` tuple the API ensures the corresponding video stream
   * is running (the pool socket may already be shared with a regular consumer),
   * forwards every box-bearing `additionalHeader` to your callback, and tears
   * the stream down when the last listener for that tuple unsubscribes.
   *
   * Defaults — `channel: 0`, `profile: "sub"` — match a single-lens standalone
   * camera. **For NVR/Hub child cameras you must pass the channel explicitly**,
   * otherwise the substream opens on channel 0 and never sees the AI boxes for
   * the other channels. The `sub` profile is recommended (lighter bandwidth)
   * but `main` / `ext` are accepted if you specifically need detections off a
   * different feed.
   *
   * Each event carries normalized `[0, 1]` box coordinates, a class label, and
   * a confidence score — render-ready without further conversion.
   */
  async onObjectDetections(
    callback: (event: ReolinkDetectionEvent) => void | Promise<void>,
    options?: { channel?: number; profile?: "main" | "sub" | "ext" },
  ): Promise<void> {
    const channel = options?.channel ?? 0;
    const profile = options?.profile ?? "sub";
    const key = this.objectDetectionKey(channel, profile);
    let entry = this.objectDetectionSubs.get(key);
    if (!entry) {
      entry = { channel, profile, listeners: new Set() };
      this.objectDetectionSubs.set(key, entry);
    }
    entry.listeners.add(callback);
    this.logger.debug?.(
      `[ReolinkBaichuanApi] onObjectDetections: registering listener for ch${channel}/${profile} (total=${entry.listeners.size})`,
    );
    await this.ensureObjectDetectionStream(key);
  }

  /**
   * Remove a detection callback for a given `(channel, profile)` tuple — or,
   * if `options` is omitted, remove the callback from every active tuple. When
   * `callback` is also omitted, every listener on the targeted tuples is
   * cleared. The auto-managed substream of a tuple is closed when its last
   * listener is removed.
   */
  async offObjectDetections(
    callback?: (event: ReolinkDetectionEvent) => void | Promise<void>,
    options?: { channel?: number; profile?: "main" | "sub" | "ext" },
  ): Promise<void> {
    const targetKeys: string[] = options
      ? [
          this.objectDetectionKey(
            options.channel ?? 0,
            options.profile ?? "sub",
          ),
        ]
      : [...this.objectDetectionSubs.keys()];

    for (const key of targetKeys) {
      const entry = this.objectDetectionSubs.get(key);
      if (!entry) continue;
      if (callback) {
        entry.listeners.delete(callback);
      } else {
        entry.listeners.clear();
      }
      if (entry.listeners.size === 0) {
        await this.tearDownObjectDetectionStream(key);
      }
    }
  }

  private objectDetectionKey(
    channel: number,
    profile: "main" | "sub" | "ext",
  ): string {
    return `${channel}:${profile}`;
  }

  private ensureObjectDetectionInternalListener(): void {
    if (this.objectDetectionInternalListener) return;
    const internal = (event: ReolinkDetectionEvent): void => {
      const key = this.objectDetectionKey(event.channel, event.profile);
      const entry = this.objectDetectionSubs.get(key);
      if (!entry || entry.listeners.size === 0) return;
      for (const cb of entry.listeners) {
        try {
          void Promise.resolve(cb(event)).catch((e: unknown) => {
            (this.logger.warn ?? this.logger.error).call(
              this.logger,
              "[ReolinkBaichuanApi] onObjectDetections handler error",
              formatErrorForLog(e),
            );
          });
        } catch (e) {
          (this.logger.warn ?? this.logger.error).call(
            this.logger,
            "[ReolinkBaichuanApi] onObjectDetections handler error",
            formatErrorForLog(e),
          );
        }
      }
    };
    this.objectDetectionInternalListener = internal;
    this.detectionEventListeners.add(internal);
  }

  private maybeDropObjectDetectionInternalListener(): void {
    if (this.objectDetectionSubs.size > 0) return;
    if (!this.objectDetectionInternalListener) return;
    this.detectionEventListeners.delete(this.objectDetectionInternalListener);
    this.objectDetectionInternalListener = undefined;
  }

  private async ensureObjectDetectionStream(key: string): Promise<void> {
    const entry = this.objectDetectionSubs.get(key);
    if (!entry) return;
    if (entry.stream) return;
    if (entry.startInFlight) {
      await entry.startInFlight;
      return;
    }
    entry.startInFlight = (async () => {
      // Lazy require to avoid a circular import at module load time.
      const { BaichuanVideoStream } = await import(
        "../../baichuan/stream/BaichuanVideoStream"
      );
      const sessionKey = `live:object-detections:ch${entry.channel}:${entry.profile}`;
      const dedicated = await this.createDedicatedSession(sessionKey);
      const stream = new BaichuanVideoStream({
        client: dedicated.client,
        api: this,
        channel: entry.channel,
        profile: entry.profile,
        logger: this.logger,
      });
      this.ensureObjectDetectionInternalListener();
      try {
        await stream.start();
      } catch (e) {
        await dedicated.release().catch(() => {});
        this.maybeDropObjectDetectionInternalListener();
        throw e;
      }
      entry.stream = {
        stop: () => stream.stop(),
        release: () => dedicated.release(),
      };
      this.logger.debug?.(
        `[ReolinkBaichuanApi] onObjectDetections: substream started (key=${sessionKey})`,
      );
    })();
    try {
      await entry.startInFlight;
    } finally {
      delete entry.startInFlight;
    }
  }

  private async tearDownObjectDetectionStream(key: string): Promise<void> {
    const entry = this.objectDetectionSubs.get(key);
    if (!entry) return;
    const handle = entry.stream;
    delete entry.stream;
    this.objectDetectionSubs.delete(key);
    if (handle) {
      try {
        await handle.stop();
      } catch (e) {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] onObjectDetections: stream stop error (key=${key}): ${formatErrorForLog(e)}`,
        );
      }
      try {
        await handle.release();
      } catch (e) {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] onObjectDetections: session release error (key=${key}): ${formatErrorForLog(e)}`,
        );
      }
    }
    this.maybeDropObjectDetectionInternalListener();
    this.logger.debug?.(
      `[ReolinkBaichuanApi] onObjectDetections: substream torn down (key=${key})`,
    );
  }

  /**
   * Internal: invoked by BaichuanVideoStream when it starts so the API can hook
   * its `additionalHeader` event. Returns a teardown function the stream calls
   * on stop. Not intended for direct use by consumers.
   */
  _registerVideoStreamForDetection(stream: {
    on: (event: "additionalHeader", listener: (info: {
      raw: Buffer;
      frameType: "Iframe" | "Pframe";
      videoType: "H264" | "H265";
      microseconds: number;
      frameWidth?: number;
      frameHeight?: number;
    }) => void) => void;
    off: (event: "additionalHeader", listener: (info: {
      raw: Buffer;
      frameType: "Iframe" | "Pframe";
      videoType: "H264" | "H265";
      microseconds: number;
      frameWidth?: number;
      frameHeight?: number;
    }) => void) => void;
  }, context: { channel: number; profile: "main" | "sub" | "ext" }): () => void {
    const listener = (info: {
      raw: Buffer;
      frameType: "Iframe" | "Pframe";
      videoType: "H264" | "H265";
      microseconds: number;
      frameWidth?: number;
      frameHeight?: number;
    }): void => {
      if (this.detectionEventListeners.size === 0) return;
      const decoded = decodeDetectionHeader(info.raw, info.frameType);
      const event: ReolinkDetectionEvent = {
        channel: context.channel,
        microseconds: info.microseconds,
        profile: context.profile,
        boxes: decoded.boxes,
        ...(info.frameWidth !== undefined ? { frameWidth: info.frameWidth } : {}),
        ...(info.frameHeight !== undefined ? { frameHeight: info.frameHeight } : {}),
        decodeState: decoded.state,
        rawHeader: info.raw,
      };
      this.dispatchDetectionEvent(event);
    };
    stream.on("additionalHeader", listener);
    const teardown = (): void => {
      stream.off("additionalHeader", listener);
      this.detectionEventStreamHooks.delete(stream);
    };
    this.detectionEventStreamHooks.set(stream, teardown);
    return teardown;
  }

  private dispatchDetectionEvent(evt: ReolinkDetectionEvent): void {
    for (const cb of this.detectionEventListeners) {
      try {
        void Promise.resolve(cb(evt)).catch((e: unknown) => {
          (this.logger.warn ?? this.logger.error).call(
            this.logger,
            "[ReolinkBaichuanApi] onDetection handler error",
            formatErrorForLog(e),
          );
        });
      } catch (e) {
        (this.logger.warn ?? this.logger.error).call(
          this.logger,
          "[ReolinkBaichuanApi] onDetection handler error",
          formatErrorForLog(e),
        );
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

  /**
   * Event watchdog: monitors whether events are flowing and auto-recovers if they stop.
   *
   * Handles two failure modes:
   * 1. Subscription flag is true but no events arrive for 5+ minutes (device dropped subscription silently)
   * 2. Subscription flag is false because initial/retry subscribe failed, but connection is now alive
   *
   * Uses exponential backoff (30s → 60s → 120s → 240s → max 5min) to avoid hammering the device.
   */
  private startSimpleEventWatchdog(): void {
    if (this.simpleEventWatchdogTimer) return;
    if (this.simpleEventListeners.size === 0) return;

    this.simpleEventWatchdogTimer = setInterval(() => {
      void this.simpleEventWatchdogTick();
    }, this.simpleEventWatchdogIntervalMs);
  }

  private stopSimpleEventWatchdog(): void {
    if (!this.simpleEventWatchdogTimer) return;
    clearInterval(this.simpleEventWatchdogTimer);
    this.simpleEventWatchdogTimer = undefined;
    this.simpleEventWatchdogRecoveryAttempts = 0;
    this.simpleEventWatchdogLastRecoveryAt = 0;
    this.simpleEventLastReceivedAt = 0;
  }

  private async simpleEventWatchdogTick(): Promise<void> {
    // No listeners → nothing to watch
    if (this.simpleEventListeners.size === 0) return;

    // Guard: socket pool may already be destroyed during disconnect cleanup
    const generalEntry = this.socketPool.get("general");
    if (!generalEntry) return;

    // Connection must be alive for recovery to work
    if (!generalEntry.client.isSocketConnected?.() || !generalEntry.client.loggedIn) {
      this.logger.debug?.(
        `[ReolinkBaichuanApi] event watchdog tick: skipping (connection not alive: connected=${generalEntry.client.isSocketConnected?.()} loggedIn=${generalEntry.client.loggedIn})`,
      );
      return;
    }

    const now = Date.now();
    const sinceLastEvent = this.simpleEventLastReceivedAt > 0 ? now - this.simpleEventLastReceivedAt : -1;
    this.logger.debug?.(
      `[ReolinkBaichuanApi] event watchdog tick: subscribed=${this.simpleEventSubscribed} ` +
        `clientSubscribed=${generalEntry.client.subscribed} ` +
        `lastEventAgoMs=${sinceLastEvent} recoveryAttempts=${this.simpleEventWatchdogRecoveryAttempts} ` +
        `listeners=${this.simpleEventListeners.size}`,
    );

    // Case 1: subscription is active but no events for too long → force resubscribe
    if (this.simpleEventSubscribed && this.simpleEventLastReceivedAt > 0) {
      const silence = now - this.simpleEventLastReceivedAt;
      if (silence < this.simpleEventWatchdogSilenceThresholdMs) return; // events flowing normally

      // Events stopped flowing → force resubscribe
      (this.logger.warn ?? this.logger.log).call(
        this.logger,
        `[ReolinkBaichuanApi] event watchdog: no events for ${Math.round(silence / 60_000)} min, forcing resubscribe`,
        { host: this.host, silenceMs: silence },
      );

      try {
        // Force the flag false so ensureSimpleEventSubscribed will actually resend
        this.simpleEventSubscribed = false;
        generalEntry.client.subscribed = false;
        await this.ensureSimpleEventSubscribed();
        this.simpleEventLastReceivedAt = Date.now(); // reset timer after resubscribe
        this.simpleEventWatchdogRecoveryAttempts = 0;
        (this.logger.info ?? this.logger.log).call(
          this.logger,
          `[ReolinkBaichuanApi] event watchdog: resubscribed successfully after silence`,
        );
      } catch (e: unknown) {
        (this.logger.debug ?? this.logger.log).call(
          this.logger,
          `[ReolinkBaichuanApi] event watchdog: resubscribe after silence failed`,
          formatErrorForLog(e),
        );
      }
      return;
    }

    // Case 2: subscription failed (simpleEventSubscribed === false) but connection is alive → recovery
    if (!this.simpleEventSubscribed) {
      // If events are actually flowing (e.g. the device pushes events even without
      // a successful subscribe handshake), treat the subscription as healthy.
      // This prevents an infinite recovery loop when subscribeEvents() keeps failing
      // but events are delivered regardless (some firmware variants do this).
      if (this.simpleEventLastReceivedAt > 0) {
        const sinceLastEvent = now - this.simpleEventLastReceivedAt;
        if (sinceLastEvent < this.simpleEventWatchdogSilenceThresholdMs) {
          // Events are flowing — mark subscription as active and stop retrying.
          this.simpleEventSubscribed = true;
          this.logger.debug?.(
            `[ReolinkBaichuanApi] event watchdog: events flowing (lastEventAgo=${Math.round(sinceLastEvent / 1000)}s) ` +
              `despite simpleEventSubscribed=false, marking subscription as active ` +
              `(recoveryAttempts=${this.simpleEventWatchdogRecoveryAttempts})`,
          );
          if (this.simpleEventWatchdogRecoveryAttempts > 0) {
            (this.logger.info ?? this.logger.log).call(
              this.logger,
              `[ReolinkBaichuanApi] event watchdog: events flowing despite failed subscribe, marking subscription active`,
            );
            this.simpleEventWatchdogRecoveryAttempts = 0;
          }
          return;
        } else {
          this.logger.debug?.(
            `[ReolinkBaichuanApi] event watchdog: events stale (lastEventAgo=${Math.round(sinceLastEvent / 1000)}s, threshold=${Math.round(this.simpleEventWatchdogSilenceThresholdMs / 1000)}s), proceeding with recovery`,
          );
        }
      } else {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] event watchdog: no events ever received (simpleEventLastReceivedAt=0), proceeding with recovery`,
        );
      }

      // Exponential backoff: 30s, 60s, 120s, 240s, max 5min
      const backoffMs = Math.min(
        30_000 * Math.pow(2, this.simpleEventWatchdogRecoveryAttempts),
        this.simpleEventWatchdogSilenceThresholdMs,
      );
      if (now - this.simpleEventWatchdogLastRecoveryAt < backoffMs) return;

      this.simpleEventWatchdogRecoveryAttempts++;
      this.simpleEventWatchdogLastRecoveryAt = now;

      const nextBackoff = Math.min(
        30_000 * Math.pow(2, this.simpleEventWatchdogRecoveryAttempts),
        this.simpleEventWatchdogSilenceThresholdMs,
      );
      (this.logger.info ?? this.logger.log).call(
        this.logger,
        `[ReolinkBaichuanApi] event watchdog: subscription inactive, attempting auto-recovery ` +
          `(attempt #${this.simpleEventWatchdogRecoveryAttempts}, next backoff ${Math.round(nextBackoff / 1000)}s)`,
        { host: this.host },
      );

      try {
        await this.ensureSimpleEventSubscribed();
        if (this.simpleEventSubscribed) {
          this.simpleEventLastReceivedAt = Date.now();
          (this.logger.info ?? this.logger.log).call(
            this.logger,
            `[ReolinkBaichuanApi] event watchdog: auto-recovery successful after ` +
              `${this.simpleEventWatchdogRecoveryAttempts} attempt(s)`,
          );
          this.simpleEventWatchdogRecoveryAttempts = 0;
        }
      } catch (e: unknown) {
        (this.logger.debug ?? this.logger.log).call(
          this.logger,
          `[ReolinkBaichuanApi] event watchdog: recovery attempt #${this.simpleEventWatchdogRecoveryAttempts} failed`,
          formatErrorForLog(e),
        );
      }
    }
  }

  private async renewSimpleEventSubscription(): Promise<void> {
    if (this.simpleEventListeners.size === 0) return;
    // Skip if disconnected (e.g. battery camera idle disconnect) — don't force a reconnect.
    if (!this.client.isSocketConnected?.()) return;
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
    if (this.simpleEventListeners.size === 0) {
      this.logger.debug?.(
        `[ReolinkBaichuanApi] ensureSimpleEventSubscribed: no listeners, skipping`,
      );
      return;
    }
    if (this.simpleEventSubscribed) {
      this.logger.debug?.(
        `[ReolinkBaichuanApi] ensureSimpleEventSubscribed: already subscribed, skipping`,
      );
      return;
    }
    if (this.simpleEventSubscribeInFlight) {
      this.logger.debug?.(
        `[ReolinkBaichuanApi] ensureSimpleEventSubscribed: subscribe already in-flight, awaiting`,
      );
      return await this.simpleEventSubscribeInFlight;
    }

    this.logger.debug?.(
      `[ReolinkBaichuanApi] ensureSimpleEventSubscribed: starting subscribe (clientSubscribed=${this.socketPool.get("general")?.client.subscribed})`,
    );

    this.simpleEventSubscribeInFlight = (async () => {
      // Guard: if socket pool is destroyed, bail out.
      const entry = this.socketPool.get("general");
      if (!entry) {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] ensureSimpleEventSubscribed: no general socket, bailing out`,
        );
        return;
      }

      // If the caller already subscribed (e.g. NVR shared connection using subscribeToAllEvents),
      // don't resubscribe.
      if (!entry.client.subscribed) {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] ensureSimpleEventSubscribed: client.subscribed=false, calling subscribeEvents()`,
        );
        await this.subscribeEvents();
      } else {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] ensureSimpleEventSubscribed: client already subscribed, skipping subscribeEvents()`,
        );
      }
      this.simpleEventSubscribed = true;

      // Only check current state and start polling for TCP connections (not UDP/battery cameras)
      // UDP/battery cameras should rely on event pushes only, not polling
      const isUdp = entry.client.getTransport?.() === "udp";
      if (isUdp) {
        // Passive sleep inference for UDP/battery cameras.
        // This does not send any requests and restores sleeping/awake events.
        this.startUdpSleepInference();
      } else if (entry.client.isStatePollingEnabled?.()) {
        const channel = entry.client.getConfiguredChannel?.() ?? 0;
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
    // Guard: if the socket pool has already been destroyed (e.g. api.close()
    // was called during disconnect cleanup), just reset local state and bail.
    const generalEntry = this.socketPool.get("general");
    if (!generalEntry) {
      this.simpleEventSubscribed = false;
      this.stopSimpleEventResubscribeTimer();
      this.stopStatePolling();
      this.stopUdpSleepInference();
      return;
    }

    if (!this.simpleEventSubscribed && !generalEntry.client.subscribed) return;
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
   * 1. Cached value from setIsNvr()
   * 2. Channel count > 3 (typical NVR detection)
   * 3. Device model matches NVR/Hub patterns (for devices like Home Hub that report channelNum=1)
   */
  async isNvrDevice(): Promise<boolean> {
    // Return cached value if available
    if (this._isNvr !== undefined) {
      return this._isNvr;
    }

    const channelCount = await this.getChannelCount();
    if (channelCount > 3) {
      this._isNvr = true;
      return true;
    }

    // Fallback: check device type for NVR/Hub patterns
    // Some devices (e.g., Home Hub) report channelNum=1 but are actually NVR/Hub
    try {
      const info = await this.getInfo(undefined, {
        tags: ["type"],
        timeoutMs: 5000,
      });
      if (isNvrHubModel(info.type)) {
        this.logger.debug?.(
          `[ReolinkBaichuanApi] isNvrDevice: type="${info.type}" matches NVR/Hub pattern`,
        );
        this._isNvr = true;
        return true;
      }
    } catch {
      // Ignore errors - model check is best-effort
    }

    this._isNvr = false;
    return false;
  }

  /**
   * Set the NVR/Hub flag explicitly.
   * Call this early (before streaming) to ensure correct socket pooling.
   * @param isNvr - true if this is an NVR/Hub, false for standalone camera
   */
  setIsNvr(isNvr: boolean): void {
    this._isNvr = isNvr;
    this.logger.debug?.(`[ReolinkBaichuanApi] setIsNvr: ${isNvr}`);
  }

  /**
   * Set the multi-focal flag explicitly.
   * Call this early (before streaming) to ensure correct socket pooling.
   * Multi-focal cameras (TrackMix, TrackFlex, Duo, etc.) reject concurrent
   * streaming TCP connections, so all channels must share a single streaming socket.
   * @param isMultiFocal - true if this is a dual-lens/multi-focal camera
   */
  setIsMultiFocal(isMultiFocal: boolean): void {
    this._isMultiFocal = isMultiFocal;
    this.logger.debug?.(`[ReolinkBaichuanApi] setIsMultiFocal: ${isMultiFocal}`);
  }

  /**
   * Enable or disable idle disconnect dynamically.
   *
   * This is useful when the battery status is discovered after connection
   * (e.g., during autodetect). Call with `true` for battery cameras to
   * preserve battery life by disconnecting when idle.
   *
   * @param enabled - true to enable idle disconnect, false to disable
   */
  setIdleDisconnect(enabled: boolean): void {
    this.client.setIdleDisconnect(enabled);
    this.logger.debug?.(`[ReolinkBaichuanApi] setIdleDisconnect: ${enabled}`);
  }

  async login(
    maxEncryption?: import("../../client/BaichuanClient.js").MaxEncryption,
  ): Promise<void> {
    await this.client.login(maxEncryption);
  }

  /**
   * Stop all active video streams on the main API client.
   * Called automatically during close() to ensure clean session termination.
   */
  async stopAllActiveStreams(): Promise<void> {
    const activeStreams = Array.from(this.activeVideoMsgNums.keys());
    if (activeStreams.length === 0) {
      return;
    }

    this.logger?.debug?.(
      `[ReolinkBaichuanApi] Stopping ${activeStreams.length} active stream(s) before close`,
    );

    // Parse keys (format: "channel:profile:variant") and stop each stream
    await Promise.allSettled(
      activeStreams.map(async (key) => {
        const [ch, profile, variant] = key.split(":");
        try {
          await this.stopVideoStream(Number(ch), profile as StreamProfile, {
            variant: variant as NativeVideoStreamVariant,
          });
        } catch (e) {
          // Ignore errors - we're shutting down anyway
          this.logger?.debug?.(
            `[ReolinkBaichuanApi] Error stopping stream ${key}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
  }

  async close(options?: { reason?: string }): Promise<void> {
    // Guard against double-close: once the pool is cleared, a second call
    // would crash on this.client accesses inside stopAllActiveStreams, etc.
    if (this._closed) return;
    this._closed = true;

    // Stop periodic session guard
    if (this.sessionGuardIntervalTimer) {
      clearInterval(this.sessionGuardIntervalTimer);
      this.sessionGuardIntervalTimer = undefined;
    }
    // Stop state polling before closing
    this.stopStatePolling();
    this.stopUdpSleepInference();
    // Stop event watchdog and resubscribe timer
    this.stopSimpleEventWatchdog();
    this.stopSimpleEventResubscribeTimer();
    // Tear down every auto-managed object-detection substream, if any.
    for (const key of [...this.objectDetectionSubs.keys()]) {
      await this.tearDownObjectDetectionStream(key).catch(() => {});
    }
    // Stop all RTSP servers before closing the client
    await this.cleanup();
    // Stop all active video streams on the main client before logout/close
    await this.stopAllActiveStreams();
    // Cleanup all sockets in the pool (including "general")
    await this.cleanupSocketPool();
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
    // - Motion alarm commands (46/47) can fail on some cameras; avoid retry loops.
    // In both cases, fail fast and let higher-level code fall back to findAlarmVideo/CGI.
    return (
      bodyLen === 0 &&
      (params.cmdId === BC_CMD_ID_FILE_INFO_LIST_GET ||
        params.cmdId === BC_CMD_ID_FILE_INFO_LIST_OPEN ||
        // Non-PTZ cameras commonly return 400+empty body for PTZ preset APIs.
        // Treat it as "unsupported" rather than triggering relogin loops.
        params.cmdId === BC_CMD_ID_GET_PTZ_PRESET ||
        // Motion alarm commands may fail on some cameras/firmwares.
        // Fail fast to avoid re-login loops.
        params.cmdId === BC_CMD_ID_GET_MOTION_ALARM ||
        params.cmdId === BC_CMD_ID_SET_MOTION_ALARM)
    );
  }

  private async handleSendXml400(
    params: Parameters<BaichuanClient["sendXml"]>[0],
    frame: Awaited<ReturnType<BaichuanClient["sendFrame"]>>,
    retry: number,
  ): Promise<string> {
    const emptyBody = frame.body.length === 0;
    const emptyBody400Msg =
      "Baichuan request failed (responseCode 400, empty body). Possible causes: expired session, invalid username/password, or unsupported command on NVR/Hub.";
    // const emptyBody400Msg =
    //   "Baichuan request failed (responseCode 400, empty body). Possible causes: camera sleeping/waking (battery), expired session, invalid username/password, or unsupported command on NVR/Hub.";

    if (this.isSendXmlFailFast400(params, frame.body.length)) {
      throw new Error(emptyBody400Msg);
    }

    // Retry logic for 400 errors (without re-login to avoid disconnection loops).
    // NOTE: several firmwares return responseCode=400 with empty body when the camera is sleeping,
    // waking up, or when the session has expired (not only for bad credentials).
    // Previously we tried forcing re-login here, but that caused cascading disconnects.
    // Now we simply backoff and retry without re-login.
    if (retry > 0) {
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

  /**
   * Create a dedicated talk session with its own isolated socket connection.
   * This is the recommended way to use intercom - the library manages the socket lifecycle.
   *
   * The dedicated socket is automatically closed when:
   * 1. `stop()` is called on the returned session
   * 2. The idle timeout expires (no audio sent for `idleTimeoutMs`)
   * 3. The API is closed via `close()`
   *
   * @param channel - Channel number (usually 0)
   * @param options - Configuration options (blocksPerPayload, idleTimeoutMs, deviceId, logger)
   *
   * @example
   * ```typescript
   * const session = await api.createDedicatedTalkSession(0, {
   *   blocksPerPayload: 2,
   *   idleTimeoutMs: 30000,
   *   deviceId: 'camera-123',
   * });
   * try {
   *   await session.sendAudio(adpcmBuffer);
   * } finally {
   *   await session.stop();
   * }
   * ```
   */
  async createDedicatedTalkSession(
    channel = 0,
    options?: {
      blocksPerPayload?: number;
      /** Auto-teardown if no audio sent for this duration (default 30000ms). Set to 0 to disable. */
      idleTimeoutMs?: number;
      /** Optional device identifier for logging/tracking */
      deviceId?: string;
      /** Optional logger for debug output */
      logger?: Logger;
    },
  ): Promise<TalkSession> {
    const logger = options?.logger ?? this.logger;
    const idleTimeoutMs = options?.idleTimeoutMs ?? 30000;
    const deviceId = options?.deviceId ?? "unknown";

    // Create a unique session key for this talk session
    const sessionKey = `talk:${deviceId}:ch${channel}:${Date.now()}`;

    logger?.info?.(
      `[DedicatedTalk] Creating session: ${sessionKey} (idleTimeout=${idleTimeoutMs}ms)`,
    );

    // Create dedicated socket session via the socket pool
    const tag = this.resolveSocketTag(sessionKey);
    const { client: dedicatedClient, release } = await this.acquirePooledSocket(
      tag,
      logger,
    );

    // Log sessions summary
    const summary = this.getSocketPoolSummary();
    logger?.info?.(
      `[DedicatedTalk] Session created [sessions: ${summary.count} active${summary.count > 0 ? ` (${summary.tags.join(", ")})` : ""}]`,
    );

    try {
      // BCUDP/battery firmwares often expect 0-based header channelId.
      const isUdp = dedicatedClient.getTransport?.() === "udp";
      const channelIdOverride = isUdp ? channel : undefined;

      // Get talk ability and build session info
      const ability = await this.getTalkAbilityWithClient(
        dedicatedClient,
        channel,
      );
      const { payloadXml, info } = buildTalkSessionInfoFromAbility({
        channel,
        ability,
      });

      // Send talk config
      await sendTalkConfigWithReset({
        client: dedicatedClient,
        channel,
        payloadXml,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
      });

      // Create the underlying talk session
      const innerSession = createBufferedTalkSession({
        client: dedicatedClient,
        channel,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
        info,
        ...(options?.blocksPerPayload != null
          ? { blocksPerPayload: options.blocksPerPayload }
          : {}),
        // Don't close socket on inner stop - we manage it here
        closeSocketOnStop: false,
      });

      // Idle timeout tracking
      let idleTimer: NodeJS.Timeout | undefined;
      let stopped = false;

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleTimeoutMs > 0 && !stopped) {
          idleTimer = setTimeout(async () => {
            if (!stopped) {
              logger?.info?.(
                `[DedicatedTalk] Idle timeout (${idleTimeoutMs}ms), stopping session: ${sessionKey}`,
              );
              await wrappedStop();
            }
          }, idleTimeoutMs);
        }
      };

      const wrappedStop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;

        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }

        try {
          await innerSession.stop();
        } catch (e) {
          logger?.debug?.(`[DedicatedTalk] Error stopping inner session: ${e}`);
        }

        // Release the dedicated socket
        try {
          await release();
          const summary = this.getDedicatedSessionsSummary();
          logger?.info?.(
            `[DedicatedTalk] Session released: ${sessionKey} [sessions: ${summary.count} active${summary.count > 0 ? ` (${summary.keys.join(", ")})` : ""}]`,
          );
        } catch (e) {
          logger?.debug?.(`[DedicatedTalk] Error releasing session: ${e}`);
        }
      };

      // Start idle timer
      resetIdleTimer();

      return {
        info: innerSession.info,
        sendAudio: async (adpcm: Buffer) => {
          if (stopped) throw new Error("Talk session is closed");
          resetIdleTimer();
          return await innerSession.sendAudio(adpcm);
        },
        stop: wrappedStop,
      };
    } catch (e) {
      // If setup fails, release the dedicated socket
      try {
        await release();
      } catch {
        // ignore
      }
      throw e;
    }
  }

  /**
   * Get talk ability using a specific client (for dedicated sessions).
   * @internal
   */
  private async getTalkAbilityWithClient(
    client: BaichuanClient,
    channel: number,
  ): Promise<TalkAbility> {
    const frame = await client.sendFrame({
      cmdId: BC_CMD_ID_TALK_ABILITY,
      channel,
      payloadXml: "",
      messageClass: BC_CLASS_MODERN_24,
    });
    // Decrypt and parse the XML response
    const xml =
      frame.body.length === 0
        ? ""
        : client.tryDecryptXml(frame.body, frame.header.channelId, client.enc);
    return parseTalkAbilityXml(xml);
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

  /**
   * Full port-config setter (cmd_id 36). Patches one or more of the six
   * service ports the camera serves — Server (Baichuan), HTTP, HTTPS,
   * RTSP, RTMP, ONVIF. Each entry takes an optional `port` (number) and
   * `enable` (boolean); fields the caller doesn't pass are left alone.
   *
   * Sends one block per port that has any field set, then issues a
   * single cmd_36 with the merged body. The camera accepts multiple
   * `<XxxPort>` siblings in the same payload.
   *
   * Wire format observed on E1 Zoom:
   *
   *   <body>
   *     <RtspPort version="1.1">
   *       <rtspPort>554</rtspPort>
   *       <enable>1</enable>
   *     </RtspPort>
   *     <HttpsPort version="1.1">
   *       <enable>0</enable>
   *     </HttpsPort>
   *     ...
   *   </body>
   */
  async setPortConfig(patch: {
    server?: { port?: number; enable?: boolean };
    http?: { port?: number; enable?: boolean };
    https?: { port?: number; enable?: boolean };
    rtsp?: { port?: number; enable?: boolean };
    rtmp?: { port?: number; enable?: boolean };
    onvif?: { port?: number; enable?: boolean };
  }): Promise<void> {
    const blocks: string[] = [];
    const append = (
      tag: string,
      portField: string,
      cfg: { port?: number; enable?: boolean } | undefined,
    ): void => {
      if (!cfg) return;
      if (cfg.port === undefined && cfg.enable === undefined) return;
      const inner: string[] = [];
      if (cfg.port !== undefined) {
        inner.push(`<${portField}>${cfg.port}</${portField}>`);
      }
      if (cfg.enable !== undefined) {
        inner.push(`<enable>${cfg.enable ? 1 : 0}</enable>`);
      }
      blocks.push(`<${tag} version="1.1">${inner.join("")}</${tag}>`);
    };
    append("ServerPort", "serverPort", patch.server);
    append("HttpPort", "httpPort", patch.http);
    append("HttpsPort", "httpsPort", patch.https);
    append("RtspPort", "rtspPort", patch.rtsp);
    append("RtmpPort", "rtmpPort", patch.rtmp);
    append("OnvifPort", "onvifPort", patch.onvif);
    if (blocks.length === 0) return;
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>${blocks.join("")}</body>`;
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
   *
   * @param options.source - Data source for the channel list (default: `"cgi"`):
   *   - `"cgi"`: Uses HTTP `GetChannelstatus` — returns the channel list immediately,
   *     no dependency on async push messages. Recommended for first-call discovery.
   *   - `"baichuan"`: Uses the cmd_id 145 push cache populated when the NVR sends channel
   *     info after login + event subscription. This push is *asynchronous*: if it has not
   *     arrived yet, the result will have zero channels. Callers must retry (nvr.ts does this
   *     with a 1-second loop). Note: explicitly requesting cmd_id 145 is not supported.
   */
  async getNvrChannelsSummary(options?: {
    channels?: number[];
    timeoutMs?: number;
    source?: "cgi" | "baichuan";
  }): Promise<NvrChannelsSummaryCacheEntry> {
    const source = options?.source ?? "cgi";

    // ── Resolve channel list ─────────────────────────────────────────────────
    let channels: number[];
    // cgiStatusByChannel carries name/uid/sleep from GetChannelstatus for CGI path
    const cgiStatusByChannel = new Map<number, { name?: string; uid?: string; sleeping?: boolean }>();

    if (options?.channels?.length) {
      channels = options.channels.map((c) => Number(c)).filter((n) => Number.isFinite(n));
    } else if (source === "cgi") {
      try {
        const { channels: cgiChannels, channelsResponse } = await this.cgiApi.getChannels();
        const status = channelsResponse?.[0]?.value?.status ?? [];
        for (const s of status) {
          const ch = Number(s?.channel);
          if (!Number.isFinite(ch)) continue;
          cgiStatusByChannel.set(ch, {
            ...(s.name != null ? { name: s.name } : {}),
            ...(s.uid != null ? { uid: s.uid } : {}),
            sleeping: s.sleep === 1,
          });
        }
        channels = cgiChannels;
        this.logger.debug?.(
          `[ReolinkBaichuanApi] getNvrChannelsSummary: CGI found ${channels.length} channel(s): [${channels.join(", ")}]`,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn?.(
          `[ReolinkBaichuanApi] getNvrChannelsSummary: CGI GetChannelstatus failed (${msg}), returning empty`,
        );
        channels = [];
      }
    } else {
      // baichuan: derive channels from cmd_id 145 push cache
      const pushInfo = this.getChannelInfoFromPushCache();
      channels = Array.from(pushInfo.keys()).map((c) => Number(c)).filter((n) => Number.isFinite(n));
    }

    channels = channels.sort((a, b) => a - b);

    // ── Support info for battery/doorbell flags ───────────────────────────────
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

    const cacheKey = `${source}:${channels.join(",")}`;
    const cached = this.nvrChannelsSummaryCache.get(cacheKey);
    if (cached) {
      return {
        channels: [...cached.channels],
        devices: cached.devices.map((d) => ({ ...d })),
      };
    }

    // ── Per-channel detail via Baichuan getInfo ───────────────────────────────
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

    // ── Build device list ────────────────────────────────────────────────────
    // For the baichuan path, enrich from push cache; for CGI path, enrich from
    // GetChannelstatus status entries. Push cache data is richer (wifiState,
    // streamSupport, loginState, etc.) so it is always preferred when available.
    const pushInfo = this.getChannelInfoFromPushCache();

    const devices = channels.map((channel) => {
      const pushCached = pushInfo.get(channel);
      const cgiStatus = cgiStatusByChannel.get(channel);
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

      // Prefer push cache for identity fields; fall back to CGI status
      const name = pushCached?.name || cgiStatus?.name || "";
      const uid = pushCached?.uid || cgiStatus?.uid || "";
      const sleeping = pushCached?.sleeping ?? cgiStatus?.sleeping;

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
        ...(name ? { name } : {}),
        ...(uid ? { uid } : {}),
        ...(pushCached?.state ? { state: pushCached.state } : {}),
        ...(typeof pushCached?.index === "number" ? { index: pushCached.index } : {}),
        ...(pushCached?.streamSupport?.length
          ? { streamSupport: pushCached.streamSupport }
          : {}),
        ...(pushCached?.wifiState ? { wifiState: pushCached.wifiState } : {}),
        ...(pushCached?.networkSegment
          ? { networkSegment: pushCached.networkSegment }
          : {}),
        ...(typeof pushCached?.changed === "boolean"
          ? { changed: pushCached.changed }
          : {}),
        ...(typeof pushCached?.abilityChanged === "boolean"
          ? { abilityChanged: pushCached.abilityChanged }
          : {}),
        ...(typeof pushCached?.online === "boolean"
          ? { online: pushCached.online }
          : {}),
        ...(typeof sleeping === "boolean" ? { sleeping } : {}),
        ...(pushCached?.loginState ? { loginState: pushCached.loginState } : {}),
        ...(typeof pushCached?.updatedAtMs === "number"
          ? { updatedAtMs: pushCached.updatedAtMs }
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
  ): Promise<MotionAlarmConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_MOTION_ALARM,
      ...(channel !== undefined ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<MotionAlarmConfig>(xml);
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
  ): Promise<AiAlarmConfig> {
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

    return parseXmlFragmentToJson<AiAlarmConfig>(xml);
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
    /** External identifier for the dedicated socket session (e.g., deviceId). */
    deviceId?: string;
  }): Promise<{
    msgNum: number;
    stream: BaichuanVideoStream;
    stop: () => Promise<void>;
  }> {
    const channel = params.channel;
    const streamType = params.streamType;
    const logger = params.logger ?? this.logger;

    // Replay uses dedicated socket per device+channel to allow concurrent replay
    // Session key format: replay:deviceId:ch{N} for proper socket pooling
    const sessionKey = params.deviceId
      ? `replay:${params.deviceId}:ch${channel}`
      : `replay:standalone:ch${channel}:${Date.now()}`;
    const tag = this.resolveSocketTag(sessionKey);

    logger?.debug?.(
      `[startRecordingReplayStreamStandalone] sessionKey=${sessionKey} -> tag=${tag}`,
    );

    const { client: dedicatedClient, release: releaseDedicatedClient } =
      await this.acquirePooledSocket(tag, logger);

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
    dedicatedClient.subscribeVideoStream(
      BC_CMD_ID_FILE_INFO_LIST_REPLAY,
      msgNum,
    );

    const profile: StreamProfile = streamType === "subStream" ? "sub" : "main";
    const stream = new BaichuanVideoStream({
      client: dedicatedClient,
      channel,
      profile,
      variant: "default",
      cmdId: BC_CMD_ID_FILE_INFO_LIST_REPLAY,
      msgNum,
      acceptAnyStreamType: true,
      logger,
    });

    let started = false;
    try {
      await stream.start();

      // PCAP-verified parameters (192.168.1.170, 192.168.50.226):
      // - channelIdOverride should be a session counter (incrementing), not 0 or channel+1
      // - Some H265 cameras reject channelId=0 with responseCode=400
      // - messageClass = BC_CLASS_MODERN_24 (0x6414)
      // - NO extensionXml
      const sessionCounter = dedicatedClient.reserveNextMsgNum();
      const frame = await dedicatedClient.sendFrame({
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
        dedicatedClient.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }
      // Release dedicated client on error
      await releaseDedicatedClient();
      throw e;
    }

    // Track if teardown has been executed to prevent double-close
    let tornDown = false;

    const stop = async (): Promise<void> => {
      if (tornDown) return;
      tornDown = true;

      const stopName = buildReplayStopNameFromFileName(params.fileName);
      if (started && stopName) {
        try {
          const stopXml = buildFileInfoListStopXml({
            channel,
            name: stopName,
            streamType,
          });

          await dedicatedClient.sendXml({
            cmdId: BC_CMD_ID_FILE_INFO_LIST_STOP,
            channel,
            payloadXml: stopXml,
            messageClass: BC_CLASS_MODERN_24,
            timeoutMs: 2_000, // Short timeout - if socket is closed, fail fast
            internal: true,
          });
        } catch {
          // ignore
        }
      }

      try {
        dedicatedClient.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }

      await stream.stop();

      // Release dedicated client when stream stops (closes socket)
      await releaseDedicatedClient();
    };

    // Auto-teardown: if stream closes/errors, ensure socket is closed
    // This is like closeApiOnTeardown in RFC4571 server
    const autoTeardown = (reason: string) => {
      if (tornDown) return;
      logger?.debug?.(
        `[DedicatedClient] Auto-teardown for ${sessionKey}: ${reason}`,
      );
      void stop();
    };

    stream.once("close", () => autoTeardown("stream closed"));
    stream.once("error", (e) =>
      autoTeardown(`stream error: ${e?.message || e}`),
    );

    // Also listen to dedicated client socket errors
    dedicatedClient.once("error", (e) =>
      autoTeardown(`client error: ${e?.message || e}`),
    );
    dedicatedClient.once("close", () => autoTeardown("client closed"));

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
    /** External identifier for the dedicated socket session (e.g., deviceId). */
    deviceId?: string;
  }): Promise<{
    msgNum: number;
    stream: BaichuanVideoStream;
    stop: () => Promise<void>;
  }> {
    const channel = params.channel;
    const streamType = params.streamType;
    const logger = params.logger ?? this.logger;

    // Replay uses dedicated socket per device+channel to allow concurrent replay
    // Session key format: replay:deviceId:ch{N} for proper socket pooling
    const sessionKey = params.deviceId
      ? `replay:${params.deviceId}:ch${channel}`
      : `replay:nvr:ch${channel}:${Date.now()}`;
    const tag = this.resolveSocketTag(sessionKey);
    const { client: dedicatedClient, release: releaseDedicatedClient } =
      await this.acquirePooledSocket(tag, logger);

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
    dedicatedClient.subscribeVideoStream(
      BC_CMD_ID_FILE_INFO_LIST_REPLAY,
      msgNum,
    );

    const profile: StreamProfile = streamType === "subStream" ? "sub" : "main";
    const stream = new BaichuanVideoStream({
      client: dedicatedClient,
      channel,
      profile,
      variant: "default",
      cmdId: BC_CMD_ID_FILE_INFO_LIST_REPLAY,
      msgNum,
      acceptAnyStreamType: true,
      logger,
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
        : dedicatedClient.reserveNextMsgNum();

      const frame = await dedicatedClient.sendFrame({
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
        dedicatedClient.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }
      // Release dedicated client on error
      await releaseDedicatedClient();
      throw e;
    }

    // Track if teardown has been executed to prevent double-close
    let tornDown = false;

    const stop = async (): Promise<void> => {
      if (tornDown) return;
      tornDown = true;

      const stopName = buildReplayStopNameFromFileName(params.fileName);
      if (started && stopName) {
        try {
          const stopXml = buildFileInfoListStopXml({
            channel,
            name: stopName,
            streamType,
          });

          await dedicatedClient.sendXml({
            cmdId: BC_CMD_ID_FILE_INFO_LIST_STOP,
            channel,
            payloadXml: stopXml,
            messageClass: BC_CLASS_MODERN_24,
            timeoutMs: 2_000, // Short timeout - if socket is closed, fail fast
            internal: true,
          });
        } catch {
          // ignore
        }
      }

      try {
        dedicatedClient.unsubscribeVideoStream(
          BC_CMD_ID_FILE_INFO_LIST_REPLAY,
          msgNum,
        );
      } catch {
        // ignore
      }

      await stream.stop();

      // Release dedicated client when stream stops (closes socket)
      await releaseDedicatedClient();
    };

    // Auto-teardown: if stream closes/errors, ensure socket is closed
    // This is like closeApiOnTeardown in RFC4571 server
    const autoTeardown = (reason: string) => {
      if (tornDown) return;
      logger?.debug?.(
        `[DedicatedClient] Auto-teardown for ${sessionKey}: ${reason}`,
      );
      void stop();
    };

    stream.once("close", () => autoTeardown("stream closed"));
    stream.once("error", (e) =>
      autoTeardown(`stream error: ${e?.message || e}`),
    );

    // Also listen to dedicated client socket errors
    dedicatedClient.once("error", (e) =>
      autoTeardown(`client error: ${e?.message || e}`),
    );
    dedicatedClient.once("close", () => autoTeardown("client closed"));

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
    /**
     * External identifier for the dedicated socket session.
     * When provided, a dedicated BaichuanClient is created/reused for this deviceId.
     * This allows multiple concurrent replay sessions without interference.
     * If not provided, a unique session key is generated automatically.
     */
    deviceId?: string;
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
      ...(params.deviceId != null ? { deviceId: params.deviceId } : {}),
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

    // Otherwise, queue the request – reject if queue is full to protect camera stability
    if (this.videoclipThumbnailQueue.length >= 50) {
      throw new Error(
        `Thumbnail queue full (${this.videoclipThumbnailQueue.length}/50) – request rejected to protect camera stability`,
      );
    }

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

    // For NVR: use the resolved headerChannelId from push cache (like FileInfoList).
    // For standalone cameras: use session counter (let client handle it).
    // NOTE: Backoff/retry is now handled globally by withSerializedCoverPreview.
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
    this.logger?.debug?.(
      `[downloadRecording] Queuing download for: ${params.fileName}, channel=${params.channel}`,
    );
    // Use replay queue to serialize all download operations on this socket
    return this.enqueueReplayOperation(async () => {
      this.logger?.debug?.(
        `[downloadRecording] Starting download for: ${params.fileName}`,
      );
      await this.client.login();

      const channel = this.normalizeChannel(params.channel);
      const uid = await this.ensureUidForRecordings(channel, params.uid);
      const fileName = params.fileName;

      this.logger?.debug?.(
        `[downloadRecording] Trying fileInfoListReplayBinaryDownload for: ${fileName}`,
      );
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
        this.logger?.debug?.(
          `[downloadRecording] fileInfoListReplayBinaryDownload failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      this.logger?.debug?.(
        `[downloadRecording] Trying fileInfoListDownload for: ${fileName}`,
      );
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
        this.logger?.debug?.(
          `[downloadRecording] fileInfoListDownload failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Third fallback: paged download via cmdId=14/15/16
      // This works for TrackMix PoE and other cameras where cmdId=5/13 return empty
      this.logger?.debug?.(
        `[downloadRecording] Trying fileInfoListPagedDownload for: ${fileName}`,
      );
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
        this.logger?.debug?.(
          `[downloadRecording] fileInfoListPagedDownload failed: ${e instanceof Error ? e.message : String(e)}`,
        );
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
    this.logger.debug?.(
      "[ReolinkBaichuanApi] subscribeEvents() called - checking session count before",
    );
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
    // For now, we just mark as unsubscribed.
    // Guard: socket pool may already be destroyed during disconnect cleanup.
    const generalEntry = this.socketPool.get("general");
    if (!generalEntry) return;
    generalEntry.client.subscribed = false;
    // For BCUDP/battery cameras: allow the camera to sleep when idle.
    generalEntry.client.refreshKeepAlive?.();
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

      // When the socket is disconnected (idle_disconnect on battery cam), the
      // rx/tx ring-buffers still contain pre-disconnect entries that age in/out
      // of the 10s window, causing phantom awake→sleeping flaps even though
      // no traffic is going to the camera. Skip the poll — the committed state
      // stays on the last valid value ("sleeping" in the normal idle_disconnect
      // path) and no event is emitted until the socket is reconnected.
      if (!this.client.isSocketConnected?.()) {
        this.udpPendingSleepStateByChannel.delete(channel);
        return;
      }

      const status = this.getSleepStatus({ channel });
      if (status.state === "unknown") return;

      const committed = this.udpLastInferredSleepStateByChannel.get(channel);
      const pending = this.udpPendingSleepStateByChannel.get(channel);

      const decision = decideSleepInferenceTransition({
        inferred: status.state,
        committed,
        pending,
        hysteresisPolls: this.udpSleepInferenceHysteresisPolls,
      });

      this.udpLastInferredSleepStateByChannel.set(
        channel,
        decision.nextCommitted,
      );
      if (decision.nextPending === undefined) {
        this.udpPendingSleepStateByChannel.delete(channel);
      } else {
        this.udpPendingSleepStateByChannel.set(channel, decision.nextPending);
      }

      if (decision.emit) {
        this.dispatchSimpleEvent({
          type: decision.emit,
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
    this.udpPendingSleepStateByChannel.clear();
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
   * @param options - Optional settings including variant and dedicated client
   * @returns Promise that resolves when stream request is sent
   */
  async startVideoStream(
    channel?: number,
    profile: StreamProfile = "sub",
    options?: {
      /** Native-only: request TrackMix tele/autotrack variants (usually on NVR/Hub). */
      variant?: NativeVideoStreamVariant;
      /**
       * Dedicated client to use for this stream. If provided, the command is sent
       * on this client instead of the main API client. This is essential when using
       * dedicated sockets for streaming to avoid frame routing issues.
       */
      client?: BaichuanClient;
    },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    // Use the same 0-based channel_id everywhere (header, Extension, payload).
    const channelId = ch;

    const variant: NativeVideoStreamVariant = options?.variant ?? "default";

    // Use dedicated client if provided, otherwise use the main API client
    const targetClient = options?.client ?? this.client;

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
    const isUdp = targetClient.getTransport?.() === "udp";
    const maxAttempts = isUdp ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // NOTE: must be atomic. Two parallel startVideoStream() calls (e.g. composite wider+tele)
      // can otherwise pick the same msgNum and cause stream packet mixups.
      const msgNum = targetClient.reserveNextMsgNum();
      targetClient.subscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);

      // Optimistically publish msgNum immediately so stream consumers can start filtering
      // even if the NVR/Hub takes a long time to reply to the start request.
      this.activeVideoMsgNums.set(`${ch}:${profile}:${variant}`, msgNum);

      try {
        const baseParams: Parameters<typeof targetClient.sendFrame>[0] = {
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
          | Awaited<ReturnType<typeof targetClient.sendFrame>>
          | undefined;
        if (
          teleChannelIdCandidates.length > 0 &&
          telePreviewStreamType &&
          teleHandleBase !== undefined
        ) {
          for (const teleChannelIdTag of teleChannelIdCandidates) {
            try {
              frame = await targetClient.sendFrame({
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
        if (!frame) frame = await targetClient.sendFrame(baseParams);

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
          // Mark the profile as rejected so buildVideoStreamOptions can
          // exclude it and callers don't retry pointlessly.
          if (frame.header.responseCode === 400) {
            const rejKey = `${ch}:${profile}`;
            if (!this._rejectedStreamProfiles.has(rejKey)) {
              this._rejectedStreamProfiles.add(rejKey);
              // Invalidate cached stream options so the next call reflects the change.
              this.videoStreamOptionsCache.clear();
              this.logger?.warn?.(
                `[ReolinkBaichuanApi] Stream profile rejected by device: channel=${ch} profile=${profile} (response_code 400). ` +
                  `This profile will be excluded from available streams. ` +
                  `The camera may not support this stream profile with the current firmware.`,
              );
            }
          }
          throw new Error(
            `Video stream request rejected (response_code ${frame.header.responseCode}). Expected response_code 200, camera returned ${frame.header.responseCode}`,
          );
        }

        // Remember msgNum so we can stop the stream with the same msgNum.
        this.activeVideoMsgNums.set(
          `${ch}:${profile}:${variant}`,
          frame.header.msgNum,
        );

        // Success — reset consecutive timeout counter for this socket.
        this.resetStreamTimeoutCounter(targetClient);
        return;
      } catch (error) {
        lastError = error;
        try {
          targetClient.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
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

    // All attempts exhausted — track consecutive timeout and force-close stale socket.
    const isTimeout =
      lastError instanceof Error && lastError.message?.includes("timeout");
    if (isTimeout) {
      this.trackStreamTimeout(targetClient);
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
   * @param options - Optional settings including variant and dedicated client
   */
  async stopVideoStream(
    channel?: number,
    profile: StreamProfile = "sub",
    options?: {
      /** Native-only: stop TrackMix tele/autotrack variants (must match the started variant). */
      variant?: NativeVideoStreamVariant;
      /**
       * Dedicated client to use for this stream. If provided, the command is sent
       * on this client instead of the main API client. Must match the client used
       * in startVideoStream.
       */
      client?: BaichuanClient;
    },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;

    const variant: NativeVideoStreamVariant = options?.variant ?? "default";

    // Use dedicated client if provided, otherwise use the main API client
    const targetClient = options?.client ?? this.client;

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
          await targetClient.sendFrame({
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
          targetClient.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
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
   * Recall (move to) a saved PTZ preset.
   *
   * cmd_id 19 (PTZ_CONTROL_PRESET) with command="toPos". The camera moves
   * the head at its own default preset-recall speed; we don't expose
   * speed here because most firmwares ignore the field on toPos.
   */
  async gotoPtzPreset(presetId: number, channel?: number): Promise<void>;
  async gotoPtzPreset(channel: number, presetId: number): Promise<void>;
  async gotoPtzPreset(arg1: number, arg2?: number): Promise<void> {
    // Two-arg form is (channel, presetId); one-arg form is (presetId).
    const ch =
      arg2 === undefined
        ? this.normalizeChannel(undefined)
        : this.normalizeChannel(arg1);
    const presetId = arg2 === undefined ? arg1 : arg2;
    const channelId = ch;
    const payloadXml = buildPtzPresetXmlV2(channelId, presetId, "toPos");
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
        `PTZ goto preset rejected (response_code ${frame.header.responseCode})`,
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
   * Called when any BaichuanClient for this device receives a D2C_DISC.
   *
   * Two-tier response:
   *  1. **Immediate**: every D2C_DISC applies a short socket pool cooldown
   *     (10 s) to prevent reconnect attempts while the camera transitions to sleep.
   *  2. **Storm**: ≥3 D2C_DISCs within 60 s triggers extended cooldown (120 s).
   */
  private notifyD2cDisc(): void {
    const now = Date.now();
    this.lastD2cDiscAtMs = now;

    // ─── Force-close all streaming sockets ───
    // After D2C_DISC, the camera is going to sleep. Streaming sockets may appear
    // connected (loggedIn=true) but the camera will ignore cmdId=3 (stream start)
    // commands, causing an infinite retry loop. Force-close them so the next stream
    // attempt creates a fresh socket after the cooldown expires.
    const streamingTags = Array.from(this.socketPool.keys()).filter(
      (tag) => tag.startsWith("streaming:"),
    );
    if (streamingTags.length > 0) {
      this.logger?.log?.(
        `[D2C_DISC] Force-closing ${streamingTags.length} streaming socket(s): ${streamingTags.join(", ")}`,
      );
      for (const tag of streamingTags) {
        this.forceClosePooledSocket(tag, this.logger).catch(() => {});
      }
    }

    // ─── Tier 1: immediate cooldown on every D2C_DISC ───
    const immediateCooldownUntil =
      now + ReolinkBaichuanApi.D2C_DISC_IMMEDIATE_COOLDOWN_MS;
    const existing = this.socketPoolCooldowns.get(this.host);
    if (!existing || existing.cooldownUntil < immediateCooldownUntil) {
      this.socketPoolCooldowns.set(this.host, {
        failureCount: existing?.failureCount ?? 1,
        lastFailureAt: now,
        cooldownUntil: immediateCooldownUntil,
      });
      this.logger?.log?.(
        `[D2C_DISC] Immediate cooldown: socket pool blocked for ${ReolinkBaichuanApi.D2C_DISC_IMMEDIATE_COOLDOWN_MS / 1000}s`,
      );
    }

    // ─── Tier 2: storm detection ───
    this.d2cDiscTimestamps.push(now);
    const cutoff = now - ReolinkBaichuanApi.D2C_DISC_STORM_WINDOW_MS;
    while (
      this.d2cDiscTimestamps.length > 0 &&
      this.d2cDiscTimestamps[0]! < cutoff
    ) {
      this.d2cDiscTimestamps.shift();
    }

    if (
      this.d2cDiscTimestamps.length >=
      ReolinkBaichuanApi.D2C_DISC_STORM_THRESHOLD
    ) {
      const stormCooldownUntil =
        now + ReolinkBaichuanApi.D2C_DISC_STORM_COOLDOWN_MS;
      const currentEntry = this.socketPoolCooldowns.get(this.host);
      if (!currentEntry || currentEntry.cooldownUntil < stormCooldownUntil) {
        this.socketPoolCooldowns.set(this.host, {
          failureCount: this.d2cDiscTimestamps.length,
          lastFailureAt: now,
          cooldownUntil: stormCooldownUntil,
        });
        this.logger?.warn?.(
          `[D2C_DISC] Storm detected: ${this.d2cDiscTimestamps.length} disconnects in ${ReolinkBaichuanApi.D2C_DISC_STORM_WINDOW_MS / 1000}s → socket pool cooldown ${ReolinkBaichuanApi.D2C_DISC_STORM_COOLDOWN_MS / 1000}s`,
        );
      }
    }
  }

  /**
   * Find the socket pool tag for a given BaichuanClient instance.
   * Returns undefined if the client is not in the pool (e.g. it's the general socket used directly).
   */
  private findSocketTagForClient(client: BaichuanClient): string | undefined {
    for (const [tag, entry] of this.socketPool) {
      if (entry.client === client) return tag;
    }
    return undefined;
  }

  /**
   * Reset the consecutive stream-start timeout counter for a streaming socket.
   * Called on successful stream start.
   */
  private resetStreamTimeoutCounter(client: BaichuanClient): void {
    const tag = this.findSocketTagForClient(client);
    if (tag) this.consecutiveStreamTimeouts.delete(tag);
  }

  /**
   * Track a stream-start timeout on a streaming socket.
   * After MAX_CONSECUTIVE_STREAM_TIMEOUTS consecutive timeouts, force-close the
   * socket so the next attempt creates a fresh connection.
   */
  private trackStreamTimeout(client: BaichuanClient): void {
    const tag = this.findSocketTagForClient(client);
    if (!tag || !tag.startsWith("streaming:")) return;

    const count = (this.consecutiveStreamTimeouts.get(tag) ?? 0) + 1;
    this.consecutiveStreamTimeouts.set(tag, count);

    if (count >= ReolinkBaichuanApi.MAX_CONSECUTIVE_STREAM_TIMEOUTS) {
      this.logger?.warn?.(
        `[SocketPool] ${count} consecutive stream timeouts on tag=${tag}, force-closing socket`,
      );
      this.consecutiveStreamTimeouts.delete(tag);
      this.forceClosePooledSocket(tag, this.logger).catch(() => {});
    }
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

    // ─── D2C_DISC → sleeping ───
    // D2C_DISC is the camera explicitly terminating the session (going to sleep).
    // Treat as sleeping immediately so consumers don't attempt new streams.
    const msSinceD2cDisc = now - this.lastD2cDiscAtMs;
    const recentD2cDisc =
      this.lastD2cDiscAtMs > 0 && msSinceD2cDisc < 30_000;

    const rx = (this.client.getRxHistory?.() ?? []).filter(
      (h) => h.atMs >= cutoff,
    );
    const tx = (this.client.getTxHistory?.() ?? []).filter(
      (h) => h.atMs >= cutoff,
    );

    // If we've had absolutely no activity in the window, treat as sleeping (best-effort).
    if (rx.length === 0 && tx.length === 0) {
      if (recentD2cDisc) {
        return {
          state: "sleeping",
          reason: `D2C_DISC ${Math.round(msSinceD2cDisc / 1000)}s ago, camera terminated session`,
        };
      }
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

    if (recentD2cDisc) {
      return {
        state: "sleeping",
        reason: `only non-waking cmdIds + D2C_DISC ${Math.round(msSinceD2cDisc / 1000)}s ago, camera terminated session`,
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
    return await this.setMotionAlarmFull({
      ...(channel !== undefined ? { channel } : {}),
      enabled,
      ...(sensitivity !== undefined ? { sensitivity } : {}),
    });
  }

  /**
   * Set motion alarm with full control, including the detection-zone grid.
   *
   * Wire format observed on E1 Zoom (cmd_id=47 SetMdAlarm body):
   *
   *   <MD version="1.1">
   *     <channelId>0</channelId>
   *     <enable>1</enable>
   *     <usepir>0</usepir>
   *     <width>60</width> <height>33</height>
   *     <scope>
   *       <columns>96</columns> <rows>64</rows>
   *       <valueTable>{base64 6144-bit bitmap}</valueTable>
   *     </scope>
   *     ... other camera-specific fields ...
   *   </MD>
   *
   * We do a read-modify-write of the GET response so any camera-specific
   * extension fields are preserved untouched. Pass `valueTable` to update
   * the detection zone — see `encodeMotionScopeBitmap` for the bitmap layout.
   *
   * @param channel - 0-based channel
   * @param enabled - toggle motion detection on/off (optional)
   * @param sensitivity - 0-50, higher = more sensitive (optional)
   * @param valueTable - base64-encoded grid bitmap; size must match
   *   `<scope><columns>×<rows></scope>` from the GET (optional)
   */
  async setMotionAlarmFull(opts: {
    channel?: number;
    enabled?: boolean;
    sensitivity?: number;
    valueTable?: string;
  }): Promise<void> {
    const ch = this.normalizeChannel(opts.channel);
    const currentXml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_MOTION_ALARM,
      channel: ch,
    });

    let modifiedXml = currentXml;
    if (opts.enabled !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<enable>[^<]*<\/enable>/,
        `<enable>${opts.enabled ? "1" : "0"}</enable>`,
      );
    }
    if (opts.sensitivity !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<sensitivityDefault>[^<]*<\/sensitivityDefault>/,
        `<sensitivityDefault>${opts.sensitivity}</sensitivityDefault>`,
      );
    }
    if (opts.valueTable !== undefined) {
      modifiedXml = modifiedXml.replace(
        /<valueTable>[^<]*<\/valueTable>/,
        `<valueTable>${opts.valueTable}</valueTable>`,
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

  /**
   * Get floodlight-on-motion state via FloodlightTask (cmdId=289).
   *
   * Returns whether the floodlight turns on automatically when motion is detected.
   * This is controlled by the `alarmMode` field in FloodlightTask.
   *
   * @param channel - Channel number (0-based)
   * @returns FloodlightTaskState with floodlightOnMotion, enabled, brightness, duration, detectType
   *
   * @example
   * const state = await api.getFloodlightOnMotion(0);
   * console.log(state.floodlightOnMotion); // true if floodlight turns on when motion detected
   */
  async getFloodlightOnMotion(channel?: number): Promise<FloodlightTaskState> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_WHITE_LED,
      channel: ch,
    });
    return parseFloodlightTaskFromXml(xml);
  }

  /**
   * Set floodlight-on-motion state via FloodlightTask (cmdId=290).
   *
   * Enables or disables the floodlight turning on automatically when motion is detected.
   * This modifies both `alarmMode` and `enable` fields in FloodlightTask.
   *
   * @param on - true to enable floodlight on motion, false to disable
   * @param channel - Channel number (0-based)
   *
   * @example
   * // Enable floodlight on motion
   * await api.setFloodlightOnMotion(true, 0);
   * // Disable floodlight on motion
   * await api.setFloodlightOnMotion(false, 0);
   */
  async setFloodlightOnMotion(on: boolean, channel?: number): Promise<void> {
    const ch = this.normalizeChannel(channel);

    // GET current FloodlightTask XML
    const currentXml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_WHITE_LED,
      channel: ch,
    });

    // Modify alarmMode and enable fields
    const modifiedXml = applyFloodlightOnMotionToXml(currentXml, on);

    // SET via cmdId 290
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_WHITE_LED_TASK,
      channel: ch,
      payloadXml: modifiedXml,
    });
  }

  /**
   * Set floodlight settings (duration, detectType, brightness) via FloodlightTask (cmdId=290).
   *
   * This allows configuring floodlight parameters without changing the enable state.
   *
   * @param channel - Channel number (0-based)
   * @param settings - Floodlight settings to apply
   *
   * @example
   * ```typescript
   * await api.setFloodlightSettings(0, {
   *   duration: 300, // 5 minutes
   *   detectType: 'people,vehicle',
   *   brightness: 80,
   * });
   * ```
   */
  async setFloodlightSettings(
    channel: number | undefined,
    settings: {
      duration?: number;
      detectType?: string;
      brightness?: number;
    },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);

    // GET current FloodlightTask XML
    const currentXml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_WHITE_LED,
      channel: ch,
    });

    // Apply settings
    const modifiedXml = applyFloodlightSettingsToXml(currentXml, settings);

    // SET via cmdId 290
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_WHITE_LED_TASK,
      channel: ch,
      payloadXml: modifiedXml,
    });
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

      return xmlIndicatesFloodlight(xml);
    } catch {
      return false;
    }
  }

  /**
   * Probe autotracking support via AiCfg (cmd 299).
   *
   * Uses smartTrackMode > 0 as the indicator for autotracking capability.
   * This is more reliable than autoPt in SupportInfo which can be a false positive
   * (e.g., NVR channels report autoPt=1 but don't actually support autotracking).
   *
   * @param channel - Channel number (0-based)
   * @param options - Optional timeout
   * @returns true if autotracking is supported, false otherwise
   */
  async probeAutotrackingSupport(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<boolean> {
    const ch = this.normalizeChannel(channel);
    const timeoutMs = options?.timeoutMs ?? 1500;

    try {
      const xml = await this.sendXml({ cmdId: 299, channel: ch, timeoutMs });
      const smartTrackModeRaw = getXmlText(xml, "smartTrackMode");
      const smartTrackMode = Number(smartTrackModeRaw ?? 0);
      return smartTrackMode > 0;
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
   * Get device capabilities for a specific channel.
   *
   * This method uses a simplified, deterministic approach:
   * - SupportInfo (cmd 199) is the single source of truth for most flags
   * - AbilityInfo (cmd 151) provides fallback for PTZ/intercom
   * - AI detection types come from cmd 299
   * - PTZ presets are probed only if ptzPreset > 0 in SupportInfo
   *
   * Results are cached for 5 minutes per channel.
   *
   * @param channel - Channel number (0-based). Defaults to 0.
   * @returns Device capabilities including abilities, support info, presets, and AI objects
   */
  async getDeviceCapabilities(
    channel?: number,
  ): Promise<DeviceCapabilitiesResult> {
    const ch = this.normalizeChannel(channel);

    // Check cache first
    const cached = this.deviceCapabilitiesCache.get(ch);
    if (
      cached &&
      Date.now() - cached.cachedAtMs <
        ReolinkBaichuanApi.CAPABILITIES_CACHE_TTL_MS
    ) {
      return cached.result;
    }

    // Fetch SupportInfo and AbilityInfo in parallel
    const [supportResult, abilitiesResult] = await Promise.allSettled([
      this.getSupportInfo({ timeoutMs: 5000 }),
      this.getAbilityInfo(),
    ]);

    const support =
      supportResult.status === "fulfilled" ? supportResult.value : undefined;
    const abilities =
      abilitiesResult.status === "fulfilled"
        ? abilitiesResult.value
        : undefined;

    // Find the best SupportItem for this channel
    const supportItem = getSupportItemForChannel(support, ch);

    const capabilities = computeDeviceCapabilities({
      channel: ch,
      ...(support != null && { support }),
      ...(abilities != null && { abilities }),
    });

    // Floodlight post-processing: override computeDeviceCapabilities result for special cases
    // - NVR: ledCtrl > 0 indicates LED control capabilities for connected camera
    // - Standalone with unknown lightType: probe cmd 289
    const item = supportItem as Record<string, unknown> | undefined;
    const lightType = item?.lightType as number | undefined;
    const ledCtrl = item?.ledCtrl as number | undefined;
    const ptzType = item?.ptzType as number | undefined;
    const supportVolume = item?.supportVolume as number | undefined;
    const supportPirSch = item?.supportPirSch as number | undefined;

    // Track if device is NVR for debug info
    const isNvr = await this.isNvrDevice();

    // For NVR: use ledCtrl > 0 as indicator (reliable for battery cameras like Argus)
    // For standalone: lightType >= 2 or probe if undefined
    if (isNvr) {
      // On NVR, ledCtrl indicates LED control capabilities for the connected camera
      capabilities.hasFloodlight = (ledCtrl ?? 0) > 0;
    } else if (lightType === undefined) {
      // Standalone camera with unknown lightType: probe cmd 289 as a fallback
      // signal. The probe can false-negative when the firmware doesn't expose
      // cmd 289, so we OR it with whatever computeDeviceCapabilities already
      // worked out from the support-info ledCtrl bitmask — never downgrade a
      // positive ledCtrl signal because of a probe miss.
      const probed = await this.probeFloodlightSupportByCmd289(ch, {
        timeoutMs: 2500,
      });
      capabilities.hasFloodlight = capabilities.hasFloodlight || probed;
    }
    // else: lightType is defined. computeDeviceCapabilities already merged the
    // lightType >= 2 check with the ledCtrl > 1 rescue (Reolink Duo 3 WiFi
    // reports lightType=1 + ledCtrl=38 even though it has a real spotlight —
    // PR #22).

    // Wireless chime: only true when paired chimes are discovered (like reolink_aio)
    let dingDongListIds: number[] | undefined;
    let dingDongCfgIds: number[] | undefined;
    let wirelessChimeError: string | undefined;
    if (capabilities.hasWirelessChime) {
      try {
        const list = await this.getDingDongList(ch);
        dingDongListIds = list.map((d) => d.id);
        const first = list[0];
        const fromList = first !== undefined && first.id >= 0;
        if (!fromList) {
          const configs = await this.getDingDongCfg(ch);
          dingDongCfgIds = configs.map((c) => c.id);
          capabilities.hasWirelessChime = configs.some((c) => c.id >= 0);
        }
      } catch (e) {
        capabilities.hasWirelessChime = false;
        wirelessChimeError = e instanceof Error ? e.message : String(e);
      }
    }

    // Build features from SupportInfo
    const features = this.parseFeaturesFromSupport(support);

    // Get AI detection types (cmd 299)
    const objects = await this.getAiDetectTypes(ch, { timeoutMs: 1500 });

    // Probe autotracking support via AiCfg (cmd 299)
    // smartTrackMode > 0 indicates the device truly supports autotracking
    // Note: autoPt in SupportInfo can be a false positive (e.g., NVR channels report autoPt=1
    // but aiTrack.ver=0 in CGI abilities and smartTrackMode=0 in AiCfg)
    const autotrackingProbed = await this.probeAutotrackingSupport(ch, {
      timeoutMs: 1500,
    });
    capabilities.hasAutotracking = autotrackingProbed;

    // Get PTZ presets if supported
    let presets: PtzPreset[] | undefined;
    if (capabilities.hasPresets) {
      try {
        presets = await this.getPtzPresets(ch);
        // Update hasPresets based on actual results
        capabilities.hasPresets = presets.length > 0;
      } catch {
        capabilities.hasPresets = false;
      }
    }

    // Build debug info with all entities used for capability detection
    const debug: DeviceCapabilitiesDebugInfo = {
      channel: ch,
      channelId1Based: ch + 1,
      transport: this.client.getTransport?.() ?? "tcp",
      encryptionKind: this.client.enc?.kind ?? "none",
      loggedIn: this.client.loggedIn,
      subscribed: this.client.subscribed,
      abilitiesAvailable: Boolean(abilities),
      supportAvailable: Boolean(support),
      isNvr,
      ...(lightType !== undefined && { lightType }),
      ...(ledCtrl !== undefined && { ledCtrl }),
      ...(ptzType !== undefined && { ptzType }),
      ...(supportVolume !== undefined && { supportVolume }),
      ...(supportPirSch !== undefined && { supportPirSch }),
      ...(supportItem?.chnID !== undefined && {
        supportItemChnID: supportItem.chnID,
      }),
      ...(abilities && {
        abilityMergedKeyCount: Object.keys(abilities).length,
      }),
      ...(support?.items && { supportItemCount: support.items.length }),
      ...(dingDongListIds !== undefined && { dingDongListIds }),
      ...(dingDongCfgIds !== undefined && { dingDongCfgIds }),
      ...(wirelessChimeError !== undefined && { wirelessChimeError }),
    };

    const result: DeviceCapabilitiesResult = {
      capabilities,
      debug,
      ...(abilities && { abilities }),
      ...(support && { support }),
      ...(presets && { presets }),
      ...(objects && { objects }),
      ...(features && { features }),
    };

    // Cache the result
    this.deviceCapabilitiesCache.set(ch, {
      result,
      cachedAtMs: Date.now(),
    });

    return result;
  }

  /**
   * Clear the device capabilities cache for a specific channel or all channels.
   */
  clearCapabilitiesCache(channel?: number): void {
    if (channel !== undefined) {
      this.deviceCapabilitiesCache.delete(channel);
    } else {
      this.deviceCapabilitiesCache.clear();
    }
  }

  /**
   * Parse support features from SupportInfo.
   */
  private parseFeaturesFromSupport(
    support: SupportInfo | undefined,
  ): DeviceSupportFlags | undefined {
    if (!support) return undefined;

    const truthy = (v: unknown): boolean => {
      if (typeof v === "number") return v > 0;
      if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n > 0 : v.length > 0 && v !== "0";
      }
      return Boolean(v);
    };

    return {
      rtsp: truthy(support.rtsp),
      onvif: truthy(support.onvif),
      wifi: truthy(support.wifi),
      record: truthy(support.record),
      ftp: truthy(support.ftp),
      email: truthy(support.email),
      pushAlarm: truthy(support.pushAlarm),
      audioTalk: truthy(support.audioTalk),
    };
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

    // Some firmwares (Reolink Duo 3 WiFi, recent Video Doorbell builds) return
    // an empty payload for the channel-specific DevInfo (cmd_id 318) on
    // standalone cameras, even though the device-wide DevInfo (cmd_id 80)
    // exposes the full `type`. Fall back to the device-wide call so the
    // dual-lens classifier doesn't end up with `model: undefined`.
    if (!model) {
      try {
        const deviceInfoBase = await this.getInfo(undefined, { tags: ["type"] });
        model = deviceInfoBase.type?.trim();
      } catch {
        // ignore
      }
    }

    try {
      const capabilities = await this.getDeviceCapabilities(channel);
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

    // Firmware-level "binocular" flag: present in cmd_id 199 (SupportInfo)
    // per-channel item as `binoCfg`. Captured against an Argus (UDP) standalone
    // confirms the Reolink Electron client uses the same SupportInfo
    // response to derive `cameraType === "binocular"` — this flag is the
    // authoritative signal for a stitched dual-sensor camera like the
    // Reolink Duo 3 (which exposes a single logical channel despite having
    // two physical lenses). The model-name match list above stays as a
    // fallback for older firmwares that pre-date the binoCfg field.
    const supportItemForChannel = (() => {
      if (!supportInfo) return undefined;
      const items = (supportInfo as { items?: Array<Record<string, unknown>> })
        .items;
      if (!Array.isArray(items)) return undefined;
      return items.find(
        (it) => typeof it === "object" && it !== null && "ledCtrl" in it,
      );
    })();
    const binoCfgRaw = supportItemForChannel
      ? (supportItemForChannel as { binoCfg?: unknown }).binoCfg
      : undefined;
    const hasBinoCfgFlag =
      typeof binoCfgRaw === "number"
        ? binoCfgRaw > 0
        : typeof binoCfgRaw === "string"
          ? Number(binoCfgRaw) > 0
          : false;

    // Consider it dual lens if any signal fires:
    //   - explicit firmware binoCfg flag (most reliable)
    //   - known model match (legacy fallback for Duo/TrackMix without binoCfg)
    //   - device exposes 2 channels (most-permissive fallback)
    const isDualLens =
      hasBinoCfgFlag ||
      isDualMotionModel ||
      isSingleMotionModel ||
      hasDualLensChannelCount;

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
        const chCapabilities = await this.getDeviceCapabilities(ch);
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
            // RTSP is available if support.rtsp > 0
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
      isTrackMix = model.includes("trackmix") || model.includes("trackflex");
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
        rawEncXml: undefined,
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
        rawEncXml: widerMetadata?.rawXml,
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

        // Skip profiles that the device has explicitly rejected (e.g. ext returning 400).
        if (this._rejectedStreamProfiles.has(`${params.channel}:${profile}`))
          continue;

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
      rawEncXml: streamMetadata?.rawXml,
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

  // ====================================================================
  // Native Baichuan tunable-settings setters
  //
  // Replace the CGI passthroughs above with on-wire Baichuan binary
  // calls. Mirrors the @http_cmd-decorated methods in reolink_aio's
  // baichuan.py — every command has a documented `cmd_id` (read) and
  // `cmd_id` (write) pair. The pattern is:
  //
  //   1. read XML via `sendXml({ cmdId: GET, channel })`
  //   2. patch fields via regex (camera firmware is XML-strict; using
  //      the parser would force us to rebuild the document and risk
  //      losing unmodified attributes / element order).
  //   3. write back via `sendXml({ cmdId: SET, channel, payloadXml })`
  //
  // All getters parse via `parseXmlFragmentToJson` so the consumer gets
  // a clean JSON object instead of XML.
  // ====================================================================

  /**
   * GetEnc via Baichuan (cmdId=56). Returns the `<Compression>` block:
   * per-stream `mainStream` / `subStream` / `thirdStream` with `audio`
   * flag, `width`, `height`, `frame` (NOT `frameRate`), `bitRate`,
   * `videoEncType` (0=h264, 1=h265), `encoderProfile`, `gop`. Mirrors
   * reolink_aio's `GetEnc` — note the wire payload wraps everything
   * in `Compression`, not `Enc`.
   */
  async getEnc(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<EncConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_ENC,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<EncConfig>(xml);
  }

  /**
   * SetEnc via Baichuan (cmdId=57). Read-modify-write — preserves
   * unspecified fields. Mirrors reolink_aio's `SetEnc` plus the additional
   * `width`/`height`/`encoderType`/`encoderProfile`/`gop`/`thirdStream`
   * fields observed in the official mobile app (see `pcap/resolution.pcapng`).
   *
   * Field meaning per stream:
   *  - `audio`           — 0/1 toggle
   *  - `width`/`height`  — resolution in pixels. Must be one of the
   *                        resolutions returned by {@link getStreamInfoList}.
   *  - `bitRate`         — kbps. Must match the table from `getStreamInfoList`.
   *  - `frameRate`       — fps. Must match the table from `getStreamInfoList`.
   *  - `videoEncType`    — `"h264"` or `"h265"`
   *  - `encoderType`     — `"vbr"` or `"cbr"`
   *  - `encoderProfile`  — `"high"`, `"main"`, or `"baseline"`
   *  - `gop`             — keyframe interval in seconds (sets `<gop><cur>`)
   *
   * @param channel - Channel number (0-based)
   * @param patch - Fields to update. Pass only the fields you want to change;
   *   everything else is preserved from the device's current configuration.
   */
  async setEnc(
    channel: number,
    patch: {
      audio?: 0 | 1;
      mainStream?: EncStreamPatch;
      subStream?: EncStreamPatch;
      thirdStream?: EncStreamPatch;
    },
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    let xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_ENC,
      channel: ch,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });

    if (patch.audio !== undefined) {
      xml = xml.replace(
        /<audio>[^<]*<\/audio>/g,
        `<audio>${patch.audio}</audio>`,
      );
    }
    xml = applyStreamPatch(xml, "mainStream", patch.mainStream);
    xml = applyStreamPatch(xml, "subStream", patch.subStream);
    xml = applyStreamPatch(xml, "thirdStream", patch.thirdStream);

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_ENC,
      channel: ch,
      payloadXml: ensureXmlHeader(xml),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * SetImage via Baichuan (cmdId=25, read via cmdId=26). Patches the
   * `<VideoInput>` block: bright / contrast / saturation / hue /
   * sharpen. Mirrors reolink_aio's `SetImage`.
   */
  async setImage(
    channel: number,
    patch: {
      bright?: number;
      contrast?: number;
      saturation?: number;
      hue?: number;
      sharpen?: number;
    },
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    let xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_VIDEO_INPUT,
      channel: ch,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });

    xml = applyXmlTagPatch(xml, "bright", patch.bright);
    xml = applyXmlTagPatch(xml, "contrast", patch.contrast);
    xml = applyXmlTagPatch(xml, "saturation", patch.saturation);
    xml = applyXmlTagPatch(xml, "hue", patch.hue);
    xml = applyXmlTagPatch(xml, "sharpen", patch.sharpen);

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_VIDEO_INPUT,
      channel: ch,
      payloadXml: ensureXmlHeader(xml),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * SetIsp via Baichuan (cmdId=25 for image side, cmdId=297 for
   * dayNightThreshold). Patches the `<InputAdvanceCfg>` block:
   * `DayNight/mode`, `Exposure/mode`, `binning_mode`, `hdrSwitch`.
   * Mirrors reolink_aio's `SetIsp`.
   *
   * @param channel - Channel number (0-based)
   * @param patch - Fields to update. `dayNight` accepts the camera's
   *   raw enum (`color`, `auto`, `blackAndWhite`, …) — pass it as the
   *   camera reports it (PascalCase / dotted forms get normalized
   *   server-side).
   */
  async setIsp(
    channel: number,
    patch: {
      dayNight?: string;
      exposure?: string;
      binningMode?: number;
      hdr?: 0 | 1;
      dayNightThreshold?: number;
    },
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const timeoutOpts =
      options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {};

    const wantsImageWrite =
      patch.dayNight !== undefined ||
      patch.exposure !== undefined ||
      patch.binningMode !== undefined ||
      patch.hdr !== undefined;

    if (wantsImageWrite) {
      let xml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_VIDEO_INPUT,
        channel: ch,
        ...timeoutOpts,
      });

      if (patch.dayNight !== undefined) {
        const normalized = normalizeDayNightMode(patch.dayNight);
        xml = patchNestedTag(xml, "DayNight", "mode", normalized);
      }
      if (patch.exposure !== undefined) {
        xml = patchNestedTag(
          xml,
          "Exposure",
          "mode",
          patch.exposure.toLowerCase(),
        );
      }
      if (patch.binningMode !== undefined) {
        xml = applyXmlTagPatch(xml, "binning_mode", patch.binningMode);
      }
      if (patch.hdr !== undefined) {
        xml = applyXmlTagPatch(xml, "hdrSwitch", patch.hdr);
      }

      await this.sendXml({
        cmdId: BC_CMD_ID_SET_VIDEO_INPUT,
        channel: ch,
        payloadXml: ensureXmlHeader(xml),
        ...timeoutOpts,
      });
    }

    if (patch.dayNightThreshold !== undefined) {
      let xml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_DAY_NIGHT_THRESHOLD,
        channel: ch,
        ...timeoutOpts,
      });
      xml = applyXmlTagPatch(xml, "cur", patch.dayNightThreshold);
      await this.sendXml({
        cmdId: BC_CMD_ID_SET_DAY_NIGHT_THRESHOLD,
        channel: ch,
        payloadXml: ensureXmlHeader(xml),
        ...timeoutOpts,
      });
    }
  }

  /**
   * GetIsp via Baichuan (cmdId=26). Convenience alias of
   * `getVideoInput()` so callers that switched from CGI keep the
   * familiar name. Both return the merged VideoInput +
   * InputAdvanceCfg blob.
   */
  async getIsp(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<IspConfig> {
    return this.getVideoInput(channel, options) as Promise<IspConfig>;
  }

  /** GetImage via Baichuan (cmdId=26). Same payload as `getIsp` —
   *  Reolink merged VideoInput + InputAdvanceCfg under one cmdId. */
  async getImage(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<IspConfig> {
    return this.getVideoInput(channel, options) as Promise<IspConfig>;
  }

  /**
   * GetIrLights via Baichuan (cmdId=208). Returns LedState block:
   * `IRLedBrightness`, `state` (ir on/off), `lightState` (status LED
   * open/close), `doorbellLightState`. Mirrors reolink_aio's
   * `get_status_led`.
   */
  async getIrLights(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<IrLightsConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_LED_STATE,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<IrLightsConfig>(xml);
  }

  /**
   * SetIrLights via Baichuan (cmdId=209, read via cmdId=208). Patches
   * IR LED + status LED + doorbell LED + IR brightness. Mirrors
   * reolink_aio's `set_status_led`.
   *
   * @param channel - Channel number (0-based)
   * @param patch - `irState` ("On" | "Off" | "Auto"), `lightState`
   *   (status LED), `doorbellLightState`, `irBrightness` (0..255).
   *   Camera-side accepts lowercase strings (`open`/`close`); the
   *   helper normalizes from the friendly variants.
   */
  async setIrLights(
    channel: number,
    patch: {
      irState?: "On" | "Off" | "Auto" | string;
      lightState?: "On" | "Off" | string;
      doorbellLightState?: "On" | "Off" | string;
      irBrightness?: number;
    },
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const timeoutOpts =
      options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {};

    let xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_LED_STATE,
      channel: ch,
      ...timeoutOpts,
    });

    if (patch.lightState !== undefined) {
      xml = applyXmlTagPatch(
        xml,
        "lightState",
        patch.lightState === "On" ? "open" : "close",
      );
    }
    if (patch.doorbellLightState !== undefined) {
      xml = applyXmlTagPatch(
        xml,
        "doorbellLightState",
        normalizeOpenClose(patch.doorbellLightState),
      );
    }
    if (patch.irState !== undefined) {
      const v = String(patch.irState);
      const out = v === "Off" ? "close" : v.toLowerCase();
      xml = applyXmlTagPatch(xml, "state", out);
    }
    if (patch.irBrightness !== undefined) {
      xml = applyXmlTagPatch(xml, "IRLedBrightness", patch.irBrightness);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_LED_STATE,
      channel: ch,
      payloadXml: ensureXmlHeader(xml),
      ...timeoutOpts,
    });
  }

  /**
   * SetAudioCfg via Baichuan (cmdId=265, read via cmdId=264). Patches
   * volume / talk-and-reply / visitor settings. Mirrors reolink_aio's
   * `SetAudioCfg`.
   */
  async setAudioCfg(
    channel: number,
    patch: {
      volume?: number;
      talkAndReplyVolume?: number;
      visitorVolume?: number;
      visitorLoudspeaker?: number;
    },
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const timeoutOpts =
      options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {};

    let xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_AUDIO_CFG,
      channel: ch,
      ...timeoutOpts,
    });

    xml = applyXmlTagPatch(xml, "volume", patch.volume);
    xml = applyXmlTagPatch(
      xml,
      "talkAndReplyVolume",
      patch.talkAndReplyVolume,
    );
    xml = applyXmlTagPatch(xml, "visitorVolume", patch.visitorVolume);
    xml = applyXmlTagPatch(xml, "visitorLoudspeaker", patch.visitorLoudspeaker);

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_AUDIO_CFG,
      channel: ch,
      payloadXml: ensureXmlHeader(xml),
      ...timeoutOpts,
    });
  }

  /**
   * GetMask (privacy mask) via Baichuan (cmdId=52). Returns the
   * `<Shelter>` block — `enable` flag + `shelterList`. Mirrors
   * reolink_aio's `GetMask`.
   */
  async getMask(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<MaskConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_PRIVACY_MASK,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<MaskConfig>(xml);
  }

  /**
   * SetMask (privacy mask) via Baichuan (cmdId=53, read via cmdId=52).
   * Toggles the `<Shelter><enable>` flag. Mirrors reolink_aio's
   * `SetMask` (which only touches enable too — shelter zone editing
   * goes through a separate flow).
   */
  async setMask(
    channel: number,
    patch: { enable?: 0 | 1 | boolean },
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const timeoutOpts =
      options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {};

    let xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PRIVACY_MASK,
      channel: ch,
      ...timeoutOpts,
    });

    if (patch.enable !== undefined) {
      xml = applyXmlTagPatch(xml, "enable", patch.enable ? 1 : 0);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_PRIVACY_MASK,
      channel: ch,
      payloadXml: ensureXmlHeader(xml),
      ...timeoutOpts,
    });
  }

  /**
   * GetAudioNoise via Baichuan (cmdId=439). Reads `enable` + `level`
   * from the aiDenoise block. Mirrors reolink_aio's `GetAudioNoise`.
   *
   * Note: `getAiDenoise` already returns the same payload typed as
   * `AiDenoiseConfig`. This getter exists for naming parity with
   * reolink_aio + the reolink CGI.
   */
  async getAudioNoise(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<AudioNoiseConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AI_DENOISE,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<AudioNoiseConfig>(xml);
  }

  /**
   * SetAudioNoise via Baichuan (cmdId=440, read via cmdId=439).
   * Mirrors reolink_aio's `SetAudioNoise` — `level <= 0` flips the
   * enable flag off; positive values turn it on and update the level.
   */
  async setAudioNoise(
    channel: number,
    level: number,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const timeoutOpts =
      options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {};

    let xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_AI_DENOISE,
      channel: ch,
      ...timeoutOpts,
    });

    xml = applyXmlTagPatch(xml, "enable", level > 0 ? 1 : 0);
    if (level > 0) {
      xml = applyXmlTagPatch(xml, "level", level);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_AI_DENOISE,
      channel: ch,
      payloadXml: ensureXmlHeader(xml),
      ...timeoutOpts,
    });
  }

  /**
   * GetAutoFocus via Baichuan (cmdId=224). Returns the `<AutoFocus>`
   * block — only `disable` (0 = AF on, 1 = AF off). Mirrors
   * reolink_aio's `GetAutoFocus`.
   */
  async getAutoFocus(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<AutoFocusConfig> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AUTO_FOCUS,
      channel: ch,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<AutoFocusConfig>(xml);
  }

  /**
   * SetAutoFocus via Baichuan (cmdId=225). Mirrors reolink_aio's
   * `SetAutoFocus`. Note: write-only command — the payload is built
   * from scratch (no read-modify-write needed).
   */
  async setAutoFocus(
    channel: number,
    disable: 0 | 1 | boolean,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const disableVal = disable ? 1 : 0;
    // The Reolink Client wire-frames cmd_id=225 with the channel-extension
    // envelope in front of the encrypted `<AutoFocus>` body. Older releases
    // here sent only the body — the camera then replied 200 but never
    // actually applied the toggle (confirmed via pcap on E1 Zoom, cmd 225
    // c2s frames carry a 104-byte `<Extension>` prefix). Mirror the
    // client's framing so the SET sticks.
    const extensionXml = buildChannelExtensionXml(ch);
    const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<AutoFocus version="1.1">
<channelId>${ch}</channelId>
<disable>${disableVal}</disable>
</AutoFocus>
</body>`;
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_AUTO_FOCUS,
      channel: ch,
      extensionXml,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
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
   * @param filenameOrVodFile - Filename string or VodFile object from getVideoclips
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
   * @param filename - Filename from getVideoclips or prepareNvrVodDownload
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

  // ====================================================================
  // CGI Videoclips Passthrough Methods
  // These methods use HTTP/CGI instead of native Baichuan protocol
  // ====================================================================

  /**
   * Search video clips using CGI API (HTTP).
   * Alternative to native getVideoclips() that uses HTTP instead of Baichuan protocol.
   * May be more reliable on some devices.
   *
   * @param params - Search parameters
   * @returns Array of RecordingFile objects
   */
  async getVideoclipsCgi(
    params: CgiGetVideoclipsParams,
  ): Promise<RecordingFile[]> {
    await this.cgiApi.login();
    return await this.cgiApi.getVideoclips(params);
  }

  /**
   * Extract thumbnail from a video clip using CGI API (HTTP + ffmpeg).
   * Alternative to native getVideoclipThumbnailJpeg() that uses HTTP VOD instead of CoverPreview.
   * May be more reliable on some devices.
   *
   * @param params - Parameters for thumbnail extraction
   * @returns JPEG buffer
   */
  async getVideoclipThumbnailJpegCgi(params: {
    /** Channel number (0-based) */
    channel: number;
    /** Recording filename or VodFile object */
    filename: string | VodFile;
    /** Path to ffmpeg executable */
    ffmpegPath: string;
    /** Timeout in milliseconds (default: 30000) */
    timeoutMs?: number;
    /** Seek position in seconds (default: 0) */
    seekSeconds?: number;
  }): Promise<Buffer> {
    await this.cgiApi.login();
    return await this.cgiApi.getVideoclipThumbnailJpeg(params);
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

  /**
   * Update the OSD timestamp + channel-name overlay via cmd_id=45
   * (SetOsdDatetime). The schema is the same `<body><OsdDatetime>` +
   * `<OsdChannelName>` block returned by `getOsdDatetime` — we
   * read-modify-write so any extension fields the camera sent are
   * preserved.
   *
   * Position is in **camera pixel coordinates** (e.g. (1,1) for top-left,
   * not preset strings). Set `enable=0` to hide the overlay; the camera
   * keeps the stored position so re-enabling later restores it.
   */
  async setOsdDatetime(
    channel: number,
    patch: {
      datetime?: {
        enable?: boolean | 0 | 1;
        topLeftX?: number;
        topLeftY?: number;
        language?: string;
      };
      channelName?: {
        name?: string;
        enable?: boolean | 0 | 1;
        topLeftX?: number;
        topLeftY?: number;
        enWatermark?: boolean | 0 | 1;
        enBgcolor?: boolean | 0 | 1;
      };
    },
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const timeoutOpts =
      options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {};
    let xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_OSD_DATETIME,
      channel: ch,
      ...timeoutOpts,
    });

    const patchBlock = (block: "OsdDatetime" | "OsdChannelName", fields: Record<string, unknown>) => {
      const start = xml.indexOf(`<${block}`);
      if (start < 0) return;
      const end = xml.indexOf(`</${block}>`, start);
      if (end < 0) return;
      let body = xml.slice(start, end);
      for (const [tag, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const raw =
          typeof value === "boolean" ? (value ? "1" : "0") : String(value);
        const escaped = raw
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        if (body.includes(`<${tag}>`)) {
          body = body.replace(
            new RegExp(`<${tag}>[^<]*<\\/${tag}>`),
            `<${tag}>${escaped}</${tag}>`,
          );
        } else {
          // Tag wasn't in the GET response — append it just before </block>.
          body += `<${tag}>${escaped}</${tag}>`;
        }
      }
      xml = xml.slice(0, start) + body + xml.slice(end);
    };

    if (patch.datetime) {
      patchBlock("OsdDatetime", {
        enable: patch.datetime.enable,
        topLeftX: patch.datetime.topLeftX,
        topLeftY: patch.datetime.topLeftY,
        language: patch.datetime.language,
      });
    }
    if (patch.channelName) {
      patchBlock("OsdChannelName", {
        name: patch.channelName.name,
        enable: patch.channelName.enable,
        topLeftX: patch.channelName.topLeftX,
        topLeftY: patch.channelName.topLeftY,
        enWatermark: patch.channelName.enWatermark,
        enBgcolor: patch.channelName.enBgcolor,
      });
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_OSD_DATETIME,
      channel: ch,
      payloadXml: ensureXmlHeader(xml),
      ...timeoutOpts,
    });
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

  /**
   * Return the set of values `setEnc` will accept on each stream of `channel`.
   * Aggregates `getStreamInfoList` (cmd_146) into a UI-friendly shape:
   * per-stream resolutions with their allowed codecs/framerates/bitrates plus
   * the enumerated encoder modes/profiles Reolink exposes.
   *
   * Useful for populating selectors and validating user input before calling
   * `setEnc` — picking an unsupported combination causes the camera to reject
   * the SET_ENC command (responseCode != 200).
   */
  async getEncOptions(
    channel: number,
    options?: { timeoutMs?: number },
  ): Promise<EncOptions> {
    const list = await this.getStreamInfoList(channel, options);
    const built = buildEncOptions(list, channel);

    // Firmware exposes only `defaultGop` per resolution in cmd_146.
    // The actual valid {cur, min, max} lives in the <Compression>
    // block of cmd_56 — fetch it best-effort and graft the per-stream
    // range onto the options reply so UI consumers can populate a single
    // GOP slider without a second round-trip.
    try {
      const enc = await this.getEnc(channel, options);
      const compression = enc.body?.Compression;
      const mergeGop = (
        target: EncStreamOptions | undefined,
        stream: CompressionStream | undefined,
      ): void => {
        if (!target || !stream) return;
        const g = stream.gop as
          | { cur?: number; min?: number; max?: number }
          | undefined;
        if (!g) return;
        target.gopRange = {
          ...(g.cur !== undefined ? { cur: g.cur } : {}),
          ...(g.min !== undefined ? { min: g.min } : {}),
          ...(g.max !== undefined ? { max: g.max } : {}),
        };
      };
      mergeGop(built.mainStream, compression?.mainStream);
      mergeGop(built.subStream, compression?.subStream);
      mergeGop(built.thirdStream, compression?.thirdStream);
    } catch {
      // getEnc failures shouldn't break the options reply — the consumer
      // can still rely on defaultGop per resolution.
    }

    return built;
  }

  /**
   * Read the camera's `<VersionInfo>` block (cmd_id=80). Returns the
   * friendly name, model code (e.g. `"E1 Zoom"`), serial number, firmware
   * version, hardware revision, build day, AI model bundle version, etc.
   *
   * This is the same info the Reolink mobile app shows in "About this
   * device" — distinct from `getSystemGeneral` (cmd_104) which carries
   * time/locale.
   *
   * No channel parameter: this command is device-global on NVRs/Hubs and
   * camera-global on standalone cameras. Pass an explicit channel via the
   * underlying `sendXml` only if a specific firmware demands it (none we've
   * tested do).
   */
  async getVersionInfo(
    options?: { timeoutMs?: number },
  ): Promise<BaichuanVersionInfo> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_VERSION_INFO,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseVersionInfo(xml);
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
  ): Promise<FtpTaskConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_FTP_TASK,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<FtpTaskConfig>(xml);
  }

  async getHddInfoList(options?: {
    timeoutMs?: number;
  }): Promise<HddInfoListConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_HDD_INFO_LIST,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<HddInfoListConfig>(xml);
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
  ): Promise<EmailTaskConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_EMAIL_TASK,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseEmailTaskFromXml(xml);
  }

  /**
   * SetEmailTask via Baichuan (cmdId=216). Updates the email alarm schedule
   * (per-event-type 7×24 valueTable + master enable).
   *
   * Reolink expects the FULL `typeScheduleList` — pass the array from a prior
   * GET and only flip the entries you care about. Slots you don't track must
   * be sent back unchanged to avoid the camera dropping them.
   */
  async setEmailTask(
    channel: number | undefined,
    task: EmailTaskConfig,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildSetEmailTaskXml({ ...task, channelId: ch });
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_EMAIL_TASK,
      channel: ch,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * Convenience wrapper that patches the schedule of one or more trigger
   * types on the camera's EmailTask without touching the others.
   *
   * Pass a high-level schedule spec (`always` / `never` / explicit windows)
   * and the trigger types it should apply to. The method:
   *
   * 1. Reads the current EmailTask via GET (so we keep every existing slot).
   * 2. Builds the new `valueTable` once from `schedule`.
   * 3. Replaces the `valueTable` of every matching `type` in the list.
   * 4. Appends entries for any requested type not already present.
   * 5. Writes the merged list back via SET.
   *
   * Returns the list of types that were actually touched.
   */
  async patchEmailSchedule(
    channel: number | undefined,
    spec: {
      types: string[];
      schedule:
        | { kind: "always" }
        | { kind: "never" }
        | {
            kind: "windows";
            windows: Array<{
              days: number[];
              startHour: number;
              endHour: number;
            }>;
          };
      /** When provided, also flips the EmailTask master `enable` flag. */
      enable?: 0 | 1;
    },
    options?: { timeoutMs?: number },
  ): Promise<{ touchedTypes: string[] }> {
    const current = await this.getEmailTask(channel, options);
    const newValueTable = buildEmailScheduleValueTable(spec.schedule);
    const targetSet = new Set(spec.types);
    const touched: string[] = [];

    const updatedList = current.typeScheduleList.map((item) => {
      if (targetSet.has(item.type)) {
        touched.push(item.type);
        return { ...item, valueTable: newValueTable };
      }
      return item;
    });

    for (const t of spec.types) {
      if (!current.typeScheduleList.some((item) => item.type === t)) {
        updatedList.push({ type: t, valueTable: newValueTable });
        touched.push(t);
      }
    }

    await this.setEmailTask(
      channel,
      {
        channelId: current.channelId,
        enable: spec.enable ?? current.enable,
        typeScheduleList: updatedList,
      },
      options,
    );

    return { touchedTypes: touched };
  }

  // ====================================================================
  // Email server (cmdId 42/43/141), NTP (38/39), DST (106/107),
  // SystemGeneral SET (105), AutoReboot (100/101).
  // Schemas derived from Reolink Client pcap (2026-05-16).
  // ====================================================================

  /**
   * Read the SMTP email configuration (cmdId=42). Returns the full `<Email>`
   * block including capability hints (`senderMaxLen`, `pwdMaxLen`,
   * `emailAttachAbility`).
   */
  async getEmail(options?: { timeoutMs?: number }): Promise<EmailConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_EMAIL,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseEmailConfigFromXml(xml);
  }

  /**
   * Patch the SMTP email configuration (cmdId=43). Reads the current config
   * first then merges the patch — Reolink rejects partial `<Email>` blocks.
   */
  async setEmail(
    patch: EmailConfigPatch,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const current = await this.getEmail(options);
    const payloadXml = buildSetEmailXml(current, patch);
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_EMAIL,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * Send a test email using either the current config or an override patch
   * (cmdId=141). Returns true when the camera reports 200 (test succeeded),
   * false when it reports 482 (test failed — server unreachable / bad creds).
   * Other non-200 codes propagate as exceptions via `sendXml`.
   */
  async testEmail(
    patch?: EmailConfigPatch,
    options?: { timeoutMs?: number },
  ): Promise<boolean> {
    const current = await this.getEmail(options);
    const payloadXml = buildSetEmailXml(current, patch ?? {});
    // testEmail makes the camera perform a real SMTP send (TCP connect +
    // EHLO + AUTH + DATA + QUIT). On slow networks or unreachable mail
    // servers this can take 30+ seconds — the default Baichuan timeout
    // (~5s) is far too aggressive. Default to 60s and let callers override.
    const timeoutMs = options?.timeoutMs ?? 60_000;
    try {
      await this.sendXml({
        cmdId: BC_CMD_ID_TEST_EMAIL,
        payloadXml,
        timeoutMs,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Reolink uses response_code=482 specifically for "test failed" — keep
      // it as a structured boolean rather than throwing, so callers can show
      // a friendly "test failed, check credentials" message.
      if (msg.includes("response_code 482") || msg.includes("response_code=482")) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Read the NTP server configuration (cmdId=38).
   */
  async getNtp(options?: { timeoutMs?: number }): Promise<NtpConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_NTP,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseNtpConfigFromXml(xml);
  }

  /**
   * Patch the NTP server configuration (cmdId=39). Reads the current state
   * first and merges the patch — Reolink rejects partial `<Ntp>` blocks.
   */
  async setNtp(
    patch: NtpConfigPatch,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const current = await this.getNtp(options);
    const payloadXml = buildSetNtpXml(current, patch);
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_NTP,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * Patch SystemGeneral (cmdId=105). Supports partial payloads: include only
   * the fields you want to change. By default the builder emits `<year>0</year>`
   * as the "do not set manual clock" marker; pass `manualTime` to actually
   * set the date/time. Setting only `deviceName` automatically uses the
   * Reolink Client's `deviceNameOnly=1` shape.
   */
  async setSystemGeneral(
    patch: SystemGeneralPatch,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const payloadXml = buildSetSystemGeneralXml(patch);
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_SYSTEM_GENERAL,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * Read the Daylight Saving Time configuration (cmdId=106).
   */
  async getDst(options?: { timeoutMs?: number }): Promise<DstConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_DST,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseDstConfigFromXml(xml);
  }

  /**
   * Patch the DST configuration (cmdId=107). Reads the current state first
   * and merges the patch.
   */
  async setDst(
    patch: DstConfigPatch,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const current = await this.getDst(options);
    const payloadXml = buildSetDstXml(current, patch);
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_DST,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * Read the auto-reboot schedule (cmdId=101).
   */
  async getAutoReboot(options?: {
    timeoutMs?: number;
  }): Promise<AutoRebootConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_AUTO_REBOOT,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseAutoRebootFromXml(xml);
  }

  /**
   * Patch the auto-reboot schedule (cmdId=100).
   */
  async setAutoReboot(
    patch: AutoRebootConfigPatch,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const current = await this.getAutoReboot(options);
    const payloadXml = buildSetAutoRebootXml(current, patch);
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_AUTO_REBOOT,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /**
   * High-level helper that configures the camera to deliver motion alerts via
   * SMTP to the local nodelink manager. Orchestrates `setEmail` + `setEmailTask`
   * in a single call so UI code can offer "auto-configure" without juggling
   * the underlying commands.
   *
   * Pass `runTest: true` to also send a test email (cmdId=141). Returns a
   * structured result describing each leg of the flow so the caller can show
   * granular feedback.
   *
   * @param params Auto-configuration parameters
   * @param channel Logical channel (default 0). Used for the EmailTask SET.
   */
  async setupEmailPushToManager(
    params: {
      /** Manager hostname or IP reachable from the camera's network. */
      managerHost: string;
      /** Manager SMTP port. Default 2525. */
      managerPort?: number;
      /** Per-camera recipient local-part — typically `cam-<cameraId>`. */
      recipientLocalPart: string;
      /** Virtual mail domain (must match the server-side setting). */
      domain?: string;
      /** Attachment kind on motion. Default "picture". */
      attachmentType?: "picture" | "video" | "none";
      /** Optional sender nickname shown in the From header. */
      sendNickname?: string;
      /** Interval throttle in seconds (ignored on battery cams). Default 30. */
      interval?: number;
      /** Optional SMTP auth — required when the server's `requireAuth` is on. */
      authUsername?: string;
      authPassword?: string;
      /**
       * Trigger types to enable in the email schedule. Must match the types
       * already present in the current EmailTask (we patch their schedule to
       * full-week 24/7, leaving any other slot untouched).
       */
      triggerTypes?: string[];
      /** Send a test email after the SET. Default false. */
      runTest?: boolean;
    },
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<{
    setEmail: { applied: true };
    setEmailTask: { applied: true; touchedTypes: string[] };
    testEmail?: { success: boolean };
  }> {
    const port = params.managerPort ?? 2525;
    const domain = params.domain ?? "nodelink.local";
    const recipient = `${params.recipientLocalPart}@${domain}`;
    const triggers = params.triggerTypes ?? ["MD", "people", "vehicle"];
    const attachmentType = params.attachmentType ?? "picture";
    const interval = params.interval ?? 30;

    const emailPatch: EmailConfigPatch = {
      smtpServer: params.managerHost,
      smtpPort: port,
      userName: params.authUsername ?? recipient,
      password: params.authPassword ?? "",
      address1: recipient,
      address2: "",
      address3: "",
      sendNickname: params.sendNickname ?? params.recipientLocalPart,
      attachment: attachmentType === "none" ? 0 : 1,
      attachmentType,
      textType: "withText",
      ssl: 0,
      interval,
    };

    await this.setEmail(emailPatch, options);

    // EmailTask: patch the schedule for the requested triggers to 24/7 ON,
    // leave any other type unchanged.
    const fullWeekOn = "1".repeat(168);
    const current = await this.getEmailTask(channel, options);
    const triggerSet = new Set(triggers);
    const touched: string[] = [];
    const updatedList = current.typeScheduleList.map((item) => {
      if (triggerSet.has(item.type)) {
        touched.push(item.type);
        return { ...item, valueTable: fullWeekOn };
      }
      return item;
    });

    // Append any requested trigger that wasn't already in the camera's list
    // (the camera will silently ignore unknown types on most firmwares, but
    // including them is correct on those that DO recognise extra slots).
    for (const t of triggers) {
      if (!current.typeScheduleList.some((item) => item.type === t)) {
        updatedList.push({ type: t, valueTable: fullWeekOn });
        touched.push(t);
      }
    }

    await this.setEmailTask(
      channel,
      {
        channelId: current.channelId,
        enable: 1,
        typeScheduleList: updatedList,
      },
      options,
    );

    const result: {
      setEmail: { applied: true };
      setEmailTask: { applied: true; touchedTypes: string[] };
      testEmail?: { success: boolean };
    } = {
      setEmail: { applied: true },
      setEmailTask: { applied: true, touchedTypes: touched },
    };

    if (params.runTest) {
      const ok = await this.testEmail(emailPatch, options);
      result.testEmail = { success: ok };
    }

    return result;
  }

  /**
   * Get siren-on-motion state via AudioTask (cmdId=232).
   *
   * This is the command the Reolink app uses to get motion alarm/siren enable state.
   * Returns AudioTask with enable=1 (siren on motion enabled) or enable=0 (disabled).
   *
   * Note: This is different from getMotionAlarm (cmdId=46) which controls motion detection recording.
   * This controls whether the siren/notification sounds when motion is detected.
   *
   * @example
   * ```ts
   * const result = await api.getSirenOnMotion(0);
   * // Returns: AudioTask with enable, typeScheduleList
   * ```
   */
  async getSirenOnMotion(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<AudioTaskConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AUDIO_TASK,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<AudioTaskConfig>(xml);
  }

  async getAudioCfg(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<AudioCfgConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AUDIO_CFG,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<AudioCfgConfig>(xml);
  }

  async getDayNightThreshold(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<DayNightThresholdConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_DAY_NIGHT_THRESHOLD,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<DayNightThresholdConfig>(xml);
  }

  async getTimelapseCfg(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<TimelapseCfgConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_TIMELAPSE_CFG,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<TimelapseCfgConfig>(xml);
  }

  async getAiDenoise(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<AiDenoiseConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AI_DENOISE,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<AiDenoiseConfig>(xml);
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
  ): Promise<RecEncConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_REC_ENC_CFG,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<RecEncConfig>(xml);
  }

  async getAccessUserList(options?: {
    timeoutMs?: number;
  }): Promise<AccessUserListConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_ACCESS_USER_LIST,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<AccessUserListConfig>(xml);
  }

  /**
   * Get list of active/online user sessions (cmdId=120).
   * Returns information about currently connected users/sessions on the device.
   */
  async getOnlineUserList(options?: {
    timeoutMs?: number;
  }): Promise<OnlineUserListConfig> {
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_ONLINE_USER_LIST,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<OnlineUserListConfig>(xml);
  }

  /**
   * Build the UI-friendly user sessions strings directly in the library.
   * This is intended for hosts (like Scrypted plugins) that want a stable, consistent
   * sessions view without re-implementing parsing/formatting logic.
   */
  async getOnlineUserSessionsForUi(options?: {
    timeoutMs?: number;
  }): Promise<string[]> {
    const sessions = await this.getOnlineUserList(options);

    let socketSessionId: string | undefined;
    try {
      socketSessionId = (this.client as any)?.getSocketSessionId?.();
    } catch {
      // ignore
    }

    const out: string[] = [];
    out.push(`Last updated: ${new Date().toLocaleString()}`);
    if (socketSessionId) {
      out.push(`Current socket session ID: ${socketSessionId}`);
    }

    try {
      const summary = this.getDedicatedSessionsSummary();
      out.push(`Internal dedicated sessions (active): ${summary.count}`);
      for (const key of summary.keys) {
        out.push(`  - ${key}`);
      }
    } catch {
      // ignore
    }

    out.push("");

    const looksLikeUserSession = (value: any): boolean => {
      if (!value || typeof value !== "object") return false;
      const hasUser =
        value.userName !== undefined ||
        value.user !== undefined ||
        value.username !== undefined;
      const hasIp = value.ip !== undefined || value.ipAddress !== undefined;
      const hasPort = value.port !== undefined;
      const hasSessionId = value.sessionId !== undefined;
      const hasId = value.id !== undefined;

      return (
        (hasUser && (hasIp || hasPort)) ||
        (hasSessionId && (hasUser || hasIp || hasPort)) ||
        (hasId && (hasUser || hasIp || hasPort))
      );
    };

    const seen = new Set<string>();
    const keyFor = (session: any, group?: string): string => {
      const user = session?.userName ?? session?.user ?? session?.username;
      const ip = session?.ip ?? session?.ipAddress;
      const port = session?.port;
      const sessionId = session?.sessionId;
      const id = session?.id;
      return `${group ?? ""}|u:${String(user ?? "")}@${String(ip ?? "")}:${String(
        port ?? "",
      )}|sid:${String(sessionId ?? "")}|id:${String(id ?? "")}`;
    };

    const collected: Array<{ session: any; group?: string }> = [];
    const collect = (data: any, group?: string): void => {
      if (!data) return;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (looksLikeUserSession(item)) {
            const k = keyFor(item, group);
            if (!seen.has(k)) {
              seen.add(k);
              collected.push(
                group ? { session: item, group } : { session: item },
              );
            }
          } else if (item && typeof item === "object") {
            collect(item, group);
          }
        }
        return;
      }
      if (typeof data !== "object") return;

      let foundNested = false;
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) {
          foundNested = true;
          collect(v, k);
        } else if (v && typeof v === "object") {
          foundNested = true;
          collect(v, group);
        }
      }

      if (!foundNested && looksLikeUserSession(data)) {
        const k = keyFor(data, group);
        if (!seen.has(k)) {
          seen.add(k);
          collected.push(group ? { session: data, group } : { session: data });
        }
      }
    };

    const format = (session: any, index: number, group?: string): string => {
      const parts: string[] = [];
      if (group) parts.push(`[${group}]`);
      parts.push(`Session ${index}:`);

      if (session.userName !== undefined)
        parts.push(`User: ${session.userName}`);
      if (session.user !== undefined) parts.push(`User: ${session.user}`);
      if (session.ip !== undefined) parts.push(`IP: ${session.ip}`);
      if (session.ipAddress !== undefined)
        parts.push(`IP: ${session.ipAddress}`);
      if (session.port !== undefined) parts.push(`Port: ${session.port}`);
      if (session.sessionId !== undefined)
        parts.push(`Session ID: ${session.sessionId}`);
      if (session.id !== undefined) parts.push(`ID: ${session.id}`);
      if (session.loginTime !== undefined)
        parts.push(`Login Time: ${session.loginTime}`);
      if (session.time !== undefined) parts.push(`Time: ${session.time}`);
      if (session.status !== undefined) parts.push(`Status: ${session.status}`);

      if (parts.length === (group ? 2 : 1)) {
        if (session && typeof session === "object") {
          const allFields = Object.entries(session)
            .filter(([, v]) => v === null || typeof v !== "object")
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          if (allFields) parts.push(allFields);
        }
      }

      return parts.join(" | ");
    };

    collect(sessions);

    // Log raw data to console for debugging
    // Note: XML parsing may return a single object instead of array when there's only 1 item
    const onlineUserList = sessions.body?.OnlineUserList;
    const rawCurrent = onlineUserList?.OnlineUser;
    const rawLegacy = onlineUserList?.item;
    const currentItems = Array.isArray(rawCurrent)
      ? rawCurrent
      : rawCurrent
        ? [rawCurrent]
        : [];
    const legacyItems = Array.isArray(rawLegacy)
      ? rawLegacy
      : rawLegacy
        ? [rawLegacy]
        : [];
    const sessionIds = currentItems
      .map((s) => `${s.sessionId}@${s.ipAddress}`)
      .join(", ");
    const legacyIds = legacyItems
      .map((s) => `${s.sessionId}@${s.ip}`)
      .join(", ");
    this.logger.log?.(
      `[ReolinkBaichuanApi] getOnlineUserSessionsForUi: legacyItems=${legacyItems.length}, currentItems=${currentItems.length} [${sessionIds || legacyIds || "none"}]`,
    );

    let count = 0;
    for (const entry of collected) {
      out.push(format(entry.session, ++count, entry.group));
    }
    if (count === 0) out.push("No active sessions found");
    return out;
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

  /**
   * Get video input settings and advanced configuration.
   *
   * @returns VideoInput + InputAdvanceCfg - brightness, contrast, exposure, etc.
   * @example
   * ```ts
   * const result = await api.getVideoInput(0);
   * // Returns: VideoInput with bright, contrast, etc.
   * ```
   */
  async getVideoInput(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<VideoInputConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_VIDEO_INPUT,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<VideoInputConfig>(xml);
  }

  /**
   * Get system general settings (time, name, language).
   *
   * @returns SystemGeneral + Norm - timezone, deviceName, language, etc.
   * @example
   * ```ts
   * const result = await api.getSystemGeneral();
   * // Returns: SystemGeneral with timeZone, deviceName, etc.
   * ```
   */
  async getSystemGeneral(options?: {
    timeoutMs?: number;
  }): Promise<SystemGeneralConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_SYSTEM_GENERAL,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseSystemGeneralFromXml(xml);
  }

  /**
   * Get device support/capability flags.
   *
   * @returns Support - ptzMode, channelNum, wifi flags, rtsp, rtmp, etc.
   * @example
   * ```ts
   * const result = await api.getSupport();
   * // Returns: Support with ptzMode, channelNum, wifi, rtsp, etc.
   * ```
   */
  async getSupport(options?: { timeoutMs?: number }): Promise<SupportConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_SUPPORT,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<SupportConfig>(xml);
  }

  /**
   * Get AI configuration (smart tracking, detection types).
   *
   * @returns AiCfg - smartTrack, detectType, trackPriorities, etc.
   * @example
   * ```ts
   * const result = await api.getAiCfg(0);
   * // Returns: AiCfg with smartTrack, detectType, etc.
   * ```
   */
  async getAiCfg(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<AiConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_AI_CFG,
      ...(channel != null ? { channel } : {}),
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<AiConfig>(xml);
  }

  /**
   * Get autotracking (smart track) state.
   *
   * Uses cmdId=299 (AiCfg) to retrieve the autotracking configuration.
   * The smartTrack field (0=off, 1=on) controls whether the camera automatically
   * pans/tilts to follow detected objects.
   *
   * @param channel - Optional channel ID (default: 0)
   * @returns Object with enabled (boolean) and raw AiCfg data
   * @example
   * ```ts
   * const result = await api.getAutotracking(0);
   * console.log("Autotracking enabled:", result.enabled);
   * console.log("Tracking mode:", result.smartTrackMode);
   * ```
   */
  async getAutotracking(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<{
    enabled: boolean;
    smartTrack: number;
    smartTrackMode?: number | undefined;
    smartTrackType?: string | undefined;
    detectType?: string | undefined;
    raw: AiConfig;
  }> {
    const aiCfg = await this.getAiCfg(channel, options);
    const cfg = (aiCfg as any)?.body?.AiCfg ?? (aiCfg as any)?.AiCfg ?? aiCfg;
    const smartTrack = Number(cfg?.smartTrack ?? 0);
    return {
      enabled: smartTrack === 1,
      smartTrack,
      smartTrackMode:
        cfg?.smartTrackMode != null ? Number(cfg.smartTrackMode) : undefined,
      smartTrackType: cfg?.smartTrackType ?? undefined,
      detectType: cfg?.detectType ?? undefined,
      raw: aiCfg,
    };
  }

  /**
   * Set autotracking (smart track) state via AiCfg (cmdId=300).
   *
   * This controls the auto pan-tilt tracking feature on PTZ cameras.
   * When enabled, the camera will automatically track detected objects (people, pets, vehicles).
   *
   * @param enabled - Whether to enable (true/1) or disable (false/0) autotracking
   * @param channel - Optional channel ID (default: 0)
   * @example
   * ```ts
   * // Enable autotracking
   * await api.setAutotracking(true, 0);
   * // Disable autotracking
   * await api.setAutotracking(false, 0);
   * ```
   */
  async setAutotracking(
    enabled: boolean | 0 | 1,
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const ch = channel ?? 0;
    const smartTrack = enabled ? 1 : 0;

    // First get the current AiCfg to preserve other settings
    const currentCfg = await this.getAiCfg(ch, options);
    const cfg =
      (currentCfg as any)?.body?.AiCfg ?? (currentCfg as any)?.AiCfg ?? {};

    // Build the XML payload with the updated smartTrack value
    const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<AiCfg version="1.1">
<channelId>${ch}</channelId>
<smartTrack>${smartTrack}</smartTrack>
${cfg.smartTrackMode != null ? `<smartTrackMode>${cfg.smartTrackMode}</smartTrackMode>` : ""}
${cfg.detectType ? `<detectType>${cfg.detectType}</detectType>` : ""}
${cfg.smartTrackType ? `<smartTrackType>${cfg.smartTrackType}</smartTrackType>` : ""}
</AiCfg>
</body>`;

    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_SET_AI_CFG,
      channel: ch,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  /**
   * Set autotracking settings (smartTrackType, delays, etc.) via AiCfg (cmdId=300).
   *
   * This allows configuring autotracking parameters without changing the enable state.
   *
   * @param channel - Channel ID (default: 0)
   * @param settings - Autotracking settings to apply
   * @example
   * ```ts
   * await api.setAutotrackingSettings(0, {
   *   smartTrackType: 'people,vehicle',
   *   smartTrackObjectStopDelay: 30,
   *   smartTrackObjectDisappearDelay: 15,
   * });
   * ```
   */
  async setAutotrackingSettings(
    channel: number | undefined,
    settings: {
      smartTrackType?: string;
      smartTrackObjectStopDelay?: number;
      smartTrackObjectDisappearDelay?: number;
    },
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const ch = channel ?? 0;

    // First get the current AiCfg to preserve other settings
    const currentCfg = await this.getAiCfg(ch, options);
    const cfg =
      (currentCfg as any)?.body?.AiCfg ?? (currentCfg as any)?.AiCfg ?? {};

    // Merge with current values
    const smartTrackType = settings.smartTrackType ?? cfg.smartTrackType;
    const stopDelay =
      settings.smartTrackObjectStopDelay ?? cfg.smartTrackObjectStopDelay ?? 20;
    const disappearDelay =
      settings.smartTrackObjectDisappearDelay ??
      cfg.smartTrackObjectDisappearDelay ??
      10;

    // Build the XML payload with updated settings
    const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<AiCfg version="1.1">
<channelId>${ch}</channelId>
<smartTrack>${cfg.smartTrack ?? 0}</smartTrack>
${cfg.smartTrackMode != null ? `<smartTrackMode>${cfg.smartTrackMode}</smartTrackMode>` : ""}
${cfg.detectType ? `<detectType>${cfg.detectType}</detectType>` : ""}
${smartTrackType ? `<smartTrackType>${smartTrackType}</smartTrackType>` : ""}
<smartTrackObjectStopDelay>${stopDelay}</smartTrackObjectStopDelay>
<smartTrackObjectDisappearDelay>${disappearDelay}</smartTrackObjectDisappearDelay>
</AiCfg>
</body>`;

    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_SET_AI_CFG,
      channel: ch,
      payloadXml,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson(xml);
  }

  /**
   * Get siren status (for cameras with siren capability).
   *
   * @returns SirenStatusList - status of siren alarm
   */
  async getSirenStatus(options?: {
    timeoutMs?: number;
  }): Promise<SirenStatusConfig> {
    const xml = await this.sendPcapDerivedSettingsGetXml({
      cmdId: BC_CMD_ID_GET_SIREN_STATUS,
      ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
    return parseXmlFragmentToJson<SirenStatusConfig>(xml);
  }

  /**
   * Set siren-on-motion state via AudioTask (cmdId=231).
   *
   * This is the command the Reolink app uses to toggle siren/alarm on motion on/off.
   * cmdId=231 sends the AudioTask configuration with enable=0/1.
   *
   * Note: This is different from setMotionDetection (cmdId=47) which controls motion detection recording.
   * This controls whether the siren/notification sounds when motion is detected.
   *
   * @param audioTask - The siren-on-motion configuration to set (enable: 0 or 1)
   * @param channel - Optional channel ID (default: 0)
   * @example
   * ```ts
   * // Disable siren on motion
   * await api.setSirenOnMotion({ enable: 0 }, 0);
   * // Enable siren on motion
   * await api.setSirenOnMotion({ enable: 1 }, 0);
   * ```
   */
  async setSirenOnMotion(
    audioTask: {
      enable: 0 | 1;
      typeScheduleList?: Array<{
        type: string;
        valueTable: string;
      }>;
    },
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<XmlJsonValue> {
    const ch = channel ?? 0;
    const scheduleList = audioTask.typeScheduleList || [
      { type: "MD", valueTable: "1".repeat(168) },
      { type: "people", valueTable: "1".repeat(168) },
      { type: "dog_cat", valueTable: "1".repeat(168) },
    ];
    const scheduleItems = scheduleList
      .map(
        (item) =>
          `<item><type>${item.type}</type><valueTable>${item.valueTable}</valueTable></item>`,
      )
      .join("");

    const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<AudioTask version="1.1">
<channelId>${ch}</channelId>
<enable>${audioTask.enable}</enable>
<typeScheduleList>
${scheduleItems}
</typeScheduleList>
</AudioTask>
</body>`;

    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_SET_AUDIO_TASK,
      channel: ch,
      payloadXml,
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
    /** Optional logger override. If not provided, uses the API's logger. */
    logger?: Logger;
    /**
     * External identifier for the dedicated socket session.
     * When provided, a dedicated BaichuanClient is created/reused for this deviceId.
     * This allows switching between clips without interfering with other sessions.
     * Recommended: pass a unique identifier per logical device/player instance.
     */
    deviceId?: string;
    /**
     * Transcode H.265/HEVC to H.264/AVC for compatibility with clients that don't support H.265.
     * When true and the source is H.265, ffmpeg will transcode to H.264 using libx264.
     * This increases CPU usage but ensures playback on iOS Safari, older browsers, etc.
     * Default: false (passthrough/copy).
     */
    transcodeH265ToH264?: boolean;
    /**
     * Use MPEG-TS muxer to preserve frame timestamps (PTS).
     * When true, frames are muxed into MPEG-TS before being passed to ffmpeg.
     * This can help with variable framerate streams but may cause issues with some decoders.
     * Default: true (MPEG-TS muxing for proper timestamp alignment).
     */
    useMpegTsMuxer?: boolean;
  }): Promise<{
    mp4: Readable;
    stop: () => Promise<void>;
  }> {
    const logger = params.logger ?? this.logger;
    const useMpegTsMuxer = params.useMpegTsMuxer ?? true;

    // Extract duration and framerate from filename timestamps
    const parsed = parseRecordingFileName(params.fileName);
    const durationMs = parsed?.durationMs ?? 300_000; // Fallback: 5 minutes
    // Use framerate from filename hex flags, fallback to 15 fps (common for recordings)
    // NOTE: When useMpegTsMuxer=true, the MPEG-TS muxer uses actual PTS/DTS timestamps
    // from BcMedia frames, so this fps value is only used as fallback for raw mode.
    const fps =
      parsed?.framerate && parsed.framerate > 0 ? parsed.framerate : 15;
    // Add 10% buffer to ensure we get the complete clip
    const seconds = Math.ceil((durationMs / 1000) * 1.1);

    logger?.debug?.(
      `[createRecordingReplayMp4Stream] Starting: channel=${params.channel}, fileName=${params.fileName}, durationMs=${durationMs}, fps=${fps}, timeoutSec=${seconds}, deviceId=${params.deviceId ?? "auto"}, useMpegTsMuxer=${useMpegTsMuxer}`,
    );

    // NOTE: Replay streams now use the "general" socket (same as commands/events).
    // We do NOT force-close the socket on clip switches - instead, the streaming queue
    // serializes access and the previous stream is stopped cleanly before the new one starts.

    const startParams: Parameters<
      ReolinkBaichuanApi["startRecordingReplayStream"]
    >[0] = {
      channel: params.channel,
      fileName: params.fileName,
      logger,
      ...(params.isNvr != null ? { isNvr: params.isNvr } : {}),
      ...(params.deviceId != null ? { deviceId: params.deviceId } : {}),
    };

    // Use streaming queue - holds the slot until release() is called.
    // This serializes replay operations to avoid conflicts on the shared socket.
    // The abort signal is triggered when a new clip is requested, causing this stream to stop.
    const {
      result: replayResult,
      release: releaseQueueSlot,
      abortSignal,
    } = await this.enqueueStreamingReplayOperation(async () => {
      return await this.startRecordingReplayStream(startParams);
    });

    const { stream, stop: stopReplay } = replayResult;

    const input = new PassThrough();
    const output = new PassThrough();

    // H264 Access Unit Delimiter - prepended before each frame for proper parsing
    const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);

    // MPEG-TS muxer (only used if useMpegTsMuxer is true)
    let tsMuxer: MpegTsMuxer | null = null;

    let ff: ReturnType<typeof spawn> | null = null;
    let ended = false;
    let frameCount = 0;

    const startFfmpeg = (videoType: "H264" | "H265") => {
      if (ff) return;

      // Check if we need to transcode H.265 to H.264
      const needsTranscode =
        videoType === "H265" && params.transcodeH265ToH264 === true;

      logger?.debug?.(
        `[createRecordingReplayMp4Stream] Starting ffmpeg with videoType=${videoType}, transcode=${needsTranscode}, useMpegTsMuxer=${useMpegTsMuxer}, fps=${fps}`,
      );

      let args: string[];

      if (useMpegTsMuxer) {
        // Initialize MPEG-TS muxer for this video type
        tsMuxer = new MpegTsMuxer({ videoType, includeAudio: false });
        tsMuxer.reset();

        // ffmpeg reads MPEG-TS input (which has PTS) and outputs fMP4
        // Use frag_keyframe+empty_moov+default_base_moof for iOS compatibility
        args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "mpegts",
          "-i",
          "pipe:0",
          // Video codec: transcode H.265→H.264 if requested, otherwise copy
          ...(needsTranscode
            ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]
            : ["-c", "copy"]),
          // frag_keyframe: create new fragment at each keyframe
          // empty_moov: write ftyp/moov immediately (required for streaming)
          // default_base_moof: required for iOS Media Source Extensions
          // negative_cts_offsets: fixes some iOS playback issues
          "-movflags",
          "frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets",
          "-f",
          "mp4",
          "pipe:1",
        ];
      } else {
        // Raw Annex-B input (original method) with genpts and framerate
        const inputFormat = videoType === "H265" ? "hevc" : "h264";
        args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-fflags",
          "+genpts",
          "-r",
          String(fps),
          "-f",
          inputFormat,
          "-i",
          "pipe:0",
          // Video codec: transcode H.265→H.264 if requested, otherwise copy
          ...(needsTranscode
            ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]
            : ["-c", "copy"]),
          // frag_keyframe: create new fragment at each keyframe
          // empty_moov: write ftyp/moov immediately (required for streaming)
          // default_base_moof: required for iOS Media Source Extensions
          // negative_cts_offsets: fixes some iOS playback issues
          "-movflags",
          "frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets",
          "-f",
          "mp4",
          "pipe:1",
        ];
      }

      ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
      if (!ff.stdin || !ff.stdout || !ff.stderr) {
        throw new Error("ffmpeg stdio streams not available");
      }
      input.pipe(ff.stdin);
      ff.stdout.pipe(output);

      // Prevent uncaught ECONNRESET/EPIPE errors on streams
      ff.stdin.on("error", () => {});
      ff.stdout.on("error", () => {});
      input.on("error", () => {});
      output.on("error", () => {});

      let stderr = "";
      ff.stderr.on("data", (d) => (stderr += String(d)));
      ff.on("close", (code) => {
        if (ended) return;
        ended = true;
        // Best-effort: surface ffmpeg errors to consumers.
        if ((code ?? 0) !== 0 && stderr.trim()) {
          logger?.error?.(
            `[createRecordingReplayMp4Stream] ffmpeg exited with code ${code}: ${stderr}`,
          );
          output.destroy(
            new Error(`ffmpeg exited with code ${code ?? 0}: ${stderr}`),
          );
        } else {
          logger?.debug?.(
            `[createRecordingReplayMp4Stream] ffmpeg closed normally, frames=${frameCount}`,
          );
          output.end();
        }
      });
    };

    const stopAll = async (): Promise<void> => {
      if (ended) return;
      ended = true;

      // IMPORTANT: Release queue slot FIRST, before any cleanup that might timeout.
      // This allows the next queued operation to proceed immediately.
      releaseQueueSlot();

      logger?.debug?.(
        `[createRecordingReplayMp4Stream] Stopping stream, frames=${frameCount}`,
      );

      // Do cleanup in parallel, don't block on any single operation
      const cleanupPromises: Promise<void>[] = [];

      cleanupPromises.push(
        stopReplay().catch(() => {
          /* ignore */
        }),
      );
      cleanupPromises.push(
        stream.stop().catch(() => {
          /* ignore */
        }),
      );

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

      // Wait for cleanup but don't block indefinitely
      await Promise.race([
        Promise.all(cleanupPromises),
        new Promise((resolve) => setTimeout(resolve, 2000)), // Max 2s for cleanup
      ]);
    };

    const timer = setTimeout(
      () => {
        logger?.debug?.(
          `[createRecordingReplayMp4Stream] Timeout reached (${seconds}s), stopping`,
        );
        void stopAll();
      },
      Math.max(1, seconds) * 1000,
    );

    // Listen for abort signal (triggered when a new clip is requested)
    // This allows quick clip switching without waiting for the current clip to finish
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (!ended) {
            logger?.debug?.(
              `[createRecordingReplayMp4Stream] Abort signal received, stopping for new clip`,
            );
            void stopAll();
          }
        },
        { once: true },
      );
    }

    output.on("close", () => {
      clearTimeout(timer);
      void stopAll();
    });

    stream.on("error", (e) => {
      logger?.error?.(
        `[createRecordingReplayMp4Stream] Stream error: ${e.message}`,
      );
      output.destroy(e);
      void stopAll();
    });

    // Ensure queue slot is released when stream closes naturally
    stream.on("close", () => {
      logger?.debug?.(
        `[createRecordingReplayMp4Stream] Stream closed, frames=${frameCount}`,
      );
      clearTimeout(timer);
      void stopAll();
    });

    stream.on(
      "videoAccessUnit",
      ({ data, videoType, isKeyframe, microseconds }) => {
        if (ended) return;
        startFfmpeg(videoType);
        frameCount++;
        if (useMpegTsMuxer && tsMuxer) {
          // Mux frame into MPEG-TS with correct PTS timestamp
          const tsData = tsMuxer.muxVideo(data, microseconds, isKeyframe);
          input.write(tsData);
        } else {
          // Write raw Annex-B NAL units directly
          // For H.264, prepend Access Unit Delimiter for proper frame demarcation
          if (videoType === "H264") input.write(H264_AUD);
          input.write(data);
        }
      },
    );

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

    // Get UID for the channel (required for download)
    const channel = this.normalizeChannel(params.channel);
    const uid = await this.ensureUidForRecordings(channel);

    // Download raw recording
    const raw = await this.downloadRecording({
      channel,
      uid,
      fileName: params.fileName,
      timeoutMs,
    });

    if (raw.length === 0) {
      throw new Error("Downloaded recording is empty");
    }

    // Demux with timestamp extraction for proper A/V sync
    const videoFrames: { annexB: Buffer; microseconds: number }[] = [];
    let videoType: BcMediaVideoType | null = null;

    const decoder = new BcMediaAnnexBDecoder({
      strict: false,
      logger: this.logger,
      onVideoAccessUnit: ({ annexB, microseconds }) => {
        videoFrames.push({ annexB, microseconds });
      },
    });

    decoder.push(raw);
    const stats = decoder.getStats();
    videoType = stats.videoType;

    if (videoFrames.length === 0) {
      throw new Error("Downloaded recording has no video frames");
    }

    // Calculate FPS from timestamps - most reliable for correct playback speed
    let fps: number;
    if (videoFrames.length >= 2) {
      const firstTs = videoFrames[0]!.microseconds;
      const lastTs = videoFrames[videoFrames.length - 1]!.microseconds;
      const durationUs = lastTs - firstTs;

      if (durationUs > 0) {
        const durationSeconds = durationUs / 1_000_000;
        fps = (videoFrames.length - 1) / durationSeconds;
      } else {
        // Fallback to info FPS if timestamps are invalid
        const infoFps = stats.infos[0]?.fps;
        fps = infoFps && infoFps > 0 ? infoFps : 15;
      }
    } else {
      // Not enough frames, use info FPS
      const infoFps = stats.infos[0]?.fps;
      fps = infoFps && infoFps > 0 ? infoFps : 15;
    }

    // Round FPS to common values if close
    if (fps > 14 && fps < 16) fps = 15;
    else if (fps > 23 && fps < 26) fps = 25;
    else if (fps > 29 && fps < 31) fps = 30;
    else fps = Math.round(fps * 100) / 100;

    const annexB = Buffer.concat(videoFrames.map((f) => f.annexB));

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

  /**
   * Create an HLS (HTTP Live Streaming) session for a recording.
   *
   * This method creates HLS segments on-the-fly from a recording replay stream.
   * HLS is required for iOS devices (Safari, Home app) which don't support
   * fragmented MP4 streaming well and require Range request support.
   *
   * The session writes HLS segments (.ts files) and playlist (.m3u8) to a
   * temporary directory. You must serve these files via HTTP to the client.
   *
   * @example
   * ```ts
   * const session = await api.createRecordingReplayHlsSession({
   *   channel: 0,
   *   fileName: "/mnt/sda/Mp4Record/2026-01-25/RecS03.mp4",
   * });
   *
   * // Serve playlist
   * app.get('/clip.m3u8', (req, res) => {
   *   res.type('application/vnd.apple.mpegurl');
   *   res.send(session.getPlaylist());
   * });
   *
   * // Serve segments
   * app.get('/segment/:name', (req, res) => {
   *   const data = session.getSegment(req.params.name);
   *   if (data) {
   *     res.type('video/mp2t');
   *     res.send(data);
   *   } else {
   *     res.status(404).end();
   *   }
   * });
   *
   * // Cleanup when done
   * await session.stop();
   * ```
   */
  async createRecordingReplayHlsSession(params: {
    /** Channel number (0-based). Required. */
    channel: number;
    /** Full path to the recording file. Required. */
    fileName: string;
    /**
     * Force NVR mode (uses id-based XML with UID) or standalone mode (name-based XML).
     * If not specified, the library will detect based on device channel count.
     */
    isNvr?: boolean;
    /** Optional logger override. If not provided, uses the API's logger. */
    logger?: Logger;
    /**
     * External identifier for the dedicated socket session.
     * When provided, a dedicated BaichuanClient is created/reused for this deviceId.
     */
    deviceId?: string;
    /**
     * Transcode H.265/HEVC to H.264/AVC for compatibility.
     * Default: false (passthrough).
     */
    transcodeH265ToH264?: boolean;
    /**
     * HLS segment duration in seconds. Default: 4.
     */
    hlsSegmentDuration?: number;
  }): Promise<{
    /**
     * Get the current HLS playlist content (.m3u8).
     * Call this to serve the playlist to the client.
     */
    getPlaylist: () => string;
    /**
     * Get a segment file by name.
     * Returns undefined if the segment doesn't exist yet.
     */
    getSegment: (name: string) => Buffer | undefined;
    /**
     * List all available segment names.
     */
    listSegments: () => string[];
    /**
     * Wait for the HLS session to be ready (at least one segment available).
     */
    waitForReady: () => Promise<void>;
    /**
     * Stop the HLS session and cleanup.
     */
    stop: () => Promise<void>;
    /**
     * Path to the temporary directory containing HLS files.
     */
    tempDir: string;
  }> {
    const logger = params.logger ?? this.logger;
    const hlsSegmentDuration = params.hlsSegmentDuration ?? 4;

    // Create temp directory for HLS files
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs/promises");
    const crypto = await import("crypto");

    const tempDir = path.join(
      os.tmpdir(),
      `reolink-hls-${crypto.randomBytes(8).toString("hex")}`,
    );
    await fs.mkdir(tempDir, { recursive: true });

    const playlistPath = path.join(tempDir, "playlist.m3u8");
    const segmentPattern = path.join(tempDir, "segment_%03d.ts");

    // Extract duration from filename
    const parsed = parseRecordingFileName(params.fileName);
    const durationMs = parsed?.durationMs ?? 300_000;
    const fps =
      parsed?.framerate && parsed.framerate > 0 ? parsed.framerate : 15;
    const seconds = Math.ceil((durationMs / 1000) * 1.1);

    logger?.debug?.(
      `[createRecordingReplayHlsSession] Starting: channel=${params.channel}, fileName=${params.fileName}, durationMs=${durationMs}, hlsSegmentDuration=${hlsSegmentDuration}`,
    );

    // NOTE: Replay streams now use the "general" socket (same as commands/events).
    // We do NOT force-close the socket on clip switches - instead, the streaming queue
    // serializes access and the previous stream is stopped cleanly before the new one starts.

    const startParams: Parameters<
      ReolinkBaichuanApi["startRecordingReplayStream"]
    >[0] = {
      channel: params.channel,
      fileName: params.fileName,
      logger,
      ...(params.isNvr != null ? { isNvr: params.isNvr } : {}),
      ...(params.deviceId != null ? { deviceId: params.deviceId } : {}),
    };

    // Use streaming queue - holds the slot until release() is called.
    // This serializes replay operations to avoid conflicts on the shared socket.
    // The abort signal is triggered when a new clip is requested, causing this stream to stop.
    const {
      result: replayResult,
      release: releaseQueueSlot,
      abortSignal,
    } = await this.enqueueStreamingReplayOperation(async () => {
      return await this.startRecordingReplayStream(startParams);
    });

    const { stream, stop: stopReplay } = replayResult;

    const input = new PassThrough();
    const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);

    // Use MPEG-TS muxer for proper timestamps
    let tsMuxer: MpegTsMuxer | null = null;

    let ff: ReturnType<typeof spawn> | null = null;
    let ended = false;
    let frameCount = 0;
    let readyResolve: (() => void) | null = null;
    let segmentWatcher: ReturnType<typeof setInterval> | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    // Segment cache
    const segments = new Map<string, Buffer>();

    // Watch for first segment to be created (more responsive than fixed timeout)
    const startSegmentWatcher = () => {
      if (segmentWatcher || !readyResolve) return;

      const firstSegmentPath = path.join(tempDir, "segment_000.ts");
      let checkCount = 0;
      const maxChecks = Math.ceil((hlsSegmentDuration + 2) * 10); // Check for segment duration + 2 seconds

      segmentWatcher = setInterval(async () => {
        checkCount++;
        try {
          const stats = await fs.stat(firstSegmentPath);
          // Segment exists and has content (small threshold for faster startup)
          if (stats.size > 256) {
            if (segmentWatcher) {
              clearInterval(segmentWatcher);
              segmentWatcher = null;
            }
            logger?.debug?.(
              `[createRecordingReplayHlsSession] First segment ready after ${checkCount * 100}ms, size=${stats.size}`,
            );
            readyResolve?.();
            readyResolve = null;
          }
        } catch {
          // File doesn't exist yet, keep waiting
        }

        // Fallback timeout
        if (checkCount >= maxChecks && readyResolve) {
          if (segmentWatcher) {
            clearInterval(segmentWatcher);
            segmentWatcher = null;
          }
          logger?.debug?.(
            `[createRecordingReplayHlsSession] Segment watcher timeout, resolving anyway`,
          );
          readyResolve?.();
          readyResolve = null;
        }
      }, 100); // Check every 100ms
    };

    const startFfmpeg = (videoType: "H264" | "H265") => {
      if (ff) return;

      const needsTranscode =
        videoType === "H265" && params.transcodeH265ToH264 === true;

      const gop = Math.max(1, Math.round(fps * hlsSegmentDuration));

      logger?.log?.(
        `[createRecordingReplayHlsSession] Starting ffmpeg HLS with videoType=${videoType}, transcode=${needsTranscode}, hlsTime=${hlsSegmentDuration}s, fileName=${params.fileName}`,
      );

      // Initialize MPEG-TS muxer
      tsMuxer = new MpegTsMuxer({ videoType, includeAudio: false });
      tsMuxer.reset();

      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        // Video codec
        ...(needsTranscode
          ? [
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              "-tune",
              "zerolatency",
              "-crf",
              "23",
              "-pix_fmt",
              "yuv420p",
              // Ensure regular GOP for consistent HLS cutting.
              "-g",
              String(gop),
              "-keyint_min",
              String(gop),
              "-sc_threshold",
              "0",
              // Force frequent keyframes so HLS can cut segments reliably.
              // Without this, ffmpeg will only cut on keyframes and segments can become huge.
              "-force_key_frames",
              `expr:gte(t,n_forced*${hlsSegmentDuration})`,
            ]
          : ["-c", "copy"]),
        // HLS output options
        "-f",
        "hls",
        "-hls_time",
        String(hlsSegmentDuration),
        "-hls_list_size",
        "0", // Keep all segments in playlist
        "-hls_playlist_type",
        "event", // Growing playlist (not VOD until end)
        "-hls_segment_filename",
        segmentPattern,
        "-hls_flags",
        "independent_segments+temp_file",
        playlistPath,
      ];

      ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
      if (!ff.stdin || !ff.stderr) {
        throw new Error("ffmpeg stdio streams not available");
      }
      input.pipe(ff.stdin);

      ff.stdin.on("error", () => {});
      ff.stderr.on("error", () => {});
      input.on("error", () => {});

      let stderr = "";
      ff.stderr.on("data", (d) => (stderr += String(d)));

      ff.on("close", (code) => {
        if (ended) return;
        ended = true;
        if ((code ?? 0) !== 0 && stderr.trim()) {
          logger?.error?.(
            `[createRecordingReplayHlsSession] ffmpeg exited with code ${code}: ${stderr}`,
          );
        } else {
          logger?.debug?.(
            `[createRecordingReplayHlsSession] ffmpeg closed normally, frames=${frameCount}`,
          );
        }
      });
    };

    const stopAll = async (): Promise<void> => {
      if (ended) return;
      ended = true;

      // Release queue slot first
      releaseQueueSlot();

      // Clear segment watcher if running
      if (segmentWatcher) {
        clearInterval(segmentWatcher);
        segmentWatcher = null;
      }

      logger?.debug?.(
        `[createRecordingReplayHlsSession] Stopping, frames=${frameCount}`,
      );

      const cleanupPromises: Promise<void>[] = [];
      cleanupPromises.push(stopReplay().catch(() => {}));
      cleanupPromises.push(stream.stop().catch(() => {}));

      try {
        input.end();
      } catch {}
      try {
        ff?.kill("SIGKILL");
      } catch {}

      await Promise.race([
        Promise.all(cleanupPromises),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);

      // Cleanup temp directory after a delay
      setTimeout(async () => {
        try {
          const files = await fs.readdir(tempDir);
          for (const file of files) {
            await fs.unlink(path.join(tempDir, file)).catch(() => {});
          }
          await fs.rmdir(tempDir).catch(() => {});
        } catch {}
      }, 60_000); // Keep files for 1 minute after stop
    };

    const timer = setTimeout(
      () => {
        logger?.debug?.(
          `[createRecordingReplayHlsSession] Timeout reached (${seconds}s), stopping`,
        );
        void stopAll();
      },
      Math.max(1, seconds) * 1000,
    );

    // Listen for abort signal (triggered when a new clip is requested)
    // This allows quick clip switching without waiting for the current clip to finish
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (!ended) {
            logger?.debug?.(
              `[createRecordingReplayHlsSession] Abort signal received, stopping for new clip`,
            );
            void stopAll();
          }
        },
        { once: true },
      );
    }

    stream.on("error", (e) => {
      logger?.error?.(
        `[createRecordingReplayHlsSession] Stream error: ${e.message}`,
      );
      clearTimeout(timer);
      void stopAll();
    });

    stream.on("close", () => {
      logger?.debug?.(
        `[createRecordingReplayHlsSession] Stream closed, frames=${frameCount}`,
      );
      clearTimeout(timer);
      // Don't call stopAll() immediately - just signal that input is done
      // so ffmpeg can finish processing the buffered data
      try {
        input.end(); // Signal EOF to ffmpeg
      } catch {}
      // Note: ffmpeg will close on its own when done processing
    });

    stream.on(
      "videoAccessUnit",
      ({ data, videoType, isKeyframe, microseconds }) => {
        if (ended) return;
        startFfmpeg(videoType);
        frameCount++;
        if (tsMuxer) {
          const tsData = tsMuxer.muxVideo(data, microseconds, isKeyframe);
          input.write(tsData);
        }

        // Start watching for first segment after first frame
        if (frameCount === 1) {
          startSegmentWatcher();
        }
      },
    );

    return {
      getPlaylist: () => {
        try {
          const { readFileSync } = require("fs");
          return readFileSync(playlistPath, "utf8");
        } catch {
          // Return minimal playlist if not ready yet
          return "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n";
        }
      },
      getSegment: (name: string) => {
        // Check cache first
        if (segments.has(name)) {
          return segments.get(name);
        }
        // Read from disk
        try {
          const { readFileSync } = require("fs");
          const segmentPath = path.join(tempDir, name);
          const data = readFileSync(segmentPath);
          segments.set(name, data);
          return data;
        } catch {
          return undefined;
        }
      },
      listSegments: () => {
        try {
          const { readdirSync } = require("fs");
          return (readdirSync(tempDir) as string[]).filter((f: string) =>
            f.endsWith(".ts"),
          );
        } catch {
          return [];
        }
      },
      waitForReady: () => readyPromise,
      stop: stopAll,
      tempDir,
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

  // --------------------
  // Chime / DingDong APIs
  // --------------------

  /**
   * Get the list of paired wireless chime devices.
   * cmd_id: 484 (GetDingDongList)
   *
   * @param channel - Channel number (0-based, default 0)
   * @returns Array of paired chime devices
   */
  async getDingDongList(channel?: number): Promise<ChimeDevice[]> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_DING_DONG_LIST,
      channel: ch,
    });
    return parseDingDongListFromXml(xml);
  }

  /**
   * Get parameters (name, volume, LED state) for a specific wireless chime.
   * cmd_id: 485 (DingDongOpt, option getParam)
   *
   * @param chimeId - The chime device ID
   * @param channel - Channel number (0-based, default 0)
   * @returns Chime parameters
   */
  async getDingDongParams(chimeId: number, channel?: number): Promise<ChimeParams> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildDingDongGetParamsXml(chimeId);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_DING_DONG_OPT,
      channel: ch,
      payloadXml,
    });
    return parseDingDongParamsFromXml(xml);
  }

  /**
   * Set parameters (name, volume, LED state) for a specific wireless chime.
   * cmd_id: 485 (DingDongOpt, option setParam)
   *
   * @param chimeId - The chime device ID
   * @param params - Parameters to set (volLevel, ledState, name)
   * @param channel - Channel number (0-based, default 0)
   */
  async setDingDongParams(
    chimeId: number,
    params: { volLevel?: number; ledState?: number; name?: string },
    channel?: number,
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildDingDongSetParamsXml(chimeId, params);
    await this.sendXml({
      cmdId: BC_CMD_ID_DING_DONG_OPT,
      channel: ch,
      payloadXml,
    });
  }

  /**
   * Trigger a wireless chime to ring with a specific ringtone.
   * cmd_id: 485 (DingDongOpt, option ringWithMusic)
   *
   * @param chimeId - The chime device ID
   * @param musicId - The ringtone/music ID to play
   * @param channel - Channel number (0-based, default 0)
   */
  async ringDingDong(chimeId: number, musicId: number, channel?: number): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildDingDongRingXml(chimeId, musicId);
    await this.sendXml({
      cmdId: BC_CMD_ID_DING_DONG_OPT,
      channel: ch,
      payloadXml,
    });
  }

  /**
   * Get the per-event alarm configuration for paired wireless chimes.
   * cmd_id: 486 (GetDingDongCfg)
   *
   * @param channel - Channel number (0-based, default 0)
   * @returns Array of chime configurations (one per paired chime)
   */
  async getDingDongCfg(channel?: number): Promise<ChimeCfg[]> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_DING_DONG_CFG,
      channel: ch,
    });
    return parseDingDongCfgFromXml(xml);
  }

  /**
   * Set the per-event alarm configuration for a specific wireless chime.
   * cmd_id: 487 (SetDingDongCfg)
   *
   * @param chimeId - The chime ring/device ID
   * @param eventType - Event type string (e.g. "doorbell", "package", "people")
   * @param state - 0 = disabled, 1 = enabled
   * @param musicId - Ringtone ID to use for this event type
   * @param channel - Channel number (0-based, default 0)
   */
  async setDingDongCfg(
    chimeId: number,
    eventType: string,
    state: 0 | 1,
    musicId: number,
    channel?: number,
  ): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildSetDingDongCfgXml(chimeId, eventType, state, musicId);
    await this.sendXml({
      cmdId: BC_CMD_ID_SET_DING_DONG_CFG,
      channel: ch,
      payloadXml,
    });
  }

  /** Cache of last known hardwired chime state per channel, used to avoid re-fetching on every set. */
  private _hardwiredChimeCache: Map<number, HardwiredChimeState> = new Map();

  /**
   * Get the hardwired (wired-in) chime state.
   * cmd_id: 483 (GetDingDongCtrl)
   *
   * Note: calling this may briefly trigger the physical chime to rattle.
   *
   * @param channel - Channel number (0-based, default 0)
   * @returns Hardwired chime state (type, enabled, time)
   */
  async getHardwiredChime(channel?: number): Promise<HardwiredChimeState> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildGetDingDongCtrlXml();
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_DING_DONG_CTRL,
      channel: ch,
      payloadXml,
    });
    const state = parseHardwiredChimeFromXml(xml);
    this._hardwiredChimeCache.set(ch, state);
    return state;
  }

  /**
   * Set the hardwired (wired-in) chime state.
   * cmd_id: 483 (SetDingDongCtrl)
   *
   * Uses the cached state from a previous getHardwiredChime call to fill in
   * missing type/time fields, avoiding a double round-trip on every set.
   * Falls back to fetching if no cache is available.
   *
   * @param params - Chime configuration (type, enabled, time)
   * @param channel - Channel number (0-based, default 0)
   */
  async setHardwiredChime(
    params: { type?: string | undefined; enabled: boolean; time?: number },
    channel?: number,
  ): Promise<HardwiredChimeState> {
    const ch = this.normalizeChannel(channel);

    // Use cached state if available to avoid extra round-trip (matching Python's cached approach).
    // Battery cameras can return 400 when sleeping; using cache prevents double-failure on set.
    let current = this._hardwiredChimeCache.get(ch);
    if (!current) {
      current = await this.getHardwiredChime(ch);
    }

    const chimeType = params.type ?? current.type;
    const enabled: 0 | 1 = params.enabled ? 1 : 0;
    const time = params.time ?? current.time;

    const payloadXml = buildSetDingDongCtrlXml(chimeType, enabled, time);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_DING_DONG_CTRL,
      channel: ch,
      payloadXml,
    });
    const newState = parseHardwiredChimeFromXml(xml);
    this._hardwiredChimeCache.set(ch, newState);
    return newState;
  }

  /**
   * Play an audio file on the doorbell / chime device.
   * cmd_id: 349 (QuickReplyPlay)
   *
   * @param fileId - The audio file ID to play
   * @param channel - Channel number (0-based, default 0)
   */
  async quickReplyPlay(fileId: number, channel?: number): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildQuickReplyPlayXml(ch, fileId);
    await this.sendXml({
      cmdId: BC_CMD_ID_QUICK_REPLY_PLAY,
      channel: ch,
      payloadXml,
    });
  }

  /**
   * Get the silent mode state of a paired wireless chime.
   * cmd_id: 609 (GetDingDongSilent)
   *
   * @param chimeId - The wireless chime device ID (from getDingDongList)
   * @param channel - Channel number (0-based, default 0)
   * @returns Wireless chime silent state (time=0 means active/not silenced)
   */
  async getDingDongSilent(chimeId: number, channel?: number): Promise<WirelessChimeSilentState> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildGetDingDongSilentXml(chimeId);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_DING_DONG_SILENT,
      channel: ch,
      payloadXml,
    });
    return parseWirelessChimeSilentFromXml(xml, chimeId);
  }

  /**
   * Set the silent mode of a paired wireless chime.
   * cmd_id: 610 (SetDingDongSilent)
   *
   * @param chimeId - The wireless chime device ID (from getDingDongList)
   * @param time - Silence duration in seconds. 0 = not silenced (chime active), >0 = silenced for this many seconds.
   * @param channel - Channel number (0-based, default 0)
   * @returns Updated wireless chime silent state
   */
  async setDingDongSilent(chimeId: number, time: number, channel?: number): Promise<WirelessChimeSilentState> {
    const ch = this.normalizeChannel(channel);
    const payloadXml = buildSetDingDongSilentXml(chimeId, time);
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_SET_DING_DONG_SILENT,
      channel: ch,
      payloadXml,
    });
    return parseWirelessChimeSilentFromXml(xml, chimeId);
  }
}
