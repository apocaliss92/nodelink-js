/**
 * Baichuan RTSP Server - Builds an RTSP server that serves a Baichuan video stream.
 *
 * Structure:
 * - RTSP server uses ffmpeg -rtsp_flags listen to create RTSP server from stdin
 * - Native stream starts when the first client needs video (e.g. DESCRIBE/PLAY path)
 * - Native stream auto-stop when no clients is optional (see nativeStreamIdleStopMs)
 * - Tracks connected clients
 * - Passes native frames directly to ffmpeg without repacketization
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as dgram from "node:dgram";
import * as crypto from "node:crypto";
import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../../reolink/baichuan/types";
import type { Logger } from "../../debug/DebugConfig";
import { createNativeStream } from "../../rfc/helpers";
import { BaichuanVideoStream } from "./BaichuanVideoStream";
import { ContinuousVideoStream } from "./ContinuousVideoStream";
import { AlwaysOnController } from "./AlwaysOnController";
import type { AlwaysOnOptions } from "./alwaysOnTypes";
import { createRtspFlow, type RtspFlow, type RtspVideoType } from "./rtspFlow";
import {
  DEFAULT_AUDIO_PRIMING_MS,
  DEFAULT_VIDEO_PRIMING_MS,
  resolvePrimingMs,
  type PrimingTimeoutOption,
} from "./primingTimeouts";
import { deriveRtpVideoTimestamp } from "./rtpVideoTimestamp";
import {
  AsyncBoundedQueue,
  type BoundedQueueOverflow,
} from "./asyncBoundedQueue";
import { convertToAnnexB as convertH264ToAnnexB } from "./H264Converter";
import {
  convertToAnnexB as convertH265ToAnnexB,
  isH265Irap,
  splitAnnexBToNalPayloads,
} from "./H265Converter";

type FanoutOptions<T> = {
  maxQueueItems: number;
  createSource: (signal: AbortSignal) => AsyncGenerator<T, void, unknown>;
  onFrame?: (frame: T) => void;
  onError?: (error: unknown) => void;
  /** Called when the pump ends, whether by error or natural stream end. */
  onEnd?: () => void;
  /**
   * Called when a subscriber's backlog overflows and frames are evicted.
   * This is the one place where a client can lose frames that the camera
   * actually delivered, so it must never go unobserved — it is the
   * difference between "the source is clean" and "the client got clean
   * frames".
   */
  onSubscriberOverflow?: (
    subscriberId: string,
    overflow: BoundedQueueOverflow<T>,
  ) => void;
};

class NativeStreamFanout<T> {
  private readonly opts: FanoutOptions<T>;
  private readonly queues = new Map<string, AsyncBoundedQueue<T>>();
  private source: AsyncGenerator<T, void, unknown> | null = null;
  private running = false;
  private pumpPromise: Promise<void> | null = null;
  private abort = new AbortController();

  constructor(opts: FanoutOptions<T>) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.source = this.opts.createSource(this.abort.signal);

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

  subscribe(id: string): AsyncGenerator<T, void, unknown> {
    const q = new AsyncBoundedQueue<T>(this.opts.maxQueueItems, (overflow) =>
      this.opts.onSubscriberOverflow?.(id, overflow),
    );
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
    // Abort first: wakes the generator's idle sleep so it exits the while loop
    // and reaches finally → videoStream.stop() → stopWatchdog() promptly.
    // Without this, an async generator stuck in a non-yielding await loop never
    // processes the queued return() request, leaving the watchdog running.
    this.abort.abort();
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

function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

export interface BaichuanRtspServerOptions {
  /** API instance (required) */
  api: ReolinkBaichuanApi;
  /** Channel number (required) */
  channel: number;
  /** Stream profile (required) */
  profile: StreamProfile;
  /** Native-only: TrackMix tele/autotrack variants (usually on NVR/Hub). */
  variant?: NativeVideoStreamVariant;
  listenHost?: string; // Host to listen on (default: "127.0.0.1")
  listenPort?: number; // Port to listen on (default: 8554)
  path?: string; // RTSP path (e.g. "/main" or "/sub")
  logger?: Logger;

  /**
   * Framing used when sending RTP packets over a TCP stream.
   * - "rtsp-interleaved": RTSP interleaved framing: '$' + channel + 2-byte length + RTP packet
   * - "rfc4571": RFC4571 framing: 2-byte length + RTP packet
   */
  tcpRtpFraming?: "rtsp-interleaved" | "rfc4571";

  /**
   * Credentials for RTSP authentication (optional).
   *
   * Each entry carries either the plaintext `password` or a pre-computed
   * Digest `ha1 = MD5(username ":" realm ":" password)`. The HA1 variant is
   * preferred when the consumer stores only hashed credentials (e.g. the
   * manager reuses dashboard-user HA1 values without ever holding plaintext).
   *
   * When both are supplied, `ha1` wins for Digest validation while `password`
   * is used for Basic authentication.
   */
  credentials?: Array<
    | { username: string; password: string; ha1?: string }
    | { username: string; password?: string; ha1: string }
  >;
  /** Require authentication for RTSP connections (default: false if no credentials set) */
  requireAuth?: boolean;
  /**
   * Digest authentication realm advertised to clients. Must match the realm
   * used when pre-computing HA1 values in `credentials[*].ha1`.
   * Default: "BaichuanRtspServer" (kept for backward compatibility).
   */
  authRealm?: string;

  /**
   * External identifier for dedicated socket session.
   * When provided, a dedicated BaichuanClient is created for the stream,
   * isolating it from other streams on the shared socket (avoids streamType mismatch).
   */
  deviceId?: string;

  /**
   * When true, the server does NOT create its own net.Server.
   * Connections are accepted externally via acceptConnection().
   * start() still performs metadata fetch and codec detection.
   */
  externalListener?: boolean;

  /**
   * When true, the server runs in **mux mode**: `start()` skips creating
   * or listening on any TCP server (a shared multiplexer — e.g.
   * `LocalRtspMux` — owns the public RTSP port and routes accepted sockets
   * here via `injectSocket()`). `stop()` likewise skips closing a TCP
   * server it does not own.
   *
   * Semantically equivalent to `externalListener: true`, but expressed from
   * the point of view of the multiplexer that will drive this instance.
   * Either flag is sufficient; both may be set together.
   */
  muxMode?: boolean;

  /**
   * Ms after the last RTSP client disconnects before stopping the native Baichuan stream.
   * 0 = keep the native stream running (matches rtsp proxy idle timeout 0 / always-mounted sources).
   * Default 30000.
   */
  nativeStreamIdleStopMs?: number;

  /**
   * If the native stream is primed (e.g. DESCRIBE) but no client SETUP/PLAYs, stop after this many ms.
   * 0 = disable. Default 15000 when nativeStreamIdleStopMs > 0, else 0.
   */
  nativeStreamPrimeIdleStopMs?: number;

  /**
   * When true, `start()` does NOT fetch stream metadata from the camera —
   * the metadata fetch is deferred to the first DESCRIBE. Useful for
   * battery / UDP cameras so binding the RTSP port at boot does not wake
   * them up when no client is listening.
   *
   * Trade-off: the very first DESCRIBE pays the metadata round-trip
   * latency. Subsequent connections hit the cached metadata.
   *
   * Default: false (keep existing behaviour).
   */
  lazyMetadata?: boolean;

  /**
   * How long a DESCRIBE waits for video parameter sets (SPS/PPS for H.264,
   * VPS/SPS/PPS for H.265) before answering with an SDP that lacks
   * `sprop-parameter-sets`.
   *
   * Accepts a single value for every transport, or `{ tcp, udp }` to raise it
   * only for battery/BCUDP cameras, which have to wake up first and routinely
   * exceed the default. `0` answers immediately without waiting.
   *
   * Default: `{ tcp: 3000, udp: 4000 }`. Capped at 60000.
   */
  videoPrimingMs?: PrimingTimeoutOption;

  /**
   * How long a DESCRIBE waits for the first AAC frame once video parameter
   * sets are ready, so the SDP can advertise the audio track instead of
   * latching it only on the second DESCRIBE.
   *
   * Same shape and clamping as `videoPrimingMs`.
   *
   * Default: `{ tcp: 2000, udp: 3000 }`.
   */
  audioPrimingMs?: PrimingTimeoutOption;

  /**
   * Always-on continuous stream (battery cameras). When `enabled`, the server
   * sources video from a {@link ContinuousVideoStream} (real frames during
   * event-driven live windows, a low-fps placeholder while the camera sleeps)
   * driven by an {@link AlwaysOnController}. The controller owns the sleep/wake
   * decision, so the server's own battery idle-stop timers are suppressed.
   * When omitted/disabled the server behaves exactly as before.
   */
  alwaysOn?: AlwaysOnOptions;
}

/**
 * BaichuanRtspServer - RTSP server that serves a Baichuan video stream.
 *
 * Uses ffmpeg as RTSP server that reads from stdin, passing native frames directly.
 * This approach is simpler and more reliable than manual RTP repacketization.
 *
 * Lifecycle:
 * - Server starts immediately (ffmpeg RTSP server)
 * - Native stream starts when clients need media
 * - Native stream may stay running with zero RTSP clients if nativeStreamIdleStopMs is 0
 */
export class BaichuanRtspServer extends EventEmitter<{
  client: [string]; // Client connesso
  clientDisconnected: [string]; // Client disconnesso
  error: [Error];
  close: [];
}> {
  private api: ReolinkBaichuanApi;
  private channel: number;
  private profile: StreamProfile;
  private variant: NativeVideoStreamVariant;
  private listenHost: string;
  private listenPort: number;
  private path: string;
  private logger: Logger;
  private tcpRtpFraming: "rtsp-interleaved" | "rfc4571";
  private active = false;
  private flow: RtspFlow;
  private deviceId: string | undefined;
  private dedicatedSessionRelease: (() => Promise<void>) | undefined;
  private externalListener: boolean;

  // Always-on continuous stream (battery cameras). Populated only when
  // `options.alwaysOn?.enabled`; the default (non-alwaysOn) path leaves these
  // null/undefined and is byte-for-byte equivalent in behaviour.
  private readonly alwaysOnOptions: AlwaysOnOptions | undefined;
  private continuousStream: ContinuousVideoStream | null = null;
  private alwaysOnController: AlwaysOnController | null = null;

  // Authentication
  private authCredentials: Array<{
    username: string;
    password?: string;
    ha1?: string;
  }> = [];
  private requireAuth: boolean;
  private authNonces = new Map<string, { nonce: string; timestamp: number }>(); // Track nonces per client
  private readonly AUTH_REALM: string;
  private readonly NONCE_TIMEOUT_MS = 300000; // 5 minutes
  private readonly lazyMetadata: boolean;
  private readonly videoPrimingMs: PrimingTimeoutOption | undefined;
  private readonly audioPrimingMs: PrimingTimeoutOption | undefined;

  // Client tracking
  private connectedClients = new Set<string>(); // Set of client IDs (IP:port)
  private nativeStreamActive = false; // Whether the native stream is currently active
  private tearingDown = false; // True while stop() is running; suppresses onEnd-driven restarts
  private clientConnectionServer: net.Server | undefined; // TCP server to track connections
  private streamMetadata: {
    frameRate: number;
    width?: number;
    height?: number;
  } | null = null;
  // Track all client resources for cleanup
  private clientResources = new Map<
    string,
    {
      ffmpeg: ReturnType<typeof spawn> | undefined;
      udpSocket: dgram.Socket | null;
      udpSocketAudio: dgram.Socket | null;
      rtspSocket: net.Socket | null;
      pipelineStarted?: boolean;
      seenFirstVideoKeyframe?: boolean;
      h265WaitStartMs?: number;
      setupTrack0: boolean;
      setupTrack1: boolean;
      isPlaying: boolean;
      track0RtpChannel?: number;
      track0RtcpChannel?: number;
      track1RtpChannel?: number;
      track1RtcpChannel?: number;
      rtpVideoSeq?: number;
      rtpVideoTimestamp?: number;
      rtpVideoBaseMicroseconds?: number;
      rtpVideoBaseTimestamp?: number;
      rtpVideoLastTimestamp?: number;
      // Unwrapped 32-bit camera µs clock state (see rtpVideoTimestamp.ts).
      rtpVideoUnwrappedUs?: number;
      rtpVideoLastRawUs?: number;
      rtpVideoBaseUnwrappedUs?: number;
      rtpVideoSsrc?: number;
      rtpAudioSeq?: number;
      rtpAudioTimestamp?: number;
      rtpAudioSsrc?: number;
      rtpSentVideoConfig?: boolean;
    }
  >();

  private isRtspDebugEnabled(): boolean {
    // Access api.client via a try/catch so that the debug log path stays
    // usable after the ReolinkBaichuanApi has been closed (for example when
    // a battery camera's idle_disconnect fires while an RTSP client socket
    // still has buffered bytes in flight). Without this guard the `get client`
    // getter throws "[ReolinkBaichuanApi] API has been closed" in the middle
    // of processBuffer(), spamming the server log and preventing the socket
    // from closing cleanly.
    try {
      if (this.api.isClosed) {
        return envBool(process.env.BAICHUAN_DEBUG_RTSP, false);
      }
      const dbg = this.api.client.getDebugConfig();
      return dbg.debugRtsp || envBool(process.env.BAICHUAN_DEBUG_RTSP, false);
    } catch {
      return envBool(process.env.BAICHUAN_DEBUG_RTSP, false);
    }
  }

  private rtspDebugLog(message: string): void {
    if (!this.isRtspDebugEnabled()) return;
    this.logger.debug(`[BaichuanRtspServer] ${message}`);
  }
  // Track when first frame arrives from camera
  private firstFramePromise: Promise<void> | null = null;
  private firstFrameResolve: (() => void) | null = null;
  private firstFrameReceived = false;
  private firstAudioPromise: Promise<void> | null = null;
  private firstAudioResolve: (() => void) | null = null;
  private firstAudioDetected = false;
  // Audio support (TCP only): AAC with ADTS framing, packetized to RTP (mpeg4-generic).
  private hasAudio = false;
  private audioInfo: {
    codec: "aac-adts";
    sampleRate: number;
    channels: number;
    configHex: string;
  } | null = null;
  private audioPrimingFrame: Buffer | null = null;
  // Temporary stream for extracting parameter sets during DESCRIBE
  private tempStreamGenerator: AsyncGenerator<
    {
      audio: boolean;
      data: Buffer;
      codec: string | null;
      sampleRate: number | null;
      microseconds: number | null;
      videoType?: "H264" | "H265";
    },
    void,
    unknown
  > | null = null;

  // Shared native stream fan-out (single camera stream, multiple RTSP clients)
  private nativeFanout: NativeStreamFanout<{
    audio: boolean;
    data: Buffer;
    codec: string | null;
    sampleRate: number | null;
    microseconds: number | null;
    videoType?: "H264" | "H265";
    isKeyframe?: boolean;
  }> | null = null;
  private noClientAutoStopTimer: NodeJS.Timeout | undefined;
  /** Fires if camera never sends frames after stream start (sleeping), even with clients connected. */
  private noFrameDeadlineTimer: NodeJS.Timeout | undefined;
  /** After last RTSP client; 0 = never auto-stop native stream. */
  private readonly nativeStreamIdleStopMs: number;
  /** Primed-but-no-PLAY timeout; 0 = disabled. */
  private readonly nativeStreamPrimeIdleStopMs: number;
  /**
   * Max time to wait for the first camera frame after stream start.
   * If no frames arrive within this window, the native stream is stopped
   * (camera is sleeping). Prevents the BaichuanVideoStream watchdog from
   * firing and waking the camera when no real viewer is watching.
   * 0 = disabled. Defaults to nativeStreamPrimeIdleStopMs * 2 when > 0.
   */
  private readonly nativeStreamNoFrameDeadlineMs: number;

  // Prebuffer: rolling ring of recent video frames for IDR-aligned fast startup.
  // When a new client connects while the stream is already running it does not need
  // to wait up to one full GOP interval for the next keyframe — we replay frames
  // from the last IDR in the prebuffer immediately.
  private readonly PREBUFFER_MAX_MS = 3000;
  private prebuffer: Array<{
    frame: {
      audio: boolean;
      data: Buffer;
      codec: string | null;
      sampleRate: number | null;
      microseconds: number | null;
      videoType?: "H264" | "H265";
    };
    time: number;
    isKeyframe: boolean;
  }> = [];

  /**
   * Hard cap on the userspace TCP send buffer for a single RTSP client. A
   * healthy consumer drains near-instantly; if this much data backs up the
   * client is dead or far too slow to keep up with the live stream.
   */
  static readonly MAX_CLIENT_BUFFERED_BYTES = 8 * 1024 * 1024;

  /** Throttle for the per-client backlog-overflow warning. */
  static readonly BACKLOG_OVERFLOW_LOG_INTERVAL_MS = 5000;

  /** Last time a backlog-overflow warning was logged, per client. */
  private readonly lastBacklogOverflowLogMs = new Map<string, number>();

  /**
   * Pure backpressure decision: should the client socket be disconnected
   * because its send buffer has grown past the hard cap? Extracted so the
   * decision can be unit-tested without a live socket.
   */
  static shouldDisconnectForBackpressure(bufferedBytes: number): boolean {
    return bufferedBytes > BaichuanRtspServer.MAX_CLIENT_BUFFERED_BYTES;
  }

  private static isAdtsAacFrame(b: Buffer): boolean {
    // ADTS syncword: 0xFFF (12 bits)
    return b.length >= 2 && b[0] === 0xff && (b[1]! & 0xf0) === 0xf0;
  }

  private static parseAdtsSamplingInfo(
    b: Buffer,
  ): { sampleRate: number; channels: number; configHex: string } | null {
    // Minimal ADTS header parsing to extract sample rate index + channel config.
    // Reference layout:
    // - sampling_frequency_index: bits 2..5 of byte2 (b[2])
    // - channel_configuration: 1 bit in b[2] (LSB) + 2 bits in b[3] (MSBs)
    if (b.length < 7) return null;
    if (!BaichuanRtspServer.isAdtsAacFrame(b)) return null;

    const samplingIndex = (b[2]! >> 2) & 0x0f;
    const sampleRates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
      11025, 8000, 7350,
    ];
    const sampleRate = sampleRates[samplingIndex] ?? null;
    if (!sampleRate) return null;

    const channelConfig = ((b[2]! & 0x01) << 2) | ((b[3]! >> 6) & 0x03);
    const channels = channelConfig === 0 ? 1 : channelConfig;

    // ADTS profile (2 bits): 0=Main, 1=LC, 2=SSR. AudioSpecificConfig uses audioObjectType = profile + 1.
    const profile = (b[2]! >> 6) & 0x03;
    const audioObjectType = profile + 1;
    // AudioSpecificConfig (AAC): 5 bits AOT, 4 bits sampling idx, 4 bits channel config.
    const asc =
      (audioObjectType << 11) | (samplingIndex << 7) | (channelConfig << 3);
    const configHex = Buffer.from([(asc >> 8) & 0xff, asc & 0xff]).toString(
      "hex",
    );
    return { sampleRate, channels, configHex };
  }

  /** Returns true if the raw (packed/Annex B) frame is an IDR (H.264) or IRAP (H.265). */
  private isRawFrameKeyframe(frame: {
    videoType?: "H264" | "H265";
    data: Buffer;
  }): boolean {
    try {
      if (frame.videoType === "H264") {
        const nals = BaichuanRtspServer.splitAnnexBNals(
          convertH264ToAnnexB(frame.data),
        );
        return nals.some((n) => n.length >= 1 && (n[0]! & 0x1f) === 5);
      }
      if (frame.videoType === "H265") {
        const nals = splitAnnexBToNalPayloads(convertH265ToAnnexB(frame.data));
        return nals.some(
          (n) => n.length >= 2 && isH265Irap((n[0]! >> 1) & 0x3f),
        );
      }
    } catch {
      // ignore conversion errors
    }
    return false;
  }

  private static parseInterleavedChannels(
    transportHeader: string,
  ): { rtp: number; rtcp: number } | null {
    const m = transportHeader.match(/interleaved\s*=\s*(\d+)\s*-\s*(\d+)/i);
    if (!m) return null;
    const rtp = Number.parseInt(m[1]!, 10);
    const rtcp = Number.parseInt(m[2]!, 10);
    if (!Number.isFinite(rtp) || !Number.isFinite(rtcp)) return null;
    return { rtp, rtcp };
  }

  private static splitAnnexBNals(data: Buffer): Buffer[] {
    // Returns NAL units WITHOUT start codes.
    const nals: Buffer[] = [];
    const len = data.length;
    const isStartCodeAt = (i: number): number => {
      // returns start code length (3 or 4) or 0
      if (i + 3 <= len && data[i] === 0x00 && data[i + 1] === 0x00) {
        if (data[i + 2] === 0x01) return 3;
        if (i + 4 <= len && data[i + 2] === 0x00 && data[i + 3] === 0x01)
          return 4;
      }
      return 0;
    };

    let i = 0;
    // find first start code
    while (i < len) {
      const sc = isStartCodeAt(i);
      if (sc) break;
      i++;
    }
    while (i < len) {
      const sc = isStartCodeAt(i);
      if (!sc) {
        i++;
        continue;
      }
      const nalStart = i + sc;
      let j = nalStart;
      while (j < len) {
        const sc2 = isStartCodeAt(j);
        if (sc2) break;
        j++;
      }
      if (nalStart < j) {
        const nal = data.subarray(nalStart, j);
        // skip empty/zero-length nals
        if (nal.length > 0) nals.push(nal);
      }
      i = j;
    }
    return nals;
  }

  private static stripAdtsHeader(adtsFrame: Buffer): Buffer | null {
    if (!BaichuanRtspServer.isAdtsAacFrame(adtsFrame)) return null;
    if (adtsFrame.length < 7) return null;
    const protectionAbsent = (adtsFrame[1]! & 0x01) === 0x01;
    const headerLen = protectionAbsent ? 7 : 9;
    if (adtsFrame.length <= headerLen) return null;
    return adtsFrame.subarray(headerLen);
  }

  constructor(options: BaichuanRtspServerOptions) {
    super();
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.variant = options.variant ?? "default";
    this.listenHost = options.listenHost ?? "127.0.0.1";
    this.listenPort = options.listenPort ?? 8554;
    this.path = options.path ?? `/stream/${this.profile}`;
    this.logger = options.logger ?? console;
    this.tcpRtpFraming = options.tcpRtpFraming ?? "rfc4571";
    this.deviceId = options.deviceId;
    // `muxMode` and `externalListener` are semantically equivalent: both
    // tell `start()`/`stop()` that some external component (the multiplexer
    // or proxy) owns the TCP socket lifecycle. Treat them as a union so
    // callers can pick whichever name reads best at the call-site.
    this.externalListener =
      (options.externalListener ?? false) || (options.muxMode ?? false);
    this.nativeStreamIdleStopMs = options.nativeStreamIdleStopMs ?? 30_000;
    this.nativeStreamPrimeIdleStopMs =
      options.nativeStreamPrimeIdleStopMs ??
      (this.nativeStreamIdleStopMs > 0 ? 15_000 : 0);
    // No-frame deadline: 2× the prime timeout, capped at 30s.
    // Fires when camera hasn't responded at all (sleeping), even if go2rtc is connected.
    this.nativeStreamNoFrameDeadlineMs =
      this.nativeStreamPrimeIdleStopMs > 0
        ? Math.min(this.nativeStreamPrimeIdleStopMs * 2, 30_000)
        : 0;

    // Authentication settings
    this.authCredentials = (options.credentials ?? []).map((c) => ({
      username: c.username,
      ...(c.password !== undefined ? { password: c.password } : {}),
      ...(c.ha1 !== undefined ? { ha1: c.ha1 } : {}),
    }));
    this.requireAuth = options.requireAuth ?? this.authCredentials.length > 0;
    this.AUTH_REALM = options.authRealm ?? "BaichuanRtspServer";
    this.lazyMetadata = options.lazyMetadata ?? false;
    this.videoPrimingMs = options.videoPrimingMs;
    this.audioPrimingMs = options.audioPrimingMs;
    this.alwaysOnOptions = options.alwaysOn;

    // Default flow is conservative (tcp+h264); it will be refined from metadata or first frames.
    const transport = this.api.client.getTransport();
    this.flow = createRtspFlow(transport, "H264");
  }

  /** Number of currently connected RTSP clients. */
  get clientCount(): number {
    return this.connectedClients.size;
  }

  // --- Authentication helpers ---

  /**
   * Generate a new nonce for Digest authentication
   */
  private generateNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  /**
   * Get or create a nonce for a client
   */
  private getNonceForClient(clientId: string): string {
    const existing = this.authNonces.get(clientId);
    const now = Date.now();

    // Clean up old nonces
    for (const [id, data] of this.authNonces) {
      if (now - data.timestamp > this.NONCE_TIMEOUT_MS) {
        this.authNonces.delete(id);
      }
    }

    if (existing && now - existing.timestamp < this.NONCE_TIMEOUT_MS) {
      return existing.nonce;
    }

    const nonce = this.generateNonce();
    this.authNonces.set(clientId, { nonce, timestamp: now });
    return nonce;
  }

  /**
   * Parse Digest Authorization header
   */
  private parseDigestAuth(authHeader: string): Record<string, string> | null {
    if (!authHeader.toLowerCase().startsWith("digest ")) return null;

    const params: Record<string, string> = {};
    const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(authHeader)) !== null) {
      const key = match[1]!.toLowerCase();
      const value = match[2] ?? match[3]!;
      params[key] = value;
    }

