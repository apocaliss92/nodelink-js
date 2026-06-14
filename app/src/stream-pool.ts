/**
 * Shared Stream Pool
 *
 * Manages a single createRfc4571TcpServer per camera:profile, shared across
 * all output formats (MJPEG, HLS, WebRTC, RTSP). This minimizes the number
 * of concurrent streaming sessions on the camera.
 *
 * Consumers register/unregister via addConsumer/removeConsumer. When no
 * consumers remain after an idle grace period, the stream is torn down.
 */

import {
  createRfc4571TcpServer,
  type Rfc4571TcpServer,
  type BaichuanVideoStream,
} from "@apocaliss92/nodelink-js";
import type { StreamProfile } from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import { getOrCreateApiConnection } from "./rtsp-manager.js";
import { getConfig } from "./settings-store.js";
import { buildAlwaysOnOptions } from "./permanent-stream.js";

const logger = createSourceLogger("stream-pool");

// ============================================================================
// Types
// ============================================================================

export type ConsumerType = "mjpeg" | "hls" | "webrtc" | "rtsp" | "external";

interface StreamConsumer {
  id: string;
  type: ConsumerType;
  /** Called when the shared stream is being torn down (error/idle/shutdown). */
  onTeardown?: () => void;
}

export interface SharedStream {
  key: string;
  cameraId: string;
  profile: StreamProfile;
  channel: number;
  rfc: Rfc4571TcpServer;
  videoStream: BaichuanVideoStream;
  consumers: Map<string, StreamConsumer>;
  createdAt: number;
  /** Timer for idle teardown (set when consumers reach 0). */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ============================================================================
// Configuration
// ============================================================================

/** Grace period before tearing down a stream with no consumers. */
const IDLE_TEARDOWN_MS = 15_000;

// ============================================================================
// State
// ============================================================================

const pool = new Map<string, SharedStream>();
/** In-flight creation promises to prevent duplicate concurrent creates. */
const creating = new Map<string, Promise<SharedStream>>();

// ============================================================================
// Helpers
// ============================================================================

function streamKey(cameraId: string, profile: StreamProfile): string {
  return `${cameraId}:${profile}`;
}

// ============================================================================
// Core
// ============================================================================

/**
 * Get or create a shared stream for a camera:profile.
 * The returned SharedStream has a `videoStream` that emits `videoAccessUnit`
 * and `audioFrame` events consumable by multiple listeners simultaneously.
 */
export async function acquireStream(
  cameraId: string,
  profile: StreamProfile,
): Promise<SharedStream> {
  const key = streamKey(cameraId, profile);

  // Return existing active stream.
  const existing = pool.get(key);
  if (existing) {
    // Cancel idle teardown if it was pending.
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    return existing;
  }

  // Deduplicate concurrent creation requests.
  const inflight = creating.get(key);
  if (inflight) return inflight;

  const promise = createSharedStream(cameraId, profile, key);
  creating.set(key, promise);
  try {
    const stream = await promise;
    return stream;
  } finally {
    creating.delete(key);
  }
}

async function createSharedStream(
  cameraId: string,
  profile: StreamProfile,
  key: string,
): Promise<SharedStream> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) throw new Error(`Camera not found: ${cameraId}`);

  const channel = camera.rtspChannel ?? 0;
  const api = await getOrCreateApiConnection(cameraId);

  logger.info(`Creating shared stream for ${camera.name}/${profile} (ch${channel})`);

  const streamLogger = createSourceLogger(`stream-pool:${camera.name}:${profile}`);

  // Always-on (continuous/placeholder) comes from the unified Manager config,
  // applied once here so every consumer of this shared source inherits it.
  const alwaysOn = buildAlwaysOnOptions(camera);
  if (alwaysOn) {
    logger.info(`Shared stream ${key}: always-on enabled (from permanentStream settings)`);
  }

  const rfc = await createRfc4571TcpServer({
    api,
    channel,
    profile,
    deviceId: cameraId,
    ...(alwaysOn ? { alwaysOn } : {}),
    host: "127.0.0.1",
    username: "pool",
    password: `pool-${Date.now()}`,
    requireAuth: false,
    closeApiOnTeardown: false,
    idleTeardownMs: 0, // Pool manages lifecycle, not the RFC server.
    uptimeRestartMs: 10_000,
    logger: {
      log: (msg: unknown) => streamLogger.info(String(msg)),
      info: (msg: string) => streamLogger.info(msg),
      warn: (msg: string) => streamLogger.warn(msg),
      error: (msg: string) => streamLogger.error(msg),
      debug: (msg: string) => streamLogger.debug(msg),
    } as Console,
  });

  const videoStream = rfc.videoStream as BaichuanVideoStream;

  const shared: SharedStream = {
    key,
    cameraId,
    profile,
    channel,
    rfc,
    videoStream,
    consumers: new Map(),
    createdAt: Date.now(),
    idleTimer: null,
  };

  // Handle stream errors/close: tear down and notify consumers.
  const onStreamEnd = (reason: string) => {
    logger.warn(`Shared stream ${key} ended: ${reason}`);
    teardownStream(key);
  };

  videoStream.on("error", (err: Error) => onStreamEnd(`error: ${err.message}`));
  videoStream.on("close", () => onStreamEnd("close"));

  pool.set(key, shared);
  logger.info(`Shared stream ${key} ready (port=${rfc.port}, video=${rfc.videoType})`);

  return shared;
}

