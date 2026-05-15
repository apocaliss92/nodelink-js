/**
 * TypeScript types for Baichuan API responses and parameters.
 * Based on Reolink API documentation.
 */

export interface OsdChannel {
  enable: number;
  name: string;
  pos: string;
}

export interface OsdTime {
  enable: number;
  pos: string;
}

export interface OsdConfig {
  channel: number;
  osdChannel: OsdChannel;
  osdTime: OsdTime;
  watermark: number;
  bgcolor?: number;
}

export interface AIDetectionState {
  alarm_state: number;
  support: number;
}

export type AiKey = "dog_cat" | "face" | "other" | "package" | "people";

export interface AIState {
  channel: number;
  alarm_state?: number;
  support?: number;
  [key: string]: unknown; // Allow additional AI detection types
}

export interface PtzPreset {
  id: number;
  name: string;
}

export type PtzPosition = {
  pan?: number;
  tilt?: number;
};

export type ZoomFocusTriplet = {
  minPos: number;
  maxPos: number;
  curPos: number;
};

export type ZoomFocusStatus = {
  zoom?: ZoomFocusTriplet;
  focus?: ZoomFocusTriplet;
};

export interface PtzCommand {
  action: "start" | "stop";
  command:
    | "Left"
    | "Right"
    | "Up"
    | "Down"
    | "ZoomIn"
    | "ZoomOut"
    | "FocusNear"
    | "FocusFar";
  speed?: number;
  /** Optional: how long to move before sending an automatic stop (ms). Set to 0 to disable auto-stop. */
  autoStopMs?: number;
}

export interface BatteryInfo {
  batteryPercent?: number;
  /** Known values include: "charging", "chargeComplete", "none". */
  chargeStatus?: string;
  /** Charging source/port status, e.g. "solarPanel". */
  adapterStatus?: string;
  /** Low power flag (0/1). */
  lowPower?: number;
  /** Battery voltage (mV) when available. */
  voltage?: number;
  /** Battery current (mA) when available (can be negative while charging). */
  current?: number;
  /** Battery temperature (°C) when available. */
  temperature?: number;
  /** Battery version info when available (commonly 2). */
  batteryVersion?: number;
  sleeping?: boolean;
  channel?: number;
}

/**
 * Minimal per-channel device summary returned by `ReolinkBaichuanApi.getDevicesInfo()`.
 *
 * This is optimized for speed and returns only common identity + battery/doorbell hints.
 */
export interface ReolinkBaichuanDeviceSummary {
  channel: number;
  name?: string;
  uid?: string;
  /** Camera IP (best-effort via Baichuan GetNetworkInfo/GetGeneral). */
  ip?: string;
  /** Camera MAC address (best-effort via Baichuan GetNetworkInfo/GetGeneral). */
  mac?: string;
  /** Active link / link type when available (varies by firmware). */
  activeLink?: string;
  /** Channel state from cmd_id 145 push (e.g. connect/disconnect/none). */
  state?: string;
  /** Channel index from cmd_id 145 push (often 1-based device slot). */
  index?: number;
  /** Supported streams as reported by cmd_id 145 push (e.g. mainStream,subStream,externStream). */
  streamSupport?: string[];
  wifiState?: string;
  networkSegment?: string;
  changed?: boolean;
  abilityChanged?: boolean;
  online?: boolean;
  sleeping?: boolean;
  loginState?: string;
  updatedAtMs?: number;
  /** Model string (Baichuan <type>). */
  model?: string;
  /** True when the channel likely belongs to a multifocal/dual-lens device (best-effort by model). */
  isMultifocal?: boolean;
  /** Device serial number when available. */
  serialNumber?: string;
  /** Battery percentage (0-100) when available. */
  battery?: number;
  /** True when the channel is a battery camera (best-effort via SupportInfo). */
  isBattery?: boolean;
  /** True when the channel is a doorbell (best-effort via SupportInfo). */
  isDoorbell?: boolean;
}

/** Best-effort network identity for a host or a channel. */
export interface ReolinkBaichuanNetworkInfo {
  ip?: string;
  mac?: string;
  activeLink?: string;
}

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

export type ReolinkBaichuanPorts = Record<string, Record<string, number>>;

export type ReolinkBaichuanChannelInfo = {
  typeInfo?: string;
  firmVer?: string;
  firmwareVersion?: string;
  boardInfo?: string;
  pakSuffix?: string;
  name?: string;
};

export type ReolinkBaichuanChannelIdentity = {
  channel: number;
  model: string;
  name: string;
};

/**
 * NVR/HUB grouping of channels that belong to the same physical device.
 *
 * Multifocal cameras typically appear as 2+ channels that share the same UID and/or serial number.
 */
export interface ReolinkNvrDeviceGroupSummary {
  /** Stable group key (usually uid:* or sn:*). */
  key: string;
  uid?: string;
  serialNumber?: string;
  name?: string;
  model?: string;
  channels: number[];
  /** True when the group likely represents a multi-channel (multifocal) device. */
  isMultifocal: boolean;
  /** Human-readable heuristic used for isMultifocal. */
  reason: string;
}

export type ReolinkNvrDeviceGroupsResult = {
  channels: number[];
  groups: ReolinkNvrDeviceGroupSummary[];
  /** Map channel -> group key. */
  channelToGroup: Record<number, string>;
};

export type SleepState = "awake" | "sleeping" | "unknown";

/**
 * Best-effort sleep status inference.
 *
 * Note: for battery cameras there is no universally reliable, purely passive "sleep" flag.
 * This status is inferred without sending any request to the camera.
 */
export interface SleepStatus {
  state: SleepState;
  reason: string;
  lastRxAtMs?: number;
  idleMs?: number;
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
   * If true, closes the connection and forces a reconnect before retrying.
   * Default: true for UDP (battery), false for TCP.
   */
  reconnect?: boolean;
};

export type LastSleepProbe = {
  atMs: number;
  status: SleepStatus;
};

export interface PirState {
  enabled: boolean;
  state?: {
    enable?: number;
    channel?: number;
    /** PIR sensitivity (typically 1..100). Camera-side field is
     *  `sensiValue` in the cmd_id 212 response. */
    sensitive?: number;
    /** False-positive reduction toggle (`reduceFalseAlarm` on the
     *  wire). 0/1. */
    reduceAlarm?: number;
    /** Cooldown between consecutive PIR triggers (seconds). */
    interval?: number;
    /** Firmware-advertised max value for `interval`. Drives the
     *  upper bound of operator-facing sliders. */
    intervalMax?: number;
    [key: string]: unknown;
  };
}

export type SirenState = {
  enabled: boolean;
};

export interface WhiteLedState {
  enabled: boolean;
  brightness?: number;
}

import type { XmlJsonValue } from "./utils/xml";

