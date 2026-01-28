/**
 * HLS Native Manager
 *
 * Manages HLS sessions using the BaichuanHlsServer from the library.
 * Handles multiple cameras and sessions with automatic cleanup.
 */

import {
  BaichuanHlsServer,
  type HlsServerStatus,
} from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import {
  getOrCreateApiConnection,
  sanitizeCameraName,
} from "./rtsp-manager.js";
import { getConfig } from "./settings-store.js";

const logger = createSourceLogger("hls-native");

// ============================================================================
// Types
// ============================================================================

type StreamProfile = "main" | "sub" | "ext";
type ClientKey = string;

interface ActiveHlsStream {
  streamKey: string;
  cameraId: string;
  cameraName: string;
  sanitizedName: string;
  profile: StreamProfile;
  server: BaichuanHlsServer;
  startedAt: number;
  lastAccessAt: number;
  clients: Map<ClientKey, number>; // lastSeen
}

// ============================================================================
// Configuration
// ============================================================================

const STREAM_IDLE_TTL_MS = 20_000;
const CLIENT_TTL_MS = 10_000;

// ============================================================================
// State
// ============================================================================

const activeStreams = new Map<string, ActiveHlsStream>();

// ============================================================================
// Utility Functions
// ============================================================================

function getStreamKey(cameraId: string, profile: StreamProfile): string {
  return `${cameraId}:${profile}`;
}

function now(): number {
  return Date.now();
}

function cleanupClients(stream: ActiveHlsStream): void {
  const t = now();
  for (const [k, last] of stream.clients) {
    if (t - last > CLIENT_TTL_MS) stream.clients.delete(k);
  }
}

function ensureCleanupLoop(): void {
  if ((ensureCleanupLoop as any)._started) return;
  (ensureCleanupLoop as any)._started = true;

  setInterval(() => {
    const t = now();
    for (const [key, stream] of activeStreams) {
      cleanupClients(stream);
      const hasClients = stream.clients.size > 0;
      const idleTime = t - stream.lastAccessAt;
      if (!hasClients && idleTime > STREAM_IDLE_TTL_MS) {
        logger.info(
          `Cleanup: stopping idle HLS stream ${key} (no clients, idle ${idleTime}ms)`,
        );
        void stopHlsStream(key);
      }
    }
  }, 2_500).unref();
}

// ============================================================================
// Stream Management
// ============================================================================

async function createOrGetStream(
  cameraNameOrId: string,
  profile: StreamProfile,
): Promise<ActiveHlsStream> {
  ensureCleanupLoop();

  const config = getConfig();
  const camera = config.cameras.find(
    (c) =>
      c.id === cameraNameOrId || sanitizeCameraName(c.name) === cameraNameOrId,
  );
  if (!camera) throw new Error("Camera not found");

  const streamKey = getStreamKey(camera.id, profile);
  const existing = activeStreams.get(streamKey);
  if (existing) return existing;

  const api = await getOrCreateApiConnection(camera.id);
  const channel = camera.rtspChannel ?? 0;
  const sanitizedName = sanitizeCameraName(camera.name);

  logger.info(`Creating HLS stream for ${camera.name}/${profile}`);

  // Create HLS server from library
  const server = new BaichuanHlsServer({
    api,
    channel,
    profile,
    logger: (level: "debug" | "info" | "warn" | "error", message: string) => {
      logger[level](message);
    },
  });

  // Setup event handlers
  server.on("started", ({ outputDir }: { outputDir: string }) => {
    logger.info(`HLS stream started: ${outputDir}`);
  });

  server.on("stopped", () => {
    logger.info(`HLS stream stopped for ${camera.name}/${profile}`);
  });

  server.on("codec-detected", ({ codec }: { codec: string }) => {
    logger.info(`HLS codec detected for ${camera.name}/${profile}: ${codec}`);
  });

  server.on("ffmpeg-started", () => {
    logger.debug(`ffmpeg started for ${camera.name}/${profile}`);
  });

  server.on(
    "ffmpeg-exited",
    ({ code, signal }: { code: number | null; signal: string | null }) => {
      logger.warn(
        `ffmpeg exited for ${camera.name}/${profile} (code=${code ?? "?"} signal=${signal ?? "?"})`,
      );
    },
  );

  server.on("error", (err: unknown) => {
    logger.error(`HLS error for ${camera.name}/${profile}: ${err}`);
  });

  const stream: ActiveHlsStream = {
    streamKey,
    cameraId: camera.id,
    cameraName: camera.name,
    sanitizedName,
    profile,
    server,
    startedAt: now(),
    lastAccessAt: now(),
    clients: new Map(),
  };

  // Start the server
  await server.start();

  activeStreams.set(streamKey, stream);
  return stream;
}

