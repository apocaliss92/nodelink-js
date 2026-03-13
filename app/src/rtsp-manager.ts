import {
  ReolinkBaichuanApi,
  BaichuanRtspServer,
} from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import {
  getConfig,
  getSettings,
  updateCamera,
  upsertCameraStream,
} from "./settings-store.js";
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

// Helper: find next available port starting from base
export async function findNextAvailablePort(
  basePort: number,
  maxAttempts: number = 100,
): Promise<number> {
  // First check ports already used by running RTSP servers
  const usedPorts = new Set<number>();
  for (const [, entry] of rtspServers) {
    if (entry.info.status === "running") {
      usedPorts.add(entry.info.port);
    }
  }

  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + i;
    if (usedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `No available port found in range ${basePort}-${basePort + maxAttempts}`,
  );
}

// Get suggested port for a new stream
export async function getSuggestedPort(): Promise<number> {
  const settings = getSettings();
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
  }
>();

// Store for camera info cache
const cameraInfoCache = new Map<string, CameraInfo>();

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
function notifyDisconnection(cameraId: string): void {
  // Release any shared streams from the pool for this camera.
  releaseStreamsByCamera(cameraId);

  for (const cb of apiDisconnectionListeners) {
    try {
      cb(cameraId);
    } catch (e) {
      createSourceLogger("rtsp-manager").error(
        `apiDisconnectionListener error: ${e}`,
      );
    }
  }

  const info = cameraInfoCache.get(cameraId);
  if (info) {
    info.status = "disconnected";
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
  const existing = apiConnections.get(cameraId);

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
      const cameraLogger = createSourceLogger(`camera:${cameraId}`);
      cameraLogger.info("API is closed, recreating connection");
      apiConnections.delete(cameraId);
      await cleanupManagedConnection(cameraId, existing);
      notifyDisconnection(cameraId);
    } else {
      // Socket disconnected but API still valid → try library-side reconnect
      const cameraLogger = createSourceLogger(`camera:${cameraId}`);
      try {
        cameraLogger.info("Socket lost, attempting ensureConnected()");
        await existing.api.ensureConnected();
        return existing.api;
      } catch (e) {
        cameraLogger.warn(
          `ensureConnected failed: ${(e as any)?.message || e}, recreating connection`,
        );
        apiConnections.delete(cameraId);
        await cleanupManagedConnection(cameraId, existing);
        notifyDisconnection(cameraId);
      }
    }
  }

  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) {
    throw new Error(`Camera not found: ${cameraId}`);
  }

  const cameraLogger = createSourceLogger(`camera:${camera.name}`);

  // Create a managed connection entry with the connect promise to serialize access
  const conn: ManagedConnection = {
    api: null!,
    cameraId,
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
      host: camera.host,
      port: camera.port,
      username: camera.username,
      password: camera.password,
      debugOptions,
      logger: {
        log: (msg: unknown) => cameraLogger.info(String(msg)),
        info: (msg: string) => cameraLogger.info(msg),
        warn: (msg: string) => cameraLogger.warn(msg),
        error: (msg: string) => cameraLogger.error(msg),
        debug: (msg: string) => cameraLogger.debug(msg),
      },
    });

    cameraLogger.info(`Connecting to camera at ${camera.host}:${camera.port}`);
    await api.login();
    cameraLogger.info("Connected successfully");

    // Detect device type and set flags BEFORE any streaming (critical for socket pooling)
    const channelCount = await api.getChannelCount();
    const info = await api.getInfo();
    const modelLower = (info?.type ?? "").toLowerCase();
    const isNvr =
      channelCount > 1 ||
      modelLower.includes("hub") ||
      modelLower.includes("nvr") ||
      modelLower.includes("home hub");

    api.setIsNvr(isNvr);
    cameraLogger.info(`setIsNvr(${isNvr}) — model=${info?.type}, channels=${channelCount}`);

    // Detect multifocal/dual-lens (TrackMix, Duo)
    const channel = camera.rtspChannel ?? 0;
    let isMultifocal = false;
    try {
      const dualLensAnalysis = await api.getDualLensChannelInfo(
        isNvr ? channel : 0,
        { onNvr: isNvr },
      );
      isMultifocal = dualLensAnalysis.isDualLens;
    } catch {
      // Not multifocal
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

    // Attach error/close listeners for auto-cleanup
    attachConnectionListeners(cameraId, conn);

    // Start ping keepalive
    startPingKeepalive(cameraId, conn);

    // Store in map
    apiConnections.set(cameraId, conn);

    // Notify listeners (e.g. events-manager for SSE/MQTT/JSON stream)
    for (const cb of apiConnectionListeners) {
      try {
        cb(cameraId, api);
      } catch (e) {
        createSourceLogger("rtsp-manager").error(
          `apiConnectionListener error: ${e}`,
        );
      }
    }

    // Update camera info cache (use already-fetched data)
    await updateCameraInfo(cameraId, api);

    return api;
  })();

  // Store immediately so concurrent callers find the connectPromise
  apiConnections.set(cameraId, conn);

  try {
    return await conn.connectPromise;
  } catch (error) {
    // Connection failed — clean up and apply backoff timestamp
    conn.lastDisconnectTime = Date.now();
    conn.connectPromise = undefined;
    apiConnections.delete(cameraId);
    cameraLogger.error(`Failed to connect: ${error}`);
    throw error;
  }
}

