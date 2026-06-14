// src/baichuan/stream/PlaceholderRenderer.ts
import { spawn } from "node:child_process";
import { Jimp, JimpMime, loadFont, measureText, measureTextHeight } from "jimp";
import { SANS_32_WHITE, SANS_64_WHITE, SANS_128_WHITE } from "jimp/fonts";
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
    // Dim the still by multiplying each RGB channel by `opacity` (0.5 = 50%
    // brightness). NOTE: do NOT use jimp's brightness() — in jimp v1 its
    // semantics changed and brightness(opacity-1) blacks out the whole frame
    // (e.g. brightness(-0.5) maps mid-gray to 0), which is why the placeholder
    // used to render as a black background with only the text visible.
    const op = Math.max(0, Math.min(1, this.opts.opacity));
    if (op < 1) {
      const data = image.bitmap.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i]! * op; // R
        data[i + 1] = data[i + 1]! * op; // G
        data[i + 2] = data[i + 2]! * op; // B
        // alpha (i+3) untouched
      }
    }
    // Scale the overlay font to the frame size and center it.
    const fontDef =
      image.width >= 1280
        ? SANS_128_WHITE
        : image.width >= 640
          ? SANS_64_WHITE
          : SANS_32_WHITE;
    const font = await loadFont(fontDef);
    const text = this.opts.text;
    const textWidth = measureText(font, text);
    const textHeight = measureTextHeight(font, text, image.width);
    const x = Math.max(0, Math.round((image.width - textWidth) / 2));
    const y = Math.max(0, Math.round((image.height - textHeight) / 2));
    image.print({ font, x, y, text });
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
