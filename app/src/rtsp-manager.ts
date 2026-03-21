import {
  ReolinkBaichuanApi,
  BaichuanRtspServer,
} from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import {
  getConfig,
  getSettings,
  getNvr,
  upsertCameraStream,
} from "./settings-store.js";
import { getGo2rtcManager } from "./go2rtc-manager.js";
import * as net from "net";
import * as crypto from "crypto";
import { releaseStreamsByCamera } from "./stream-pool.js";

// Helper: sanitize camera name for URL path (Camera Studio => camera_studio)
export function sanitizeCameraName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Helper: generate random token for RTSP path
export function generateStreamToken(): string {
  return crypto.randomBytes(8).toString("hex");
}

// Helper: build go2rtc-safe stream name (e.g. "camera_studio/main")
export function buildGo2rtcStreamName(
  cameraName: string,
  profile: string,
  channel: number,
): string {
  const base = sanitizeCameraName(cameraName);
  return channel > 0 ? `${base}/${profile}/${channel}` : `${base}/${profile}`;
}

// Helper: generate RTSP server key for multi-stream support
export function getRtspServerKey(
  cameraId: string,
  profile: "main" | "sub" | "ext",
  channel: number,
): string {
  return `${cameraId}:${profile}:${channel}`;
}

// Helper: check if a port is available
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "0.0.0.0");
  });
}

// Ports claimed by streams being started (prevents race conditions)
const claimedPorts = new Set<number>();

// Helper: find next available port starting from base
export async function findNextAvailablePort(
  basePort: number,
  maxAttempts: number = 100,
): Promise<number> {
  // Collect all ports in use: running servers + ports being started
  const usedPorts = new Set<number>(claimedPorts);
  for (const [, entry] of rtspServers) {
    if (entry.info.port) {
      usedPorts.add(entry.info.port);
    }
  }

  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + i;
    if (usedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      // Claim immediately to prevent concurrent callers from taking the same port
      claimedPorts.add(port);
      return port;
    }
  }
  throw new Error(
    `No available port found in range ${basePort}-${basePort + maxAttempts}`,
  );
}

// Get suggested port for a new stream
export async function getSuggestedPort(): Promise<number> {
  const basePort = Number(process.env.RTSP_PORT) || 8554;
  return findNextAvailablePort(basePort);
}

export interface RtspServerInfo {
  cameraId: string;
  cameraName: string;
  status: "running" | "stopped" | "starting" | "error";
  rtspUrl?: string;
  port: number;
  profile: "main" | "sub" | "ext";
  channel: number;
  startedAt?: Date;
  error?: string;
  connections: number;
  /** Unique key for this stream (cameraId:profile:channel) */
  streamKey: string;
  /** RTSP path (e.g., /token123) */
  path?: string;
  /** When using go2rtc: the stream name registered in go2rtc. */
  go2rtcStreamName?: string;
  /** When using go2rtc: the tcp:// source URL. */
  go2rtcSourceUrl?: string;
  /** Server mode: "rtsp" (BaichuanRtspServer) or "go2rtc" (BaichuanRtspServer). */
  mode?: "rtsp" | "go2rtc";
}

export interface CameraInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  status: "connected" | "disconnected" | "error";
  deviceInfo?: {
    model?: string;
    firmwareVersion?: string;
    serialNumber?: string;
    channelCount?: number;
    /** For NVR/Hub: the name of the camera on the specific channel */
    channelName?: string;
    /** Whether this device is an NVR/Hub with multiple channels */
    isNvr?: boolean;
    /** Whether this device is multifocal/dual-lens (TrackMix, Duo) */
    isMultifocal?: boolean;
    /** For NVR/Hub: the model of the Hub itself */
    hubModel?: string;
  };
  lastConnected?: Date;
  error?: string;
}

// Store for API connections with connection state
interface ManagedConnection {
  api: ReolinkBaichuanApi;
  cameraId: string;
  /** Timestamp of last successful connection */
  connectionTime: number;
  /** Timestamp of last disconnect (for backoff) */
  lastDisconnectTime: number;
  /** Ping keepalive interval */
  pingInterval?: NodeJS.Timeout;
  /** Consecutive ping failures */
  consecutivePingFailures: number;
  /** Whether cleanup is in progress (prevent re-entrant cleanup) */
  cleanupInProgress: boolean;
  /** In-flight connect promise (prevent concurrent login storms) */
  connectPromise?: Promise<ReolinkBaichuanApi>;
}

const apiConnections = new Map<string, ManagedConnection>();

/** Minimum ms between reconnection attempts */
const RECONNECT_BACKOFF_MS = 2000;

/** Ping interval ms */
const PING_INTERVAL_MS = 30_000;

/** Max consecutive ping failures before forcing reconnect */
const MAX_PING_FAILURES = 3;

// --- NVR shared connection helpers ---

/** Get the connection map key for a camera (shared by NVR siblings) */
function getConnectionKey(cameraId: string): string {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (camera?.nvrId) return `nvr:${camera.nvrId}`;
  return cameraId;
}

/** Get all camera IDs belonging to an NVR */
function getNvrChildCameraIds(nvrId: string): string[] {
  const config = getConfig();
  return config.cameras.filter((c) => c.nvrId === nvrId).map((c) => c.id);
}

/** Get all camera IDs affected by a connection key */
function getAffectedCameraIds(connKey: string): string[] {
  if (connKey.startsWith("nvr:")) {
    return getNvrChildCameraIds(connKey.slice(4));
  }
  return [connKey];
}

