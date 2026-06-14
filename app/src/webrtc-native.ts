/**
 * WebRTC Native Manager
 *
 * Manages WebRTC sessions using the BaichuanWebRTCServer from the library.
 * Handles multiple cameras and sessions with automatic cleanup.
 */

import {
  BaichuanWebRTCServer,
  type WebRTCOffer,
  type WebRTCAnswer,
  type WebRTCIceCandidate,
  type WebRTCSessionInfo,
} from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import {
  getOrCreateApiConnection,
  getCameraInfo,
  sanitizeCameraName,
} from "./rtsp-manager.js";
import { getConfig, getSettings } from "./settings-store.js";
import { emitStreamClientsChanged } from "./events-manager.js";
import { acquireStream, addConsumer } from "./stream-pool.js";

const logger = createSourceLogger("webrtc-native");

function parsePortRange(
  value: string | undefined,
): [number, number] | undefined {
  if (!value) return undefined;
  const m = value.trim().match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (!m) return undefined;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (min <= 0 || max <= 0 || min >= max) return undefined;
  return [min, max];
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const out = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

// ============================================================================
// Types
// ============================================================================

interface WebRTCCameraSession {
  cameraId: string;
  profile: "main" | "sub" | "ext";
  server: BaichuanWebRTCServer;
  sessionId: string;
  /** Release the shared-pool consumer registration for this session. */
  releaseConsumer?: () => void;
}

// ============================================================================
// State
// ============================================================================

// Map of sessionId -> camera session info
const activeSessions = new Map<string, WebRTCCameraSession>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a new WebRTC session for a camera
 */
export async function createWebRTCSession(
  cameraId: string,
  profile: "main" | "sub" | "ext",
  enableIntercom: boolean = false,
): Promise<{ sessionId: string; offer: WebRTCOffer }> {
  // Find camera by ID or sanitized name
  const config = getConfig();
  const camera = config.cameras.find(
    (c) => c.id === cameraId || sanitizeCameraName(c.name) === cameraId,
  );

  if (!camera) {
    throw new Error(`Camera ${cameraId} not found`);
  }

  // Check if camera is connected
  const camInfo = getCameraInfo(camera.id);
  if (!camInfo || camInfo.status !== "connected") {
    throw new Error(`Camera ${camera.id} is not connected`);
  }

  // Get API connection
  const api = await getOrCreateApiConnection(camera.id);
  if (!api) {
    throw new Error(`Failed to get API connection for camera ${camera.id}`);
  }

  logger.info(
    `Creating WebRTC session for ${camera.name}/${profile} (intercom: ${enableIntercom})`,
  );

  // Evict any existing session for the same (camera, profile). The camera
  // rejects a second <Preview> on the same channel with response_code 430
  // while the previous dedicated socket is still open, so we wait for the
  // old session to finish closing before we ask for the next one. This
  // happens whenever the browser re-mounts the player (React StrictMode in
  // dev, or a rapid Stop→Start click) without an explicit close in between.
  const stale = [...activeSessions.values()].filter(
    (s) => s.cameraId === camera.id && s.profile === profile,
  );
  if (stale.length > 0) {
    logger.info(
      `Evicting ${stale.length} stale WebRTC session(s) for ${camera.name}/${profile} before opening a new one`,
    );
    await Promise.allSettled(
      stale.map(async (s) => {
        try {
          await s.server.closeSession(s.sessionId);
        } catch (e) {
          logger.warn(
            `Eviction closeSession failed for ${s.sessionId}: ${(e as Error).message}`,
          );
        }
        try {
          await s.server.stop();
        } catch { /* noop */ }
        s.releaseConsumer?.();
        activeSessions.delete(s.sessionId);
      }),
    );
    // Brief grace period so the underlying BaichuanClient dedicated socket
    // fully releases inside the library's socket pool before we ask for it
    // again. 200 ms is enough on the cameras we've tested.
    await new Promise((r) => setTimeout(r, 200));
  }

  // Get channel from rtspChannel config or default to 0
  const channel = camera.rtspChannel ?? 0;

  // Acquire the single shared source for this camera:profile. Every output
  // format (RTSP, WebRTC, …) consumes this same stream so the camera only ever
  // has one native session, and always-on behavior is applied once at the pool.
  const shared = await acquireStream(camera.id, profile);

  // Create WebRTC server for this session
  const settings = getSettings();
  const icePortRange = parsePortRange(settings.webrtc?.icePortRange);
  const iceAdditionalHostAddresses = parseCsv(
    settings.webrtc?.iceAdditionalHostAddresses,
  );

  const server = new BaichuanWebRTCServer({
    api,
    channel,
    profile,
    externalVideoStream: shared.videoStream,
    enableIntercom,
    icePortRange,
    iceAdditionalHostAddresses,
    logger: (level: "debug" | "info" | "warn" | "error", message: string) => {
      logger[level](message);
    },
  });

  // Setup event handlers
  server.on("session-connected", ({ sessionId }: { sessionId: string }) => {
    logger.info(`WebRTC session ${sessionId} connected`);
  });

  server.on("session-closed", ({ sessionId }: { sessionId: string }) => {
    logger.info(`WebRTC session ${sessionId} closed`);
    const session = activeSessions.get(sessionId);
    session?.releaseConsumer?.();
    activeSessions.delete(sessionId);
    if (session) {
      const count = [...activeSessions.values()].filter(
        (s) => s.cameraId === session.cameraId && s.profile === session.profile,
      ).length;
      emitStreamClientsChanged(session.cameraId, "webrtc", session.profile, count);
    }
  });

  server.on("intercom-started", ({ sessionId }: { sessionId: string }) => {
    logger.info(`Intercom started for session ${sessionId}`);
  });

  server.on("intercom-stopped", ({ sessionId }: { sessionId: string }) => {
    logger.info(`Intercom stopped for session ${sessionId}`);
  });

  // Create session
  const { sessionId, offer } = await server.createSession();

  // Register this session as a consumer of the shared source. If the shared
  // source is torn down (error/idle/shutdown), close this WebRTC session too.
  const releaseConsumer = addConsumer(
    shared,
    `webrtc:${sessionId}`,
    "webrtc",
    () => {
      void closeWebRTCSession(sessionId).catch(() => {});
    },
  );

  // Store session info
  activeSessions.set(sessionId, {
    cameraId: camera.id,
    profile,
    server,
    sessionId,
    releaseConsumer,
  });

  const count = [...activeSessions.values()].filter(
    (s) => s.cameraId === camera.id && s.profile === profile,
  ).length;
  emitStreamClientsChanged(camera.id, "webrtc", profile, count);

  logger.info(
    `WebRTC session ${sessionId} created for ${camera.name}/${profile}`,
  );

  return { sessionId, offer };
}

/**
 * Handle WebRTC answer from browser
 */
export async function handleWebRTCAnswer(
  sessionId: string,
  answer: WebRTCAnswer,
): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  await session.server.handleAnswer(sessionId, answer);
}

