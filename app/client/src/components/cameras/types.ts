export type StreamProfile = "main" | "sub" | "ext";

export type AvailableStream = {
  id: string;
  profile: StreamProfile;
  channel: number;
  lensType?: "wide" | "telephoto" | "composite";
  resolution?: string;
  codec?: string;
};

export type RtspStreamConfig = {
  profile: StreamProfile;
  channel: number;
  enabled: boolean;
  autoStart: boolean;
  port?: number;
  token?: string;
};

export type CameraInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
  status: "connected" | "disconnected" | "error";
  error?: string;
  deviceInfo?: {
    model?: string;
    hubModel?: string;
    channelName?: string;
    channelCount?: number;
    firmwareVersion?: string;
    serialNumber?: string;
    isNvr?: boolean;
    isMultifocal?: boolean;
  };
  sanitizedName: string;
  rtspChannel: number;
  isNvr: boolean;
  nvrId?: string;
  isBattery?: boolean;
  batteryMode?: "alwaysOn" | "streamOnly";
  sleepStatus?: "awake" | "sleeping";
  debugLogs: boolean;
  autoStart: boolean;
  rtspStreams: RtspStreamConfig[];
};

export type DropdownItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type CameraEvent = {
  cameraId: string;
  cameraName: string;
  cameraNameSlug: string;
  type: string;
  channel: number;
  timestamp: number;
  timestampIso: string;
  streamType?: string;
  profile?: string;
  clientCount?: number;
};

export type PreviewKind = "mjpeg" | "webrtc" | "hls";

export type PreviewModalState =
  | {
      open: true;
      kind: PreviewKind;
      title: string;
      cameraName: string;
      profile: StreamProfile;
      /** go2rtc stream name for WHEP signaling. */
      streamName?: string;
      /** go2rtc API port for direct access. */
      go2rtcApiPort?: number | null;
      /** Service IP for building go2rtc URLs. */
      serviceIp?: string;
      mjpegUrl?: string;
      hlsUrl?: string;
    }
  | { open: false };

export type AddCameraInput = {
  name?: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  isNvr: boolean;
  nvrChannel: number;
};

export type NvrChannel = {
  channel: number;
  name: string;
  model: string;
  uid: string;
  state: string;
  online: boolean;
  isMultifocal: boolean;
  isBattery: boolean;
  isDoorbell: boolean;
  ip: string;
};

export type NvrInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
};

export type ControlsState = {
  hasFloodlight: boolean;
  hasSiren: boolean;
  hasPtz: boolean;
  hasPresets: boolean;
  hasAutotracking: boolean;
  hasPir: boolean;
  lightOn?: boolean;
  sirenOn?: boolean;
  floodlightOnMotion?: boolean;
  sirenOnMotion?: boolean;
  autotrackingOn?: boolean;
  pirOn?: boolean;
  ptzPresets: Array<{ id: number; name: string }>;
} | null;
