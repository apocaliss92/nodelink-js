/**
 * Multifocal Camera Composite Stream
 * 
 * Combines streams from a multifocal camera (wider and tele) into a new composite stream
 * with configurable picture-in-picture (PIP).
 * 
 * Uses ffmpeg to overlay the tele stream on the wider stream in various positions.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { StreamProfile } from "../reolink/baichuan/types";
import type { Logger } from "../debug/DebugConfig";
import { createNativeStream } from "../rfc/helpers";

export type PipPosition = 
  | "top-left" 
  | "top-right" 
  | "bottom-left" 
  | "bottom-right" 
  | "center"
  | "top-center"
  | "bottom-center"
  | "left-center"
  | "right-center";

export interface CompositeStreamPipOptions {
  /** Wider channel (default: 0) */
  widerChannel?: number;
  /** Tele channel (default: 1) */
  teleChannel?: number;
  /** PIP position (default: "bottom-right") */
  pipPosition?: PipPosition;
  /** PIP size (default: 0.25) */
  pipSize?: number;
  /** PIP margin in pixels (default: 10) */
  pipMargin?: number;
  /** True when behind NVR/Hub (affects variant selection for snapshots) */
  onNvr?: boolean;
}

export type CompositeStreamOptions = {
  api: ReolinkBaichuanApi;
  /** Channel for wider stream (typically 0) */
  widerChannel: number;
  /** Channel for tele stream (typically 1) */
  teleChannel: number;
  /** Profile for wider stream */
  widerProfile: StreamProfile;
  /** Profile for tele stream */
  teleProfile: StreamProfile;
  /** PIP position of tele on wider */
  pipPosition?: PipPosition;
  /** Relative size of PIP (0.1 = 10%, 0.3 = 30%, etc.) */
  pipSize?: number;
  /** Margin from edge in pixels */
  pipMargin?: number;
  /** Optional logger */
  logger?: Logger;
};

/**
 * Calculate overlay position based on requested PIP position
 */
function calculateOverlayPosition(
  position: PipPosition,
  mainWidth: number,
  mainHeight: number,
  pipWidth: number,
  pipHeight: number,
  margin: number
): { x: number; y: number } {
  const pipW = Math.floor(pipWidth);
  const pipH = Math.floor(pipHeight);
  const m = margin;

  switch (position) {
    case "top-left":
      return { x: m, y: m };
    case "top-right":
      return { x: mainWidth - pipW - m, y: m };
    case "bottom-left":
      return { x: m, y: mainHeight - pipH - m };
    case "bottom-right":
      return { x: mainWidth - pipW - m, y: mainHeight - pipH - m };
    case "center":
      return { x: Math.floor((mainWidth - pipW) / 2), y: Math.floor((mainHeight - pipH) / 2) };
    case "top-center":
      return { x: Math.floor((mainWidth - pipW) / 2), y: m };
    case "bottom-center":
      return { x: Math.floor((mainWidth - pipW) / 2), y: mainHeight - pipH - m };
    case "left-center":
      return { x: m, y: Math.floor((mainHeight - pipH) / 2) };
    case "right-center":
      return { x: mainWidth - pipW - m, y: Math.floor((mainHeight - pipH) / 2) };
    default:
      return { x: m, y: m };
  }
}

/**
 * CompositeStream - Combines wider and tele streams with configurable PIP
 */