// Listeners notified when a new API connection is established (for events, etc.)
const apiConnectionListeners: Array<
  (cameraId: string, api: ReolinkBaichuanApi) => void
> = [];

/**
 * Register a callback to be notified when a camera API connection is established.
 * The callback is also invoked immediately for all existing connections.
 */
export function onApiConnected(
  callback: (cameraId: string, api: ReolinkBaichuanApi) => void,
): void {
  apiConnectionListeners.push(callback);
  for (const [cameraId, conn] of apiConnections) {
    if (conn.api.isReady) {
      callback(cameraId, conn.api);
    }
  }
}

/** Callback invoked when a camera API connection is closed */
const apiDisconnectionListeners: Array<(cameraId: string) => void> = [];

export function onApiDisconnected(
  callback: (cameraId: string) => void,
): void {
  apiDisconnectionListeners.push(callback);
}

// Store for RTSP servers
const rtspServers = new Map<
  string,
  {
    server: BaichuanRtspServer;
    info: RtspServerInfo;
    /** go2rtc stream name (set when using BaichuanRtspServer). */
    go2rtcStreamName?: string;
  }
>();

// Store for camera info cache
const cameraInfoCache = new Map<string, CameraInfo>();

// NVR per-camera disabled set: cameras in this set are "disconnected" from restreaming
// but the NVR shared socket stays alive. When a user "connects" an NVR child,
// it's removed from this set and becomes visible for restreaming.
const disabledNvrCameras = new Set<string>();

/**
 * Cleanup a managed connection: remove listeners, stop ping, close API.
 * Safe to call multiple times (idempotent via cleanupInProgress guard).
 */
async function cleanupManagedConnection(
  cameraId: string,
  conn: ManagedConnection,
): Promise<void> {
  if (conn.cleanupInProgress) return;
  conn.cleanupInProgress = true;

  const cameraLogger = createSourceLogger(`camera:${cameraId}`);

  try {
    // Stop ping interval
    if (conn.pingInterval) {
      clearInterval(conn.pingInterval);
      conn.pingInterval = undefined;
    }

    // Remove listeners to prevent re-entrant close handling
    try {
      conn.api.client.removeAllListeners("error");
      conn.api.client.removeAllListeners("close");
    } catch {
      // ignore — client may already be destroyed
    }

    // Close the API connection
    try {
      await conn.api.close();
    } catch {
      // ignore
    }

    cameraLogger.info("Connection cleaned up");
  } finally {
    conn.cleanupInProgress = false;
  }
}

/**
 * Notify disconnection listeners and update cache status.
 */
function notifyDisconnection(connKey: string): void {
  const affectedIds = getAffectedCameraIds(connKey);

  for (const camId of affectedIds) {
    releaseStreamsByCamera(camId);

    for (const cb of apiDisconnectionListeners) {
      try {
        cb(camId);
      } catch (e) {
        createSourceLogger("rtsp-manager").error(
          `apiDisconnectionListener error: ${e}`,
        );
      }
    }

    const info = cameraInfoCache.get(camId);
    if (info) {
      info.status = "disconnected";
    }
  }
}

/**
 * Attach error/close listeners to a managed connection.
 * On close: cleanup, remove from map, notify listeners.
 */
function attachConnectionListeners(
  cameraId: string,
  conn: ManagedConnection,
): void {
  const cameraLogger = createSourceLogger(`camera:${cameraId}`);

  conn.api.client.on("error", (err: unknown) => {
    const msg =
      (err as any)?.message || (err as any)?.toString?.() || String(err);
    if (
      typeof msg === "string" &&
      (msg.includes("Baichuan socket closed") ||
        msg.includes("Baichuan UDP stream closed") ||
        msg.includes("Not running"))
    ) {
      cameraLogger.debug(`Connection error (recoverable): ${msg}`);
      return;
    }
    cameraLogger.error(`Connection error: ${msg}`);
  });

  conn.api.client.on("close", async () => {
    // Only handle if this is still the current connection for this camera
    const current = apiConnections.get(cameraId);
    if (!current || current !== conn || conn.cleanupInProgress) {
      cameraLogger.debug("Close event for stale connection, ignoring");
      return;
    }

    conn.lastDisconnectTime = Date.now();
    cameraLogger.warn("Socket closed, cleaning up for reconnection on next use");

    // Remove from map FIRST to prevent getOrCreateApiConnection from returning dead conn
    apiConnections.delete(cameraId);

    await cleanupManagedConnection(cameraId, conn);
    notifyDisconnection(cameraId);
  });
}

/**
 * Start ping keepalive for a managed connection.
 */
function startPingKeepalive(cameraId: string, conn: ManagedConnection): void {
  const cameraLogger = createSourceLogger(`camera:${cameraId}`);

  if (conn.pingInterval) {
    clearInterval(conn.pingInterval);
  }

  conn.consecutivePingFailures = 0;

  conn.pingInterval = setInterval(async () => {
    // Stop if connection has changed
    const current = apiConnections.get(cameraId);
    if (!current || current !== conn) {
      clearInterval(conn.pingInterval);
      conn.pingInterval = undefined;
      return;
    }

    try {
      await conn.api.ping();
      conn.consecutivePingFailures = 0;
    } catch (e) {
      conn.consecutivePingFailures++;
      cameraLogger.debug(
        `Ping failed (${conn.consecutivePingFailures}/${MAX_PING_FAILURES}): ${(e as any)?.message || e}`,
      );

      if (conn.consecutivePingFailures >= MAX_PING_FAILURES) {
        cameraLogger.warn(
          `${MAX_PING_FAILURES} consecutive ping failures, forcing reconnection`,
        );

        // Remove from map and cleanup — next call will reconnect
        apiConnections.delete(cameraId);
        await cleanupManagedConnection(cameraId, conn);
        notifyDisconnection(cameraId);
      }
    }
  }, PING_INTERVAL_MS);
}

