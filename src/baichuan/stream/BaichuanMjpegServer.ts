/**
 * Baichuan MJPEG Server - HTTP server that serves MJPEG streams from Baichuan cameras
 *
 * Converts H.264/H.265 video streams to MJPEG for browser viewing.
 * Supports multiple concurrent viewers with efficient stream sharing.
 */

import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../../reolink/baichuan/types";
import { createNativeStream } from "../../rfc/helpers";
import {
  MjpegTransformer,
  createMjpegBoundary,
  getMjpegContentType,
  formatMjpegFrame,
  type MjpegFrame,
} from "./MjpegTransformer";
import { convertToAnnexB as convertH264ToAnnexB } from "./H264Converter";
import { convertToAnnexB as convertH265ToAnnexB } from "./H265Converter";
import { detectVideoCodecFromNal } from "./BcMediaAnnexBDecoder";

export interface BaichuanMjpegServerOptions {
  /** API instance (required) */
  api: ReolinkBaichuanApi;
  /** Channel number (required) */
  channel: number;
  /** Stream profile (required) */
  profile: StreamProfile;
  /** Native-only: TrackMix tele/autotrack variants */
  variant?: NativeVideoStreamVariant;
  /** HTTP server port (default: 8080) */
  port?: number;
  /** HTTP server host (default: "0.0.0.0") */
  host?: string;
  /** URL path for MJPEG stream (default: "/mjpeg") */
  path?: string;
  /** JPEG quality (1-31, lower is better, default: 5) */
  quality?: number;
  /** Output width (optional) */
  width?: number;
  /** Output height (optional) */
  height?: number;
  /** Max FPS (optional) */
  maxFps?: number;
  /** Logger callback */
  logger?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;
}

interface MjpegClient {
  id: string;
  response: http.ServerResponse;
  boundary: string;
  connectedAt: number;
}

/**
 * BaichuanMjpegServer - MJPEG HTTP server for Baichuan video streams
 *
 * Events:
 * - 'started': Server started
 * - 'stopped': Server stopped
 * - 'client-connected': Client connected
 * - 'client-disconnected': Client disconnected
 * - 'error': Error occurred
 */
export class BaichuanMjpegServer extends EventEmitter {
  private readonly options: BaichuanMjpegServerOptions;
  private readonly clients = new Map<string, MjpegClient>();
  private httpServer: http.Server | null = null;
  private transformer: MjpegTransformer | null = null;
  private nativeStream: AsyncGenerator<any, void, unknown> | null = null;
  private streamPump: Promise<void> | null = null;
  private detectedCodec: "h264" | "h265" | null = null;
  private started = false;
  private clientIdCounter = 0;

  constructor(options: BaichuanMjpegServerOptions) {
    super();
    this.options = options;
  }

