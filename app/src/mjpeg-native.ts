/**
 * Native MJPEG Stream Manager
 *
 * Manages MJPEG streams using the native Baichuan protocol directly,
 * bypassing RTSP for more efficient browser previews.
 */

import {
  MjpegTransformer,
  createMjpegBoundary,
  getMjpegContentType,
  formatMjpegFrame,
  createNativeStream,
  convertToAnnexB as convertH264ToAnnexB,
  convertH265ToAnnexB,
  type MjpegFrame,
} from "@apocaliss92/nodelink-js";
import type { Response } from "express";
import { createSourceLogger } from "./logger.js";
import { getOrCreateApiConnection } from "./rtsp-manager.js";
import { getConfig } from "./settings-store.js";
import { emitStreamClientsChanged } from "./events-manager.js";

const logger = createSourceLogger("mjpeg-native");

interface NativeMjpegStream {
  cameraId: string;
  profile: "main" | "sub" | "ext";
  channel: number;
  transformer: MjpegTransformer;
  clients: Map<string, { response: Response; boundary: string }>;
  nativeStream: AsyncGenerator<any, void, unknown> | null;
  pumpPromise: Promise<void> | null;
  detectedCodec: "h264" | "h265" | null;
  frameCount: number;
  startedAt: Date;
}

// Active MJPEG streams
const activeStreams = new Map<string, NativeMjpegStream>();

// Client counter for unique IDs
let clientIdCounter = 0;

/**
 * Get stream key for a camera/profile combination
 */
function getStreamKey(cameraId: string, profile: string): string {
  return `${cameraId}:${profile}`;
}

/**
 * Add a client to an MJPEG stream (creates stream if needed)
 */
export async function addMjpegClient(
  cameraId: string,
  profile: "main" | "sub" | "ext",
  response: Response,
): Promise<{ clientId: string; cleanup: () => void }> {
  const streamKey = getStreamKey(cameraId, profile);
  const clientId = `client-${++clientIdCounter}`;
  const boundary = createMjpegBoundary();

  // Set MJPEG headers
  response.setHeader("Content-Type", getMjpegContentType(boundary));
  response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Connection", "close");

  // Get or create stream
  let stream = activeStreams.get(streamKey);
  if (!stream) {
    stream = await createNativeMjpegStream(cameraId, profile);
    activeStreams.set(streamKey, stream);
  }

  // Add client
  stream.clients.set(clientId, { response, boundary });
  logger.info(
    `MJPEG client ${clientId} connected to ${streamKey} (total: ${stream.clients.size})`,
  );
  emitStreamClientsChanged(cameraId, "mjpeg", profile, stream.clients.size);

  // Return cleanup function
  const cleanup = () => {
    removeMjpegClient(streamKey, clientId);
  };

  return { clientId, cleanup };
}

/**
 * Remove a client from an MJPEG stream
 */
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

  // Stop stream if no clients
  if (stream.clients.size === 0) {
    stopNativeMjpegStream(streamKey);
  }
}

/**
 * Create a new native MJPEG stream
 */
async function createNativeMjpegStream(
  cameraId: string,
  profile: "main" | "sub" | "ext",
): Promise<NativeMjpegStream> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) {
    throw new Error(`Camera not found: ${cameraId}`);
  }

  const channel = camera.rtspChannel ?? 0;
  const api = await getOrCreateApiConnection(cameraId);

  logger.info(`Creating native MJPEG stream for ${camera.name}/${profile}`);

  const stream: NativeMjpegStream = {
    cameraId,
    profile,
    channel,
    transformer: null!,
    clients: new Map(),
    nativeStream: null,
    pumpPromise: null,
    detectedCodec: null,
    frameCount: 0,
    startedAt: new Date(),
  };

  // Start native video stream
  // createNativeStream automatically acquires a dedicated socket from the pool.
  stream.nativeStream = createNativeStream(api, channel, profile);

  // Pump the native stream
  stream.pumpPromise = pumpNativeStream(stream, api);

  return stream;
}

/**
 * Pump native stream and feed to transformer
 */
async function pumpNativeStream(
  stream: NativeMjpegStream,
  api: any,
): Promise<void> {
  if (!stream.nativeStream) return;

  let waitingForKeyframe = true;
  const streamKey = getStreamKey(stream.cameraId, stream.profile);

  try {
    for await (const frame of stream.nativeStream) {
      // Check if stream still active
      if (!activeStreams.has(streamKey)) break;
      if (stream.clients.size === 0) break;

      // Only process video frames
      if (frame.audio) continue;
      if (!frame.data || frame.data.length === 0) continue;

      // Detect codec from first frame
      if (!stream.detectedCodec) {
        stream.detectedCodec = frame.videoType === "H265" ? "h265" : "h264";
        logger.info(`Detected codec: ${stream.detectedCodec} for ${streamKey}`);

        // Create transformer now that we know the codec
        stream.transformer = new MjpegTransformer({
          codec: stream.detectedCodec,
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

        // Handle frames from transformer
        stream.transformer.on("frame", (mjpegFrame: MjpegFrame) => {
          stream.frameCount++;
          broadcastFrame(stream, mjpegFrame);
        });

        stream.transformer.on("error", (err: Error) => {
          logger.error(`Transformer error for ${streamKey}: ${err}`);
        });

        stream.transformer.start();
      }

      // Wait for keyframe to start
      if (waitingForKeyframe) {
        if (frame.isKeyframe) {
          waitingForKeyframe = false;
          logger.debug(`Got keyframe for ${streamKey}, starting output`);
        } else {
          continue;
        }
      }

      // Convert to Annex-B and push to transformer
      if (stream.transformer) {
        const annexB =
          stream.detectedCodec === "h265"
            ? convertH265ToAnnexB(frame.data)
            : convertH264ToAnnexB(frame.data);
        stream.transformer.push(
          annexB,
          frame.microseconds ?? Date.now() * 1000,
        );
      }
    }
  } catch (err) {
    logger.error(`Native stream error for ${streamKey}: ${err}`);
  }

  logger.debug(`Native stream pump ended for ${streamKey}`);
}

/**
 * Broadcast JPEG frame to all connected clients
 */
function broadcastFrame(stream: NativeMjpegStream, frame: MjpegFrame): void {
  for (const [clientId, client] of stream.clients) {
    try {
      const mjpegData = formatMjpegFrame(frame.data, client.boundary);
      client.response.write(mjpegData);
    } catch {
      // Client might have disconnected, will be cleaned up
    }
  }
}

/**
 * Stop a native MJPEG stream
 */
async function stopNativeMjpegStream(streamKey: string): Promise<void> {
  const stream = activeStreams.get(streamKey);
  if (!stream) return;

  logger.info(`Stopping native MJPEG stream for ${streamKey}`);

  // Remove from active streams
  activeStreams.delete(streamKey);

  // Stop transformer
  if (stream.transformer) {
    await stream.transformer.stop();
  }

  // Stop native stream
  if (stream.nativeStream) {
    try {
      await stream.nativeStream.return(undefined as any);
    } catch {
      // ignore
    }
  }

  // Wait for pump to finish
  if (stream.pumpPromise) {
    try {
      await stream.pumpPromise;
    } catch {
      // ignore
    }
  }

  logger.info(`Native MJPEG stream stopped for ${streamKey}`);
}

/**
 * Stop all native MJPEG streams
 */
export async function stopAllNativeMjpegStreams(): Promise<void> {
  const keys = Array.from(activeStreams.keys());
  for (const key of keys) {
    await stopNativeMjpegStream(key);
  }
}

/**
 * Get status of all native MJPEG streams
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