export class CompositeStream extends EventEmitter<{
  videoFrame: [Buffer];
  error: [Error];
  close: [];
}> {
  private options: CompositeStreamOptions;
  private widerStream: AsyncGenerator<any, void, unknown> | null = null;
  private teleStream: AsyncGenerator<any, void, unknown> | null = null;
  private ffmpegProcess: ReturnType<typeof spawn> | null = null;
  private active = false;
  private logger: Logger;

  constructor(options: CompositeStreamOptions) {
    super();
    this.options = {
      pipPosition: "bottom-right",
      pipSize: 0.25,
      pipMargin: 10,
      ...options,
    };
    this.logger = options.logger ?? console;
  }

  /**
   * Start the composite stream
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("Composite stream already active");
    }

    this.active = true;
    this.logger.log?.("[CompositeStream] Starting composite stream...");

    try {
      // Get metadata to determine resolutions
      const widerMetadata = await this.options.api.getStreamMetadata(this.options.widerChannel);
      const teleMetadata = await this.options.api.getStreamMetadata(this.options.teleChannel);

      const widerStreamInfo = widerMetadata.streams.find((s) => s.profile === this.options.widerProfile);
      const teleStreamInfo = teleMetadata.streams.find((s) => s.profile === this.options.teleProfile);

      if (!widerStreamInfo || !teleStreamInfo) {
        throw new Error("Stream metadata not found");
      }

      const mainWidth = widerStreamInfo.width;
      const mainHeight = widerStreamInfo.height;
      const pipWidth = Math.floor(teleStreamInfo.width * (this.options.pipSize ?? 0.25));
      const pipHeight = Math.floor(teleStreamInfo.height * (this.options.pipSize ?? 0.25));

      const position = calculateOverlayPosition(
        this.options.pipPosition ?? "bottom-right",
        mainWidth,
        mainHeight,
        pipWidth,
        pipHeight,
        this.options.pipMargin ?? 10
      );

      this.logger.log?.(
        `[CompositeStream] Main: ${mainWidth}x${mainHeight}, PIP: ${pipWidth}x${pipHeight} at (${position.x}, ${position.y})`
      );

      // Start native streams
      this.widerStream = createNativeStream(
        this.options.api,
        this.options.widerChannel,
        this.options.widerProfile
      );
      this.teleStream = createNativeStream(
        this.options.api,
        this.options.teleChannel,
        this.options.teleProfile
      );

      // Start ffmpeg for composition
      await this.startFfmpegComposition(mainWidth, mainHeight, pipWidth, pipHeight, position);

      this.logger.log?.("[CompositeStream] Composite stream started");
    } catch (error) {
      this.active = false;
      this.emit("error", error as Error);
      throw error;
    }
  }

  /**
   * Start ffmpeg for composition with overlay
   */
  private async startFfmpegComposition(
    mainWidth: number,
    mainHeight: number,
    pipWidth: number,
    pipHeight: number,
    position: { x: number; y: number }
  ): Promise<void> {
    // Determine video codec from both streams
    // If metadata is not available or inaccurate, ffmpeg will auto-detect from stream data
    const widerMetadata = await this.options.api.getStreamMetadata(this.options.widerChannel);
    const teleMetadata = await this.options.api.getStreamMetadata(this.options.teleChannel);
    const widerStreamInfo = widerMetadata.streams.find((s) => s.profile === this.options.widerProfile);
    const teleStreamInfo = teleMetadata.streams.find((s) => s.profile === this.options.teleProfile);
    
    // Determine codec for each input stream
    const widerCodec = widerStreamInfo?.videoEncType?.toLowerCase().includes("265") ? "hevc" : "h264";
    const teleCodec = teleStreamInfo?.videoEncType?.toLowerCase().includes("265") ? "hevc" : "h264";
    
    // Log codec detection for debugging
    this.logger.log?.(
      `[CompositeStream] Codec detection: wider=${widerCodec} (from metadata: ${widerStreamInfo?.videoEncType || "unknown"}), tele=${teleCodec} (from metadata: ${teleStreamInfo?.videoEncType || "unknown"})`
    );

    // ffmpeg args for composition
    // Input 0: wider stream (main)
    // Input 1: tele stream (PIP)
    // Output: composite stream with overlay
    // Note: For raw H264/H265 streams from pipes, we need to specify the format
    // but we add flags to help ffmpeg detect the codec more reliably
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "error",
      "-fflags", "+genpts",
      "-probesize", "32", // Small probe size for faster detection
      "-analyzeduration", "500000", // 0.5 seconds to analyze stream
      // Input 0: wider stream (main)
      "-f", widerCodec,
      "-i", "pipe:0",
      // Input 1: tele stream (PIP)  
      "-f", teleCodec,
      "-i", "pipe:3",
      // Filter to scale and position PIP
      "-filter_complex",
      `[1:v]scale=${pipWidth}:${pipHeight}[pip];[0:v][pip]overlay=${position.x}:${position.y}[out]`,
      "-map", "[out]",
      "-c:v", "libx264", // Re-encode for compatibility
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-crf", "23",
      "-f", "h264",
      "pipe:1", // Output (stdout)
    ];

    this.logger.log?.(
      `[CompositeStream] Starting ffmpeg: ${ffmpegArgs.join(" ")}`
    );

    // We need two writable inputs: stdin (fd 0) for wider, and an extra fd (fd 3) for tele.
    // stdout (fd 1) is used for the composed H.264 output.
    this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });

    // Handle ffmpeg errors
    this.ffmpegProcess.on("error", (error) => {
      this.logger.error?.("[CompositeStream] FFmpeg error:", error);
      this.emit("error", error);
    });

    this.ffmpegProcess.on("close", (code) => {
      if (code !== 0 && code !== null) {
        this.logger.warn?.(`[CompositeStream] FFmpeg exited with code ${code}`);
      }
      this.emit("close");
    });

    // Read composite video output
    this.ffmpegProcess.stdout?.on("data", (data: Buffer) => {
      this.emit("videoFrame", data);
    });

    // Read stderr for debug
    this.ffmpegProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("error") || output.includes("Error")) {
        this.logger.error?.("[CompositeStream] FFmpeg stderr:", output);
      }
    });

    // Feed frames to ffmpeg inputs
    this.feedFramesToFfmpeg();
  }

  /**
   * Feed frames from native streams to ffmpeg
   * Uses two separate loops to write frames continuously
   */
  private async feedFramesToFfmpeg(): Promise<void> {
    if (!this.ffmpegProcess || !this.widerStream || !this.teleStream) {
      return;
    }

    const widerStdin = this.ffmpegProcess.stdio[0] as NodeJS.WritableStream | null;
    const teleStdin = this.ffmpegProcess.stdio[3] as NodeJS.WritableStream | null;

    if (!widerStdin || !teleStdin) {
      this.logger.error?.("[CompositeStream] FFmpeg stdin not available");
      return;
    }

    // Feed wider stream (input 0)
    const feedWider = async () => {
      try {
        for await (const frame of this.widerStream!) {
          if (!this.active) break;
          if (frame.audio) continue; // Skip audio frames

          try {
            const written = widerStdin.write(frame.data);
            if (!written) {
              await new Promise<void>((resolve) => {
                widerStdin.once("drain", () => resolve());
              });
            }
          } catch (error) {
            const code = (error as any)?.code;
            if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
              this.logger.log?.("[CompositeStream] FFmpeg wider stdin closed");
              break;
            }
            this.logger.error?.("[CompositeStream] Error writing wider frame:", error);
          }
        }
      } catch (error) {
        if (this.active) {
          this.logger.error?.("[CompositeStream] Error in wider stream:", error);
        }
      } finally {
        try {
          widerStdin.end();
        } catch {}
      }
    };

    // Feed tele stream (input 1)
    const feedTele = async () => {
      try {
        for await (const frame of this.teleStream!) {
          if (!this.active) break;
          if (frame.audio) continue; // Skip audio frames

          try {
            const written = teleStdin.write(frame.data);
            if (!written) {
              await new Promise<void>((resolve) => {
                teleStdin.once("drain", () => resolve());
              });
            }
          } catch (error) {
            const code = (error as any)?.code;
            if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
              this.logger.log?.("[CompositeStream] FFmpeg tele stdin closed");
              break;
            }
            this.logger.error?.("[CompositeStream] Error writing tele frame:", error);
          }
        }
      } catch (error) {
        if (this.active) {
          this.logger.error?.("[CompositeStream] Error in tele stream:", error);
        }
      } finally {
        try {
          teleStdin.end();
        } catch {}
      }
    };

    // Start both feeds in parallel
    Promise.all([feedWider(), feedTele()]).catch((error) => {
      if (this.active) {
        this.logger.error?.("[CompositeStream] Error in frame processing:", error);
        this.emit("error", error);
      }
    });
  }

  /**
   * Stop the composite stream
   */
  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.logger.log?.("[CompositeStream] Stopping composite stream...");

    // Stop ffmpeg
    if (this.ffmpegProcess) {
      try {
        this.ffmpegProcess.stdin?.end();
        this.ffmpegProcess.kill("SIGTERM");
        setTimeout(() => {
          try {
            this.ffmpegProcess?.kill("SIGKILL");
          } catch {}
        }, 1000);
      } catch {}
      this.ffmpegProcess = null;
    }

    // Native streams will be closed automatically when generators terminate
    this.widerStream = null;
    this.teleStream = null;

    this.logger.log?.("[CompositeStream] Composite stream stopped");
  }

  /**
   * Check if stream is active
   */
  isActive(): boolean {
    return this.active;
  }
}