/**
 * Get or create a robust API connection for a camera.
 *
 * Aligned with scrypted-reolink-native plugin's ensureBaichuanClient():
 * - Checks isReady/isClosed before reusing connections
 * - Calls setIsNvr()/setIsMultiFocal() after login for correct socket pooling
 * - Attaches error/close listeners for automatic cleanup
 * - Serializes concurrent login attempts (prevents login storms)
 * - Reconnection backoff after disconnections
 * - Ping keepalive to detect stale connections
 */
export async function getOrCreateApiConnection(
  cameraId: string,
): Promise<ReolinkBaichuanApi> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) {
    throw new Error(`Camera not found: ${cameraId}`);
  }

  // For NVR children, use a shared connection keyed by nvrId
  const connKey = getConnectionKey(cameraId);
  const existing = apiConnections.get(connKey);

  if (existing) {
    // Prevent concurrent login storms — wait on in-flight connect
    if (existing.connectPromise) {
      return existing.connectPromise;
    }

    // Already connected and ready → reuse
    if (existing.api.isReady) {
      return existing.api;
    }

    // API was explicitly closed → cleanup and recreate
    if (existing.api.isClosed) {
      const cameraLogger = createSourceLogger(`camera:${connKey}`);
      cameraLogger.info("API is closed, recreating connection");
      apiConnections.delete(connKey);
      await cleanupManagedConnection(connKey, existing);
      notifyDisconnection(connKey);
    } else {
      // Socket disconnected but API still valid → try library-side reconnect
      const cameraLogger = createSourceLogger(`camera:${connKey}`);
      try {
        cameraLogger.info("Socket lost, attempting ensureConnected()");
        await existing.api.ensureConnected();
        return existing.api;
      } catch (e) {
        cameraLogger.warn(
          `ensureConnected failed: ${(e as any)?.message || e}, recreating connection`,
        );
        apiConnections.delete(connKey);
        await cleanupManagedConnection(connKey, existing);
        notifyDisconnection(connKey);
      }
    }
  }

  // Resolve credentials: NVR children use NVR credentials
  let host: string, port: number, username: string, password: string;
  let logLabel: string;

  if (camera.nvrId) {
    const nvr = getNvr(camera.nvrId);
    if (!nvr) throw new Error(`NVR not found: ${camera.nvrId}`);
    ({ host, port, username, password } = nvr);
    logLabel = `nvr:${nvr.name}`;
  } else {
    ({ host, port, username, password } = camera);
    logLabel = camera.name;
  }

  const cameraLogger = createSourceLogger(`camera:${logLabel}`);
  const isNvrConnection = !!camera.nvrId;

  // Create a managed connection entry with the connect promise to serialize access
  const conn: ManagedConnection = {
    api: null!,
    cameraId: connKey,
    connectionTime: 0,
    lastDisconnectTime: existing?.lastDisconnectTime ?? 0,
    consecutivePingFailures: 0,
    cleanupInProgress: false,
  };

  // The connect promise serializes concurrent callers
  conn.connectPromise = (async () => {
    // Apply backoff to avoid aggressive reconnection after disconnection
    if (conn.lastDisconnectTime > 0) {
      const timeSinceDisconnect = Date.now() - conn.lastDisconnectTime;
      if (timeSinceDisconnect < RECONNECT_BACKOFF_MS) {
        const waitTime = RECONNECT_BACKOFF_MS - timeSinceDisconnect;
        cameraLogger.info(`Waiting ${waitTime}ms before reconnection (backoff)`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    const debugOptions = camera.debugLogs
      ? {
          general: true,
          debugRtsp: true,
          traceNativeStream: true,
          traceTalk: true,
        }
      : undefined;

    const api = new ReolinkBaichuanApi({
      host,
      port,
      username,
      password,
      debugOptions,
      logger: {
        log: (msg: unknown) => cameraLogger.info(String(msg)),
        info: (msg: string) => cameraLogger.info(msg),
        warn: (msg: string) => cameraLogger.warn(msg),
        error: (msg: string) => cameraLogger.error(msg),
        debug: (msg: string) => cameraLogger.debug(msg),
      },
    });

    cameraLogger.info(`Connecting to ${host}:${port}`);
    await api.login();
    cameraLogger.info("Connected successfully");

    // Detect device type and set flags BEFORE any streaming (critical for socket pooling)
    const channelCount = await api.getChannelCount();
    const info = await api.getInfo();
    const modelLower = (info?.type ?? "").toLowerCase();
    const isNvr =
      isNvrConnection ||
      channelCount > 1 ||
      modelLower.includes("hub") ||
      modelLower.includes("nvr") ||
      modelLower.includes("home hub");

    api.setIsNvr(isNvr);
    cameraLogger.info(`setIsNvr(${isNvr}) — model=${info?.type}, channels=${channelCount}`);

    // Detect multifocal/dual-lens (TrackMix, Duo)
    const channel = camera.rtspChannel ?? 0;
    let isMultifocal = false;
    if (!isNvrConnection) {
      try {
        const dualLensAnalysis = await api.getDualLensChannelInfo(
          isNvr ? channel : 0,
          { onNvr: isNvr },
        );
        isMultifocal = dualLensAnalysis.isDualLens;
      } catch {
        // Not multifocal
      }
    }

    api.setIsMultiFocal(isMultifocal);
    if (isMultifocal) {
      cameraLogger.info("setIsMultiFocal(true) — dual-lens device detected");
    }

    // Verify socket is connected
    if (!api.client.isSocketConnected()) {
      throw new Error("Socket not connected after login");
    }

    // Finalize the managed connection
    conn.api = api;
    conn.connectionTime = Date.now();
    conn.connectPromise = undefined;

    // Attach error/close listeners for auto-cleanup (keyed by connKey)
    attachConnectionListeners(connKey, conn);

    // Start ping keepalive
    startPingKeepalive(connKey, conn);

    // Store in map
    apiConnections.set(connKey, conn);

    // Notify listeners for all affected cameras
    const affectedIds = getAffectedCameraIds(connKey);
    for (const camId of affectedIds) {
      for (const cb of apiConnectionListeners) {
        try {
          cb(camId, api);
        } catch (e) {
          createSourceLogger("rtsp-manager").error(
            `apiConnectionListener error: ${e}`,
          );
        }
      }
    }

    // Update camera info cache for all affected cameras
    await updateCameraInfo(connKey, api);

    // For NVR connections: only the requesting camera is enabled,
    // all siblings start disabled (user must explicitly connect each one)
    if (connKey.startsWith("nvr:")) {
      const nvrId = connKey.slice(4);
      const siblings = getNvrChildCameraIds(nvrId);
      for (const sibId of siblings) {
        if (sibId !== cameraId) {
          disabledNvrCameras.add(sibId);
        }
      }
      // Ensure the requesting camera is NOT disabled
      disabledNvrCameras.delete(cameraId);
    }

    return api;
  })();

  // Store immediately so concurrent callers find the connectPromise
  apiConnections.set(connKey, conn);

  try {
    return await conn.connectPromise;
  } catch (error) {
    // Connection failed — clean up and apply backoff timestamp
    conn.lastDisconnectTime = Date.now();
    conn.connectPromise = undefined;
    apiConnections.delete(connKey);
    cameraLogger.error(`Failed to connect: ${error}`);
    throw error;
  }
}

// Update a single camera's info cache entry
async function updateSingleCameraInfo(
  camera: { id: string; name: string; host: string; port: number; rtspChannel?: number; isBattery?: boolean },
  api: ReolinkBaichuanApi,
  sharedInfo?: { type?: string; firmwareVersion?: string; serialNumber?: string },
  sharedChannelCount?: number,
  sharedIsNvr?: boolean,
) {
  try {
    const info = sharedInfo ?? (await api.getInfo());
    const channelCount = sharedChannelCount ?? (await api.getChannelCount());
    const channel = camera.rtspChannel ?? 0;

    const modelLower = (info?.type ?? "").toLowerCase();
    const isNvr =
      sharedIsNvr ??
      (channelCount > 1 ||
        modelLower.includes("hub") ||
        modelLower.includes("nvr") ||
        modelLower.includes("home hub"));

    let isMultifocal = false;
    if (!camera.isBattery) {
      try {
        const dualLensAnalysis = await api.getDualLensChannelInfo(
          isNvr ? channel : 0,
          { onNvr: isNvr },
        );
        isMultifocal = dualLensAnalysis.isDualLens;
      } catch {
        // Not multifocal
      }
    }

    let channelName: string | undefined;
    let channelModel: string | undefined;
    if (!camera.isBattery && isNvr && channel >= 0) {
      try {
        const channelInfo = await api.getInfo(channel);
        if (channelInfo?.name) channelName = channelInfo.name;
        if (channelInfo?.type) channelModel = channelInfo.type;
      } catch {
        // ignore
      }
    }

    cameraInfoCache.set(camera.id, {
      id: camera.id,
      name: camera.name,
      host: camera.host,
      port: camera.port,
      status: "connected",
      deviceInfo: {
        model: channelModel || info?.type,
        firmwareVersion: info?.firmwareVersion,
        serialNumber: info?.serialNumber,
        channelCount,
        isNvr,
        isMultifocal,
        channelName,
        hubModel: isNvr ? info?.type : undefined,
      },
      lastConnected: new Date(),
    });
  } catch (error) {
    cameraInfoCache.set(camera.id, {
      id: camera.id,
      name: camera.name,
      host: camera.host,
      port: camera.port,
      status: "error",
      error: String(error),
    });
  }
}

// Update camera info cache (handles both standalone and NVR shared connections)
async function updateCameraInfo(connKey: string, api: ReolinkBaichuanApi) {
  const config = getConfig();

  if (connKey.startsWith("nvr:")) {
    // NVR shared connection: update all children
    const nvrId = connKey.slice(4);
    const children = config.cameras.filter((c) => c.nvrId === nvrId);

    // Fetch NVR-level info once
    const info = await api.getInfo();
    const channelCount = await api.getChannelCount();

    for (const camera of children) {
      await updateSingleCameraInfo(camera, api, info, channelCount, true);
    }
  } else {
    const camera = config.cameras.find((c) => c.id === connKey);
    if (camera) await updateSingleCameraInfo(camera, api);
  }
}

// Get camera info
export function getCameraInfo(cameraId: string): CameraInfo | undefined {
  return cameraInfoCache.get(cameraId);
}

// Get all cameras info
export function getAllCamerasInfo(): CameraInfo[] {
  const config = getConfig();
  return config.cameras.map((camera) => {
    const cached = cameraInfoCache.get(camera.id);

    // NVR children that are disabled show as disconnected even if the NVR socket is alive
    if (cached && disabledNvrCameras.has(camera.id)) {
      return { ...cached, status: "disconnected" as const };
    }

    if (cached) return cached;

    return {
      id: camera.id,
      name: camera.name,
      host: camera.host,
      port: camera.port,
      status: "disconnected" as const,
    };
  });
}

/**
 * Enable an NVR child camera for restreaming (without affecting the NVR socket).
 * If the NVR socket isn't alive yet, creates it (only this camera will be enabled).
 * Events stay subscribed for all NVR children regardless of enable/disable state.
 */
export async function enableNvrCamera(cameraId: string): Promise<void> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera?.nvrId) throw new Error(`Camera ${cameraId} is not an NVR child`);

  // Ensure the NVR socket is alive (getOrCreateApiConnection will disable siblings)
  const connKey = getConnectionKey(cameraId);
  const conn = apiConnections.get(connKey);
  if (!conn?.api?.isReady) {
    await getOrCreateApiConnection(cameraId);
    return;
  }

  // NVR socket already alive — just remove from disabled set
  disabledNvrCameras.delete(cameraId);

  // Update cache to connected (refresh device info)
  await updateSingleCameraInfo(camera, conn.api);

  // Start go2rtc streams for this camera (the onApiConnected listener won't
  // fire because the NVR socket was already connected — trigger manually).
  const settings = getSettings();
  const go2rtcMgr = getGo2rtcManager();
  if (settings.go2rtc?.enabled && go2rtcMgr?.isRunning) {
    const channel = camera.rtspChannel ?? 0;
    const profiles = await getAvailableProfiles(cameraId);
    for (const profile of profiles) {
      const sk = getRtspServerKey(cameraId, profile, channel);
      if (rtspServers.get(sk)?.info.status === "running") continue;
      startRtspServer(cameraId, { profile, channel }).catch(() => {});
    }
  }
}

