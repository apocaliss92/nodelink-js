/**
 * Baichuan RTSP Server - Costruisce un server RTSP che serve stream video Baichuan
 * Basato su neolink: riceve frame video da BaichuanVideoStream e li serve come RTSP
 * 
 * Reference: neolink utilizza GStreamer per costruire il server RTSP
 * Per Node.js, possiamo usare node-rtsp-stream o costruire un server RTSP custom
 */

import { BaichuanVideoStream, type BaichuanVideoStreamOptions } from "./BaichuanVideoStream.js";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { StreamProfile } from "../../reolink/baichuan/types.js";

export interface BaichuanRtspServerOptions {
  videoStream: BaichuanVideoStream;
  listenPort?: number;
  path?: string; // RTSP path (es. "/main" o "/sub")
}

/**
 * BaichuanRtspServer - Server RTSP che serve stream video Baichuan
 * 
 * Riceve frame video da BaichuanVideoStream e li serve come stream RTSP.
 * Utilizza ffmpeg per costruire lo stream RTSP dai frame video.
 * 
 * Basato su neolink: neolink usa GStreamer, qui usiamo ffmpeg come alternativa.
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

  constructor(options: BaichuanRtspServerOptions) {
    super();
    this.videoStream = options.videoStream;
    this.listenPort = options.listenPort ?? 8554;
    this.path = options.path ?? "/stream";
  }

  /**
   * Start RTSP server.
   * Avvia ffmpeg che riceve frame video e li serve come stream RTSP.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("RTSP server already active");
    }

    // Avvia lo stream video Baichuan
    await this.videoStream.start();

    // Avvia ffmpeg per servire lo stream RTSP
    // ffmpeg riceve frame video via stdin e li serve come RTSP
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "h264", // Input format (H.264, potrebbe essere H.265)
      "-i", "pipe:0", // Legge da stdin
      "-c:v", "copy", // Copy video codec (no re-encoding)
      "-f", "rtsp", // Output format RTSP
      `rtsp://127.0.0.1:${this.listenPort}${this.path}`, // RTSP URL
    ]);

    this.ffmpegProcess = ffmpeg;

    // Invia frame video a ffmpeg
    this.videoStream.on("videoFrame", (videoData: Buffer) => {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        try {
          ffmpeg.stdin.write(videoData);
        } catch (error) {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    // Gestisci output ffmpeg (stderr contiene log)
    let ffmpegOutput = "";
    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      ffmpegOutput += output;
      // Log solo errori critici
      if (output.includes("error") || output.includes("Error") || output.includes("Invalid")) {
        console.error(`[BaichuanRtspServer] FFmpeg: ${output.trim()}`);
        this.emit("error", new Error(`FFmpeg error: ${output}`));
      }
    });
    
    // Log quando ffmpeg è pronto
    ffmpeg.stdout.on("data", (data) => {
      const output = data.toString();
      if (output.includes("Stream") || output.includes("rtsp")) {
        console.log(`[BaichuanRtspServer] FFmpeg: ${output.trim()}`);
      }
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

