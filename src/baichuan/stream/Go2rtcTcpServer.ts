/**
 * Go2rtcTcpServer — Lightweight TCP server that feeds raw Annex-B video
 * (H.264 / H.265) and ADTS AAC audio frames to go2rtc via a plain TCP
 * connection.
 *
 * go2rtc configuration example:
 *   streams:
 *     camera_main: tcp://127.0.0.1:{port}
 *
 * go2rtc auto-detects the codec from the bitstream (SPS/PPS/VPS NALUs).
 *
 * Lifecycle:
 *   1. Server starts listening immediately on the configured port.
 *   2. When the first TCP client connects the native camera stream is started.
 *   3. Frames are fan-out to every connected client (go2rtc typically opens
 *      one connection, but multiple are supported).
 *   4. When the last client disconnects a grace period runs before stopping
 *      the native stream (avoids thrashing on rapid reconnects).
 *   5. A prebuffer ring keeps the last few seconds of frames so new clients
 *      get IDR-aligned fast startup without waiting for the next keyframe.
 */

import { EventEmitter } from "node:events";
import * as net from "node:net";
import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../../reolink/baichuan/types";
import type { Logger } from "../../debug/DebugConfig";
import { createNativeStream } from "../../rfc/helpers";
import { convertToAnnexB as convertH264ToAnnexB } from "./H264Converter";
import {
  convertToAnnexB as convertH265ToAnnexB,
  isH265Irap,
  splitAnnexBToNalPayloads,
} from "./H265Converter";

// ---------------------------------------------------------------------------
// Bounded queue (same as BaichuanRtspServer, kept local to avoid coupling)
// ---------------------------------------------------------------------------

class AsyncBoundedQueue<T> {
  private readonly maxItems: number;
  private readonly queue: T[] = [];
  private waiting:
    | { resolve: (r: IteratorResult<T>) => void }
    | undefined;
  private closed = false;

  constructor(maxItems: number) {
    this.maxItems = Math.max(1, maxItems | 0);
  }

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
      return;
    }
    this.queue.push(item);
    if (this.queue.length > this.maxItems) {
      this.queue.splice(0, this.queue.length - this.maxItems);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as any, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.closed) return { value: undefined as any, done: true };
    const item = this.queue.shift();
    if (item !== undefined) return { value: item, done: false };
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.waiting = { resolve };
    });
  }
}

// ---------------------------------------------------------------------------
// NativeStreamFanout (same pattern as BaichuanRtspServer)
// ---------------------------------------------------------------------------

type NativeFrame = {
  audio: boolean;
  data: Buffer;
  codec: string | null;
  sampleRate: number | null;
  microseconds: number | null;
  videoType?: "H264" | "H265";
  isKeyframe?: boolean;
};

type FanoutOptions = {
  maxQueueItems: number;
  createSource: () => AsyncGenerator<NativeFrame, void, unknown>;
  onFrame?: (frame: NativeFrame) => void;
  onError?: (error: unknown) => void;
  onEnd?: () => void;
};

class NativeStreamFanout {
  private readonly opts: FanoutOptions;
  private readonly queues = new Map<string, AsyncBoundedQueue<NativeFrame>>();
  private source: AsyncGenerator<NativeFrame, void, unknown> | null = null;
  private running = false;
  private pumpPromise: Promise<void> | null = null;

  constructor(opts: FanoutOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.source = this.opts.createSource();

    this.pumpPromise = (async () => {
      try {
        for await (const frame of this.source!) {
          try {
            this.opts.onFrame?.(frame);
          } catch {
            // ignore observer errors
          }
          for (const q of this.queues.values()) {
            q.push(frame);
          }
        }
      } catch (e) {
        this.opts.onError?.(e);
      } finally {
        for (const q of this.queues.values()) q.close();
        this.queues.clear();
        this.running = false;
        this.opts.onEnd?.();
      }
    })();
  }