async function stopHlsStream(streamKey: string): Promise<void> {
  const stream = activeStreams.get(streamKey);
  if (!stream) return;

  logger.info(`Stopping HLS stream ${streamKey}`);
  activeStreams.delete(streamKey);

  await stream.server.stop();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Touch HLS client to keep stream alive
 */
export async function touchHlsClient(
  cameraNameOrId: string,
  profile: StreamProfile,
  clientKey: string,
): Promise<void> {
  const stream = await createOrGetStream(cameraNameOrId, profile);
  stream.lastAccessAt = now();
  stream.clients.set(clientKey, now());
  logger.debug(
    `HLS touch: ${stream.streamKey} client=${clientKey} clients=${stream.clients.size}`,
  );
}

/**
 * Read HLS asset (playlist or segment)
 */
export async function readHlsAsset(params: {
  cameraNameOrId: string;
  profile: StreamProfile;
  asset: string;
  clientKey: string;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}> {
  const { cameraNameOrId, profile, asset, clientKey } = params;

  // Validate asset name
  const safe = asset.replace(/^\/+/, "");
  if (safe.includes("..") || safe.includes("/")) {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Invalid asset path",
    };
  }

  await touchHlsClient(cameraNameOrId, profile, clientKey);

  const config = getConfig();
  const camera = config.cameras.find(
    (c) =>
      c.id === cameraNameOrId || sanitizeCameraName(c.name) === cameraNameOrId,
  );
  if (!camera) {
    return {
      status: 404,
      headers: { "Content-Type": "text/plain" },
      body: "Camera not found",
    };
  }

  const streamKey = getStreamKey(camera.id, profile);
  const stream = activeStreams.get(streamKey);
  if (!stream) {
    return {
      status: 500,
      headers: { "Content-Type": "text/plain" },
      body: "HLS stream not available",
    };
  }

  // Wait for playlist on first request
  if (safe.endsWith(".m3u8")) {
    const exists = await stream.server.waitForPlaylist(20_000);
    if (!exists) {
      return {
        status: 503,
        headers: {
          "Content-Type": "text/plain",
          "Retry-After": "2",
        },
        body: "Playlist not ready yet",
      };
    }
  }

  // Read asset from server
  const result = await stream.server.readAsset(safe);
  if (!result) {
    return {
      status: 404,
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
      body: "Not found",
    };
  }

  return {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
    body: result.data,
  };
}

/**
 * Get status of all HLS streams
 */
export function getHlsStatus(): Array<{
  cameraId: string;
  profile: StreamProfile;
  clients: number;
  uptime: number;
  serverStatus: HlsServerStatus;
}> {
  const out: Array<{
    cameraId: string;
    profile: StreamProfile;
    clients: number;
    uptime: number;
    serverStatus: HlsServerStatus;
  }> = [];

  for (const [, stream] of activeStreams) {
    cleanupClients(stream);
    out.push({
      cameraId: stream.cameraId,
      profile: stream.profile,
      clients: stream.clients.size,
      uptime: now() - stream.startedAt,
      serverStatus: stream.server.getStatus(),
    });
  }

  return out;
}

/**
 * Stop all HLS streams
 */
export async function stopAllHlsStreams(): Promise<void> {
  const keys = Array.from(activeStreams.keys());
  for (const key of keys) {
    await stopHlsStream(key);
  }
}
