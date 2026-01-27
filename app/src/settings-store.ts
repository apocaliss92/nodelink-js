import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CameraConfigSchema,
  RtspServerConfigSchema,
  type CameraConfig,
  type RtspServerConfig,
} from "./types.js";

// RTSP Credential schema
export const RtspCredentialSchema = z.object({
  id: z.string(),
  username: z.string(),
  password: z.string(),
  description: z.string().optional(),
});

export type RtspCredential = z.infer<typeof RtspCredentialSchema>;

// Unified Settings schema (includes cameras and rtspServers)
export const SettingsSchema = z.object({
  // Server
  serverPort: z.number().default(3000),
  serviceIp: z.string().default("localhost"), // IP/hostname to show in RTSP URLs

  // Logging (LOGS_PATH env var can override default)
  logsPath: z.string().default(process.env.LOGS_PATH || "./logs"),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  logRetentionDays: z.number().default(14),

  // RTSP defaults
  rtspDefaultPort: z.number().default(8554),

  // RTSP Authentication
  rtspCredentials: z.array(RtspCredentialSchema).default([]),
  rtspRequireAuth: z.boolean().default(false),

  // Cameras and RTSP servers (previously in config.json)
  cameras: z.array(CameraConfigSchema).default([]),
  rtspServers: z.array(RtspServerConfigSchema).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;

const SETTINGS_FILE = process.env.SETTINGS_PATH || "./settings.json";

let settings: Settings = SettingsSchema.parse({});

// Load settings from file
export function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
      const parsed = JSON.parse(data);
      settings = SettingsSchema.parse(parsed);
    }
  } catch (error) {
    console.error("Failed to load settings, using defaults:", error);
    settings = SettingsSchema.parse({});
  }
  return settings;
}