  subscribe(id: string): AsyncGenerator<NativeFrame, void, unknown> {
    const q = new AsyncBoundedQueue<NativeFrame>(this.opts.maxQueueItems);
    this.queues.set(id, q);
    const self = this;
    return (async function* () {
      try {
        while (true) {
          const r = await q.next();
          if (r.done) return;
          yield r.value;
        }
      } finally {
        q.close();
        self.queues.delete(id);
      }
    })();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const src = this.source;
    this.source = null;
    for (const q of this.queues.values()) q.close();
    this.queues.clear();
    try {
      await src?.return(undefined as any);
    } catch {
      // ignore
    }
    try {
      await this.pumpPromise;
    } catch {
      // ignore
    }
    this.pumpPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Prebuffer entry
// ---------------------------------------------------------------------------

interface PrebufferEntry {
  /** Annex-B (video) or ADTS (audio) buffer ready to write on the wire. */
  data: Buffer;
  time: number;
  isKeyframe: boolean;
  audio: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface Go2rtcTcpServerOptions {
  /** API instance (required). */
  api: ReolinkBaichuanApi;
  /** Channel number (required). */
  channel: number;
  /** Stream profile (required). */
  profile: StreamProfile;
  /** TrackMix tele/autotrack variant. */
  variant?: NativeVideoStreamVariant;
  /** Host to listen on (default: "127.0.0.1"). */
  listenHost?: string;
  /** Port to listen on (default: 0 = OS picks). */
  listenPort?: number;
  /** Logger. */
  logger?: Logger;
  /**
   * External identifier for dedicated socket session.
   * When provided, a dedicated BaichuanClient is created for the stream,
   * isolating it from other streams on the shared socket.
   */
  deviceId?: string;
  /** Grace period in ms before stopping native stream after last client disconnects (default: 30 000). */
  gracePeriodMs?: number;
  /** Maximum prebuffer window in ms (default: 3 000). */
  prebufferMs?: number;
  /** Maximum write buffer per client before dropping the connection (default: 100 MB). */
  maxBufferBytes?: number;
  /**
   * Stream inactivity timeout in ms. If no frames arrive from the native
   * stream for this duration, the stream is considered dead and will be
   * torn down + restarted (similar to go2rtc's per-packet read deadline).
   * Default: 15 000 (15s). Set to 0 to disable.
   */
  streamTimeoutMs?: number;
  /**
   * When true, the native camera stream is started immediately on start()
   * rather than waiting for the first TCP client. This ensures frames are
   * already flowing (and the prebuffer is warm) when go2rtc connects.
   * Default: true.
   */
  prestartStream?: boolean;
}

// ---------------------------------------------------------------------------
// Go2rtcTcpServer
// ---------------------------------------------------------------------------

export class Go2rtcTcpServer extends EventEmitter<{
  client: [string];
  clientDisconnected: [string];
  error: [Error];
  close: [];
  listening: [{ host: string; port: number }];
}> {
  private readonly api: ReolinkBaichuanApi;
  private readonly channel: number;
  private readonly profile: StreamProfile;
  private readonly variant: NativeVideoStreamVariant;
  private readonly listenHost: string;
  private readonly listenPort: number;
  private readonly logger: Logger;
  private readonly deviceId: string | undefined;
  private readonly gracePeriodMs: number;
  private readonly prebufferMaxMs: number;
  private readonly maxBufferBytes: number;
  private readonly streamTimeoutMs: number;
  private readonly prestartStream: boolean;

  private active = false;
  private server: net.Server | undefined;
  private resolvedPort: number | undefined;

  // Native stream
  private nativeFanout: NativeStreamFanout | null = null;
  private nativeStreamActive = false;
  private dedicatedSessionRelease: (() => Promise<void>) | undefined;
  private detectedVideoType: "H264" | "H265" | undefined;

  // Client tracking
  private connectedClients = new Set<string>();
  private clientSockets = new Map<string, net.Socket>();
  private stopGraceTimer: ReturnType<typeof setTimeout> | undefined;

  // Stream health monitoring
  private lastFrameAt = 0;
  private streamHealthTimer: ReturnType<typeof setInterval> | undefined;
  private totalFramesReceived = 0;
  private totalVideoFramesWritten = 0;

  // Prebuffer
  private prebuffer: PrebufferEntry[] = [];

  constructor(options: Go2rtcTcpServerOptions) {
    super();
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.variant = options.variant ?? "default";
    this.listenHost = options.listenHost ?? "127.0.0.1";
    this.listenPort = options.listenPort ?? 0;
    this.logger = options.logger ?? console;
    this.deviceId = options.deviceId;
    this.gracePeriodMs = options.gracePeriodMs ?? 30_000;
    this.prebufferMaxMs = options.prebufferMs ?? 3_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 100_000_000;
    this.streamTimeoutMs = options.streamTimeoutMs ?? 15_000;
    this.prestartStream = options.prestartStream ?? true;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start listening. Resolves once the TCP server is bound. */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    this.server = net.createServer((socket) => this.handleClient(socket));
    this.server.on("error", (err) => {
      this.logger.error?.(`[Go2rtcTcpServer] server error: ${err.message}`);
      this.emit("error", err);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.listenPort, this.listenHost, () => {
        const addr = this.server!.address() as net.AddressInfo;
        this.resolvedPort = addr.port;
        this.logger.info?.(
          `[Go2rtcTcpServer] listening on ${addr.address}:${addr.port}  channel=${this.channel} profile=${this.profile}`,
        );
        this.emit("listening", { host: addr.address, port: addr.port });
        resolve();
      });
      this.server!.once("error", reject);
    });

    // Pre-start the native camera stream so the prebuffer is warm when go2rtc
    // connects. Without this, go2rtc connects → sees no data → disconnects.
    if (this.prestartStream) {
      this.logger.info?.(
        `[Go2rtcTcpServer] pre-starting native stream  channel=${this.channel} profile=${this.profile}`,
      );
      this.startNativeStream();
    }
  }

  /** Stop the server and all active streams. */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.stopGraceTimer);
    this.stopStreamHealthMonitor();

    // Close all client sockets
    for (const [id, sock] of this.clientSockets) {
      sock.destroy();
      this.connectedClients.delete(id);
    }
    this.clientSockets.clear();

    // Stop native stream
    await this.stopNativeStream();

    // Close TCP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }

    this.prebuffer = [];
    this.resolvedPort = undefined;
    this.emit("close");
  }