/**
 * Disable an NVR child camera from restreaming (without closing the NVR socket).
 * Stops streams but keeps event subscriptions alive (for sleep/wake detection).
 */
export async function disableNvrCamera(cameraId: string): Promise<void> {
  disabledNvrCameras.add(cameraId);

  // Stop all streams for this camera
  await stopAllCameraStreams(cameraId);
  releaseStreamsByCamera(cameraId);
}

// Close API connection (handles NVR shared connections)
export async function closeApiConnection(cameraId: string) {
  const connKey = getConnectionKey(cameraId);
  const conn = apiConnections.get(connKey);
  if (conn) {
    apiConnections.delete(connKey);
    await cleanupManagedConnection(connKey, conn);
    notifyDisconnection(connKey);
  }
}

// Connect all cameras of an NVR via shared connection
export async function connectNvr(nvrId: string): Promise<void> {
  const childIds = getNvrChildCameraIds(nvrId);
  if (childIds.length === 0) return;
  // Connecting any child triggers the shared NVR connection
  await getOrCreateApiConnection(childIds[0]);
}

// Disconnect an NVR and all its child cameras
export async function disconnectNvr(nvrId: string): Promise<void> {
  const connKey = `nvr:${nvrId}`;
  // Stop all streams for child cameras first
  const childIds = getNvrChildCameraIds(nvrId);
  for (const camId of childIds) {
    disabledNvrCameras.delete(camId);
    await stopAllCameraStreams(camId);
  }
  const conn = apiConnections.get(connKey);
  if (conn) {
    apiConnections.delete(connKey);
    await cleanupManagedConnection(connKey, conn);
    notifyDisconnection(connKey);
  }
}

