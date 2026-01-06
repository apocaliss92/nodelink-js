/**
 * RTSP Server per stream composito multifocal
 * 
 * Espone un server RTSP che serve lo stream composito (wider + tele con PIP)
 * come un nuovo stream "rtp" configurabile.
 */

import { BaichuanRtspServer } from "../baichuan/stream/BaichuanRtspServer";
import { CompositeStream, type CompositeStreamOptions, type PipPosition } from "./compositeStream";
import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { StreamProfile } from "../reolink/baichuan/types";
import type { Logger } from "../debug/DebugConfig";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import * as net from "node:net";

export type CompositeRtspServerOptions = {
  api: ReolinkBaichuanApi;
  widerChannel: number;
  teleChannel: number;
  widerProfile: StreamProfile;
  teleProfile: StreamProfile;
  pipPosition?: PipPosition;
  pipSize?: number;
  pipMargin?: number;
  listenHost?: string;
  listenPort?: number;
  path?: string;
  logger?: Logger;
};

/**
 * RTSP Server che serve uno stream composito multifocal
 * 
 * Utilizza ffmpeg per creare un server RTSP che legge dallo stream composito
 */
export class CompositeRtspServer extends EventEmitter<{
  client: [string];
  clientDisconnected: [string];
  error: [Error];
  close: [];
}> {
  private options: CompositeRtspServerOptions;
  private compositeStream: CompositeStream | null = null;
  private rtspServer: net.Server | null = null;
  private ffmpegProcess: ReturnType<typeof spawn> | null = null;
  private active = false;
  private logger: Logger;
  private connectedClients = new Set<string>();

  constructor(options: CompositeRtspServerOptions) {
    super();
    this.options = {
      listenHost: "127.0.0.1",
      listenPort: 8554,
      path: "/composite",
      ...options,
    };
    this.logger = options.logger ?? console;
  }

  /**
   * Avvia il server RTSP composito
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("Composite RTSP server already active");
    }

    this.active = true;
    this.logger.log?.("[CompositeRtspServer] Starting composite RTSP server...");

    try {
      // Crea e avvia composite stream
      this.compositeStream = new CompositeStream({
        api: this.options.api,
        widerChannel: this.options.widerChannel,
        teleChannel: this.options.teleChannel,
        widerProfile: this.options.widerProfile,
        teleProfile: this.options.teleProfile,
        ...(this.options.pipPosition ? { pipPosition: this.options.pipPosition } : {}),
        ...(this.options.pipSize !== undefined ? { pipSize: this.options.pipSize } : {}),
        ...(this.options.pipMargin !== undefined ? { pipMargin: this.options.pipMargin } : {}),
        logger: this.logger,
      });

      this.compositeStream.on("error", (error) => {
        this.logger.error?.("[CompositeRtspServer] Composite stream error:", error);
        this.emit("error", error);
      });

      this.compositeStream.on("close", () => {
        this.logger.log?.("[CompositeRtspServer] Composite stream closed");
      });

      await this.compositeStream.start();

      // Avvia server RTSP che legge dallo stream composito
      await this.startRtspServer();

      this.logger.log?.(
        `[CompositeRtspServer] Server started on ${this.options.listenHost}:${this.options.listenPort}${this.options.path}`
      );
    } catch (error) {
      this.active = false;
      this.emit("error", error as Error);
      throw error;
    }
  }

  /**
   * Avvia server RTSP usando ffmpeg
   */
  private async startRtspServer(): Promise<void> {
    // Ottieni metadata per determinare risoluzione output
    const widerMetadata = await this.options.api.getStreamMetadata(this.options.widerChannel);
    const widerStreamInfo = widerMetadata.streams.find((s) => s.profile === this.options.widerProfile);
    const width = widerStreamInfo?.width ?? 1920;
    const height = widerStreamInfo?.height ?? 1080;
    const fps = widerStreamInfo?.frameRate ?? 25;

    // Avvia server RTSP TCP
    this.rtspServer = net.createServer((socket) => {
      this.handleRtspConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.rtspServer!.listen(this.options.listenPort, this.options.listenHost, () => {
        const address = this.rtspServer!.address();
        if (address && typeof address === "object" && "port" in address) {
          (this.options as any).listenPort = address.port;
        }
        resolve();
      });
      this.rtspServer!.on("error", reject);
    });

    // Avvia ffmpeg RTSP server che legge dallo stream composito
    this.startFfmpegRtspServer(width, height, fps);
  }

  /**
   * Avvia ffmpeg come server RTSP che legge dallo stream composito
   */
  private startFfmpegRtspServer(width: number, height: number, fps: number): void {
    const rtspUrl = `rtsp://${this.options.listenHost}:${this.options.listenPort}${this.options.path}`;

    // ffmpeg legge H.264 da stdin e lo serve come RTSP
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "h264",
      "-i", "pipe:0",
      "-c:v", "copy",
      "-f", "rtsp",
      "-rtsp_flags", "listen",
      rtspUrl,
    ];

    this.logger.log?.(
      `[CompositeRtspServer] Starting ffmpeg RTSP server: ${ffmpegArgs.join(" ")}`
    );

    this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.ffmpegProcess.on("error", (error) => {
      this.logger.error?.("[CompositeRtspServer] FFmpeg error:", error);
      this.emit("error", error);
    });

    this.ffmpegProcess.on("close", (code) => {
      if (code !== 0 && code !== null) {
        this.logger.warn?.(`[CompositeRtspServer] FFmpeg exited with code ${code}`);
      }
    });

    // Feed frames compositi a ffmpeg
    this.compositeStream!.on("videoFrame", (frame: Buffer) => {
      if (this.ffmpegProcess?.stdin && !this.ffmpegProcess.stdin.destroyed) {
        try {
          const written = this.ffmpegProcess.stdin.write(frame);
          if (!written) {
            this.ffmpegProcess.stdin.once("drain", () => {});
          }
        } catch (error) {
          const code = (error as any)?.code;
          if (code !== "EPIPE" && code !== "ERR_STREAM_WRITE_AFTER_END") {
            this.logger.error?.("[CompositeRtspServer] Error writing to ffmpeg:", error);
          }
        }
      }
    });

    // Log stderr per debug
    this.ffmpegProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("error") || output.includes("Error")) {
        this.logger.error?.("[CompositeRtspServer] FFmpeg stderr:", output);
      }
    });
  }

  /**
   * Gestisce connessioni RTSP (semplificato - delega a ffmpeg)
   */
  private handleRtspConnection(socket: net.Socket): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.log?.(`[CompositeRtspServer] RTSP client connected: ${clientId}`);
    this.connectedClients.add(clientId);
    this.emit("client", clientId);

    socket.on("close", () => {
      this.connectedClients.delete(clientId);
      this.emit("clientDisconnected", clientId);
      this.logger.log?.(`[CompositeRtspServer] RTSP client disconnected: ${clientId}`);
    });

    socket.on("error", (error) => {
      this.logger.error?.(`[CompositeRtspServer] RTSP client error:`, error);
    });

    // Nota: ffmpeg gestisce il protocollo RTSP, quindi qui potremmo solo fare proxy
    // oppure lasciare che ffmpeg gestisca tutto direttamente
    // Per semplicità, lasciamo che ffmpeg gestisca tutto
  }

  /**
   * Ferma il server RTSP composito
   */
  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.logger.log?.("[CompositeRtspServer] Stopping server...");

    // Ferma composite stream
    if (this.compositeStream) {
      await this.compositeStream.stop();
      this.compositeStream = null;
    }

    // Ferma ffmpeg
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

    // Chiudi server RTSP
    if (this.rtspServer) {
      await new Promise<void>((resolve) => {
        this.rtspServer?.close(() => resolve());
      });
      this.rtspServer = null;
    }

    this.connectedClients.clear();
    this.emit("close");
    this.logger.log?.("[CompositeRtspServer] Server stopped");
  }

  /**
   * Ottieni URL RTSP
   */
  getRtspUrl(): string {
    return `rtsp://${this.options.listenHost}:${this.options.listenPort}${this.options.path}`;
  }

  /**
   * Verifica se il server è attivo
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Numero di client connessi
   */
  getClientCount(): number {
    return this.connectedClients.size;
  }
}

