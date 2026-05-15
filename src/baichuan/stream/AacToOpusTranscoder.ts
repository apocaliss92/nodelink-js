/**
 * AAC ADTS → Opus transcoder for live WebRTC.
 *
 * Reolink cameras send audio as AAC LC (ADTS frames) over the Baichuan video
 * stream. WebRTC audio in browsers is Opus-only, so we shell out to ffmpeg to
 * decode AAC and re-encode to Opus. The transcoded Opus packets come back to
 * us as raw RTP via a UDP loopback — far simpler than parsing OGG pages or
 * relying on native bindings.
 *
 * Pipeline:
 *
 *   AAC frames ──stdin──▶ ffmpeg ──RTP/UDP──▶ this.socket
 *                          │
 *                          └─ -c:a libopus -ar 48000 -ac 2
 *                             -frame_duration 20 -f rtp
 *
 * For each RTP packet received, we strip the 12-byte RTP header, take the
 * Opus payload + the 32-bit timestamp ffmpeg generated, and forward it via
 * the consumer-supplied `onPacket` callback. The consumer (e.g.
 * BaichuanWebRTCServer) re-wraps the payload into an RTP packet with the
 * audio track's own SSRC and sequence number and calls `audioTrack.writeRtp()`.
 *
 * This keeps the transcoder decoupled from werift specifics and makes it
 * easy to unit test (the consumer can pass any onPacket handler).
 */

import { ChildProcess, spawn } from "node:child_process";
import { createSocket, Socket } from "node:dgram";
import { EventEmitter } from "node:events";

export interface AacToOpusTranscoderOptions {
  /** Path to the ffmpeg binary. Defaults to "ffmpeg" on PATH. */
  ffmpegPath?: string;
  /** Sample rate of the output Opus stream. Browsers require 48000. */
  opusSampleRate?: number;
  /** Channel count of the output Opus stream. */
  opusChannels?: 1 | 2;
  /** Opus frame duration in ms. 20 is the WebRTC default. */
  opusFrameMs?: 10 | 20 | 40 | 60;
  /** Opus target bitrate in bits/sec. 64k is decent for camera audio. */
  opusBitrate?: number;
  /** Optional logger for diagnostic messages. */
  logger?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

export interface OpusPacket {
  /** Raw Opus payload (no RTP header). */
  payload: Buffer;
  /** RTP timestamp ffmpeg assigned to the packet (48kHz clock). */
  timestamp: number;
  /** Marker bit from the originating RTP packet (rare for audio). */
  marker: boolean;
}

type Events = {
  packet: [OpusPacket];
  error: [Error];
  exit: [code: number | null];
};

export class AacToOpusTranscoder extends EventEmitter<Events> {
  private readonly opts: Required<Omit<AacToOpusTranscoderOptions, "logger">> &
    Pick<AacToOpusTranscoderOptions, "logger">;
  private socket: Socket | null = null;
  private ffmpeg: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(options: AacToOpusTranscoderOptions = {}) {
    super();
    this.opts = {
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      opusSampleRate: options.opusSampleRate ?? 48000,
      opusChannels: options.opusChannels ?? 2,
      opusFrameMs: options.opusFrameMs ?? 20,
      opusBitrate: options.opusBitrate ?? 64_000,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    };
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.opts.logger?.(level, `[AacToOpusTranscoder] ${message}`);
  }

  /**
   * Allocate the UDP loopback socket and spawn ffmpeg. Must be awaited before
   * the first call to `feedAac`.
   */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this._start();
    return this.starting;
  }