/**
 * Query the camera API for available stream profiles (main, sub, ext).
 * Returns only the profiles the camera actually supports.
 * Falls back to ["main", "sub"] if the camera is unreachable.
 */
async function getAvailableProfiles(
  cameraId: string,
): Promise<Array<"main" | "sub" | "ext">> {
  try {
    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);
    if (!camera) return ["main", "sub"];

    const api = await getOrCreateApiConnection(cameraId);
    const channel = camera.rtspChannel ?? 0;
    const isNvr = camera.isNvr || !!camera.nvrId;
    const opts = await api.buildVideoStreamOptions({ channel, onNvr: isNvr });
    const profiles = opts.nativeStreams
      .map((s: any) => s.profile as string)
      .filter((p: string): p is "main" | "sub" | "ext" =>
        p === "main" || p === "sub" || p === "ext",
      );
    return profiles.length > 0 ? [...new Set(profiles)] : ["main", "sub"];
  } catch {
    return ["main", "sub"];
  }
}

// Start RTSP server for a camera stream
export async function startRtspServer(
  cameraId: string,
  options?: {
    port?: number;
    profile?: "main" | "sub" | "ext";
    channel?: number;
  },
): Promise<RtspServerInfo> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) {
    throw new Error(`Camera not found: ${cameraId}`);
  }

  const profile = options?.profile || camera.rtspProfile || "main";
  const channel = options?.channel ?? camera.rtspChannel ?? 0;
  const streamKey = getRtspServerKey(cameraId, profile, channel);

  // Check if this specific stream is already running
  const existing = rtspServers.get(streamKey);
  if (existing && existing.info.status === "running") {
    return existing.info;
  }

  const logger = createSourceLogger(`rtsp:${camera.name}:${profile}`);
  const settings = getSettings();

  // Find saved stream config to get previously used port
  const savedStreamConfig = camera.rtspStreams?.find(
    (s) => s.profile === profile && s.channel === channel,
  );

  // Auto-select port: use specified port, saved port, or find next available
  let port: number;
  if (options?.port) {
    port = options.port;
  } else if (
    savedStreamConfig?.port &&
    (await isPortAvailable(savedStreamConfig.port))
  ) {
    // Use previously saved port if it's still available
    port = savedStreamConfig.port;
    logger.info(`Reusing saved port ${port} for stream`);
  } else {
    const basePort = camera.rtspPort || Number(process.env.RTSP_PORT) || 8554;
    port = await findNextAvailablePort(basePort);
  }

  // Build RTSP path using friendly name (camera-name/profile or camera-name/profile/channel for multifocal)
  // For multifocal with channel > 0, append /channel to avoid path collision (e.g. /camera/main/1 for tele)
  const basePath = `/${sanitizeCameraName(camera.name)}/${profile}`;
  const friendlyPath =
    channel > 0 ? `${basePath}/${channel}` : basePath;

  // Keep token for backward compatibility in saved config
  let streamToken = savedStreamConfig?.token;
  if (!streamToken) {
    streamToken = generateStreamToken();
  }
  const rtspPath = friendlyPath;

  const info: RtspServerInfo = {
    cameraId,
    cameraName: camera.name,
    status: "starting",
    port,
    profile,
    channel,
    connections: 0,
    streamKey,
    path: rtspPath,
  };

  rtspServers.set(streamKey, { server: null as any, info });

  try {
    const api = await getOrCreateApiConnection(cameraId);
    const go2rtcMgr = getGo2rtcManager();
    const useGo2rtc = settings.go2rtc?.enabled === true && go2rtcMgr?.isRunning;

    logger.info(
      `Stream mode decision: go2rtc.enabled=${settings.go2rtc?.enabled}, manager=${!!go2rtcMgr}, running=${go2rtcMgr?.isRunning}, useGo2rtc=${useGo2rtc}`,
    );

    // BaichuanRtspServer is always used as the internal stream source.
    // It handles audio+video via RTP over TCP (interleaved).
    // When go2rtc is enabled, the RTSP URL is registered as a source in go2rtc
    // which provides the external output (WebRTC/HLS/MJPEG/MSE).
    logger.info(
      `Starting RTSP server on port ${port} (${profile}, ch${channel})${useGo2rtc ? " → go2rtc" : ""}`,
    );

    const server = new BaichuanRtspServer({
      api,
      profile,
      channel,
      listenPort: port,
      listenHost: useGo2rtc ? "127.0.0.1" : "0.0.0.0",
      path: rtspPath,
      deviceId: cameraId,
      logger: {
        log: (msg: unknown) => logger.info(String(msg)),
        info: (msg: string) => logger.info(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
        debug: (msg: string) => logger.debug(msg),
      },
    });

    await server.start();

    const serviceIp = settings.serviceIp || "localhost";
    const localRtspUrl = `rtsp://127.0.0.1:${port}${rtspPath}`;

    if (useGo2rtc) {
      // Register the internal RTSP server as a source in go2rtc.
      // go2rtc ingests via RTSP (audio+video) and re-exports as WebRTC/HLS/MJPEG/MSE/RTSP.
      const go2rtcName = buildGo2rtcStreamName(camera.name, profile, channel);
      await go2rtcMgr!.addStream(go2rtcName, localRtspUrl);

      info.status = "running";
      info.mode = "go2rtc";
      info.go2rtcStreamName = go2rtcName;
      info.go2rtcSourceUrl = localRtspUrl;
      info.port = port;
      info.startedAt = new Date();

      const go2rtcRtspPort = Number(process.env.GO2RTC_RTSP_PORT) || (settings.go2rtc?.rtspPort ?? 18554);
      info.rtspUrl = `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`;

      rtspServers.set(streamKey, { server, info, go2rtcStreamName: go2rtcName });

      logger.info(`Go2rtc stream registered: ${go2rtcName} → ${localRtspUrl}`);
      logger.info(`RTSP via go2rtc: ${info.rtspUrl}`);
    } else {
      // Classic mode: BaichuanRtspServer exposed directly.
      info.status = "running";
      info.mode = "rtsp";
      info.rtspUrl = `rtsp://${serviceIp}:${port}${rtspPath}`;
      info.startedAt = new Date();

      rtspServers.set(streamKey, { server, info });

      logger.info(`RTSP server started: ${info.rtspUrl}`);
    }

    // Save stream configuration for auto-start on next server restart
    upsertCameraStream(cameraId, {
      profile,
      channel,
      port,
      token: streamToken,
      enabled: true,
      autoStart: true,
    });

    return info;
  } catch (error) {
    logger.error(`Failed to start stream server: ${error}`);
    info.status = "error";
    info.error = String(error);
    rtspServers.set(streamKey, { server: null as any, info });
    throw error;
  } finally {
    // Release claimed port — the server has either bound it or failed
    claimedPorts.delete(port);
  }
}

