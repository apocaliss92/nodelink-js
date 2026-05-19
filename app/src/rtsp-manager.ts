import {
  ReolinkBaichuanApi,
  Go2rtcTcpServer,
  BaichuanRtspServer,
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
  RTSP_DIGEST_REALM,
} from "./settings-store.js";
import { getGo2rtcManager } from "./go2rtc-manager.js";
import { isBatteryCamera } from "./camera-traits.js";
import {
  getLocalRtspMux,
  initLocalRtspMux,
  stopLocalRtspMux,
} from "./local-rtsp-mux.js";
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
 * Ensure the single-port local RTSP multiplexer is initialized and listening.
 *
 * Called eagerly from server startup (before any camera streams are
 * registered) and defensively from `startRtspServer` in local mode so the
 * mux always exists before we try to register a path on it. The second
 * call is cheap: `initLocalRtspMux` returns the singleton and `start()` is
 * idempotent once the server is listening.
 *
 * Returns the mux instance. Rejects only if binding the port fails.
 */
export async function ensureLocalRtspMux() {
  const settings = getSettings();
  const port = settings.localRtsp?.port ?? 8554;
  const bindHost = settings.localRtsp?.bindHost ?? "0.0.0.0";

  const logger = createSourceLogger("rtsp-mux");
  const muxLogger = {
    info: (m: string) => logger.info(m),
    warn: (m: string) => logger.warn(m),
    error: (m: string) => logger.error(m),
    debug: (m: string) => logger.debug(m),
  };

  const mux = initLocalRtspMux(port, bindHost, muxLogger);
  if (!mux.isStarted) {
    await mux.start();
  }
  return mux;
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
  /**
   * When using go2rtc: the companion stream name that exposes a WebRTC-
   * compatible H.264 + OPUS transcode of the primary stream. WebRTC
   * consumers must use this name instead of `go2rtcStreamName` since
   * WebRTC cannot play H.265 and cannot accept AAC audio.
   */
  go2rtcWebrtcStreamName?: string;
  /** When using go2rtc: the tcp:// source URL. */
  go2rtcSourceUrl?: string;
  /**
   * Server mode:
   *  - "go2rtc": Go2rtcTcpServer feeding the go2rtc sidecar (WebRTC/HLS/MJPEG/RTSP out)
   *  - "local":  BaichuanRtspServer directly exposes RTSP (no previews)
   */
  mode?: "go2rtc" | "local";
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
  // Flush for connections that are already ready. Use optional chaining:
  // a ManagedConnection is inserted into the map with api=null before its
  // connect-promise completes (so concurrent callers can find the in-flight
  // promise), and the listener must not crash on those in-flight entries.
  for (const [cameraId, conn] of apiConnections) {
    if (conn.api?.isReady) {
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

// Store for RTSP servers. `server` may be either a Go2rtcTcpServer (when
// settings.restreamer === "go2rtc") or a BaichuanRtspServer (when
// settings.restreamer === "local"). Both expose an async `stop()` method.
const rtspServers = new Map<
  string,
  {
    server: Go2rtcTcpServer | BaichuanRtspServer;
    info: RtspServerInfo;
    /** go2rtc stream name registered with the go2rtc process (go2rtc mode only). */
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

    // Remove listeners to prevent re-entrant close handling.
    // Re-attach a no-op error handler immediately so any error emitted during
    // the subsequent api.close() teardown (ECONNRESET on the underlying TCP
    // socket is common) doesn't bubble up as an unhandled error and crash
    // the host process.
    try {
      conn.api.client.removeAllListeners("error");
      conn.api.client.removeAllListeners("close");
      conn.api.client.on("error", () => {
        // swallow — connection is being torn down
      });
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
      return isBatteryCamera(cam) && !conn.api.isClosed;
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

    // Synchronously mark all RTSP server entries for affected cameras as
    // "stopped" so the reconnect listener (enableAutoStreamsOnConnect) does
    // not skip them on its `status === "running"` early-exit check while the
    // async stopAllCameraStreams below is still tearing them down. Without
    // this, the watchdog can race the cleanup and conclude that streams are
    // still alive — leaving them dead until the next disconnect cycle.
    const affectedIds = getAffectedCameraIds(cameraId);
    for (const [, entry] of rtspServers) {
      if (affectedIds.includes(entry.info.cameraId) && entry.info.status === "running") {
        entry.info.status = "stopped";
      }
    }

    await cleanupManagedConnection(cameraId, conn);
    notifyDisconnection(cameraId);

    // Stop all streams that held a reference to the now-closed API so they
    // can be cleanly re-created with a fresh connection on next use.
    // Without this, BaichuanRtspServer instances keep a dead API reference
    // and throw "API has been closed" on the next client connection.
    // AWAITED so the reconnect listener observes a fully clean state when it
    // runs after getOrCreateApiConnection completes.
    for (const camId of affectedIds) {
      try {
        await stopAllCameraStreams(camId);
      } catch (e) {
        cameraLogger.debug(`Error stopping streams after close: ${e}`);
      }
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
      // NVR/Hub connections always use TCP on port 9000.
      // For standalone cameras the explicit `camera.transport` is the source
      // of truth: battery cameras carry `transport: "udp"` (set explicitly
      // by the user, by discovery, or by the "Persisted resolved transport"
      // hook in events-manager). AC cameras carry "tcp" or "auto".
      transport: isNvrConnection ? "tcp" : (camera.transport ?? "auto"),
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
    if (!isNvrConnection && !isBatteryCamera(camera)) {
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
    if (isBatteryCamera(camera)) {
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
    if (!isBatteryCamera(camera)) {
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
  camera: { id: string; name: string; host: string; port: number; rtspChannel?: number; transport?: string },
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

    const battery = isBatteryCamera(camera);
    let isMultifocal = false;
    if (!battery) {
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
    if (!battery && isNvr && channel >= 0) {
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
  // conn.api is null during an in-flight connection (the map is populated
  // before the connect promise resolves so concurrent callers share it).
  if (!conn || !conn.api || conn.api.isClosed) return undefined;
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
  const nativeIdleMs = isBatteryCamera(camera)
    ? baseNativeIdleMs > 0
      ? Math.min(baseNativeIdleMs, 15_000)
      : 15_000
    : baseNativeIdleMs;
  const rtspNativeIdleOpts = {
    nativeStreamIdleStopMs: nativeIdleMs,
    nativeStreamPrimeIdleStopMs: nativeIdleMs > 0 ? 15_000 : 0,
  };

  // Port availability host MUST match the actual bind host of the stream
  // server, otherwise findNextAvailablePort may think a port is free on
  // loopback while another process holds it on the public interface (or
  // vice-versa), producing a confusing EADDRINUSE at bind time.
  //  - go2rtc mode: Go2rtcTcpServer binds loopback only (feeds go2rtc).
  //  - local mode:  BaichuanRtspServer binds on settings.localRtsp.bindHost
  //                 (default 0.0.0.0) so external RTSP clients can connect.
  const portBindHost =
    settings.restreamer === "local"
      ? (settings.localRtsp?.bindHost ?? "0.0.0.0")
      : "127.0.0.1";

  // Find saved stream config to get previously used port
  const savedStreamConfig = camera.rtspStreams?.find(
    (s) => s.profile === profile && s.channel === channel,
  );

  const portsHeldByPeers = collectInProcessRtspPorts(streamKey);

  // Auto-select port.
  //
  // In **local restreamer mode**, all streams share a single RTSP port owned
  // by `LocalRtspMux` — there is no need to allocate per-stream ports, and
  // reusing the mux port for every stream avoids bogus EADDRINUSE probing
  // against a port we don't even bind ourselves. The mux reads the first
  // request line and dispatches by path.
  //
  // In **go2rtc mode** we keep the historical per-Go2rtcTcpServer port
  // allocation (each TCP source needs its own loopback listener).
  let port: number;
  if (settings.restreamer === "local") {
    port = settings.localRtsp?.port ?? 8554;
  } else if (options?.port) {
    port = options.port;
    if (portsHeldByPeers.has(port)) {
      logger.warn(
        `Explicit port ${port} already used by another stream; picking next free on ${portBindHost}`,
      );
      const basePort =
        camera.rtspPort ||
        Number(process.env.RTSP_PORT) ||
        8554;
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
    const restreamerMode = settings.restreamer ?? "go2rtc";
    const go2rtcMgr = getGo2rtcManager();
    const useGo2rtc = restreamerMode === "go2rtc" && go2rtcMgr?.isRunning === true;

    /**
     * Detect the camera's video codec so we can decide whether a WebRTC
     * companion stream (H.264 + OPUS) is needed. Returns null when
     * detection fails (e.g. battery camera sleeping at registration time).
     */
    const detectCodec = async (): Promise<"H.264" | "H.265" | null> => {
      try {
        const isNvr = camera.isNvr || !!camera.nvrId;
        const opts = await api.buildVideoStreamOptions({ channel, onNvr: isNvr });
        const match = opts.nativeStreams.find(
          (s) => s.profile === profile && (s.channel ?? 0) === channel,
        );
        const codec = match?.metadata?.videoEncType;
        if (codec === "H.264") return "H.264";
        if (codec === "H.265") return "H.265";
        return null;
      } catch {
        return null;
      }
    };

    const go2rtcRtspPortForSources =
      Number(process.env.GO2RTC_RTSP_PORT) || (settings.go2rtc?.rtspPort ?? 18554);

    if (restreamerMode === "go2rtc" && !useGo2rtc) {
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

    // ─── Local restreamer mode ──────────────────────────────────────────────
    // Use the library's built-in BaichuanRtspServer in **mux mode**: a
    // single-port LocalRtspMux owns the listening socket and routes each
    // RTSP connection to the correct per-stream server by URL path. No
    // go2rtc sidecar, no WebRTC/HLS/MJPEG previews.
    if (restreamerMode === "local") {
      const mux = await ensureLocalRtspMux();
      const muxPort = mux.listenPort;
      const muxBindHost = mux.listenHost;
      const localPath = `/${buildGo2rtcStreamName(camera.name, profile, channel)}`;

      logger.info(
        `Registering BaichuanRtspServer (local RTSP, mux) on ${muxBindHost}:${muxPort}${localPath} (${profile}, ch${channel})`,
      );

      // Unified auth: reuse dashboard users as RTSP users. Their HA1 digest
      // is pre-computed at password-set time ([settings-store.ts]
      // addDashboardUser / setDashboardUserPassword) so the RTSP server can
      // validate Digest challenges without ever seeing the plaintext.
      const requireAuthSetting =
        settings.localRtsp?.requireAuth ?? settings.rtspRequireAuth ?? false;
      const credentials = (settings.dashboardUsers ?? [])
        .filter((u) => u.rtspDigestHa1 && u.username)
        .map((u) => ({ username: u.username, ha1: u.rtspDigestHa1! }));
      if (requireAuthSetting && credentials.length === 0) {
        logger.warn(
          `rtspRequireAuth is set but no dashboard user has a pre-computed rtspDigestHa1. ` +
          `Reset any user password from the Users tab to regenerate it, or clear rtspRequireAuth.`,
        );
      }

      const baichuanServer = new BaichuanRtspServer({
        api,
        channel,
        profile,
        // listenHost/listenPort are purely informational in mux mode — the
        // server never binds them. They are still passed so that SDP/logs
        // reflect the public endpoint users will dial.
        listenHost: muxBindHost,
        listenPort: muxPort,
        path: localPath,
        logger: rtspLogger,
        deviceId: cameraId,
        requireAuth: requireAuthSetting && credentials.length > 0,
        credentials,
        authRealm: RTSP_DIGEST_REALM,
        muxMode: true,
        // On-demand native stream:
        // - lazyMetadata: don't wake the camera at boot just to grab SDP
        //   fields; fetch on first DESCRIBE instead. Matches go2rtc's lazy
        //   source-pull model.
        // - nativeStreamIdleStopMs: stop the native Baichuan stream after
        //   30s with no RTSP clients connected (user-configurable via
        //   rtspProxyBackendIdleTimeoutMs).
        lazyMetadata: true,
        nativeStreamIdleStopMs:
          rtspNativeIdleOpts.nativeStreamIdleStopMs > 0
            ? rtspNativeIdleOpts.nativeStreamIdleStopMs
            : 30_000,
      });

      await baichuanServer.start();
      mux.register(localPath, baichuanServer);

      info.status = "running";
      info.mode = "local";
      info.port = muxPort;
      info.startedAt = new Date();
      info.rtspUrl = `rtsp://${serviceIp}:${muxPort}${localPath}`;

      rtspServers.set(streamKey, { server: baichuanServer, info });
      logger.info(`RTSP (local, mux): ${info.rtspUrl}`);

      upsertCameraStream(cameraId, {
        profile,
        channel,
        port: muxPort,
        token: streamToken,
        enabled: true,
        autoStart: true,
      });

      return info;
    }

    // ─── go2rtc restreamer mode (default) ──────────────────────────────────
    // Go2rtcTcpServer on loopback, feeding MPEG-TS (H.264/H.265 + AAC)
    // directly to go2rtc via a tcp:// source — no intermediate RTSP stack.
    logger.info(
      `Starting Go2rtcTcpServer (MPEG-TS) on port ${port} (${profile}, ch${channel}) → go2rtc`,
    );

    const go2rtcName = buildGo2rtcStreamName(camera.name, profile, channel);

    const server = new Go2rtcTcpServer({
      api,
      profile,
      channel,
      listenPort: port,
      listenHost: "127.0.0.1",
      deviceId: cameraId,
      logger: rtspLogger,
      prestartStream: !isBatteryCamera(camera),
      gracePeriodMs: rtspNativeIdleOpts.nativeStreamIdleStopMs > 0
        ? rtspNativeIdleOpts.nativeStreamIdleStopMs
        : 30_000,
    });

    await server.start();

    const tcpSourceUrl = server.go2rtcSourceUrl!;

    // Primary stream: MPEG-TS from our Go2rtcTcpServer, carrying native
    // H.264/H.265 video + AAC audio.  Ingested 1:1 for RTSP / HLS / MSE
    // consumers that can handle the native codecs.
    await go2rtcMgr!.addStream(go2rtcName, tcpSourceUrl);
    logger.info(`Go2rtc primary stream registered: ${go2rtcName} → ${tcpSourceUrl}`);

    // WebRTC companion stream: single-source ffmpeg transcode to H.264+OPUS.
    // We register it as a SEPARATE stream (not an additional source on the
    // primary) because go2rtc's `PUT /api/streams` silently keeps only the
    // first `src` parameter — multi-source entries only work from the static
    // YAML, which go2rtc does not hot-reload.  Combining video + audio into
    // one ffmpeg chain is fine here because both tracks are transcoded
    // (no `audio=copy` AAC-over-RTSP negotiation failure).
    //
    // H.264 cameras still need the audio transcoded for WebRTC (AAC is not
    // a WebRTC audio codec), but can leave video untouched. The combined
    // ffmpeg chain handles both cases — ffmpeg is smart enough to copy
    // video when the filter keeps the same codec.
    const detectedCodec = await detectCodec();
    const webrtcStreamName = `${go2rtcName}/webrtc`;
    const webrtcInputUrl = `rtsp://127.0.0.1:${go2rtcRtspPortForSources}/${go2rtcName}`;
    const webrtcVideoFilter =
      detectedCodec === "H.264" ? "video=copy" : "video=h264";
    const webrtcSource = `ffmpeg:${webrtcInputUrl}#${webrtcVideoFilter}#audio=opus`;
    await go2rtcMgr!.addStream(webrtcStreamName, webrtcSource);
    logger.info(
      `Go2rtc WebRTC companion stream registered: ${webrtcStreamName} → ${webrtcSource} ` +
      `(detected codec: ${detectedCodec ?? "unknown"})`,
    );

    info.status = "running";
    info.mode = "go2rtc";
    info.go2rtcStreamName = go2rtcName;
    info.go2rtcWebrtcStreamName = webrtcStreamName;
    info.go2rtcSourceUrl = tcpSourceUrl;
    info.port = port;
    info.startedAt = new Date();

    const go2rtcRtspPort = Number(process.env.GO2RTC_RTSP_PORT) || (settings.go2rtc?.rtspPort ?? 18554);
    info.rtspUrl = `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`;

    rtspServers.set(streamKey, { server, info, go2rtcStreamName: go2rtcName });

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
    // Deregister both the primary and the WebRTC companion streams from go2rtc
    // (only when running in go2rtc mode).
    if (entry.info.mode === "go2rtc" && entry.go2rtcStreamName) {
      const go2rtcMgr = getGo2rtcManager();
      if (go2rtcMgr?.isRunning) {
        await go2rtcMgr.removeStream(entry.go2rtcStreamName).catch(() => {});
        const webrtcName = entry.info.go2rtcWebrtcStreamName;
        if (webrtcName) {
          await go2rtcMgr.removeStream(webrtcName).catch(() => {});
        }
      }
    }

    if (entry.server) {
      logger.info(
        entry.info.mode === "local"
          ? "Stopping BaichuanRtspServer (local)"
          : "Stopping Go2rtc TCP server",
      );
      // In local (mux) mode, unregister the path BEFORE stopping the
      // server so any new connection that races the teardown is rejected
      // with a clean 404 instead of being handed to a stopped server.
      if (entry.info.mode === "local" && entry.info.path) {
        const mux = getLocalRtspMux();
        mux?.unregister(entry.info.path);
      }
      await entry.server.stop();
    }
    entry.info.status = "stopped";
    entry.info.rtspUrl = undefined;
    entry.info.startedAt = undefined;
    entry.info.go2rtcStreamName = undefined;
    entry.info.go2rtcWebrtcStreamName = undefined;
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
): Go2rtcTcpServer | BaichuanRtspServer | undefined {
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
  if (streams.length === 0 && (camera.rtspEnabled || isBatteryCamera(camera))) {
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

// --- Reconnect watchdog ---
// Periodically scan autoStart cameras whose API connection has dropped
// (WiFi loss, scheduled reboot, transient network failure) and re-attempt
// the connection with exponential backoff. The onApiConnected listener
// (enableAutoStreamsOnConnect) restarts streams once the connection is
// re-established, so RTSP recordings resume without manual intervention.

interface ReconnectState {
  attempts: number;
  lastAttempt: number;
}
const reconnectState = new Map<string, ReconnectState>();
const RECONNECT_CHECK_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

function nextReconnectDelay(attempts: number): number {
  const delay = RECONNECT_INITIAL_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
}

let reconnectInterval: NodeJS.Timeout | undefined;

async function runReconnectCheck(): Promise<void> {
  const config = getConfig();
  const logger = createSourceLogger("reconnect-watchdog");
  const seenKeys = new Set<string>();

  for (const camera of config.cameras) {
    if (camera.autoStart !== true) continue;
    // Battery cameras have their own wake-on-demand lifecycle (idle disconnect)
    if (isBatteryCamera(camera)) continue;
    // NVR child explicitly disabled by user
    if (camera.nvrId && disabledNvrCameras.has(camera.id)) continue;

    const connKey = getConnectionKey(camera.id);
    if (seenKeys.has(connKey)) continue;
    seenKeys.add(connKey);

    const existing = apiConnections.get(connKey);
    if (existing?.api?.isReady) {
      reconnectState.delete(connKey);
      continue;
    }
    if (existing?.connectPromise) continue;

    const state = reconnectState.get(connKey) ?? { attempts: 0, lastAttempt: 0 };
    const now = Date.now();
    if (state.lastAttempt > 0 && now - state.lastAttempt < nextReconnectDelay(state.attempts)) {
      continue;
    }

    state.attempts += 1;
    state.lastAttempt = now;
    reconnectState.set(connKey, state);

    logger.info(
      `Attempting reconnect for ${camera.name} (attempt ${state.attempts})`,
    );
    try {
      if (camera.nvrId) {
        await enableNvrCamera(camera.id);
      } else {
        await getOrCreateApiConnection(camera.id);
      }
      logger.info(`Reconnect succeeded for ${camera.name}`);
      reconnectState.delete(connKey);
    } catch (e) {
      logger.warn(
        `Reconnect failed for ${camera.name}: ${(e as { message?: string })?.message ?? String(e)}`,
      );
    }
  }
}

export function startReconnectWatchdog(): void {
  if (reconnectInterval) return;
  reconnectInterval = setInterval(() => {
    void runReconnectCheck();
  }, RECONNECT_CHECK_INTERVAL_MS);
}

export function stopReconnectWatchdog(): void {
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
    reconnectInterval = undefined;
  }
  reconnectState.clear();
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

  // Tear down the shared local-mode multiplexer after all streams are
  // stopped. Safe no-op if the mux was never initialized (e.g. go2rtc
  // mode only).
  try {
    await stopLocalRtspMux();
  } catch (error) {
    logger.error(`Error stopping LocalRtspMux: ${error}`);
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
  if (!isBatteryCamera(camera)) {
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
  const restreamerMode = getSettings().restreamer ?? "go2rtc";

  // In go2rtc mode we must wait for the sidecar; in local mode the library
  // binds the RTSP port directly and has no external dependency.
  if (restreamerMode === "go2rtc" && !go2rtcMgr?.isRunning) {
    return;
  }

  const config = getConfig();
  for (const camera of config.cameras) {
    if (camera.nvrId && disabledNvrCameras.has(camera.id)) continue;

    // Skip battery cameras in streamOnly+go2rtc mode: go2rtc reconnects
    // every ~60s, continuously waking the camera and draining the battery.
    // In local mode the BaichuanRtspServer handles wakeup on-demand via
    // lazyMetadata — we must register the mux path now so it exists.
    if (isBatteryCamera(camera) && (camera.batteryMode ?? "streamOnly") === "streamOnly" && restreamerMode !== "local") {
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
    const restreamerMode = getSettings().restreamer ?? "go2rtc";

    // Only go2rtc mode depends on the sidecar process — local mode owns
    // the RTSP port itself and can start streams immediately.
    if (restreamerMode === "go2rtc" && !go2rtcMgr?.isRunning) {
      logger.debug(
        `Defer auto-streams for camera ${cameraId}: go2rtc not running yet`,
      );
      return;
    }

    if (disabledNvrCameras.has(cameraId)) return;

    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);
    if (!camera) return;

    // Skip battery cameras in streamOnly mode when using go2rtc: go2rtc
    // reconnects every ~60s even with no viewer, which continuously wakes
    // the camera and drains the battery.  In local mode the BaichuanRtspServer
    // handles on-demand wakeup via lazyMetadata — registering the mux path
    // upfront is safe (and required so the path exists before any client connects).
    if (isBatteryCamera(camera) && (camera.batteryMode ?? "streamOnly") === "streamOnly" && restreamerMode !== "local") {
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
