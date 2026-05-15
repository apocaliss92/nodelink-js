/**
 * Baichuan HLS Server - HLS streaming from Baichuan cameras
 *
 * Provides HLS (HTTP Live Streaming) output from Baichuan native video streams.
 * Uses ffmpeg to transcode H.265 to H.264 for browser compatibility, or copies H.264 directly.
 *
 * Architecture:
 * - Camera → Baichuan native stream → H.264/H.265 frames → ffmpeg → HLS segments
 *
 * Usage:
 * ```typescript
 * const hls = new BaichuanHlsServer({
 *   api: reolinkApi,
 *   channel: 0,
 *   profile: "main",
 *   outputDir: "/tmp/hls-output",
 * });
 *
 * // Start streaming
 * await hls.start();
 *
 * // Get playlist path
 * const playlistPath = hls.getPlaylistPath();
 *
 * // Stop streaming
 * await hls.stop();
 * ```
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../../reolink/baichuan/types";
import { createNativeStream } from "../../rfc/helpers";
import type { BaichuanVideoStream } from "./BaichuanVideoStream";
import { detectVideoCodecFromNal } from "./BcMediaAnnexBDecoder";
import { convertToAnnexB as convertH264ToAnnexB } from "./H264Converter";
import { convertToAnnexB as convertH265ToAnnexB } from "./H265Converter";

// ============================================================================
// Types
// ============================================================================

export type HlsCodec = "h264" | "h265";

export interface BaichuanHlsServerOptions {
  /** API instance (required) */
  api: ReolinkBaichuanApi;
  /** Channel number (required) */
  channel: number;
  /** Stream profile (required) */
  profile: StreamProfile;
  /** Native-only: TrackMix tele/autotrack variants */
  variant?: NativeVideoStreamVariant;
  /** Output directory for HLS segments. If not provided, a temp directory will be created. */
  outputDir?: string;
  /** HLS segment duration in seconds (default: 2) */
  segmentDuration?: number;
  /** Number of segments to keep in playlist (default: 5) */
  playlistSize?: number;
  /** ffmpeg binary path (default: "ffmpeg") */
  ffmpegPath?: string;
  /**
   * External video stream from a shared pool (e.g. createRfc4571TcpServer).
   * When provided, the HLS server subscribes to this stream's events instead
   * of creating its own via createNativeStream. This allows multiple outputs
   * (MJPEG, HLS, WebRTC) to share a single camera streaming session.
   */
  externalVideoStream?: BaichuanVideoStream;
  /** Logger callback */
  logger?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;
}

export interface HlsServerStatus {
  state: "idle" | "starting" | "running" | "stopping" | "stopped" | "error";
  codec: HlsCodec | null;
  framesReceived: number;
  ffmpegRunning: boolean;
  playlistPath: string | null;
  outputDir: string | null;
  startedAt: Date | null;
  error: string | null;
}

// ============================================================================
// NAL Unit Parsing Utilities
// ============================================================================

function parseAnnexBNalUnits(data: Buffer): Buffer[] {
  const units: Buffer[] = [];
  const len = data.length;

  const findStart = (from: number): number => {
    for (let i = from; i + 3 < len; i++) {
      if (data[i] === 0x00 && data[i + 1] === 0x00) {
        if (data[i + 2] === 0x01) return i;
        if (i + 4 < len && data[i + 2] === 0x00 && data[i + 3] === 0x01)
          return i;
      }
    }
    return -1;
  };

  const startCodeLenAt = (i: number): number => {
    if (i + 3 < len && data[i] === 0x00 && data[i + 1] === 0x00) {
      if (data[i + 2] === 0x01) return 3;
      if (i + 4 < len && data[i + 2] === 0x00 && data[i + 3] === 0x01) return 4;
    }
    return 0;
  };

  let start = findStart(0);
  if (start < 0) return units;

  while (start >= 0) {
    const scLen = startCodeLenAt(start);
    if (!scLen) break;
    const nalStart = start + scLen;
    let next = findStart(nalStart);
    if (next < 0) next = len;
    if (nalStart < next) units.push(data.subarray(nalStart, next));
    start = next < len ? next : -1;
  }

  return units;
}