// Stop RTSP server by streamKey or legacy cameraId
export async function stopRtspServer(
  streamKeyOrCameraId: string,
  options?: { profile?: "main" | "sub" | "ext"; channel?: number },
): Promise<void> {
  // Try to find by exact streamKey first
  let entry = rtspServers.get(streamKeyOrCameraId);
  let streamKey = streamKeyOrCameraId;

  // If not found and options provided, build the key
  if (!entry && options) {
    streamKey = getRtspServerKey(
      streamKeyOrCameraId,
      options.profile || "main",
      options.channel ?? 0,
    );
    entry = rtspServers.get(streamKey);
  }

  // Fallback: search by cameraId (legacy support)
  if (!entry) {
    for (const [key, value] of rtspServers) {
      if (value.info.cameraId === streamKeyOrCameraId) {
        entry = value;
        streamKey = key;
        break;
      }
    }
  }

  if (!entry) return;

  const logger = createSourceLogger(
    `rtsp:${entry.info.cameraName}:${entry.info.profile}`,
  );

  try {
    // Deregister from go2rtc if this was a go2rtc stream
    if (entry.go2rtcStreamName) {
      const go2rtcMgr = getGo2rtcManager();
      if (go2rtcMgr?.isRunning) {
        await go2rtcMgr.removeStream(entry.go2rtcStreamName).catch(() => {});
      }
    }

    if (entry.server) {
      logger.info(`Stopping ${entry.info.mode === "go2rtc" ? "Go2rtc TCP" : "RTSP"} server`);
      await entry.server.stop();
    }
    entry.info.status = "stopped";
    entry.info.rtspUrl = undefined;
    entry.info.startedAt = undefined;
    entry.info.go2rtcStreamName = undefined;
    entry.info.go2rtcSourceUrl = undefined;

    logger.info("Stream server stopped");
  } catch (error) {
    logger.error(`Error stopping stream server: ${error}`);
    entry.info.status = "error";
    entry.info.error = String(error);
    throw error;
  }
}

