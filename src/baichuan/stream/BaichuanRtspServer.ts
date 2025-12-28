/**
 * Baichuan RTSP Server - Builds an RTSP server that serves a Baichuan video stream.
 * Inspired by neolink: receives frames from BaichuanVideoStream and serves them via RTSP.
 *
 * Reference: neolink uses GStreamer to build the RTSP server.
 * In Node.js, we can use ffmpeg (as done here) or a dedicated RTSP server implementation.
 */

import { BaichuanVideoStream, type BaichuanVideoStreamOptions } from "./BaichuanVideoStream.js";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { StreamProfile } from "../../reolink/baichuan/types.js";

const NAL_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const NAL_START_CODE_3B = Buffer.from([0x00, 0x00, 0x01]);
function hasAnnexBStart(data: Buffer): boolean {
  if (data.length < 4) return false;
  return data.subarray(0, 4).equals(NAL_START_CODE_4B) || data.subarray(0, 3).equals(NAL_START_CODE_3B);
}

export interface BaichuanRtspServerOptions {
  videoStream: BaichuanVideoStream;
  listenPort?: number;
  path?: string; // RTSP path (e.g. "/main" or "/sub")
}

/**
 * BaichuanRtspServer - RTSP server that serves a Baichuan video stream.
 *
 * Receives video frames from BaichuanVideoStream and serves them as RTSP.
 * Uses ffmpeg to build the RTSP stream from raw H.264 frames.
 *
 * Inspired by neolink: neolink uses GStreamer, here we use ffmpeg as an alternative.
 */
