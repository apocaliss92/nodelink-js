import {
  ReolinkBaichuanApi,
  Go2rtcTcpServer,
} from "@apocaliss92/nodelink-js";
import {
  createSourceLogger,
  appendConnLog,
  connLogEmitter,
  getConnLogs,
  clearConnLogs,
} from "./logger.js";
export { appendConnLog, connLogEmitter, getConnLogs, clearConnLogs };
export type { ConnLogLevel, ConnLogEntry } from "./logger.js";
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


// ---------------------------------------------------------------------------
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

/**
 * Check if a TCP port can be bound on the given host.
 * go2rtc ingest binds BaichuanRtspServer on 127.0.0.1 — checking only 0.0.0.0
 * misses conflicts and causes EADDRINUSE on sub/ext when they reuse main's saved port.
 */
export function isPortAvailable(
  port: number,
  host: string = "0.0.0.0",
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, host);
  });
}

/** Ports already assigned to other RTSP server entries (starting or running). */
function collectInProcessRtspPorts(excludeStreamKey?: string): Set<number> {
  const used = new Set<number>();
  for (const [key, entry] of rtspServers) {
    if (excludeStreamKey && key === excludeStreamKey) continue;
    const p = entry.info.port;
    if (!p || p <= 0) continue;
    if (entry.info.status === "running" || entry.info.status === "starting") {
      used.add(p);
    }
  }
  return used;
}

// Ports claimed by streams being started (prevents race conditions)
const claimedPorts = new Set<number>();

// Helper: find next available port starting from base
export async function findNextAvailablePort(
  basePort: number,
  maxAttempts: number = 100,
  listenHost: string = "0.0.0.0",
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
    if (await isPortAvailable(port, listenHost)) {
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
  return findNextAvailablePort(basePort, 100, "0.0.0.0");
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
  /** Server mode. Always "go2rtc" — kept for backward compatibility with
   * persisted stream-info objects, RTSP listener output, and tRPC clients. */
  mode?: "go2rtc";
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
    server: Go2rtcTcpServer;
    info: RtspServerInfo;
    /** go2rtc stream name registered with the go2rtc process. */
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

  const cameraLogger = createSourceLogger(`camera:${cameraId}`, cameraId);

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
  const cam = getConfig().cameras.find((c) => c.id === cameraId);
  const cameraName = cam?.name || cam?.host || cameraId;
  const cameraLogger = createSourceLogger(`camera:${cameraName}`, cameraId);

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

    // Battery camera idle disconnect: keep the API and streams alive for on-demand reconnect.
    // Check BEFORE any cleanup — api.isClosed is only true when api.close() was explicitly
    // called (hard/user-initiated disconnect). An idle_disconnect only closes the socket,
    // leaving api.isClosed = false. Calling cleanupManagedConnection first would call
    // api.close() and flip isClosed to true, making the check always false.
    const currentConfig = getConfig();
    const isBatteryIdleDisconnect = getAffectedCameraIds(cameraId).some((camId) => {
      const cam = currentConfig.cameras.find((c) => c.id === camId);
      return cam?.isBattery && !conn.api.isClosed;
    });

    if (isBatteryIdleDisconnect) {
      // Battery idle disconnect: the camera closed the TCP socket to save power.
      // The streaming session to the camera has already closed (prestartStream=false
      // + idle disconnect). The BaichuanRtspServer listener stays bound so that
      // the next go2rtc client (e.g. WebRTC preview) can reconnect and wake the
      // camera on demand. The apiConnections entry is kept so ensureConnected()
      // can reopen the socket transparently without waking the camera prematurely.
      if (conn.pingInterval) {
        clearInterval(conn.pingInterval);
        conn.pingInterval = undefined;
      }
      cameraLogger.info("Battery camera idle disconnect — camera socket closed, RTSP listener retained for on-demand streaming");
      return;
    }

    cameraLogger.warn("Socket closed, cleaning up for reconnection on next use");

    // Remove from map FIRST to prevent getOrCreateApiConnection from returning dead conn
    apiConnections.delete(cameraId);

    await cleanupManagedConnection(cameraId, conn);
    notifyDisconnection(cameraId);

    // Stop all streams that held a reference to the now-closed API so they
    // can be cleanly re-created with a fresh connection on next use.
    // Without this, BaichuanRtspServer instances keep a dead API reference
    // and throw "API has been closed" on the next client connection.
    const affectedIds = getAffectedCameraIds(cameraId);
    for (const camId of affectedIds) {
      stopAllCameraStreams(camId).catch((e) => {
        cameraLogger.debug(`Error stopping streams after close: ${e}`);
      });
    }
  });
}

