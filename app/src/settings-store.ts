import { z } from "zod";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CameraConfigSchema,
  NvrConfigSchema,
  RtspServerConfigSchema,
  type CameraConfig,
  type NvrConfig,
  type RtspServerConfig,
} from "./types.js";
import { hashPassword } from "./password.js";
import { migrateLegacyBatteryCamera } from "./camera-traits.js";
import { atomicWriteFileSync, readWithBackupFallback } from "./atomic-write.js";
import { invalidateAvailableProfiles } from "./available-profiles-cache.js";

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

  // RTSP Authentication
  rtspRequireAuth: z.boolean().default(false),

  /**
   * Ms with zero clients on the RTSP proxy before stopping a running per-path backend.
   * 0 = never stop automatically (keeps the Baichuan source mounted for reconnects).
   * Set e.g. 30000 to restore previous “idle teardown” behaviour and save bandwidth.
   */
  rtspProxyBackendIdleTimeoutMs: z.number().int().min(0).default(0),

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

  /**
   * Local RTSP server options. The manager always uses the library's
   * BaichuanRtspServer behind a LocalRtspMux — one port serves every
   * camera (video paths `/<cameraName>/<profile>`, backchannel
   * `/<cameraName>`). go2rtc has been removed from the manager.
   */
  localRtsp: z
    .object({
      /** RTSP port for the local BaichuanRtspServer (default 8554). */
      port: z.number().int().min(1).max(65535).default(8554),
      /** Bind host for the local RTSP server. Default: 0.0.0.0 (all). */
      bindHost: z.string().default("0.0.0.0"),
      /** Require HTTP Basic/Digest auth on RTSP clients. Default: mirrors rtspRequireAuth. */
      requireAuth: z.boolean().optional(),
      /**
       * How long a DESCRIBE waits for the camera to deliver what the SDP
       * needs before answering anyway.
       *
       * Video = SPS/PPS (H.264) or VPS/SPS/PPS (H.265); without them the SDP
       * has no `sprop-parameter-sets` and ffmpeg/Frigate may hang on first
       * load. Audio = first AAC frame, so the track is advertised on the
       * first DESCRIBE rather than the second.
       *
       * Battery cameras on BCUDP must wake up first and routinely exceed the
       * defaults — raise the `udp` values for them. `0` = answer immediately.
       */
      priming: z
        .object({
          videoTcpMs: z.number().int().min(0).max(60_000).default(3000),
          videoUdpMs: z.number().int().min(0).max(60_000).default(4000),
          audioTcpMs: z.number().int().min(0).max(60_000).default(2000),
          audioUdpMs: z.number().int().min(0).max(60_000).default(3000),
        })
        .default({}),
    })
    .default({}),

  // RTSP backchannel (Frigate 2-way audio) is always-on and rides the same
  // LocalRtspMux that serves video. Each camera is reachable at
  // `/<sanitizedCameraName>` on `settings.localRtsp.port`. There used to be
  // a `talk.enabled` toggle here — see migration `drop-talk-enabled-v1`.

  // Frigate integration (config management)
  frigate: z
    .object({
      /** Frigate server URL (e.g. http://192.168.1.100:5000). */
      host: z.string().default(""),
      /** Frigate username (optional, for authenticated instances). */
      username: z.string().default(""),
      /** Frigate password (optional). */
      password: z.string().default(""),
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

  /**
   * Email push: receive SMTP-delivered motion notifications from battery cameras
   * (Argus, Go, etc.) that don't reliably emit TCP/ONVIF push when sleeping.
   *
   * The manager runs an SMTP server. Each camera gets a unique recipient
   * `cam-<id>@<domain>`; when a mail arrives we parse it and emit a motion
   * event via the events-manager (same path as native motion).
   */
  emailPush: z
    .object({
      // Default `true` so fresh installs spin up the SMTP intake immediately
      // (battery-cam owners get email-delivered motion out of the box). Users
      // who don't want it can flip the user-facing toggle off from
      // Settings → Email Push; that change is honoured by the boot path.
      //
      // NOTE: the legacy `featureEnabled` master kill-switch has been removed
      // from the schema. The `email-push-drop-featureEnabled-v1` migration
      // strips it from existing settings.json files on first load; Zod
      // silently drops unknown keys at parse time so the field is gone
      // after the first save regardless.
      enabled: z.boolean().default(true),
      /** SMTP listen port. Default 2525 (avoid privileged 25). */
      port: z.number().int().min(1).max(65535).default(2525),
      /** Bind host (0.0.0.0 to accept on LAN). */
      bindHost: z.string().default("0.0.0.0"),
      /** Virtual mail domain used for per-camera recipients. */
      domain: z.string().default("nodelink.local"),
      /**
       * If true, the SMTP server requires AUTH PLAIN/LOGIN with the credentials below.
       * Camera firmwares all support SMTP auth. Default is `true` because
       * Reolink firmwares are noticeably more reliable when AUTH PLAIN is
       * negotiated on the SMTP session, and leaving the port reachable
       * without auth invites anyone on the LAN to forge motion events.
       */
      requireAuth: z.boolean().default(true),
      authUsername: z.string().default(""),
      authPassword: z.string().default(""),
      /**
       * Enable STARTTLS. The camera will negotiate TLS after EHLO.
       * Self-signed cert is auto-generated and stored under DATA_PATH/email-push-tls/.
       */
      tls: z.boolean().default(false),
      /** Maximum accepted message size in bytes (default 25 MB). */
      maxMessageBytes: z.number().int().min(1024).default(25 * 1024 * 1024),
      /**
       * Auto-reset delay for the synthetic motion event in ms. After this
       * window with no more emails, the motion state goes back to clear.
       */
      motionResetMs: z.number().int().min(500).default(15_000),
    })
    .default({}),

  /**
   * Internal: list of one-shot migration IDs that have already been applied
   * to this settings file. Read and updated by `loadSettings()` only — never
   * exposed in the UI. New IDs added here when we ship a migration so it
   * runs at most once per install.
   */
  _migrationsApplied: z.array(z.string()).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;

const DATA_DIR = process.env.DATA_PATH || ".";
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

let settings: Settings = SettingsSchema.parse({});

// Load settings from file. If the primary file is missing, empty, or corrupt
// (e.g. truncated to 0 bytes by a crash mid-write — see issue #17), fall back
// to the .bak sibling written by the previous successful save before giving up
// and using defaults.
export function loadSettings(): Settings {
  const data = readWithBackupFallback(SETTINGS_FILE);
  if (data === null) {
    return settings;
  }
  try {
    settings = SettingsSchema.parse(JSON.parse(data));
  } catch (error) {
    console.error("Failed to load settings, using defaults:", error);
    settings = SettingsSchema.parse({});
  }

  // One-shot migration for the legacy `isBattery` field. For
  // standalone cameras the flag is replaced by `transport: "udp"`
  // (single source of truth, see `./camera-traits.ts`). NVR children
  // keep the flag because they share the parent Hub's TCP socket and
  // the field is the only per-child battery signal we have. Settings
  // written by older versions are migrated in place and rewritten on
  // first run so the file converges to the new shape.
  let migrated = 0;
  for (const cam of settings.cameras) {
    if (migrateLegacyBatteryCamera(cam)) migrated++;
    // Strip the legacy field on standalone cameras only; NVR children
    // keep it.
    if (!cam.nvrId && "isBattery" in cam) {
      delete (cam as { isBattery?: boolean }).isBattery;
    }
  }
  if (migrated > 0) {
    console.log(
      `[settings] Migrated ${migrated} legacy standalone battery camera(s) to transport=udp; rewriting settings.json`,
    );
    saveSettings({ cameras: settings.cameras });
  }

  // Generic one-shot migration runner. Each step is an idempotent
  // mutation of the live settings tagged with a stable ID. Once applied
  // the ID is appended to `_migrationsApplied` and never replays. Steps
  // are kept small and atomic so we can stack them safely across releases.
  type SettingsMigration = {
    id: string;
    apply: (s: Settings) => Partial<Settings> | null;
  };
  const migrations: SettingsMigration[] = [
    {
      // Forces requireAuth=true and bootstraps random AUTH credentials when
      // the install was previously running without them. Pre-existing
      // user-set creds are preserved verbatim.
      id: "email-push-auth-defaults-v1",
      apply: (s) => {
        const ep = s.emailPush;
        const next = {
          ...ep,
          requireAuth: true,
          authUsername:
            ep.authUsername || `nodelink-${randomBytes(4).toString("hex")}`,
          authPassword:
            ep.authPassword || randomBytes(18).toString("base64url"),
        };
        return { emailPush: next };
      },
    },
    {
      // Turn the SMTP intake on by default so battery-cam owners get
      // email-delivered motion without having to hunt for a toggle. Users
      // who don't want it can flip it back off in the UI; once flipped
      // back this migration does NOT re-enable it (marker is permanent).
      id: "email-push-enabled-default-v1",
      apply: (s) =>
        s.emailPush.enabled
          ? null
          : { emailPush: { ...s.emailPush, enabled: true } },
    },
    {
      // featureEnabled was a master kill-switch from the experimental
      // phase. The schema no longer declares it and the boot path no
      // longer checks it — but legacy settings.json files still carry
      // the field, which now silently confuses readers. The migration
      // is a marker-only no-op: the runner records the marker via
      // saveSettings(), which re-parses through SettingsSchema and
      // drops the unknown key on the rewrite.
      id: "email-push-drop-featureEnabled-v1",
      apply: () => null,
    },
    {
      // The bundled go2rtc sidecar was removed: settings.restreamer,
      // settings.go2rtc.* and settings.webrtc.preferredBackend no longer
      // exist in the schema and Zod silently drops them at parse time.
      // This marker forces saveSettings() to rewrite the file once so the
      // legacy keys are gone from disk too — keeps backups and downgrade
      // diffs clean.
      id: "drop-go2rtc-v1",
      apply: () => null,
    },
    {
      // talk.enabled / talk.port / talk.bindHost are gone — the backchannel
      // is always on and shares the LocalRtspMux port. Marker-only: Zod
      // already strips the unknown keys on parse, the migration just forces
      // a rewrite so legacy installs no longer carry a stale `talk` block.
      id: "drop-talk-enabled-v1",
      apply: () => null,
    },
  ];

  for (const m of migrations) {
    if (settings._migrationsApplied.includes(m.id)) continue;
    const patch = m.apply(settings);
    if (patch === null) {
      console.log(
        `[settings] Migration ${m.id}: no-op for this install; recording marker`,
      );
      saveSettings({
        _migrationsApplied: [...settings._migrationsApplied, m.id],
      });
      continue;
    }
    console.log(`[settings] Applying migration ${m.id}`);
    saveSettings({
      ...patch,
      _migrationsApplied: [...settings._migrationsApplied, m.id],
    });
  }

  return settings;
}

// Save settings to file atomically (tmp + fsync + rename) so a crash between
// O_TRUNC and write() can never leave settings.json at 0 bytes. Keeps a .bak
// of the previous version for one-step recovery if the rename ever races on
// something exotic.
export function saveSettings(newSettings: Partial<Settings>): Settings {
  settings = SettingsSchema.parse({ ...settings, ...newSettings });

  atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), {
    keepBackup: true,
  });
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

  // Reconfiguring a camera can change which stream profiles it exposes, so the
  // cached answer must go — the ttl alone would leave it stale for far too long.
  invalidateAvailableProfiles(id);

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

/**
 * Apply a user-defined ordering to cameras and/or NVRs. `orderedCameraIds` /
 * `orderedNvrIds` are the new ordering; items not present in those lists
 * keep their existing relative order at the tail. Sets the `position`
 * field on each item to its index in the new ordering — that's what the
 * grid's "Custom" sort mode reads.
 */
export function reorderDevices(input: {
  orderedCameraIds?: string[];
  orderedNvrIds?: string[];
}): void {
  let touched = false;

  if (input.orderedCameraIds) {
    const wantedOrder = new Map<string, number>(
      input.orderedCameraIds.map((id, idx) => [id, idx] as const),
    );
    const nextPosFor = (id: string, fallback: number): number => {
      const w = wantedOrder.get(id);
      return w !== undefined ? w : input.orderedCameraIds!.length + fallback;
    };
    settings.cameras = settings.cameras.map((c, idx) => ({
      ...c,
      position: nextPosFor(c.id, idx),
    }));
    touched = true;
  }

  if (input.orderedNvrIds) {
    const wantedOrder = new Map<string, number>(
      input.orderedNvrIds.map((id, idx) => [id, idx] as const),
    );
    settings.nvrs = settings.nvrs.map((n, idx) => ({
      ...n,
      position:
        wantedOrder.get(n.id) ?? input.orderedNvrIds!.length + idx,
    }));
    touched = true;
  }

  if (touched) saveSettings(settings);
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