export class BaichuanRtspServer extends EventEmitter<{
  client: [string]; // Client connesso
  error: [Error];
  close: [];
}> {
  private videoStream: BaichuanVideoStream;
  private listenPort: number;
  private path: string;
  private ffmpegProcess: ReturnType<typeof spawn> | undefined;
  private active = false;
  private videoListener: ((unit: any) => void) | undefined;
  private seenKeyframe = false;
  private usingAccessUnit = false;

  constructor(options: BaichuanRtspServerOptions) {
    super();
    this.videoStream = options.videoStream;
    this.listenPort = options.listenPort ?? 8554;
    this.path = options.path ?? "/stream";
  }

  /**
   * Start RTSP server.
   * Starts ffmpeg which receives video frames and serves them as an RTSP stream.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("RTSP server already active");
    }

    // Start Baichuan video stream
    await this.videoStream.start();

    // Start ffmpeg to serve RTSP.
    // ffmpeg receives video frames via stdin and serves them over RTSP.
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "warning",
      "-fflags", "+genpts", // Generate PTS
      "-f", "h264", // Input format (H.264 Annex-B)
      "-i", "pipe:0", // Read from stdin
      "-c:v", "copy", // Copy video codec (no re-encoding)
      "-f", "rtsp", // RTSP output format
      "-rtsp_transport", "tcp", // Use TCP for RTSP (more reliable)
      "-rtsp_flags", "listen", // RTSP server listen mode
      `rtsp://127.0.0.1:${this.listenPort}${this.path}`, // RTSP URL
    ], {
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
    });

    this.ffmpegProcess = ffmpeg;

    // Send video frames to ffmpeg
    this.seenKeyframe = false;
    this.usingAccessUnit = false;
    this.videoListener = (unit: any) => {
      const data: Buffer = Buffer.isBuffer(unit) ? unit : unit?.data;
      const isKeyframeFromBuffer = (annexB: Buffer): boolean => {
        for (let i = 0; i < annexB.length; i++) {
          // 00 00 01
          if (
            i + 3 < annexB.length &&
            annexB[i] === 0x00 &&
            annexB[i + 1] === 0x00 &&
            annexB[i + 2] === 0x01
          ) {
            const nalHeader = annexB[i + 3];
            if (((nalHeader ?? 0) & 0x1f) === 5) return true; // IDR
          }
          // 00 00 00 01
          if (
            i + 4 < annexB.length &&
            annexB[i] === 0x00 &&
            annexB[i + 1] === 0x00 &&
            annexB[i + 2] === 0x00 &&
            annexB[i + 3] === 0x01
          ) {
            const nalHeader = annexB[i + 4];
            if (((nalHeader ?? 0) & 0x1f) === 5) return true; // IDR
          }
        }
        return false;
      };
      const isKeyframe: boolean = Buffer.isBuffer(unit) ? isKeyframeFromBuffer(data) : Boolean(unit?.isKeyframe);
      if (!Buffer.isBuffer(data)) return;

      if (!Buffer.isBuffer(unit)) {
        this.usingAccessUnit = true;
      } else if (this.usingAccessUnit) {
        return;
      }

      if (!this.seenKeyframe) {
        if (!isKeyframe) return;
        this.seenKeyframe = true;
        console.log(`[BaichuanRtspServer] ✅ Primo keyframe ricevuto: inizio a feedare ffmpeg`);
      }

      // Mitigazione: scarta frame non Annex-B per evitare corruzione/nero.
      if (!hasAnnexBStart(data)) {
        return;
      }

      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        try {
          ffmpeg.stdin.write(data);
        } catch (error) {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    this.videoStream.on("videoAccessUnit" as any, this.videoListener as any);
    this.videoStream.on("videoFrame", this.videoListener as any);

    // Gestisci output ffmpeg (stderr contiene log)
    let ffmpegOutput = "";
    let ffmpegReady = false;
    const serverUrl = `rtsp://127.0.0.1:${this.listenPort}${this.path}`;
    
    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      ffmpegOutput += output;
      
    // Log when ffmpeg is ready
      if (!ffmpegReady && (output.includes("Stream") || output.includes("rtsp") || output.includes("listening"))) {
        ffmpegReady = true;
        console.log(`[BaichuanRtspServer] ✅ FFmpeg RTSP server pronto: ${serverUrl}`);
      }
      
      // Log solo errori critici (non warning di decodifica H.264 che sono normali)
      // Gli errori "top block unavailable" e "error while decoding MB" sono warning normali
      // quando alcuni frame sono frammentati, non errori critici
      const isCriticalError = 
        (output.includes("error") || output.includes("Error") || output.includes("Invalid")) &&
        !output.includes("top block unavailable") &&
        !output.includes("error while decoding MB") &&
        !output.includes("concealing") &&
        !output.includes("left block unavailable") &&
        !output.includes("bottom block unavailable");
      
      if (isCriticalError) {
        console.error(`[BaichuanRtspServer] FFmpeg critical error: ${output.trim()}`);
        this.emit("error", new Error(`FFmpeg error: ${output}`));
      }
    });
    
    // Log when ffmpeg is ready (stdout)
    ffmpeg.stdout.on("data", (data) => {
      const output = data.toString();
      console.log(`[BaichuanRtspServer] FFmpeg stdout: ${output.trim()}`);
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        this.emit("error", new Error(`FFmpeg exited with code ${code}`));
      }
      this.active = false;
      this.emit("close");
    });

    this.active = true;
  }

  /**
   * Get RTSP URL for this stream.
   */
  getRtspUrl(): string {
    return `rtsp://127.0.0.1:${this.listenPort}${this.path}`;
  }

  /**
   * Stop RTSP server.
   */
  async stop(): Promise<void> {
    if (!this.active) return;

    // Ferma lo stream video
    await this.videoStream.stop();

    if (this.videoListener) {
      this.videoStream.removeListener("videoAccessUnit" as any, this.videoListener as any);
      this.videoStream.removeListener("videoFrame", this.videoListener as any);
    }
    this.videoListener = undefined;

    // Ferma ffmpeg
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill("SIGTERM");
    }
    this.ffmpegProcess = undefined;

    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }
}

/**
 * Helper function per creare uno stream RTSP da Baichuan.
 * 
 * @param options - Opzioni per lo stream video Baichuan
 * @param rtspPort - Porta RTSP (default: 8554)
 * @param rtspPath - Path RTSP (default: "/{profile}")
 */
export async function createBaichuanRtspStream(
  options: BaichuanVideoStreamOptions,
  rtspPort: number = 8554,
  rtspPath?: string
): Promise<BaichuanRtspServer> {
  const videoStream = new BaichuanVideoStream(options);
  const path = rtspPath ?? `/${options.profile}`;
  
  const server = new BaichuanRtspServer({
    videoStream,
    listenPort: rtspPort,
    path,
  });

  await server.start();
  return server;
}

