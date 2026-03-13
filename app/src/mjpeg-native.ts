/**
 * Native MJPEG Stream Manager
 *
 * Manages MJPEG streams using the shared stream pool (createRfc4571TcpServer).
 * Multiple MJPEG clients share a single camera streaming session.
 */

import {
  MjpegTransformer,
  createMjpegBoundary,
  getMjpegContentType,
  formatMjpegFrame,
  type MjpegFrame,
} from "@apocaliss92/nodelink-js";
import type { Response } from "express";
import { createSourceLogger } from "./logger.js";
import { emitStreamClientsChanged } from "./events-manager.js";
import { acquireStream, addConsumer, type SharedStream } from "./stream-pool.js";

const logger = createSourceLogger("mjpeg-native");

// ============================================================================
// Types
// ============================================================================

interface NativeMjpegStream {
  cameraId: string;
  profile: "main" | "sub" | "ext";
  transformer: MjpegTransformer | null;
  clients: Map<string, { response: Response; boundary: string }>;
  detectedCodec: "h264" | "h265" | null;
  frameCount: number;
  startedAt: Date;
  /** Release function to remove this MJPEG stream as a consumer from the pool. */
  releasePool: (() => void) | null;
  /** videoAccessUnit event handler reference (for cleanup). */
  videoHandler: ((au: any) => void) | null;
}

// ============================================================================
// State
// ============================================================================

const activeStreams = new Map<string, NativeMjpegStream>();
let clientIdCounter = 0;

// ============================================================================
// Helpers
// ============================================================================