/** Public snapshot entry returned by `ReolinkBaichuanApi.getChannelInfoFromPushCache()`. */
export type ChannelPushCacheEntry = {
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
};

/** Internal live entry used to maintain cmd_id 145 push state. */
export type ChannelPushDataEntry = ChannelPushCacheEntry & {
  /** Lowercased state for convenience (e.g. "connect", "none"). */
  stateLower?: string;
  updatedAtMs: number;
};

// --------------------
// PCAP-derived push cache (cmd_id 78/79/464/484/623/723)
// --------------------

export type BaichuanCachedPush<T> = {
  updatedAtMs: number;
  value: T;
};

export type BaichuanVideoInputPush = {
  channelId?: number;
  bright?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  sharpen?: number;
  corridorAbility?: number;
  corridorMode?: string;
};

export type BaichuanSerialPush = {
  channelId?: number;
  baudRate?: number;
  dataBit?: string;
  stopBit?: string;
  parity?: string;
  flowControl?: string;
  controlProtocol?: string;
  controlAddress?: number;
};

export type BaichuanNetInfoPush = {
  netType?: string;
  signal?: number;
};

export type BaichuanDingdongListPush = {
  maxPairNumber?: number;
  /** -1 commonly means "all" / host-level. */
  channel?: number;
  pairedCount?: number;
  pairedList?: XmlJsonValue;
};

export type BaichuanSleepStatusPush = {
  /** Parsed from <sleep>0/1 when present. */
  sleep?: boolean;
  rawSleep?: number;
  /** Some firmwares use <statusList>... for per-channel statuses. */
  statusListPresent?: boolean;
};

export type BaichuanCoordinatePointListPush = {
  count: number;
  points?: Array<{ x: number; y: number }>;
};

export type BaichuanSettingsPushCacheEntry = {
  /** Map key (0-based) when known; -1 for host-level pushes. */
  channel: number;
  videoInput?: BaichuanCachedPush<BaichuanVideoInputPush>;
  serial?: BaichuanCachedPush<BaichuanSerialPush>;
  netInfo?: BaichuanCachedPush<BaichuanNetInfoPush>;
  dingdongList?: BaichuanCachedPush<BaichuanDingdongListPush>;
  sleepStatus?: BaichuanCachedPush<BaichuanSleepStatusPush>;
  coordinatePointList?: BaichuanCachedPush<BaichuanCoordinatePointListPush>;
};

// --------------------
// PCAP-derived getters (cmd_id 44/54/81/115/116/146/208/574/...)
// --------------------

export type BaichuanOsdDatetime = {
  channelId?: number;
  enable?: boolean;
  topLeftX?: number;
  topLeftY?: number;
  width?: number;
  height?: number;
  language?: string;
};

export type BaichuanOsdChannelName = {
  channelId?: number;
  name?: string;
  enable?: boolean;
  topLeftX?: number;
  topLeftY?: number;
  enWatermark?: boolean;
  enBgcolor?: boolean;
};

export type BaichuanGetOsdDatetimeResult = {
  osdDatetime?: BaichuanOsdDatetime;
  osdChannelName?: BaichuanOsdChannelName;
};

export type BaichuanRecordCfg = {
  channelId?: number;
  cycle?: number;
  recordAbility?: number;
  smartRecord?: number;
  recordDelayTime?: number;
  preRecordTime?: number;
  packageTime?: number;
  cycleList?: number[];
};

export type BaichuanRecordSchedule = {
  channelId?: number;
  enable?: boolean;
  typeScheduleList?: Array<{ type: string; valueTable: string }>;
};

export type BaichuanWifiSignal = {
  signal?: number;
};

export type BaichuanWifi = {
  protocol?: number;
  mode?: string;
  ssid?: string;
  /** Masked in many firmwares (e.g. ***********) */
  key?: string;
  channel?: number;
  isNVRSsid?: number;
};

export type BaichuanLedState = {
  channelId?: number;
  ledVersion?: number;
  state?: string;
  lightState?: string;
};

export type BaichuanSleepState = {
  sleep?: number;
  mode?: number;
  panPos?: number;
  tiltPos?: number;
  imageName?: string;
};

export type BaichuanStreamEncodeTable = {
  type?: string;
  width?: number;
  height?: number;
  videoEncType?: number;
  videoEncTypeList?: number[];
  defaultFramerate?: number;
  defaultBitrate?: number;
  framerateTable?: number[];
  bitrateTable?: number[];
  defaultGop?: number;
};

export type BaichuanStreamInfo = {
  channelBits?: number;
  encodeTables: BaichuanStreamEncodeTable[];
};

export type BaichuanStreamInfoList = {
  streams: BaichuanStreamInfo[];
};

export type AiTypesCacheEntry = {
  types?: string[];
  updatedAtMs: number;
};

export type DeviceCapabilitiesCacheEntry = {
  result: DeviceCapabilitiesResult;
  cachedAtMs: number;
};

export type NvrChannelsSummaryCacheEntry = {
  channels: number[];
  devices: ReolinkBaichuanDeviceSummary[];
};

export type RecordingsCacheEntry = {
  recordings: RecordingFile[];
  cachedAt: number;
  /** TTL in milliseconds (default 5 minutes) */
  ttlMs: number;
};

export type RecordingsQueueItem = {
  run: () => Promise<void>;
};

export interface AudioAlarmParams {
  channel: number;
  alarm_mode?: "times" | "manul";
  times?: number;
  manual_switch?: number;
}

