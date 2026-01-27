/**
 * MJPEG Transformer - Converts H.264/H.265 video frames to MJPEG stream
 *
 * Uses FFmpeg as a persistent process for efficient decoding and JPEG encoding.
 * Receives Annex-B access units and outputs JPEG frames.
 */

import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Logger callback type for MjpegTransformer */
export type LoggerCallback = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
) => void;

export interface MjpegTransformerOptions {
  /** Video codec (required) */
  codec: "h264" | "h265";
  /** JPEG quality (1-31, lower is better, default: 5) */
  quality?: number | undefined;
  /** Output width (optional, maintains aspect ratio if only one dimension set) */
  width?: number | undefined;
  /** Output height (optional, maintains aspect ratio if only one dimension set) */
  height?: number | undefined;
  /** Frame rate limit (optional, e.g., 10 for max 10 fps) */
  maxFps?: number | undefined;
  /** Logger callback */
  logger?: LoggerCallback | undefined;
}

export interface MjpegFrame {
  /** JPEG data */
  data: Buffer;
  /** Timestamp in microseconds */
  timestamp: number;
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]); // Start of Image
const JPEG_EOI = Buffer.from([0xff, 0xd9]); // End of Image

/**
 * MjpegTransformer - Transforms H.264/H.265 access units to JPEG frames
 *
 * Events:
 * - 'frame': Emitted when a JPEG frame is ready (MjpegFrame)
 * - 'error': Emitted on error
 * - 'close': Emitted when transformer is closed
 */
export class MjpegTransformer extends EventEmitter {
  private readonly options: Required<
    Omit<MjpegTransformerOptions, "logger" | "width" | "height" | "maxFps">
  > &
    Pick<MjpegTransformerOptions, "logger" | "width" | "height" | "maxFps">;
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private closed = false;
  private jpegBuffer = Buffer.alloc(0);
  private frameCount = 0;
  private lastTimestamp = 0;

  constructor(options: MjpegTransformerOptions) {
    super();
    this.options = {
      codec: options.codec,
      quality: options.quality ?? 5,
      width: options.width,
      height: options.height,
      maxFps: options.maxFps,
      logger: options.logger,
    };
  }

  /**
   * Start the transformer (spawns FFmpeg process)
   */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;

    const { codec, quality, width, height, maxFps } = this.options;

    // Build FFmpeg arguments
    const args: string[] = [
      "-hide_banner",
      "-loglevel",
      "error",
      // Input: raw video from stdin
      "-f",
      codec === "h265" ? "hevc" : "h264",
      "-i",
      "pipe:0",
    ];

    // Video filters
    const filters: string[] = [];

    // Scale if dimensions specified
    if (width || height) {
      const w = width ?? -1;
      const h = height ?? -1;
      filters.push(`scale=${w}:${h}`);
    }

    // Frame rate limit
    if (maxFps) {
      filters.push(`fps=${maxFps}`);
    }

    if (filters.length > 0) {
      args.push("-vf", filters.join(","));
    }

    // Output: MJPEG to stdout
    args.push(
      "-c:v",
      "mjpeg",
      "-q:v",
      String(quality),
      "-f",
      "mjpeg",
      "pipe:1",
    );

    this.log("debug", `Starting FFmpeg with args: ${args.join(" ")}`);

    this.ffmpeg = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.ffmpeg.stdout.on("data", (data: Buffer) => {
      this.handleJpegData(data);
    });

    this.ffmpeg.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        this.log("debug", `FFmpeg: ${msg}`);
      }
    });

    this.ffmpeg.on("close", (code) => {
      this.log("debug", `FFmpeg closed with code ${code}`);
      this.ffmpeg = null;
      if (!this.closed) {
        this.emit("close", code);
      }
    });

    this.ffmpeg.on("error", (err) => {
      this.log("error", `FFmpeg error: ${err.message}`);
      this.emit("error", err);
    });
  }

  /**
   * Push an H.264/H.265 access unit (Annex-B format with start codes)
   */
  push(accessUnit: Buffer, timestamp?: number): void {
    if (!this.started || this.closed || !this.ffmpeg) {
      return;
    }

    this.lastTimestamp = timestamp ?? Date.now() * 1000;

    try {
      this.ffmpeg.stdin.write(accessUnit);
    } catch (err) {
      this.log("error", `Failed to write to FFmpeg: ${err}`);
    }
  }

  /**
   * Handle JPEG data from FFmpeg stdout
   * FFmpeg outputs complete JPEG images, each starting with SOI (0xFFD8)
   * and ending with EOI (0xFFD9)
   */
  private handleJpegData(data: Buffer): void {
    this.jpegBuffer = Buffer.concat([this.jpegBuffer, data]);

    // Process all complete JPEG frames in buffer
    while (true) {
      // Find SOI marker
      const soiIndex = this.jpegBuffer.indexOf(JPEG_SOI);
      if (soiIndex < 0) {
        // No start marker, clear buffer
        this.jpegBuffer = Buffer.alloc(0);
        break;
      }

      // Discard data before SOI
      if (soiIndex > 0) {
        this.jpegBuffer = this.jpegBuffer.subarray(soiIndex);
      }

      // Find EOI marker (must be after SOI)
      const eoiIndex = this.jpegBuffer.indexOf(JPEG_EOI, 2);
      if (eoiIndex < 0) {
        // No end marker yet, wait for more data
        break;
      }

      // Extract complete JPEG frame (including EOI)
      const frameEnd = eoiIndex + 2;
      const jpegFrame = this.jpegBuffer.subarray(0, frameEnd);

      // Remove processed frame from buffer
      this.jpegBuffer = this.jpegBuffer.subarray(frameEnd);

      // Emit frame
      this.frameCount++;
      const frame: MjpegFrame = {
        data: jpegFrame,
        timestamp: this.lastTimestamp,
      };
      this.emit("frame", frame);
    }
  }

  /**
   * Stop the transformer
   */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.ffmpeg) {
      try {
        this.ffmpeg.stdin.end();
      } catch {
        // ignore
      }

      // Give FFmpeg a moment to flush
      await new Promise<void>((resolve) => {
        const ff = this.ffmpeg;
        if (!ff) {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          ff.kill("SIGKILL");
          resolve();
        }, 1000);

        ff.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });

        try {
          ff.kill("SIGTERM");
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.ffmpeg = null;
    }

    this.emit("close", 0);
  }

  /**
   * Get frame count
   */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.started && !this.closed && this.ffmpeg !== null;
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    this.options.logger?.(level, `[MjpegTransformer] ${message}`);
  }
}

/**
 * Create an MJPEG HTTP response handler
 *
 * Usage:
 * ```ts
 * const transformer = new MjpegTransformer({ codec: "h264" });
 * transformer.start();
 *
 * // In your stream handler:
 * stream.on("accessUnit", (au) => transformer.push(au.data, au.timestamp));
 *
 * // HTTP handler:
 * app.get("/mjpeg", (req, res) => {
 *   serveMjpeg(res, transformer);
 * });
 * ```
 */
export function createMjpegBoundary(): string {
  return `mjpegboundary${Date.now()}`;
}

export function getMjpegContentType(boundary: string): string {
  return `multipart/x-mixed-replace; boundary=${boundary}`;
}

export function formatMjpegFrame(frame: Buffer, boundary: string): Buffer {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
  );
  return Buffer.concat([header, frame, Buffer.from("\r\n")]);
}
