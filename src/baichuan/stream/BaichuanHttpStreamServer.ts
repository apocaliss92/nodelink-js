/**
 * Baichuan HTTP Stream Server - Serves a Baichuan video stream over HTTP (MPEG-TS).
 * A simpler alternative to an RTSP server.
 *
 * Inspired by neolink: neolink uses GStreamer for RTSP; here we use HTTP for simplicity.
 */

import { BaichuanVideoStream } from "./BaichuanVideoStream";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import * as http from "node:http";
import type { Logger } from "../../debug/DebugConfig";

export interface BaichuanHttpStreamServerOptions {
  videoStream: BaichuanVideoStream;
  listenPort?: number;
  path?: string; // HTTP path (es. "/main" o "/sub")
  /**
   * Input FPS to help ffmpeg generate PTS/DTS when the input is raw H.264.
   * Defaults to 25 if not provided.
   */
  inputFps?: number;
  logger?: Logger;
}

const NAL_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const NAL_START_CODE_3B = Buffer.from([0x00, 0x00, 0x01]);

function hasAnnexBStart(data: Buffer): boolean {
  if (data.length < 4) return false;
  return data.subarray(0, 4).equals(NAL_START_CODE_4B) || data.subarray(0, 3).equals(NAL_START_CODE_3B);
}

function splitAnnexBNals(annexB: Buffer): Buffer[] {
  // Returns NAL payloads without start codes.
  // Supports both 3B and 4B start codes.
  const starts: Array<{ idx: number; len: number }> = [];
  for (let i = 0; i < annexB.length - 3; i++) {
    if (annexB[i] === 0x00 && annexB[i + 1] === 0x00) {
      if (annexB[i + 2] === 0x01) {
        starts.push({ idx: i, len: 3 });
        i += 2;
      } else if (annexB[i + 2] === 0x00 && annexB[i + 3] === 0x01) {
        starts.push({ idx: i, len: 4 });
        i += 3;
      }
    }
  }
  if (starts.length === 0) return [];

  const out: Buffer[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s]!;
    const payloadStart = start.idx + start.len;
    const next = starts[s + 1];
    const payloadEnd = next ? next.idx : annexB.length;
    if (payloadEnd > payloadStart) out.push(annexB.subarray(payloadStart, payloadEnd));
  }
  return out;
}

function h264NalType(nalPayload: Buffer): number | null {
  if (nalPayload.length < 1) return null;
  const b0 = nalPayload[0];
  if (b0 === undefined) return null;
  return b0 & 0x1f;
}

function isH264KeyframeFromAnnexB(annexB: Buffer): boolean {
  const nals = splitAnnexBNals(annexB);
  for (const nal of nals) {
    const t = h264NalType(nal);
    if (t === 5) return true; // IDR
  }
  return false;
}

/**
 * BaichuanHttpStreamServer - HTTP server that serves a Baichuan video stream as MPEG-TS.
 *
 * Receives video frames from BaichuanVideoStream and streams them as HTTP MPEG-TS.
 * Uses ffmpeg to mux raw H.264 into MPEG-TS.
 */
