import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  CameraConfigSchema,
  NvrConfigSchema,
  RtspServerConfigSchema,
  type CameraConfig,
  type NvrConfig,
  type RtspServerConfig,
} from "./types.js";
import { hashPassword } from "./password.js";

export const RTSP_DIGEST_REALM = "RTSP Proxy";

function computeRtspDigestHa1Hex(input: {
  username: string;
  password: string;
  realm?: string;
}): string {
  const realm = input.realm ?? RTSP_DIGEST_REALM;
  return createHash("md5")
    .update(`${input.username}:${realm}:${input.password}`)
    .digest("hex");
}

export const DashboardUserSchema = z.object({
  username: z.string().min(1),
  role: z.enum(["admin", "user"]).default("user"),
  passwordSalt: z.string().min(1),
  passwordHash: z.string().min(1),
  // Precomputed digest HA1 for RTSP proxy Digest authentication.
  // HA1 = MD5(username:realm:password)
  rtspDigestHa1: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

export type DashboardUser = z.infer<typeof DashboardUserSchema>;

export const AuthTokenSchema = z.object({
  id: z.string(),
  tokenHashHex: z.string().min(1),
  // Token type:
  // - session: created by web login, can have multiple
  // - personal: long-lived personal token (unique per user)
  type: z.enum(["session", "personal"]).optional().default("session"),
  user: z.object({
    username: z.string().min(1),
    kind: z.enum(["env-admin", "settings", "trusted-proxy"]),
    role: z.enum(["admin", "user"]),
  }),
  createdAt: z.number(),
});

export type AuthToken = z.infer<typeof AuthTokenSchema>;

export const PersonalTokenSchema = z.object({
  id: z.string(),
  user: z.object({
    username: z.string().min(1),
    kind: z.enum(["env-admin", "settings", "trusted-proxy"]),
  }),
  // Stored in cleartext so the UI can show it after a reload.
  // Treat settings.json as sensitive.
  token: z.string().min(1),
  createdAt: z.number(),
});

export type PersonalToken = z.infer<typeof PersonalTokenSchema>;

// Unified Settings schema (includes cameras and rtspServers)
export const SettingsSchema = z.object({
  // Service IP (hostname to show in RTSP URLs - Port and RTSP Port are controlled by env vars)
  serviceIp: z.string().default("localhost"), // IP/hostname to show in RTSP URLs

  // HTTP Port exposed on the host (used to build public MJPEG/WebRTC/HLS URLs).
  // Useful with Docker port mappings (e.g. container 3000 -> host 3412).
  hostPort: z.number().int().min(1).max(65535).optional(),

  // Logging
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  logRetentionDays: z.number().default(14),

  // RTSP Proxy (single entry point for all streams - port controlled by RTSP_PORT env var)
  rtspProxyEnabled: z.boolean().default(true),

  // RTSP Authentication
  rtspRequireAuth: z.boolean().default(false),

  // Cameras, NVRs, and RTSP servers
  cameras: z.array(CameraConfigSchema).default([]),
  nvrs: z.array(NvrConfigSchema).default([]),
  rtspServers: z.array(RtspServerConfigSchema).default([]),

  // Dashboard/web UI authentication users
  dashboardUsers: z.array(DashboardUserSchema).default([]),

  // Persistent auth tokens (hashed). Never expose these via API.
  authTokens: z.array(AuthTokenSchema).default([]),

  // Personal tokens stored in cleartext for UI display.
  // Never expose these via settings APIs.
  personalTokens: z.array(PersonalTokenSchema).default([]),

  // Auth (advanced)
  auth: z
    .object({
      trustedProxy: z
        .object({
          enabled: z.boolean().default(false),
          // Default to loopback only.
          allowedIps: z.array(z.string().min(1)).default(["127.0.0.1", "::1"]),
          usernameHeader: z.string().default("x-authentik-username"),
          groupsHeader: z.string().default("x-authentik-groups"),
          adminGroup: z.string().default("admin"),
        })
        .default({}),
    })
    .default({}),

  // WebRTC (advanced)
  webrtc: z
    .object({
      // Example: "10000-10100" (empty disables)
      icePortRange: z.string().default(""),
      // CSV list of IPs/hostnames to advertise in ICE candidates (empty disables)
      iceAdditionalHostAddresses: z.string().default(""),
    })
    .default({}),

  // MQTT (events publishing)
  mqtt: z
    .object({
      enabled: z.boolean().default(false),
      brokerUrl: z.string().default("mqtt://localhost:1883"),
      username: z.string().optional(),
      password: z.string().optional(),
      clientId: z.string().optional(),
      topicPrefix: z.string().default("nodelink-js"),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
      reconnectPeriod: z.number().default(5000),
    })
    .default({}),

  // Home Assistant MQTT discovery (device state forwarding)
  homeassistant: z
    .object({
      enabled: z.boolean().default(false),
      discoveryPrefix: z.string().default("homeassistant"),
      /** Poll interval in seconds for fetching camera API data */
      pollIntervalSeconds: z.number().min(10).max(3600).default(60),
      /** Topic prefix for device state (e.g. nodelink-js/camera/living_room/state) */
      stateTopicPrefix: z.string().default("nodelink-js"),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

const DATA_DIR = process.env.DATA_PATH || ".";
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

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

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

// Get current settings
export function getSettings(): Settings {
  return settings;
}

// ==================== RTSP Credentials ====================
// RTSP credentials are now the same as dashboardUsers.

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

// ==================== NVRs ====================

export function getNvrs(): NvrConfig[] {
  return settings.nvrs;
}

export function getNvr(id: string): NvrConfig | undefined {
  return settings.nvrs.find((n) => n.id === id);
}

export function addNvr(
  nvr: Omit<NvrConfig, "id"> & { id?: string },
): NvrConfig {
  const newNvr: NvrConfig = {
    ...nvr,
    id: nvr.id || randomUUID(),
  } as NvrConfig;
  settings.nvrs = [...settings.nvrs, newNvr];
  saveSettings(settings);
  return newNvr;
}

export function deleteNvr(id: string): boolean {
  const index = settings.nvrs.findIndex((n) => n.id === id);
  if (index === -1) return false;

  settings.nvrs = [
    ...settings.nvrs.slice(0, index),
    ...settings.nvrs.slice(index + 1),
  ];
  // Also remove cameras that belong to this NVR
  const cameraIds = settings.cameras
    .filter((c) => c.nvrId === id)
    .map((c) => c.id);
  settings.cameras = settings.cameras.filter((c) => c.nvrId !== id);
  // Remove associated RTSP servers
  settings.rtspServers = settings.rtspServers.filter(
    (s) => !cameraIds.includes(s.cameraId),
  );
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

// ==================== Dashboard Users ====================

export function listDashboardUsers(): Array<
  Pick<DashboardUser, "username" | "role" | "createdAt" | "updatedAt">
> {
  return settings.dashboardUsers.map(
    ({ username, role, createdAt, updatedAt }) => ({
      username,
      role,
      createdAt,
      updatedAt,
    }),
  );
}

export function addDashboardUser(input: {
  username: string;
  password: string;
  role?: "admin" | "user";
}): Pick<DashboardUser, "username" | "role" | "createdAt" | "updatedAt"> {
  const username = input.username.trim();
  if (!username) throw new Error("Username is required");
  if (!input.password) throw new Error("Password is required");
  if (settings.dashboardUsers.some((u) => u.username === username)) {
    throw new Error("User already exists");
  }

  const now = Date.now();
  const { saltBase64, hashBase64 } = hashPassword(input.password);
  const user: DashboardUser = {
    username,
    role: input.role ?? "user",
    passwordSalt: saltBase64,
    passwordHash: hashBase64,
    rtspDigestHa1: computeRtspDigestHa1Hex({
      username,
      password: input.password,
    }),
    createdAt: now,
    updatedAt: now,
  };

  settings.dashboardUsers = [...settings.dashboardUsers, user];
  saveSettings(settings);
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function deleteDashboardUser(username: string): boolean {
  const idx = settings.dashboardUsers.findIndex((u) => u.username === username);
  if (idx === -1) return false;
  settings.dashboardUsers = [
    ...settings.dashboardUsers.slice(0, idx),
    ...settings.dashboardUsers.slice(idx + 1),
  ];
  saveSettings(settings);
  return true;
}

export function setDashboardUserPassword(input: {
  username: string;
  password: string;
}): boolean {
  const idx = settings.dashboardUsers.findIndex(
    (u) => u.username === input.username,
  );
  if (idx === -1) return false;
  const now = Date.now();
  const { saltBase64, hashBase64 } = hashPassword(input.password);
  const current = settings.dashboardUsers[idx]!;
  settings.dashboardUsers = [
    ...settings.dashboardUsers.slice(0, idx),
    {
      ...current,
      passwordSalt: saltBase64,
      passwordHash: hashBase64,
      rtspDigestHa1: computeRtspDigestHa1Hex({
        username: input.username,
        password: input.password,
      }),
      updatedAt: now,
    },
    ...settings.dashboardUsers.slice(idx + 1),
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
  nvrs: NvrConfig[];
  rtspServers: RtspServerConfig[];
} {
  return {
    cameras: settings.cameras,
    nvrs: settings.nvrs,
    rtspServers: settings.rtspServers,
  };
}

// Initialize settings on module load
loadSettings();