// Get RTSP server info by streamKey or cameraId
export function getRtspServerInfo(
  streamKeyOrCameraId: string,
  options?: { profile?: "main" | "sub" | "ext"; channel?: number },
): RtspServerInfo | undefined {
  // Try direct lookup
  const direct = rtspServers.get(streamKeyOrCameraId);
  if (direct) return direct.info;

  // Try with options
  if (options) {
    const streamKey = getRtspServerKey(
      streamKeyOrCameraId,
      options.profile || "main",
      options.channel ?? 0,
    );
    const byKey = rtspServers.get(streamKey);
    if (byKey) return byKey.info;
  }

  // Fallback: search by cameraId
  for (const [, value] of rtspServers) {
    if (value.info.cameraId === streamKeyOrCameraId) {
      return value.info;
    }
  }

  return undefined;
}

// Get all RTSP servers info
export function getAllRtspServersInfo(): RtspServerInfo[] {
  return Array.from(rtspServers.values()).map((entry) => {
    if (entry.server && entry.info.status === "running") {
      entry.info.connections = entry.server.getClientCount();
    }
    return entry.info;
  });
}

// Get all RTSP servers for a specific camera
export function getCameraRtspServers(cameraId: string): RtspServerInfo[] {
  return Array.from(rtspServers.values())
    .filter((entry) => entry.info.cameraId === cameraId)
    .map((entry) => {
      if (entry.server && entry.info.status === "running") {
        entry.info.connections = entry.server.getClientCount();
      }
      return entry.info;
    });
}

// Restart RTSP server
export async function restartRtspServer(
  streamKeyOrCameraId: string,
  options?: { profile?: "main" | "sub" | "ext"; channel?: number },
): Promise<RtspServerInfo> {
  // Find existing server
  let entry = rtspServers.get(streamKeyOrCameraId);
  if (!entry && options) {
    const streamKey = getRtspServerKey(
      streamKeyOrCameraId,
      options.profile || "main",
      options.channel ?? 0,
    );
    entry = rtspServers.get(streamKey);
  }
  if (!entry) {
    for (const [, value] of rtspServers) {
      if (value.info.cameraId === streamKeyOrCameraId) {
        entry = value;
        break;
      }
    }
  }

  const restartOptions = entry?.info
    ? {
        port: entry.info.port,
        profile: entry.info.profile,
        channel: entry.info.channel,
      }
    : options;

  const cameraId = entry?.info.cameraId || streamKeyOrCameraId;

  await stopRtspServer(streamKeyOrCameraId, options);
  return startRtspServer(cameraId, restartOptions);
}

// Start all configured streams for a camera
export async function startAllCameraStreams(
  cameraId: string,
): Promise<RtspServerInfo[]> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) {
    throw new Error(`Camera not found: ${cameraId}`);
  }

  const results: RtspServerInfo[] = [];
  const streams = camera.rtspStreams?.filter((s) => s.enabled) || [];

  // If no streams configured, start main by default
  if (streams.length === 0 && camera.rtspEnabled) {
    const info = await startRtspServer(cameraId, {
      profile: camera.rtspProfile || "main",
      channel: camera.rtspChannel ?? 0,
    });
    results.push(info);
  } else {
    for (const stream of streams) {
      try {
        const info = await startRtspServer(cameraId, {
          profile: stream.profile,
          channel: stream.channel,
        });
        results.push(info);
      } catch (error) {
        // Continue with other streams even if one fails
        const logger = createSourceLogger("rtsp-manager");
        logger.error(`Failed to start stream ${stream.profile}: ${error}`);
      }
    }
  }

  return results;
}

// Stop all streams for a camera
export async function stopAllCameraStreams(cameraId: string): Promise<void> {
  const logger = createSourceLogger("rtsp-manager");

  for (const [streamKey, entry] of rtspServers) {
    if (entry.info.cameraId === cameraId) {
      try {
        await stopRtspServer(streamKey);
      } catch (error) {
        logger.error(`Error stopping stream ${streamKey}: ${error}`);
      }
    }
  }
}