  /**
   * Start the MJPEG server
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const port = this.options.port ?? 8080;
    const host = this.options.host ?? "0.0.0.0";
    const path = this.options.path ?? "/mjpeg";

    this.httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res, path);
    });

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", (err) => {
        this.log("error", `HTTP server error: ${err.message}`);
        reject(err);
      });

      this.httpServer!.listen(port, host, () => {
        this.log(
          "info",
          `MJPEG server started on http://${host}:${port}${path}`,
        );
        this.emit("started", { host, port, path });
        resolve();
      });
    });
  }

  /**
   * Stop the MJPEG server
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Close all clients
    for (const [id, client] of this.clients) {
      try {
        client.response.end();
      } catch {
        // ignore
      }
      this.clients.delete(id);
    }

    // Stop stream
    await this.stopStream();

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.log("info", "MJPEG server stopped");
    this.emit("stopped");
  }

  /**
   * Handle HTTP request
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    expectedPath: string,
  ): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname !== expectedPath) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    this.handleMjpegClient(req, res);
  }

  /**
   * Handle new MJPEG client
   */
  private handleMjpegClient(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const clientId = `client-${++this.clientIdCounter}`;
    const boundary = createMjpegBoundary();

    const client: MjpegClient = {
      id: clientId,
      response: res,
      boundary,
      connectedAt: Date.now(),
    };

    this.clients.set(clientId, client);
    this.log(
      "info",
      `MJPEG client connected: ${clientId} (total: ${this.clients.size})`,
    );
    this.emit("client-connected", { id: clientId, total: this.clients.size });

    // Set MJPEG headers
    res.writeHead(200, {
      "Content-Type": getMjpegContentType(boundary),
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      Connection: "close",
    });

    // Handle client disconnect
    const cleanup = () => {
      this.clients.delete(clientId);
      this.log(
        "info",
        `MJPEG client disconnected: ${clientId} (remaining: ${this.clients.size})`,
      );
      this.emit("client-disconnected", {
        id: clientId,
        total: this.clients.size,
      });

      // Stop stream if no clients
      if (this.clients.size === 0) {
        this.stopStream();
      }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    // Start stream if not running
    if (!this.transformer) {
      this.startStream();
    }
  }

  /**
   * Start the native video stream and MJPEG transformer
   */
  private async startStream(): Promise<void> {
    if (this.transformer) return;

    this.log("info", "Starting native video stream...");

    const { api, channel, profile, variant, quality, width, height, maxFps } =
      this.options;

    try {
      // Create native stream
      this.nativeStream = createNativeStream(
        api,
        channel,
        profile,
        variant ? { variant } : undefined,
      );

      // Pump stream to detect codec and get frames
      this.streamPump = this.pumpStream();
    } catch (err) {
      this.log("error", `Failed to start stream: ${err}`);
      this.emit("error", err);
    }
  }

  /**
   * Pump native stream and feed to transformer
   */
  private async pumpStream(): Promise<void> {
    if (!this.nativeStream) return;

    let frameBuffer: Buffer[] = [];
    let waitingForKeyframe = true;

    try {
      for await (const frame of this.nativeStream) {
        if (!this.started || this.clients.size === 0) break;

        // Frame has: type, data, microseconds, videoType
        const { type, data, microseconds, videoType } = frame;

        if (type !== "Iframe" && type !== "Pframe") continue;
        if (!data || data.length === 0) continue;

        // Convert to Annex-B format
        let annexB: Buffer;
        if (videoType === "H265") {
          annexB = convertH265ToAnnexB(data);
          if (!this.detectedCodec) {
            this.detectedCodec = "h265";
            this.initTransformer();
          }
        } else {
          annexB = convertH264ToAnnexB(data);
          if (!this.detectedCodec) {
            this.detectedCodec = "h264";
            this.initTransformer();
          }
        }

        // Wait for keyframe to start
        if (waitingForKeyframe) {
          if (type === "Iframe") {
            waitingForKeyframe = false;
          } else {
            continue;
          }
        }

        // Push to transformer
        if (this.transformer) {
          this.transformer.push(annexB, microseconds);
        }
      }
    } catch (err) {
      if (this.started) {
        this.log("error", `Stream error: ${err}`);
        this.emit("error", err);
      }
    }
  }

  /**
   * Initialize MJPEG transformer once codec is detected
   */
  private initTransformer(): void {
    if (this.transformer || !this.detectedCodec) return;

    const { quality, width, height, maxFps } = this.options;

    this.transformer = new MjpegTransformer({
      codec: this.detectedCodec,
      quality,
      width,
      height,
      maxFps,
      logger: this.options.logger,
    });

    this.transformer.on("frame", (frame: MjpegFrame) => {
      this.broadcastFrame(frame);
    });

    this.transformer.on("error", (err) => {
      this.log("error", `Transformer error: ${err}`);
    });

    this.transformer.on("close", () => {
      this.log("debug", "Transformer closed");
    });

    this.transformer.start();
    this.log(
      "info",
      `MJPEG transformer started (codec: ${this.detectedCodec})`,
    );
  }

  /**
   * Broadcast JPEG frame to all connected clients
   */
  private broadcastFrame(frame: MjpegFrame): void {
    for (const client of this.clients.values()) {
      try {
        const mjpegData = formatMjpegFrame(frame.data, client.boundary);
        client.response.write(mjpegData);
      } catch {
        // Client might have disconnected
      }
    }
  }

  /**
   * Stop the stream and transformer
   */
  private async stopStream(): Promise<void> {
    // Stop transformer
    if (this.transformer) {
      await this.transformer.stop();
      this.transformer = null;
    }

    // Stop native stream
    if (this.nativeStream) {
      try {
        await this.nativeStream.return(undefined as any);
      } catch {
        // ignore
      }
      this.nativeStream = null;
    }

    // Wait for pump to finish
    if (this.streamPump) {
      try {
        await this.streamPump;
      } catch {
        // ignore
      }
      this.streamPump = null;
    }

    this.detectedCodec = null;
    this.log("debug", "Stream stopped");
  }

  /**
   * Get current number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get server status
   */
  getStatus(): {
    running: boolean;
    clients: number;
    codec: string | null;
    frames: number;
  } {
    return {
      running: this.started,
      clients: this.clients.size,
      codec: this.detectedCodec,
      frames: this.transformer?.getFrameCount() ?? 0,
    };
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    this.options.logger?.(level, `[BaichuanMjpegServer] ${message}`);
  }
}