  /** The actual port the server is listening on (available after start()). */
  get port(): number | undefined {
    return this.resolvedPort;
  }

  /** The go2rtc-compatible source URL. */
  get go2rtcSourceUrl(): string | undefined {
    if (this.resolvedPort == null) return undefined;
    return `tcp://127.0.0.1:${this.resolvedPort}`;
  }

  /** Number of currently connected clients. */
  get clientCount(): number {
    return this.connectedClients.size;
  }

  // -----------------------------------------------------------------------
  // Client handling
  // -----------------------------------------------------------------------

  private handleClient(socket: net.Socket): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    socket.setNoDelay(true);

    this.connectedClients.add(clientId);
    this.clientSockets.set(clientId, socket);
    this.logger.info?.(
      `[Go2rtcTcpServer] client connected  id=${clientId} total=${this.connectedClients.size}`,
    );
    this.emit("client", clientId);

    // Cancel any pending grace-period stop
    if (this.stopGraceTimer) {
      clearTimeout(this.stopGraceTimer);
      this.stopGraceTimer = undefined;
    }

    // Ensure native stream is running
    if (!this.nativeStreamActive) {
      this.startNativeStream();
    }

    // Feed this client
    this.feedClient(clientId, socket).catch((err) => {
      this.logger.warn?.(
        `[Go2rtcTcpServer] feedClient error  id=${clientId}: ${err}`,
      );
    });

