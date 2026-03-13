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

export type ControlsState = {
  hasFloodlight: boolean;
  hasSiren: boolean;
  hasPtz: boolean;
  hasPresets: boolean;
  lightOn?: boolean;
  sirenOn?: boolean;
  ptzPresets: Array<{ id: number; name: string }>;
} | null;
