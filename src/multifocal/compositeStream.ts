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
  /** True when behind NVR/Hub (tele is selected via stream variant on the same channel). */
  onNvr?: boolean;
}

export type CompositeStreamOptions = {
  api: ReolinkBaichuanApi;
  /** Optional: dedicated API for wider stream (recommended on NVR/Hub). */
  widerApi?: ReolinkBaichuanApi;
  /** Optional: dedicated API for tele stream (recommended on NVR/Hub). */
  teleApi?: ReolinkBaichuanApi;
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
  /** True when behind NVR/Hub (tele is selected via stream variant on the same channel). */
  onNvr?: boolean;
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

  // ffmpeg stdout is an H.264 Annex-B byte stream; chunk boundaries are arbitrary.
  // We need to reassemble access units (frames) for RFC4571 packetization and keyframe priming.
  private ffmpegOutBuf: Buffer = Buffer.alloc(0);

  // Prime frames read before ffmpeg starts (used to infer codec + seed decoder).
  private widerPrimeFrame:
    | { data: Buffer; videoType?: "H264" | "H265"; isKeyframe?: boolean }
    | undefined;
  private telePrimeFrame:
    | { data: Buffer; videoType?: "H264" | "H265"; isKeyframe?: boolean }
    | undefined;

  private ffmpegStderrLastLogAtMs = 0;
  private ffmpegStderrLogBurst = 0;

  private closeGenerator(gen: AsyncGenerator<any, void, unknown> | null): Promise<void> {
    if (!gen) return Promise.resolve();
    const r = (gen as any).return;
    if (typeof r !== 'function') return Promise.resolve();
    try {
      return Promise.resolve(r.call(gen)).then(() => undefined).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

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

  private async primeForFfmpeg(
    gen: AsyncGenerator<any, void, unknown>,
    timeoutMs: number,
    requireKeyframe: boolean,
  ): Promise<{ data: Buffer; videoType?: "H264" | "H265"; isKeyframe?: boolean } | undefined> {
    const start = Date.now();
    let first: { data: Buffer; videoType?: "H264" | "H265"; isKeyframe?: boolean } | undefined;

    while (Date.now() - start < timeoutMs) {
      const r = await Promise.race([
        gen.next(),
        new Promise<IteratorResult<any>>((resolve) => setTimeout(() => resolve({ value: undefined, done: false } as any), 250)),
      ]);

      if (!r || (r as any).done) return first;
      const v = (r as any).value;
      if (!v || v.audio) continue;
      if (!first) first = { data: v.data, videoType: v.videoType, isKeyframe: v.isKeyframe };
      if (v.isKeyframe) return { data: v.data, videoType: v.videoType, isKeyframe: v.isKeyframe };
    }

    return requireKeyframe ? undefined : first;
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
      const widerApi = this.options.widerApi ?? this.options.api;
      const teleApi = this.options.teleApi ?? this.options.api;

      // Get metadata to determine resolutions
      const widerMetadata = await widerApi.getStreamMetadata(this.options.widerChannel);
      const teleMetadata = await teleApi.getStreamMetadata(this.options.teleChannel);

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
      // On NVR/Hub, wider+tele are typically the same logical channel, and lens selection
      // happens via native stream variant (telephoto) rather than a separate channel.
      const teleIsVariantOnSameChannel =
        !!this.options.onNvr || this.options.teleChannel === this.options.widerChannel;

      // Wider stream.
      this.widerStream = createNativeStream(widerApi, this.options.widerChannel, this.options.widerProfile);
      this.teleStream = teleIsVariantOnSameChannel
        ? createNativeStream(teleApi, this.options.teleChannel, this.options.teleProfile, { variant: 'telephoto' })
        : createNativeStream(teleApi, this.options.teleChannel, this.options.teleProfile);

      // Prime both streams BEFORE starting ffmpeg. This makes codec detection resilient on NVR/Hub where
      // metadata may not reflect tele variant, and helps ffmpeg see a clean access unit early.
      // Prefer waiting for an IDR on both inputs (startup alignment). Fallback to any video frame if needed.
      this.widerPrimeFrame = await this.primeForFfmpeg(this.widerStream, 5000, true);
      this.telePrimeFrame = await this.primeForFfmpeg(this.teleStream, 5000, true);
      if (!this.widerPrimeFrame) {
        this.widerPrimeFrame = await this.primeForFfmpeg(this.widerStream, 2000, false);
      }
      if (!this.telePrimeFrame) {
        this.telePrimeFrame = await this.primeForFfmpeg(this.teleStream, 2000, false);
      }

      this.logger.log?.(
        `[CompositeStream] Prime: wider=${this.widerPrimeFrame?.isKeyframe ? 'keyframe' : (this.widerPrimeFrame ? 'frame' : 'none')}, tele=${this.telePrimeFrame?.isKeyframe ? 'keyframe' : (this.telePrimeFrame ? 'frame' : 'none')}`
      );

      const widerCodecFromFrames = this.widerPrimeFrame?.videoType === 'H265' ? 'hevc' : (this.widerPrimeFrame?.videoType === 'H264' ? 'h264' : undefined);
      const teleCodecFromFrames = this.telePrimeFrame?.videoType === 'H265' ? 'hevc' : (this.telePrimeFrame?.videoType === 'H264' ? 'h264' : undefined);

      // Start ffmpeg for composition
      await this.startFfmpegComposition(mainWidth, mainHeight, pipWidth, pipHeight, position, widerCodecFromFrames, teleCodecFromFrames);

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
    position: { x: number; y: number },
    widerCodecOverride?: "h264" | "hevc",
    teleCodecOverride?: "h264" | "hevc",
  ): Promise<void> {
    const widerApi = this.options.widerApi ?? this.options.api;
    const teleApi = this.options.teleApi ?? this.options.api;

    // Determine video codec from both streams
    // If metadata is not available or inaccurate, ffmpeg will auto-detect from stream data
    const widerMetadata = await widerApi.getStreamMetadata(this.options.widerChannel);
    const teleMetadata = await teleApi.getStreamMetadata(this.options.teleChannel);
    const widerStreamInfo = widerMetadata.streams.find((s) => s.profile === this.options.widerProfile);
    const teleStreamInfo = teleMetadata.streams.find((s) => s.profile === this.options.teleProfile);
    
    // Determine codec for each input stream.
    // Prefer real frame-derived codec, because on NVR/Hub tele variant can differ from metadata.
    const widerCodec = widerCodecOverride ?? (widerStreamInfo?.videoEncType?.toLowerCase().includes("265") ? "hevc" : "h264");
    const teleCodec = teleCodecOverride ?? (teleStreamInfo?.videoEncType?.toLowerCase().includes("265") ? "hevc" : "h264");
    
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
      `[0:v]scale=${mainWidth}:${mainHeight}[main];[1:v]scale=${pipWidth}:${pipHeight}[pip];[main][pip]overlay=${position.x}:${position.y}[out]`,
      "-map", "[out]",
      "-c:v", "libx264", // Re-encode for compatibility
      // Make the stream easy to join mid-flight: frequent IDRs + in-band headers + AUD.
      // Without this, a new client may wait many seconds for the next keyframe.
      "-g", "30",
      "-keyint_min", "30",
      "-sc_threshold", "0",
      "-x264-params", "aud=1:repeat-headers=1:keyint=30:min-keyint=30:scenecut=0",
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

    // Read composite video output.
    // IMPORTANT: stdout chunking is arbitrary; split by AUD (NAL type 9) into access units.
    this.ffmpegProcess.stdout?.on("data", (data: Buffer) => {
      this.onFfmpegStdoutData(data);
    });

    // Read stderr for debug
    this.ffmpegProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("error") || output.includes("Error")) {
        // Rate-limit: ffmpeg can spam decoder errors during corruption/resync.
        const now = Date.now();
        if (now - this.ffmpegStderrLastLogAtMs > 2000) {
          this.ffmpegStderrLastLogAtMs = now;
          this.ffmpegStderrLogBurst = 0;
        }
        if (this.ffmpegStderrLogBurst++ < 3) {
          this.logger.error?.("[CompositeStream] FFmpeg stderr:", output);
        }
      }
    });

    // Feed frames to ffmpeg inputs
    this.feedFramesToFfmpeg();
  }

  private onFfmpegStdoutData(data: Buffer) {
    if (!data?.length) return;

    // Append new bytes.
    this.ffmpegOutBuf = this.ffmpegOutBuf.length
      ? Buffer.concat([this.ffmpegOutBuf, data], this.ffmpegOutBuf.length + data.length)
      : data;

    // Prevent runaway buffering if AUDs are missing for any reason.
    const MAX_BUF = 8 * 1024 * 1024;
    if (this.ffmpegOutBuf.length > MAX_BUF) {
      // Try to resync: keep only the last 1MB.
      this.logger.warn?.(`[CompositeStream] ffmpeg stdout buffer grew too large (${this.ffmpegOutBuf.length} bytes); resyncing`);
      this.ffmpegOutBuf = this.ffmpegOutBuf.subarray(this.ffmpegOutBuf.length - 1024 * 1024);
    }

    const audPositions = this.findAudStartPositions(this.ffmpegOutBuf);
    if (!audPositions.length) return;

    // Discard anything before the first AUD for clean framing.
    if (audPositions[0]! > 0) {
      this.ffmpegOutBuf = this.ffmpegOutBuf.subarray(audPositions[0]!);
    }

    // Re-scan after trimming (positions change).
    const audPositions2 = this.findAudStartPositions(this.ffmpegOutBuf);
    if (audPositions2.length < 2) return;

    // Emit complete access units: [AUD_i .. AUD_{i+1}). Keep tail starting at last AUD.
    for (let i = 0; i < audPositions2.length - 1; i++) {
      const start = audPositions2[i]!;
      const end = audPositions2[i + 1]!;
      if (end > start) {
        const au = this.ffmpegOutBuf.subarray(start, end);
        this.emit("videoFrame", au);
      }
    }
    this.ffmpegOutBuf = this.ffmpegOutBuf.subarray(audPositions2[audPositions2.length - 1]!);
  }

  private findAudStartPositions(buf: Buffer): number[] {
    const positions: number[] = [];
    const len = buf.length;
    // Need at least start code + 1 byte header.
    if (len < 5) return positions;

    let i = 0;
    while (i < len - 4) {
      // Find Annex-B start code.
      let startCodeLen = 0;
      if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
        if (buf[i + 2] === 0x01) startCodeLen = 3;
        else if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) startCodeLen = 4;
      }

      if (!startCodeLen) {
        i++;
        continue;
      }

      const nalStart = i + startCodeLen;
      if (nalStart >= len) break;
      const nalHeader = buf[nalStart];
      if (nalHeader === undefined) break;
      const nalType = nalHeader & 0x1f;
      if (nalType === 9) {
        positions.push(i);
      }

      // Jump ahead to continue scan; still safe even if we land mid-NAL.
      i = nalStart;
    }

    return positions;
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
        if (this.widerPrimeFrame?.data) {
          try {
            const written = widerStdin.write(this.toAnnexB(this.widerPrimeFrame.data));
            this.widerPrimeFrame = undefined;
            if (!written) {
              await new Promise<void>((resolve) => {
                widerStdin.once("drain", () => resolve());
              });
            }
          } catch {
            // ignore
          }
        }
        for await (const frame of this.widerStream!) {
          if (!this.active) break;
          if (frame.audio) continue; // Skip audio frames

          try {
            const written = widerStdin.write(this.toAnnexB(frame.data));
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
        if (this.telePrimeFrame?.data) {
          try {
            const written = teleStdin.write(this.toAnnexB(this.telePrimeFrame.data));
            this.telePrimeFrame = undefined;
            if (!written) {
              await new Promise<void>((resolve) => {
                teleStdin.once("drain", () => resolve());
              });
            }
          } catch {
            // ignore
          }
        }
        for await (const frame of this.teleStream!) {
          if (!this.active) break;
          if (frame.audio) continue; // Skip audio frames

          try {
            const written = teleStdin.write(this.toAnnexB(frame.data));
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

  private toAnnexB(accessUnit: Buffer): Buffer {
    if (!accessUnit?.length) return accessUnit;

    // Already Annex-B if it starts with a start code.
    if (accessUnit.length >= 3 && accessUnit[0] === 0x00 && accessUnit[1] === 0x00) {
      if (accessUnit[2] === 0x01) return accessUnit;
      if (accessUnit.length >= 4 && accessUnit[2] === 0x00 && accessUnit[3] === 0x01) return accessUnit;
    }

    // Best-effort conversion of length-prefixed NAL units (AVCC/HVCC style) to Annex-B.
    // Many sources use 4-byte big-endian lengths per NAL.
    try {
      let off = 0;
      const parts: Buffer[] = [];
      while (off + 4 <= accessUnit.length) {
        const n = accessUnit.readUInt32BE(off);
        off += 4;
        if (!n || off + n > accessUnit.length) {
          return accessUnit;
        }
        parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
        parts.push(accessUnit.subarray(off, off + n));
        off += n;
      }
      if (!parts.length) return accessUnit;
      return Buffer.concat(parts);
    } catch {
      return accessUnit;
    }
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

    // Ensure native generators are terminated so their finally{} runs (stops BaichuanVideoStream + watchdog).
    // Setting fields to null is NOT enough: any running for-await loops will keep the generator alive.
    await Promise.all([
      this.closeGenerator(this.widerStream),
      this.closeGenerator(this.teleStream),
    ]);
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