/**
 * Check if frame is a true keyframe (IDR/CRA/BLA) that can start decoding.
 * Parameter sets alone (SPS/PPS/VPS) are NOT enough - we need an actual intra frame.
 *
 * H.265 Random Access Points:
 * - IDR_W_RADL (19), IDR_N_LP (20): Instantaneous Decoder Refresh
 * - CRA_NUT (21): Clean Random Access
 * - BLA_W_LP (16), BLA_W_RADL (17), BLA_N_LP (18): Broken Link Access
 */
function isKeyframeAnnexB(codec: HlsCodec, annexB: Buffer): boolean {
  const nals = parseAnnexBNalUnits(annexB);

  for (const nal of nals) {
    if (!nal || nal.length === 0) continue;
    if (codec === "h264") {
      const nalType = nal[0]! & 0x1f;
      // IDR = 5
      if (nalType === 5) return true;
    } else {
      const nalType = (nal[0]! >> 1) & 0x3f;
      // H.265 Random Access Point NAL types: 16-21
      if (nalType >= 16 && nalType <= 21) return true;
    }
  }

  return false;
}

/**
 * Check if frame contains parameter sets
 */
function hasParamSets(codec: HlsCodec, annexB: Buffer): boolean {
  const nals = parseAnnexBNalUnits(annexB);
  for (const nal of nals) {
    if (!nal || nal.length === 0) continue;
    if (codec === "h264") {
      const nalType = nal[0]! & 0x1f;
      if (nalType === 7 || nalType === 8) return true;
    } else {
      const nalType = (nal[0]! >> 1) & 0x3f;
      if (nalType === 32 || nalType === 33 || nalType === 34) return true;
    }
  }
  return false;
}

/**
 * Get NAL types from Annex-B data for debugging
 */
function getNalTypes(codec: HlsCodec, annexB: Buffer): number[] {
  const nals = parseAnnexBNalUnits(annexB);
  return nals.map((nal) => {
    if (codec === "h265") {
      return (nal[0]! >> 1) & 0x3f;
    } else {
      return nal[0]! & 0x1f;
    }
  });
}

// ============================================================================
// BaichuanHlsServer Class
// ============================================================================

export class BaichuanHlsServer extends EventEmitter {
  private readonly api: ReolinkBaichuanApi;
  private readonly channel: number;
  private readonly profile: StreamProfile;
  private readonly variant: NativeVideoStreamVariant | undefined;
  private readonly segmentDuration: number;
  private readonly playlistSize: number;
  private readonly ffmpegPath: string;
  private readonly externalVideoStream: BaichuanVideoStream | undefined;
  private readonly log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;

  private outputDir: string | null = null;
  private createdTempDir: boolean = false;
  private playlistPath: string | null = null;
  private segmentPattern: string | null = null;

  private state: HlsServerStatus["state"] = "idle";
  private codec: HlsCodec | null = null;
  private framesReceived: number = 0;
  private ffmpeg: ChildProcess | null = null;
  private nativeStream: AsyncGenerator<any, void, unknown> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private startedAt: Date | null = null;
  private lastError: string | null = null;

  constructor(options: BaichuanHlsServerOptions) {
    super();
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.variant = options.variant ?? undefined;
    this.segmentDuration = options.segmentDuration ?? 2;
    this.playlistSize = options.playlistSize ?? 5;
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";

    if (options.outputDir) {
      this.outputDir = options.outputDir;
      this.createdTempDir = false;
    }

    this.externalVideoStream = options.externalVideoStream;
    this.log = options.logger ?? (() => {});
  }