// Update camera info cache
async function updateCameraInfo(cameraId: string, api: ReolinkBaichuanApi) {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) return;

  try {
    const info = await api.getInfo();
    const channelCount = await api.getChannelCount();
    const channel = camera.rtspChannel ?? 0;

    // Check if this is an NVR/Hub (multiple channels or specific device types)
    const modelLower = (info?.type ?? "").toLowerCase();
    const isNvr =
      channelCount > 1 ||
      modelLower.includes("hub") ||
      modelLower.includes("nvr") ||
      modelLower.includes("home hub");

    // Check if this is a multifocal/dual-lens device (TrackMix, Duo)
    let isMultifocal = false;
    try {
      const dualLensAnalysis = await api.getDualLensChannelInfo(
        isNvr ? channel : 0,
        { onNvr: isNvr },
      );
      isMultifocal = dualLensAnalysis.isDualLens;
    } catch {
      // Not multifocal or getDualLensChannelInfo failed
    }

    // For NVR/Hub, use getInfo(channel) to get the channel-specific camera name
    let channelName: string | undefined;
    let channelModel: string | undefined;
    if (isNvr && channel >= 0) {
      try {
        // getInfo(channel) uses cmd_id 318 which returns channel-specific device info
        const channelInfo = await api.getInfo(channel);
        if (channelInfo?.name) {
          channelName = channelInfo.name;
        }
        if (channelInfo?.type) {
          channelModel = channelInfo.type;
        }
      } catch (e) {
        // Ignore errors, channelName will remain undefined
      }
    }

    cameraInfoCache.set(cameraId, {
      id: cameraId,
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
    cameraInfoCache.set(cameraId, {
      id: cameraId,
      name: camera.name,
      host: camera.host,
      port: camera.port,
      status: "error",
      error: String(error),
    });
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

// Close API connection
export async function closeApiConnection(cameraId: string) {
  const conn = apiConnections.get(cameraId);
  if (conn) {
    apiConnections.delete(cameraId);
    await cleanupManagedConnection(cameraId, conn);
    notifyDisconnection(cameraId);
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
    logger.info(
      `Starting RTSP server on port ${port} (${profile}, ch${channel})`,
    );

    const api = await getOrCreateApiConnection(cameraId);

    const server = new BaichuanRtspServer({
      api,
      profile,
      channel,
      listenPort: port,
      listenHost: "0.0.0.0", // Listen on all interfaces
      path: rtspPath,
      logger: {
        log: (msg: unknown) => logger.info(String(msg)),
        info: (msg: string) => logger.info(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
        debug: (msg: string) => logger.debug(msg),
      },
    });

    await server.start();

    info.status = "running";
    // Build URL using serviceIp setting
    const serviceIp = settings.serviceIp || "localhost";
    info.rtspUrl = `rtsp://${serviceIp}:${port}${rtspPath}`;
    info.startedAt = new Date();

    rtspServers.set(streamKey, { server, info });

    // Save stream configuration for auto-start on next server restart (including port and token)
    upsertCameraStream(cameraId, {
      profile,
      channel,
      port, // Remember the port for next time
      token: streamToken, // Remember the token for consistent URLs
      enabled: true,
      autoStart: true,
    });

    logger.info(`RTSP server started: ${info.rtspUrl}`);

    return info;
  } catch (error) {
    logger.error(`Failed to start RTSP server: ${error}`);
    info.status = "error";
    info.error = String(error);
    rtspServers.set(streamKey, { server: null as any, info });
    throw error;
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
    if (entry.server) {
      logger.info("Stopping RTSP server");
      await entry.server.stop();
    }
    entry.info.status = "stopped";
    entry.info.rtspUrl = undefined;
    entry.info.startedAt = undefined;

    logger.info("RTSP server stopped");
  } catch (error) {
    logger.error(`Error stopping RTSP server: ${error}`);
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
    // Update connections count from live server
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
      // Update connections count from live server
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
    const enabledStreams = (camera.rtspStreams ?? []).filter((s) => s.enabled === true);

    logger.info(
      `Camera ${camera.name}: autoStart=${camera.autoStart}, ${enabledStreams.length} enabled stream(s)`,
    );

    if (camera.autoStart !== true) continue;

    if (enabledStreams.length > 0) {
      for (const stream of enabledStreams) {
        try {
          logger.info(
            `Auto-starting stream ${stream.profile}/ch${stream.channel} for camera: ${camera.name}`,
          );
          await startRtspServer(camera.id, {
            profile: stream.profile,
            channel: stream.channel,
          });
        } catch (error) {
          logger.error(
            `Failed to auto-start ${stream.profile} for ${camera.name}: ${error}`,
          );
        }
      }
    } else if (camera.rtspEnabled) {
      // Legacy support
      try {
        logger.info(
          `Auto-starting RTSP for camera: ${camera.name} (legacy mode)`,
        );
        await startRtspServer(camera.id);
      } catch (error) {
        logger.error(`Failed to auto-start RTSP for ${camera.name}: ${error}`);
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
      await getOrCreateApiConnection(camera.id);
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
