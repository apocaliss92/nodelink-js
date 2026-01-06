/**
 * Multifocal Camera Composite Stream
 * 
 * Combina gli stream di una telecamera multifocal (wider e tele) in un nuovo stream composito
 * con picture-in-picture (PIP) configurabile.
 * 
 * Utilizza ffmpeg per fare overlay del stream tele sul wider in varie posizioni.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { StreamProfile } from "../reolink/baichuan/types";
import type { Logger } from "../debug/DebugConfig";
import { createNativeStream } from "../scrypted/helpers";

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

export type CompositeStreamOptions = {
  api: ReolinkBaichuanApi;
  /** Channel per wider (solitamente 0) */
  widerChannel: number;
  /** Channel per tele (solitamente 1) */
  teleChannel: number;
  /** Profile per wider stream */
  widerProfile: StreamProfile;
  /** Profile per tele stream */
  teleProfile: StreamProfile;
  /** Posizione PIP del tele sul wider */
  pipPosition?: PipPosition;
  /** Dimensione relativa del PIP (0.1 = 10%, 0.3 = 30%, ecc.) */
  pipSize?: number;
  /** Margine dal bordo in pixel */
  pipMargin?: number;
  /** Logger opzionale */
  logger?: Logger;
};

/**
 * Calcola la posizione dell'overlay in base alla posizione PIP richiesta
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
 * CompositeStream - Combina stream wider e tele con PIP configurabile
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
   * Avvia il stream composito
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("Composite stream already active");
    }

    this.active = true;
    this.logger.log?.("[CompositeStream] Starting composite stream...");

    try {
      // Ottieni metadata per determinare risoluzioni
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

      // Avvia gli stream nativi
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

      // Avvia ffmpeg per composizione
      await this.startFfmpegComposition(mainWidth, mainHeight, pipWidth, pipHeight, position);

      this.logger.log?.("[CompositeStream] Composite stream started");
    } catch (error) {
      this.active = false;
      this.emit("error", error as Error);
      throw error;
    }
  }

  /**
   * Avvia ffmpeg per fare composizione con overlay
   */
  private async startFfmpegComposition(
    mainWidth: number,
    mainHeight: number,
    pipWidth: number,
    pipHeight: number,
    position: { x: number; y: number }
  ): Promise<void> {
    // Determina codec video (assumiamo H.264 per semplicità, potrebbe essere H.265)
    const widerMetadata = await this.options.api.getStreamMetadata(this.options.widerChannel);
    const widerStreamInfo = widerMetadata.streams.find((s) => s.profile === this.options.widerProfile);
    const videoCodec = widerStreamInfo?.videoEncType?.toLowerCase().includes("265") ? "hevc" : "h264";

    // ffmpeg args per composizione
    // Input 0: wider stream (main)
    // Input 1: tele stream (PIP)
    // Output: stream composito con overlay
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "error",
      "-fflags", "+genpts",
      // Input 0: wider stream (main)
      "-f", videoCodec === "hevc" ? "hevc" : "h264",
      "-i", "pipe:0",
      // Input 1: tele stream (PIP)
      "-f", videoCodec === "hevc" ? "hevc" : "h264",
      "-i", "pipe:1",
      // Filtro per scalare e posizionare il PIP
      "-filter_complex",
      `[1:v]scale=${pipWidth}:${pipHeight}[pip];[0:v][pip]overlay=${position.x}:${position.y}[out]`,
      "-map", "[out]",
      "-c:v", "libx264", // Ricodifica per garantire compatibilità
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-crf", "23",
      "-f", "h264",
      "pipe:2", // Output
    ];

    this.logger.log?.(
      `[CompositeStream] Starting ffmpeg: ${ffmpegArgs.join(" ")}`
    );

    this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Gestisci errori ffmpeg
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

    // Leggi output video composito
    this.ffmpegProcess.stdout?.on("data", (data: Buffer) => {
      this.emit("videoFrame", data);
    });

    // Leggi stderr per debug
    this.ffmpegProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("error") || output.includes("Error")) {
        this.logger.error?.("[CompositeStream] FFmpeg stderr:", output);
      }
    });

    // Feed frames agli input di ffmpeg
    this.feedFramesToFfmpeg();
  }

  /**
   * Feed frames dagli stream nativi a ffmpeg
   * Usa due loop separati per scrivere i frame in modo continuo
   */
  private async feedFramesToFfmpeg(): Promise<void> {
    if (!this.ffmpegProcess || !this.widerStream || !this.teleStream) {
      return;
    }

    const widerStdin = this.ffmpegProcess.stdio[0] as NodeJS.WritableStream | null;
    const teleStdin = this.ffmpegProcess.stdio[1] as NodeJS.WritableStream | null;

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

    // Avvia entrambi i feed in parallelo
    Promise.all([feedWider(), feedTele()]).catch((error) => {
      if (this.active) {
        this.logger.error?.("[CompositeStream] Error in frame processing:", error);
        this.emit("error", error);
      }
    });
  }

  /**
   * Ferma il stream composito
   */
  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.logger.log?.("[CompositeStream] Stopping composite stream...");

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

    // Gli stream nativi verranno chiusi automaticamente quando i generatori terminano
    this.widerStream = null;
    this.teleStream = null;

    this.logger.log?.("[CompositeStream] Composite stream stopped");
  }

  /**
   * Verifica se il stream è attivo
   */
  isActive(): boolean {
    return this.active;
  }
}

