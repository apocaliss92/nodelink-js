import {
  ReolinkBaichuanApi,
  BaichuanRtspServer,
} from "@apocaliss92/nodelink-js";
import { createBaichuanApi } from "./baichuan-api-factory.js";
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
import { isBatteryCamera } from "./camera-traits.js";
import {
  getLocalRtspMux,
  initLocalRtspMux,
  stopLocalRtspMux,
} from "./local-rtsp-mux.js";
import * as net from "net";
import * as crypto from "crypto";
import { releaseStreamsByCamera } from "./stream-pool.js";
import { sanitizeCameraName } from "./camera-name.js";


// ---------------------------------------------------------------------------
// Helper: sanitize camera name for URL path (Camera Studio => camera_studio).
// Defined in the pure ./camera-name module; re-exported here so existing
// importers keep working unchanged.
export { sanitizeCameraName };

// Helper: generate random token for RTSP path
export function generateStreamToken(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Build the URL path component for a camera stream, e.g.
 * `camera_studio/main` or `camera_studio/main/2` for NVR child channel 2.
 * Used both for the LocalRtspMux path and for any external integration
 * (Frigate config emitter) that references the manager's RTSP endpoint.
 */
export function buildStreamName(
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
  const port = Number(process.env.RTSP_PORT) || settings.localRtsp?.port || 8554;
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
 * BaichuanRtspServer may bind 127.0.0.1 in some paths — checking only 0.0.0.0
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
  /** Always "local" — kept as a literal so consumers branching on it still compile. */
  mode?: "local";
}

export interface CameraInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  status: "connected" | "disconnected" | "error";
  /** Parent NVR id if this camera is an NVR child — used by the grid's
   * "Group by parent" sort and the NvrSettingsModal channels tab. */
  nvrId?: string;
  /** User-defined position for the "Custom" sort mode. Sourced from
   * `CameraConfig.position` written by `cameras.reorder`. */
  position?: number;
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

// Store for RTSP servers. Every camera stream is now served via a
// BaichuanRtspServer plugged into LocalRtspMux.
const rtspServers = new Map<
  string,
  {
    server: BaichuanRtspServer;
    info: RtspServerInfo;
  }
>();

// Store for camera info cache
const cameraInfoCache = new Map<string, CameraInfo>();

// NVR per-camera disabled set: cameras in this set are "disconnected" from restreaming
// but the NVR shared socket stays alive. When a user "connects" an NVR child,
// it's removed from this set and becomes visible for restreaming.
const disabledNvrCameras = new Set<string>();

// Standalone cameras the user has explicitly disconnected. Mirrors
// `disabledNvrCameras` for non-NVR cameras: the reconnect watchdog and the
// auto-stream-on-connect listener skip cameras in this set, so a manual
// disconnect "sticks" instead of being undone by the autoStart reconnect loop.
// An explicit user "connect" clears it. In-memory only (resets on restart),
// matching `disabledNvrCameras`.
const manuallyDisconnected = new Set<string>();

/** Mark a standalone camera as user-disconnected so it is not auto-reconnected. */
export function markManuallyDisconnected(cameraId: string): void {
  manuallyDisconnected.add(cameraId);
}

/** Clear the user-disconnected flag (e.g. on an explicit connect). */
export function clearManuallyDisconnected(cameraId: string): void {
  manuallyDisconnected.delete(cameraId);
}

/** Whether the user has explicitly disconnected this camera. */
export function isManuallyDisconnected(cameraId: string): boolean {
  return manuallyDisconnected.has(cameraId);
}

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
      // the next RTSP / WebRTC preview client can reconnect and wake the
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

    // Don't wait up to {@link RECONNECT_CHECK_INTERVAL_MS} (30s) for the
    // watchdog tick — kick a reconnect immediately. Without this, every
    // transient EPIPE/network blip produces a 30s window of 404s on the
    // mux for any client mid-DESCRIBE. Frigate's ffmpeg watchdog reads
    // that as "stream gone", kills the process, and enters a slow
    // exponential restart loop from which it recovers minutes later (or
    // not at all). See nodelink-js#34. The fire-and-forget here is
    // deliberate: `triggerImmediateReconnect` re-uses the watchdog's
    // `reconnectState` map so concurrent attempts collapse onto a single
    // in-flight connect and exponential backoff is preserved.
    for (const camId of affectedIds) {
      setImmediate(() => {
        void triggerImmediateReconnect(camId);
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

    const api = createBaichuanApi({
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
      // Auto-bridge SMTP email-push into this api's onSimpleEvent
      // stream — the manager's EmailPushServer dispatches events on
      // the global bus keyed by `camera.id` (the same value used as
      // the recipient local-part `cam-<camera.id>@<domain>`), so
      // events-manager and ha-mqtt receive native + SMTP motion
      // through `api.onSimpleEvent` uniformly without each needing
      // its own global bus subscription. Skipped for NVR connections
      // (the parent NVR owns the mail path, channels share its bus).
      ...(!isNvrConnection
        ? {
            emailPushCameraId: camera.id,
            emailPushChannel: camera.rtspChannel ?? 0,
          }
        : {}),
      logger: {
        log: (msg: unknown) => cameraLogger.info(String(msg)),
        info: (msg: string) => cameraLogger.info(msg),
        warn: (msg: string) => cameraLogger.warn(msg),
        error: (msg: string) => cameraLogger.error(msg),
        debug: (msg: string) => cameraLogger.debug(msg),
      },
    }, { source: "rtsp-manager", cameraId: camera.id });

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

/**
 * Get the live shared API connection for an NVR addressed directly by its id
 * (device-global commands), if one is already established. Mirrors
 * getExistingApiConnection but keyed by the `nvr:<nvrId>` shared-socket key.
 */
export function getExistingNvrApiConnection(
  nvrId: string,
): ReolinkBaichuanApi | undefined {
  const conn = apiConnections.get(`nvr:${nvrId}`);
  if (!conn || !conn.api || conn.api.isClosed) return undefined;
  return conn.api;
}

// Get all cameras info
export function getAllCamerasInfo(): CameraInfo[] {
  const config = getConfig();
  return config.cameras.map((camera) => {
    const cached = cameraInfoCache.get(camera.id);

    // Lookup-and-augment fields that live in config (not in the runtime
    // cache) — position + nvrId. The cache may pre-date the latest config
    // reorder so we always read the live values here.
    const augment = {
      ...(camera.nvrId !== undefined ? { nvrId: camera.nvrId } : {}),
      ...(camera.position !== undefined ? { position: camera.position } : {}),
    };

    // NVR children that are disabled show as disconnected even if the NVR socket is alive
    if (cached && disabledNvrCameras.has(camera.id)) {
      return { ...cached, status: "disconnected" as const, ...augment };
    }

    if (cached) return { ...cached, ...augment };

    return {
      id: camera.id,
      name: camera.name,
      host: camera.host,
      port: camera.port,
      status: "disconnected" as const,
      ...augment,
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

  // Start RTSP streams for this camera (the onApiConnected listener won't
  // fire because the NVR socket was already connected — trigger manually).
  const channel = camera.rtspChannel ?? 0;
  const profiles = await getAvailableProfiles(cameraId);
  for (const profile of profiles) {
    const sk = getRtspServerKey(cameraId, profile, channel);
    if (rtspServers.get(sk)?.info.status === "running") continue;
    startRtspServer(cameraId, { profile, channel }).catch(() => {});
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
  // RTSP registration) keep the stream alive forever and the camera
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

  // Find saved stream config to get previously used port (kept for
  // backward-compat — port is now always the mux port).
  const savedStreamConfig = camera.rtspStreams?.find(
    (s) => s.profile === profile && s.channel === channel,
  );

  // Every stream shares the single LocalRtspMux port. No per-stream
  // allocation, no port-availability probing — the mux reads the first
  // request line and dispatches by path.
  const port = Number(process.env.RTSP_PORT) || settings.localRtsp?.port || 8554;

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

    const rtspLogger = {
      log: (msg: unknown) => logger.info(String(msg)),
      info: (msg: string) => logger.info(msg),
      warn: (msg: string) => logger.warn(msg),
      error: (msg: string) => logger.error(msg),
      debug: (msg: string) => logger.debug(msg),
    };

    const serviceIp = settings.serviceIp || "localhost";

    // Single-port LocalRtspMux + BaichuanRtspServer in mux mode. The mux
    // owns the listening socket and routes each RTSP connection to the
    // correct per-stream server by URL path. WebRTC for the in-browser
    // preview is served separately via `webrtc-native` (werift in-process).
    const mux = await ensureLocalRtspMux();
    const muxPort = mux.listenPort;
    const muxBindHost = mux.listenHost;
    const localPath = `/${buildStreamName(camera.name, profile, channel)}`;

    logger.info(
      `Registering BaichuanRtspServer on ${muxBindHost}:${muxPort}${localPath} (${profile}, ch${channel})`,
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

    // Permanent (continuous) stream. Honored whenever permanentStream.enabled
    // is set — the UI only exposes the toggle for battery cameras, so we don't
    // re-gate on transport here (battery cams may run transport="auto", with
    // battery detected at runtime rather than via transport="udp").
    // Maps windowSeconds → windowMs and only includes explicitly-set fields
    // to respect exactOptionalPropertyTypes.
    const ps = camera.permanentStream;
    const alwaysOn =
      ps?.enabled
        ? {
            enabled: true,
            ...(ps.triggers !== undefined && ps.triggers.length > 0
              ? { triggers: ps.triggers }
              : {}),
            ...(ps.windowSeconds !== undefined
              ? { windowMs: ps.windowSeconds * 1000 }
              : {}),
            ...(ps.idleFps !== undefined ? { idleFps: ps.idleFps } : {}),
            ...(ps.placeholderEnabled !== undefined ||
            ps.placeholderText !== undefined ||
            ps.placeholderOpacity !== undefined
              ? {
                  placeholder: {
                    ...(ps.placeholderEnabled !== undefined
                      ? { enabled: ps.placeholderEnabled }
                      : {}),
                    ...(ps.placeholderText !== undefined
                      ? { text: ps.placeholderText }
                      : {}),
                    ...(ps.placeholderOpacity !== undefined
                      ? { opacity: ps.placeholderOpacity }
                      : {}),
                  },
                }
              : {}),
          }
        : undefined;
    if (alwaysOn) {
      logger.info(
        `Permanent stream enabled (windowMs=${alwaysOn.windowMs ?? "default"}, idleFps=${alwaysOn.idleFps ?? "default"})`,
      );
    }

    const baichuanServer = new BaichuanRtspServer({
      api,
      channel,
      profile,
      ...(alwaysOn ? { alwaysOn } : {}),
      // listenHost/listenPort are informational in mux mode — the server
      // never binds them. They are still passed so SDP/logs reflect the
      // public endpoint users will dial.
      listenHost: muxBindHost,
      listenPort: muxPort,
      path: localPath,
      logger: rtspLogger,
      deviceId: cameraId,
      requireAuth: requireAuthSetting && credentials.length > 0,
      credentials,
      authRealm: RTSP_DIGEST_REALM,
      muxMode: true,
      lazyMetadata: true,
      nativeStreamIdleStopMs:
        rtspNativeIdleOpts.nativeStreamIdleStopMs > 0
          ? rtspNativeIdleOpts.nativeStreamIdleStopMs
          : 30_000,
      videoPrimingMs: {
        tcp: settings.localRtsp.priming.videoTcpMs,
        udp: settings.localRtsp.priming.videoUdpMs,
      },
      audioPrimingMs: {
        tcp: settings.localRtsp.priming.audioTcpMs,
        udp: settings.localRtsp.priming.audioUdpMs,
      },
    });

    await baichuanServer.start();
    mux.register(localPath, baichuanServer);

    info.status = "running";
    info.mode = "local";
    info.port = muxPort;
    info.startedAt = new Date();
    info.rtspUrl = `rtsp://${serviceIp}:${muxPort}${localPath}`;

    rtspServers.set(streamKey, { server: baichuanServer, info });
    logger.info(`RTSP: ${info.rtspUrl}`);

    upsertCameraStream(cameraId, {
      profile,
      channel,
      port: muxPort,
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
    if (entry.server) {
      logger.info("Stopping BaichuanRtspServer");
      // Unregister the mux path BEFORE stopping the server so any new
      // connection that races the teardown is rejected with a clean 404
      // instead of being handed to a stopped server.
      if (entry.info.path) {
        const mux = getLocalRtspMux();
        mux?.unregister(entry.info.path);
      }
      await entry.server.stop();
    }
    entry.info.status = "stopped";
    entry.info.rtspUrl = undefined;
    entry.info.startedAt = undefined;

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
): BaichuanRtspServer | undefined {
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
    // Standalone camera explicitly disconnected by user
    if (manuallyDisconnected.has(camera.id)) continue;

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

/**
 * Trigger a reconnect attempt for a single camera as soon as it disconnects,
 * instead of waiting up to {@link RECONNECT_CHECK_INTERVAL_MS} for the next
 * watchdog tick. Called from `attachConnectionListeners`' close handler.
 *
 * Idempotent: if a reconnect is already in flight (via watchdog OR a previous
 * immediate-reconnect that hasn't resolved yet), this no-ops. Re-uses
 * `reconnectState` so the exponential backoff window applies uniformly across
 * watchdog ticks and immediate triggers — if the camera is hard-down (camera
 * power off, network split-brain), repeated EPIPEs do not produce a tight
 * reconnect loop.
 *
 * Skips:
 *  - cameras without `autoStart: true` (manual-only streams)
 *  - battery cameras (their idle disconnect lifecycle is handled separately)
 *  - NVR child cameras the user has explicitly disabled
 *  - cameras whose config row vanished between disconnect and this call
 */
export async function triggerImmediateReconnect(cameraId: string): Promise<void> {
  const cfg = getConfig();
  const camera = cfg.cameras.find((c) => c.id === cameraId);
  if (!camera) return;
  if (camera.autoStart !== true) return;
  if (isBatteryCamera(camera)) return;
  if (camera.nvrId && disabledNvrCameras.has(cameraId)) return;
  // User explicitly disconnected this standalone camera — don't auto-reconnect
  // on the close event that the disconnect itself produced.
  if (manuallyDisconnected.has(cameraId)) return;

  const connKey = getConnectionKey(cameraId);

  // Watchdog or another close handler may already be reconnecting this
  // connKey — collapse onto its in-flight promise so we don't queue a
  // second login attempt against the camera.
  const existing = apiConnections.get(connKey);
  if (existing?.api?.isReady) return;
  if (existing?.connectPromise) return;

  // Respect the backoff window so repeated EPIPEs from a hard-down camera
  // don't bypass the exponential retry schedule.
  const state = reconnectState.get(connKey) ?? { attempts: 0, lastAttempt: 0 };
  const now = Date.now();
  if (
    state.lastAttempt > 0 &&
    now - state.lastAttempt < nextReconnectDelay(state.attempts)
  ) {
    return;
  }
  state.attempts += 1;
  state.lastAttempt = now;
  reconnectState.set(connKey, state);

  const logger = createSourceLogger("reconnect-watchdog");
  logger.info(
    `Immediate reconnect for ${camera.name} (post-close, attempt ${state.attempts})`,
  );
  try {
    if (camera.nvrId) {
      await enableNvrCamera(cameraId);
    } else {
      await getOrCreateApiConnection(cameraId);
    }
    logger.info(`Immediate reconnect succeeded for ${camera.name}`);
    reconnectState.delete(connKey);
  } catch (e) {
    logger.warn(
      `Immediate reconnect failed for ${camera.name}: ${(e as { message?: string })?.message ?? String(e)} — watchdog will retry`,
    );
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

  // Tear down the shared multiplexer after all streams are stopped.
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

  const api = createBaichuanApi(
    {
      host,
      port,
      username,
      password,
    },
    { source: "test-camera-connection" },
  );

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
 * Start all stream profiles for cameras that already have a live Baichuan
 * connection. Used at boot after the LocalRtspMux is up.
 */
export async function startStreamsForAllConnectedCameras(): Promise<void> {
  const logger = createSourceLogger("auto-streams");

  const config = getConfig();
  for (const camera of config.cameras) {
    if (camera.nvrId && disabledNvrCameras.has(camera.id)) continue;

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
    if (disabledNvrCameras.has(cameraId)) return;
    if (manuallyDisconnected.has(cameraId)) return;

    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);
    if (!camera) return;

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