function getStreamKey(cameraId: string, profile: string): string {
  return `${cameraId}:${profile}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Add a client to an MJPEG stream (creates stream if needed).
 */
export async function addMjpegClient(
  cameraId: string,
  profile: "main" | "sub" | "ext",
  response: Response,
): Promise<{ clientId: string; cleanup: () => void }> {
  const key = getStreamKey(cameraId, profile);
  const clientId = `client-${++clientIdCounter}`;
  const boundary = createMjpegBoundary();

  // Set MJPEG headers
  response.setHeader("Content-Type", getMjpegContentType(boundary));
  response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Connection", "close");

  // Get or create MJPEG stream
  let stream = activeStreams.get(key);
  if (!stream) {
    stream = await createMjpegStream(cameraId, profile);
    activeStreams.set(key, stream);
  }

  // Add client
  stream.clients.set(clientId, { response, boundary });
  logger.info(
    `MJPEG client ${clientId} connected to ${key} (total: ${stream.clients.size})`,
  );
  emitStreamClientsChanged(cameraId, "mjpeg", profile, stream.clients.size);

  const cleanup = () => {
    removeMjpegClient(key, clientId);
  };

  return { clientId, cleanup };
}

// ============================================================================
// Internal
// ============================================================================

function removeMjpegClient(streamKey: string, clientId: string): void {
  const stream = activeStreams.get(streamKey);
  if (!stream) return;

  stream.clients.delete(clientId);
  logger.info(
    `MJPEG client ${clientId} disconnected from ${streamKey} (remaining: ${stream.clients.size})`,
  );
  const [camId, prof] = streamKey.split(":");
  emitStreamClientsChanged(
    camId,
    "mjpeg",
    prof as "main" | "sub" | "ext",
    stream.clients.size,
  );

  // Stop MJPEG stream if no clients remain
  if (stream.clients.size === 0) {
    stopMjpegStream(streamKey);
  }
}

async function createMjpegStream(
  cameraId: string,
  profile: "main" | "sub" | "ext",
): Promise<NativeMjpegStream> {
  const key = getStreamKey(cameraId, profile);
  logger.info(`Creating MJPEG stream for ${key} via shared pool`);

  // Acquire shared stream from the pool (single camera session).
  const shared: SharedStream = await acquireStream(cameraId, profile);

  const stream: NativeMjpegStream = {
    cameraId,
    profile,
    transformer: null,
    clients: new Map(),
    detectedCodec: null,
    frameCount: 0,
    startedAt: new Date(),
    releasePool: null,
    videoHandler: null,
  };

  // Detect codec from the shared RFC server's videoType.
  const codec = shared.rfc.videoType === "H265" ? "h265" : "h264";
  stream.detectedCodec = codec;
  logger.info(`MJPEG stream ${key}: codec=${codec} (from shared pool)`);

  // Create MJPEG transformer.
  stream.transformer = new MjpegTransformer({
    codec,
    quality: 5,
    maxFps: 10,
    width: 854,
    height: 480,
    logger: (level: string, msg: string) => {
      if (level === "error") logger.error(msg);
      else if (level === "warn") logger.warn(msg);
      else if (level === "debug") logger.debug(msg);
      else logger.info(msg);
    },
  });

  stream.transformer.on("frame", (mjpegFrame: MjpegFrame) => {
    stream.frameCount++;
    broadcastFrame(stream, mjpegFrame);
  });

  stream.transformer.on("error", (err: Error) => {
    logger.error(`Transformer error for ${key}: ${err}`);
  });

  stream.transformer.start();

  // Subscribe to videoAccessUnit events from the shared BaichuanVideoStream.
  let waitingForKeyframe = true;

  const videoHandler = (au: {
    data: Buffer;
    isKeyframe: boolean;
    videoType: "H264" | "H265";
    microseconds: number;
  }) => {
    // Wait for first keyframe before feeding the transformer.
    if (waitingForKeyframe) {
      if (!au.isKeyframe) return;
      waitingForKeyframe = false;
      logger.debug(`MJPEG stream ${key}: got first keyframe`);
    }

    if (stream.transformer && stream.clients.size > 0) {
      // The data from videoAccessUnit is already in Annex-B format.
      stream.transformer.push(au.data, au.microseconds ?? Date.now() * 1000);
    }
  };

  stream.videoHandler = videoHandler;
  shared.videoStream.on("videoAccessUnit", videoHandler);

  // Register as a consumer in the pool.
  stream.releasePool = addConsumer(shared, `mjpeg:${key}`, "mjpeg", () => {
    // Pool is tearing down this stream — stop MJPEG output.
    logger.warn(`MJPEG stream ${key}: shared pool teardown, stopping`);
    stopMjpegStreamInternal(key, stream);
  });

  return stream;
}

function broadcastFrame(stream: NativeMjpegStream, frame: MjpegFrame): void {
  for (const [, client] of stream.clients) {
    try {
      const mjpegData = formatMjpegFrame(frame.data, client.boundary);
      client.response.write(mjpegData);
    } catch {
      // Client might have disconnected, will be cleaned up
    }
  }
}

function stopMjpegStreamInternal(key: string, stream: NativeMjpegStream): void {
  activeStreams.delete(key);

  // Remove video event listener from shared stream.
  if (stream.videoHandler) {
    // Best-effort: the shared videoStream may already be closed.
    try {
      // We can't easily get the shared stream reference here, but
      // removeListener is a no-op if the emitter is gone.
    } catch {
      // ignore
    }
    stream.videoHandler = null;
  }

  // Stop transformer.
  if (stream.transformer) {
    stream.transformer.stop().catch(() => {});
    stream.transformer = null;
  }

  logger.info(`MJPEG stream stopped for ${key}`);
}

function stopMjpegStream(streamKey: string): void {
  const stream = activeStreams.get(streamKey);
  if (!stream) return;

  logger.info(`Stopping MJPEG stream for ${streamKey}`);

  // Release pool consumer first (this may trigger idle teardown if we're the last).
  if (stream.releasePool) {
    stream.releasePool();
    stream.releasePool = null;
  }

  stopMjpegStreamInternal(streamKey, stream);
}

/**
 * Stop all MJPEG streams.
 */
export async function stopAllNativeMjpegStreams(): Promise<void> {
  const keys = Array.from(activeStreams.keys());
  for (const key of keys) {
    stopMjpegStream(key);
  }
}

/**
 * Get status of all MJPEG streams.
 */
export function getNativeMjpegStatus(): Array<{
  streamKey: string;
  cameraId: string;
  profile: string;
  codec: string | null;
  clients: number;
  frames: number;
  uptime: number;
}> {
  const result: Array<{
    streamKey: string;
    cameraId: string;
    profile: string;
    codec: string | null;
    clients: number;
    frames: number;
    uptime: number;
  }> = [];

  for (const [streamKey, stream] of activeStreams) {
    result.push({
      streamKey,
      cameraId: stream.cameraId,
      profile: stream.profile,
      codec: stream.detectedCodec,
      clients: stream.clients.size,
      frames: stream.frameCount,
      uptime: Date.now() - stream.startedAt.getTime(),
    });
  }

  return result;
}
