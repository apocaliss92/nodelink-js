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

// Full config file schema
export const ConfigFileSchema = z.object({
  cameras: z.array(CameraConfigSchema),
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
