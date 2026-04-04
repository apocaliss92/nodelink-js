import { z } from "zod";

// RTSP Stream configuration (per stream, within a camera)
export const RtspStreamConfigSchema = z.object({
  profile: z.enum(["main", "sub", "ext"]),
  channel: z.number().default(0),
  port: z.number().optional(), // Remember assigned port for this stream
  token: z.string().optional(), // Random token for RTSP path (instead of camera name)
  enabled: z.boolean().default(false),
  autoStart: z.boolean().default(false), // Auto-start this stream on server startup
});

export type RtspStreamConfig = z.infer<typeof RtspStreamConfigSchema>;

// Camera configuration schema
export const CameraConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().default(9000),
  username: z.string(),
  password: z.string(),
  channels: z.number().default(1),
  // Explicitly mark this camera as a channel on an NVR/Hub
  // (so the UI can show the channel even if it's 0)
  isNvr: z.boolean().default(false),
  // Reference to parent NVR (if this camera was added via NVR discovery)
  nvrId: z.string().optional(),
  // Whether this camera is battery-powered (affects query behavior)
  isBattery: z.boolean().default(false),
  // Battery behavior: "alwaysOn" keeps camera awake while connected,
  // "streamOnly" wakes on stream and sleeps after last client disconnects
  batteryMode: z.enum(["alwaysOn", "streamOnly"]).optional().default("streamOnly"),
  // UID for BCUDP discovery (battery/wireless cameras). Required for UDP transport.
  // When omitted and transport is "auto", local-direct UDP discovery is attempted using the host IP.
  uid: z.string().optional(),
  // Transport protocol. Default "auto": tries TCP first, falls back to UDP if TCP fails.
  transport: z.enum(["tcp", "udp", "auto"]).optional().default("auto"),
  // UDP discovery method. Default "local-direct" when no UID is set.
  udpDiscoveryMethod: z
    .enum(["local-broadcast", "local-direct", "remote", "map", "relay"])
    .optional(),
  // Debug logging for this camera
  debugLogs: z.boolean().default(false),
  // Auto-connect and auto-start streams on server startup
  autoStart: z.boolean().default(false),
  // RTSP streams configuration (multiple streams per camera)
  rtspStreams: z.array(RtspStreamConfigSchema).default([]),
  // Legacy fields (for backward compatibility, will be migrated)
  rtspEnabled: z.boolean().default(false),
  rtspPort: z.number().optional(),
  rtspProfile: z.enum(["main", "sub", "ext"]).default("main"),
  rtspChannel: z.number().default(0),
  // Note: RTSP authentication credentials are now managed globally in settings
});

export type CameraConfig = z.infer<typeof CameraConfigSchema>;

// RTSP Server configuration schema
export const RtspServerConfigSchema = z.object({
  id: z.string(),
  cameraId: z.string(),
  channel: z.number().default(0),
  profile: z.enum(["main", "sub", "ext"]).default("main"),
  port: z.number(),
  enabled: z.boolean().default(true),
});

export type RtspServerConfig = z.infer<typeof RtspServerConfigSchema>;

// NVR configuration schema
export const NvrConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().default(9000),
  username: z.string(),
  password: z.string(),
});

export type NvrConfig = z.infer<typeof NvrConfigSchema>;

// Full config file schema
export const ConfigFileSchema = z.object({
  cameras: z.array(CameraConfigSchema),
  nvrs: z.array(NvrConfigSchema).default([]),
  rtspServers: z.array(RtspServerConfigSchema),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

// API connection params
export const ConnectionParamsSchema = z.object({
  host: z.string(),
  port: z.number().default(9000),
  username: z.string(),
  password: z.string(),
});

export type ConnectionParams = z.infer<typeof ConnectionParamsSchema>;