/**
 * Start ping keepalive for a managed connection.
 */
function startPingKeepalive(cameraId: string, conn: ManagedConnection): void {
  const cameraLogger = createSourceLogger(`camera:${cameraId}`, cameraId);

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
      const cameraLogger = createSourceLogger(`camera:${connKey}`, connKey);
      cameraLogger.info("API is closed, recreating connection");
      apiConnections.delete(connKey);
      await cleanupManagedConnection(connKey, existing);
      notifyDisconnection(connKey);
    } else {
      // Socket disconnected but API still valid → try library-side reconnect
      const cameraLogger = createSourceLogger(`camera:${connKey}`, connKey);
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

  const cameraLogger = createSourceLogger(`camera:${logLabel}`, cameraId);
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
      ...(camera.uid ? { uid: camera.uid } : {}),
      // NVR/Hub connections always use TCP on port 9000 — never UDP, even if the
      // child camera is a battery device. The battery flag applies to standalone connections only.
      // For standalone battery cameras, use UDP directly — "auto" mode won't help because the
      // camera accepts the TCP socket handshake but never responds to Baichuan protocol,
      // so connectTcp() resolves without throwing and the UDP fallback never triggers.
      transport: isNvrConnection ? "tcp" : (camera.isBattery ? "udp" : (camera.transport ?? "auto")),
      ...(!isNvrConnection && camera.udpDiscoveryMethod ? { udpDiscoveryMethod: camera.udpDiscoveryMethod } : {}),
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

    // Detect device type and set flags BEFORE any streaming (critical for socket pooling).
    // getChannelCount and getInfo use independent cmdIds — run in parallel.
    const [channelCount, info] = await Promise.all([
      api.getChannelCount(),
      api.getInfo(),
    ]);
    const modelLower = (info?.type ?? "").toLowerCase();
    const isNvr =
      isNvrConnection ||
      channelCount > 1 ||
      modelLower.includes("hub") ||
      modelLower.includes("nvr") ||
      modelLower.includes("home hub");

    api.setIsNvr(isNvr);
    cameraLogger.info(`setIsNvr(${isNvr}) — model=${info?.type}, channels=${channelCount}`);

    // Detect multifocal/dual-lens (TrackMix, Duo).
    // Skipped for battery cameras: they're never dual-lens and this call would
    // unnecessarily wake the camera during reconnection.
    const channel = camera.rtspChannel ?? 0;
    let isMultifocal = false;
    if (!isNvrConnection && !camera.isBattery) {
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

    // Enable library-level idle disconnect for battery cameras so the UDP
    // socket is released when idle, allowing the camera to enter deep sleep.
    // Without this the camera is constantly woken up by external pings and
    // drains the battery even with a solar panel attached.
    // (Mirrors scrypted-reolink-native/src/baichuan-base.ts.)
    if (camera.isBattery) {
      api.setIdleDisconnect(true);
      cameraLogger.info("setIdleDisconnect(true) — battery camera");
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

    // Start ping keepalive — skipped for battery cameras: pings would
    // force-wake the camera every PING_INTERVAL_MS, defeating idle disconnect
    // and draining the battery. The library's internal watchdog handles
    // event subscription recovery for UDP/battery cameras.
    if (!camera.isBattery) {
      startPingKeepalive(connKey, conn);
    } else {
      cameraLogger.info("Ping keepalive disabled — battery camera");
    }

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

/**
 * Returns the existing API connection for a camera WITHOUT triggering reconnect.
 * Returns undefined if no connection exists or if the API is closed.
 * Safe to call for sleeping battery cameras — it never wakes the camera.
 */
export function getExistingApiConnection(
  cameraId: string,
): ReolinkBaichuanApi | undefined {
  const connKey = getConnectionKey(cameraId);
  const conn = apiConnections.get(connKey);
  if (!conn || conn.api.isClosed) return undefined;
  return conn.api;
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
  if (go2rtcMgr?.isRunning) {
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

  const logger = createSourceLogger(`rtsp:${camera.name}:${profile}`, camera.id);
  const settings = getSettings();
  // For battery cameras we force a short idle timeout (15s) so the native
  // Baichuan stream is torn down when no RTSP consumer is connected, letting
  // the camera go back to sleep. Without this, one-off probes (UI preview,
  // go2rtc registration) keep the stream alive forever and the camera
  // drains its battery. AC-powered cameras use the user setting
  // (rtspProxyBackendIdleTimeoutMs, default 0 = always-on).
  const baseNativeIdleMs = settings.rtspProxyBackendIdleTimeoutMs;
  const nativeIdleMs = camera.isBattery
    ? baseNativeIdleMs > 0
      ? Math.min(baseNativeIdleMs, 15_000)
      : 15_000
    : baseNativeIdleMs;
  const rtspNativeIdleOpts = {
    nativeStreamIdleStopMs: nativeIdleMs,
    nativeStreamPrimeIdleStopMs: nativeIdleMs > 0 ? 15_000 : 0,
  };

  // Go2rtcTcpServer always binds loopback only — only the local go2rtc
  // process consumes the MPEG-TS feed; external clients connect to go2rtc.
  const portBindHost = "127.0.0.1";

  // Find saved stream config to get previously used port
  const savedStreamConfig = camera.rtspStreams?.find(
    (s) => s.profile === profile && s.channel === channel,
  );

  const portsHeldByPeers = collectInProcessRtspPorts(streamKey);

  // Auto-select port: use specified port, saved port, or find next available
  let port: number;
  if (options?.port) {
    port = options.port;
    if (portsHeldByPeers.has(port)) {
      logger.warn(
        `Explicit port ${port} already used by another stream; picking next free on ${portBindHost}`,
      );
      const basePort = camera.rtspPort || Number(process.env.RTSP_PORT) || 8554;
      port = await findNextAvailablePort(basePort, 100, portBindHost);
    }
  } else if (
    savedStreamConfig?.port &&
    !portsHeldByPeers.has(savedStreamConfig.port) &&
    (await isPortAvailable(savedStreamConfig.port, portBindHost))
  ) {
    // Use previously saved port if still free on the bind host and not taken in-process
    port = savedStreamConfig.port;
    claimedPorts.add(port);
    logger.info(`Reusing saved port ${port} for stream`);
  } else {
    if (
      savedStreamConfig?.port &&
      (portsHeldByPeers.has(savedStreamConfig.port) ||
        !(await isPortAvailable(savedStreamConfig.port, portBindHost)))
    ) {
      logger.info(
        `Saved port ${savedStreamConfig.port} unavailable for ${profile} (in use or wrong host); allocating next on ${portBindHost}`,
      );
    }
    const basePort = camera.rtspPort || Number(process.env.RTSP_PORT) || 8554;
    port = await findNextAvailablePort(basePort, 100, portBindHost);
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
    const useGo2rtc = go2rtcMgr?.isRunning === true;

    // For H265 cameras, register an ffmpeg-transcoded source in go2rtc so
    // WebRTC clients (browsers that don't support H265) get H264.
    // go2rtc's multi-source merge doesn't do per-codec routing, so we use
    // the ffmpeg source as the SOLE go2rtc source for H265 streams.
    // H264 cameras keep the native RTSP source (no transcoding overhead).
    // Unknown codec (battery sleeping at registration time): use ffmpeg as a
    // safety net — better to transcode than to silently fail WebRTC.
    const buildGo2rtcSources = async (
      streamName: string,
      primarySource: string,
    ): Promise<string[]> => {
      // ffmpeg transcodes FROM the go2rtc stream (not from the raw RTSP URL).
      // Using the stream name lets go2rtc ingest natively (audio+video) and
      // exposes a clean H.264 re-encode for WebRTC clients that cannot play H.265.
      // #audio=copy preserves the AAC track so audio is not silently dropped.
      const ffmpegSource = `ffmpeg:${streamName}#video=h264#audio=copy`;
      try {
        const isNvr = camera.isNvr || !!camera.nvrId;
        const opts = await api.buildVideoStreamOptions({ channel, onNvr: isNvr });
        const match = opts.nativeStreams.find(
          (s) => s.profile === profile && (s.channel ?? 0) === channel,
        );
        const codec = match?.metadata?.videoEncType;
        if (codec === "H.264") {
          logger.info(`Codec for ${streamName} is H264 — using native source`);
          return [primarySource];
        }
        // H.265 or unknown: register both the native source (for RTSP/HLS/MSE
        // clients that handle H.265 natively) and the ffmpeg transcode source
        // (for WebRTC clients that require H.264).
        logger.info(
          `Codec for ${streamName} is "${codec ?? "unknown"}" — using native + ffmpeg H264 transcode`,
        );
        return [primarySource, ffmpegSource];
      } catch (e) {
        logger.info(
          `Codec detection failed for ${streamName} (${e}); using native + ffmpeg H264 transcode as safety net`,
        );
        return [primarySource, ffmpegSource];
      }
    };

    if (!useGo2rtc) {
      throw new Error(
        `Cannot start stream ${profile}/ch${channel}: go2rtc is not running. ` +
        `Check the go2rtc process status.`,
      );
    }

    const rtspLogger = {
      log: (msg: unknown) => logger.info(String(msg)),
      info: (msg: string) => logger.info(msg),
      warn: (msg: string) => logger.warn(msg),
      error: (msg: string) => logger.error(msg),
      debug: (msg: string) => logger.debug(msg),
    };

    const serviceIp = settings.serviceIp || "localhost";

    // Go2rtcTcpServer on loopback, feeding MPEG-TS (H.264/H.265 + AAC)
    // directly to go2rtc via a tcp:// source — no intermediate RTSP stack.
    logger.info(
      `Starting Go2rtcTcpServer (MPEG-TS) on port ${port} (${profile}, ch${channel}) → go2rtc`,
    );

    const server = new Go2rtcTcpServer({
      api,
      profile,
      channel,
      listenPort: port,
      listenHost: "127.0.0.1",
      deviceId: cameraId,
      logger: rtspLogger,
      prestartStream: !camera.isBattery,
      gracePeriodMs: rtspNativeIdleOpts.nativeStreamIdleStopMs > 0
        ? rtspNativeIdleOpts.nativeStreamIdleStopMs
        : 30_000,
    });

    await server.start();

    const tcpSourceUrl = server.go2rtcSourceUrl!;
    const go2rtcName = buildGo2rtcStreamName(camera.name, profile, channel);
    // The MPEG-TS source carries audio+video in one TCP stream, so go2rtc
    // ingests it natively.  For H.265 cameras we still add the ffmpeg
    // transcode source so WebRTC clients (which require H.264) are served.
    const sources = await buildGo2rtcSources(go2rtcName, tcpSourceUrl);
    await go2rtcMgr!.addStream(go2rtcName, sources);

    info.status = "running";
    info.mode = "go2rtc";
    info.go2rtcStreamName = go2rtcName;
    info.go2rtcSourceUrl = tcpSourceUrl;
    info.port = port;
    info.startedAt = new Date();

    const go2rtcRtspPort = Number(process.env.GO2RTC_RTSP_PORT) || (settings.go2rtc?.rtspPort ?? 18554);
    info.rtspUrl = `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`;

    rtspServers.set(streamKey, { server, info, go2rtcStreamName: go2rtcName });

    logger.info(`Go2rtc TCP stream registered: ${go2rtcName} → ${tcpSourceUrl}`);
    logger.info(`RTSP via go2rtc: ${info.rtspUrl}`);

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
    entry.info.cameraId,
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
      logger.info("Stopping Go2rtc TCP server");
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
/** Get the stream server instance for a stream (used by diagnostics). */
export function getRtspServerInstance(
  cameraId: string,
  profile: "main" | "sub" | "ext",
  channel: number,
): Go2rtcTcpServer | undefined {
  const key = getRtspServerKey(cameraId, profile, channel);
  return rtspServers.get(key)?.server;
}

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
      entry.info.connections = entry.server.clientCount;
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
        entry.info.connections = entry.server.clientCount;
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

  // If no streams configured, start main by default.
  // For battery cameras, also fall back even if rtspEnabled is false —
  // the caller (e.g. manual connect) explicitly requested stream start.
  if (streams.length === 0 && (camera.rtspEnabled || camera.isBattery)) {
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
 * Register a pre-connected API (e.g. from autoDetectDeviceType()) into the
 * managed connection pool. This avoids a redundant login — the API is already
 * authenticated and probed.
 *
 * Sets up the same lifecycle as getOrCreateApiConnection(): error/close
 * listeners, ping keepalive, info cache, and connection listeners.
 */
export async function registerPreConnectedApi(
  cameraId: string,
  api: ReolinkBaichuanApi,
): Promise<void> {
  const connKey = getConnectionKey(cameraId);
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const cameraName = camera?.name || camera?.host || cameraId;
  const cameraLogger = createSourceLogger(`camera:${cameraName}`, cameraId);

  // If there's already a live connection for this key, close the old one
  const existing = apiConnections.get(connKey);
  if (existing) {
    cameraLogger.info("Replacing existing connection with pre-connected API");
    apiConnections.delete(connKey);
    await cleanupManagedConnection(connKey, existing);
  }

  const conn: ManagedConnection = {
    api,
    cameraId: connKey,
    connectionTime: Date.now(),
    lastDisconnectTime: 0,
    consecutivePingFailures: 0,
    cleanupInProgress: false,
  };

  // Attach lifecycle management (same as getOrCreateApiConnection)
  attachConnectionListeners(connKey, conn);
  // Skip ping keepalive for battery cameras — pings would force-wake the camera
  // every PING_INTERVAL_MS, defeating idle disconnect and draining the battery.
  if (!camera?.isBattery) {
    startPingKeepalive(connKey, conn);
  } else {
    cameraLogger.info("Ping keepalive disabled — battery camera");
  }
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

  // Update camera info cache
  await updateCameraInfo(connKey, api);
  cameraLogger.info("Pre-connected API registered successfully");
}

/**
 * Create a logger that forwards to both the system logger and the per-camera
 * connection log buffer (for SSE streaming to the UI).
 */
export function createCameraConnLogger(cameraId: string, label: string) {
  const l = createSourceLogger(`camera:${label}`, cameraId);
  return {
    log: (msg: unknown) => l.info(String(msg)),
    info: l.info,
    warn: l.warn,
    error: l.error,
    debug: l.debug,
  };
}

/**
 * Start all stream profiles for cameras that already have a live Baichuan connection.
 * Used after go2rtc finishes starting (connections that happened earlier deferred).
 */
export async function startStreamsForAllConnectedCameras(): Promise<void> {
  const logger = createSourceLogger("auto-streams");
  const go2rtcMgr = getGo2rtcManager();

  if (!go2rtcMgr?.isRunning) {
    return;
  }

  const config = getConfig();
  for (const camera of config.cameras) {
    if (camera.nvrId && disabledNvrCameras.has(camera.id)) continue;

    // Skip battery cameras in streamOnly mode: auto-starting their streams
    // registers the RTSP URL with go2rtc, which then reconnects every ~60s
    // even when no client is watching — waking the camera continuously and
    // draining the battery. Streams are started on-demand when a client connects.
    if (camera.isBattery && (camera.batteryMode ?? "streamOnly") === "streamOnly") {
      logger.info(`Flush: skip battery camera ${camera.name} (batteryMode=streamOnly)`);
      continue;
    }

    const connKey = getConnectionKey(camera.id);
    const conn = apiConnections.get(connKey);
    if (!conn?.api?.isReady) continue;

    const channel = camera.rtspChannel ?? 0;
    const profiles = await getAvailableProfiles(camera.id);
    for (const profile of profiles) {
      const sk = getRtspServerKey(camera.id, profile, channel);
      if (rtspServers.get(sk)?.info.status === "running") continue;

      logger.info(
        `Flush: starting ${profile}/ch${channel} for ${camera.name}`,
      );
      try {
        await startRtspServer(camera.id, { profile, channel });
      } catch (e) {
        logger.warn(`Flush: failed ${profile} for ${camera.name}: ${e}`);
      }
    }
  }
}

/**
 * Register a listener that starts all stream profiles when a camera API connects.
 * Idempotent per stream (startRtspServer no-ops if already running). Call once at
 * server startup, before autoConnectCameras().
 */
export function enableAutoStreamsOnConnect(): void {
  const logger = createSourceLogger("auto-streams");

  onApiConnected(async (cameraId, _api) => {
    const go2rtcMgr = getGo2rtcManager();

    if (!go2rtcMgr?.isRunning) {
      logger.debug(
        `Defer auto-streams for camera ${cameraId}: go2rtc not running yet`,
      );
      return;
    }

    if (disabledNvrCameras.has(cameraId)) return;

    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);
    if (!camera) return;

    // Skip battery cameras in streamOnly mode: they must start streams
    // only on-demand (when a client actually requests playback), otherwise
    // we hold the Baichuan video socket open and the camera never sleeps.
    // Users who want permanent streams can switch batteryMode to "alwaysOn".
    if (camera.isBattery && (camera.batteryMode ?? "streamOnly") === "streamOnly") {
      logger.info(
        `Skip auto-streams for battery camera ${camera.name} (batteryMode=streamOnly)`,
      );
      return;
    }

    const channel = camera.rtspChannel ?? 0;
    const profiles = await getAvailableProfiles(cameraId);
    for (const profile of profiles) {
      const sk = getRtspServerKey(cameraId, profile, channel);
      if (rtspServers.get(sk)?.info.status === "running") continue;

      logger.info(
        `Camera ${camera.name} connected, starting ${profile}/ch${channel}`,
      );
      try {
        await startRtspServer(cameraId, { profile, channel });
      } catch (e) {
        logger.warn(`Failed to start ${profile} for ${camera.name}: ${e}`);
      }
    }
  });

  logger.info("Auto-stream on camera connect listener registered");
}

/** @deprecated Use enableAutoStreamsOnConnect */
export const enableGo2rtcAutoStreams = enableAutoStreamsOnConnect;