  /**
   * Start HLS streaming
   */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return;
    }

    this.state = "starting";
    this.lastError = null;

    try {
      // Create output directory if needed
      if (!this.outputDir) {
        this.outputDir = await fsp.mkdtemp(
          path.join(os.tmpdir(), `nodelink-hls-${this.profile}-`),
        );
        this.createdTempDir = true;
      } else {
        await fsp.mkdir(this.outputDir, { recursive: true });
      }

      this.playlistPath = path.join(this.outputDir, "playlist.m3u8");
      this.segmentPattern = path.join(this.outputDir, "segment_%05d.ts");

      this.log("info", `Starting HLS stream to ${this.outputDir}`);

      // Use external video stream if provided (shared pool), otherwise create our own.
      if (this.externalVideoStream) {
        this.nativeStream = this.wrapVideoStreamAsGenerator(this.externalVideoStream);
      } else {
        // createNativeStream automatically acquires a dedicated socket from the pool.
        this.nativeStream = createNativeStream(
          this.api,
          this.channel,
          this.profile,
          this.variant ? { variant: this.variant } : undefined,
        );
      }

      // Start pumping frames to ffmpeg
      this.pumpPromise = this.pumpNativeToFfmpeg();
      this.startedAt = new Date();
      this.state = "running";

      this.emit("started", { outputDir: this.outputDir });
    } catch (err) {
      this.state = "error";
      this.lastError = String(err);
      this.log("error", `Failed to start HLS: ${err}`);
      throw err;
    }
  }

  /**
   * Stop HLS streaming
   */
  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") {
      return;
    }

    this.state = "stopping";
    this.log("info", "Stopping HLS stream");

    // Close ffmpeg stdin
    try {
      this.ffmpeg?.stdin?.end();
    } catch {
      // ignore
    }

    // Kill ffmpeg
    try {
      this.ffmpeg?.kill("SIGKILL");
    } catch {
      // ignore
    }
    this.ffmpeg = null;

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
    if (this.pumpPromise) {
      try {
        await this.pumpPromise;
      } catch {
        // ignore
      }
      this.pumpPromise = null;
    }

    // Clean up temp directory if we created it
    if (this.createdTempDir && this.outputDir) {
      try {
        await fsp.rm(this.outputDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    this.state = "stopped";
    this.emit("stopped");
  }

  /**
   * Get current status
   */
  getStatus(): HlsServerStatus {
    return {
      state: this.state,
      codec: this.codec,
      framesReceived: this.framesReceived,
      ffmpegRunning: this.ffmpeg !== null && !this.ffmpeg.killed,
      playlistPath: this.playlistPath,
      outputDir: this.outputDir,
      startedAt: this.startedAt,
      error: this.lastError,
    };
  }

  /**
   * Get playlist file path
   */
  getPlaylistPath(): string | null {
    return this.playlistPath;
  }

  /**
   * Get output directory
   */
  getOutputDir(): string | null {
    return this.outputDir;
  }

  /**
   * Check if playlist file exists
   */
  async waitForPlaylist(timeoutMs: number = 20000): Promise<boolean> {
    if (!this.playlistPath) return false;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(this.playlistPath)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  /**
   * Read an HLS asset (playlist or segment)
   */
  async readAsset(
    assetName: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    if (!this.outputDir) return null;

    // Validate asset name (security)
    const safe = assetName.replace(/^\/+/, "");
    if (safe.includes("..") || safe.includes("/")) {
      return null;
    }

    const filePath = path.join(this.outputDir, safe);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = await fsp.readFile(filePath);
    let contentType = "application/octet-stream";
    if (safe.endsWith(".m3u8")) {
      contentType = "application/vnd.apple.mpegurl";
    } else if (safe.endsWith(".ts")) {
      contentType = "video/mp2t";
    }

    return { data, contentType };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Wrap a BaichuanVideoStream's videoAccessUnit events into an async generator
   * compatible with createNativeStream's output format.
   */
  private async *wrapVideoStreamAsGenerator(
    videoStream: BaichuanVideoStream,
  ): AsyncGenerator<{
    audio: boolean;
    data: Buffer;
    videoType?: "H264" | "H265";
    isKeyframe?: boolean;
    microseconds: number | null;
  }, void, unknown> {
    type Frame = {
      data: Buffer;
      isKeyframe: boolean;
      videoType: "H264" | "H265";
      microseconds: number;
    };

    const queue: Frame[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const onFrame = (au: Frame) => {
      queue.push(au);
      resolve?.();
      resolve = null;
    };

    const onClose = () => {
      done = true;
      resolve?.();
      resolve = null;
    };

    const onError = () => {
      done = true;
      resolve?.();
      resolve = null;
    };

    videoStream.on("videoAccessUnit", onFrame);
    videoStream.on("close", onClose);
    videoStream.on("error", onError);

    try {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>((r) => { resolve = r; });
        }
        while (queue.length > 0) {
          const frame = queue.shift()!;
          yield {
            audio: false,
            data: frame.data,
            videoType: frame.videoType,
            isKeyframe: frame.isKeyframe,
            microseconds: frame.microseconds,
          };
        }
      }
    } finally {
      videoStream.removeListener("videoAccessUnit", onFrame);
      videoStream.removeListener("close", onClose);
      videoStream.removeListener("error", onError);
    }
  }

  private async pumpNativeToFfmpeg(): Promise<void> {
    if (!this.nativeStream || !this.playlistPath || !this.segmentPattern) {
      return;
    }

    let startedFfmpeg = false;
    let pendingParamSets: Buffer[] = [];
    const MAX_FRAMES_WAIT_FOR_KEYFRAME = 180;

    const collectParamSets = (codec: HlsCodec, annexB: Buffer) => {
      const nals = parseAnnexBNalUnits(annexB);
      for (const nal of nals) {
        if (!nal || nal.length === 0) continue;
        if (codec === "h264") {
          const t = nal[0]! & 0x1f;
          if (t === 7 || t === 8) {
            pendingParamSets.push(
              Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]),
            );
          }
        } else {
          const t = (nal[0]! >> 1) & 0x3f;
          if (t === 32 || t === 33 || t === 34) {
            pendingParamSets.push(
              Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]),
            );
          }
        }
      }
      if (pendingParamSets.length > 12) {
        pendingParamSets = pendingParamSets.slice(-12);
      }
    };

    try {
      for await (const frame of this.nativeStream) {
        if (this.state !== "running") break;

        // Only video
        if (frame.audio) continue;
        if (!frame.data || frame.data.length === 0) continue;

        // Detect codec
        if (!this.codec) {
          const detected = detectVideoCodecFromNal(frame.data);
          const fromMeta: HlsCodec =
            frame.videoType === "H265" ? "h265" : "h264";
          this.codec = detected
            ? (detected.toLowerCase() as HlsCodec)
            : fromMeta;
          this.log(
            "info",
            `HLS codec detected: meta=${fromMeta} detected=${detected} (using ${this.codec})`,
          );
          this.emit("codec-detected", { codec: this.codec });
        }

        // Convert to Annex-B
        const annexB =
          this.codec === "h265"
            ? convertH265ToAnnexB(frame.data)
            : convertH264ToAnnexB(frame.data);

        this.framesReceived++;

        // Debug logging for first frames and periodically
        const shouldLog =
          this.framesReceived <= 5 ||
          (this.framesReceived <= 60 && this.framesReceived % 10 === 0);
        if (shouldLog) {
          const nalTypes = getNalTypes(this.codec, annexB);
          const hasIdr = isKeyframeAnnexB(this.codec, annexB);
          const hasParams = hasParamSets(this.codec, annexB);
          this.log(
            "debug",
            `HLS frame#${this.framesReceived}: bytes=${annexB.length} nalTypes=[${nalTypes.join(",")}] hasIDR=${hasIdr} hasParams=${hasParams}`,
          );
        }

        collectParamSets(this.codec, annexB);

        // Only start ffmpeg on a TRUE keyframe (IDR for H.264, IDR/CRA/BLA for H.265)
        // "Logical keyframes" (VPS/SPS/PPS + TRAIL) don't work because TRAIL frames
        // reference previous frames that we don't have.
        const isKeyframe = isKeyframeAnnexB(this.codec, annexB);

        // Wait for keyframe before starting ffmpeg
        if (!isKeyframe && !startedFfmpeg) {
          if (this.framesReceived < MAX_FRAMES_WAIT_FOR_KEYFRAME) {
            continue;
          }
          this.log(
            "warn",
            `No keyframe after ${this.framesReceived} frames, starting ffmpeg anyway`,
          );
        }

        if (!startedFfmpeg) {
          this.log(
            "info",
            `Starting ffmpeg: codec=${this.codec} framesSeen=${this.framesReceived} isKeyframe=${isKeyframe} paramSets=${pendingParamSets.length}`,
          );
          this.ffmpeg = this.spawnFfmpeg();
          startedFfmpeg = true;
          this.emit("ffmpeg-started");

          // Prepend parameter sets
          try {
            if (this.ffmpeg?.stdin && !this.ffmpeg.stdin.destroyed) {
              for (const ps of pendingParamSets) {
                this.ffmpeg.stdin.write(ps);
              }
            }
          } catch {
            // ignore
          }
        }

        if (!this.ffmpeg || !this.ffmpeg.stdin || this.ffmpeg.stdin.destroyed) {
          this.log("warn", "ffmpeg stdin not available, stopping pump");
          break;
        }

        try {
          this.ffmpeg.stdin.write(annexB);
          // Log progress periodically
          if (
            this.framesReceived % 100 === 0 ||
            this.framesReceived <= 5 ||
            (this.framesReceived <= 50 && this.framesReceived % 10 === 0)
          ) {
            this.log(
              "debug",
              `HLS fed frame #${this.framesReceived} to ffmpeg (${annexB.length} bytes)`,
            );
          }
        } catch (err) {
          this.log("error", `Failed to write to ffmpeg: ${err}`);
          break;
        }
      }
    } catch (e) {
      this.log("error", `HLS pump error: ${e}`);
      this.lastError = String(e);
      this.state = "error";
      this.emit("error", e);
    }
  }

  private spawnFfmpeg(): ChildProcess {
    if (!this.playlistPath || !this.segmentPattern) {
      throw new Error("Playlist path not set");
    }

    const codec = this.codec ?? "h264";

    const args: string[] = [
      "-hide_banner",
      "-loglevel",
      "warning",
      // `+genpts` makes ffmpeg generate uniform PTS from the declared `-r`
      // when the raw H.264/H.265 input has none. We deliberately do NOT use
      // `-use_wallclock_as_timestamps 1` here: it replaces the generated
      // PTS with the host wallclock at FRAME ARRIVAL time, and because the
      // camera ships frames in bursty network reads, the resulting PTS
      // sequence is uneven. With `-r 25` (or anything else) forcing a
      // target rate downstream, ffmpeg then drops/duplicates frames to
      // match — visible as the periodic stutter / pulsing reported on
      // local-restreamer recordings (issue #11).
      "-fflags",
      "+genpts",
      "-r",
      "25",
      "-f",
      codec === "h265" ? "hevc" : "h264",
      "-i",
      "pipe:0",
    ];

    if (codec === "h265") {
      // Transcode H.265 to H.264 for browser compatibility
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
      );
    } else {
      // Copy H.264 directly
      args.push("-c:v", "copy");
    }

    args.push(
      "-f",
      "hls",
      "-hls_time",
      String(this.segmentDuration),
      "-hls_list_size",
      String(this.playlistSize),
      "-hls_flags",
      "delete_segments+append_list+omit_endlist",
      "-hls_segment_filename",
      this.segmentPattern,
      this.playlistPath,
    );

    const p = spawn(this.ffmpegPath, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    p.on("error", (err) => {
      this.log("error", `ffmpeg spawn error: ${err}`);
      this.emit("ffmpeg-error", err);
    });

    p.stderr?.on("data", (d) => {
      const s = String(d ?? "").trim();
      if (s) this.log("warn", `[ffmpeg] ${s}`);
    });

    p.on("exit", (code, signal) => {
      this.log(
        "warn",
        `ffmpeg exited (code=${code ?? "?"} signal=${signal ?? "?"})`,
      );
      this.emit("ffmpeg-exited", { code, signal });
    });

    return p;
  }
}