export class BaichuanHttpStreamServer extends EventEmitter<{
  client: [string]; // Connected client
  error: [Error];
  close: [];
}> {
  private videoStream: BaichuanVideoStream;
  private listenPort: number;
  private path: string;  private logger: Logger;  private inputFps: number;
  private httpServer: http.Server | undefined;
  private ffmpegProcess: ReturnType<typeof spawn> | undefined;
  private active = false;
  private clients = new Set<http.ServerResponse>();
  private videoListener:
    | ((data: Buffer) => void)
    | ((unit: { data: Buffer; isKeyframe: boolean }) => void)
    | undefined;
  private usingAccessUnit = false;
  private seenKeyframe = false;
  private cachedSps: Buffer | null = null; // payload without start code
  private cachedPps: Buffer | null = null; // payload without start code

  constructor(options: BaichuanHttpStreamServerOptions) {
    super();
    this.videoStream = options.videoStream;
    this.listenPort = options.listenPort ?? 8080;
    this.path = options.path ?? "/stream";
    this.inputFps = options.inputFps ?? 25;
    this.logger = options.logger ?? console;
  }
  
  /**
   * Start HTTP stream server.
   * Starts an HTTP server that serves an MPEG-TS stream.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("HTTP stream server already active");
    }

    this.logger.info(`[BaichuanHttpStreamServer] Starting Baichuan video stream...`);
    // Start the Baichuan video stream.
    await this.videoStream.start();
    this.logger.info(`[BaichuanHttpStreamServer] Baichuan video stream started`);

    // Crea server HTTP
    this.httpServer = http.createServer((req, res) => {
      if (req.url === this.path || req.url === `${this.path}.ts`) {
        this.logger.info(`[BaichuanHttpStreamServer] New client connected: ${req.socket.remoteAddress}`);
        this.clients.add(res);
        this.emit("client", req.socket.remoteAddress || "unknown");

        // Set headers for MPEG-TS streaming.
        res.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        // Remove the client when it disconnects.
        req.on("close", () => {
          this.clients.delete(res);
          this.logger.info(`[BaichuanHttpStreamServer] Client disconnected`);
        });
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    // Start HTTP server.
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.listenPort, "127.0.0.1", () => {
        this.logger.info(`[BaichuanHttpStreamServer] HTTP server listening on port ${this.listenPort}`);
        resolve();
      });
      this.httpServer!.on("error", reject);
    });

    // Avvia ffmpeg per convertire H.264 in MPEG-TS e inviare ai client
    this.logger.info(`[BaichuanHttpStreamServer] Starting ffmpeg for H.264 -> MPEG-TS conversion...`);
    
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      // ffmpeg warnings often include non-fatal decode messages (e.g. decode_slice_header),
      // which we don't want to treat as application errors.
      "-loglevel", "error",
      // Force a known frame rate on raw H.264 input so the muxer gets valid PTS/DTS.
      "-r", String(this.inputFps),
      "-fflags", "+genpts",
      "-use_wallclock_as_timestamps", "1",
      "-f", "h264", // Input format (H.264 Annex-B)
      "-i", "pipe:0", // Read from stdin
      "-c:v", "copy", // Copy video codec (no re-encoding)
      "-muxpreload", "0",
      "-muxdelay", "0",
      "-f", "mpegts", // Output format MPEG-TS
      "pipe:1", // Scrive su stdout
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.ffmpegProcess = ffmpeg;
    this.logger.info(`[BaichuanHttpStreamServer] FFmpeg process started (PID: ${ffmpeg.pid})`);

    // Feed video frames to ffmpeg.
    let frameCount = 0;
    const writeToFfmpeg = (videoData: Buffer) => {
      // Guardrail: if we feed non-Annex-B "frames", ffmpeg errors and the result is a black/corrupted video.
      // Until we have perfect P-frame parsing, drop non-Annex-B payloads.
      if (!hasAnnexBStart(videoData)) {
        return;
      }
      frameCount++;
      if (frameCount === 1) {
        this.logger.info(`[BaichuanHttpStreamServer] First video frame received (${videoData.length} bytes)`);
      }
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        try {
          ffmpeg.stdin.write(videoData);
        } catch (error) {
          this.logger.error(`[BaichuanHttpStreamServer] Error writing frame: ${error}`);
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    // Prefer the richer event (keyframe metadata), but keep compatibility with `videoFrame`.
    this.seenKeyframe = false;
    this.usingAccessUnit = false;
    this.cachedSps = null;
    this.cachedPps = null;

    this.videoListener = (unit: any) => {
      const data: Buffer = Buffer.isBuffer(unit) ? unit : unit?.data;
      const isKeyframe: boolean = Buffer.isBuffer(unit) ? isH264KeyframeFromAnnexB(data) : Boolean(unit?.isKeyframe);
      if (!Buffer.isBuffer(data)) return;

    // Avoid double-feeding: BaichuanVideoStream emits both `videoFrame` and `videoAccessUnit`.
    // If we are receiving `videoAccessUnit`, ignore `videoFrame` (Buffer) callbacks.
      if (!Buffer.isBuffer(unit)) {
        this.usingAccessUnit = true;
      } else if (this.usingAccessUnit) {
        return;
      }

      // Cache SPS/PPS (H.264) if present in the access unit.
      const nals = splitAnnexBNals(data);
      for (const nal of nals) {
        const t = h264NalType(nal);
        if (t === 7) this.cachedSps = nal;
        if (t === 8) this.cachedPps = nal;
      }

      // Do not feed ffmpeg until we see a keyframe: avoids starting on P-frames.
      if (!this.seenKeyframe) {
        if (!isKeyframe) return;
        this.seenKeyframe = true;
        this.logger.info(`[BaichuanHttpStreamServer] First keyframe received: starting ffmpeg feed`);
      }

      // If we have cached SPS/PPS, prepend them before keyframes for robustness (some muxers/players require it).
      if (isKeyframe && this.cachedSps && this.cachedPps) {
        // Avoid duplicates if already present
        let hasSps = false;
        let hasPps = false;
        for (const nal of nals) {
          const t = h264NalType(nal);
          if (t === 7) hasSps = true;
          if (t === 8) hasPps = true;
        }
        if (!hasSps || !hasPps) {
          const patched = Buffer.concat([
            NAL_START_CODE_4B, this.cachedSps,
            NAL_START_CODE_4B, this.cachedPps,
            data,
          ]);
          writeToFfmpeg(patched);
          return;
        }
      }

      writeToFfmpeg(data);
    };

    // Register both: if `videoAccessUnit` arrives we will use it; `videoFrame` remains for compatibility.
    this.videoStream.on("videoAccessUnit" as any, this.videoListener as any);
    this.videoStream.on("videoFrame", this.videoListener as any);

    // Broadcast ffmpeg MPEG-TS output to HTTP clients.
    ffmpeg.stdout.on("data", (data: Buffer) => {
      // Send to all connected clients.
      for (const client of this.clients) {
        if (!client.destroyed) {
          try {
            client.write(data);
          } catch (error) {
            // Client disconnected; remove it.
            this.clients.delete(client);
          }
        }
      }
    });

    // Handle ffmpeg stderr.
    let ffmpegOutput = "";
    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      ffmpegOutput += output;
      
      // With -loglevel error we only get errors here, but many are still "non-fatal"
      // during startup or on corrupted frames. Avoid crashing the app (unhandled 'error' event).
      const isKnownNonFatal =
        output.includes("top block unavailable") ||
        output.includes("error while decoding") ||
        output.includes("decode_slice_header error") ||
        output.includes("no frame") ||
        output.includes("concealing") ||
        output.includes("left block unavailable") ||
        output.includes("bottom block unavailable");

      if (isKnownNonFatal) {
        // Track but do not emit 'error'
        this.logger.warn(`[BaichuanHttpStreamServer] FFmpeg decode warning: ${output.trim()}`);
        return;
      }

      // Truly critical errors (invalid input / broken pipe / muxer failure).
      const isCriticalError =
        output.includes("Invalid data found") ||
        output.includes("Error opening") ||
        output.includes("Could not write header") ||
        output.includes("Broken pipe") ||
        output.includes("Connection refused") ||
        output.includes("Immediate exit") ||
        output.includes("Conversion failed");

      if (isCriticalError) {
        this.logger.error(`[BaichuanHttpStreamServer] FFmpeg critical error: ${output.trim()}`);
        // Emit 'error' only for truly terminal conditions.
        this.emit("error", new Error(`FFmpeg error: ${output}`));
      } else {
        this.logger.warn(`[BaichuanHttpStreamServer] FFmpeg stderr: ${output.trim()}`);
      }
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        this.logger.error(`[BaichuanHttpStreamServer] FFmpeg exited with code ${code}`);
        this.emit("error", new Error(`FFmpeg exited with code ${code}`));
      }
      this.active = false;
      this.emit("close");
    });

    this.active = true;
  }

  /**
   * Get HTTP URL for this stream.
   */
  getStreamUrl(): string {
    return `http://127.0.0.1:${this.listenPort}${this.path}.ts`;
  }

  /**
   * Stop HTTP stream server.
   */
  async stop(): Promise<void> {
    // Stop must be idempotent: even if `active` is already false (e.g. ffmpeg crashed),
    // dobbiamo comunque chiudere server/socket e killare processi per permettere a Node di uscire.

    // Chiudi tutti i client
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.end();
      }
    }
    this.clients.clear();

    // Ferma lo stream video
    try {
      await this.videoStream.stop();
    } catch {
      // ignore
    }

    // Rimuovi listener per evitare leak tra start/stop
    if (this.videoListener) {
      this.videoStream.removeListener("videoAccessUnit" as any, this.videoListener as any);
      this.videoStream.removeListener("videoFrame", this.videoListener as any);
    }
    this.videoListener = undefined;

    // Ferma ffmpeg
    if (this.ffmpegProcess) {
      const proc = this.ffmpegProcess;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      // If it doesn't exit, force SIGKILL so it doesn't hang.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 1500);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        (t as any)?.unref?.();
        proc.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.ffmpegProcess = undefined;

    // Ferma server HTTP
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        // best-effort: close connections and then the server (modern Node versions)
        (this.httpServer as any)?.closeAllConnections?.();
        (this.httpServer as any)?.closeIdleConnections?.();
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }

    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }
}