    return params;
  }

  /**
   * Calculate MD5 hash
   */
  private md5(data: string): string {
    return crypto.createHash("md5").update(data).digest("hex");
  }

  /**
   * Validate Digest authentication against any of the configured credentials
   */
  private validateDigestAuth(
    authHeader: string,
    method: string,
    uri: string,
    clientId: string,
  ): boolean {
    if (this.authCredentials.length === 0) return false;

    const params = this.parseDigestAuth(authHeader);
    if (!params) return false;

    const { username, realm, nonce, uri: authUri, response } = params;

    // Validate required fields
    if (!username || !realm || !nonce || !response) return false;

    // Validate nonce (must match what we issued to this client)
    const clientNonceData = this.authNonces.get(clientId);
    if (!clientNonceData || clientNonceData.nonce !== nonce) {
      this.rtspDebugLog(`Auth failed: nonce mismatch for client ${clientId}`);
      return false;
    }

    // Realm presented by the client must match our advertised realm, otherwise
    // HA1 computed against the wrong realm will silently not match — fail
    // early with a clear debug log.
    if (realm !== this.AUTH_REALM) {
      this.rtspDebugLog(
        `Auth failed: realm mismatch (client="${realm}", server="${this.AUTH_REALM}")`,
      );
      return false;
    }

    // Try to match against any configured credential
    for (const cred of this.authCredentials) {
      if (username !== cred.username) continue;

      // Prefer a pre-computed HA1 — lets consumers authenticate without
      // holding the plaintext password in memory (e.g. dashboard users
      // whose HA1 is persisted once at password set time).
      const ha1 =
        cred.ha1 ??
        (cred.password !== undefined
          ? this.md5(`${cred.username}:${this.AUTH_REALM}:${cred.password}`)
          : undefined);
      if (!ha1) continue;

      // HA2 = MD5(method:uri)
      const ha2 = this.md5(`${method}:${authUri || uri}`);
      // Response = MD5(HA1:nonce:HA2)
      const expectedResponse = this.md5(`${ha1}:${nonce}:${ha2}`);

      if (response === expectedResponse) {
        this.rtspDebugLog(
          `Auth successful for client ${clientId} with user ${username}`,
        );
        return true;
      }
    }

    this.rtspDebugLog(
      `Auth failed: no matching credentials for user ${username}`,
    );
    return false;
  }

  /**
   * Generate WWW-Authenticate header for 401 response
   */
  private generateWwwAuthenticateHeader(clientId: string): string {
    const nonce = this.getNonceForClient(clientId);
    return `Digest realm="${this.AUTH_REALM}", nonce="${nonce}"`;
  }

  // --- End Authentication helpers ---

  private clearNoClientAutoStopTimer(): void {
    if (this.noClientAutoStopTimer) {
      clearTimeout(this.noClientAutoStopTimer);
      this.noClientAutoStopTimer = undefined;
    }
  }

  private clearNoFrameDeadlineTimer(): void {
    if (this.noFrameDeadlineTimer) {
      clearTimeout(this.noFrameDeadlineTimer);
      this.noFrameDeadlineTimer = undefined;
    }
  }

  private setFlowVideoType(videoType: RtspVideoType, reason: string): void {
    if (this.flow.videoType === videoType) return;
    const transport = this.api.client.getTransport();
    this.flow.stopKeepAlive();
    this.flow = createRtspFlow(transport, videoType);
    this.rtspDebugLog(`Using RTSP flow ${this.flow.key} (${reason})`);
  }

  /**
   * Start the RTSP server.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("RTSP server is already active");
    }

    // Get stream metadata (unless lazy mode defers this to first DESCRIBE
    // — avoids waking battery/UDP cameras just to bind the RTSP port).
    if (this.lazyMetadata) {
      this.logger.info(
        `[BaichuanRtspServer] lazy metadata: skipping initial getStreamMetadata; will fetch on first DESCRIBE`,
      );
      // Leave streamMetadata undefined; handleRtspDescribe re-fetches.
      // flow.videoType stays at the conservative H264 default until the
      // first camera frame refines it.
    } else {
      try {
        const metadata = await this.api.getStreamMetadata(this.channel);
        const stream = metadata.streams.find((s) => s.profile === this.profile);
        if (stream) {
          this.streamMetadata = {
            frameRate: stream.frameRate || 25,
            width: stream.width,
            height: stream.height,
          };
          // Detect video type from metadata (refines flow early, before first frame).
          const enc = String(stream.videoEncType ?? "")
            .trim()
            .toLowerCase();
          const metaVideoType: RtspVideoType =
            enc.includes("265") || enc.includes("hevc") ? "H265" : "H264";
          this.setFlowVideoType(metaVideoType, "metadata");
        }
      } catch (error) {
        this.logger.warn(
          `[BaichuanRtspServer] Could not get stream metadata: ${error}`,
        );
        // Do NOT hardcode 1920x1080 — for 4K cameras this would advertise wrong
        // a=framesize in SDP. Leave width/height undefined so generateSdp() omits
        // the attribute and downstream decoders (go2rtc, ffmpeg) derive resolution
        // from the actual SPS/PPS in the bitstream.
        this.streamMetadata = { frameRate: 25 };
        this.setFlowVideoType("H264", "metadata unavailable");
      }
    }

    if (!this.externalListener) {
      // Start TCP server to handle RTSP connections
      this.clientConnectionServer = net.createServer((socket) => {
        this.handleRtspConnection(socket);
      });

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.clientConnectionServer!.listen(
          this.listenPort,
          this.listenHost,
          () => {
            // Update listenPort with the actual assigned port (in case listenPort was 0)
            const address = this.clientConnectionServer!.address();
            if (address && typeof address === "object" && "port" in address) {
              this.listenPort = address.port;
            }
            resolve();
          },
        );
        this.clientConnectionServer!.on("error", (error) => {
          reject(error);
        });
      });
    }

    this.active = true;
    this.logger.info(
      `[BaichuanRtspServer] RTSP server started on ${this.listenHost}:${this.listenPort}, path: ${this.path}`,
    );
  }

  /**
   * Accept an externally-routed RTSP connection.
   * Used in directHandoff mode where RtspProxyServer routes sockets here.
   * @param socket - The client TCP socket (already authenticated by proxy)
   * @param initialBuffer - Any bytes already read during path parsing/auth
   */
  acceptConnection(socket: net.Socket, initialBuffer?: Buffer): void {
    if (!this.active) {
      socket.end("RTSP/1.0 503 Service Unavailable\r\n\r\n");
      return;
    }
    this.handleRtspConnection(socket, initialBuffer);
  }

  /**
   * Inject an already-accepted client socket from a multiplexer
   * (e.g. `LocalRtspMux`) that owns the listening port.
   *
   * The mux reads the first RTSP request line to determine the target path,
   * then hands the socket over. Any bytes already consumed during routing
   * are replayed back onto the socket via `unshift()` so the RTSP parser in
   * `handleRtspConnection` sees the complete original request.
   *
   * @param socket - Client TCP socket, already accepted by the mux.
   * @param preReadData - Bytes the mux has already pulled off the socket
   *   while parsing the request line. Replayed via `socket.unshift()`
   *   before any further reads.
   */
  injectSocket(socket: net.Socket, preReadData: Buffer): void {
    if (!this.active) {
      socket.end("RTSP/1.0 503 Service Unavailable\r\n\r\n");
      return;
    }
    // `socket.unshift` must happen BEFORE any consumer reads from the
    // socket. We unshift here (not inside handleRtspConnection) so the
    // bytes are on the stream the moment the RTSP handler attaches its
    // 'data' listener.
    if (preReadData && preReadData.length > 0) {
      socket.unshift(preReadData);
    }
    // Do NOT pass `initialBuffer` — we've already pushed the bytes back
    // onto the socket, and handleRtspConnection seeds its own parse buffer
    // from the live stream.
    this.handleRtspConnection(socket);
  }

  /**
   * Handle RTSP connection from a client.
   */
  private handleRtspConnection(socket: net.Socket, initialBuffer?: Buffer): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    const connectTime = Date.now();
    this.logger.info(
      `[rebroadcast] client connected  client=${clientId} path=${this.path} profile=${this.profile} channel=${this.channel}`,
    );

    let sessionId = "";
    let buffer = initialBuffer ?? Buffer.alloc(0);
    let clientFfmpeg: ReturnType<typeof spawn> | undefined;
    let useTcpInterleaved = false;
    let clientUdpSocket: dgram.Socket | null = null;
    let clientUdpSocketAudio: dgram.Socket | null = null;

    let cleanedUp = false;
    const cleanup = () => {
      // Bound to both 'close' and 'error'; run the teardown only once so we
      // don't log a duplicate disconnect line (the second pass would read
      // frames=0 after clientResources was already deleted).
      if (cleanedUp) return;
      cleanedUp = true;
      const sessionDurationMs = Date.now() - connectTime;
      const res = this.clientResources.get(clientId) as any;
      const framesSent: number = res?.framesSent ?? 0;
      // Always report backlog loss on the summary line. A client that shows
      // `frames=N dropped=0` proves the delivery path was clean, which is the
      // one thing the source-side stream analyzer can never tell us.
      const framesDropped: number = res?.framesDropped ?? 0;
      const keyframesDropped: number = res?.keyframesDropped ?? 0;
      const dropSummary =
        framesDropped > 0
          ? ` dropped=${framesDropped} (keyframes=${keyframesDropped}, ${(
              (framesDropped / Math.max(1, framesSent + framesDropped)) *
              100
            ).toFixed(1)}%)`
          : " dropped=0";
      this.logger.info(
        `[rebroadcast] client disconnected  client=${clientId} path=${this.path} profile=${this.profile} duration=${sessionDurationMs}ms frames=${framesSent}${dropSummary}`,
      );
      this.removeClient(clientId);

      // Clean up authentication nonce for this client
      this.authNonces.delete(clientId);

      // Remove from tracking
      const resources = this.clientResources.get(clientId);
      if (resources) {
        // Kill ffmpeg process
        if (resources.ffmpeg) {
          try {
            resources.ffmpeg.stdin?.end();
            resources.ffmpeg.kill("SIGTERM");
            setTimeout(() => {
              try {
                resources.ffmpeg?.kill("SIGKILL");
              } catch {}
            }, 1000);
          } catch {}
        }

        // Close UDP sockets
        if (resources.udpSocket) {
          try {
            resources.udpSocket.close();
          } catch {}
        }
        if ((resources as any).udpSocketAudio) {
          try {
            ((resources as any).udpSocketAudio as dgram.Socket).close();
          } catch {}
        }

        // Close RTSP socket if still open
        if (resources.rtspSocket && !resources.rtspSocket.destroyed) {
          try {
            resources.rtspSocket.destroy();
          } catch {}
        }

        this.clientResources.delete(clientId);
      }

      // Also cleanup local variables
      if (clientFfmpeg) {
        try {
          clientFfmpeg.stdin?.end();
          clientFfmpeg.kill("SIGTERM");
          setTimeout(() => {
            try {
              clientFfmpeg?.kill("SIGKILL");
            } catch {}
          }, 1000);
        } catch {}
        clientFfmpeg = undefined;
      }

      if (clientUdpSocket) {
        try {
          clientUdpSocket.close();
        } catch {}
        clientUdpSocket = null;
      }

      if (clientUdpSocketAudio) {
        try {
          clientUdpSocketAudio.close();
        } catch {}
        clientUdpSocketAudio = null;
      }
    };

    socket.on("close", cleanup);
    socket.on("error", (error) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code !== "EPIPE"
      ) {
        this.logger.error(`[BaichuanRtspServer] RTSP client error:`, error);
      }
      cleanup();
    });

    const processBuffer = async () => {
      while (buffer.includes("\r\n\r\n")) {
        const endIndex = buffer.indexOf("\r\n\r\n");
        const requestText = buffer.subarray(0, endIndex).toString();
        buffer = buffer.subarray(endIndex + 4);

        if (!requestText.trim()) continue;

        const lines = requestText.split("\r\n");
        const requestLine = lines[0]?.split(" ");
        if (!requestLine || requestLine.length < 3) continue;

        const method = requestLine[0];
        const url = requestLine[1];
        const version = requestLine[2];

        const cseqMatch = requestText.match(/CSeq:\s*(\d+)/i);
        const cseq = cseqMatch ? parseInt(cseqMatch[1] ?? "0", 10) : 0;

        const sendResponse = (
          statusCode: number,
          statusText: string,
          headers: Record<string, string> = {},
          body?: string,
        ) => {
          let response = `${version} ${statusCode} ${statusText}\r\n`;
          response += `CSeq: ${cseq}\r\n`;
          for (const [key, value] of Object.entries(headers)) {
            response += `${key}: ${value}\r\n`;
          }
          if (body) {
            const bodyBuf = Buffer.from(body, "utf8");
            response += `Content-Length: ${bodyBuf.length}\r\n`;
            response += "\r\n";
            socket.write(response);
            socket.write(bodyBuf);
          } else {
            response += "\r\n";
            socket.write(response);
          }
        };

        this.rtspDebugLog(`RTSP ${method} ${url}`);

        // --- Authentication check ---
        if (this.requireAuth) {
          const authMatch = requestText.match(/Authorization:\s*([^\r\n]+)/i);
          const authHeader = authMatch?.[1] ?? "";

          // Allow OPTIONS without authentication (RFC 2617 recommends this)
          if (method !== "OPTIONS") {
            if (!authHeader) {
              // No Authorization header - send 401 challenge
              this.rtspDebugLog(
                `Auth required, sending 401 challenge to ${clientId}`,
              );
              sendResponse(401, "Unauthorized", {
                "WWW-Authenticate":
                  this.generateWwwAuthenticateHeader(clientId),
              });
              continue;
            }

            // Validate the Authorization header
            if (
              !this.validateDigestAuth(
                authHeader,
                method ?? "",
                url ?? "",
                clientId,
              )
            ) {
              // Invalid credentials - send 401 with new nonce
              this.rtspDebugLog(`Auth failed for ${clientId}, sending 401`);
              // Generate a new nonce for retry
              this.authNonces.delete(clientId);
              sendResponse(401, "Unauthorized", {
                "WWW-Authenticate":
                  this.generateWwwAuthenticateHeader(clientId),
              });
              continue;
            }
          }
        }
        // --- End Authentication check ---

        if (method === "OPTIONS") {
          sendResponse(200, "OK", {
            Public: "DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, OPTIONS",
          });
        } else if (method === "DESCRIBE") {
          // Best-effort priming: start the native stream to extract codec parameter sets
          // (SPS/PPS for H.264, VPS/SPS/PPS for H.265) needed for a valid SDP response.
          //
          // IMPORTANT: skip priming if param sets are already available from a previous stream.
          // Starting the native stream prematurely (before a real RTSP client has done SETUP/PLAY)
          // is harmful for battery cameras: the camera wakes up, sends a few frames, but the Hub
          // (or the camera itself) closes the stream shortly after because no consumer is actively
          // reading with proper keepalives. By the time SETUP/PLAY arrives the fanout pump has
          // already ended, leaving the new subscriber with a dead queue and no frames.
          // startNativeStream() is always called at SETUP time (see below), so battery cameras
          // are only woken up when an actual RTSP consumer is ready to receive frames.
          //
          // Early wakeup: if the camera is sleeping (API not ready but not closed — e.g. after
          // idle_disconnect) kick off ensureConnected() in the background NOW so the control
          // socket is re-established by the time SETUP arrives.  We don't await this here to
          // avoid adding latency to DESCRIBE; SETUP will call startNativeStream() which internally
          // calls ensureConnected() again — but a second call is a cheap no-op if it's already
          // connected, so there is no race condition.
          if (!this.api.isClosed && !this.api.isReady && !this.nativeStreamActive) {
            void this.api.ensureConnected().catch(() => {
              // handled by startNativeStream() at SETUP time
            });
          }
          if (!this.flow.getFmtp().hasParamSets && this.connectedClients.size === 0) {
            try {
              if (!this.nativeStreamActive) {
                await this.startNativeStream();
              }
            } catch (error) {
              this.logger.warn(
                `[BaichuanRtspServer] Failed to start native stream for SDP priming: ${error}`,
              );
            }

            const { hasParamSets } = this.flow.getFmtp();
            if (!hasParamSets) {
              // Wait for SPS/PPS to arrive before sending DESCRIBE response.
              // TCP cameras typically deliver first keyframe within ~1-2s; the
              // default 3000ms gives slower or 4K cameras enough time, and UDP
              // (battery) gets 4000ms since it starts slower. Without param
              // sets, go2rtc/ffmpeg must wait for in-band SPS/PPS which causes
              // the visible "hang at first load". Battery cameras that have to
              // wake up can need much longer — override via `videoPrimingMs`.
              const primingMs = resolvePrimingMs(
                this.videoPrimingMs,
                this.api.client.getTransport() === "udp" ? "udp" : "tcp",
                DEFAULT_VIDEO_PRIMING_MS,
              );
              const primingStart = Date.now();
              this.logger.info(
                `[rebroadcast] DESCRIBE priming: waiting up to ${primingMs}ms for SPS/PPS  client=${clientId} path=${this.path}`,
              );
              try {
                await Promise.race([
                  this.firstFramePromise || Promise.resolve(),
                  new Promise((resolve) => setTimeout(resolve, primingMs)),
                ]);
              } catch {
                // ignore
              }
              const primingElapsed = Date.now() - primingStart;
              const { hasParamSets: hasParamSetsAfter } = this.flow.getFmtp();
              if (hasParamSetsAfter) {
                this.logger.info(
                  `[rebroadcast] DESCRIBE priming: SPS/PPS received after ${primingElapsed}ms  client=${clientId} path=${this.path}`,
                );
              } else {
                this.logger.warn(
                  `[rebroadcast] DESCRIBE priming: timed out after ${primingElapsed}ms without SPS/PPS — SDP will lack sprop-parameter-sets, downstream decoder may hang  client=${clientId} path=${this.path}`,
                );
              }
            }
          }

          // Audio priming: after video SPS/PPS is ready, wait for the first
          // ADTS AAC frame to arrive. Some cameras (notably Elite Floodlight WiFi)
          // deliver audio frames noticeably later than video on a freshly started
          // native stream — 300 ms is too short and yields a video-only SDP on
          // the first DESCRIBE while the second sees audio because hasAudio is
          // already latched.  Use 2000 ms for TCP and 3000 ms for UDP/battery
          // (BCUDP) where transport latency is higher.  The race resolves as
          // soon as firstAudioPromise fires, so cameras with audio incur no
          // extra latency, and audio-less cameras still hit the cap once.
          if (!this.hasAudio && this.firstAudioPromise) {
            const audioPrimingMs = resolvePrimingMs(
              this.audioPrimingMs,
              this.api.client.getTransport() === "udp" ? "udp" : "tcp",
              DEFAULT_AUDIO_PRIMING_MS,
            );
            const audioPrimingStart = Date.now();
            try {
              await Promise.race([
                this.firstAudioPromise,
                new Promise((resolve) => setTimeout(resolve, audioPrimingMs)),
              ]);
            } catch {
              // ignore
            }
            const audioPrimingElapsed = Date.now() - audioPrimingStart;
            if (this.hasAudio) {
              this.logger.info(
                `[rebroadcast] DESCRIBE audio priming: AAC detected after ${audioPrimingElapsed}ms  client=${clientId} path=${this.path}`,
              );
            } else {
              this.logger.info(
                `[rebroadcast] DESCRIBE audio priming: no audio after ${audioPrimingElapsed}ms — SDP will be video-only  client=${clientId} path=${this.path}`,
              );
            }
          }

          // Generate SDP (parameter sets will be included if available)
          {
            const { fmtp, hasParamSets } = this.flow.getFmtp();
            const fmtpPreview =
              fmtp.length > 160 ? `${fmtp.slice(0, 160)}...` : fmtp;
            this.logger.info(
              `[BaichuanRtspServer] DESCRIBE SDP for ${clientId} path=${this.path} codec=${this.flow.sdpCodec} hasParamSets=${hasParamSets} fmtp=${fmtpPreview}`,
            );
          }
          const sdp = this.generateSdp();
          // Advertise a Content-Base that RTSP clients can resolve. Prefer
          // the interface the client actually used (socket.localAddress) so
          // a wildcard bind (e.g. 0.0.0.0) doesn't end up handing the
          // client a dial-to-0.0.0.0 URL during SETUP. Fallback to
          // listenHost for environments where localAddress is undefined.
          const contentHost =
            (socket.localAddress && socket.localAddress !== "0.0.0.0" && socket.localAddress !== "::"
              ? socket.localAddress.replace(/^::ffff:/, "")
              : null) ?? this.listenHost;
          sendResponse(
            200,
            "OK",
            {
              "Content-Type": "application/sdp",
              "Content-Base": `rtsp://${contentHost}:${this.listenPort}${this.path}/`,
            },
            sdp,
          );
        } else if (method === "SETUP") {
          const isTrack0 = url?.includes("track0");
          const isTrack1 = url?.includes("track1");
          if (!isTrack0 && !isTrack1) {
            sendResponse(404, "Not Found", {
              Session:
                sessionId ||
                `session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            });
            continue;
          }

          // Only accept track1 if we advertised audio in SDP.
          if (isTrack1 && !this.hasAudio) {
            sendResponse(404, "Not Found", {
              Session:
                sessionId ||
                `session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            });
            continue;
          }

          // Add client first
          this.connectedClients.add(clientId);
          this.emit("client", clientId);
          this.clearNoClientAutoStopTimer();

          // Start native stream if first client.
          // Fire-and-forget: do NOT await here.  For battery/UDP cameras, ensureConnected()
          // inside startNativeStream() can take up to 30 s (UDP discovery timeout), which
          // would block the SETUP response and cause the RTSP client to time out.
          // Responding to SETUP immediately lets the connection stay alive; frames will
          // arrive once the camera wakes up (visible in subsequent PLAY traffic).
          if (this.connectedClients.size === 1 && !this.nativeStreamActive) {
            void this.startNativeStream();
          }

          // Parse transport
          const transportMatch = requestText.match(/Transport:\s*([^\r\n]+)/i);
          const transport = (transportMatch?.[1] ?? "").trim();
          useTcpInterleaved = transport
            ? transport.includes("TCP") || transport.includes("tcp")
            : true; // Default to TCP

          // Generate session ID (must stay stable across SETUP for multiple tracks)
          if (!sessionId) {
            sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          }

          // Track client resources
          const existing = this.clientResources.get(clientId);
          if (!existing) {
            this.clientResources.set(clientId, {
              ffmpeg: undefined,
              udpSocket: null,
              udpSocketAudio: null,
              rtspSocket: socket,
              pipelineStarted: false,
              seenFirstVideoKeyframe: false,
              setupTrack0: false,
              setupTrack1: false,
              isPlaying: false,
              connectTime,
            } as any);
          } else {
            // Keep existing state across multiple SETUP requests (track0 + track1).
            existing.rtspSocket = socket;
          }

          // Record requested interleaved channels (ffmpeg can choose them).
          if (useTcpInterleaved) {
            const resources = this.clientResources.get(clientId) as any;
            const requested =
              BaichuanRtspServer.parseInterleavedChannels(transport);
            if (resources) {
              if (isTrack1) {
                const ch = requested ?? { rtp: 2, rtcp: 3 };
                resources.track1RtpChannel = ch.rtp;
                resources.track1RtcpChannel = ch.rtcp;
              } else {
                const ch = requested ?? { rtp: 0, rtcp: 1 };
                resources.track0RtpChannel = ch.rtp;
                resources.track0RtcpChannel = ch.rtcp;
              }
            }
          }

          // Start the media pipeline for this client once (on first SETUP, track0 or track1).
          // Note: in direct-RTP mode there is no ffmpeg process, so we must not rely on `clientFfmpeg`.
          {
            const resources = this.clientResources.get(clientId) as any;
            if (resources && !resources.pipelineStarted) {
              resources.pipelineStarted = true;
              await this.startClientFfmpeg(
                clientId,
                socket,
                useTcpInterleaved,
                (proc, udpSock, udpSockAudio) => {
                  clientFfmpeg = proc;
                  clientUdpSocket = udpSock;
                  clientUdpSocketAudio = udpSockAudio;
                  const r = this.clientResources.get(clientId) as any;
                  if (r) {
                    r.ffmpeg = proc;
                    r.udpSocket = udpSock;
                    r.udpSocketAudio = udpSockAudio;
                  }
                },
              );
            }
          }

          // Mark track SETUP state (used to gate interleaved RTP forwarding).
          {
            const resources = this.clientResources.get(clientId) as any;
            if (resources) {
              if (isTrack1) resources.setupTrack1 = true;
              else resources.setupTrack0 = true;
              const transport = useTcpInterleaved ? "TCP/interleaved" : "UDP";
              const track = isTrack1 ? "track1(audio)" : "track0(video)";
              this.logger.info(
                `[rebroadcast] SETUP  client=${clientId} ${track} transport=${transport} session=${sessionId}`,
              );
            }
          }

          if (useTcpInterleaved) {
            const resources = this.clientResources.get(clientId) as any;
            const fallback = isTrack1
              ? { rtp: 2, rtcp: 3 }
              : { rtp: 0, rtcp: 1 };
            const rtp = isTrack1
              ? (resources?.track1RtpChannel ?? fallback.rtp)
              : (resources?.track0RtpChannel ?? fallback.rtp);
            const rtcp = isTrack1
              ? (resources?.track1RtcpChannel ?? fallback.rtcp)
              : (resources?.track0RtcpChannel ?? fallback.rtcp);
            const interleaved = `${rtp}-${rtcp}`;
            sendResponse(200, "OK", {
              Transport: `RTP/AVP/TCP;unicast;interleaved=${interleaved}`,
              Session: sessionId,
            });
          } else {
            // UDP transport to RTSP client is not the main focus here; keep existing behavior.
            sendResponse(200, "OK", {
              Transport: `RTP/AVP/UDP;unicast;client_port=5004-5005;server_port=5004-5005`,
              Session: sessionId,
            });
          }
        } else if (method === "PLAY") {
          {
            const resources = this.clientResources.get(clientId) as any;
            if (resources) {
              resources.isPlaying = true;
              const hasAudio = !!resources.setupTrack1;
              this.logger.info(
                `[rebroadcast] PLAY  client=${clientId} path=${this.path} profile=${this.profile} channel=${this.channel} codec=${this.flow.sdpCodec} audio=${hasAudio} session=${sessionId}`,
              );
            }
          }
          // Build RTP-Info header with track URLs (go2rtc and other clients expect this)
          {
            const baseUrl = `rtsp://${this.listenHost}:${this.listenPort}${this.path}`;
            const resources = this.clientResources.get(clientId) as any;
            const rtpInfoParts: string[] = [];
            if (resources?.setupTrack0) {
              rtpInfoParts.push(`url=${baseUrl}/track0`);
            }
            if (resources?.setupTrack1) {
              rtpInfoParts.push(`url=${baseUrl}/track1`);
            }
            const playHeaders: Record<string, string> = {
              Session: sessionId,
              Range: "npt=now-",
            };
            if (rtpInfoParts.length > 0) {
              playHeaders["RTP-Info"] = rtpInfoParts.join(",");
            }
            sendResponse(200, "OK", playHeaders);
          }
        } else if (method === "TEARDOWN") {
          this.logger.info(
            `[rebroadcast] TEARDOWN  client=${clientId} session=${sessionId}`,
          );
          cleanup();
          sendResponse(200, "OK", {
            Session: sessionId,
          });
          socket.end();
        } else {
          sendResponse(501, "Not Implemented");
        }
      }
    };

    // Catch any rejection from processBuffer so a stale/closed API does not
    // crash the server with an "Unhandled rejection" (see `get client` in
    // ReolinkBaichuanApi which throws "API has been closed").
    const runProcessBuffer = () => {
      processBuffer().catch((err) => {
        this.logger.debug(
          `[BaichuanRtspServer] processBuffer failed for ${clientId}: ${(err as Error)?.message ?? err}`,
        );
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
    };

    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      runProcessBuffer();
    });

    // Process any complete requests already present in initialBuffer
    if (buffer.includes("\r\n\r\n")) {
      runProcessBuffer();
    }
  }

  /**
   * Generate SDP (Session Description Protocol) for RTSP DESCRIBE.
   */
  private generateSdp(): string {
    const codec = this.flow.sdpCodec;
    const videoPayloadType = 96;
    const audioPayloadType = 97;

    let sdp = "v=0\r\n";
    sdp += `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.listenHost}\r\n`;
    sdp += "s=Baichuan Stream\r\n";
    sdp += `c=IN IP4 ${this.listenHost}\r\n`;
    sdp += "t=0 0\r\n";
    sdp += "a=range:npt=now-\r\n";
    sdp += "a=control:*\r\n";

    // Video track
    sdp += `m=video 0 RTP/AVP ${videoPayloadType}\r\n`;
    sdp += `a=rtpmap:${videoPayloadType} ${codec}/90000\r\n`;
    if (this.streamMetadata?.frameRate) {
      sdp += `a=framerate:${this.streamMetadata.frameRate}\r\n`;
    }
    if (this.streamMetadata?.width && this.streamMetadata?.height) {
      sdp += `a=framesize:${videoPayloadType} ${this.streamMetadata.width}-${this.streamMetadata.height}\r\n`;
    }
    sdp += `a=control:track0\r\n`;

    const { fmtp, hasParamSets } = this.flow.getFmtp();
    if (!hasParamSets) {
      this.logger.warn(
        `[BaichuanRtspServer] SDP missing parameter sets for flow ${this.flow.key}`,
      );
    }

    if (fmtp) {
      sdp += `a=fmtp:${videoPayloadType} ${fmtp}\r\n`;
    }

    // Audio track (TCP only).
    // We packetize AAC (ADTS) as RTP mpeg4-generic, with config derived from ADTS.
    if (this.hasAudio) {
      sdp += `m=audio 0 RTP/AVP ${audioPayloadType}\r\n`;
      const a = this.audioInfo;
      const rate = a?.sampleRate ?? 8000;
      const ch = a?.channels ?? 1;
      const cfg = a?.configHex ?? "";
      sdp += `a=rtpmap:${audioPayloadType} mpeg4-generic/${rate}/${ch}\r\n`;
      if (cfg) {
        sdp += `a=fmtp:${audioPayloadType} streamtype=5; profile-level-id=15; mode=AAC-hbr; config=${cfg}; SizeLength=13; IndexLength=3; IndexDeltaLength=3;\r\n`;
      }
      sdp += `a=control:track1\r\n`;
    }

    return sdp;
  }

  /**
   * Start ffmpeg for a specific client.
   */
  private async startClientFfmpeg(
    clientId: string,
    rtspSocket: net.Socket,
    useTcpInterleaved: boolean,
    onProcess: (
      proc: ReturnType<typeof spawn> | undefined,
      udpSock: dgram.Socket | null,
      udpSockAudio: dgram.Socket | null,
    ) => void,
  ): Promise<void> {
    // Re-fetch stream metadata to ensure we have the correct frame rate for this profile
    let streamMetadata = this.streamMetadata;
    if (!streamMetadata || !streamMetadata.frameRate) {
      try {
        const metadata = await this.api.getStreamMetadata(this.channel);
        const stream = metadata.streams.find((s) => s.profile === this.profile);
        if (stream) {
          streamMetadata = {
            frameRate: stream.frameRate || 25,
            width: stream.width,
            height: stream.height,
          };
          this.rtspDebugLog(
            `Fetched metadata for profile ${this.profile}: ${streamMetadata.frameRate} fps`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `[BaichuanRtspServer] Could not fetch stream metadata: ${error}`,
        );
        streamMetadata = { frameRate: 25 };
      }
    }

    const ffmpegFormat = this.flow.ffmpegFormat;

    // For TCP interleaved we can either:
    // - packetize locally (direct RTP), or
    // - use ffmpeg as a packetizer and forward RTP.
    // The ffmpeg path proved flaky; prefer direct RTP for TCP interleaved.
    let localUdpPort = 0;
    let localUdpPortAudio = 0;
    let udpSocket: dgram.Socket | null = null;
    let udpSocketAudio: dgram.Socket | null = null;

    const useDirectRtp = useTcpInterleaved;

    const frameRtpOverTcp = (channel: number, rtpPacket: Buffer): Buffer => {
      // If the RTSP client negotiated TCP interleaved transport, we MUST use RTSP interleaved framing.
      // RFC4571 is only valid on a raw TCP transport carrying RTP, not on RTSP interleaved.
      const framing = useTcpInterleaved
        ? "rtsp-interleaved"
        : this.tcpRtpFraming;

      if (framing === "rfc4571") {
        const h = Buffer.alloc(2);
        h.writeUInt16BE(rtpPacket.length & 0xffff, 0);
        return Buffer.concat([h, rtpPacket]);
      }
      const h = Buffer.alloc(4);
      h[0] = 0x24; // '$'
      h[1] = channel & 0xff;
      h[2] = (rtpPacket.length >> 8) & 0xff;
      h[3] = rtpPacket.length & 0xff;
      return Buffer.concat([h, rtpPacket]);
    };

    if (useTcpInterleaved && !useDirectRtp) {
      localUdpPort = 50000 + Math.floor(Math.random() * 10000);
      udpSocket = dgram.createSocket("udp4");

      await new Promise<void>((resolve, reject) => {
        udpSocket!.once("listening", () => resolve());
        udpSocket!.once("error", reject);
        udpSocket!.bind(localUdpPort, "127.0.0.1");
      });

      const sendInterleaved = (channel: number, msg: Buffer): boolean => {
        if (!rtspSocket || rtspSocket.destroyed || !rtspSocket.writable)
          return false;
        if (msg.length < 12) return false;

        const version = (msg[0]! >> 6) & 0x3;
        if (version !== 2) return false;

        // Gate forwarding until the RTSP client has completed SETUP and PLAY.
        const resources = this.clientResources.get(clientId) as any;
        if (!resources?.isPlaying) return false;
        const videoRtpChannel = resources?.track0RtpChannel ?? 0;
        const audioRtpChannel = resources?.track1RtpChannel ?? 2;
        if (channel === videoRtpChannel && !resources?.setupTrack0)
          return false;
        if (channel === audioRtpChannel && !resources?.setupTrack1)
          return false;

        // Backpressure: kill dead/slow clients whose socket buffer has grown too large.
        // A healthy TCP connection drains near-instantly; a large backlog means the
        // client is dead or too slow to consume the stream (e.g., network drop).
        const buffered = rtspSocket.writableLength;
        if (buffered > 10 * 1024 * 1024) {
          this.logger.warn(
            `[rebroadcast] backpressure: ${Math.round(buffered / 1024)}KB buffered for client=${clientId} — disconnecting`,
          );
          rtspSocket.destroy();
          return false;
        }

        try {
          return rtspSocket.write(frameRtpOverTcp(channel, msg));
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error as any).code === "EPIPE"
          )
            return false;
        }

        return false;
      };

      if (udpSocket) {
        const resources = this.clientResources.get(clientId) as any;
        const videoRtpChannel = resources?.track0RtpChannel ?? 0;
        let rtpPacketCount = 0;
        let firstSeen = false;
        let firstForwarded = false;
        udpSocket.on("message", (msg: Buffer) => {
          if (!firstSeen) {
            firstSeen = true;
            this.rtspDebugLog(
              `First video RTP packet received from ffmpeg for client ${clientId} (len=${msg.length})`,
            );
          }

          const forwarded = sendInterleaved(videoRtpChannel, msg);
          if (forwarded && !firstForwarded) {
            firstForwarded = true;
            this.rtspDebugLog(
              `First video RTP packet forwarded via TCP interleaved for client ${clientId}`,
            );
          }
          rtpPacketCount++;
          if (rtpPacketCount % 1000 === 0) {
            this.rtspDebugLog(
              `Forwarded ${rtpPacketCount} RTP packets to client ${clientId} via TCP interleaved`,
            );
          }
        });
      }

      if (this.hasAudio) {
        localUdpPortAudio =
          localUdpPort + 2 + Math.floor(Math.random() * 1000) * 2;
        udpSocketAudio = dgram.createSocket("udp4");
        await new Promise<void>((resolve, reject) => {
          udpSocketAudio!.once("listening", () => resolve());
          udpSocketAudio!.once("error", reject);
          udpSocketAudio!.bind(localUdpPortAudio, "127.0.0.1");
        });
        let audioPacketCount = 0;
        let firstSeenAudio = false;
        let firstForwardedAudio = false;
        udpSocketAudio.on("message", (msg: Buffer) => {
          const resources = this.clientResources.get(clientId) as any;
          const audioRtpChannel = resources?.track1RtpChannel ?? 2;
          audioPacketCount++;
          if (!firstSeenAudio) {
            firstSeenAudio = true;
            this.rtspDebugLog(
              `First audio RTP packet received from ffmpeg for client ${clientId} (len=${msg.length})`,
            );
          }
          const forwarded = sendInterleaved(audioRtpChannel, msg);
          if (forwarded && !firstForwardedAudio) {
            firstForwardedAudio = true;
            this.rtspDebugLog(
              `First audio RTP packet forwarded via TCP interleaved for client ${clientId}`,
            );
          }
          if (audioPacketCount % 1000 === 0) {
            this.rtspDebugLog(
              `Forwarded ${audioPacketCount} audio RTP packets to client ${clientId} via TCP interleaved`,
            );
          }
        });
      }
    }

    const resources = this.clientResources.get(clientId) as any;
    const rtspDebug = this.isRtspDebugEnabled();
    const rtspDebugLog = (message: string) => this.rtspDebugLog(message);

    // Returns the socket's `write()` backpressure signal: `true` when the kernel
    // accepted the data immediately, `false` when it was buffered (caller should
    // pause and await 'drain' before sending more). Returns `true` on the
    // not-writable / error fast paths so callers don't wait on a dead socket.
    //
    // The send-buffer hard cap below previously lived in an unreachable
    // `useTcpInterleaved && !useDirectRtp` branch (useDirectRtp === useTcpInterleaved),
    // so it never ran on the path consumers actually use. It now runs here.
    const sendInterleaved = (channel: number, msg: Buffer): boolean => {
      if (!rtspSocket || rtspSocket.destroyed || !rtspSocket.writable)
        return true;
      // Backpressure: a large backlog means the client is dead or too slow.
      // Forwarding the ~94 FU-A packets of a 100 KB+ keyframe back-to-back can
      // otherwise balloon the userspace buffer and stall delivery for everyone.
      if (
        BaichuanRtspServer.shouldDisconnectForBackpressure(
          rtspSocket.writableLength,
        )
      ) {
        this.logger.warn(
          `[rebroadcast] backpressure: ${Math.round(rtspSocket.writableLength / 1024)}KB buffered for client=${clientId} — disconnecting`,
        );
        rtspSocket.destroy();
        return true;
      }
      try {
        return rtspSocket.write(frameRtpOverTcp(channel, msg));
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as any).code === "EPIPE"
        )
          return true;
      }
      return true;
    };

    // Pause the feed loop until the client's TCP socket has drained its
    // userspace buffer. Called after each full access unit so a keyframe burst
    // (~94 FU-A writes for a 100 KB+ IDR) cannot pile up faster than the
    // consumer reads it — the root cause of downstream "dropped/choppy frames"
    // even though the source is clean. Resolves immediately when not buffered.
    const awaitClientDrain = async (): Promise<void> => {
      if (!rtspSocket || rtspSocket.destroyed) return;
      if (!rtspSocket.writableNeedDrain) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          rtspSocket.removeListener("drain", done);
          rtspSocket.removeListener("close", done);
          resolve();
        };
        rtspSocket.once("drain", done);
        rtspSocket.once("close", done);
      });
    };

    const getVideoChannel = (): number => resources?.track0RtpChannel ?? 0;
    const getAudioChannel = (): number => resources?.track1RtpChannel ?? 2;

    const buildRtpHeader = (
      payloadType: number,
      marker: boolean,
      seq: number,
      timestamp: number,
      ssrc: number,
    ): Buffer => {
      const h = Buffer.alloc(12);
      h[0] = 0x80; // V=2
      h[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
      h.writeUInt16BE(seq & 0xffff, 2);
      h.writeUInt32BE(timestamp >>> 0, 4);
      h.writeUInt32BE(ssrc >>> 0, 8);
      return h;
    };

    const sendRtpPacket = (
      isAudio: boolean,
      payload: Buffer,
      marker: boolean,
    ) => {
      const pt = isAudio ? 97 : 96;
      if (!resources?.isPlaying) return;
      if (isAudio && !resources?.setupTrack1) return;
      if (!isAudio && !resources?.setupTrack0) return;

      if (!isAudio) {
        if (resources.rtpVideoSeq === undefined)
          resources.rtpVideoSeq = Math.floor(Math.random() * 0x10000);
        // Start at 0 to reduce A/V offset when RTCP SR is not present.
        if (resources.rtpVideoTimestamp === undefined)
          resources.rtpVideoTimestamp = 0;
        if (resources.rtpVideoSsrc === undefined)
          resources.rtpVideoSsrc = (Math.random() * 0xffffffff) >>> 0;
        const h = buildRtpHeader(
          pt,
          marker,
          resources.rtpVideoSeq,
          resources.rtpVideoTimestamp,
          resources.rtpVideoSsrc,
        );
        resources.rtpVideoSeq = (resources.rtpVideoSeq + 1) & 0xffff;
        sendInterleaved(getVideoChannel(), Buffer.concat([h, payload]));
      } else {
        if (resources.rtpAudioSeq === undefined)
          resources.rtpAudioSeq = Math.floor(Math.random() * 0x10000);
        // Start at 0 to reduce A/V offset when RTCP SR is not present.
        if (resources.rtpAudioTimestamp === undefined)
          resources.rtpAudioTimestamp = 0;
        if (resources.rtpAudioSsrc === undefined)
          resources.rtpAudioSsrc = (Math.random() * 0xffffffff) >>> 0;
        const h = buildRtpHeader(
          pt,
          marker,
          resources.rtpAudioSeq,
          resources.rtpAudioTimestamp,
          resources.rtpAudioSsrc,
        );
        resources.rtpAudioSeq = (resources.rtpAudioSeq + 1) & 0xffff;
        sendInterleaved(getAudioChannel(), Buffer.concat([h, payload]));
      }
    };

    const maxRtpPayload = 1200;

    const isH264IdrAccessUnit = (annexB: Buffer): boolean => {
      const nals = BaichuanRtspServer.splitAnnexBNals(annexB);
      for (const nal of nals) {
        if (nal.length < 1) continue;
        const t = (nal[0] ?? 0) & 0x1f;
        if (t === 5) return true; // IDR
      }
      return false;
    };

    const packetizeAndSendH264 = (nal: Buffer, markerOnLast: boolean) => {
      if (nal.length <= maxRtpPayload) {
        sendRtpPacket(false, nal, markerOnLast);
        return;
      }
      const nalHeader = nal[0]!;
      const nalType = nalHeader & 0x1f;
      // FU indicator: keep forbidden_zero_bit + NRI, set type to 28 (FU-A)
      const fuIndicator = (nalHeader & 0xe0) | 28;
      const data = nal.subarray(1);
      let offset = 0;
      while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, maxRtpPayload - 2);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader = (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | nalType;
        const chunk = data.subarray(offset, offset + chunkLen);
        const payload = Buffer.concat([
          Buffer.from([fuIndicator, fuHeader]),
          chunk,
        ]);
        sendRtpPacket(false, payload, markerOnLast && end);
        offset += chunkLen;
      }
    };

    const packetizeAndSendH265 = (nal: Buffer, markerOnLast: boolean) => {
      if (nal.length <= maxRtpPayload) {
        sendRtpPacket(false, nal, markerOnLast);
        return;
      }
      if (nal.length < 3) return;
      const nalHeader0 = nal[0]!;
      const nalHeader1 = nal[1]!;
      const nalType = (nalHeader0 >> 1) & 0x3f;
      const fuIndicator0 = (nalHeader0 & 0x81) | (49 << 1);
      const fuIndicator1 = nalHeader1;
      const data = nal.subarray(2);
      let offset = 0;
      while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, maxRtpPayload - 3);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader =
          (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | (nalType & 0x3f);
        const chunk = data.subarray(offset, offset + chunkLen);
        const payload = Buffer.concat([
          Buffer.from([fuIndicator0, fuIndicator1, fuHeader]),
          chunk,
        ]);
        sendRtpPacket(false, payload, markerOnLast && end);
        offset += chunkLen;
      }
    };

    const videoClockRate = 90000;
    const videoFps =
      streamMetadata?.frameRate && streamMetadata.frameRate > 0
        ? streamMetadata.frameRate
        : 25;
    const videoTimestampIncrement = Math.max(
      1,
      Math.round(videoClockRate / videoFps),
    );

    const setVideoTimestampFromMicroseconds = (
      frameMicroseconds: number | null | undefined,
    ) => {
      if (!resources) return;
      if (frameMicroseconds === null || frameMicroseconds === undefined) return;
      if (!Number.isFinite(frameMicroseconds)) return;

      if (resources.rtpVideoTimestamp === undefined)
        resources.rtpVideoTimestamp = 0;
      if (resources.rtpVideoBaseTimestamp === undefined)
        resources.rtpVideoBaseTimestamp = resources.rtpVideoTimestamp;

      // Unwrap the 32-bit camera µs clock so pacing stays correct past the
      // 2^32 µs (~71.6 min) boundary instead of flatlining. See
      // rtpVideoTimestamp.ts for the wrap details.
      const { timestamp, state } = deriveRtpVideoTimestamp(
        {
          timestamp: resources.rtpVideoTimestamp,
          baseTimestamp: resources.rtpVideoBaseTimestamp,
          unwrappedUs: resources.rtpVideoUnwrappedUs,
          lastRawUs: resources.rtpVideoLastRawUs,
          baseUnwrappedUs: resources.rtpVideoBaseUnwrappedUs,
        },
        frameMicroseconds,
        videoClockRate,
      );

      resources.rtpVideoTimestamp = timestamp;
      resources.rtpVideoBaseTimestamp = state.baseTimestamp;
      resources.rtpVideoUnwrappedUs = state.unwrappedUs;
      resources.rtpVideoLastRawUs = state.lastRawUs;
      resources.rtpVideoBaseUnwrappedUs = state.baseUnwrappedUs;
      resources.rtpVideoLastTimestamp = timestamp;

      // Mark the µs path active so sendVideoAccessUnit() does not also apply
      // the fixed-FPS fallback increment.
      if (resources.rtpVideoBaseMicroseconds === undefined)
        resources.rtpVideoBaseMicroseconds = frameMicroseconds >>> 0;
    };

    const sendVideoAccessUnit = (
      videoType: "H264" | "H265",
      accessUnitAnnexB: Buffer,
      advanceTimestamp = true,
    ) => {
      const nals = BaichuanRtspServer.splitAnnexBNals(accessUnitAnnexB);
      if (nals.length === 0) return;
      for (let idx = 0; idx < nals.length; idx++) {
        const nal = nals[idx]!;
        const isLastNal = idx === nals.length - 1;
        if (videoType === "H265") packetizeAndSendH265(nal, isLastNal);
        else packetizeAndSendH264(nal, isLastNal);
      }

      // If we don't have bcmedia microseconds available, fall back to fixed FPS increment.
      if (
        advanceTimestamp &&
        resources?.rtpVideoTimestamp !== undefined &&
        resources?.rtpVideoBaseMicroseconds === undefined
      ) {
        resources.rtpVideoTimestamp =
          (resources.rtpVideoTimestamp + videoTimestampIncrement) >>> 0;
      }
    };

    const sendAudioAdtsFrame = (adts: Buffer) => {
      const raw = BaichuanRtspServer.stripAdtsHeader(adts);
      if (!raw) return;
      // RFC 3640: AU-headers-length (16 bits) + AU-header (16 bits)
      const auHeadersLength = Buffer.from([0x00, 0x10]);
      const auSize = raw.length & 0x1fff;
      const auHeader = Buffer.alloc(2);
      // AU-size (13 bits) + AU-Index (3 bits, 0)
      auHeader[0] = (auSize >> 5) & 0xff;
      auHeader[1] = (auSize & 0x1f) << 3;
      const payload = Buffer.concat([auHeadersLength, auHeader, raw]);
      sendRtpPacket(true, payload, true);

      // advance audio timestamp by 1024 samples per AAC-LC frame
      if (resources?.rtpAudioTimestamp !== undefined) {
        resources.rtpAudioTimestamp =
          (resources.rtpAudioTimestamp + 1024) >>> 0;
      }
    };

    const isH265IrapAccessUnit = (annexB: Buffer): boolean => {
      const nals = splitAnnexBToNalPayloads(annexB);
      for (const nal of nals) {
        if (nal.length < 2) continue;
        const b0 = nal[0];
        if (b0 === undefined) continue;
        if ((b0 & 0x80) !== 0) continue;
        const nalType = (b0 >> 1) & 0x3f;
        if (isH265Irap(nalType)) return true;
      }
      return false;
    };

    if (useDirectRtp) {
      onProcess(undefined, null, null);
    }

    let ffmpeg: ReturnType<typeof spawn> | undefined;
    let audioPipe: NodeJS.WritableStream | undefined;
    if (!useDirectRtp) {
      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts+igndts", // Generate PTS, ignore DTS from input
      ];

      // Set input frame rate if available (before -f and -i)
      // This tells ffmpeg how to interpret the timing of frames from stdin
      const frameRate = streamMetadata?.frameRate || 25;
      if (frameRate > 0) {
        ffmpegArgs.push("-r", frameRate.toString());
        this.rtspDebugLog(
          `Using frame rate ${frameRate} fps for client ${clientId}`,
        );
      }

      ffmpegArgs.push("-f", ffmpegFormat, "-i", "pipe:0");

      // Optional audio input (AAC ADTS -> RTP L16).
      // We keep it TCP-only and conservative: if audio isn't detected/advertised, skip entirely.
      if (this.hasAudio) {
        ffmpegArgs.push("-f", "aac", "-i", "pipe:3");
      }

      // Note: For RTP output, we don't need to specify output frame rate
      // The timestamps will be generated based on the input frame rate and -vsync cfr

      // Note: Frames from BaichuanVideoStream are already in Annex-B format with SPS/PPS prepended
      // So we don't need h264_mp4toannexb or hevc_mp4toannexb bitstream filters
      if (useTcpInterleaved) {
        // Video output
        ffmpegArgs.push(
          "-map",
          "0:v:0",
          "-c:v",
          "copy",
          "-vsync",
          "cfr", // Constant frame rate - generate timestamps based on input frame rate
          "-avoid_negative_ts",
          "make_zero", // Ensure timestamps are non-negative
          "-f",
          "rtp",
          "-payload_type",
          "96",
          `rtp://127.0.0.1:${localUdpPort}?pkt_size=1300`,
        );
        // Audio output
        if (this.hasAudio && udpSocketAudio && localUdpPortAudio) {
          const a = this.audioInfo;
          const rate = a?.sampleRate ?? 8000;
          const ch = a?.channels ?? 1;
          ffmpegArgs.push(
            "-map",
            "1:a:0",
            // ffmpeg's RTP muxer requires AAC extradata (global headers); encoding ensures it's present.
            "-c:a",
            "aac",
            "-profile:a",
            "aac_low",
            "-ar",
            String(rate),
            "-ac",
            String(ch),
            "-flags:a",
            "+global_header",
            "-f",
            "rtp",
            "-payload_type",
            "97",
            `rtp://127.0.0.1:${localUdpPortAudio}?pkt_size=1300`,
          );
        }
      } else {
        ffmpegArgs.push(
          "-map",
          "0:v:0",
          "-c:v",
          "copy",
          "-vsync",
          "cfr",
          "-avoid_negative_ts",
          "make_zero",
          "-f",
          "rtp",
          "-payload_type",
          "96",
          `rtp://127.0.0.1:5004?pkt_size=1300`,
        );
      }

      const stdio: any[] = ["pipe", "ignore", "pipe"];
      if (this.hasAudio) stdio.push("pipe");
      this.rtspDebugLog(
        `Spawning ffmpeg for client ${clientId}: ffmpeg ${ffmpegArgs.join(" ")}`,
      );
      ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio,
      });

      // Seed ffmpeg with video parameter sets so it can start parsing/packetizing immediately.
      // This helps when live access units don't carry SPS/PPS early enough.
      try {
        const paramSets = this.flow.getParameterSetsAnnexB();
        if (paramSets && paramSets.length > 0 && ffmpeg?.stdin) {
          ffmpeg.stdin.write(paramSets);
          this.rtspDebugLog(
            `Wrote video parameter sets to ffmpeg stdin for client ${clientId} (len=${paramSets.length})`,
          );
        }
      } catch (e) {
        this.logger.warn(
          `[BaichuanRtspServer] Failed to write video parameter sets to ffmpeg for client ${clientId}: ${e}`,
        );
      }
      ffmpeg.on("error", (error) => {
        this.logger.error(
          `[BaichuanRtspServer] Failed to spawn ffmpeg for client ${clientId}:`,
          error,
        );
      });

      ffmpeg.on("close", (code, signal) => {
        this.rtspDebugLog(
          `ffmpeg exited for client ${clientId} (code=${code}, signal=${signal})`,
        );
      });

      onProcess(ffmpeg, udpSocket, udpSocketAudio);

      // Prevent unhandled errors on the writable side when the client disconnects or the server stops.
      // We treat these as normal shutdown signals.
      ffmpeg.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        const code = (error as any)?.code;
        if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
          this.rtspDebugLog(
            `FFmpeg stdin error (${code}) for client ${clientId}`,
          );
          return;
        }
        this.logger.error(
          `[BaichuanRtspServer] FFmpeg stdin error for client ${clientId}:`,
          error,
        );
      });

      audioPipe = this.hasAudio
        ? (ffmpeg.stdio?.[3] as NodeJS.WritableStream | undefined)
        : undefined;
      (audioPipe as any)?.on?.("error", (error: NodeJS.ErrnoException) => {
        const code = (error as any)?.code;
        if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
          this.rtspDebugLog(
            `FFmpeg audio pipe error (${code}) for client ${clientId}`,
          );
          return;
        }
        this.logger.error(
          `[BaichuanRtspServer] FFmpeg audio pipe error for client ${clientId}:`,
          error,
        );
      });

      // If we already observed an ADTS frame during SDP priming, push one immediately.
      // This prevents ffmpeg from blocking on probing `pipe:3` before it can start producing RTP.
      if (audioPipe && this.audioPrimingFrame) {
        try {
          audioPipe.write(this.audioPrimingFrame);
        } catch {}
      }
    }

    // Each RTSP client gets its own iterator, but they all share the same underlying
    // camera-native stream (critical for BCUDP/battery reliability).
    this.rtspDebugLog(`Creating native stream iterator for client ${clientId}`);
    const clientGenerator = this.nativeFanout
      ? this.nativeFanout.subscribe(clientId)
      : createNativeStream(this.api, this.channel, this.profile, {
          variant: this.variant,
        });
    // Legacy: disable old priming generator reuse path.
    this.tempStreamGenerator = null;

    // Feed frames to ffmpeg from native stream with proper timing
    let frameCount = 0;
    let lastFrameTime = Date.now();
    const targetFrameInterval =
      streamMetadata && streamMetadata.frameRate > 0
        ? 1000 / streamMetadata.frameRate
        : 40; // Default to 25fps if not available

    // Prebuffer injection: snapshot the ring buffer and find the last IDR.
    // Subscribing to the live fanout first ensures no frames are dropped while
    // we replay prebuffered ones.
    const prebufferSnap = this.prebuffer.slice();
    let lastIdrIdx = -1;
    for (let i = prebufferSnap.length - 1; i >= 0; i--) {
      if (prebufferSnap[i]!.isKeyframe) {
        lastIdrIdx = i;
        break;
      }
    }
    const prebufferFrames =
      lastIdrIdx >= 0 ? prebufferSnap.slice(lastIdrIdx) : [];
    if (prebufferFrames.length > 0) {
      this.logger.info(
        `[rebroadcast] prebuffer replay  client=${clientId} frames=${prebufferFrames.length} starting from IDR`,
      );
    }

    // Combined generator: prebuffered IDR-onwards frames first, then live stream.
    const combined = async function* () {
      for (const entry of prebufferFrames) yield entry.frame;
      for await (const f of clientGenerator) yield f;
    };

    const feedFrames = async () => {
      try {
        this.rtspDebugLog(
          `Starting to feed frames to client ${clientId} (target FPS: ${streamMetadata?.frameRate || 25}, interval: ${targetFrameInterval}ms)`,
        );
        let audioFrameCount = 0;
        let firstVideoWriteLogged = false;
        let firstAudioWriteLogged = false;
        let firstVideoFrameSeenLogged = false;
        let h265WaitParamSetsLogged = false;
        let h265WaitIrapLogged = false;
        for await (const frame of combined()) {
          // Check if client is still connected before processing frame
          if (!this.connectedClients.has(clientId)) {
            this.rtspDebugLog(
              `Client ${clientId} disconnected, stopping frame feed`,
            );
            break;
          }

          const stdin = ffmpeg?.stdin;
          if (!useDirectRtp) {
            if (
              !stdin ||
              stdin.destroyed ||
              stdin.writableEnded ||
              stdin.writableFinished
            ) {
              this.rtspDebugLog(`FFmpeg stdin closed for client ${clientId}`);
              break;
            }
          }

          if (frame.data.length === 0) continue;

          if (!frame.audio && !firstVideoFrameSeenLogged) {
            firstVideoFrameSeenLogged = true;
            if (rtspDebug) {
              const headHex = frame.data.subarray(0, 16).toString("hex");
              rtspDebugLog(
                `First video frame received from generator for client ${clientId} (len=${frame.data.length}, videoType=${String(
                  (frame as any).videoType ?? this.flow.videoType,
                )}, head=${headHex})`,
              );
            }
          }

          // Handle audio frames (TCP only): write ADTS AAC frames to ffmpeg audio pipe.
          if (frame.audio) {
            audioFrameCount++;
            if (audioFrameCount === 1) {
              this.rtspDebugLog(
                `Audio frames detected (codec: ${frame.codec || "unknown"}, sampleRate: ${frame.sampleRate || "unknown"})`,
              );
            }
            if (audioFrameCount % 100 === 0) {
              this.rtspDebugLog(
                `Received ${audioFrameCount} audio frames (not sent to RTSP yet)`,
              );
            }

            if (useDirectRtp) {
              // Avoid starting with audio-only while the decoder is still waiting for the first keyframe.
              if (!resources?.seenFirstVideoKeyframe) {
                continue;
              }
              if (
                this.hasAudio &&
                BaichuanRtspServer.isAdtsAacFrame(frame.data)
              ) {
                if (rtspDebug && !firstAudioWriteLogged) {
                  firstAudioWriteLogged = true;
                  const headHex = frame.data.subarray(0, 16).toString("hex");
                  rtspDebugLog(
                    `First audio ADTS frame packetized to RTP for client ${clientId} (len=${frame.data.length}, head=${headHex})`,
                  );
                }
                sendAudioAdtsFrame(frame.data);
              }
              continue;
            } else {
              const audioPipeOk =
                this.hasAudio &&
                audioPipe &&
                !(audioPipe as any).writableEnded &&
                !(audioPipe as any).writableFinished;
              if (audioPipeOk) {
                const ap = audioPipe;
                if (!ap) continue;
                // Only accept AAC ADTS frames for now.
                if (BaichuanRtspServer.isAdtsAacFrame(frame.data)) {
                  try {
                    if (!firstAudioWriteLogged) {
                      firstAudioWriteLogged = true;
                      const headHex = frame.data
                        .subarray(0, 16)
                        .toString("hex");
                      this.rtspDebugLog(
                        `First audio frame written to ffmpeg pipe for client ${clientId} (len=${frame.data.length}, head=${headHex})`,
                      );
                    }
                    const written = ap.write(frame.data);
                    if (!written) {
                      await new Promise<void>((resolve) =>
                        ap.once("drain", () => resolve()),
                      );
                    }
                  } catch {}
                }
              }
              continue;
            }
            continue;
          }

          // Extract parameter sets until available.
          // Some cameras don't include VPS/SPS/PPS in the very first access unit.
          if (frame.videoType === "H264" || frame.videoType === "H265") {
            const normalizedVideoData =
              frame.videoType === "H264"
                ? convertH264ToAnnexB(frame.data)
                : convertH265ToAnnexB(frame.data);
            if (frameCount === 0) {
              this.setFlowVideoType(frame.videoType, "first video frame");
            }

            const before = this.flow.getFmtp();
            if (!before.hasParamSets) {
              this.flow.extractParameterSets(normalizedVideoData);
              const after = this.flow.getFmtp();
              if (after.hasParamSets) {
                this.markFirstFrameReceived();
              }
            } else if (!this.firstFrameReceived) {
              this.markFirstFrameReceived();
            }
          }

          frameCount++;
          if (frameCount % 100 === 0) {
            this.rtspDebugLog(
              `Sent ${frameCount} frames to client ${clientId} (frame size: ${frame.data.length} bytes)`,
            );
          }

          // Throttle frame sending to match frame rate — FFmpeg path only.
          // For direct RTP, the client (go2rtc/ffmpeg) uses RTP timestamps for timing;
          // throttling here would only cause artificial frame drops when the camera
          // streams faster than the configured FPS (e.g., 30fps camera with 25fps metadata).
          if (!useDirectRtp) {
            const now = Date.now();
            const timeSinceLastFrame = now - lastFrameTime;
            const waitTime = targetFrameInterval - timeSinceLastFrame;
            if (waitTime > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(waitTime, targetFrameInterval * 2)),
              );
            }
            lastFrameTime = Date.now();
          }

          if (useDirectRtp) {
            const videoType = (frame.videoType ?? this.flow.videoType) as
              | "H264"
              | "H265";
            const normalizedVideoData =
              videoType === "H264"
                ? convertH264ToAnnexB(frame.data)
                : convertH265ToAnnexB(frame.data);

            // Many cameras start streaming with P-frames; decoding stays black until the first IDR/IRAP.
            // For H.264 we gate strictly on IDR.
            // For H.265 we gate on: (1) having VPS/SPS/PPS extracted (so we can send config), then
            // (2) seeing an IRAP access unit (with a short timeout to avoid deadlocks).
            if (!resources?.seenFirstVideoKeyframe) {
              if (videoType === "H265") {
                const { hasParamSets } = this.flow.getFmtp();
                if (!hasParamSets) {
                  if (rtspDebug && !h265WaitParamSetsLogged) {
                    h265WaitParamSetsLogged = true;
                    rtspDebugLog(
                      `H265 gating: waiting for VPS/SPS/PPS before sending RTP to client ${clientId}`,
                    );
                  }
                  continue;
                }

                // Send parameter sets as soon as we have them, even before the first IRAP.
                if (!resources?.rtpSentVideoConfig) {
                  const paramSets = this.flow.getParameterSetsAnnexB();
                  if (paramSets && paramSets.length > 0) {
                    sendVideoAccessUnit(videoType, paramSets, false);
                    resources.rtpSentVideoConfig = true;
                  }
                }

                if (!resources.h265WaitStartMs)
                  resources.h265WaitStartMs = Date.now();
                const isIrap = isH265IrapAccessUnit(normalizedVideoData);
                const waitedMs =
                  Date.now() - (resources.h265WaitStartMs as number);
                if (!isIrap && waitedMs < 2000) {
                  if (rtspDebug && !h265WaitIrapLogged) {
                    h265WaitIrapLogged = true;
                    rtspDebugLog(
                      `H265 gating: waiting for IRAP (or timeout) for client ${clientId}`,
                    );
                  }
                  continue;
                }

                resources.seenFirstVideoKeyframe = true;
              } else {
                // H.264 gating:
                // - wait until SPS/PPS are extracted (so we can provide config)
                // - then wait for an IDR (type 5)
                const { hasParamSets } = this.flow.getFmtp();
                if (!hasParamSets) {
                  if (rtspDebug && !h265WaitParamSetsLogged) {
                    // reuse the flag name to avoid adding more state; message makes it clear.
                    h265WaitParamSetsLogged = true;
                    rtspDebugLog(
                      `H264 gating: waiting for SPS/PPS before sending RTP to client ${clientId}`,
                    );
                  }
                  continue;
                }

                // Send parameter sets as soon as we have them, even before the first IDR.
                if (!resources?.rtpSentVideoConfig) {
                  const paramSets = this.flow.getParameterSetsAnnexB();
                  if (paramSets && paramSets.length > 0) {
                    sendVideoAccessUnit(videoType, paramSets, false);
                    resources.rtpSentVideoConfig = true;
                  }
                }

                const isIdr = isH264IdrAccessUnit(normalizedVideoData);
                if (!isIdr) {
                  continue;
                }

                resources.seenFirstVideoKeyframe = true;
              }
            }

            // Derive RTP timestamps from the bcmedia microseconds clock (when available).
            // This makes frame pacing/timing match the camera source more closely than using a fixed FPS increment.
            const frameMicroseconds = (frame as any).microseconds as
              | number
              | null
              | undefined;
            setVideoTimestampFromMicroseconds(frameMicroseconds);

            if (!resources?.rtpSentVideoConfig) {
              const paramSets = this.flow.getParameterSetsAnnexB();
              if (paramSets && paramSets.length > 0) {
                // Parameter sets are not a video frame; keep the same RTP timestamp.
                sendVideoAccessUnit(videoType, paramSets, false);
                resources.rtpSentVideoConfig = true;
              }
            }
            if (!firstVideoWriteLogged) {
              firstVideoWriteLogged = true;
              const clientConnectTime: number = (resources as any)?.connectTime ?? Date.now();
              const ttffMs = Date.now() - clientConnectTime;
              this.logger.info(
                `[rebroadcast] first keyframe → client  client=${clientId} codec=${videoType} ttff=${ttffMs}ms`,
              );
              if (rtspDebug) {
                const headHex = frame.data.subarray(0, 16).toString("hex");
                rtspDebugLog(
                  `First video access unit packetized to RTP for client ${clientId} (len=${frame.data.length}, head=${headHex})`,
                );
              }
            }

            if (resources) {
              (resources as any).framesSent = ((resources as any).framesSent ?? 0) + 1;
            }
            sendVideoAccessUnit(videoType, normalizedVideoData, true);
            // Backpressure: wait for the client socket to drain before pulling
            // the next access unit, so bursts (keyframes) don't flood/coalesce.
            await awaitClientDrain();
          } else {
            try {
              if (
                stdin &&
                !stdin.destroyed &&
                !stdin.writableEnded &&
                !stdin.writableFinished
              ) {
                if (!firstVideoWriteLogged) {
                  firstVideoWriteLogged = true;
                  const headHex = frame.data.subarray(0, 16).toString("hex");
                  this.rtspDebugLog(
                    `First video frame written to ffmpeg stdin for client ${clientId} (len=${frame.data.length}, head=${headHex})`,
                  );
                }
                const written = stdin.write(
                  frame.videoType === "H264"
                    ? convertH264ToAnnexB(frame.data)
                    : frame.data,
                );
                if (!written) {
                  await new Promise<void>((resolve) => {
                    if (stdin) {
                      stdin.once("drain", () => resolve());
                    } else {
                      resolve();
                    }
                  });
                }
              }
            } catch (error) {
              const code = (error as any)?.code;
              if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
                this.rtspDebugLog(
                  `EPIPE writing to ffmpeg for client ${clientId}`,
                );
                break;
              }
              this.logger.error(
                `[BaichuanRtspServer] Error writing frame to ffmpeg for client ${clientId}:`,
                error,
              );
            }
          }
        }
        this.rtspDebugLog(
          `Finished feeding frames to client ${clientId} (total: ${frameCount} frames)`,
        );
      } catch (error) {
        this.logger.error(
          `[BaichuanRtspServer] Error in feedFrames for client ${clientId}:`,
          error,
        );
      }
    };

    feedFrames().catch((error) => {
      this.logger.error(
        `[BaichuanRtspServer] Error feeding frames to client ${clientId}:`,
        error,
      );
    });

    // Log ffmpeg errors (ffmpeg path only)
    ffmpeg?.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("error") || output.includes("Error")) {
        this.logger.error(
          `[BaichuanRtspServer] FFmpeg error for client ${clientId}: ${output}`,
        );
      }
    });
  }

  /**
   * Always-on source: bridge a {@link ContinuousVideoStream} into the existing
   * fanout. Yields the same frame shape that `createNativeStream` produces, so
   * the rest of the pipeline (prebuffer, param-set extraction, per-client
   * subscribe, ffmpeg/direct-RTP) is unchanged.
   *
   * The CVS itself is long-lived (created once, reused across native-stream
   * restarts) and is driven by the {@link AlwaysOnController}, which opens/closes
   * live windows from camera events. Each fanout source generator only forwards
   * CVS events to the fanout pump for as long as `signal` is not aborted.
   */
  private async *createContinuousSource(
    dedicatedClient:
      | import("../../client/BaichuanClient").BaichuanClient
      | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<
    {
      audio: boolean;
      data: Buffer;
      codec: string | null;
      sampleRate: number | null;
      microseconds: number | null;
      videoType?: "H264" | "H265";
      isKeyframe?: boolean;
    },
    void,
    unknown
  > {
    const cvs = this.ensureContinuousStream(dedicatedClient);

    type SourceFrame = {
      audio: boolean;
      data: Buffer;
      codec: string | null;
      sampleRate: number | null;
      microseconds: number | null;
      videoType?: "H264" | "H265";
      isKeyframe?: boolean;
    };

    const queue: SourceFrame[] = [];
    const MAX_QUEUE = 200;
    let wake: (() => void) | null = null;
    let done = false;

    const push = (frame: SourceFrame) => {
      queue.push(frame);
      if (queue.length > MAX_QUEUE) {
        queue.splice(0, queue.length - MAX_QUEUE);
      }
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };

    const onVideo = (au: {
      data: Buffer;
      isKeyframe: boolean;
      videoType: "H264" | "H265";
      microseconds: number;
    }) => {
      push({
        audio: false,
        data: au.data,
        codec: null,
        sampleRate: null,
        microseconds: au.microseconds,
        videoType: au.videoType,
        isKeyframe: au.isKeyframe,
      });
    };
    const onAudio = (frame: Buffer) => {
      push({
        audio: true,
        data: frame,
        codec: "aac",
        sampleRate: 8000,
        microseconds: null,
      });
    };
    const finish = () => {
      done = true;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    const onAbort = () => finish();

    cvs.on("videoAccessUnit", onVideo);
    cvs.on("audioFrame", onAudio);
    cvs.on("close", finish);
    if (signal.aborted) {
      done = true;
    } else {
      signal.addEventListener("abort", onAbort);
    }

    try {
      while (!done && !signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (done || signal.aborted) {
              wake = null;
              resolve();
            }
          });
        }
      }
      // Drain whatever is left so a clean close still delivers buffered frames.
      while (queue.length > 0 && !signal.aborted) {
        yield queue.shift()!;
      }
    } finally {
      cvs.off("videoAccessUnit", onVideo);
      cvs.off("audioFrame", onAudio);
      cvs.off("close", finish);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Lazily build the long-lived {@link ContinuousVideoStream} +
   * {@link AlwaysOnController} for always-on mode. Both are created once and
   * reused for the lifetime of the server (across native-stream restarts).
   */
  private ensureContinuousStream(
    dedicatedClient:
      | import("../../client/BaichuanClient").BaichuanClient
      | undefined,
  ): ContinuousVideoStream {
    if (this.continuousStream) return this.continuousStream;

    const createLiveStream = async (): Promise<BaichuanVideoStream> => {
      // Return an UN-started BaichuanVideoStream — ContinuousVideoStream owns
      // start() (calling start() twice throws "Video stream already active").
      const client = dedicatedClient ?? this.api.client;
      return new BaichuanVideoStream({
        client,
        api: this.api,
        channel: this.channel,
        profile: this.profile,
        ...(this.variant !== "default" ? { variant: this.variant } : {}),
        ...(this.logger ? { logger: this.logger } : {}),
      });
    };

    const cvsOptions: import("./ContinuousVideoStream").ContinuousVideoStreamOptions =
      {
        createLiveStream,
        ...(this.alwaysOnOptions?.idleFps !== undefined
          ? { idleFps: this.alwaysOnOptions.idleFps }
          : {}),
        ...(this.alwaysOnOptions?.placeholder !== undefined
          ? { placeholder: this.alwaysOnOptions.placeholder }
          : {}),
        ...(this.logger ? { logger: this.logger } : {}),
      };
    const cvs = new ContinuousVideoStream(cvsOptions);
    cvs.on("error", (e) => {
      this.logger.warn(
        `[BaichuanRtspServer] ContinuousVideoStream error: ${e?.message ?? e}`,
      );
    });
    this.continuousStream = cvs;

    // The controller owns the sleep/wake decision; it primes once, opens a
    // window per event, and calls goLive/goIdle on the CVS.
    this.alwaysOnController = new AlwaysOnController({
      api: this.api,
      channel: this.channel,
      options: this.alwaysOnOptions!,
      goLive: () => cvs.goLive(),
      goIdle: () => cvs.goIdle(),
      ...(this.logger ? { logger: this.logger } : {}),
    });
    void this.alwaysOnController.start().catch((e) => {
      this.logger.warn(
        `[BaichuanRtspServer] AlwaysOnController start failed: ${(e as Error)?.message ?? e}`,
      );
    });

    return cvs;
  }

  /**
   * Start native stream (mark as active).
   * Each client will create its own generator, so we just track that the stream is active.
   */
  private async startNativeStream(): Promise<void> {
    if (this.nativeStreamActive) {
      return;
    }

    // Ensure the API's control socket is connected before starting the stream.
    // Battery cameras use idle_disconnect: the control socket closes after a
    // period of inactivity but the API object stays valid (isClosed = false).
    // ensureConnected() reconnects transparently so the stream can start
    // without requiring a full reconnect at the manager level.
    if (!this.api.isReady) {
      if (this.api.isClosed) {
        this.logger.warn?.(
          `[rebroadcast] API has been explicitly closed — stream cannot start  profile=${this.profile}`,
        );
        return;
      }
      try {
        this.logger.info?.(
          `[rebroadcast] API not ready (idle disconnect?), calling ensureConnected  profile=${this.profile}`,
        );
        await this.api.ensureConnected();
      } catch (e) {
        this.logger.warn?.(
          `[rebroadcast] ensureConnected failed, aborting stream start: ${e}`,
        );
        return;
      }
    }

    this.nativeStreamActive = true;
    this.firstFrameReceived = false;
    this.firstAudioDetected = false;
    this.hasAudio = false;
    this.audioInfo = null;
    this.audioPrimingFrame = null;

    // Create promise that resolves when first frame arrives
    this.firstFramePromise = new Promise<void>((resolve) => {
      this.firstFrameResolve = resolve;
    });

    this.firstAudioPromise = new Promise<void>((resolve) => {
      this.firstAudioResolve = resolve;
    });

    // Acquire a dedicated socket session for stream isolation.
    // Without this, frames from other active streams (e.g. main) on the shared socket
    // can interleave, causing streamType mismatches and delayed time-to-first-frame.
    let dedicatedClient: import("../../client/BaichuanClient").BaichuanClient | undefined;
    const variantSuffix = this.variant && this.variant !== "default" ? `:${this.variant}` : "";
    const deviceIdPart = this.deviceId ?? "rtsp-server";
    const sessionKey = `live:${deviceIdPart}:ch${this.channel}:${this.profile}${variantSuffix}`;
    try {
      const session = await this.api.createDedicatedSession(sessionKey, this.logger);
      dedicatedClient = session.client;
      this.dedicatedSessionRelease = session.release;
      this.logger.info(
        `[rebroadcast] dedicated session acquired  sessionKey=${sessionKey}`,
      );
    } catch (e) {
      this.logger.warn(
        `[rebroadcast] failed to acquire dedicated session, falling back to shared socket: ${e}`,
      );
    }

    this.logger.info(
      `[rebroadcast] native stream starting  profile=${this.profile} channel=${this.channel} clients=${this.connectedClients.size} dedicated=${!!dedicatedClient}`,
    );

    // Keep-alive behavior is part of the selected protocol flow.
    await this.flow.startKeepAlive(this.api);

    // Use a single shared native stream and fan out frames to clients.
    // This avoids starting/stopping multiple camera streams (especially fragile on BCUDP/battery).
    this.nativeFanout = new NativeStreamFanout({
      maxQueueItems: 200,
      onSubscriberOverflow: (subscriberId, overflow) =>
        this.onSubscriberBacklogOverflow(subscriberId, overflow),
      createSource: (signal) =>
        this.alwaysOnOptions?.enabled
          ? this.createContinuousSource(dedicatedClient, signal)
          : createNativeStream(this.api, this.channel, this.profile, {
              variant: this.variant,
              ...(dedicatedClient ? { client: dedicatedClient } : {}),
              signal,
            }),
      onFrame: (frame) => {
        if (frame.audio) {
          // Detect audio from any transport (TCP or UDP/BCUDP both carry ADTS AAC).
          if (
            !this.hasAudio &&
            BaichuanRtspServer.isAdtsAacFrame(frame.data)
          ) {
            const info = BaichuanRtspServer.parseAdtsSamplingInfo(frame.data);
            if (info) {
              this.hasAudio = true;
              this.audioInfo = {
                codec: "aac-adts",
                sampleRate: info.sampleRate,
                channels: info.channels,
                configHex: info.configHex,
              };
              this.audioPrimingFrame = Buffer.from(frame.data);
              this.markFirstAudioDetected();
              this.rtspDebugLog(
                `Audio detected (AAC/ADTS ${info.sampleRate}Hz ch=${info.channels}); advertising RTSP track1 as mpeg4-generic`,
              );
            }
          }
          return;
        }

        if (frame.data.length === 0) return;
        if (frame.videoType === "H264" || frame.videoType === "H265") {
          this.setFlowVideoType(frame.videoType, "native stream");
        }

        // Extract parameter sets for SDP — only until we have them.
        // Calling extractParameterSets on every frame (after SPS/PPS are known) performs
        // an O(frame_size) NAL scan for nothing; skip it once params are in hand.
        if (!this.flow.getFmtp().hasParamSets) {
          this.flow.extractParameterSets(frame.data);
        }
        if (this.flow.getFmtp().hasParamSets) {
          this.markFirstFrameReceived();
        }

        // Add to prebuffer ring for IDR-aligned fast startup on client connect.
        // Prefer the isKeyframe flag already set by createNativeStream/videoAccessUnit;
        // fall back to NAL inspection only when the field is absent.
        const isKeyframe = typeof frame.isKeyframe === "boolean"
          ? frame.isKeyframe
          : this.isRawFrameKeyframe(frame);
        this.prebuffer.push({
          frame: { ...frame, data: Buffer.from(frame.data) },
          time: Date.now(),
          isKeyframe,
        });
        // Trim frames older than the window.
        const cutoff = Date.now() - this.PREBUFFER_MAX_MS;
        let trimIdx = 0;
        while (
          trimIdx < this.prebuffer.length &&
          this.prebuffer[trimIdx]!.time < cutoff
        ) {
          trimIdx++;
        }
        if (trimIdx > 0) this.prebuffer.splice(0, trimIdx);
      },
      onError: (error) => {
        this.logger.warn(
          `[BaichuanRtspServer] Shared native stream error: ${error}`,
        );
      },
      onEnd: () => {
        // Stream ended (camera went to sleep, Hub closed the relay, or stream error).
        // Reset state so the next SETUP/PLAY triggers a fresh startNativeStream().
        // If connected clients exist, restart immediately so they can continue receiving
        // frames once the camera wakes back up.
        if (!this.nativeStreamActive) return; // already cleaned up
        this.nativeStreamActive = false;
        this.clearNoFrameDeadlineTimer();
        const hadFrames = this.firstFrameReceived;
        this.firstFrameReceived = false;
        this.firstFramePromise = null;
        this.firstFrameResolve = null;
        this.nativeFanout = null;
        // Keep prebuffer across restarts so reconnecting clients can still get
        // IDR-aligned fast startup while the new stream spins up.
        // The prebuffer will be naturally replaced once the new stream starts
        // producing frames (trimmed by the PREBUFFER_MAX_MS window).

        // Reset RTP timestamp bases for all connected clients.
        // The new camera stream will have a reset internal clock, so stale
        // base values would produce non-monotonic / backwards-jumping DTS.
        // Also reset keyframe gate so clients wait for a fresh IDR from the
        // new stream before forwarding frames (avoids sending orphan P-frames
        // that cause H.264 decode errors like "illegal reordering_of_pic_nums_idc").
        for (const [, resources] of this.clientResources) {
          const res = resources as any;
          res.rtpVideoBaseMicroseconds = undefined;
          res.rtpVideoBaseTimestamp = undefined;
          res.rtpVideoLastTimestamp = undefined;
          res.seenFirstVideoKeyframe = false;
          res.rtpSentVideoConfig = false;
          // Keep rtpVideoTimestamp and rtpVideoSeq so the RTP stream
          // continues with monotonically increasing values for the client.
          // The next frame will re-anchor the base from the current timestamp.
        }

        this.logger.info(
          `[rebroadcast] native stream ended (camera sleeping or connection lost)  profile=${this.profile} channel=${this.channel} clients=${this.connectedClients.size}`,
        );

        // Release the dedicated session BEFORE restarting to prevent session leaks.
        // Without awaiting release, the new session would be created while the old one
        // is still active on the camera, causing response_code 430 (too many streams).
        const releaseAndRestart = async () => {
          if (this.dedicatedSessionRelease) {
            const release = this.dedicatedSessionRelease;
            this.dedicatedSessionRelease = undefined;
            try { await release(); } catch { /* ignore */ }
          }
          // Do not restart while the server is tearing down: stop() stops the
          // ContinuousVideoStream which ends the source and fires this onEnd.
          // Restarting here would resurrect the native stream mid-teardown.
          if (this.tearingDown) return;
          if (this.connectedClients.size > 0 && hadFrames) {
            this.logger.info(
              `[rebroadcast] restarting native stream for ${this.connectedClients.size} active client(s)`,
            );
            // Small delay to let the camera fully close the old stream.
            await new Promise((r) => setTimeout(r, 500));
            void this.startNativeStream();
          }
        };
        void releaseAndRestart();
      },
    });
    this.nativeFanout.start();

    // No-frame deadline: stop stream if the camera never responds (sleeping),
    // even when go2rtc is connected. Without this, the BaichuanVideoStream
    // watchdog fires after 60s idle and re-wakes the battery camera.
    this.clearNoFrameDeadlineTimer();
    // Always-on mode: the AlwaysOnController owns the sleep/wake decision, so the
    // server must NOT tear the stream down when the camera is idle/sleeping.
    if (this.nativeStreamNoFrameDeadlineMs > 0 && !this.alwaysOnOptions?.enabled) {
      this.noFrameDeadlineTimer = setTimeout(() => {
        this.noFrameDeadlineTimer = undefined;
        if (!this.firstFrameReceived && this.nativeStreamActive) {
          this.logger.info(
            `[rebroadcast] no frames within ${this.nativeStreamNoFrameDeadlineMs}ms — camera sleeping, stopping stream  profile=${this.profile} channel=${this.channel}`,
          );
          void this.stopNativeStream();
        }
      }, this.nativeStreamNoFrameDeadlineMs);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (this.noFrameDeadlineTimer as any)?.unref?.();
    }

    // If DESCRIBE primes the stream but no RTSP client actually SETUP/PLAYs,
    // auto-stop after a short window so battery cams can go back to sleep.
    // Disabled when nativeStreamPrimeIdleStopMs === 0 (always-mounted mode).
    this.clearNoClientAutoStopTimer();
    // Always-on mode: never auto-stop on a primed-but-no-client window; the
    // controller keeps the continuous stream alive across viewer churn.
    if (this.nativeStreamPrimeIdleStopMs > 0 && !this.alwaysOnOptions?.enabled) {
      this.noClientAutoStopTimer = setTimeout(() => {
        if (this.connectedClients.size === 0) {
          this.rtspDebugLog(
            `Auto-stopping primed native stream (no clients connected)`,
          );
          void this.stopNativeStream();
        }
      }, this.nativeStreamPrimeIdleStopMs);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (this.noClientAutoStopTimer as any)?.unref?.();
    }
  }

  private markFirstFrameReceived(): void {
    if (!this.firstFrameReceived && this.firstFrameResolve) {
      this.firstFrameReceived = true;
      // Camera is alive — cancel the sleeping-camera deadline.
      this.clearNoFrameDeadlineTimer();
      this.rtspDebugLog(
        `First frame received from camera for profile ${this.profile}`,
      );
      this.firstFrameResolve();
      this.firstFrameResolve = null;
    }
  }

  private markFirstAudioDetected(): void {
    if (!this.firstAudioDetected && this.firstAudioResolve) {
      this.firstAudioDetected = true;
      this.firstAudioResolve();
      this.firstAudioResolve = null;
    }
  }

  /**
   * Stop native stream (mark as inactive).
   */
  private async stopNativeStream(): Promise<void> {
    if (!this.nativeStreamActive) {
      return;
    }

    this.logger.info(
      `[rebroadcast] native stream stopping  profile=${this.profile} channel=${this.channel} clients=${this.connectedClients.size}`,
    );

    this.flow.stopKeepAlive();

    this.clearNoClientAutoStopTimer();
    this.clearNoFrameDeadlineTimer();

    this.nativeStreamActive = false;
    this.firstFrameReceived = false;
    this.firstFramePromise = null;
    if (this.firstFrameResolve) {
      // Reject the promise if it's still pending
      this.firstFrameResolve = null;
    }
    this.firstAudioDetected = false;
    this.firstAudioPromise = null;
    if (this.firstAudioResolve) {
      this.firstAudioResolve = null;
    }
    // Stop shared native stream fan-out.
    if (this.nativeFanout) {
      const fanout = this.nativeFanout;
      this.nativeFanout = null;
      await fanout.stop();
    }
    this.prebuffer = [];

    // Release dedicated socket session.
    if (this.dedicatedSessionRelease) {
      const release = this.dedicatedSessionRelease;
      this.dedicatedSessionRelease = undefined;
      try {
        await release();
      } catch {
        // ignore
      }
    }

    // Legacy: ensure no priming generator remains open.
    if (this.tempStreamGenerator) {
      try {
        await this.tempStreamGenerator.return(undefined as any);
      } catch {}
      this.tempStreamGenerator = null;
    }

    // Note: Individual client generators are cleaned up when clients disconnect
  }

  /**
   * Remove a client and schedule native stream stop if no clients remain.
   * Uses a grace period so rapid reconnects (e.g. Frigate polling) reuse the running stream
   * and benefit from the prebuffer instead of waiting for a fresh keyframe.
   */
  /**
   * A subscriber's backlog overflowed and frames the camera actually
   * delivered were evicted before reaching that client.
   *
   * This is the blind spot behind long-running "Frigate reports dropped
   * frames but the stream analyzer says the source is clean" reports: the
   * analyzer measures what arrives *from the camera*, while loss here happens
   * *towards the client* and used to leave no trace at all.
   *
   * Losing a keyframe is called out separately because it is far more
   * damaging than losing inter frames — the consumer then decodes a GOP with
   * no IDR to anchor it, which is what turns into visible corruption and
   * ffmpeg errors rather than a barely perceptible stutter.
   */
  private onSubscriberBacklogOverflow(
    subscriberId: string,
    overflow: BoundedQueueOverflow<{ audio: boolean; isKeyframe?: boolean }>,
  ): void {
    const videoDropped = overflow.dropped.filter((f) => !f.audio);
    const keyframesDropped = videoDropped.filter((f) => f.isKeyframe).length;

    const res = this.clientResources.get(subscriberId) as any;
    if (res) {
      res.framesDropped = (res.framesDropped ?? 0) + videoDropped.length;
      res.keyframesDropped = (res.keyframesDropped ?? 0) + keyframesDropped;
    }

    // At 20 fps a sustained stall would log on every frame, so throttle to one
    // line per client per BACKLOG_OVERFLOW_LOG_INTERVAL_MS. The cumulative
    // totals in the message mean nothing is hidden by the throttling, and the
    // disconnect summary always reports the full count.
    const now = Date.now();
    const lastLogged = this.lastBacklogOverflowLogMs.get(subscriberId) ?? 0;
    if (now - lastLogged < BaichuanRtspServer.BACKLOG_OVERFLOW_LOG_INTERVAL_MS)
      return;
    this.lastBacklogOverflowLogMs.set(subscriberId, now);

    this.logger.warn(
      `[rebroadcast] client backlog overflow: dropping frames for client=${subscriberId} path=${this.path} ` +
        `— consumer is not keeping up (total dropped=${res?.framesDropped ?? videoDropped.length}, ` +
        `keyframes=${res?.keyframesDropped ?? keyframesDropped}). ` +
        `Downstream will report choppy/dropped frames even though the camera feed is fine.`,
    );
  }

  private removeClient(clientId: string): void {
    this.lastBacklogOverflowLogMs.delete(clientId);
    if (this.connectedClients.has(clientId)) {
      this.connectedClients.delete(clientId);
      this.emit("clientDisconnected", clientId);

      // Defer native stream stop to allow rapid reconnects to reuse the running stream.
      // nativeStreamIdleStopMs === 0: keep Baichuan stream running for go2rtc / remount.
      if (this.connectedClients.size === 0) {
        this.clearNoClientAutoStopTimer();
        // Always-on mode: the controller owns lifecycle — do not stop the
        // native/continuous stream just because the last RTSP viewer left.
        if (this.nativeStreamIdleStopMs > 0 && !this.alwaysOnOptions?.enabled) {
          this.noClientAutoStopTimer = setTimeout(() => {
            if (this.connectedClients.size === 0) {
              void this.stopNativeStream();
            }
          }, this.nativeStreamIdleStopMs);
          (this.noClientAutoStopTimer as any)?.unref?.();
        }
      }
    }
  }

  /**
   * Wait until RTSP server is ready to accept connections AND camera starts transmitting frames.
   * This ensures that the server is fully ready, including waiting for the camera to wake up
   * and start sending video frames (important for battery-powered cameras).
   */
  async waitUntilReady(timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.clientConnectionServer) {
        reject(new Error("RTSP server not started"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timeout waiting for RTSP server to be ready (${timeoutMs}ms). Camera may be sleeping or not responding.`,
          ),
        );
      }, timeoutMs);

      // First, check if port is listening
      const checkPort = () => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on("connect", () => {
          socket.destroy();
          // Port is listening, now wait for first frame if native stream is active
          if (this.nativeStreamActive && this.firstFramePromise) {
            this.rtspDebugLog(
              `Port is listening, waiting for camera to start transmitting frames...`,
            );
            this.firstFramePromise
              .then(() => {
                clearTimeout(timeout);
                resolve();
              })
              .catch((error) => {
                clearTimeout(timeout);
                reject(error);
              });
          } else {
            // No native stream active yet, just wait for port
            clearTimeout(timeout);
            resolve();
          }
        });
        socket.on("timeout", () => {
          socket.destroy();
          setTimeout(checkPort, 500);
        });
        socket.on("error", () => {
          socket.destroy();
          setTimeout(checkPort, 500);
        });
        socket.connect(this.listenPort, this.listenHost);
      };

      // Start checking immediately
      checkPort();
    });
  }

  /**
   * Stop the RTSP server.
   * This will close all client connections and release all resources.
   */
  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    // Mark teardown BEFORE stopping the controller/cvs/native stream. Stopping
    // the ContinuousVideoStream emits "close", which ends createContinuousSource
    // and fires the fanout onEnd; without this guard onEnd could restart the
    // native stream mid-teardown when clients are still connected.
    this.tearingDown = true;

    this.logger.info(
      `[BaichuanRtspServer] Stopping RTSP server on ${this.listenHost}:${this.listenPort}...`,
    );

    // Always-on teardown: stop the controller (detaches event listeners,
    // closes any open window) and the continuous stream (goes idle + closes)
    // before tearing down the native stream and client sockets.
    if (this.alwaysOnController) {
      const controller = this.alwaysOnController;
      this.alwaysOnController = null;
      await controller.stop().catch(() => {});
    }
    if (this.continuousStream) {
      const cvs = this.continuousStream;
      this.continuousStream = null;
      await cvs.stop().catch(() => {});
    }

    // Stop native stream
    await this.stopNativeStream();

    // Close all client connections and cleanup resources
    const clientIds = Array.from(this.connectedClients);
    for (const clientId of clientIds) {
      const resources = this.clientResources.get(clientId);
      if (resources) {
        // Kill ffmpeg process
        if (resources.ffmpeg) {
          try {
            resources.ffmpeg.stdin?.end();
            resources.ffmpeg.kill("SIGTERM");
            setTimeout(() => {
              try {
                resources.ffmpeg?.kill("SIGKILL");
              } catch {}
            }, 1000);
          } catch {}
        }

        // Close UDP socket
        if (resources.udpSocket) {
          try {
            resources.udpSocket.close();
          } catch {}
        }

        // Close RTSP socket
        if (resources.rtspSocket && !resources.rtspSocket.destroyed) {
          try {
            resources.rtspSocket.destroy();
          } catch {}
        }
      }
    }
    this.clientResources.clear();

    // Close client connection server
    if (this.clientConnectionServer) {
      await new Promise<void>((resolve) => {
        this.clientConnectionServer?.close(() => {
          resolve();
        });
      });
      this.clientConnectionServer = undefined;
    }

    this.active = false;
    this.connectedClients.clear();
    this.emit("close");
    this.logger.info(`[BaichuanRtspServer] RTSP server stopped`);
  }

  /**
   * Get RTSP URL for this server.
   */
  getRtspUrl(): string {
    return `rtsp://${this.listenHost}:${this.listenPort}${this.path}`;
  }

  /**
   * Check if server is active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get number of connected clients.
   */
  getClientCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Subscribe to the raw native stream for diagnostic purposes.
   * The subscriber receives the same frames as RTSP clients.
   * Counts as a "consumer" for lifecycle — prevents auto-stop while subscribed.
   * If the native stream is not active, starts it automatically.
   */
  async subscribeDiagnostic(id: string): Promise<AsyncGenerator<{
    audio: boolean;
    data: Buffer;
    codec: string | null;
    sampleRate: number | null;
    microseconds: number | null;
    videoType?: "H264" | "H265";
  }, void, unknown>> {
    this.connectedClients.add(`diag:${id}`);
    if (!this.nativeStreamActive) {
      await this.startNativeStream();
    }
    return this.nativeFanout!.subscribe(`diag:${id}`);
  }

  /**
   * Unsubscribe a diagnostic session.
   */
  unsubscribeDiagnostic(id: string): void {
    this.removeClient(`diag:${id}`);
  }

  /**
   * Returns detected audio metadata (available after first audio frame).
   */
  getAudioInfo(): {
    codec: "aac-adts";
    sampleRate: number;
    channels: number;
    configHex: string;
  } | null {
    return this.audioInfo;
  }
}
