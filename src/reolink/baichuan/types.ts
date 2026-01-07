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

export interface PtzCommand {
  action: "start" | "stop";
  command: "Left" | "Right" | "Up" | "Down" | "ZoomIn" | "ZoomOut" | "FocusNear" | "FocusFar";
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

export interface PirState {
  enabled: boolean;
  state?: {
    enable?: number;
    channel?: number;
    [key: string]: unknown;
  };
}

export interface WhiteLedState {
  enabled: boolean;
  brightness?: number;
}

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

export interface ChannelStreamMetadata {
  channel: number;
  streams: StreamMetadata[];
  audioEnabled: boolean; // Overall audio enabled (AND of all streams)
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
  | "other";

export interface ReolinkSimpleEvent {
  type: ReolinkSimpleEventType;
  channel: number;
  timestamp: number;
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
}

/**
 * Enriched recording file with all parsed metadata, ready for consumption.
 * Contains detection flags, duration, timestamps in milliseconds, and playback URLs.
 */
export interface EnrichedRecordingFile {
  /** Original file name/path from the camera */
  fileName: string;
  /** Unique identifier for the recording */
  id: string;
  /** Start time in milliseconds since epoch */
  startTimeMs: number;
  /** End time in milliseconds since epoch */
  endTimeMs: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** File size in bytes (if available) */
  sizeBytes?: number;
  
  // Detection flags (from hex decoding or recordType parsing)
  /** Person/people detected */
  hasPerson: boolean;
  /** Vehicle detected */
  hasVehicle: boolean;
  /** Animal (dog/cat) detected */
  hasAnimal: boolean;
  /** Face detected */
  hasFace: boolean;
  /** Motion detected */
  hasMotion: boolean;
  /** Scheduled recording */
  hasSchedule: boolean;
  /** Doorbell/visitor event */
  hasDoorbell: boolean;
  /** Package event */
  hasPackage: boolean;
  /** RF sensor trigger */
  hasRf: boolean;
  /** Other AI detection */
  hasOther: boolean;
  
  /** Original record type string from camera (e.g. "md,people,dog_cat") */
  recordType?: string;
  
  /** RTMP VOD playback URL (if available) */
  rtmpUrl?: string;
  
  /** Stream type hint (main/sub/unknown) */
  streamHint: RecordingVodStreamHint;
  
  /** Device type (cam/hub) */
  devType: RecordingDevType;
  
  /** Raw parsed filename data for advanced usage */
  parsedFileName?: ParsedRecordingFileName;
  
  /** Original RecordingFile for reference */
  raw: RecordingFile;
}

export interface ListRecordingsParams {
  channel: number;
  uid: string;
  start: Date;
  end: Date;
  streamType?: RecordingStreamType;
  /** Comma-separated list for Reolink XML, e.g. "manual, sched, io, md, people". */
  recordType?: string;
  /**
   * If true (default), when FileInfoList returns no results, try the alternate Baichuan listing
   * based on <findAlarmVideo> (cmdId 272/273/274).
   */
  fallbackToAlarmVideo?: boolean;
  /** Safety limit for pagination/iterations (default 50). */
  maxIterations?: number;
}

export interface DownloadRecordingParams {
  channel: number;
  uid: string;
  /** Recording identifier (usually one of the `fileName` returned by listRecordings). */
  fileName: string;
  /** If true, fall back to HTTP CGI `cmd=Download` when Baichuan download fails/times out. Default: false (socket-first). */
  fallbackToHttp?: boolean;
  timeoutMs?: number;
}

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

