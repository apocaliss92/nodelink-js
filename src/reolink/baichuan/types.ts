/**
 * TypeScript types for Baichuan API responses and parameters.
 * Based on Scrypted reolink-api.ts and Reolink API documentation.
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