/**
 * Add ICE candidate from browser
 */
export async function addIceCandidate(
  sessionId: string,
  candidate: WebRTCIceCandidate,
): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  await session.server.addIceCandidate(sessionId, candidate);
}

/**
 * Close a WebRTC session
 */
export async function closeWebRTCSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    logger.warn(`Session ${sessionId} not found for close`);
    return;
  }

  await session.server.closeSession(sessionId);
  await session.server.stop();
  session.releaseConsumer?.();
  activeSessions.delete(sessionId);
  const count = [...activeSessions.values()].filter(
    (s) => s.cameraId === session.cameraId && s.profile === session.profile,
  ).length;
  emitStreamClientsChanged(session.cameraId, "webrtc", session.profile, count);
}

/**
 * Get status of all WebRTC sessions
 */
export function getWebRTCStatus(): {
  sessions: Array<{
    sessionId: string;
    cameraId: string;
    profile: string;
    state: string;
    createdAt: string;
    stats: WebRTCSessionInfo["stats"];
  }>;
} {
  const sessions: Array<{
    sessionId: string;
    cameraId: string;
    profile: string;
    state: string;
    createdAt: string;
    stats: WebRTCSessionInfo["stats"];
  }> = [];

  for (const [sessionId, session] of activeSessions) {
    const info = session.server.getSession(sessionId);
    if (info) {
      sessions.push({
        sessionId,
        cameraId: session.cameraId,
        profile: session.profile,
        state: info.state,
        createdAt: info.createdAt.toISOString(),
        stats: info.stats,
      });
    }
  }

  return { sessions };
}

/**
 * Stop all WebRTC sessions
 */
export async function stopAllWebRTCSessions(): Promise<void> {
  logger.info(`Stopping all WebRTC sessions (${activeSessions.size} active)`);

  const promises: Promise<void>[] = [];
  for (const [sessionId, session] of activeSessions) {
    session.releaseConsumer?.();
    promises.push(
      session.server
        .stop()
        .catch((err: unknown) =>
          logger.error(`Error stopping session ${sessionId}: ${err}`),
        ),
    );
  }

  await Promise.all(promises);
  activeSessions.clear();

  logger.info("All WebRTC sessions stopped");
}
