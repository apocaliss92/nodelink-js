// src/baichuan/stream/PlaceholderRenderer.ts
import { spawn } from "node:child_process";
import { Jimp, JimpMime, loadFont } from "jimp";
import { SANS_32_WHITE } from "jimp/fonts";
import type { PlaceholderOptions } from "./alwaysOnTypes";
import { ALWAYS_ON_DEFAULTS } from "./alwaysOnTypes";

export interface CachedKeyframe {
  data: Buffer;
  videoType: "H264" | "H265";
}

export interface Logger {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
  debug?: (...a: unknown[]) => void;
}

/** Maps the internal video type to the ffmpeg demuxer/encoder identifiers. */
function ffmpegCodec(videoType: "H264" | "H265"): {
  inputFormat: string;
  encoder: string;
  outputFormat: string;
} {
  if (videoType === "H265") {
    return {
      inputFormat: "hevc",
      encoder: "libx265",
      outputFormat: "hevc",
    };
  }
  return {
    inputFormat: "h264",
    encoder: "libx264",
    outputFormat: "h264",
  };
}

/** Spawns ffmpeg, writes `input` to stdin, resolves with the collected stdout buffer. */
function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", (error) => reject(error));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });

    const stdin = proc.stdin;
    if (!stdin) {
      reject(new Error("ffmpeg stdin not available"));
      return;
    }
    stdin.on("error", (error) => reject(error));
    stdin.end(input);
  });
}

export class PlaceholderRenderer {
  private readonly opts: Required<PlaceholderOptions>;
  private readonly logger: Logger | undefined;

  constructor(args: { placeholder?: PlaceholderOptions; logger?: Logger }) {
    this.opts = { ...ALWAYS_ON_DEFAULTS.placeholder, ...(args.placeholder ?? {}) };
    this.logger = args.logger;
  }

  /** Returns the access unit bytes to emit as placeholder, or null if none available. */
  async render(keyframe: CachedKeyframe | null): Promise<Buffer | null> {
    if (!keyframe) return null;
    if (!this.opts.enabled) return keyframe.data;

    try {
      const jpeg = await this.decodeToJpeg(keyframe);
      const decorated = await this.decorate(jpeg);
      const idr = await this.encodeIdr(decorated, keyframe.videoType);
      if (!idr || idr.length === 0) {
        throw new Error("ffmpeg produced empty IDR output");
      }
      return idr;
    } catch (error) {
      this.logger?.warn?.(
        "PlaceholderRenderer: decoration failed, falling back to raw keyframe",
        error instanceof Error ? error.message : error,
      );
      return keyframe.data;
    }
  }

  /** Decodes the cached keyframe access unit into a single JPEG still via ffmpeg. */
  private async decodeToJpeg(keyframe: CachedKeyframe): Promise<Buffer> {
    const { inputFormat } = ffmpegCodec(keyframe.videoType);
    return runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        inputFormat,
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-f",
        "mjpeg",
        "pipe:1",
      ],
      keyframe.data,
    );
  }

  /** Dims the still and prints the overlay text using jimp, returning a JPEG buffer. */
  private async decorate(jpeg: Buffer): Promise<Buffer> {
    const image = await Jimp.read(jpeg);
    // opacity is "1 = original brightness"; brightness() takes a delta where
    // negative values darken. opacity 0.5 -> brightness(-0.5).
    const delta = Math.max(0, Math.min(1, this.opts.opacity)) - 1;
    if (delta !== 0) {
      image.brightness(delta);
    }
    const font = await loadFont(SANS_32_WHITE);
    image.print({ font, x: 10, y: 10, text: this.opts.text });
    return image.getBuffer(JimpMime.jpeg);
  }

  /** Encodes the decorated JPEG into a single IDR access unit in the target codec. */
  private async encodeIdr(jpeg: Buffer, videoType: "H264" | "H265"): Promise<Buffer> {
    // NOTE: do NOT apply a *_mp4toannexb bitstream filter here. That BSF is for
    // demuxing MP4/AVCC -> Annex-B; the `-f h264`/`-f hevc` elementary-stream
    // muxer already emits Annex-B. Applying it is a no-op for H264 but CORRUPTS
    // H265 output (silently falling back to raw for every H265 camera).
    const { encoder, outputFormat } = ffmpegCodec(videoType);
    return runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-c:v",
        encoder,
        "-pix_fmt",
        "yuv420p",
        "-f",
        outputFormat,
        "pipe:1",
      ],
      jpeg,
    );
  }
}