// Auto-start RTSP servers for cameras with autoStart flag enabled
export async function autoStartRtspServers() {
  const config = getConfig();
  const logger = createSourceLogger("rtsp-manager");

  logger.info(
    `Auto-starting RTSP servers for ${config.cameras.length} cameras`,
  );

  for (const camera of config.cameras) {
    logger.info(
      `Camera ${camera.name}: autoStart=${camera.autoStart}`,
    );

    if (camera.autoStart !== true) continue;

    const channel = camera.rtspChannel ?? 0;
    const profiles = await getAvailableProfiles(camera.id);
    for (const profile of profiles) {
      try {
        logger.info(
          `Auto-starting stream ${profile}/ch${channel} for camera: ${camera.name}`,
        );
        await startRtspServer(camera.id, { profile, channel });
      } catch (error) {
        logger.warn(
          `Failed to auto-start ${profile} for ${camera.name}: ${error}`,
        );
      }
    }
  }
}

// Auto-connect to all configured cameras on startup
export async function autoConnectCameras() {
  const config = getConfig();
  const logger = createSourceLogger("rtsp-manager");

  const camerasToConnect = config.cameras.filter((camera) => {
    if (camera.autoStart === true) {
      logger.info(`Camera ${camera.name}: auto-connect (autoStart=true)`);
      return true;
    }
    logger.info(`Camera ${camera.name}: skipped (autoStart=${camera.autoStart})`);
    return false;
  });

  logger.info(
    `Auto-connecting to ${camerasToConnect.length} cameras (autoStart-enabled only)`,
  );

  for (const camera of camerasToConnect) {
    try {
      logger.info(
        `Connecting to camera: ${camera.name} (${camera.host}:${camera.port})`,
      );
      if (camera.nvrId) {
        // NVR child: enable only this camera (creates shared socket if needed)
        await enableNvrCamera(camera.id);
      } else {
        await getOrCreateApiConnection(camera.id);
      }
      logger.info(`Connected to camera: ${camera.name}`);
    } catch (error) {
      logger.error(`Failed to connect to ${camera.name}: ${error}`);
    }
  }
}

// Stop all RTSP servers
export async function stopAllRtspServers() {
  const logger = createSourceLogger("rtsp-manager");

  for (const [streamKey] of rtspServers) {
    try {
      await stopRtspServer(streamKey);
    } catch (error) {
      logger.error(`Error stopping RTSP for ${streamKey}: ${error}`);
    }
  }
}

// Update RTSP URLs for all running streams when serviceIp changes
export function updateRtspUrls(): void {
  const settings = getSettings();
  const serviceIp = settings.serviceIp || "localhost";

  for (const [, entry] of rtspServers) {
    if (
      entry.info.status === "running" &&
      entry.info.port &&
      entry.info.rtspUrl
    ) {
      try {
        // Extract path from current URL
        const url = new URL(entry.info.rtspUrl);
        const rtspPath = url.pathname;
        entry.info.rtspUrl = `rtsp://${serviceIp}:${entry.info.port}${rtspPath}`;
      } catch {
        // If URL parsing fails, skip this entry
      }
    }
  }
}

// Test camera connection
export async function testCameraConnection(
  host: string,
  port: number,
  username: string,
  password: string,
  channel?: number,
): Promise<{ success: boolean; info?: any; error?: string }> {
  const logger = createSourceLogger("connection-test");

  const api = new ReolinkBaichuanApi({
    host,
    port,
    username,
    password,
  });

  try {
    logger.debug(
      `Testing connection to ${host}:${port}${channel !== undefined ? ` (channel ${channel})` : ""}`,
    );
    await api.login();
    // Pass channel to getInfo for Hub/NVR to get the correct camera info
    const info = await api.getInfo(channel);
    await api.close();

    logger.debug(`Connection test successful: ${JSON.stringify(info)}`);
    return { success: true, info };
  } catch (error) {
    logger.error(`Connection test failed: ${error}`);
    return { success: false, error: String(error) };
  }
}

/**
 * Register a listener that auto-starts go2rtc streams when any camera connects.
 * Call once at startup when go2rtc is enabled.
 */
export function enableGo2rtcAutoStreams(): void {
  const logger = createSourceLogger("go2rtc-auto");

  onApiConnected(async (cameraId, _api) => {
    const settings = getSettings();
    if (!settings.go2rtc?.enabled) return;

    const go2rtcMgr = getGo2rtcManager();
    if (!go2rtcMgr?.isRunning) return;

    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);
    if (!camera) return;

    // Skip cameras with autoStart=true — those are handled by autoStartRtspServers()
    // at startup to avoid double-start race conditions.
    if (camera.autoStart === true) {
      logger.info(`Camera ${camera.name} connected (autoStart — handled at startup)`);
      return;
    }

    const channel = camera.rtspChannel ?? 0;
    const profiles = await getAvailableProfiles(cameraId);
    for (const profile of profiles) {
      const sk = getRtspServerKey(cameraId, profile, channel);
      if (rtspServers.get(sk)?.info.status === "running") continue;

      logger.info(`Camera ${camera.name} connected, starting ${profile}/ch${channel}`);
      try {
        await startRtspServer(cameraId, { profile, channel });
      } catch (e) {
        logger.warn(`Failed to start ${profile} for ${camera.name}: ${e}`);
      }
    }
  });

  logger.info("go2rtc auto-stream listener registered");
}