  private async _start(): Promise<void> {
    if (this.stopped) throw new Error("transcoder stopped");

    // 1) Bind a UDP socket on localhost. Port 0 lets the OS pick a free port.
    this.socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("error", reject);
      this.socket!.bind({ address: "127.0.0.1", port: 0 }, () => {
        this.socket!.removeListener("error", reject);
        this.port = (this.socket!.address() as { port: number }).port;
        resolve();
      });
    });
    this.log("info", `UDP loopback bound on 127.0.0.1:${this.port}`);

    this.socket.on("message", (rtpPacket) => this.handleRtp(rtpPacket));
    this.socket.on("error", (err) => {
      this.log("error", `socket error: ${err.message}`);
      this.emit("error", err);
    });

    // 2) Spawn ffmpeg. We use `-loglevel warning` to silence the per-frame
    // info chatter ffmpeg emits at info level.
    const args = [
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-f",
      "aac",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-ar",
      String(this.opts.opusSampleRate),
      "-ac",
      String(this.opts.opusChannels),
      "-application",
      "audio",
      "-frame_duration",
      String(this.opts.opusFrameMs),
      "-b:a",
      String(this.opts.opusBitrate),
      // Important: disable VBR so the output rate matches the configured
      // bitrate consistently — easier on the browser jitter buffer.
      "-vbr",
      "off",
      "-f",
      "rtp",
      `rtp://127.0.0.1:${this.port}`,
    ];
    this.log("info", `spawning ffmpeg with: ${this.opts.ffmpegPath} ${args.join(" ")}`);

    this.ffmpeg = spawn(this.opts.ffmpegPath, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    this.ffmpeg.on("error", (err) => {
      this.log("error", `ffmpeg spawn error: ${err.message}`);
      this.emit("error", err);
    });
    this.ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      // ffmpeg sends important warnings to stderr; surface at debug.
      this.log("debug", `ffmpeg stderr: ${chunk.toString().trim()}`);
    });
    this.ffmpeg.on("exit", (code) => {
      this.log(code === 0 ? "info" : "warn", `ffmpeg exited code=${code}`);
      this.emit("exit", code);
    });
  }

  /**
   * Feed one or more concatenated ADTS AAC frames to ffmpeg. Returns the
   * number of bytes written. Safe to call before a frame is fully buffered.
   */
  feedAac(buf: Buffer): boolean {
    if (this.stopped) return false;
    if (!this.ffmpeg?.stdin || !this.ffmpeg.stdin.writable) {
      this.log("debug", "drop AAC frame — ffmpeg stdin not writable");
      return false;
    }
    return this.ffmpeg.stdin.write(buf);
  }

  /**
   * Close stdin (ffmpeg exits cleanly on EOF) and tear down the UDP socket.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.ffmpeg?.stdin?.end();
    } catch {
      // ignore
    }
    if (this.ffmpeg && this.ffmpeg.exitCode === null) {
      // Give ffmpeg a moment to exit on stdin close before we kill it.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.ffmpeg?.kill("SIGKILL");
          resolve();
        }, 500);
        this.ffmpeg?.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.ffmpeg = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.log("info", "stopped");
  }

  /**
   * Parse an RTP packet ffmpeg emitted on the loopback socket and surface
   * its Opus payload. RTP header layout (RFC 3550):
   *
   *   0                   1                   2                   3
   *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
   *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   *  |V=2|P|X|  CC   |M|     PT      |       sequence number         |
   *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   *  |                           timestamp                           |
   *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   *  |           synchronization source (SSRC) identifier            |
   *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   *
   * We honor the CC, X (extension) and P (padding) bits to compute the
   * payload offset / length correctly even if ffmpeg ever emits those.
   */
  private handleRtp(packet: Buffer): void {
    if (packet.length < 12) return;
    const b0 = packet[0]!;
    const b1 = packet[1]!;
    const version = b0 >> 6;
    if (version !== 2) return;
    const padding = (b0 & 0x20) !== 0;
    const extension = (b0 & 0x10) !== 0;
    const csrcCount = b0 & 0x0f;
    const marker = (b1 & 0x80) !== 0;
    let offset = 12 + csrcCount * 4;
    if (extension) {
      if (packet.length < offset + 4) return;
      const extLen = packet.readUInt16BE(offset + 2);
      offset += 4 + extLen * 4;
    }
    let end = packet.length;
    if (padding) {
      const pad = packet[packet.length - 1]!;
      end -= pad;
    }
    if (offset >= end) return;

    const timestamp = packet.readUInt32BE(4);
    const payload = Buffer.from(packet.subarray(offset, end));
    this.emit("packet", { payload, timestamp, marker });
  }
}
