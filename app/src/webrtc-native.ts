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
import { getConfig } from "./settings-store.js";

const logger = createSourceLogger("webrtc-native");

// ============================================================================
// Types
// ============================================================================

interface WebRTCCameraSession {
  cameraId: string;
  profile: "main" | "sub" | "ext";
  server: BaichuanWebRTCServer;
  sessionId: string;
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

  // Get channel from rtspChannel config or default to 0
  const channel = camera.rtspChannel ?? 0;

  // Create WebRTC server for this session
  const server = new BaichuanWebRTCServer({
    api,
    channel,
    profile,
    enableIntercom,
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
    activeSessions.delete(sessionId);
  });

  server.on("intercom-started", ({ sessionId }: { sessionId: string }) => {
    logger.info(`Intercom started for session ${sessionId}`);
  });

  server.on("intercom-stopped", ({ sessionId }: { sessionId: string }) => {
    logger.info(`Intercom stopped for session ${sessionId}`);
  });

  // Create session
  const { sessionId, offer } = await server.createSession();

  // Store session info
  activeSessions.set(sessionId, {
    cameraId: camera.id,
    profile,
    server,
    sessionId,
  });

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
  activeSessions.delete(sessionId);
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