// ============================================================================
// Consumer management
// ============================================================================

/**
 * Register a consumer on a shared stream.
 * @returns A release function to call when the consumer is done.
 */
export function addConsumer(
  shared: SharedStream,
  consumerId: string,
  type: ConsumerType,
  onTeardown?: () => void,
): () => void {
  // Cancel idle teardown.
  if (shared.idleTimer) {
    clearTimeout(shared.idleTimer);
    shared.idleTimer = null;
  }

  shared.consumers.set(consumerId, { id: consumerId, type, onTeardown });
  logger.debug(
    `Consumer ${consumerId} (${type}) added to ${shared.key} (total: ${shared.consumers.size})`,
  );

  // Return a release function.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeConsumer(shared.key, consumerId);
  };
}

function removeConsumer(key: string, consumerId: string): void {
  const shared = pool.get(key);
  if (!shared) return;

  shared.consumers.delete(consumerId);
  logger.debug(
    `Consumer ${consumerId} removed from ${key} (remaining: ${shared.consumers.size})`,
  );

  // Start idle teardown if no consumers remain.
  if (shared.consumers.size === 0 && !shared.idleTimer) {
    shared.idleTimer = setTimeout(() => {
      if (shared.consumers.size === 0) {
        logger.info(`Idle teardown for shared stream ${key}`);
        teardownStream(key);
      }
    }, IDLE_TEARDOWN_MS);
  }
}

// ============================================================================
// Teardown
// ============================================================================

function teardownStream(key: string): void {
  const shared = pool.get(key);
  if (!shared) return;

  pool.delete(key);

  if (shared.idleTimer) {
    clearTimeout(shared.idleTimer);
    shared.idleTimer = null;
  }

  // Notify all consumers.
  for (const consumer of shared.consumers.values()) {
    try {
      consumer.onTeardown?.();
    } catch {
      // ignore
    }
  }
  shared.consumers.clear();

  // Close the RFC server (async, best-effort).
  shared.rfc.close("stream-pool teardown").catch((err) => {
    logger.warn(`Error closing shared stream ${key}: ${err}`);
  });

  logger.info(`Shared stream ${key} torn down`);
}

// ============================================================================
// Public lifecycle
// ============================================================================

/**
 * Release all shared streams for a specific camera (e.g. on disconnect).
 */
export function releaseStreamsByCamera(cameraId: string): void {
  for (const [key, shared] of pool) {
    if (shared.cameraId === cameraId) {
      logger.info(`Releasing shared stream ${key} (camera disconnected)`);
      teardownStream(key);
    }
  }
}

/**
 * Release all shared streams (graceful shutdown).
 */
export async function releaseAllStreams(): Promise<void> {
  const keys = Array.from(pool.keys());
  for (const key of keys) {
    teardownStream(key);
  }
  logger.info(`All shared streams released (${keys.length})`);
}

/**
 * Get status of all active shared streams.
 */
export function getStreamPoolStatus(): Array<{
  key: string;
  cameraId: string;
  profile: StreamProfile;
  consumers: number;
  consumerTypes: ConsumerType[];
  videoType: string;
  port: number;
  uptimeMs: number;
}> {
  const out: Array<{
    key: string;
    cameraId: string;
    profile: StreamProfile;
    consumers: number;
    consumerTypes: ConsumerType[];
    videoType: string;
    port: number;
    uptimeMs: number;
  }> = [];

  for (const [, shared] of pool) {
    out.push({
      key: shared.key,
      cameraId: shared.cameraId,
      profile: shared.profile,
      consumers: shared.consumers.size,
      consumerTypes: Array.from(shared.consumers.values()).map((c) => c.type),
      videoType: shared.rfc.videoType,
      port: shared.rfc.port,
      uptimeMs: Date.now() - shared.createdAt,
    });
  }

  return out;
}