// Save settings to file
export function saveSettings(newSettings: Partial<Settings>): Settings {
  settings = SettingsSchema.parse({ ...settings, ...newSettings });

  // Ensure directory exists
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

// Get current settings
export function getSettings(): Settings {
  return settings;
}

// ==================== RTSP Credentials ====================

export function getRtspCredentials(): RtspCredential[] {
  return settings.rtspCredentials;
}

export function addRtspCredential(
  credential: Omit<RtspCredential, "id">,
): RtspCredential {
  const id = `cred_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const newCredential: RtspCredential = { ...credential, id };
  settings.rtspCredentials = [...settings.rtspCredentials, newCredential];
  saveSettings(settings);
  return newCredential;
}

export function updateRtspCredential(
  id: string,
  updates: Partial<Omit<RtspCredential, "id">>,
): RtspCredential | null {
  const index = settings.rtspCredentials.findIndex((c) => c.id === id);
  if (index === -1) return null;

  const updated = { ...settings.rtspCredentials[index]!, ...updates };
  settings.rtspCredentials = [
    ...settings.rtspCredentials.slice(0, index),
    updated,
    ...settings.rtspCredentials.slice(index + 1),
  ];
  saveSettings(settings);
  return updated;
}

export function deleteRtspCredential(id: string): boolean {
  const index = settings.rtspCredentials.findIndex((c) => c.id === id);
  if (index === -1) return false;

  settings.rtspCredentials = [
    ...settings.rtspCredentials.slice(0, index),
    ...settings.rtspCredentials.slice(index + 1),
  ];
  saveSettings(settings);
  return true;
}

// ==================== Cameras ====================

export function getCameras(): CameraConfig[] {
  return settings.cameras;
}

export function getCamera(id: string): CameraConfig | undefined {
  return settings.cameras.find((c) => c.id === id);
}

export function addCamera(
  camera: Omit<CameraConfig, "id"> & { id?: string },
): CameraConfig {
  const newCamera: CameraConfig = {
    ...camera,
    id: camera.id || randomUUID(),
  } as CameraConfig;
  settings.cameras = [...settings.cameras, newCamera];
  saveSettings(settings);
  return newCamera;
}

export function updateCamera(
  id: string,
  updates: Partial<CameraConfig>,
): CameraConfig | null {
  const index = settings.cameras.findIndex((c) => c.id === id);
  if (index === -1) return null;

  const updated = { ...settings.cameras[index]!, ...updates };
  settings.cameras = [
    ...settings.cameras.slice(0, index),
    updated,
    ...settings.cameras.slice(index + 1),
  ];
  saveSettings(settings);
  return updated;
}

export function deleteCamera(id: string): boolean {
  const index = settings.cameras.findIndex((c) => c.id === id);
  if (index === -1) return false;

  settings.cameras = [
    ...settings.cameras.slice(0, index),
    ...settings.cameras.slice(index + 1),
  ];
  // Also remove associated RTSP servers
  settings.rtspServers = settings.rtspServers.filter((s) => s.cameraId !== id);
  saveSettings(settings);
  return true;
}

// ==================== RTSP Servers ====================

export function getRtspServers(): RtspServerConfig[] {
  return settings.rtspServers;
}

export function getRtspServer(id: string): RtspServerConfig | undefined {
  return settings.rtspServers.find((s) => s.id === id);
}

export function addRtspServer(server: RtspServerConfig): RtspServerConfig {
  settings.rtspServers = [...settings.rtspServers, server];
  saveSettings(settings);
  return server;
}

export function updateRtspServer(
  id: string,
  updates: Partial<RtspServerConfig>,
): RtspServerConfig | null {
  const index = settings.rtspServers.findIndex((s) => s.id === id);
  if (index === -1) return null;

  const updated = { ...settings.rtspServers[index]!, ...updates };
  settings.rtspServers = [
    ...settings.rtspServers.slice(0, index),
    updated,
    ...settings.rtspServers.slice(index + 1),
  ];
  saveSettings(settings);
  return updated;
}

export function deleteRtspServer(id: string): boolean {
  const index = settings.rtspServers.findIndex((s) => s.id === id);
  if (index === -1) return false;

  settings.rtspServers = [
    ...settings.rtspServers.slice(0, index),
    ...settings.rtspServers.slice(index + 1),
  ];
  saveSettings(settings);
  return true;
}

// ==================== Camera Stream Config ====================

export function upsertCameraStream(
  cameraId: string,
  streamConfig: {
    profile: "main" | "sub" | "ext";
    channel: number;
    port?: number;
    token?: string;
    enabled?: boolean;
    autoStart?: boolean;
  },
): boolean {
  const cameraIndex = settings.cameras.findIndex((c) => c.id === cameraId);
  if (cameraIndex === -1) return false;

  const camera = { ...settings.cameras[cameraIndex]! };

  // Ensure rtspStreams array exists
  if (!camera.rtspStreams) {
    camera.rtspStreams = [];
  }

  // Find existing stream config
  const existingIndex = camera.rtspStreams.findIndex(
    (s) =>
      s.profile === streamConfig.profile && s.channel === streamConfig.channel,
  );

  if (existingIndex >= 0) {
    // Update existing
    camera.rtspStreams = [
      ...camera.rtspStreams.slice(0, existingIndex),
      { ...camera.rtspStreams[existingIndex]!, ...streamConfig },
      ...camera.rtspStreams.slice(existingIndex + 1),
    ];
  } else {
    // Add new with defaults
    camera.rtspStreams = [
      ...camera.rtspStreams,
      {
        profile: streamConfig.profile,
        channel: streamConfig.channel,
        port: streamConfig.port,
        token: streamConfig.token,
        enabled: streamConfig.enabled ?? true,
        autoStart: streamConfig.autoStart ?? true,
      },
    ];
  }

  settings.cameras = [
    ...settings.cameras.slice(0, cameraIndex),
    camera,
    ...settings.cameras.slice(cameraIndex + 1),
  ];
  saveSettings(settings);
  return true;
}

export function setStreamAutoStart(
  cameraId: string,
  profile: "main" | "sub" | "ext",
  channel: number,
  autoStart: boolean,
): boolean {
  const cameraIndex = settings.cameras.findIndex((c) => c.id === cameraId);
  if (cameraIndex === -1) return false;

  const camera = settings.cameras[cameraIndex]!;
  const stream = camera.rtspStreams?.find(
    (s) => s.profile === profile && s.channel === channel,
  );

  if (stream) {
    return upsertCameraStream(cameraId, { profile, channel, autoStart });
  }
  return false;
}

// ==================== Config compatibility (for getConfig) ====================

export function getConfig(): {
  cameras: CameraConfig[];
  rtspServers: RtspServerConfig[];
} {
  return {
    cameras: settings.cameras,
    rtspServers: settings.rtspServers,
  };
}

// Initialize settings on module load
loadSettings();