export interface Events {
  channel?: number;
  ai?: AIState;
  motion?: {
    state?: number;
    [key: string]: unknown;
  };
  /** Doorbell/visitor notification (instant event). Present when detected. */
  visitor?: {
    detected?: boolean;
    timestamp?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type StreamProfile = "main" | "sub" | "ext";

export type NativeVideoStreamVariant = "default" | "autotrack" | "telephoto";

export type VideoCodec = "H.264" | "H.265" | "MJPEG" | "MPEG4" | string;

export interface StreamMetadata {
  profile: StreamProfile;
  audio: number; // 0 or 1
  audioCodec: string;
  width: number;
  height: number;
  videoEncType: VideoCodec;
  videoEncTypeInt: number; // Internal encoding type integer
  frameRate: number; // FPS
  bitRate: number; // Bitrate in kbps
}

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

export type RtspCreateOptions = {
  listenHost?: string;
  listenPort?: number;
  path?: string;
  variant?: NativeVideoStreamVariant;
};

export type ReolinkVideoStreamOptionsResult = {
  nativeStreams: ReolinkSupportedStream[];
  rtspStreams: ReolinkSupportedStream[];
  rtmpStreams: ReolinkSupportedStream[];
  /** Raw XML response from GetEnc (cmd_id 56) for debugging stream availability */
  rawEncXml?: string | undefined;
};

export type VideoStreamOptionsCacheEntry = ReolinkVideoStreamOptionsResult;

export type RunAllDiagnosticsConsecutivelyResult = {
  runDir: string;
  zipPath: string;
  diagnosticsPath: string;
  streamsDir: string;
};

export type RunMultifocalDiagnosticsConsecutivelyResult = {
  runDir: string;
  resultsPath: string;
  streamsDir: string;
};

export interface ChannelStreamMetadata {
  channel: number;
  streams: StreamMetadata[];
  audioEnabled: boolean; // Overall audio enabled (AND of all streams)
  /** Raw XML response from GetEnc (cmd_id 56) for debugging */
  rawXml?: string;
}

export interface MotionEvent {
  channel: number;
  state: boolean; // true = motion detected
  timestamp?: number;
  /** Origin of motion trigger when known (e.g. PIR-only cameras). */
  source?: "md" | "pir" | "unknown";
}

export interface AIEvent {
  channel: number;
  type: "people" | "vehicle" | "dog_cat" | "face" | "package" | "other";
  detected: boolean;
  timestamp?: number;
}

export interface ReolinkMotionNotification {
  channel: number;
  type: "motion";
  motion: MotionEvent;
  timestamp?: number;
}

export interface ReolinkAiNotification {
  channel: number;
  type: "ai";
  ai: AIEvent;
  timestamp?: number;
}

export interface ReolinkVisitorNotification {
  channel: number;
  type: "visitor";
  timestamp?: number;
}

export interface ReolinkDayNightNotification {
  channel: number;
  type: "daynight";
  timestamp?: number;
}

export type ReolinkEvent =
  | ReolinkMotionNotification
  | ReolinkAiNotification
  | ReolinkVisitorNotification
  | ReolinkDayNightNotification;

export type ReolinkSimpleEventType =
  | "motion"
  | "doorbell"
  | "people"
  | "vehicle"
  | "animal"
  | "face"
  | "package"
  | "daynight"
  | "sleeping"
  | "awake"
  | "online"
  | "offline"
  | "battery"
  | "other";

export interface ReolinkSimpleEvent {
  type: ReolinkSimpleEventType;
  channel: number;
  timestamp: number;
  /** Present when type === "battery" — pushed by the camera via cmdId 252. */
  battery?: Partial<BatteryInfo>;
}

/**
 * A single detection bounding box in normalized [0, 1] coordinates relative to
 * the source video frame. Using fractions instead of pixels keeps the same box
 * valid across mainStream / subStream / externStream output and across firmware
 * resolution changes.
 */
export interface ReolinkDetectionBox {
  /** Left edge in [0, 1] (0 = left, 1 = right). */
  x: number;
  /** Top edge in [0, 1] (0 = top, 1 = bottom). */
  y: number;
  /** Width in [0, 1]. */
  width: number;
  /** Height in [0, 1]. */
  height: number;
  /** AI class label if the camera reports one (e.g. "person", "vehicle"). */
  label?: string;
  /** Confidence in [0, 1] if exposed by the camera. */
  confidence?: number;
}

/**
 * Diagnostic state describing how much of the BcMedia additionalHeader the
 * decoder was able to interpret. Useful for consumers iterating on the format.
 */
export type ReolinkDetectionDecodeState =
  /** Header marker was missing or malformed. */
  | "invalid-marker"
  /** Baseline 128-byte header — camera reports no overlay metadata. */
  | "no-overlay"
  /** Overlay block present, but coordinates have not been decoded yet. */
  | "overlay-undecoded"
  /** Overlay block decoded successfully. */
  | "overlay-decoded";

/**
 * High-level "detection" event emitted alongside every video frame that carries
 * a non-empty BcMedia additionalHeader. Mirrors `ReolinkSimpleEvent` but is
 * sourced from the streaming side-channel rather than from cmd_id 33 push events.
 */
export interface ReolinkDetectionEvent {
  channel: number;
  /** Microseconds timestamp from the BcMedia video frame. */
  microseconds: number;
  /** Stream profile that produced the underlying frame. */
  profile: "main" | "sub" | "ext";
  /** Boxes in [0, 1] fractional coordinates. */
  boxes: ReolinkDetectionBox[];
  /** Source frame width (from BcMedia InfoV1/V2) if known. */
  frameWidth?: number;
  /** Source frame height (from BcMedia InfoV1/V2) if known. */
  frameHeight?: number;
  /** Decoder diagnostic state. */
  decodeState: ReolinkDetectionDecodeState;
  /** Raw additionalHeader bytes — kept for downstream decoder work. */
  rawHeader: Buffer;
}

export interface TwoWayAudioConfig {
  channel: number;
  enabled: boolean;
  mode?: "mixAudioStream" | string;
}

export interface TalkAudioConfig {
  priority?: number;
  audioType: string;
  sampleRate: number;
  samplePrecision: number;
  lengthPerEncoder: number;
  soundTrack: string;
}

export interface TalkAbility {
  version?: string;
  duplexList: string[];
  audioStreamModeList: string[];
  audioConfigList: TalkAudioConfig[];
}

export interface TalkConfig {
  channel: number;
  duplex: string;
  audioStreamMode: string;
  audioConfig: TalkAudioConfig;
}

export interface TalkSessionInfo {
  channel: number;
  audioConfig: TalkAudioConfig;
  /** ADPCM bytes per block excluding the 4-byte predictor state. */
  blockSize: number;
  /** ADPCM bytes per block including the 4-byte predictor state. */
  fullBlockSize: number;
}

export interface TalkSession {
  readonly info: TalkSessionInfo;
  /**
   * Enqueue ADPCM DVI4 bytes (raw blocks, including the 4-byte predictor header per block).
   * The session will packetize into BcMedia ADPCM and pace delivery.
   */
  sendAudio(adpcm: Buffer): Promise<void>;
  /** Flush remaining audio and stop the talk session. */
  stop(): Promise<void>;
}

/**
 * Device ability/capability information for a specific channel or host.
 *
 * Keys are capability names (e.g., "preview_rw", "control_rw", "motion_rw", "reboot_rw").
 * Values are:
 * - 1 = capability is supported (typically with _rw suffix for read-write, _ro for read-only)
 * - 0 or undefined = capability is not supported
 * - string = metadata values (e.g., "userName")
 */
export type AbilityInfo = Record<string, number | string | undefined>;

/**
 * Complete device abilities structure returned by getAbilityInfo.
 *
 * - Channel numbers (0, 1, 2, etc.): Channel-specific abilities
 * - "Host": Host-level/system abilities
 */
export type DeviceAbilities = Partial<Record<number | "Host", AbilityInfo>>;

export interface SupportItem {
  chnID: number;
  ptzType?: number;
  ptzPreset?: number;
  ptzPatrol?: number;
  ptzTattern?: number;
  ptzControl?: number;
  rfCfg?: number;
  noAudio?: number;
  autoFocus?: number;
  videoClip?: number;
  battery?: number;
  ispCfg?: number;
  osdCfg?: number;
  batAnalysis?: number;
  dynamicReso?: number;
  audioVersion?: number;
  ledCtrl?: number;
  motion?: number;
  [key: string]: number | string | undefined;
}

export interface SupportInfo {
  items: SupportItem[];
  ptzMode?: string;

  IOInputPortNum?: number;
  IOOutputPortNum?: number;
  diskNum?: number;
  channelNum?: number;
  audioNum?: number;
  ptzCfg?: number;
  B485?: number;
  autoUpdate?: number;
  pushAlarm?: number;
  ftp?: number;
  ftpTest?: number;
  email?: number;
  wifi?: number;
  record?: number;
  wifiTest?: number;
  rtsp?: number;
  onvif?: number;
  audioTalk?: number;

  // Preserve unknown fields when useful.
  [key: string]: unknown;
}

export interface DeviceCapabilities {
  channel: number;
  /** Lower-cased ptzMode when available (e.g. "pt", "ptz", "none"). */
  ptzMode?: string;
  hasPan: boolean;
  hasTilt: boolean;
  hasZoom: boolean;
  hasPresets: boolean;
  hasPtz: boolean;
  hasBattery: boolean;
  hasIntercom: boolean;
  hasSiren: boolean;
  hasFloodlight: boolean;
  hasPir: boolean;
  /** True when device reports doorbell support via support.items[].doorbellVersion. */
  isDoorbell: boolean;
  /** True when device supports autotracking (smartTrack in AiCfg). */
  hasAutotracking: boolean;
  /** True when device is a doorbell (can potentially support wireless chime) or has dingDong abilities explicitly detected. */
  hasWirelessChime: boolean;
}

export type DeviceObjectType = string;

export interface DeviceSupportFlags {
  rtsp?: boolean;
  onvif?: boolean;
  wifi?: boolean;
  record?: boolean;
  ftp?: boolean;
  email?: boolean;
  pushAlarm?: boolean;
  audioTalk?: boolean;
}

export interface DeviceCapabilitiesDebugInfo {
  channel: number;
  channelId1Based: number;
  transport: "tcp" | "udp";
  encryptionKind: "none" | "bc" | "aes" | "full_aes";
  loggedIn: boolean;
  subscribed: boolean;
  abilitiesAvailable: boolean;
  supportAvailable: boolean;
  abilityMergedKeyCount?: number;
  supportItemCount?: number;
  /** Whether the device is detected as NVR/Hub */
  isNvr?: boolean;
  /** lightType from SupportItem (0=no light, 1=IR only, >=2=floodlight) */
  lightType?: number;
  /** ledCtrl bitmask from SupportItem (>0 indicates LED control capability) */
  ledCtrl?: number;
  /** ptzType from SupportItem */
  ptzType?: number;
  /** supportVolume from SupportItem (indicates siren support) */
  supportVolume?: number;
  /** supportPirSch from SupportItem (indicates PIR support) */
  supportPirSch?: number;
  /** Selected SupportItem chnID */
  supportItemChnID?: number;
  /** Wireless chime IDs from GetDingDongList (cmd 484) */
  dingDongListIds?: number[];
  /** Wireless chime IDs from GetDingDongCfg (cmd 486) */
  dingDongCfgIds?: number[];
  /** Error message if chime discovery failed */
  wirelessChimeError?: string;
}

export interface DeviceCapabilitiesResult {
  abilities?: DeviceAbilities;
  support?: SupportInfo;
  capabilities: DeviceCapabilities;
  presets?: PtzPreset[];
  objects?: DeviceObjectType[];
  features?: DeviceSupportFlags;
  debug?: DeviceCapabilitiesDebugInfo;
}

export type RecordingStreamType = "mainStream" | "subStream";

export type RecordingDevType = "cam" | "hub";
export type RecordingVodStreamHint = "main" | "sub" | "unknown";

export interface RecordingVodFlags {
  aiPerson?: boolean;
  aiVehicle?: boolean;
  aiAnimal?: boolean;
  aiFace?: boolean;
  aiOther?: boolean;
  motion?: boolean;
  schedule?: boolean;
  doorbell?: boolean;
  rf?: boolean;
  package?: boolean;
}

export interface ParsedRecordingFileName {
  baseName: string;
  ext: string;
  streamHint: RecordingVodStreamHint;
  version: number;
  devType: RecordingDevType;
  start: Date;
  end: Date;
  durationMs: number;
  /** Frame rate extracted from filename hex flags (if available) */
  framerate?: number;
  /** File size in bytes extracted from filename (last hex field before extension) */
  sizeBytes?: number;
  flags?: RecordingVodFlags;
  rawFlags?: Record<string, number>;
  animalTypeRaw?: string;
  widthRaw?: string;
  heightRaw?: string;
}

export interface RecordingFile {
  /** Camera-provided recording identifier (often a filename/path, e.g. "00_YYYYMMDDHHMMSS"). */
  fileName: string;
  /** Optional human-friendly name when provided separately (e.g. FileInfoList <name>). */
  name?: string;
  /** Optional full path/identifier when provided separately (e.g. FileInfoList <Id>). */
  id?: string;
  /** Optional size when provided by the camera (bytes). */
  sizeBytes?: number;
  /** Optional recordType when provided (e.g. md, people, sched, manual...). */
  recordType?: string;
  /** Optional start time when provided as YYYY/MM/DD etc; best-effort parsing may be absent. */
  startTime?: Date;
  /** Optional end time when provided. */
  endTime?: Date;

  /** Parsed metadata extracted from the file name when it matches known Reolink VOD patterns. */
  parsedFileName?: ParsedRecordingFileName;

  /** Detection classes for this recording (e.g. person, vehicle, animal, face, motion, doorbell, package) */
  detectionClasses?: RecordingDetectionClass[];
}

/**
 * A RecordingFile associated with an explicit logical channel.
 *
 * Useful for NVR/Hub-style listings where you query multiple channels and
 * want to keep the channel number alongside each returned file/event.
 */
export interface ChannelRecordingFile extends RecordingFile {
  channel: number;
  /** Optional UID used for the request (when known). */
  uid?: string;
}

export type RecordingDetectionClass =
  | "person"
  | "vehicle"
  | "animal"
  | "face"
  | "package"
  | "doorbell"
  | "rf"
  | "other"
  | "motion"
  | "schedule";

export interface DownloadRecordingParams {
  channel: number;
  uid?: string;
  /** Recording identifier (usually one of the `fileName` returned by getVideoclips). */
  fileName: string;
  timeoutMs?: number;
}

export type RecordingPlaybackUrls = {
  /** RTMP VOD URL for playback/export. */
  rtmpVodUrl: string;
};

export type PlaybackSnapshotStreamInfo = {
  width?: number;
  height?: number;
  frameRate?: number;
};

export type VideoclipThumbnailResult = {
  /** Raw I-frame data (H.264 or H.265) */
  frame: Buffer;
  /** Video encoding type detected from frame header */
  encoding: string;
  /** Frame length in bytes */
  frameLength: number;
  /** Frame timestamp (Unix seconds) if available */
  frameTime?: number;
  /** Stream metadata from header */
  streamInfo: PlaybackSnapshotStreamInfo;
};

/**
 * Detailed information about channel capabilities for dual lens models.
 */
export interface DualLensChannelInfo {
  /** Channel number (0-based) */
  channel: number;
  /** Indicates whether this channel supports pan */
  hasPan: boolean;
  /** Indicates whether this channel supports tilt */
  hasTilt: boolean;
  /** Indicates whether this channel supports zoom */
  hasZoom: boolean;
  /** Indicates whether this channel supports motion detection */
  hasMotion: boolean;
  /** Indicates whether this channel supports intercom (two-way audio) */
  hasIntercom: boolean;
  /** Indicates whether this channel supports PTZ presets */
  hasPresets: boolean;
  /** Channel type: "wide" for wide-angle lens, "telephoto" for telephoto lens */
  lensType?: "wide" | "telephoto" | undefined;
  /** Which Native variant maps to this lens (default=wide; autotrack/telephoto=tele lens depending on context). */
  variantType?: NativeVideoStreamVariant;
  /** Available streams for this channel */
  availableStreams: {
    /** RTSP stream available */
    rtsp: boolean;
    /** RTMP stream available */
    rtmp: boolean;
    /** Native Baichuan stream available */
    native: boolean;
  };
}

/**
 * Result of dual lens channel analysis.
 */
export interface DualLensChannelAnalysis {
  /** Indicates whether the device is a dual lens model */
  isDualLens: boolean;
  /** Dual lens model type: "dual_motion" (Duo) or "single_motion" (TrackMix) */
  dualLensType?: "dual_motion" | "single_motion" | undefined;
  /** Device model */
  model?: string | undefined;
  /** Total number of available stream channels */
  streamChannelCount?: number | undefined;
  /** Total number of logical channels */
  logicalChannelCount?: number | undefined;
  /** Detailed information for each channel */
  channels: DualLensChannelInfo[];
  /** Maps each capability to the list of channel numbers (0-based) that support it.
   * Use this to determine which channels to send commands to.
   */
  capabilityChannels: {
    /** Channel numbers that support pan */
    pan: number[];
    /** Channel numbers that support tilt */
    tilt: number[];
    /** Channel numbers that support zoom */
    zoom: number[];
    /** Channel numbers that support motion detection */
    motion: number[];
    /** Channel numbers that support intercom (two-way audio) */
    intercom: number[];
    /** Channel numbers that support PTZ presets */
    presets: number[];
  };
}

// ---------------------------------------------------------------------------
// Recording download result types
// ---------------------------------------------------------------------------

/**
 * Video codec type detected from BcMedia stream.
 */
export type RecordingVideoCodec = "H264" | "H265";

/**
 * Audio codec type detected from BcMedia stream.
 */
export type RecordingAudioCodec = "Aac" | "Adpcm";

/**
 * Statistics returned by getRecordingVideo() about the demuxed/muxed recording.
 */
export interface GetRecordingVideoStats {
  /** Total bytes received from camera */
  bytesIn: number;
  /** Total video bytes after demuxing */
  videoBytesOut: number;
  /** Total audio bytes after demuxing */
  audioBytesOut: number;
  /** Number of video packets */
  videoPackets: number;
  /** Number of audio packets */
  audioPackets: number;
  /** Number of keyframes */
  keyframes: number;
  /** Calculated frames per second */
  fps: number;
  /** Duration in seconds */
  durationSeconds: number;
  /** Video codec detected */
  videoCodec: RecordingVideoCodec;
  /** Audio codec detected (null if no audio) */
  audioCodec: RecordingAudioCodec | null;
  /** Whether audio was present */
  hasAudio: boolean;
}

/**
 * Result of getRecordingVideo() - a fully muxed MP4 with stats.
 */
export interface GetRecordingVideoResult {
  /** MP4 file with video and audio muxed together */
  mp4: Buffer;
  /** Statistics about the demuxing/muxing process */
  stats: GetRecordingVideoStats;
}

/**
 * Parameters for getVideoclips() recording search.
 */
export interface GetVideoclipsParams {
  /** Channel number (0-based). Optional for standalone cameras, required for NVR. */
  channel?: number;
  /** Start time for search */
  start: Date;
  /** End time for search */
  end: Date;
  /** Stream type. Default: "subStream" */
  streamType?: RecordingStreamType;
  /** Comma-separated record types. Default includes all types. */
  recordType?: string;
  /** Explicit UID (skip auto-discovery if provided) */
  uid?: string;
  /** Per-request timeout in ms. Default: 15000 */
  timeoutMs?: number;
  /** Max pagination iterations. Default: 50 */
  maxIterations?: number;
}

// ============================================================================
// Typed API Response Interfaces (extracted from XML responses)
// These represent the actual content without the outer <body> wrapper
// ============================================================================

/**
 * AudioTask configuration - controls siren/alarm on motion detection.
 * Retrieved via cmdId=232 (GET) and set via cmdId=231 (SET).
 */
export interface AudioTaskConfig {
  body?: {
    AudioTask?: {
      channelId?: number;
      /** 0 = disabled, 1 = enabled */
      enable?: number;
      typeScheduleList?: {
        item?: Array<{
          type?: string;
          valueTable?: string;
        }>;
      };
    };
  };
}

/**
 * Audio configuration settings (getAudioCfg response).
 */
export interface AudioCfgConfig {
  body?: {
    AudioCfg?: {
      channelId?: number;
      timeout?: number;
      audioSelect?: number;
      volume?: number;
      preAlarm?: number;
      audioListId?: number;
      visitorLoudspeaker?: number;
    };
  };
}

/**
 * Day/Night threshold configuration.
 */
export interface DayNightThresholdConfig {
  body?: {
    DayNightThreshold?: {
      channelId?: number;
      threshold?: string;
      stat?: string;
      thresholdval?: {
        min?: number;
        max?: number;
        cur?: number;
      };
    };
  };
}

/**
 * AI denoise configuration.
 */
export interface AiDenoiseConfig {
  body?: {
    AiDenoise?: {
      channelId?: number;
      enable?: number;
      level?: number;
    };
  };
}

/**
 * Recording encryption configuration.
 */
export interface RecEncConfig {
  body?: {
    RecEnc?: {
      enable?: number;
      pwdValid?: number;
    };
  };
}

/**
 * AI configuration - includes autotracking (smartTrack) settings.
 * Retrieved via cmdId=299 (GET) and set via cmdId=300 (SET).
 */
export interface AiConfig {
  body?: {
    AiCfg?: {
      channelId?: number;
      /** 0 = disabled, 1 = enabled - controls autotracking */
      smartTrack?: number;
      /** Tracking mode (0=normal, 1=digital, etc.) */
      smartTrackMode?: number;
      smartTrackModeAbility?: number;
      /** Comma-separated detection types (e.g. "people,vehicle,dog_cat") */
      detectType?: string;
      /** Comma-separated tracking types */
      smartTrackType?: string;
      smartTrackPt?: number;
      smartTrackObjectStopDelay?: number;
      smartTrackObjectDisappearDelay?: number;
      cryDetectLevel?: number;
      cryDetectAbility?: number;
      trackPriorities?: {
        item?: string[];
      };
    };
  };
}

/**
 * Floodlight task configuration - controls floodlight on motion.
 * Retrieved via cmdId=289 (GET) and set via cmdId=290 (SET).
 */
export interface FloodlightTaskConfig {
  body?: {
    FloodlightTask?: {
      channelId?: number | undefined;
      /** 0 = disabled, 1 = enabled - controls floodlight on motion */
      alarmMode?: number | undefined;
      enable?: number | undefined;
      brightness_cur?: number | undefined;
      duration?: number | undefined;
      detectType?: string | undefined;
    };
  };
}

/**
 * White LED state configuration.
 */
export interface WhiteLedConfig {
  body?: {
    WhiteLed?: {
      channelId?: number | undefined;
      /** 0 = off, 1 = on */
      state?: number | undefined;
      /** Brightness level */
      bright?: number | undefined;
      /** LED mode */
      mode?: number | undefined;
      /** Light state (for some camera models) */
      LightState?: number | undefined;
    };
  };
}

/**
 * PIR sensor configuration.
 */
export interface PirConfig {
  body?: {
    PirInfo?: {
      channelId?: number | undefined;
      /** 0 = disabled, 1 = enabled */
      enable?: number | undefined;
      sensitivity?: number | undefined;
      scheduleEnable?: number | undefined;
    };
  };
}

// ============================================================================
// Additional API Response Interfaces
// ============================================================================

/**
 * Motion alarm configuration (getMotionAlarm response).
 * cmdId=46 (GetMdAlarm)
 */
export interface MotionAlarmConfig {
  body?: {
    MdAlarm?: {
      channelId?: number | undefined;
      sensInfoNew?: {
        enable?: number | undefined;
        sensitivity?: number | undefined;
        alarmType?: number | undefined;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
  };
}

/**
 * AI alarm/detection configuration (getAiAlarmRaw response).
 * cmdId=342 (GetAiAlarm)
 */
export interface AiAlarmConfig {
  body?: {
    AiAlarm?: {
      channelId?: number | undefined;
      chn?: number | undefined;
      type?: string | undefined;
      enabled?: number | undefined;
      sensitivity?: number | undefined;
      trackType?: string | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Per-stream encoding entry inside `Compression`. Captured live on
 * E1-Zoom (TCP), Doorbell (UDP), Hub channel-0 (Argus 3E).
 *
 * Note: the camera-side field name is `frame`, NOT `frameRate`.
 * `videoEncType` is a numeric enum (`0` = h264, `1` = h265). The
 * `gop`/`encoderType`/`separateCfg` sub-blocks are firmware-dependent
 * (Hub-channel cameras carry them; standalone devices may not).
 */
export interface CompressionStream {
  audio?: number | undefined;
  resolutionName?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  frame?: number | undefined;
  bitRate?: number | undefined;
  encoderProfile?: string | undefined;
  videoEncType?: number | undefined;
  gop?: { cur?: number; max?: number; min?: number } | undefined;
  encoderType?: string | undefined;
  [key: string]: unknown;
}

/**
 * One allowable resolution from a `getEncOptions` reply.
 * `videoEncTypeList` enumerates the codecs supported at this resolution
 * (mapped to `"h264"`/`"h265"`).
 */
export interface EncResolutionOption {
  width: number;
  height: number;
  /** Codecs available at this resolution. */
  videoEncTypes: Array<"h264" | "h265">;
  /** Camera-default framerate at this resolution, if reported. */
  defaultFramerate?: number;
  /** Camera-default bitrate (kbps) at this resolution, if reported. */
  defaultBitrate?: number;
  /** Camera-default GOP at this resolution, if reported. */
  defaultGop?: number;
  /** Allowed framerate values. */
  framerateOptions: number[];
  /** Allowed bitrate values (kbps). */
  bitrateOptions: number[];
}

/**
 * Allowable values for a single stream profile (mainStream / subStream / thirdStream).
 * Aggregated from `getStreamInfoList` (cmd_146) so consumers can populate UI
 * pickers without re-implementing the parsing logic.
 */
export interface EncStreamOptions {
  /** Stream profile (one of `mainStream` / `subStream` / `thirdStream`). */
  type: string;
  /** Each entry is a `{width, height}` paired with its allowed values. */
  resolutions: EncResolutionOption[];
  /** Encoder rate-control modes Reolink exposes in the app. */
  encoderTypes: Array<"vbr" | "cbr">;
  /** Encoder profiles Reolink exposes in the app. */
  encoderProfiles: Array<"high" | "main" | "baseline">;
}

/**
 * Reply from `getEncOptions` — the set of allowable values for `setEnc`,
 * derived from `getStreamInfoList`. Use this to validate user input or
 * populate UI selectors.
 */
export interface EncOptions {
  channel: number;
  mainStream?: EncStreamOptions;
  subStream?: EncStreamOptions;
  thirdStream?: EncStreamOptions;
}

/**
 * Patch payload accepted by `setEnc` for a single stream block
 * (`mainStream` / `subStream` / `thirdStream`). All fields optional —
 * unspecified ones are preserved from the device's current config.
 */
export interface EncStreamPatch {
  audio?: 0 | 1;
  width?: number;
  height?: number;
  bitRate?: number;
  frameRate?: number;
  videoEncType?: "h264" | "h265";
  encoderType?: "vbr" | "cbr";
  encoderProfile?: "high" | "main" | "baseline";
  /** Keyframe interval in seconds — patches `<gop><cur>`. */
  gop?: number;
}

/**
 * Encoding configuration (getEnc response).
 * cmdId=56 (GetEnc) — payload is wrapped in `Compression`, not `Enc`.
 */
export interface EncConfig {
  body?: {
    Compression?: {
      channelId?: number | undefined;
      isNoTranslateFrame?: number | undefined;
      mainStream?: CompressionStream | undefined;
      subStream?: CompressionStream | undefined;
      thirdStream?: CompressionStream | undefined;
      separateCfg?: { encodeCfg?: number; [key: string]: unknown } | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * ISP / image input configuration. Both `getIsp` (cmdId=25) and
 * `getImage` (cmdId=26) return identical payloads on observed firmwares
 * — the underlying VideoInput + InputAdvanceCfg blocks. Different
 * cmdIds preserved for backwards compatibility.
 */
export interface IspConfig {
  body?: {
    VideoInput?: {
      channelId?: number | undefined;
      bright?: number | undefined;
      contrast?: number | undefined;
      saturation?: number | undefined;
      hue?: number | undefined;
      sharpen?: number | undefined;
      corridorAbility?: number | undefined;
      corridorMode?: string | undefined;
      [key: string]: unknown;
    };
    InputAdvanceCfg?: {
      channelId?: number | undefined;
      digitalChannel?: number | undefined;
      separateCfg?: { encType?: number; constantFrameRate?: number; [key: string]: unknown } | undefined;
      PowerLineFrequency?: { mode?: string; enable?: number; [key: string]: unknown } | undefined;
      Exposure?: {
        mode?: string;
        Gainctl?: { defMin?: number; defMax?: number; curMin?: number; curMax?: number };
        Shutterctl?: { defMin?: number; defMax?: number; curMin?: number; curMax?: number };
        shutterLevel?: string;
        gainLevel?: number;
        [key: string]: unknown;
      } | undefined;
      Scene?: {
        mode?: string;
        modeList?: string;
        Redgain?: { min?: number; max?: number; cur?: number };
        Bluegain?: { min?: number; max?: number; cur?: number };
        [key: string]: unknown;
      } | undefined;
      DayNight?: { mode?: string; IrcutMode?: string; Threshold?: string; [key: string]: unknown } | undefined;
      BLC?: { enable?: number; mode?: string; [key: string]: unknown } | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * IR / supplemental light state (`getIrLights`). Captured live on every
 * test camera — `state` is the operator-facing toggle, `lightState` is
 * the camera's own runtime status. `doorbellLightState` /
 * `doorbellAbility` only appear on doorbell models.
 */
export interface IrLightsConfig {
  body?: {
    LedState?: {
      channelId?: number | undefined;
      ledVersion?: number | undefined;
      IRLedBrightness?: number | undefined;
      state?: string | undefined;
      lightState?: string | undefined;
      doorbellLightState?: string | undefined;
      doorbellAbility?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Privacy mask configuration (`getMask`). The `Shelter` block always
 * contains `enable` + `maxNum` + `shelterList`; tracked-shelter sub-
 * blocks (`trackEnable`, `trackShelterList`) are PTZ-only and
 * conditional on the camera supporting motion-tracking. Hub-channel
 * cameras include `separateCfg` + `logicChannel`.
 */
export interface MaskConfig {
  body?: {
    Shelter?: {
      channelId?: number | undefined;
      enable?: number | undefined;
      maxNum?: number | undefined;
      shelterList?: unknown;
      trackEnable?: number | undefined;
      maxTrackShelterNum?: number | undefined;
      trackShelterList?: unknown;
      separateCfg?: { shelter?: number; [key: string]: unknown } | undefined;
      logicChannel?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Audio noise reduction configuration (`getAudioNoise`).
 * cmdId=439. Note: the wire tag is lowercase `aiDenoise` (capital `V`
 * in `@_Version`). Mirrors the camera-side schema observed live.
 */
export interface AudioNoiseConfig {
  body?: {
    aiDenoise?: {
      channelId?: number | undefined;
      enable?: number | undefined;
      level?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Auto-focus configuration (`getAutoFocus`). cmdId=224.
 *
 * The `disable` field is a 0/1 flag — `0` means autofocus is ENABLED.
 * Non-PTZ cameras may return an empty `{}` or 400 — callers should
 * narrow `body?.AutoFocus?.disable` defensively.
 */
export interface AutoFocusConfig {
  body?: {
    AutoFocus?: {
      channelId?: number | undefined;
      disable?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Video input configuration.
 * cmdId=75 (GetVideoInput)
 */
export interface VideoInputConfig {
  body?: {
    VideoInput?: {
      channelId?: number | undefined;
      bright?: number | undefined;
      contrast?: number | undefined;
      saturation?: number | undefined;
      hue?: number | undefined;
      irCutSwap?: number | undefined;
      dayNight?: string | undefined;
      [key: string]: unknown;
    };
    InputAdvanceCfg?: {
      [key: string]: unknown;
    };
  };
}

/**
 * System general configuration.
 * cmdId=77 (GetSystemGeneral)
 */
export interface SystemGeneralConfig {
  body?: {
    SystemGeneral?: {
      timeZone?: number | undefined;
      deviceName?: string | undefined;
      language?: string | undefined;
      dstMode?: number | undefined;
      [key: string]: unknown;
    };
    Norm?: {
      [key: string]: unknown;
    };
  };
}

/**
 * Device support/capability flags.
 * cmdId=78 (GetSupport)
 */
export interface SupportConfig {
  body?: {
    Support?: {
      ptzMode?: string | undefined;
      channelNum?: number | undefined;
      wifi?: number | undefined;
      rtsp?: number | undefined;
      rtmp?: number | undefined;
      onvif?: number | undefined;
      email?: number | undefined;
      ftp?: number | undefined;
      push?: number | undefined;
      cloudStorage?: number | undefined;
      ledCtrl?: number | undefined;
      audioAlarm?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Siren status information.
 * cmdId=270 (GetSirenStatus)
 */
export interface SirenStatusConfig {
  body?: {
    SirenStatusList?: {
      channelId?: number | undefined;
      status?: number | undefined;
      playing?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * FTP task configuration.
 */
export interface FtpTaskConfig {
  body?: {
    FtpTask?: {
      channelId?: number | undefined;
      enable?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Email task configuration.
 */
export interface EmailTaskConfig {
  body?: {
    EmailTask?: {
      channelId?: number | undefined;
      enable?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * HDD info list response.
 */
export interface HddInfoListConfig {
  body?: {
    HddInfoList?: {
      itemNum?: number | undefined;
      item?: Array<{
        id?: number | undefined;
        size?: number | undefined;
        used?: number | undefined;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
  };
}

/**
 * Timelapse configuration.
 */
export interface TimelapseCfgConfig {
  body?: {
    TimelapseCfg?: {
      channelId?: number | undefined;
      enable?: number | undefined;
      interval?: number | undefined;
      [key: string]: unknown;
    };
  };
}

/**
 * Access user list response.
 */
export interface AccessUserListConfig {
  body?: {
    AccessUserList?: {
      itemNum?: number | undefined;
      item?: Array<{
        userName?: string | undefined;
        level?: number | undefined;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
  };
}

/**
 * Online user list response.
 */
export interface OnlineUserListConfig {
  body?: {
    OnlineUserList?: {
      itemNum?: number | undefined;
      /** Legacy format (some firmware versions) */
      item?: Array<{
        userName?: string | undefined;
        ip?: string | undefined;
        level?: number | undefined;
        [key: string]: unknown;
      }>;
      /** Current format (OnlineUser array) */
      OnlineUser?: Array<{
        userId?: number | undefined;
        sessionId?: number | undefined;
        userName?: string | undefined;
        userLevel?: number | undefined;
        ipAddress?: string | undefined;
        macAddress?: string | undefined;
        enableOutoffLine?: number | undefined;
        isOnline?: number | undefined;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
  };
}

// ============================================================================
// Videoclip Client Detection Utilities
// ============================================================================

/**
 * Client information extracted from HTTP request headers.
 * Used to determine optimal video delivery format.
 */
export type VideoclipClientInfo = {
  userAgent: string | undefined;
  accept: string | undefined;
  range: string | undefined;
  secChUa: string | undefined;
  secChUaMobile: string | undefined;
  secChUaPlatform: string | undefined;
};

/**
 * Videoclip delivery mode.
 * - `passthrough`: Copy codec as-is (H.264 or H.265)
 * - `transcode-h264`: Transcode H.265 to H.264 for compatibility
 */
export type VideoclipTranscodeMode = "passthrough" | "transcode-h264";

/**
 * Result of videoclip mode decision.
 */
export type VideoclipModeDecision = {
  mode: VideoclipTranscodeMode;
  reason: string;
  clientInfo: VideoclipClientInfo;
};

/**
 * Extract client info from HTTP request headers.
 */
export function getVideoclipClientInfo(
  headers: Record<string, string | string[] | undefined>,
): VideoclipClientInfo {
  const getHeader = (key: string): string | undefined => {
    const val =
      headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
    return Array.isArray(val) ? val[0] : val;
  };

  return {
    userAgent: getHeader("user-agent") ?? getHeader("User-Agent"),
    accept: getHeader("accept") ?? getHeader("Accept"),
    range: getHeader("range") ?? getHeader("Range"),
    secChUa: getHeader("sec-ch-ua") ?? getHeader("Sec-CH-UA"),
    secChUaMobile:
      getHeader("sec-ch-ua-mobile") ?? getHeader("Sec-CH-UA-Mobile"),
    secChUaPlatform:
      getHeader("sec-ch-ua-platform") ?? getHeader("Sec-CH-UA-Platform"),
  };
}

/**
 * Determine if H.265 should be transcoded to H.264 based on client capabilities.
 *
 * Decision logic:
 * - iOS devices (Safari): Need transcoding (no native H.265 in <video> without HLS)
 * - macOS Safari: Supports H.265 natively
 * - Chrome/Edge: Limited H.265 support, safer to transcode
 * - Firefox: No H.265 support, needs transcoding
 * - Android: Variable support, transcode for safety
 *
 * @param headers - HTTP request headers
 * @param forceMode - Optional override: "passthrough" or "transcode-h264"
 * @returns Decision with mode, reason, and client info
 */
export function decideVideoclipTranscodeMode(
  headers: Record<string, string | string[] | undefined>,
  forceMode?: VideoclipTranscodeMode,
): VideoclipModeDecision {
  const clientInfo = getVideoclipClientInfo(headers);

  // If force mode is specified, use it
  if (forceMode) {
    return {
      mode: forceMode,
      reason: `forced: ${forceMode}`,
      clientInfo,
    };
  }

  const ua = (clientInfo.userAgent ?? "").toLowerCase();
  const platform = (clientInfo.secChUaPlatform ?? "")
    .toLowerCase()
    .replace(/"/g, "");

  // iOS devices (iPhone, iPad, iPod) - no native H.265 in <video> element
  const isIos = /iphone|ipad|ipod/.test(ua);
  if (isIos) {
    return {
      mode: "transcode-h264",
      reason: "iOS device detected - no native H.265 support in <video>",
      clientInfo,
    };
  }

  // Firefox - no H.265 support at all
  const isFirefox = ua.includes("firefox");
  if (isFirefox) {
    return {
      mode: "transcode-h264",
      reason: "Firefox detected - no H.265 support",
      clientInfo,
    };
  }

  // Android - variable H.265 support, safer to transcode
  const isAndroid = ua.includes("android") || platform === "android";
  if (isAndroid) {
    return {
      mode: "transcode-h264",
      reason: "Android device detected - variable H.265 support",
      clientInfo,
    };
  }

  // Chrome/Edge on non-Mac - limited H.265 support
  const isChromium = ua.includes("chrome") || ua.includes("edg");
  const isMac = ua.includes("mac os") || platform === "macos";
  if (isChromium && !isMac) {
    return {
      mode: "transcode-h264",
      reason: "Chrome/Edge on non-Mac detected - limited H.265 support",
      clientInfo,
    };
  }

  // macOS Safari or Chrome on Mac - good H.265 support via VideoToolbox
  if (isMac) {
    return {
      mode: "passthrough",
      reason: "macOS detected - native H.265 hardware decoding available",
      clientInfo,
    };
  }

  // Default: transcode for safety
  return {
    mode: "transcode-h264",
    reason: "Unknown client - transcoding for compatibility",
    clientInfo,
  };
}

// --------------------
// Chime / DingDong types
// --------------------

/** A paired wireless chime device as returned by GetDingDongList. */
export interface ChimeDevice {
  id: number;
  name: string;
  /** 0 = offline, 1 = online */
  netState: number;
}

/** Wireless chime parameters returned by DingDongOpt (option 2 / getParam). */
export interface ChimeParams {
  name?: string;
  /** Volume level (0-4 typical) */
  volLevel?: number;
  /** LED state: 0 = off, 1 = on */
  ledState?: number;
}

/** Per-event alarm config entry inside a chime's GetDingDongCfg response. */
export interface ChimeAlarmCfg {
  /** Whether this event type triggers the chime: 0 = off, 1 = on */
  valid: number;
  /** Ringtone / music ID */
  musicId: number;
}

/** Per-chime config from GetDingDongCfg. */
export interface ChimeCfg {
  /** Chime ring ID */
  id: number;
  /** Map of event type string → alarm config */
  type: Record<string, ChimeAlarmCfg>;
}

/** Hardwired (wired-in) chime state from GetDingDongCtrl / SetDingDongCtrl. */
export interface HardwiredChimeState {
  /** Chime type string (e.g. "dingdong", "single", "dual") */
  type: string;
  /** Whether the chime is enabled */
  enabled: boolean;
  /** Duration / timing value */
  time: number;
}

/** Wireless chime silent mode state from GetDingDongSilent / SetDingDongSilent. */
export interface WirelessChimeSilentState {
  /** The wireless chime device ID */
  id: number;
  /**
   * Silent mode duration in seconds.
   * 0 = not silenced (chime active), >0 = silenced for this many seconds.
   */
  time: number;
  /** Whether the chime is currently active (not silenced). Derived: time === 0 */
  active: boolean;
}