    const cleanup = (reason?: string) => {
      this.removeClient(clientId, reason);
      socket.destroy();
    };
    socket.on("error", (err) => cleanup(`error: ${err.message}`));
    socket.on("close", (hadError) => cleanup(hadError ? "close (with error)" : "close (clean)"));
  }

  private async feedClient(clientId: string, socket: net.Socket): Promise<void> {
    // Wait for the fanout to be ready — for on-demand (battery) cameras this
    // may take several seconds while the camera wakes up and the stream starts.
    const fanoutDeadline = Date.now() + 30_000; // 30s max wait
    while (this.active && !this.nativeFanout) {
      if (socket.destroyed) return;
      if (Date.now() > fanoutDeadline) {
        this.logger.warn?.(
          `[Go2rtcTcpServer] fanout not ready after 30s, dropping client ${clientId}`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.active || !this.nativeFanout) return;

    const subscription = this.nativeFanout.subscribe(clientId);

    // ---- Prebuffer replay: send from last IDR onwards ----
    const prebufferSnap = this.prebuffer.slice();
    let lastIdrIdx = -1;
    for (let i = prebufferSnap.length - 1; i >= 0; i--) {
      if (prebufferSnap[i]!.isKeyframe) {
        lastIdrIdx = i;
        break;
      }
    }
    if (lastIdrIdx >= 0) {
      const replay = prebufferSnap.slice(lastIdrIdx);
      this.logger.info?.(
        `[Go2rtcTcpServer] prebuffer replay  client=${clientId} frames=${replay.length}`,
      );
      for (const entry of replay) {
        if (socket.destroyed) return;
        socket.write(entry.data);
      }
    }

    // ---- Live frames ----
    let seenKeyframe = lastIdrIdx >= 0; // already replayed one if prebuffer had IDR
    let liveFrameCount = 0;
    let liveVideoWritten = 0;
    let lastLogAt = Date.now();
    try {
      this.logger.info?.(
        `[Go2rtcTcpServer] entering live loop  client=${clientId} seenKeyframe=${seenKeyframe}`,
      );
      for await (const frame of subscription) {
        if (socket.destroyed || !this.active) {
          this.logger.info?.(
            `[Go2rtcTcpServer] live loop exit  client=${clientId} destroyed=${socket.destroyed} active=${this.active}`,
          );
          break;
        }

        liveFrameCount++;

        const annexB = this.convertFrame(frame);
        if (!annexB) continue;

        // Gate on first keyframe so go2rtc doesn't get orphan P-frames
        if (!seenKeyframe) {
          if (!this.isAnnexBKeyframe(annexB, frame.videoType)) continue;
          seenKeyframe = true;
          this.logger.info?.(
            `[Go2rtcTcpServer] first live keyframe  client=${clientId} after ${liveFrameCount} frames`,
          );
        }

        socket.write(annexB);
        liveVideoWritten++;
        this.totalVideoFramesWritten++;

        // Periodic log every 10 seconds
        if (Date.now() - lastLogAt > 10_000) {
          this.logger.info?.(
            `[Go2rtcTcpServer] live stats  client=${clientId} received=${liveFrameCount} written=${liveVideoWritten} bufLen=${socket.writableLength}`,
          );
          lastLogAt = Date.now();
        }

        // Backpressure: drop client if buffer grows too large
        if (socket.writableLength > this.maxBufferBytes) {
          this.logger.warn?.(
            `[Go2rtcTcpServer] buffer overflow (${socket.writableLength} bytes), dropping client ${clientId}`,
          );
          socket.destroy();
          break;
        }
      }
      this.logger.info?.(
        `[Go2rtcTcpServer] live loop ended naturally  client=${clientId} received=${liveFrameCount} written=${liveVideoWritten}`,
      );
    } finally {
      // Ensure subscription is cleaned up
      await subscription.return(undefined as any).catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Frame conversion
  // -----------------------------------------------------------------------

  /**
   * Convert a native frame to wire-ready Annex-B.
   * Audio frames are skipped — raw TCP carries only video (Annex-B).
   * go2rtc auto-detects the codec from SPS/PPS/VPS NALUs.
   */
  private convertFrame(frame: NativeFrame): Buffer | null {
    if (frame.audio) {
      // Raw TCP can only carry video. Sending ADTS AAC bytes would corrupt
      // the Annex-B bitstream and cause go2rtc to disconnect.
      return null;
    }
    if (frame.data.length === 0) return null;
    try {
      if (frame.videoType === "H264") {
        return convertH264ToAnnexB(frame.data);
      }
      if (frame.videoType === "H265") {
        return convertH265ToAnnexB(frame.data);
      }
    } catch {
      // ignore conversion errors
    }
    // Unknown codec — pass raw data through
    return frame.data;
  }

  /** Check if an Annex-B buffer contains a keyframe (IDR for H.264, IRAP for H.265). */
  private isAnnexBKeyframe(
    annexB: Buffer,
    videoType?: "H264" | "H265",
  ): boolean {
    try {
      if (videoType === "H264") {
        const nals = Go2rtcTcpServer.splitAnnexBNals(annexB);
        return nals.some((n) => n.length >= 1 && (n[0]! & 0x1f) === 5);
      }
      if (videoType === "H265") {
        const nals = splitAnnexBToNalPayloads(annexB);
        return nals.some(
          (n) => n.length >= 2 && isH265Irap((n[0]! >> 1) & 0x3f),
        );
      }
    } catch {
      // ignore
    }
    return false;
  }

  /** Split Annex-B byte stream into individual NAL units. */
  private static splitAnnexBNals(buf: Buffer): Buffer[] {
    const nals: Buffer[] = [];
    let i = 0;
    while (i < buf.length) {
      // Find start code (0x000001 or 0x00000001)
      if (
        i + 2 < buf.length &&
        buf[i] === 0 &&
        buf[i + 1] === 0
      ) {
        let scLen: number;
        if (buf[i + 2] === 1) {
          scLen = 3;
        } else if (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) {
          scLen = 4;
        } else {
          i++;
          continue;
        }
        // Find next start code
        const nalStart = i + scLen;
        let nalEnd = buf.length;
        for (let j = nalStart; j < buf.length - 2; j++) {
          if (
            buf[j] === 0 &&
            buf[j + 1] === 0 &&
            (buf[j + 2] === 1 || (j + 3 < buf.length && buf[j + 2] === 0 && buf[j + 3] === 1))
          ) {
            nalEnd = j;
            break;
          }
        }
        if (nalEnd > nalStart) {
          nals.push(buf.subarray(nalStart, nalEnd));
        }
        i = nalEnd;
      } else {
        i++;
      }
    }
    return nals;
  }

  // -----------------------------------------------------------------------
  // Native stream management
  // -----------------------------------------------------------------------

  private async startNativeStream(): Promise<void> {
    if (this.nativeStreamActive) return;

    // Ensure the API's control socket is connected. Battery cameras use
    // idle_disconnect: the control socket closes between stream sessions but
    // the API object stays valid (isClosed = false). ensureConnected()
    // reconnects transparently on-demand.
    if (!this.api.isReady) {
      if (this.api.isClosed) {
        this.logger.warn?.(
          `[Go2rtcTcpServer] API has been explicitly closed — stream cannot start`,
        );
        return;
      }
      try {
        this.logger.info?.(
          `[Go2rtcTcpServer] API not ready (idle disconnect?), calling ensureConnected`,
        );
        await this.api.ensureConnected();
      } catch (e) {
        this.logger.warn?.(
          `[Go2rtcTcpServer] ensureConnected failed, aborting stream start: ${e}`,
        );
        return;
      }
    }

    this.nativeStreamActive = true;

    // Acquire dedicated session if deviceId is set
    let dedicatedClient: import("../../client/BaichuanClient").BaichuanClient | undefined;
    if (this.deviceId) {
      try {
        // Session key MUST start with "live:" so the library's resolveSocketTag()
        // assigns a per-profile socket tag (e.g. "streaming:ch0:main").
        // Without the "live:" prefix, all streams fall back to the shared "general"
        // socket, causing streamType mismatches between main/sub/ext.
        const session = await this.api.createDedicatedSession(
          `live:${this.deviceId}:ch${this.channel}:${this.profile}`,
        );
        dedicatedClient = session.client;
        this.dedicatedSessionRelease = session.release;
      } catch (e) {
        this.logger.warn?.(
          `[Go2rtcTcpServer] failed to acquire dedicated session, using shared socket: ${e}`,
        );
      }
    }

    this.logger.info?.(
      `[Go2rtcTcpServer] native stream starting  channel=${this.channel} profile=${this.profile} dedicated=${!!dedicatedClient}`,
    );

    this.nativeFanout = new NativeStreamFanout({
      maxQueueItems: 200,
      createSource: () =>
        createNativeStream(this.api, this.channel, this.profile, {
          variant: this.variant,
          ...(dedicatedClient ? { client: dedicatedClient } : {}),
        }),
      onFrame: (frame) => {
        // Update stream health tracking
        this.lastFrameAt = Date.now();
        this.totalFramesReceived++;

        // Detect video type
        if (!frame.audio && (frame.videoType === "H264" || frame.videoType === "H265")) {
          this.detectedVideoType = frame.videoType;
        }

        // Convert and add to prebuffer
        const wireData = this.convertFrame(frame);
        if (!wireData || wireData.length === 0) return;

        const isKeyframe = !frame.audio && this.isAnnexBKeyframe(wireData, frame.videoType);
        this.prebuffer.push({
          data: Buffer.from(wireData),
          time: Date.now(),
          isKeyframe,
          audio: frame.audio,
        });

        // Trim prebuffer
        const cutoff = Date.now() - this.prebufferMaxMs;
        let trimIdx = 0;
        while (trimIdx < this.prebuffer.length && this.prebuffer[trimIdx]!.time < cutoff) {
          trimIdx++;
        }
        if (trimIdx > 0) this.prebuffer.splice(0, trimIdx);
      },
      onError: (error) => {
        this.logger.warn?.(`[Go2rtcTcpServer] native stream error: ${error}`);
      },
      onEnd: () => {
        if (!this.nativeStreamActive) return;
        this.nativeStreamActive = false;
        this.nativeFanout = null;
        this.stopStreamHealthMonitor();

        const silenceMs = this.lastFrameAt > 0 ? Date.now() - this.lastFrameAt : -1;
        const diagnosis = silenceMs > this.streamTimeoutMs
          ? "camera stopped sending frames"
          : silenceMs >= 0
            ? "stream source closed"
            : "no frames were ever received";
        this.logger.warn?.(
          `[Go2rtcTcpServer] native stream ended  diagnosis="${diagnosis}" ` +
          `lastFrame=${silenceMs >= 0 ? `${(silenceMs / 1000).toFixed(1)}s ago` : "never"} ` +
          `totalRx=${this.totalFramesReceived} clients=${this.connectedClients.size}`,
        );

        // Release dedicated session
        if (this.dedicatedSessionRelease) {
          this.dedicatedSessionRelease().catch(() => {});
          this.dedicatedSessionRelease = undefined;
        }

        // Auto-restart if clients are connected or prestart mode is active
        if (this.active && (this.connectedClients.size > 0 || this.prestartStream)) {
          this.logger.info?.(
            `[Go2rtcTcpServer] restarting native stream (clients=${this.connectedClients.size}, prestart=${this.prestartStream})`,
          );
          this.startNativeStream();
        }
      },
    });

    this.nativeFanout.start();
    this.startStreamHealthMonitor();
  }

  private async stopNativeStream(): Promise<void> {
    this.nativeStreamActive = false;
    this.stopStreamHealthMonitor();
    const fanout = this.nativeFanout;
    this.nativeFanout = null;
    if (fanout) {
      await fanout.stop();
    }
    this.prebuffer = [];

    if (this.dedicatedSessionRelease) {
      await this.dedicatedSessionRelease().catch(() => {});
      this.dedicatedSessionRelease = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Stream health monitoring
  // -----------------------------------------------------------------------

  private startStreamHealthMonitor(): void {
    this.stopStreamHealthMonitor();
    if (this.streamTimeoutMs <= 0) return;

    this.lastFrameAt = Date.now();
    this.streamHealthTimer = setInterval(() => {
      if (!this.nativeStreamActive || !this.active) {
        this.stopStreamHealthMonitor();
        return;
      }

      const silenceMs = Date.now() - this.lastFrameAt;
      if (silenceMs > this.streamTimeoutMs) {
        this.logger.warn?.(
          `[Go2rtcTcpServer] stream inactivity timeout: no frames for ${(silenceMs / 1000).toFixed(1)}s (threshold=${this.streamTimeoutMs}ms), ` +
          `totalReceived=${this.totalFramesReceived} clients=${this.connectedClients.size} — forcing stream restart`,
        );
        this.stopStreamHealthMonitor();

        // Force-stop the native stream; the onEnd callback will auto-restart
        // if clients are connected or prestartStream is enabled.
        const fanout = this.nativeFanout;
        if (fanout) {
          this.nativeStreamActive = false;
          this.nativeFanout = null;
          fanout.stop().catch(() => {});
        }
      }
    }, Math.min(this.streamTimeoutMs / 2, 5_000));
  }

  private stopStreamHealthMonitor(): void {
    if (this.streamHealthTimer) {
      clearInterval(this.streamHealthTimer);
      this.streamHealthTimer = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Client lifecycle
  // -----------------------------------------------------------------------

  private removeClient(clientId: string, reason?: string): void {
    if (!this.connectedClients.has(clientId)) return;
    this.connectedClients.delete(clientId);
    this.clientSockets.delete(clientId);

    const silenceMs = this.lastFrameAt > 0 ? Date.now() - this.lastFrameAt : -1;
    const silenceInfo = silenceMs >= 0 ? ` lastFrame=${(silenceMs / 1000).toFixed(1)}s ago` : "";
    this.logger.info?.(
      `[Go2rtcTcpServer] client disconnected  id=${clientId} reason=${reason ?? "unknown"}` +
      `  remaining=${this.connectedClients.size}  totalRx=${this.totalFramesReceived} totalTx=${this.totalVideoFramesWritten}${silenceInfo}`,
    );
    this.emit("clientDisconnected", clientId);

    if (this.connectedClients.size === 0 && !this.prestartStream) {
      // Only schedule stop if prestart is off. When prestart is on, the native
      // stream stays alive permanently so go2rtc can reconnect at any time.
      this.scheduleStop();
    }
  }

  private scheduleStop(): void {
    if (this.stopGraceTimer) return;
    this.logger.info?.(
      `[Go2rtcTcpServer] no clients, scheduling stream stop in ${this.gracePeriodMs}ms`,
    );
    this.stopGraceTimer = setTimeout(async () => {
      this.stopGraceTimer = undefined;
      if (this.connectedClients.size === 0 && this.nativeStreamActive) {
        this.logger.info?.("[Go2rtcTcpServer] grace period expired, stopping native stream");
        await this.stopNativeStream();
      }
    }, this.gracePeriodMs);
  }
}
