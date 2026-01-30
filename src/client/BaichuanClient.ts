import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { BcUdpStream } from "../bcudp/BcUdpStream";
import {
  debugLog,
  eventTraceLog,
  normalizeDebugOptions,
  recordingsTraceLog,
  talkTraceLog,
  traceLog,
  type DebugConfig,
  type DebugOptions,
  type Logger,
} from "../debug/DebugConfig";
import { createDebugGateLogger } from "../logging/logger";
import {
  BC_CLASS_LEGACY,
  BC_CLASS_FILE_DOWNLOAD,
  BC_CLASS_MODERN_24,
  BC_CMD_ID_CHANNEL_INFO_ALL,
  BC_CMD_ID_FILE_INFO_LIST_CLOSE,
  BC_CMD_ID_FILE_INFO_LIST_REPLAY,
  BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
  BC_CMD_ID_FILE_INFO_LIST_GET,
  BC_CMD_ID_FILE_INFO_LIST_OPEN,
  BC_CMD_ID_FIND_REC_VIDEO_CLOSE,
  BC_CMD_ID_FIND_REC_VIDEO_GET,
  BC_CMD_ID_FIND_REC_VIDEO_OPEN,
  BC_CMD_ID_PING,
  BC_CMD_ID_TALK,
  BC_CMD_ID_TALK_ABILITY,
  BC_CMD_ID_TALK_CONFIG,
  BC_CMD_ID_TALK_RESET,
  BC_CMD_ID_UDP_KEEP_ALIVE,
  BC_TCP_DEFAULT_PORT,
} from "../protocol/constants";
import {
  aesDecrypt,
  aesEncrypt,
  bcDecrypt,
  bcEncrypt,
  deriveAesKey,
  md5StrModern,
  type EncryptionProtocol,
} from "../protocol/crypto";
import {
  BaichuanFrameParser,
  encodeHeader,
  type BaichuanFrame,
} from "../protocol/framing";
import {
  buildBinaryExtensionXml,
  buildChannelExtensionXml,
  buildLoginXml,
  getXmlText,
} from "../protocol/xml";
import type { ReolinkEvent } from "../reolink/baichuan/types";
export type { Logger };

function isTalkCmd(cmdId: number): boolean {
  return (
    cmdId === BC_CMD_ID_TALK_ABILITY ||
    cmdId === BC_CMD_ID_TALK_RESET ||
    cmdId === BC_CMD_ID_TALK_CONFIG ||
    cmdId === BC_CMD_ID_TALK
  );
}

export type BaichuanClientOptions = {
  host: string;
  port?: number;
  username: string;
  password: string;
  /** UID used for BCUDP discovery (typical for battery cameras). Required for `transport: "udp"` and UDP fallback in `auto`. */
  uid?: string;
  /**
   * UDP discovery method to use when connecting via `uid`.
   * Default: `local-broadcast` (LAN broadcast). Use `local-direct` to try unicast to the known host first.
   * Use `remote`/`map`/`relay` for P2P discovery via Reolink servers.
   */
  udpDiscoveryMethod?:
    | "local-broadcast"
    | "local-direct"
    | "remote"
    | "map"
    | "relay";
  /**
   * For NVR: logical channel index (0-based).
   * For standalone cameras: usually 0.
   */
  channel?: number;
  /** Structured debug/tracing/dump options. */
  debugOptions?: DebugOptions;
  /** Logger instance (e.g. console). If provided, debug logs will be sent here. */
  logger?: Logger;

  /**
   * Enable periodic polling used by higher-level APIs (e.g. simple motion/AI events).
   *
   * Default: false (push events only).
   */
  enableStatePolling?: boolean;

  /**
   * Idle disconnect.
   *
   * When enabled, the client will close its socket after a period of *user inactivity*
   * (no explicit API calls), as long as there are:
   * - no active video subscriptions on this client
   * - no in-flight requests
   * - no active permits
   *
   * Useful mainly for battery/BCUDP cameras to reduce the chance of keeping them awake.
   */
  idleDisconnect?: boolean;

  /** Idle timeout used when `idleDisconnect` is enabled. Default: 30s. */
  idleDisconnectTimeoutMs?: number;
  /**
   * Transport to use:
   * - `tcp`: Baichuan TCP (typical for wired cameras)
   * - `udp`: BCUDP (typical for battery cameras)
   * - `auto`: try `tcp`, then fallback to `udp`
   */
  transport?: "tcp" | "udp" | "auto";
};

export type MaxEncryption = "none" | "bc" | "aes" | "full_aes";

type PendingKey = `${number}:${number}`; // cmdId:msgNum

export class BaichuanClient extends EventEmitter<{
  frame: [BaichuanFrame];
  push: [BaichuanFrame];
  close: [];
  error: [Error];
  debug: [string, unknown?];
  event: [ReolinkEvent]; // Parsed events (motion/AI)
  channelInfo: [string]; // Channel info XML from cmd_id 145 push
}> {
  /**
   * Process-wide streaming activity registry.
   *
   * Why this exists:
   * - Consumers may create multiple BaichuanClient instances per device:
   *   one for control/polling and one for streaming.
   * - Passive sleep inference should treat the device as awake while ANY client is actively streaming,
   *   even if the current client instance is idle/disconnected.
   */
  private static readonly streamingRegistry = new Map<
    string,
    { activeStreamClients: number }
  >();

  /**
   * Global (process-wide) CoverPreview serialization.
   *
   * Why:
   * - CoverPreview uses fixed msgNum=0 and some firmwares correlate requests loosely.
   * - Concurrent CoverPreview attempts can cause cross-talk (400 rejects / timeouts)
   *   and may leave device-side sessions in a bad state.
   */
  private static readonly coverPreviewQueueTail = new Map<
    string,
    Promise<void>
  >();

  private readonly opts: BaichuanClientOptions;
  private readonly debugCfg: DebugConfig;
  private readonly logger: Logger;

  private tcpSocket: net.Socket | undefined;
  private socketSessionId: string | undefined;
  // Default header channelId to use for host-scoped commands (when `channel` is omitted).
  // Some NVR/HomeHub firmwares use channelId=0 for host operations (PCAP-observed), while others use 250.
  private hostChannelId = 250;

  isStatePollingEnabled(): boolean {
    return this.opts.enableStatePolling ?? false;
  }
  private udpSocket: BcUdpStream | undefined;
  private transport: "tcp" | "udp" = "tcp";
  private readonly parser = new BaichuanFrameParser();
  private readonly pending = new Map<
    PendingKey,
    { resolve: (f: BaichuanFrame) => void; reject: (e: Error) => void }
  >();
  private socketClosed = false;

  private pendingCloseInfo:
    | {
        atMs: number;
        reason: string;
      }
    | undefined;

  private lastDisconnectInfo:
    | {
        atMs: number;
        transport: "tcp" | "udp";
        voluntary: boolean;
        reason: string;
      }
    | undefined;

  private msgNum = 0;
  loggedIn = false; // Public to allow ReolinkBaichuanApi to check login status
  subscribed = false; // Public to allow ReolinkBaichuanApi to check subscription status

  private keepAliveTimer: NodeJS.Timeout | undefined;
  private keepAlivePingInFlight = false;
  // Battery/BCUDP cameras may actively terminate sessions (D2C_DISC) when overwhelmed
  // or sleeping. Without a cooldown, callers can end up in tight reconnect loops.
  private udpReconnectCooldownUntilMs = 0;
  private udpReconnectBackoffMs = 0;
  private udpReconnectLastD2cDiscAtMs = 0;

  private idleDisconnectTimer: NodeJS.Timeout | undefined;
  private lastUserActivityAtMs: number | undefined;
  private permitSeq = 1;
  private readonly permits = new Map<
    number,
    {
      timer: NodeJS.Timeout | undefined;
      untilMs: number;
      reason: string | undefined;
    }
  >();

  private lastRxAtMs: number | undefined;
  private lastTxAtMs: number | undefined;
  private lastRxInfo:
    | {
        atMs: number;
        cmdId: number;
        responseCode: number;
        msgNum: number;
        channelId: number;
        streamType: number;
      }
    | undefined;

  private lastTxInfo:
    | {
        atMs: number;
        cmdId: number;
        responseCode: number;
        msgNum: number;
        channelId: number;
        streamType: number;
      }
    | undefined;

  // Ring-buffer of the last received frames (metadata only). Used for sleep inference heuristics.
  private readonly rxHistory: Array<{
    atMs: number;
    cmdId: number;
    responseCode: number;
    msgNum: number;
    channelId: number;
    streamType: number;
  }> = [];

  // Ring-buffer of the last transmitted frames (metadata only). Used for sleep inference heuristics.
  private readonly txHistory: Array<{
    atMs: number;
    cmdId: number;
    responseCode: number;
    msgNum: number;
    channelId: number;
    streamType: number;
  }> = [];

  // Recording-related command IDs (FileInfoList + findAlarmVideo).
  private static readonly recordingCmdIds = new Set<number>([
    BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
    BC_CMD_ID_FILE_INFO_LIST_OPEN,
    BC_CMD_ID_FILE_INFO_LIST_GET,
    BC_CMD_ID_FILE_INFO_LIST_CLOSE,
    BC_CMD_ID_FIND_REC_VIDEO_OPEN,
    BC_CMD_ID_FIND_REC_VIDEO_GET,
    BC_CMD_ID_FIND_REC_VIDEO_CLOSE,
  ]);

  enc: EncryptionProtocol = { kind: "none" }; // Public to allow ReolinkBaichuanApi to access for audio decryption
  private nonce?: string;

  // Video stream subscriptions: map of cmdId -> Set of msgNum that are subscribed
  private videoSubscriptions = new Map<number, Set<number>>();

  // Tracks whether THIS client currently contributes to the global streaming registry.
  private contributesToGlobalStreamingRegistry = false;

  // Throttled per-stream frame tracing (rx cmd_id=3 stream frames can be extremely chatty).
  private streamTraceStats = new Map<
    number,
    { lastLogMs: number; frames: number }
  >();

  // Throttled global RX cmd tracing (useful to debug missing pushes/events).
  private rxCmdTraceStats = new Map<
    number,
    { lastLogMs: number; frames: number }
  >();

  // AlarmEventList (cmdId=33) can be very chatty (often sent every second).
  // Track last per-channel alarm state so we only emit on transitions.
  private readonly alarmEventState = new Map<
    number,
    {
      motionActive: boolean;
      visitorActive: boolean;
      dayNightActive: boolean;
      aiTypeToken: string; // lowercased token, or "none"
      aiFlag: boolean;
      aiTimeStamp: number | undefined; // numeric timeStamp from event payload (often 0/undefined when idle)
    }
  >();

  constructor(options: BaichuanClientOptions) {
    super();
    this.opts = options;
    this.debugCfg = normalizeDebugOptions(options.debugOptions);
    // Centralized verbosity control: treat `.debug()` as opt-in.
    this.logger = createDebugGateLogger(
      options.logger,
      this.debugCfg.general ||
        this.debugCfg.traceNativeStream ||
        this.debugCfg.traceRecordings ||
        this.debugCfg.traceTalk ||
        this.debugCfg.traceEvents ||
        this.debugCfg.debugRtsp,
    );

    // Ensure socket/transport errors never crash the process by default.
    // Consumers can still add their own `error` listeners.
    this.on("error", (err) => {
      this.logFixed("error", {
        message: err?.message ?? String(err),
        code: (err as any)?.code,
      });
    });
    // this.logger.log("BaichuanClient constructor", { options, dgfg: this.debugCfg });
  }

  private newSocketSessionId(transport: "tcp" | "udp"): string {
    // Short, log-friendly id; uniqueness is best-effort.
    const short = randomUUID().split("-")[0] ?? randomUUID().slice(0, 8);
    return `${transport}-${short}`;
  }

  private logFixed(event: string, data?: unknown): void {
    const prefix = "[BaichuanClient]";
    const msg = `${prefix} ${event}`;
    const l: any = this.logger as any;

    if (typeof l.info === "function") {
      l.info(msg, data);
      return;
    }
    if (typeof l.log === "function") {
      l.log(msg, data);
      return;
    }
    if (typeof l.warn === "function") {
      l.warn(msg, data);
    }
  }

  private getIdleDisconnectTimeoutMs(): number {
    const v = this.opts.idleDisconnectTimeoutMs;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    return 30_000;
  }

  private isIdleDisconnectEnabled(): boolean {
    return this.opts.idleDisconnect === true;
  }

  private clearIdleDisconnectTimer(): void {
    if (!this.idleDisconnectTimer) return;
    clearTimeout(this.idleDisconnectTimer);
    this.idleDisconnectTimer = undefined;
  }

  private touchUserActivity(reason: string): void {
    this.lastUserActivityAtMs = Date.now();
    this.logDebug("user_activity", { reason, atMs: this.lastUserActivityAtMs });
  }

  private isIdleDisconnectEligibleNow(): boolean {
    if (!this.isIdleDisconnectEnabled()) return false;
    if (!this.isSocketConnected()) return false;
    if (this.pending.size > 0) return false;
    if (this.hasActiveVideoSubscriptionsInternal()) return false;
    if (this.permits.size > 0) return false;
    return true;
  }

  private kickIdleDisconnectTimer(): void {
    if (!this.isIdleDisconnectEnabled()) return;
    this.clearIdleDisconnectTimer();

    if (!this.isIdleDisconnectEligibleNow()) return;
    if (this.lastUserActivityAtMs == null) return;

    const timeoutMs = this.getIdleDisconnectTimeoutMs();
    const elapsedMs = Date.now() - this.lastUserActivityAtMs;
    const delayMs = Math.max(0, timeoutMs - elapsedMs);

    this.idleDisconnectTimer = setTimeout(() => {
      try {
        if (!this.isIdleDisconnectEligibleNow()) return;
        if (this.lastUserActivityAtMs == null) return;
        const elapsed2 = Date.now() - this.lastUserActivityAtMs;
        if (elapsed2 < timeoutMs) {
          this.kickIdleDisconnectTimer();
          return;
        }
        const sid = this.socketSessionId;
        const shortUid = this.opts.uid
          ? this.opts.uid.substring(0, 5)
          : undefined;
        this.logDebug("idle_disconnect", {
          elapsedMs: elapsed2,
          timeoutMs,
          transport: this.transport,
          host: this.opts.host,
          sid,
          uid: shortUid,
        });
        this.logFixed("idle_disconnect", {
          elapsedMs: elapsed2,
          timeoutMs,
          transport: this.transport,
          host: this.opts.host,
          sid,
          uid: shortUid,
        });
        void this.close({ reason: "idle_disconnect" });
      } catch (e) {
        this.logDebug("idle_disconnect_error", e);
      }
    }, delayMs);
    this.idleDisconnectTimer.unref?.();
  }

  /**
   * Best-effort request to drop an idle BCUDP connection soon.
   *
   * This is primarily for battery cameras: after a stream teardown, we want to
   * close the UDP session quickly (when truly idle) without force-closing shared
   * connections that may still be in use.
   */
  requestIdleDisconnectSoon(reason = "requested", graceMs = 0): void {
    try {
      if (!this.isIdleDisconnectEnabled()) return;
      if (this.transport !== "udp") return;

      const timeoutMs = this.getIdleDisconnectTimeoutMs();
      const g = Math.max(0, Math.floor(graceMs));

      // Make the idle timer eligible as soon as possible. The eligibility check
      // still ensures no pending requests / video subscriptions / permits.
      this.lastUserActivityAtMs = Date.now() - timeoutMs + g;
      const sid = this.socketSessionId;
      const shortUid = this.opts.uid
        ? this.opts.uid.substring(0, 5)
        : undefined;
      this.logDebug("idle_disconnect_requested", {
        reason,
        graceMs: g,
        timeoutMs,
        host: this.opts.host,
        sid,
        uid: shortUid,
      });
      this.kickIdleDisconnectTimer();
    } catch {
      // ignore
    }
  }

  /**
   * Metadata about the last TCP/UDP disconnect.
   * Useful for higher-level heuristics (e.g. disconnect storm handling).
   */
  getLastDisconnectInfo():
    | {
        atMs: number;
        transport: "tcp" | "udp";
        voluntary: boolean;
        reason: string;
      }
    | undefined {
    return this.lastDisconnectInfo;
  }

  /**
   * Acquire a temporary permit to keep the connection open.
   *
   * Returns a release function.
   */
  acquirePermit(
    holdMs = this.getIdleDisconnectTimeoutMs(),
    reason?: string,
  ): () => void {
    const ms = Math.max(0, Math.floor(holdMs));
    const id = this.permitSeq++;
    const untilMs = Date.now() + ms;

    let timer: NodeJS.Timeout | undefined;
    if (ms > 0) {
      timer = setTimeout(() => this.releasePermit(id, "timeout"), ms);
      timer.unref?.();
    }

    this.permits.set(id, { timer, untilMs, reason });
    this.logDebug("permit_acquired", {
      id,
      holdMs: ms,
      untilMs,
      reason,
      permits: this.permits.size,
    });

    // A permit disables idle disconnect.
    this.clearIdleDisconnectTimer();

    return () => this.releasePermit(id, "manual");
  }

  private releasePermit(id: number, how: "manual" | "timeout" | "close"): void {
    const p = this.permits.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.permits.delete(id);
    this.logDebug("permit_released", { id, how, permits: this.permits.size });
    this.kickIdleDisconnectTimer();
  }

  private getDeviceRegistryKey(): string {
    // Prefer UID when available (BCUDP/battery), but still include host as a safety net.
    const uid = (this.opts.uid ?? "").trim().toUpperCase();
    const host = (this.opts.host ?? "").trim();
    const channel = this.opts.channel ?? 0;
    return `${host}|${uid}|${channel}`;
  }

  private getCoverPreviewQueueKey(): string {
    // CoverPreview is effectively host-scoped; include UID when available to avoid collisions.
    const host = (this.opts.host ?? "").trim();
    const uid = (this.opts.uid ?? "").trim().toUpperCase();
    return `coverpreview|${host}|${uid}`;
  }

  private async withSerializedCoverPreview<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.getCoverPreviewQueueKey();
    const prevTail =
      BaichuanClient.coverPreviewQueueTail.get(key) ?? Promise.resolve();

    const run = prevTail.catch(() => undefined).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    BaichuanClient.coverPreviewQueueTail.set(key, tail);

    try {
      return await run;
    } finally {
      // Cleanup tail if nobody queued behind us.
      if (BaichuanClient.coverPreviewQueueTail.get(key) === tail) {
        BaichuanClient.coverPreviewQueueTail.delete(key);
      }
    }
  }

  private recomputeGlobalStreamingContribution(): void {
    const shouldContribute = this.hasActiveVideoSubscriptionsInternal();
    if (shouldContribute === this.contributesToGlobalStreamingRegistry) return;

    const key = this.getDeviceRegistryKey();
    const cur = BaichuanClient.streamingRegistry.get(key) ?? {
      activeStreamClients: 0,
    };
    const nextCount = Math.max(
      0,
      cur.activeStreamClients + (shouldContribute ? 1 : -1),
    );
    if (nextCount === 0) BaichuanClient.streamingRegistry.delete(key);
    else
      BaichuanClient.streamingRegistry.set(key, {
        activeStreamClients: nextCount,
      });

    this.contributesToGlobalStreamingRegistry = shouldContribute;
  }

  /**
   * True if the device should be considered "awake" due to active streaming.
   * This includes streaming on other BaichuanClient instances within the same process.
   */
  isDeviceStreamingActive(): boolean {
    if (this.hasActiveVideoSubscriptionsInternal()) return true;
    const key = this.getDeviceRegistryKey();
    const cur = BaichuanClient.streamingRegistry.get(key);
    return (cur?.activeStreamClients ?? 0) > 0;
  }

  private logDebug(event: string, data?: unknown): void {
    if (this.debugCfg.general) {
      this.logger.debug(`[BaichuanClient] ${event}`, data);
      this.emit("debug", event, data);
    }
  }

  private getTcpSocketDebugSnapshot(sock: net.Socket | undefined):
    | {
        readyState?: string;
        destroyed: boolean;
        connecting?: boolean;
        pending?: boolean;
        localAddress?: string;
        localFamily?: string;
        localPort?: number;
        remoteAddress?: string;
        remoteFamily?: string;
        remotePort?: number;
        bytesRead: number;
        bytesWritten: number;
        readableLength?: number;
        writableLength?: number;
        timeoutMs?: number;
      }
    | undefined {
    if (!sock) return undefined;
    const s: any = sock as any;
    const snap: any = {
      destroyed: sock.destroyed,
      bytesRead: sock.bytesRead,
      bytesWritten: sock.bytesWritten,
    };

    if (typeof s.readyState === "string") snap.readyState = s.readyState;
    if (typeof s.connecting === "boolean") snap.connecting = s.connecting;
    if (typeof s.pending === "boolean") snap.pending = s.pending;

    if (sock.localAddress != null) snap.localAddress = sock.localAddress;
    if (sock.localFamily != null) snap.localFamily = sock.localFamily;
    if (sock.localPort != null) snap.localPort = sock.localPort;
    if (sock.remoteAddress != null) snap.remoteAddress = sock.remoteAddress;
    if (sock.remoteFamily != null) snap.remoteFamily = sock.remoteFamily;
    if (sock.remotePort != null) snap.remotePort = sock.remotePort;

    if (typeof s.readableLength === "number")
      snap.readableLength = s.readableLength;
    if (typeof s.writableLength === "number")
      snap.writableLength = s.writableLength;
    if (typeof s.timeout === "number") snap.timeoutMs = s.timeout;

    return snap;
  }

  private logSocketState(
    reason: string,
    extra?: Record<string, unknown>,
  ): void {
    try {
      const transport = this.transport;
      const sid = this.socketSessionId;
      const host = this.opts.host;
      const port = this.opts.port ?? BC_TCP_DEFAULT_PORT;
      const shortUid = this.opts.uid
        ? this.opts.uid.substring(0, 5)
        : undefined;

      this.logDebug("socket_state", {
        reason,
        transport,
        host,
        ...(transport === "tcp" ? { port } : {}),
        ...(sid ? { sid } : {}),
        ...(shortUid ? { uid: shortUid } : {}),
        socketClosed: this.socketClosed,
        socketConnected: this.isSocketConnected(),
        loggedIn: this.loggedIn,
        subscribed: this.subscribed,
        pending: this.pending.size,
        permits: this.permits.size,
        videoSubscriptions: this.videoSubscriptions.size,
        lastRxAtMs: this.lastRxAtMs,
        lastTxAtMs: this.lastTxAtMs,
        lastRxCmdId: this.lastRxInfo?.cmdId,
        lastTxCmdId: this.lastTxInfo?.cmdId,
        tcp: this.getTcpSocketDebugSnapshot(this.tcpSocket),
        udpConnected: this.udpSocket?.isConnected?.(),
        ...extra,
      });
    } catch {
      // best-effort
    }
  }

  getTransport(): "tcp" | "udp" {
    return this.transport;
  }

  getConfiguredChannel(): number {
    return this.opts.channel ?? 0;
  }

  /**
   * Recompute keepalive behavior based on current state.
   *
   * Default policy (UDP):
   * - idle (no subscriptions/streams): no periodic keepalive (allows battery cameras to sleep)
   * - subscribed to events OR streaming: periodic keepalive (improves reliability)
   */
  refreshKeepAlive(): void {
    this.stopKeepAlive();
    if (this.isSocketConnected()) this.startKeepAlive();
  }

  /** Timestamp (ms) of the last received Baichuan frame, if any. */
  getLastRxAtMs(): number | undefined {
    return this.lastRxAtMs;
  }

  /** Metadata about the last received Baichuan frame, if any. */
  getLastRxInfo():
    | {
        atMs: number;
        cmdId: number;
        responseCode: number;
        msgNum: number;
        channelId: number;
        streamType: number;
      }
    | undefined {
    return this.lastRxInfo;
  }

  /** Recent RX frame metadata (newest last). */
  getRxHistory(): ReadonlyArray<{
    atMs: number;
    cmdId: number;
    responseCode: number;
    msgNum: number;
    channelId: number;
    streamType: number;
  }> {
    return this.rxHistory;
  }

  /** Timestamp (ms) of the last transmitted Baichuan frame, if any. */
  getLastTxAtMs(): number | undefined {
    return this.lastTxAtMs;
  }

  /** Metadata about the last transmitted Baichuan frame, if any. */
  getLastTxInfo():
    | {
        atMs: number;
        cmdId: number;
        responseCode: number;
        msgNum: number;
        channelId: number;
        streamType: number;
      }
    | undefined {
    return this.lastTxInfo;
  }

  /** Recent TX frame metadata (newest last). */
  getTxHistory(): ReadonlyArray<{
    atMs: number;
    cmdId: number;
    responseCode: number;
    msgNum: number;
    channelId: number;
    streamType: number;
  }> {
    return this.txHistory;
  }

  private recordTx(info: {
    cmdId: number;
    responseCode: number;
    msgNum: number;
    channelId: number;
    streamType: number;
  }): void {
    const now = Date.now();
    this.lastTxAtMs = now;
    this.lastTxInfo = { atMs: now, ...info };
    this.txHistory.push(this.lastTxInfo);
    if (this.txHistory.length > 32) this.txHistory.shift();
  }

  /**
   * Sleep/idle inference for battery/BCUDP cameras.
   *
   * With `idleDisconnect` enabled, this library can actively close the BCUDP socket when idle.
   * In that mode we can rely on connection state instead of RX inactivity heuristics.
   *
   * Behavior:
   * - If `idleDisconnect` is enabled: rely on connection state (socket closed => sleeping).
   * - Otherwise: fallback to RX inactivity heuristics (no RX for `idleMs`).
   */
  isProbablySleeping(idleMs = 15_000): boolean {
    if (this.transport !== "udp") return false;

    // Deterministic mode: if we actively idle-disconnect, sleep maps to socket state.
    if (this.isIdleDisconnectEnabled()) {
      void idleMs; // kept for backward compatibility
      return !this.isSocketConnected();
    }

    // Heuristic mode (back-compat): consider the device "probably sleeping" when we
    // don't see RX traffic for a while. If we're disconnected, treat as sleeping.
    if (!this.isSocketConnected()) return true;
    if (this.isDeviceStreamingActive()) return false;
    if (this.lastRxAtMs == null) return false;
    return Date.now() - this.lastRxAtMs >= idleMs;
  }

  getDebugConfig(): DebugConfig {
    return this.debugCfg;
  }

  /**
   * Stable identifier for the current underlying socket session.
   * Useful for correlating logs and diagnosing duplicate event streams.
   */
  getSocketSessionId(): string | undefined {
    return this.socketSessionId;
  }

  /**
   * Check if the socket is connected and ready for operations.
   * For TCP: checks if socket exists and is not destroyed.
   * For UDP: checks if socket exists.
   */
  isSocketConnected(): boolean {
    if (this.transport === "tcp") {
      return this.tcpSocket !== undefined && !this.tcpSocket.destroyed;
    }
    if (this.transport === "udp") {
      return (
        this.udpSocket !== undefined && (this.udpSocket.isConnected?.() ?? true)
      );
    }
    return false;
  }

  get username(): string {
    return this.opts.username;
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;

    // Defaults:
    // - TCP: prevent idle socket closures by camera/NAT.
    // - UDP/BCUDP: dynamic keepalive.
    //   * When subscribed/streaming: send periodic keepalive to keep push/stream reliable.
    //   * When idle: do not send keepalive, allowing battery cameras to sleep.
    let interval = 30_000;
    if (this.transport === "udp") {
      if (!this.shouldSendUdpKeepAlive()) return;
      interval = 2500;
    }

    if (interval <= 0) return;

    this.keepAliveTimer = setInterval(() => {
      // BCUDP keepalive behaves differently: some cameras don't reply to the keepalive frame,
      // so waiting for a response would stall the loop.
      if (this.transport === "udp") {
        try {
          this.sendUdpKeepAlive();
        } catch (e) {
          this.logDebug("udp_keepalive_ping_error", e);
        }
        return;
      }

      // Avoid overlapping pings (they wait for a reply and can take up to timeoutMs).
      if (this.keepAlivePingInFlight) return;
      this.keepAlivePingInFlight = true;
      void (async () => {
        try {
          await this.sendPing();
        } catch (e) {
          this.logDebug("keepalive_ping_error", e);
        } finally {
          this.keepAlivePingInFlight = false;
        }
      })();
    }, interval);
    // Don't keep the Node process alive only for keepalive.
    this.keepAliveTimer.unref?.();
  }

  private hasActiveVideoSubscriptionsInternal(): boolean {
    for (const set of this.videoSubscriptions.values()) {
      if (set.size > 0) return true;
    }
    return false;
  }

  /** True when there is at least one active Baichuan video subscription (cmdId/msgNum). */
  hasActiveVideoSubscriptions(): boolean {
    return this.hasActiveVideoSubscriptionsInternal();
  }

  private shouldSendUdpKeepAlive(): boolean {
    // Only useful when connected via BCUDP and logged in.
    if (this.transport !== "udp") return false;
    if (!this.udpSocket) return false;
    if (!this.loggedIn) return false;

    // Default: do NOT send periodic keepalive unless we're actively streaming.
    // Battery cameras should be allowed to sleep; we still reply to camera-initiated keepalive frames.
    if (this.hasActiveVideoSubscriptionsInternal()) return true;
    return false;
  }

  private sendUdpKeepAlive(): void {
    if (this.transport !== "udp") return;
    if (!this.udpSocket) return;
    // Avoid keepalives before login; some firmwares treat them as invalid.
    if (!this.loggedIn) return;

    const msgNum = this.nextMsgNum();
    const header = encodeHeader({
      cmdId: BC_CMD_ID_UDP_KEEP_ALIVE,
      bodyLen: 0,
      channelId: 0,
      streamType: 0,
      msgNum,
      responseCode: 0,
      messageClass: BC_CLASS_MODERN_24,
      payloadOffset: 0,
    });

    this.logDebug("udp_keepalive_ping_tx", {
      msgNum,
      channelId: 0,
      streamType: 0,
    });
    this.recordTx({
      cmdId: BC_CMD_ID_UDP_KEEP_ALIVE,
      responseCode: 0,
      msgNum,
      channelId: 0,
      streamType: 0,
    });
    this.writeWire(header);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    this.keepAlivePingInFlight = false;
  }

  private async sendPing(): Promise<void> {
    // Only send if connected
    if (!this.tcpSocket && !this.udpSocket) return;

    // Avoid pings before login; some firmwares treat them as invalid and may drop the session.
    if (!this.loggedIn) return;

    // TCP keepalive: MSG_ID_PING (93)
    try {
      // We use sendFrame which waits for response.
      // If it times out, it's fine, we just log it.
      await this.sendFrame({
        cmdId: BC_CMD_ID_PING,
        channel: this.opts.channel ?? 0,
        channelIdOverride: 0, // Force 0-based channel ID for Ping
        messageClass: BC_CLASS_MODERN_24,
        streamType: 0,
        extensionXml: "", // Keepalive has empty body
        internal: true,
      });
    } catch (e) {
      // Ignore errors, just log debug
      this.logDebug("keepalive_ping_failed", e);
    }
  }

  async connect(): Promise<void> {
    const desired = this.opts.transport ?? "tcp";
    if (desired === "tcp") {
      await this.connectTcp();
      return;
    }
    if (desired === "udp") {
      await this.waitForUdpReconnectCooldown();
      await this.connectUdp();
      return;
    }
    // auto: try TCP first, then fallback to UDP
    try {
      // Use a timeout for TCP discovery (TCP_WAIT = 4 seconds)
      // We use Promise.race to timeout TCP connection attempt
      await Promise.race([
        this.connectTcp(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("TCP connection timeout (falling back to UDP)")),
            4000,
          ),
        ),
      ]);
    } catch (e) {
      this.logDebug("auto:tcp_failed", e);
      // Fallback to UDP discovery
      // Requires UID.
      if (!this.opts.uid) {
        throw new Error(
          "TCP connection failed and UDP fallback requires `options.uid` (BCUDP discovery UID).",
        );
      }
      await this.waitForUdpReconnectCooldown();
      await this.connectUdp();
    }
  }

  private async waitForUdpReconnectCooldown(): Promise<void> {
    const now = Date.now();
    const waitMs = this.udpReconnectCooldownUntilMs - now;
    if (waitMs <= 0) return;
    const sid = this.socketSessionId;
    const shortUid = this.opts.uid ? this.opts.uid.substring(0, 5) : undefined;
    this.logDebug("udp_reconnect_cooldown", {
      transport: "udp",
      host: this.opts.host,
      sid,
      uid: shortUid,
      waitMs,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  private async connectTcp(): Promise<void> {
    if (this.tcpSocket && !this.tcpSocket.destroyed) {
      this.transport = "tcp";
      return;
    }
    const port = this.opts.port ?? BC_TCP_DEFAULT_PORT;
    const sock = net.createConnection({ host: this.opts.host, port });
    this.tcpSocket = sock;
    this.transport = "tcp";
    this.socketClosed = false;
    this.socketSessionId = this.newSocketSessionId("tcp");

    // TCP keep-alive at OS level (helps prevent idle disconnects from NAT/camera).
    try {
      sock.setKeepAlive(true, 30_000);
    } catch (e) {
      this.logDebug("tcp_setKeepAlive_failed", e);
    }

    sock.on("data", (chunk) => {
      const frames = this.parser.push(chunk);
      for (const f of frames) this.handleFrame(f);
    });
    sock.on("close", (hadError) => {
      // Snapshot state before mutating internal refs.
      this.logSocketState("tcp_close_event", { hadError: Boolean(hadError) });
      const sid = this.socketSessionId;
      // Ensure socket is completely destroyed and listeners are removed
      if (sock === this.tcpSocket) {
        this.tcpSocket = undefined;
      }

      // Remove all listeners to prevent memory leaks
      sock.removeAllListeners();

      // Ensure socket is destroyed
      if (!sock.destroyed) {
        sock.destroy();
      }

      this.stopKeepAlive();
      this.socketClosed = true;

      const pending = this.pendingCloseInfo;
      this.pendingCloseInfo = undefined;
      this.lastDisconnectInfo = {
        atMs: Date.now(),
        transport: "tcp",
        voluntary: pending != null,
        reason: pending?.reason ?? "socket_closed",
      };

      const tcpDisconnectParts: string[] = [
        `transport=tcp`,
        `host=${this.opts.host}`,
      ];
      if (sid) tcpDisconnectParts.push(`sid=${sid}`);
      const tcpPort = this.opts.port ?? BC_TCP_DEFAULT_PORT;
      if (tcpPort != null) tcpDisconnectParts.push(`port=${tcpPort}`);
      if (this.lastRxInfo?.cmdId != null)
        tcpDisconnectParts.push(`lastRxCmdId=${this.lastRxInfo.cmdId}`);
      if (this.lastTxInfo?.cmdId != null)
        tcpDisconnectParts.push(`lastTxCmdId=${this.lastTxInfo.cmdId}`);
      this.logFixed("disconnected", tcpDisconnectParts.join(" "));

      // End socket session.
      this.socketSessionId = undefined;

      // Reset state flags
      this.loggedIn = false;
      this.subscribed = false;

      this.emit("close");
      // Reject all pending promises asynchronously to allow catch handlers to be attached
      // This prevents unhandled rejections when the socket closes
      const pendingEntries = Array.from(this.pending.entries());
      this.pending.clear();
      for (const [, p] of pendingEntries) {
        // Use setImmediate to allow catch handlers to be attached before rejection
        // setImmediate runs after the current event loop, giving catch handlers time to attach
        setImmediate(() => {
          try {
            p.reject(new Error("Baichuan socket closed"));
          } catch (e) {
            // Ignore errors from rejecting promises (they may already be handled)
          }
        });
      }
    });
    sock.on("error", (err) => {
      this.logSocketState("tcp_error", {
        error: {
          message: err?.message ?? String(err),
          code: (err as any)?.code,
        },
      });
      this.emit("error", err);
    });

    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", (e) => reject(e));
    });

    const sid = this.socketSessionId;
    // NOTE: `remote` here refers to the local endpoint used to initialize the socket (client side).
    // The camera endpoint is logged as `peer`.
    const localAddress = sock.localAddress;
    const localFamily = sock.localFamily;
    const localPort = sock.localPort;
    const remote = localAddress
      ? `${localAddress}${localFamily ? `/${localFamily}` : ""}${localPort ? `:${localPort}` : ""}`
      : undefined;

    const peerAddress = sock.remoteAddress;
    const peerFamily = sock.remoteFamily;
    const peerPort = sock.remotePort;
    const peer = peerAddress
      ? `${peerAddress}${peerFamily ? `/${peerFamily}` : ""}${peerPort ? `:${peerPort}` : ""}`
      : undefined;
    this.logFixed(
      "connected",
      `transport=tcp host=${this.opts.host} port=${port}` +
        `${sid ? ` sid=${sid}` : ""}` +
        `${remote ? ` remote=${remote}` : ""}` +
        `${peer ? ` peer=${peer}` : ""}`,
    );

    this.logSocketState("tcp_connected");
    this.startKeepAlive();
    this.kickIdleDisconnectTimer();
  }

  private async connectUdp(): Promise<void> {
    if (this.udpSocket) {
      // If the stream object exists but the underlying socket/remote is gone (e.g. after D2C_DISC),
      // drop it so we can create a fresh connection.
      if (this.udpSocket.isConnected?.()) {
        this.transport = "udp";
        return;
      }
      try {
        await this.udpSocket.close();
      } catch {
        // ignore
      }
      this.udpSocket = undefined;
    }
    if (!this.opts.uid) {
      throw new Error(
        "Baichuan UDP requested but `options.uid` is not set (required for BCUDP discovery).",
      );
    }
    const sock = new BcUdpStream({
      mode: "uid",
      uid: this.opts.uid,
      // If the camera IP/hostname is known, allow local-direct to try unicast before broadcast.
      ...(this.opts.host?.trim() ? { directHost: this.opts.host.trim() } : {}),
      ...(this.opts.udpDiscoveryMethod
        ? { discoveryMethod: this.opts.udpDiscoveryMethod }
        : {}),
    });
    this.udpSocket = sock;
    this.transport = "udp";
    this.socketClosed = false;
    this.socketSessionId = this.newSocketSessionId("udp");

    sock.on("data", (chunk) => {
      const frames = this.parser.push(chunk);
      for (const f of frames) this.handleFrame(f);
    });
    sock.on("close", () => {
      this.logSocketState("udp_close_event", {
        udpConnected: sock.isConnected?.(),
      });
      const sid = this.socketSessionId;
      // Ensure socket is completely cleaned up
      if (sock === this.udpSocket) {
        this.udpSocket = undefined;
      }

      // Remove all listeners to prevent memory leaks
      if (sock.removeAllListeners) {
        sock.removeAllListeners();
      }

      this.stopKeepAlive();
      this.socketClosed = true;

      const pending = this.pendingCloseInfo;
      this.pendingCloseInfo = undefined;
      this.lastDisconnectInfo = {
        atMs: Date.now(),
        transport: "udp",
        voluntary: pending != null,
        reason: pending?.reason ?? "socket_closed",
      };

      const udpDisconnectParts: string[] = [
        `transport=udp`,
        `host=${this.opts.host}`,
      ];
      if (sid) udpDisconnectParts.push(`sid=${sid}`);
      if (this.opts.uid) {
        const shortUid = this.opts.uid.substring(0, 5);
        udpDisconnectParts.push(`uid=${shortUid}`);
      }
      if (this.lastRxInfo?.cmdId != null)
        udpDisconnectParts.push(`lastRxCmdId=${this.lastRxInfo.cmdId}`);
      if (this.lastTxInfo?.cmdId != null)
        udpDisconnectParts.push(`lastTxCmdId=${this.lastTxInfo.cmdId}`);
      this.logFixed("disconnected", udpDisconnectParts.join(" "));

      // End socket session.
      this.socketSessionId = undefined;
      // Mark session state as invalid; a new connect/login is required.
      this.loggedIn = false;
      this.subscribed = false;
      // If this client was contributing streaming state, clear it.
      if (this.contributesToGlobalStreamingRegistry) {
        this.videoSubscriptions.clear();
        this.recomputeGlobalStreamingContribution();
      }
      this.emit("close");
      // Reject all pending promises asynchronously to allow catch handlers to be attached
      // This prevents unhandled rejections when the socket closes
      const pendingEntries = Array.from(this.pending.entries());
      this.pending.clear();
      for (const [, p] of pendingEntries) {
        // Use setImmediate to allow catch handlers to be attached before rejection
        // setImmediate runs after the current event loop, giving catch handlers time to attach
        setImmediate(() => {
          try {
            p.reject(new Error("Baichuan UDP stream closed"));
          } catch (e) {
            // Ignore errors from rejecting promises (they may already be handled)
          }
        });
      }
    });
    sock.on("error", (err) => {
      // If the camera terminates the BCUDP session (D2C_DISC), the stream will close.
      // Make sure we don't keep a stale handle around.
      if (err?.message?.includes("D2C_DISC")) {
        this.logSocketState("udp_error_d2c_disc", {
          message: err.message,
          udpConnected: sock.isConnected?.(),
        });
        const now = Date.now();
        const sid = this.socketSessionId;
        const shortUid = this.opts.uid
          ? this.opts.uid.substring(0, 5)
          : undefined;
        this.logFixed("d2c_disc", {
          transport: "udp",
          host: this.opts.host,
          sid,
          uid: shortUid,
          message: err.message,
        });

        // Apply exponential backoff to avoid reconnect storms.
        // If D2C_DISC repeats frequently, ramp up cooldown to give the camera time.
        const withinWindow = now - this.udpReconnectLastD2cDiscAtMs < 60_000;
        const baseMs = 2_000;
        const maxMs = 30_000;
        const nextBackoffMs = withinWindow
          ? Math.min(
              maxMs,
              Math.max(
                baseMs,
                this.udpReconnectBackoffMs > 0
                  ? this.udpReconnectBackoffMs * 2
                  : baseMs,
              ),
            )
          : baseMs;
        this.udpReconnectLastD2cDiscAtMs = now;
        this.udpReconnectBackoffMs = nextBackoffMs;
        this.udpReconnectCooldownUntilMs = Math.max(
          this.udpReconnectCooldownUntilMs,
          now + nextBackoffMs,
        );
        this.logDebug("d2c_disc_backoff", {
          transport: "udp",
          host: this.opts.host,
          sid,
          uid: shortUid,
          backoffMs: nextBackoffMs,
          cooldownUntilMs: this.udpReconnectCooldownUntilMs,
        });

        this.stopKeepAlive();
        this.loggedIn = false;
        this.subscribed = false;
        // Camera terminated the session; clear streaming contribution for this client.
        if (this.contributesToGlobalStreamingRegistry) {
          this.videoSubscriptions.clear();
          this.recomputeGlobalStreamingContribution();
        }
      }
      this.emit("error", err);
    });

    // Forward BcUdpStream debug events
    sock.on("debug", (event: string, data?: unknown) => {
      this.logDebug(`udp_${event}`, data);
    });

    await sock.connect();

    const shortUid = this.opts.uid ? this.opts.uid.substring(0, 5) : "";
    const udpDiscoveryMethod =
      (this.opts.udpDiscoveryMethod as string | undefined) ?? "local-direct";
    const sid = this.socketSessionId;
    const udpRemoteHost: string | undefined = (sock as any)?.remote?.host;
    this.logFixed(
      "connected",
      `transport=udp host=${this.opts.host}${sid ? ` sid=${sid}` : ""}${udpRemoteHost ? ` remote=${udpRemoteHost}` : ""} uid=${shortUid} udpDiscoveryMethod=${udpDiscoveryMethod}`,
    );
    this.logSocketState("udp_connected", {
      udpConnected: sock.isConnected?.(),
      udpRemoteHost,
      udpDiscoveryMethod,
    });
    this.startKeepAlive();
    this.kickIdleDisconnectTimer();
  }

  async close(options?: { reason?: string }): Promise<void> {
    const hasSocket = Boolean(
      (this.tcpSocket && !this.tcpSocket.destroyed) || this.udpSocket,
    );
    const reason = (options?.reason ?? "manual_close").trim() || "manual_close";
    if (hasSocket) {
      this.pendingCloseInfo = {
        atMs: Date.now(),
        reason,
      };
    }

    // Always log close triggers (even if the socket close event is swallowed by the runtime).
    // This helps diagnose cases where we see repeated "connected ... sid=..." without an obvious disconnect.
    try {
      const sid = this.socketSessionId;
      const transport = this.transport;
      const host = this.opts.host;
      const port = this.opts.port ?? BC_TCP_DEFAULT_PORT;
      const shortUid = this.opts.uid
        ? this.opts.uid.substring(0, 5)
        : undefined;
      this.logFixed("closing", {
        transport,
        host,
        ...(transport === "tcp" ? { port } : {}),
        ...(sid ? { sid } : {}),
        ...(shortUid ? { uid: shortUid } : {}),
        reason,
        hasSocket,
        socketConnected: this.isSocketConnected(),
        loggedIn: this.loggedIn,
        subscribed: this.subscribed,
        pending: this.pending.size,
        permits: this.permits.size,
        videoSubscriptions: this.videoSubscriptions.size,
      });

      this.logSocketState("close_called", { reason });

      // Optional: emit a trimmed stack trace to locate the caller.
      // Enable via env var to avoid noisy logs in production.
      if ((process.env.BAICHUAN_LOG_CLOSE_STACK ?? "").trim() === "1") {
        const stack = new Error("BaichuanClient.close() stack").stack;
        if (stack) {
          const lines = stack.split("\n").slice(0, 10).join("\n");
          this.logDebug("closing_stack", lines);
        }
      }
    } catch {
      // ignore
    }

    this.stopKeepAlive();
    this.clearIdleDisconnectTimer();

    // Drop permits on close.
    for (const id of Array.from(this.permits.keys())) {
      this.releasePermit(id, "close");
    }

    // Ensure we drop any global streaming contribution before tearing down sockets.
    if (this.contributesToGlobalStreamingRegistry) {
      this.videoSubscriptions.clear();
      this.recomputeGlobalStreamingContribution();
    }

    // IMPORTANT:
    // Don't remove listeners here: the per-transport socket "close" handler is responsible for:
    // - logging "disconnected"
    // - clearing socket/session state
    // - rejecting pending requests
    // If we remove listeners here, we lose observability and can leave state inconsistent.

    // Trigger TCP close (if any) and wait for the "close" event.
    const tcp = this.tcpSocket;
    if (tcp && !tcp.destroyed) {
      try {
        // Best-effort graceful end; most firmwares just close anyway.
        tcp.end();
      } catch {
        // ignore
      }
      try {
        tcp.destroy();
      } catch {
        // ignore
      }

      await new Promise<void>((resolve) => {
        if (tcp.destroyed) {
          resolve();
          return;
        }
        tcp.once("close", () => resolve());
        setTimeout(() => resolve(), 250);
      });
    }

    // Trigger UDP close (if any). BcUdpStream.close() should emit "close" and run our handler.
    const udp = this.udpSocket;
    if (udp) {
      try {
        await udp.close();
      } catch (e) {
        this.logDebug("udp_close_error", e);
      }
    }
  }

  private handleFrame(frame: BaichuanFrame): void {
    const now = Date.now();
    this.lastRxAtMs = now;
    this.lastRxInfo = {
      atMs: now,
      cmdId: frame.header.cmdId,
      responseCode: frame.header.responseCode,
      msgNum: frame.header.msgNum,
      channelId: frame.header.channelId,
      streamType: frame.header.streamType,
    };

    this.rxHistory.push(this.lastRxInfo);
    if (this.rxHistory.length > 32) this.rxHistory.shift();

    // Temporary global RX logging: show every received cmdId.
    // Throttle cmdId=3 (stream) to avoid flooding logs.
    if (this.debugCfg.general) {
      if (frame.header.cmdId === 3) {
        const s = this.rxCmdTraceStats.get(3) ?? { lastLogMs: now, frames: 0 };
        s.frames++;
        if (now - s.lastLogMs >= 1000) {
          debugLog(
            this.debugCfg,
            this.logger,
            "BaichuanRx",
            `rx cmdId=3 frames=${s.frames} lastMsgNum=${frame.header.msgNum} lastResponseCode=${frame.header.responseCode} lastChannelId=${frame.header.channelId} lastStreamType=${frame.header.streamType} lastBodyLen=${frame.body.length} lastPayloadLen=${frame.payload.length}`,
          );
          s.lastLogMs = now;
          s.frames = 0;
        }
        this.rxCmdTraceStats.set(3, s);
      } else {
        debugLog(
          this.debugCfg,
          this.logger,
          "BaichuanRx",
          `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} streamType=${frame.header.streamType} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`,
        );
      }
    }

    // Battery cameras (BCUDP) expect the client to respond to UDP keep-alive frames.
    // Always reply with response_code=200 using the same msg_num/channel_id/stream_type
    // and do not special-case the incoming response_code.
    // Some firmwares send these with response_code=200 already; we still reply to keep the session alive.
    if (
      this.transport === "udp" &&
      frame.header.cmdId === BC_CMD_ID_UDP_KEEP_ALIVE
    ) {
      try {
        const header = encodeHeader({
          cmdId: frame.header.cmdId,
          bodyLen: 0,
          channelId: frame.header.channelId,
          streamType: frame.header.streamType,
          msgNum: frame.header.msgNum,
          responseCode: 200,
          messageClass: frame.header.messageClass,
          payloadOffset: 0,
        });

        this.logDebug("udp_keepalive_rx", {
          msgNum: frame.header.msgNum,
          channelId: frame.header.channelId,
          streamType: frame.header.streamType,
          responseCode: frame.header.responseCode,
        });
        this.recordTx({
          cmdId: frame.header.cmdId,
          responseCode: 200,
          msgNum: frame.header.msgNum,
          channelId: frame.header.channelId,
          streamType: frame.header.streamType,
        });
        this.writeWire(header);
        this.logDebug("udp_keepalive_tx", {
          msgNum: frame.header.msgNum,
          channelId: frame.header.channelId,
          streamType: frame.header.streamType,
        });
      } catch (e) {
        // Keepalive failures shouldn't crash the client; log when debug is enabled.
        this.logDebug("udp_keepalive_error", e);
      }
      // Keepalive frames are handled here.
      return;
    }

    if (this.debugCfg.traceTalk && isTalkCmd(frame.header.cmdId)) {
      talkTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTalk",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`,
      );
    }

    this.emit("frame", frame);

    const key: PendingKey = `${frame.header.cmdId}:${frame.header.msgNum}`;
    const pending = this.pending.get(key);
    if (pending) {
      this.pending.delete(key);
      pending.resolve(frame);
      return;
    }

    // Check if this frame matches a video stream subscription
    // Frames with matching cmdId and msgNum
    const subscribedMsgNums = this.videoSubscriptions.get(frame.header.cmdId);
    if (subscribedMsgNums && subscribedMsgNums.size > 0) {
      // If there are active subscriptions for this cmdId (typically MSG_ID_VIDEO=3),
      // emit only frames that match msgNum. This prevents mixing old/parallel streams.
      if (subscribedMsgNums.has(frame.header.msgNum)) {
        if (this.debugCfg.traceNativeStream && frame.header.cmdId === 3) {
          const now = Date.now();
          const key = frame.header.msgNum;
          const s = this.streamTraceStats.get(key) ?? {
            lastLogMs: now,
            frames: 0,
          };
          s.frames++;

          // Throttle per-frame logs to keep BCUDP ACK/keepalive responsive.
          if (now - s.lastLogMs >= 500) {
            traceLog(
              this.debugCfg,
              this.logger,
              "BaichuanTrace",
              `rx stream frames cmdId=3 msgNum=${frame.header.msgNum} frames=${s.frames} lastChannelId=${frame.header.channelId} lastBodyLen=${frame.body.length} lastPayloadLen=${frame.payload.length} lastPayloadOffset=${frame.header.payloadOffset ?? 0}`,
            );
            s.lastLogMs = now;
            s.frames = 0;
          }

          this.streamTraceStats.set(key, s);
        }
        this.emit("push", frame);
      }
      return;
    }

    // Handle cmd_id 145 (channel info push from NVR)
    if (frame.header.cmdId === BC_CMD_ID_CHANNEL_INFO_ALL) {
      try {
        // Decrypt the body using the same method as sendXml
        const xml = this.tryDecryptXml(
          frame.body,
          frame.header.channelId,
          this.enc,
        );
        if (xml && xml.startsWith("<?xml")) {
          // Emit a special event with the parsed channel info
          this.emit("channelInfo", xml);
          // this.logFixed("channel_info_push", {
          //   cmdId: frame.header.cmdId,
          //   msgNum: frame.header.msgNum,
          //   channelId: frame.header.channelId,
          //   bodyLen: frame.body.length,
          //   xmlLen: xml.length,
          // });
        } else {
          this.logDebug("channel_info_push_decrypt_failed", {
            bodyLen: frame.body.length,
            xmlPreview: xml?.substring(0, 100),
          });
        }
      } catch (e) {
        this.logDebug("channel_info_push_error", e);
      }
    }

    // No subscription: behave as before (generic push)
    this.emit("push", frame);

    // Parse events (cmd_id 33 = AlarmEventList push)
    if (frame.header.cmdId === 33) {
      try {
        const sid = this.socketSessionId;
        const eventLogTag = sid ? `BaichuanEvent sid=${sid}` : "BaichuanEvent";
        const events = this.parseEvents(frame);
        for (const event of events) {
          eventTraceLog(
            this.debugCfg,
            this.logger,
            eventLogTag,
            `dispatch cmdId=33 msgNum=${frame.header.msgNum} channelId=${frame.header.channelId} type=${event.type} eventChannel=${event.channel}` +
              (event.type === "ai"
                ? ` aiType=${(event.ai as any)?.type ?? "unknown"} detected=${(event.ai as any)?.detected ?? ""}`
                : "") +
              (event.type === "motion"
                ? ` source=${(event.motion as any)?.source ?? ""}`
                : ""),
          );
          this.emit("event", event);
        }
      } catch (error) {
        this.logDebug("event_parse_error", error);
      }
    }
  }

  /**
   * Subscribe to video stream frames with a specific cmdId and msgNum.
   *
   * @param cmdId - Command ID to subscribe to (e.g., 3 for MSG_ID_VIDEO)
   * @param msgNum - Message number to subscribe to
   */
  subscribeVideoStream(cmdId: number, msgNum: number): void {
    if (!this.videoSubscriptions.has(cmdId)) {
      this.videoSubscriptions.set(cmdId, new Set());
    }
    this.videoSubscriptions.get(cmdId)!.add(msgNum);
    if (cmdId === 3 && !this.streamTraceStats.has(msgNum)) {
      this.streamTraceStats.set(msgNum, { lastLogMs: Date.now(), frames: 0 });
    }

    // Streaming requires keeping the BCUDP session alive.
    if (this.transport === "udp") this.refreshKeepAlive();

    // Keep global streaming registry in sync.
    this.recomputeGlobalStreamingContribution();

    // Re-evaluate idle disconnect eligibility (streaming changes it).
    this.kickIdleDisconnectTimer();
  }

  /**
   * Unsubscribe from video stream frames.
   *
   * @param cmdId - Command ID to unsubscribe from
   * @param msgNum - Message number to unsubscribe from (optional, if not provided, unsubscribes from all msgNum for this cmdId)
   */
  unsubscribeVideoStream(cmdId: number, msgNum?: number): void {
    const subscribedMsgNums = this.videoSubscriptions.get(cmdId);
    if (!subscribedMsgNums) return;

    if (msgNum !== undefined) {
      subscribedMsgNums.delete(msgNum);
      if (subscribedMsgNums.size === 0) {
        this.videoSubscriptions.delete(cmdId);
      }
      if (cmdId === 3) this.streamTraceStats.delete(msgNum);
    } else {
      this.videoSubscriptions.delete(cmdId);
      if (cmdId === 3) this.streamTraceStats.clear();
    }

    if (this.transport === "udp") this.refreshKeepAlive();

    // Keep global streaming registry in sync.
    this.recomputeGlobalStreamingContribution();

    // If streaming stopped, we may now be eligible for idle disconnect.
    this.kickIdleDisconnectTimer();
  }

  /**
   * Parses event frame (cmd_id 33) into one or more ReolinkEvent.
   * Primary format: <AlarmEventList><AlarmEvent>...</AlarmEvent>...</AlarmEventList>
   * Fallback format (seen on some firmwares): <Event>...</Event>
   */
  private parseEvents(frame: BaichuanFrame): ReolinkEvent[] {
    const body = frame.body;
    if (body.length === 0) return [];

    const sid = this.socketSessionId;
    const eventRawLogTag = sid
      ? `BaichuanEventRaw sid=${sid}`
      : "BaichuanEventRaw";

    const xml = this.tryDecryptXml(body, frame.header.channelId, this.enc);
    if (!xml || !xml.startsWith("<?xml")) return [];

    if (this.debugCfg.traceEvents) {
      const snippet = xml.length > 500 ? `${xml.slice(0, 500)}...` : xml;
      eventTraceLog(
        this.debugCfg,
        this.logger,
        eventRawLogTag,
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} xml=${JSON.stringify(snippet)}`,
      );
    }

    // Default channel from frame header (channelId 250 = host, 1+ = channels)
    const fallbackChannelId = frame.header.channelId;
    const fallbackChannel =
      fallbackChannelId === 250 ? 0 : Math.max(0, fallbackChannelId - 1);

    const now = Date.now();

    // 1) Format: AlarmEventList
    if (xml.includes("<AlarmEventList")) {
      const out: ReolinkEvent[] = [];
      const alarmEventMatches = xml.matchAll(
        /<AlarmEvent\b[^>]*>([\s\S]*?)<\/AlarmEvent>/g,
      );
      for (const match of alarmEventMatches) {
        const alarmXml = match[1] ?? "";
        const channelText = getXmlText(alarmXml, "channelId");
        const channel =
          channelText !== undefined ? Number(channelText) : fallbackChannel;
        const status = (getXmlText(alarmXml, "status") ?? "").trim();
        const statusUpper = status.toUpperCase();

        // Some firmwares may attach AI type in different tag names.
        const aiTypeRaw = (
          getXmlText(alarmXml, "AItype") ??
          getXmlText(alarmXml, "aiType") ??
          getXmlText(alarmXml, "aitype") ??
          ""
        ).trim();

        // Some firmwares include a numeric timeStamp in AlarmEvent; when present and non-zero it can
        // be used to disambiguate real detections from static configured AI types.
        const timeStampRaw = (
          getXmlText(alarmXml, "timeStamp") ??
          getXmlText(alarmXml, "timestamp") ??
          ""
        ).trim();
        const timeStampNum = timeStampRaw.length
          ? Number(timeStampRaw)
          : undefined;
        const alarmTimeStamp = Number.isFinite(timeStampNum as number)
          ? (timeStampNum as number)
          : undefined;

        if (this.debugCfg.traceEvents) {
          eventTraceLog(
            this.debugCfg,
            this.logger,
            eventRawLogTag,
            `AlarmEvent channel=${channel} status=${JSON.stringify(status)} aiType=${JSON.stringify(aiTypeRaw)}`,
          );
        }

        // Unlike older implementations, a single AlarmEvent may encode multiple independent states
        // (e.g. motion + ai + visitor). Emit all applicable events.

        // Motion inference: treat as motion start when status != "none".
        // Battery cams often use status "other" for PIR-based motion.
        // IMPORTANT: Do not infer motion solely from AItype when status is "none"; some firmwares
        // report the configured AI type even when there is no detection.
        const statusLower = status.toLowerCase();
        const statusTokens = statusLower
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

        const visitorActive = statusTokens.includes("visitor");
        const dayNightActive =
          statusTokens.includes("dn") || statusTokens.includes("daynight");

        // Default motion heuristic: status != none, excluding known non-motion flags.
        const statusIndicatesMotion = statusTokens.some(
          (t) =>
            t !== "none" && t !== "visitor" && t !== "dn" && t !== "daynight",
        );
        const aiTypeTokenRaw = aiTypeRaw
          ? aiTypeRaw
              .split(",")
              .map((t) => t.trim())
              .find((t) => t.length > 0 && t.toLowerCase() !== "none")
          : undefined;

        const aiFlag = statusUpper.includes("AI");
        const aiTypeToken = (
          aiTypeTokenRaw ?? (aiFlag ? "other" : "none")
        ).toLowerCase();

        const prev = this.alarmEventState.get(channel);
        const curr = {
          motionActive: statusIndicatesMotion,
          visitorActive,
          dayNightActive,
          aiTypeToken,
          aiFlag,
          aiTimeStamp: alarmTimeStamp,
        };

        // First observation: initialize state, don't emit (avoids spurious startup detections).
        if (!prev) {
          this.alarmEventState.set(channel, curr);

          // However, some firmwares report an active AI detection immediately upon subscription without
          // toggling state. If a non-zero timeStamp is present, treat it as a concrete detection.
          if (
            curr.aiTypeToken !== "none" &&
            curr.aiTimeStamp &&
            curr.aiTimeStamp !== 0
          ) {
            const t = curr.aiTypeToken;
            const aiTypeMap: Record<
              string,
              "people" | "vehicle" | "dog_cat" | "face" | "package" | "other"
            > = {
              people: "people",
              person: "people",
              human: "people",
              vehicle: "vehicle",
              car: "vehicle",
              dog_cat: "dog_cat",
              dog: "dog_cat",
              cat: "dog_cat",
              pet: "dog_cat",
              face: "face",
              package: "package",
            };
            out.push({
              channel,
              type: "ai",
              ai: {
                channel,
                type: aiTypeMap[t] ?? "other",
                detected: true,
                timestamp: now,
              },
              timestamp: now,
            });
          }

          // Doorbell/visitor and day/night are discrete flags.
          if (curr.visitorActive)
            out.push({ channel, type: "visitor", timestamp: now });
          if (curr.dayNightActive)
            out.push({ channel, type: "daynight", timestamp: now });

          continue;
        }

        // Motion: emit only on rising edge.
        if (!prev.motionActive && curr.motionActive) {
          const source = statusUpper.includes("MD")
            ? "md"
            : statusUpper.includes("PIR") || statusUpper.includes("OTHER")
              ? "pir"
              : "unknown";
          out.push({
            channel,
            type: "motion",
            motion: { channel, state: true, timestamp: now, source },
            timestamp: now,
          });
        }

        // AI: many firmwares (notably hubs) toggle AItype between "none" and a token while status stays "none".
        // Emit on AI type transition to a non-none value.
        // Additionally, if a non-zero timeStamp is present, emit when it changes (some firmwares keep AItype
        // constant like "other" while timeStamp increments per detection).
        const aiTypeChanged = prev.aiTypeToken !== curr.aiTypeToken;
        const aiTimeStampChanged =
          curr.aiTimeStamp !== undefined &&
          curr.aiTimeStamp !== 0 &&
          curr.aiTimeStamp !== prev.aiTimeStamp;

        if (
          (aiTypeChanged && curr.aiTypeToken !== "none") ||
          (aiTimeStampChanged && curr.aiTypeToken !== "none")
        ) {
          const t = curr.aiTypeToken;
          const aiTypeMap: Record<
            string,
            "people" | "vehicle" | "dog_cat" | "face" | "package" | "other"
          > = {
            people: "people",
            person: "people",
            human: "people",
            vehicle: "vehicle",
            car: "vehicle",
            dog_cat: "dog_cat",
            dog: "dog_cat",
            cat: "dog_cat",
            pet: "dog_cat",
            face: "face",
            package: "package",
          };
          out.push({
            channel,
            type: "ai",
            ai: {
              channel,
              type: aiTypeMap[t] ?? "other",
              detected: true,
              timestamp: now,
            },
            timestamp: now,
          });
        }

        // Doorbell/visitor and day/night: emit only on rising edge.
        if (!prev.visitorActive && curr.visitorActive) {
          out.push({ channel, type: "visitor", timestamp: now });
        }

        if (!prev.dayNightActive && curr.dayNightActive) {
          out.push({ channel, type: "daynight", timestamp: now });
        }

        // Update state after processing.
        this.alarmEventState.set(channel, curr);
      }
      return out;
    }

    // 2) Fallback format: <Event>
    const eventMatch = xml.match(/<Event\b[^>]*>([\s\S]*?)<\/Event>/);
    if (!eventMatch) return [];

    const eventXml = eventMatch[1] ?? "";
    const status = (getXmlText(eventXml, "status") ?? "").trim();
    const statusUpper = status.toUpperCase();
    const aiTypeRaw = (
      getXmlText(eventXml, "AItype") ??
      getXmlText(eventXml, "aiType") ??
      getXmlText(eventXml, "aitype") ??
      ""
    ).trim();

    const timeStampRaw = (
      getXmlText(eventXml, "timeStamp") ??
      getXmlText(eventXml, "timestamp") ??
      ""
    ).trim();
    const timeStampNum = timeStampRaw.length ? Number(timeStampRaw) : undefined;
    const alarmTimeStamp = Number.isFinite(timeStampNum as number)
      ? (timeStampNum as number)
      : undefined;

    const out: ReolinkEvent[] = [];

    const statusLower = status.toLowerCase();
    const statusTokens = statusLower
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const visitorActive = statusTokens.includes("visitor");
    const dayNightActive =
      statusTokens.includes("dn") || statusTokens.includes("daynight");
    const statusIndicatesMotion = statusTokens.some(
      (t) => t !== "none" && t !== "visitor" && t !== "dn" && t !== "daynight",
    );

    const aiTypeTokenRaw = aiTypeRaw
      ? aiTypeRaw
          .split(",")
          .map((t) => t.trim())
          .find((t) => t.length > 0 && t.toLowerCase() !== "none")
      : undefined;
    const aiFlag = statusUpper.includes("AI");
    const aiTypeToken = (
      aiTypeTokenRaw ?? (aiFlag ? "other" : "none")
    ).toLowerCase();

    const prev = this.alarmEventState.get(fallbackChannel);
    const curr = {
      motionActive: statusIndicatesMotion,
      visitorActive,
      dayNightActive,
      aiTypeToken,
      aiFlag,
      aiTimeStamp: alarmTimeStamp,
    };

    if (!prev) {
      this.alarmEventState.set(fallbackChannel, curr);

      if (
        curr.aiTypeToken !== "none" &&
        curr.aiTimeStamp &&
        curr.aiTimeStamp !== 0
      ) {
        const t = curr.aiTypeToken;
        const aiTypeMap: Record<
          string,
          "people" | "vehicle" | "dog_cat" | "face" | "package" | "other"
        > = {
          people: "people",
          person: "people",
          human: "people",
          vehicle: "vehicle",
          car: "vehicle",
          dog_cat: "dog_cat",
          dog: "dog_cat",
          cat: "dog_cat",
          pet: "dog_cat",
          face: "face",
          package: "package",
        };
        out.push({
          channel: fallbackChannel,
          type: "ai",
          ai: {
            channel: fallbackChannel,
            type: aiTypeMap[t] ?? "other",
            detected: true,
            timestamp: now,
          },
          timestamp: now,
        });
      }

      if (curr.visitorActive)
        out.push({ channel: fallbackChannel, type: "visitor", timestamp: now });
      if (curr.dayNightActive)
        out.push({
          channel: fallbackChannel,
          type: "daynight",
          timestamp: now,
        });

      return out;
    }

    if (!prev.motionActive && curr.motionActive) {
      const source = statusUpper.includes("MD")
        ? "md"
        : statusUpper.includes("PIR") || statusUpper.includes("OTHER")
          ? "pir"
          : "unknown";
      out.push({
        channel: fallbackChannel,
        type: "motion",
        motion: {
          channel: fallbackChannel,
          state: true,
          timestamp: now,
          source,
        },
        timestamp: now,
      });
    }

    const aiTypeChanged = prev.aiTypeToken !== curr.aiTypeToken;
    const aiTimeStampChanged =
      curr.aiTimeStamp !== undefined &&
      curr.aiTimeStamp !== 0 &&
      curr.aiTimeStamp !== prev.aiTimeStamp;

    if (
      (aiTypeChanged && curr.aiTypeToken !== "none") ||
      (aiTimeStampChanged && curr.aiTypeToken !== "none")
    ) {
      const t = curr.aiTypeToken;
      const aiTypeMap: Record<
        string,
        "people" | "vehicle" | "dog_cat" | "face" | "package" | "other"
      > = {
        people: "people",
        person: "people",
        human: "people",
        vehicle: "vehicle",
        car: "vehicle",
        dog_cat: "dog_cat",
        dog: "dog_cat",
        cat: "dog_cat",
        pet: "dog_cat",
        face: "face",
        package: "package",
      };
      out.push({
        channel: fallbackChannel,
        type: "ai",
        ai: {
          channel: fallbackChannel,
          type: aiTypeMap[t] ?? "other",
          detected: true,
          timestamp: now,
        },
        timestamp: now,
      });
    }

    if (!prev.visitorActive && curr.visitorActive)
      out.push({ channel: fallbackChannel, type: "visitor", timestamp: now });
    if (!prev.dayNightActive && curr.dayNightActive)
      out.push({ channel: fallbackChannel, type: "daynight", timestamp: now });

    this.alarmEventState.set(fallbackChannel, curr);

    return out;
  }

  private nextMsgNum(): number {
    this.msgNum = (this.msgNum + 1) & 0xffff;
    return this.msgNum;
  }

  /**
   * Atomically allocate the next msgNum.
   *
   * IMPORTANT: `peekNextMsgNum()` is not safe under concurrency: two parallel callers can observe
   * the same value and end up starting two streams with the same msgNum, which causes media packet
   * mixups when sharing a single socket.
   */
  public reserveNextMsgNum(): number {
    return this.nextMsgNum();
  }

  /**
   * Get the next message number that will be used (without incrementing).
   * Useful for subscribing to video streams before sending the command.
   * Public to allow ReolinkBaichuanApi to subscribe before sending video stream commands.
   */
  public peekNextMsgNum(): number {
    return (this.msgNum + 1) & 0xffff;
  }

  private requireSocket(): net.Socket {
    if (this.transport !== "tcp")
      throw new Error("Internal: requireSocket called while not using TCP");
    if (!this.tcpSocket || this.tcpSocket.destroyed)
      throw new Error("Baichuan TCP socket is not connected");
    return this.tcpSocket;
  }

  private writeWire(wire: Buffer): void {
    this.lastTxAtMs = Date.now();
    if (this.transport === "tcp") {
      this.requireSocket().write(wire);
      return;
    }
    if (!this.udpSocket)
      throw new Error("Baichuan UDP stream is not connected");
    this.udpSocket.write(wire);
  }

  private encodeBodyXml(
    extXml: string,
    payloadXml: string,
    channelId: number,
    enc: EncryptionProtocol,
  ): Buffer {
    const extBuf = Buffer.from(extXml, "utf8");
    const payloadBuf = Buffer.from(payloadXml, "utf8");

    if (enc.kind === "none") return Buffer.concat([extBuf, payloadBuf]);
    if (enc.kind === "bc")
      return Buffer.concat([
        bcEncrypt(extBuf, channelId),
        bcEncrypt(payloadBuf, channelId),
      ]);
    if (enc.kind === "aes" || enc.kind === "full_aes")
      return Buffer.concat([
        aesEncrypt(extBuf, enc.key),
        aesEncrypt(payloadBuf, enc.key),
      ]);
    // exhaustive
    return Buffer.concat([extBuf, payloadBuf]);
  }

  private encodeBodyBinary(
    extXml: string,
    payload: Buffer,
    channelId: number,
    enc: EncryptionProtocol,
  ): Buffer {
    const extBuf = Buffer.from(extXml, "utf8");

    // Binary payloads are sent unencrypted, while the Extension is still encrypted.
    if (enc.kind === "none") return Buffer.concat([extBuf, payload]);
    if (enc.kind === "bc")
      return Buffer.concat([bcEncrypt(extBuf, channelId), payload]);
    if (enc.kind === "aes" || enc.kind === "full_aes")
      return Buffer.concat([aesEncrypt(extBuf, enc.key), payload]);
    return Buffer.concat([extBuf, payload]);
  }

  /**
   * Sends a Baichuan command with a binary payload (Extension XML + raw binary payload).
   *
   * This is required for Talk (cmdId=202): the payload is BcMedia ADPCM and should NOT be encrypted,
   * while the Extension still follows the session encryption.
   *
   * Note: many cameras do not send a reply for Talk packets, so this is fire-and-forget.
   */
  async sendBinaryPayloadNoReply(params: {
    cmdId: number;
    payload: Buffer;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    /** If omitted, uses a binary Extension with <binaryData>1</binaryData> + channelId. */
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    /** Internal operations should not count as user activity for idle disconnect. */
    internal?: boolean;
  }): Promise<void> {
    const internal = params.internal === true;
    if (!internal)
      this.touchUserActivity(`sendBinaryPayloadNoReply cmdId=${params.cmdId}`);
    await this.connect();
    if (!internal) this.kickIdleDisconnectTimer();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId =
      params.channelIdOverride ??
      (params.channel == null ? this.hostChannelId : channel + 1);

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml = params.extensionXml ?? buildBinaryExtensionXml(channel);
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + params.payload.length;

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: params.streamType ?? 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyBinary(
      extXml,
      params.payload,
      channelId,
      enc,
    );
    const wire = Buffer.concat([header, bodyBytes]);

    this.logDebug("tx", {
      cmdId,
      msgNum,
      channelId,
      messageClass,
      bodyLen,
      binaryPayload: true,
    });
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTalk",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset} binaryPayloadLen=${params.payload.length}`,
      );
    }
    this.recordTx({
      cmdId,
      responseCode: 0,
      msgNum,
      channelId,
      streamType: params.streamType ?? 0,
    });
    this.writeWire(wire);

    if (!internal) this.kickIdleDisconnectTimer();
  }

  tryDecryptXml(
    buf: Buffer,
    channelId: number,
    preferred: EncryptionProtocol,
  ): string {
    const tryDecode = (b: Buffer) => b.toString("utf8");

    const tryAs = (enc: EncryptionProtocol): string | undefined => {
      let dec: Buffer;
      try {
        if (enc.kind === "none") dec = buf;
        else if (enc.kind === "bc") dec = bcDecrypt(buf, channelId);
        else dec = aesDecrypt(buf, enc.key);
      } catch {
        return undefined;
      }
      const s = tryDecode(dec);
      return s.startsWith("<?xml") ? s : undefined;
    };

    return (
      tryAs(preferred) ??
      (preferred.kind !== "bc" ? tryAs({ kind: "bc" }) : undefined) ??
      tryAs({ kind: "none" }) ??
      tryDecode(buf)
    );
  }

  /**
   * Sends a Baichuan command and returns the XML reply (if any).
   * If the reply has no body, returns an empty string.
   */
  async sendXml(params: {
    cmdId: number;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    /** Header class; defaults to modern 24-byte header (0x6414). */
    messageClass?: number;
    /** Stream type in header: 0 for main/ext, 1 for sub (used for video streaming). */
    streamType?: number;
    /** Force a specific encryption protocol for this call. */
    encryption?: EncryptionProtocol;
    /** Timeout ms. */
    timeoutMs?: number;
    /** Internal operations (keepalive/ping) should not count as user activity for idle disconnect. */
    internal?: boolean;
  }): Promise<string> {
    const internal = params.internal === true;
    if (!internal) this.touchUserActivity(`sendXml cmdId=${params.cmdId}`);
    await this.connect();
    if (!internal) this.kickIdleDisconnectTimer();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId =
      params.channelIdOverride ??
      (params.channel == null ? this.hostChannelId : channel + 1);

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml =
      params.extensionXml ??
      (params.channel != null ? buildChannelExtensionXml(channel) : "");
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: params.streamType ?? 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });
    const pendingKey: PendingKey = `${cmdId}:${msgNum}`;

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 10_000;
    let rejectFn: ((e: Error) => void) | undefined;
    const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
      rejectFn = reject;
      const t = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`Baichuan timeout cmdId=${cmdId} msgNum=${msgNum}`));
      }, timeoutMs);
      this.pending.set(pendingKey, {
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });

    // CRITICAL: Add catch handler IMMEDIATELY after promise creation, BEFORE any operations
    // This must happen synchronously, before writeWire or any async operations
    // This prevents unhandled rejections when socket closes during writeWire
    framePromise.catch(() => {
      // Silently handle rejections from socket closures
      // The caller will handle the error when they await the promise
    });

    this.logDebug("tx", { cmdId, msgNum, channelId, messageClass, bodyLen });
    if (this.debugCfg.traceNativeStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTrace",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`,
      );
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTalk",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`,
      );
    }
    this.recordTx({
      cmdId,
      responseCode: 0,
      msgNum,
      channelId,
      streamType: params.streamType ?? 0,
    });
    this.writeWire(wire);

    const frame = await framePromise;
    this.logDebug("rx", {
      cmdId: frame.header.cmdId,
      responseCode: frame.header.responseCode,
      msgNum: frame.header.msgNum,
    });
    if (this.debugCfg.traceNativeStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTrace",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`,
      );
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTalk",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`,
      );
    }

    // Check responseCode for errors (400 = bad request/auth failure, 200 = success)
    // Some cameras return 400 with empty body when authentication fails
    if (frame.header.responseCode === 400) {
      // Try to decrypt anyway in case there's an error message, but don't fail if body is empty
      const body = frame.body;
      if (body.length === 0) {
        // Empty body with 400 typically means authentication failure
        throw new Error(
          "Baichuan authentication failed (responseCode 400, empty body) - check username/password",
        );
      }
      // If body is not empty, try to decrypt and return it (might contain error details)
    }

    // split + decrypt (extension/payload concatenated as in body)
    const body = frame.body;
    if (body.length === 0) {
      if (!internal) this.kickIdleDisconnectTimer();
      return "";
    }

    // For modern 24-byte frames: extension+payload; we decrypt full body as one stream just like references do.
    // (In practice extension and payload are separately encrypted but concatenation preserves it.)
    const xml = this.tryDecryptXml(body, frame.header.channelId, enc);
    if (!internal) this.kickIdleDisconnectTimer();
    return xml;
  }

  /**
   * Sends a Baichuan command and returns the frame (for checking response_code).
   * Similar to sendXml but returns the full frame instead of just the XML body.
   */
  async sendFrame(params: {
    cmdId: number;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    /** Override the header msgNum for this request (advanced; used to match start/stop stream msgNum). */
    msgNumOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
    /** Internal operations (keepalive/ping) should not count as user activity for idle disconnect. */
    internal?: boolean;
  }): Promise<BaichuanFrame> {
    const internal = params.internal === true;
    if (!internal) this.touchUserActivity(`sendFrame cmdId=${params.cmdId}`);
    await this.connect();
    if (!internal) this.kickIdleDisconnectTimer();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId =
      params.channelIdOverride ??
      (params.channel == null ? this.hostChannelId : channel + 1);

    const msgNum = params.msgNumOverride ?? this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml =
      params.extensionXml ??
      (params.channel != null ? buildChannelExtensionXml(channel) : "");
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: params.streamType ?? 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });
    const pendingKey: PendingKey = `${cmdId}:${msgNum}`;

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 10_000;
    let rejectFn: ((e: Error) => void) | undefined;
    const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
      rejectFn = reject;
      const t = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`Baichuan timeout cmdId=${cmdId} msgNum=${msgNum}`));
      }, timeoutMs);
      this.pending.set(pendingKey, {
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });

    // CRITICAL: Add catch handler IMMEDIATELY after promise creation, BEFORE any operations
    // This must happen synchronously, before writeWire or any async operations
    // This prevents unhandled rejections when socket closes during writeWire
    framePromise.catch(() => {
      // Silently handle rejections from socket closures
      // The caller will handle the error when they await the promise
    });

    this.logDebug("tx", { cmdId, msgNum, channelId, messageClass, bodyLen });
    if (BaichuanClient.recordingCmdIds.has(cmdId)) {
      recordingsTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanRecordings",
        `tx recording cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} bodyLen=${bodyLen}`,
      );
    }
    if (this.debugCfg.traceNativeStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTrace",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`,
      );
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTalk",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`,
      );
    }
    this.recordTx({
      cmdId,
      responseCode: 0,
      msgNum,
      channelId,
      streamType: params.streamType ?? 0,
    });
    this.writeWire(wire);

    const frame = await framePromise;
    this.logDebug("rx", {
      cmdId: frame.header.cmdId,
      responseCode: frame.header.responseCode,
      msgNum: frame.header.msgNum,
    });
    if (BaichuanClient.recordingCmdIds.has(frame.header.cmdId)) {
      recordingsTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanRecordings",
        `rx recording cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`,
      );
    }
    if (this.debugCfg.traceNativeStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTrace",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`,
      );
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg,
        this.logger,
        "BaichuanTalk",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`,
      );
    }
    if (!internal) this.kickIdleDisconnectTimer();
    return frame;
  }

  /**
   * Sends a Baichuan command and returns the binary reply (for commands like Snap that return binary data).
   * Similar to sendXml but returns raw Buffer instead of XML string.
   */
  async sendBinary(params: {
    cmdId: number;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    /** Override the header msgNum for this request (advanced). */
    msgNumOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
    /** Internal operations should not count as user activity for idle disconnect. */
    internal?: boolean;
  }): Promise<Buffer> {
    const internal = params.internal === true;
    if (!internal) this.touchUserActivity(`sendBinary cmdId=${params.cmdId}`);
    // Snapshot (cmdId=109) is special: many firmwares deliver the binary payload via unsolicited "push" frames
    // and do not necessarily reply on the request's cmdId:msgNum pending slot. In that case, waiting on
    // `pending` will timeout. Handle it by sending without pending and collecting push chunks.
    if (params.cmdId === 109) {
      const res = await this.sendBinarySnapshot109(params);
      if (!internal) this.kickIdleDisconnectTimer();
      return res;
    }

    // FileInfoList replay (cmdId=5) is commonly delivered as a sequence of binary chunks.
    // PCAP: response Extension has <binaryData>1</binaryData> and then many payload-only frames.
    if (params.cmdId === BC_CMD_ID_FILE_INFO_LIST_REPLAY) {
      const res = await this.sendBinaryFileInfoListReplay5(params);
      if (!internal) this.kickIdleDisconnectTimer();
      return res;
    }

    // File download (class=0x6482) is often delivered as a sequence of binary chunks.
    // Handle it similarly to snapshot: send without pending and collect frames until completion.
    if (
      (params.messageClass ?? BC_CLASS_MODERN_24) === BC_CLASS_FILE_DOWNLOAD
    ) {
      const res = await this.sendBinaryFileDownload6482(params);
      if (!internal) this.kickIdleDisconnectTimer();
      return res;
    }

    await this.connect();
    if (!internal) this.kickIdleDisconnectTimer();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId =
      params.channelIdOverride ??
      (params.channel == null ? this.hostChannelId : channel + 1);

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml =
      params.extensionXml ??
      (params.channel != null
        ? buildBinaryExtensionXml(channel)
        : buildBinaryExtensionXml(undefined));
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });
    const pendingKey: PendingKey = `${cmdId}:${msgNum}`;

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 10_000;
    let rejectFn: ((e: Error) => void) | undefined;
    const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
      rejectFn = reject;
      const t = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`Baichuan timeout cmdId=${cmdId} msgNum=${msgNum}`));
      }, timeoutMs);
      this.pending.set(pendingKey, {
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });

    // CRITICAL: Add catch handler IMMEDIATELY after promise creation, BEFORE any operations
    // This must happen synchronously, before writeWire or any async operations
    // This prevents unhandled rejections when socket closes during writeWire
    framePromise.catch(() => {
      // Silently handle rejections from socket closures
      // The caller will handle the error when they await the promise
    });

    this.logDebug("tx", {
      cmdId,
      msgNum,
      channelId,
      messageClass,
      bodyLen,
      binary: true,
    });
    this.recordTx({ cmdId, responseCode: 0, msgNum, channelId, streamType: 0 });
    this.writeWire(wire);

    const frame = await framePromise;
    this.logDebug("rx", {
      cmdId: frame.header.cmdId,
      responseCode: frame.header.responseCode,
      msgNum: frame.header.msgNum,
      binary: true,
    });

    if (frame.header.responseCode === 400) {
      const body = frame.body;
      if (body.length === 0) {
        throw new Error(
          "Baichuan binary request failed (responseCode 400, empty body)",
        );
      }
    }

    // IMPORTANT: `body` can include an XML Extension prefix; for binary data use `payload`.
    const payload = frame.payload;
    if (payload.length === 0) return Buffer.alloc(0);

    const decrypted = this.tryDecryptBinary(
      payload,
      frame.header.channelId,
      enc,
    );
    if (!internal) this.kickIdleDisconnectTimer();
    return decrypted;
  }

  private async sendBinaryFileDownload6482(params: {
    cmdId: number;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId =
      params.channelIdOverride ??
      (params.channel == null ? this.hostChannelId : channel + 1);

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    // For binary downloads, request Extension should include <binaryData>1</binaryData>.
    const extXml = params.extensionXml ?? buildBinaryExtensionXml(channel);
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_FILE_DOWNLOAD;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: params.streamType ?? 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 60_000;
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let lastProgressLogAt = 0;
    let streamMsgNum: number | undefined;
    let lockedChannelId: number | undefined;
    let lockedStreamType: number | undefined;

    const expectedStreamType = params.streamType ?? 0;

    return await new Promise<Buffer>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      let done = false;

      const cleanup = () => {
        this.off("frame", onFrame);
        if (timeout) clearTimeout(timeout);
      };

      const finish = (buf: Buffer) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(buf);
      };

      const fail = (e: unknown) => {
        if (done) return;
        done = true;
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const looksLikeXml = (buf: Buffer): boolean => {
        // Skip leading whitespace/NULs
        let i = 0;
        while (
          i < buf.length &&
          (buf[i] === 0x00 ||
            buf[i] === 0x09 ||
            buf[i] === 0x0a ||
            buf[i] === 0x0d ||
            buf[i] === 0x20)
        )
          i++;
        if (i >= buf.length) return false;
        return buf[i] === 0x3c; // '<'
      };

      const decryptBinaryForDownload = (
        payload: Buffer,
        frameChannelId: number,
        encryptLen?: number,
      ): Buffer => {
        // If encryptLen is provided, only decrypt the first encryptLen bytes
        // and keep the rest as-is. This is how Reolink partial encryption works.
        if (
          encryptLen !== undefined &&
          encryptLen > 0 &&
          encryptLen < payload.length
        ) {
          const encryptedPart = payload.subarray(0, encryptLen);
          const clearPart = payload.subarray(encryptLen);
          const decryptedPart = this.tryDecryptBinary(
            encryptedPart,
            frameChannelId,
            enc,
          );
          return Buffer.concat([decryptedPart, clearPart]);
        }

        // Helper to score how "BcMedia-like" a buffer is
        const scoreBcMediaLike = (b: Buffer): number => {
          if (b.length < 4) return -1;
          const maxScan = Math.min(64 * 1024, b.length - 4);
          let count = 0;
          let first = -1;
          for (let i = 0; i <= maxScan; i++) {
            const magic = b.readUInt32LE(i);
            const isInfoV1 = magic === 0x31303031;
            const isInfoV2 = magic === 0x32303031;
            const isIFrame = magic >= 0x63643030 && magic <= 0x63643039;
            const isPFrame = magic >= 0x63643130 && magic <= 0x63643139;
            const isAac = magic === 0x62773530;
            const isAdpcm = magic === 0x62773130;
            if (
              isInfoV1 ||
              isInfoV2 ||
              isIFrame ||
              isPFrame ||
              isAac ||
              isAdpcm
            ) {
              count++;
              if (first < 0) first = i;
              if (count > 32 && first === 0) break;
            }
          }
          return count * 1000 - (first < 0 ? 50000 : first);
        };

        if (enc.kind !== "bc") {
          // In AES/full_aes mode, video data may NOT be encrypted.
          // Compare raw vs decrypted and choose the one that looks more like BcMedia.
          const decrypted = this.tryDecryptBinary(payload, frameChannelId, enc);
          const rawScore = scoreBcMediaLike(payload);
          const decScore = scoreBcMediaLike(decrypted);
          // Use >= so we prefer raw if scores are equal (avoid unnecessary decrypt)
          return rawScore >= decScore ? payload : decrypted;
        }

        const candidates = [frameChannelId, channelId, 250, 0, 1].filter(
          (n, i, a) => Number.isFinite(n) && a.indexOf(n) === i,
        );
        const decrypted = candidates.map((cid) =>
          this.tryDecryptBinary(payload, cid, enc),
        );

        // Prefer a candidate that doesn't look like XML (chunks are binary).
        for (const d of decrypted) {
          if (d.length > 0 && !looksLikeXml(d)) return d;
        }
        return decrypted[0] ?? Buffer.alloc(0);
      };

      const onFrame = (frame: BaichuanFrame) => {
        if (frame.header.cmdId !== cmdId) return;

        if (
          lockedStreamType !== undefined &&
          frame.header.streamType !== lockedStreamType
        ) {
          return;
        }

        // Filter by request context (avoid mixing concurrent downloads on the same socket).
        // Some NVR firmwares reply with a different channelId than the request.
        if (
          lockedChannelId !== undefined &&
          frame.header.channelId !== lockedChannelId
        ) {
          return;
        }

        // Once we lock onto a stream msgNum, ignore everything else.
        if (
          streamMsgNum !== undefined &&
          frame.header.msgNum !== streamMsgNum
        ) {
          return;
        }

        // Fail fast if the request was rejected.
        if (
          frame.header.msgNum === msgNum &&
          frame.header.responseCode >= 400
        ) {
          fail(
            new Error(
              `Baichuan file download request rejected (cmdId=${cmdId} reqChannelId=${channelId} rspChannelId=${frame.header.channelId} msgNum=${msgNum} responseCode=${frame.header.responseCode})`,
            ),
          );
          return;
        }

        try {
          // Some firmwares do NOT mark file download chunks with <binaryData>1</binaryData>.
          // Prefer the marker when present, otherwise fall back to a payload heuristic.
          let markedBinary = false;
          let encryptLen: number | undefined;
          if (frame.extension.length > 0) {
            try {
              const extDec = this.tryDecryptXml(
                frame.extension,
                frame.header.channelId,
                enc,
              );
              if (extDec.includes("<binaryData>1</binaryData>"))
                markedBinary = true;
              // Extract encryptLen if present - only first N bytes of payload are encrypted
              const encryptLenMatch = extDec.match(
                /<encryptLen>(\d+)<\/encryptLen>/i,
              );
              if (encryptLenMatch && encryptLenMatch[1]) {
                encryptLen = parseInt(encryptLenMatch[1], 10);
              }
            } catch {
              // ignore
            }
          }

          const decrypted = decryptBinaryForDownload(
            frame.payload,
            frame.header.channelId,
            encryptLen,
          );
          if (decrypted.length === 0) return;

          if (!markedBinary) {
            // If the payload looks like XML, it's probably an ACK/info frame, not a chunk.
            if (looksLikeXml(decrypted)) return;
          }

          // Lock onto the msgNum that is actually carrying binary chunks.
          if (streamMsgNum === undefined) {
            streamMsgNum = frame.header.msgNum;
            lockedChannelId = frame.header.channelId;
            lockedStreamType = frame.header.streamType;
          }

          chunks.push(decrypted);
          receivedBytes += decrypted.length;

          // Debug-only progress hint for long downloads (avoid noisy logs).
          const now = Date.now();
          if (this.debugCfg.general && now - lastProgressLogAt >= 2_000) {
            lastProgressLogAt = now;
            this.logDebug("file_download_progress", {
              cmdId,
              msgNum,
              bytes: receivedBytes,
            });
          }

          // Completion commonly uses responseCode=201 for the final chunk.
          if (frame.header.responseCode === 201) {
            finish(Buffer.concat(chunks));
          }
        } catch (e) {
          fail(e);
        }
      };

      timeout = setTimeout(() => {
        fail(
          new Error(
            `Baichuan timeout waiting file download chunks cmdId=${cmdId} msgNum=${msgNum}`,
          ),
        );
      }, timeoutMs);

      // Attach listener BEFORE sending request.
      this.on("frame", onFrame);

      try {
        this.logDebug("tx", {
          cmdId,
          msgNum,
          channelId,
          messageClass,
          bodyLen,
          binary: true,
          fileDownload: true,
        });
        this.recordTx({
          cmdId,
          responseCode: 0,
          msgNum,
          channelId,
          streamType: expectedStreamType,
        });
        this.writeWire(wire);
      } catch (e) {
        fail(e);
      }
    });
  }

  private async sendBinaryFileInfoListReplay5(params: {
    cmdId: number;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    /** Override the header msgNum for this request (advanced). */
    msgNumOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    // PCAP analysis shows: channelId in header is a SESSION COUNTER that increments,
    // similar to CoverPreview (cmdId=298). Some H265 cameras reject channelId=0 or
    // channel+1 with responseCode=400 but accept a session counter value.
    // Use a separate session counter for channelId (independent from msgNum).
    const sessionCounter = this.nextMsgNum();
    const channelId = params.channelIdOverride ?? sessionCounter;
    // PCAP shows msgNum is always 0 for FileInfoListReplay (cmdId=5), like CoverPreview.
    const msgNum = params.msgNumOverride ?? 0;
    const cmdId = params.cmdId;

    // PCAP: request uses empty extension (payloadOffset=0).
    const extXml = params.extensionXml ?? "";
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");
    const expectedStreamType = params.streamType ?? 0;
    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: expectedStreamType,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 120_000;
    // Idle timeout: finish after no data received for this duration.
    // Cameras may send data in bursts with pauses between GOP boundaries.
    // Use longer timeout to ensure full file is received.
    const idleTimeoutMs = 15_000;
    const chunks: Buffer[] = [];
    let streamMsgNum: number | undefined;
    let lockedChannelId: number | undefined;
    let lockedStreamType: number | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const looksLikeXml = (buf: Buffer): boolean => {
      let i = 0;
      while (
        i < buf.length &&
        (buf[i] === 0x00 ||
          buf[i] === 0x09 ||
          buf[i] === 0x0a ||
          buf[i] === 0x0d ||
          buf[i] === 0x20)
      )
        i++;
      if (i >= buf.length) return false;
      return buf[i] === 0x3c;
    };

    const decryptBinaryForReplay = (
      payload: Buffer,
      frameChannelId: number,
      encryptLen?: number,
    ) => {
      // If encryptLen is provided, only decrypt the first encryptLen bytes
      // and keep the rest as-is. This is how Reolink partial encryption works.
      if (
        encryptLen !== undefined &&
        encryptLen > 0 &&
        encryptLen < payload.length
      ) {
        const encryptedPart = payload.subarray(0, encryptLen);
        const clearPart = payload.subarray(encryptLen);
        const decryptedPart = this.tryDecryptBinary(
          encryptedPart,
          frameChannelId,
          enc,
        );
        return Buffer.concat([decryptedPart, clearPart]);
      }

      // Helper to score how "BcMedia-like" a buffer is
      const scoreBcMediaLike = (b: Buffer): number => {
        if (b.length < 4) return -1;
        const maxScan = Math.min(64 * 1024, b.length - 4);
        let count = 0;
        let first = -1;
        for (let i = 0; i <= maxScan; i++) {
          const magic = b.readUInt32LE(i);
          const isInfoV1 = magic === 0x31303031;
          const isInfoV2 = magic === 0x32303031;
          const isIFrame = magic >= 0x63643030 && magic <= 0x63643039;
          const isPFrame = magic >= 0x63643130 && magic <= 0x63643139;
          const isAac = magic === 0x62773530;
          const isAdpcm = magic === 0x62773130;
          if (
            isInfoV1 ||
            isInfoV2 ||
            isIFrame ||
            isPFrame ||
            isAac ||
            isAdpcm
          ) {
            count++;
            if (first < 0) first = i;
            if (count > 32 && first === 0) break;
          }
        }
        return count * 1000 - (first < 0 ? 50000 : first);
      };

      if (enc.kind !== "bc") {
        // In AES/full_aes mode, video data may NOT be encrypted.
        // Compare raw vs decrypted and choose the one that looks more like BcMedia.
        const decrypted = this.tryDecryptBinary(payload, frameChannelId, enc);
        const rawScore = scoreBcMediaLike(payload);
        const decScore = scoreBcMediaLike(decrypted);
        // Use >= so we prefer raw if scores are equal (avoid unnecessary decrypt)
        return rawScore >= decScore ? payload : decrypted;
      }

      const candidates = [frameChannelId, channelId, 250, 0, 1].filter(
        (n, i, a) => Number.isFinite(n) && a.indexOf(n) === i,
      );
      const decrypted = candidates.map((cid) =>
        this.tryDecryptBinary(payload, cid, enc),
      );

      for (const d of decrypted) {
        if (d.length > 0 && !looksLikeXml(d)) return d;
      }
      return decrypted[0] ?? Buffer.alloc(0);
    };

    return await new Promise<Buffer>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      let done = false;

      const cleanup = () => {
        this.off("frame", onFrame);
        if (timeout) clearTimeout(timeout);
        if (idleTimer) clearTimeout(idleTimer);
      };

      const finish = (buf: Buffer) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(buf);
      };

      const fail = (e: unknown) => {
        if (done) return;
        done = true;
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const armIdleFinish = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (chunks.length > 0) finish(Buffer.concat(chunks));
        }, idleTimeoutMs);
      };

      const onFrame = (frame: BaichuanFrame) => {
        if (frame.header.cmdId !== cmdId) return;

        // Some firmwares reply with a different streamType than the request.
        // Lock streamType once we see the stream header / first binary chunk.
        if (
          lockedStreamType !== undefined &&
          frame.header.streamType !== lockedStreamType
        ) {
          return;
        }

        // Some NVR firmwares reply with a different channelId than the request.
        // Lock channelId once we see the first binary chunk.
        if (
          lockedChannelId !== undefined &&
          frame.header.channelId !== lockedChannelId
        ) {
          return;
        }

        if (
          streamMsgNum !== undefined &&
          frame.header.msgNum !== streamMsgNum
        ) {
          return;
        }

        // PCAP: replay binary chunks can use responseCode=60052 (and similar 60k codes).
        // Only treat classic 4xx/5xx-like codes as a hard error, and prefer tying it to
        // the request msgNum to avoid cross-talk from other in-flight attempts.
        const rc = frame.header.responseCode;
        const isHardError = rc >= 400 && rc < 60_000;
        if (isHardError && frame.header.msgNum === msgNum) {
          fail(
            new Error(
              `Baichuan FileInfoList replay rejected (cmdId=${cmdId} reqChannelId=${channelId} rspChannelId=${frame.header.channelId} streamType=${expectedStreamType} msgNum=${frame.header.msgNum} responseCode=${rc})`,
            ),
          );
          return;
        }

        try {
          let markedBinary = false;
          let encryptLen: number | undefined;
          if (frame.extension.length > 0) {
            try {
              const extDec = this.tryDecryptXml(
                frame.extension,
                frame.header.channelId,
                enc,
              );
              if (extDec.includes("<binaryData>1</binaryData>")) {
                markedBinary = true;
              }
              // Extract encryptLen if present - only first N bytes of payload are encrypted
              const encryptLenMatch = extDec.match(
                /<encryptLen>(\d+)<\/encryptLen>/i,
              );
              if (encryptLenMatch && encryptLenMatch[1]) {
                encryptLen = parseInt(encryptLenMatch[1], 10);
              }
            } catch {
              // ignore
            }
          }

          const decrypted = decryptBinaryForReplay(
            frame.payload,
            frame.header.channelId,
            encryptLen,
          );
          if (decrypted.length === 0) return;

          if (!markedBinary && looksLikeXml(decrypted)) return;

          if (streamMsgNum === undefined) {
            streamMsgNum = frame.header.msgNum;
            lockedChannelId = frame.header.channelId;
            lockedStreamType = frame.header.streamType;
          }

          chunks.push(decrypted);
          armIdleFinish();

          if (frame.header.responseCode === 201) {
            finish(Buffer.concat(chunks));
          }
        } catch (e) {
          fail(e);
        }
      };

      timeout = setTimeout(() => {
        if (chunks.length > 0) {
          finish(Buffer.concat(chunks));
          return;
        }
        fail(
          new Error(
            `Baichuan timeout waiting FileInfoList replay binary chunks cmdId=${cmdId} channelId=${channelId} streamType=${expectedStreamType}`,
          ),
        );
      }, timeoutMs);

      this.on("frame", onFrame);

      try {
        this.logDebug("tx", {
          cmdId,
          msgNum,
          channelId,
          messageClass,
          bodyLen,
          binary: true,
          fileInfoListReplay: true,
        });
        this.recordTx({
          cmdId,
          responseCode: 0,
          msgNum,
          channelId,
          streamType: expectedStreamType,
        });
        this.writeWire(wire);
      } catch (e) {
        fail(e);
      }
    });
  }

  private async sendBinarySnapshot109(params: {
    cmdId: number;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId =
      params.channelIdOverride ??
      (params.channel == null ? this.hostChannelId : channel + 1);

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    // For Snap (cmdId=109) the request uses only channelId (no <binaryData>1</binaryData>).
    // I chunk binari in risposta saranno marcati con <binaryData>1</binaryData> nella Extension.
    const extXml =
      params.extensionXml ??
      (params.channel != null ? buildChannelExtensionXml(channel) : "");
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: params.streamType ?? 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 15_000;
    const chunks: Buffer[] = [];
    let seenJpegStart = false;

    const indexOfJpegSoi = (buf: Buffer): number => {
      // JPEG SOI: FF D8
      for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] === 0xff && buf[i + 1] === 0xd8) return i;
      }
      return -1;
    };

    const endsWithJpegEoi = (buf: Buffer): boolean => {
      // JPEG EOI: FF D9
      for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] === 0xff && buf[i + 1] === 0xd9) return true;
      }
      return false;
    };

    return await new Promise<Buffer>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      let done = false;

      const cleanup = () => {
        this.off("frame", onFrame);
        if (timeout) clearTimeout(timeout);
      };

      const finish = (buf: Buffer) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(buf);
      };

      const fail = (e: unknown) => {
        if (done) return;
        done = true;
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onFrame = (frame: BaichuanFrame) => {
        if (frame.header.cmdId !== cmdId) return;

        // If the request itself was rejected, fail fast instead of timing out.
        // Some firmwares respond with an empty-body error for snapshot.
        if (
          frame.header.msgNum === msgNum &&
          frame.header.responseCode >= 400
        ) {
          fail(
            new Error(
              `Baichuan snapshot request rejected (cmdId=${cmdId} msgNum=${msgNum} responseCode=${frame.header.responseCode})`,
            ),
          );
          return;
        }

        try {
          // Snapshot flow:
          // - reply 1: XML body (no binaryData)
          // - reply 2..n: Extension has <binaryData>1</binaryData>, payload is binary chunks (responseCode 200/201)
          let isBinaryChunk = false;
          if (frame.extension.length > 0) {
            try {
              const extDec = this.tryDecryptXml(
                frame.extension,
                frame.header.channelId,
                enc,
              );
              if (extDec.includes("<binaryData>1</binaryData>")) {
                isBinaryChunk = true;
              }
            } catch {
              // PCAP: some firmwares send a non-XML (and not AES-decryptable) extension.
              // Treat as "not marked" and rely on payload heuristics.
            }
          }

          // If extension isn't present/parseable, fallback to heuristic: payload contains JPEG SOI.
          const decrypted = this.tryDecryptBinary(
            frame.payload,
            frame.header.channelId,
            enc,
          );
          if (decrypted.length === 0) return;

          const head = decrypted
            .subarray(0, Math.min(16, decrypted.length))
            .toString("utf8");
          const looksLikeXml =
            head.startsWith("<?xml") || head.trimStart().startsWith("<");
          if (!isBinaryChunk && looksLikeXml) return;

          let toAppend = decrypted;
          if (!seenJpegStart) {
            const soi = indexOfJpegSoi(decrypted);
            if (soi === -1) {
              // Not JPEG yet; ignore unless this is a declared binary chunk (could start mid-stream).
              if (!isBinaryChunk) return;
              // If it's a binary chunk but doesn't contain SOI, append as-is.
              toAppend = decrypted;
              chunks.push(toAppend);
              const combined = Buffer.concat(chunks);
              if (frame.header.responseCode === 201) finish(combined);
              return;
            }
            seenJpegStart = true;
            toAppend = decrypted.subarray(soi);
          }

          chunks.push(toAppend);
          const combined = Buffer.concat(chunks);

          // Prefer marker-based completion; some firmwares don't use responseCode 201 reliably.
          if (endsWithJpegEoi(combined) || frame.header.responseCode === 201) {
            // Trim to the first EOI if present.
            const eoiIdx = combined.indexOf(Buffer.from([0xff, 0xd9]));
            if (eoiIdx !== -1) {
              finish(combined.subarray(0, eoiIdx + 2));
              return;
            }
            finish(combined);
          }
        } catch (e) {
          fail(e);
        }
      };

      timeout = setTimeout(() => {
        fail(
          new Error(
            `Baichuan timeout waiting snapshot push cmdId=${cmdId} msgNum=${msgNum}`,
          ),
        );
      }, timeoutMs);

      // Attach listener BEFORE sending request to avoid missing the first chunk.
      // Use "frame" (not "push") so we also see frames that would otherwise be consumed by `pending`.
      this.on("frame", onFrame);

      try {
        this.logDebug("tx", {
          cmdId,
          msgNum,
          channelId,
          messageClass,
          bodyLen,
          binary: true,
          snapshot: true,
        });
        this.recordTx({
          cmdId,
          responseCode: 0,
          msgNum,
          channelId,
          streamType: params.streamType ?? 0,
        });
        this.writeWire(wire);
      } catch (e) {
        fail(e);
      }
    });
  }

  /**
   * Send CoverPreview command (cmd_id=298) to get an I-frame from a past recording.
   * Similar to sendBinarySnapshot109 but handles the stream header + frame format
   * instead of JPEG.
   */
  async sendBinaryCoverPreview(params: {
    cmdId: number;
    channel?: number;
    /** Override the header channelId (and encryption channelId) for this request. */
    channelIdOverride?: number;
    /** Override the header msgNum for this request (advanced). */
    msgNumOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
    /** Maximum retry attempts on 400 rejection (default: 5). PCAP analysis shows camera often rejects first few requests. */
    maxRetries?: number;
    /** Delay between retries in ms (default: 1000). */
    retryDelayMs?: number;
  }): Promise<Buffer> {
    return await this.withSerializedCoverPreview(async () => {
      const maxRetries = params.maxRetries ?? 5;
      const retryDelayMs = params.retryDelayMs ?? 1000;

      let lastError: Error | undefined;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await this._sendBinaryCoverPreviewOnce(params);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastError = e instanceof Error ? e : new Error(msg);

          // Check if it's a 400 rejection that might be recoverable with retry.
          const is400Rejection =
            msg.includes("rejected") &&
            (msg.includes("responseCode=400") || msg.includes("resp_code=400"));

          if (is400Rejection && attempt < maxRetries - 1) {
            this.logDebug("coverpreview_retry_400", {
              attempt: attempt + 1,
              maxRetries,
              retryDelayMs,
            });
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }

          throw lastError;
        }
      }

      throw lastError ?? new Error("CoverPreview failed after all retries");
    });
  }

  /**
   * Internal: single attempt for sendBinaryCoverPreview
   */
  private async _sendBinaryCoverPreviewOnce(params: {
    cmdId: number;
    channel?: number;
    channelIdOverride?: number;
    msgNumOverride?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;

    // For CoverPreview, PCAP analysis shows:
    // - channelId in header is a session counter (29,30,32...) - use nextMsgNum()
    // - msgNum in header is always 0
    // So we use the message counter for channelId, but fix msgNum to 0.
    const sessionCounter = this.nextMsgNum();
    const channelId = params.channelIdOverride ?? sessionCounter;
    const msgNum = params.msgNumOverride ?? 0; // PCAP shows msgNum is always 0 for CoverPreview

    const cmdId = params.cmdId;

    // PCAP: CoverPreview requests use empty extension (payloadOffset=0).
    const extXml = params.extensionXml ?? "";
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: params.streamType ?? 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 30_000;
    const chunks: Buffer[] = [];
    let seenStreamHeader = false;
    let streamMsgNum: number | undefined;
    let lockedChannelId: number | undefined;
    let lockedStreamType: number | undefined;
    let lastXmlReply: string | undefined;
    const supportedMagics = new Set(["1001", "1002"]);

    const expectedStreamType = params.streamType ?? 0;

    const looksLikeAnnexB = (buf: Buffer): boolean => {
      // Look for 0x000001 or 0x00000001 start codes early in the payload.
      const maxScan = Math.min(Math.max(buf.length - 4, 0), 64 * 1024);
      for (let i = 0; i < maxScan; i++) {
        if (buf[i] !== 0x00 || buf[i + 1] !== 0x00) continue;
        if (buf[i + 2] === 0x01) return true;
        if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) return true;
      }
      return false;
    };

    const decryptBinaryForCover = (
      payload: Buffer,
      frameChannelId: number,
      encryptLen?: number,
    ) => {
      // If encryptLen is provided, only decrypt the first encryptLen bytes
      // and keep the rest as-is. This is how Reolink partial encryption works.
      if (
        encryptLen !== undefined &&
        encryptLen > 0 &&
        encryptLen < payload.length
      ) {
        const encryptedPart = payload.subarray(0, encryptLen);
        const clearPart = payload.subarray(encryptLen);
        const decryptedPart = this.tryDecryptBinary(
          encryptedPart,
          frameChannelId,
          enc,
        );
        return Buffer.concat([decryptedPart, clearPart]);
      }

      // Helper to score how "BcMedia-like" a buffer is
      const scoreBcMediaLike = (b: Buffer): number => {
        if (b.length < 4) return -1;
        const maxScan = Math.min(64 * 1024, b.length - 4);
        let count = 0;
        let first = -1;
        for (let i = 0; i <= maxScan; i++) {
          const magic = b.readUInt32LE(i);
          const isInfoV1 = magic === 0x31303031;
          const isInfoV2 = magic === 0x32303031;
          const isIFrame = magic >= 0x63643030 && magic <= 0x63643039;
          const isPFrame = magic >= 0x63643130 && magic <= 0x63643139;
          const isAac = magic === 0x62773530;
          const isAdpcm = magic === 0x62773130;
          if (
            isInfoV1 ||
            isInfoV2 ||
            isIFrame ||
            isPFrame ||
            isAac ||
            isAdpcm
          ) {
            count++;
            if (first < 0) first = i;
            if (count > 32 && first === 0) break;
          }
        }
        return count * 1000 - (first < 0 ? 50000 : first);
      };

      // For BC XOR encryption, some firmwares appear to use an offset different from
      // the response header channelId. Try a small set of plausible offsets.
      if (enc.kind !== "bc") {
        // In AES/full_aes mode, video data may NOT be encrypted.
        // Compare raw vs decrypted and choose the one that looks more like BcMedia.
        const decrypted = this.tryDecryptBinary(payload, frameChannelId, enc);
        const rawScore = scoreBcMediaLike(payload);
        const decScore = scoreBcMediaLike(decrypted);
        return decScore > rawScore ? decrypted : payload;
      }

      const candidates = [frameChannelId, channelId, 250, 0, 1].filter(
        (n, i, a) => Number.isFinite(n) && a.indexOf(n) === i,
      );
      const decrypted = candidates.map((cid) =>
        this.tryDecryptBinary(payload, cid, enc),
      );
      for (const d of decrypted) {
        if (d.length >= 4) {
          const magic = d.subarray(0, 4).toString("ascii");
          if (supportedMagics.has(magic)) return d;
        }
      }
      return decrypted[0] ?? Buffer.alloc(0);
    };

    return await new Promise<Buffer>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      let done = false;

      const onClose = () => {
        fail(
          new Error(
            `Baichuan socket closed while waiting CoverPreview cmdId=${cmdId} msgNum=${msgNum}`,
          ),
        );
      };

      const cleanup = () => {
        this.off("frame", onFrame);
        this.off("close", onClose);
        if (timeout) clearTimeout(timeout);
      };

      const finish = (buf: Buffer) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(buf);
      };

      const fail = (e: unknown) => {
        if (done) return;
        done = true;
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onFrame = (frame: BaichuanFrame) => {
        // Accept responses with the same cmdId as the request,
        // OR with cmdId=138 (BC_CMD_ID_COVER_RESPONSE) which is used by standalone cameras
        // for cover data when requesting with cmdId 458-462.
        // Also accept cmdId=0 which is used as ACK in standalone protocol.
        const standaloneCoverCmds = new Set([458, 459, 460, 461, 462]);
        const isStandaloneCover = standaloneCoverCmds.has(cmdId);
        const acceptedCmdIds = isStandaloneCover
          ? new Set([cmdId, 138, 0]) // Standalone: request cmdId, data response (138), ACK (0)
          : new Set([cmdId]);

        if (!acceptedCmdIds.has(frame.header.cmdId)) {
          return;
        }

        if (
          lockedStreamType !== undefined &&
          frame.header.streamType !== lockedStreamType
        ) {
          return;
        }

        // Filter by request context (avoid mixing concurrent CoverPreview attempts).
        // Some NVR firmwares reply with a different channelId than the request.
        if (
          lockedChannelId !== undefined &&
          frame.header.channelId !== lockedChannelId
        ) {
          return;
        }

        // Once we lock onto a stream msgNum, ignore everything else.
        // NOTE: For standalone cameras using cmdId 458-462, the correlation is done
        // via response_code field (which contains the original request msgNum) instead
        // of the header msgNum field. So we check both.
        if (streamMsgNum !== undefined) {
          const matchesByMsgNum = frame.header.msgNum === streamMsgNum;
          const matchesByResponseCode =
            isStandaloneCover && frame.header.responseCode === streamMsgNum;
          if (!matchesByMsgNum && !matchesByResponseCode) {
            return;
          }
        }

        // If the request itself was rejected, fail fast.
        // For standalone protocol, check both msgNum and responseCode for correlation.
        // ext1=400 (0x190) in cmd_id=0 response seems to indicate rejection.
        const isRejected =
          (frame.header.responseCode >= 400 &&
            frame.header.msgNum === msgNum) ||
          (isStandaloneCover &&
            frame.header.cmdId === 0 &&
            frame.header.payloadOffset === 400 &&
            frame.header.responseCode === msgNum);

        if (isRejected) {
          fail(
            new Error(
              `Baichuan CoverPreview request rejected (cmdId=${cmdId} reqChannelId=${channelId} rspChannelId=${frame.header.channelId} reqStreamType=${expectedStreamType} rspStreamType=${frame.header.streamType} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} payloadOffset=${frame.header.payloadOffset})`,
            ),
          );
          return;
        }

        try {
          // CoverPreview flow:
          // - reply 1: XML body (no binaryData)
          // - reply 2..n: Extension has <binaryData>1</binaryData>, payload is binary chunks
          let isBinaryChunk = false;
          let encryptLen: number | undefined;
          if (frame.extension.length > 0) {
            const extDec = this.tryDecryptXml(
              frame.extension,
              frame.header.channelId,
              enc,
            );
            if (extDec.includes("<binaryData>1</binaryData>")) {
              isBinaryChunk = true;
            }
            // Extract encryptLen if present - only first N bytes of payload are encrypted
            const encryptLenMatch = extDec.match(
              /<encryptLen>(\d+)<\/encryptLen>/i,
            );
            if (encryptLenMatch && encryptLenMatch[1]) {
              encryptLen = parseInt(encryptLenMatch[1], 10);
            }
          }

          const decrypted = decryptBinaryForCover(
            frame.payload,
            frame.header.channelId,
            encryptLen,
          );

          // Check for end-of-stream marker BEFORE checking payload length,
          // since the end marker frame has bodyLen=0
          const isEndMarker =
            frame.header.responseCode === 201 ||
            frame.header.responseCode === 300;
          const isEndMarkerStandalone =
            isStandaloneCover &&
            frame.header.cmdId === 0 &&
            frame.header.payloadOffset === 300;

          if (isEndMarker || isEndMarkerStandalone) {
            const combined = Buffer.concat(chunks);
            finish(combined);
            return;
          }

          if (decrypted.length === 0) return;

          // Skip XML responses
          const head = decrypted
            .subarray(0, Math.min(16, decrypted.length))
            .toString("utf8");
          const looksLikeXml =
            head.startsWith("<?xml") || head.trimStart().startsWith("<");
          if (!isBinaryChunk && looksLikeXml) {
            // Keep the last XML reply for diagnostics (some firmwares ACK with XML and never send chunks).
            // Limit size to avoid huge errors.
            const asText = decrypted.toString("utf8");
            lastXmlReply =
              asText.length > 2000 ? `${asText.slice(0, 2000)}…` : asText;
            return;
          }

          // For CoverPreview, look for stream header magic "1001"/"1002".
          // Lock onto the msgNum that carries the stream header to avoid mixing
          // frames from other in-flight/previous attempts.
          // For standalone cameras (cmdId 458-462), the correlation is via response_code.
          if (!seenStreamHeader) {
            const streamMagic = decrypted.subarray(0, 4).toString("ascii");
            if (supportedMagics.has(streamMagic)) {
              lockedChannelId = frame.header.channelId;
              lockedStreamType = frame.header.streamType;
              // For standalone protocol, lock on response_code instead of msgNum
              streamMsgNum = isStandaloneCover
                ? frame.header.responseCode
                : frame.header.msgNum;
              seenStreamHeader = true;
              chunks.push(decrypted);
            } else if (looksLikeAnnexB(decrypted)) {
              // Some firmwares appear to send a raw Annex-B payload without a 1001/1002 stream header.
              // Treat the first Annex-B chunk as the start of the stream.
              lockedChannelId = frame.header.channelId;
              lockedStreamType = frame.header.streamType;
              streamMsgNum = isStandaloneCover
                ? frame.header.responseCode
                : frame.header.msgNum;
              seenStreamHeader = true;
              chunks.push(decrypted);
            }
          } else {
            chunks.push(decrypted);
          }
        } catch (e) {
          fail(e);
        }
      };

      timeout = setTimeout(() => {
        // If we have data, return what we have instead of failing
        if (chunks.length > 0) {
          const combined = Buffer.concat(chunks);
          finish(combined);
        } else {
          const extra = lastXmlReply
            ? `; lastXmlReply=${JSON.stringify(lastXmlReply)}`
            : "; lastXmlReply=(none)";
          fail(
            new Error(
              `Baichuan timeout waiting CoverPreview push cmdId=${cmdId} msgNum=${msgNum}${extra}`,
            ),
          );
        }
      }, timeoutMs);

      // Attach listener BEFORE sending request
      this.on("frame", onFrame);
      this.on("close", onClose);

      try {
        this.logDebug("tx", {
          cmdId,
          msgNum,
          channelId,
          messageClass,
          bodyLen,
          binary: true,
          coverPreview: true,
        });
        this.recordTx({
          cmdId,
          responseCode: 0,
          msgNum,
          channelId,
          streamType: params.streamType ?? 0,
        });
        this.writeWire(wire);
      } catch (e) {
        fail(e);
      }
    });
  }

  /**
   * Decrypts binary data (similar to tryDecryptXml but for binary responses).
   * Public method to allow ReolinkBaichuanApi to decrypt audio frames.
   */
  tryDecryptBinary(
    buf: Buffer,
    channelId: number,
    preferred: EncryptionProtocol,
  ): Buffer {
    if (buf.length === 0) return buf;

    const tryAs = (enc: EncryptionProtocol): Buffer | null => {
      try {
        if (enc.kind === "none") return buf;
        if (enc.kind === "bc") {
          return bcDecrypt(buf, channelId);
        }
        if (enc.kind === "aes" || enc.kind === "full_aes") {
          return aesDecrypt(buf, enc.key);
        }
        return null;
      } catch {
        return null;
      }
    };

    // Try preferred encryption first, then fallback to current encryption, then BC, then none
    return (
      tryAs(preferred) ??
      (preferred.kind !== "bc" &&
      this.enc.kind !== "none" &&
      (this.enc.kind === "aes" || this.enc.kind === "full_aes")
        ? tryAs(this.enc)
        : null) ??
      (preferred.kind !== "bc" ? tryAs({ kind: "bc" }) : null) ??
      tryAs({ kind: "none" }) ??
      buf // Return as-is if decryption fails
    );
  }

  /**
   * Login flow: legacy "upgrade" -> receive nonce/encryption -> modern login.
   */
  async login(maxEncryption: MaxEncryption = "full_aes"): Promise<void> {
    if (this.loggedIn) return;

    const maxAttempts = 3;
    let lastError: unknown;

    // Some NVR/HomeHub firmwares are picky about encryption negotiation.
    // If the nonce/encryption negotiation fails (socket close / timeout), automatically
    // downgrade the requested encryption to keep the connection stable.
    let effectiveMaxEncryption: MaxEncryption = maxEncryption;
    let effectiveHostChannelId = this.hostChannelId;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // 1) legacy header-only login upgrade to obtain nonce + encryption type

        // 1) legacy header-only login upgrade to obtain nonce + encryption type
        // Encryption negotiation request byte (0xDC??):
        // - 0xDC00: none
        // - 0xDC01: bc
        // - 0xDC02: aes
        // - 0xDC12: full_aes
        // Some firmwares will reset the socket if you request an unsupported mode.
        const encByte =
          effectiveMaxEncryption === "none"
            ? 0xdc00
            : effectiveMaxEncryption === "bc"
              ? 0xdc01
              : effectiveMaxEncryption === "aes"
                ? 0xdc02
                : /* full_aes */ 0xdc12;

        await this.connect();
        // legacy login is supported on both transports

        const msgNum = this.nextMsgNum();
        const cmdId = 1;
        const channelId = effectiveHostChannelId;

        const header = encodeHeader({
          cmdId,
          bodyLen: 0,
          channelId,
          streamType: 0,
          msgNum,
          responseCode: encByte,
          messageClass: BC_CLASS_LEGACY,
        });
        const pendingKey: PendingKey = `${cmdId}:${msgNum}`;

        const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
          const t = setTimeout(() => {
            this.pending.delete(pendingKey);
            reject(new Error("Baichuan timeout waiting for nonce"));
          }, 10_000);
          this.pending.set(pendingKey, {
            resolve: (f) => {
              clearTimeout(t);
              resolve(f);
            },
            reject: (e) => {
              clearTimeout(t);
              reject(e);
            },
          });
        });

        // CRITICAL: Add catch handler IMMEDIATELY after promise creation, BEFORE writeWire
        // This must happen synchronously, before any operations that might cause socket to close
        // This prevents unhandled rejections when socket closes during writeWire
        framePromise.catch(() => {
          // Silently handle rejections from socket closures
          // The caller will handle the error when they await the promise
        });

        this.writeWire(header); // header-only
        const nonceFrame = await framePromise;

        // This reply contains <Encryption><nonce>...</nonce></Encryption> and response_code 0xDD??
        const resp = nonceFrame.header.responseCode;
        if (resp >>> 8 !== 0xdd)
          throw new Error(
            `Baichuan login: expected encryption info (0xDDxx), got 0x${resp.toString(16)}`,
          );
        const encType = resp & 0xff;

        // During negotiation the payload is at most BCEncrypt (even if AES is supported).
        const nonceXml = this.tryDecryptXml(
          nonceFrame.body,
          nonceFrame.header.channelId,
          encType === 0x00 ? { kind: "none" } : { kind: "bc" },
        );
        const nonce = getXmlText(nonceXml, "nonce");
        if (!nonce) throw new Error("Baichuan login: nonce not found in XML");
        this.nonce = nonce;

        // set encryption mode for post-login traffic
        if (encType === 0x00) this.enc = { kind: "none" };
        else if (encType === 0x01) this.enc = { kind: "bc" };
        else if (encType === 0x02)
          this.enc = {
            kind: "aes",
            key: deriveAesKey(nonce, this.opts.password),
          };
        else if (encType === 0x12)
          this.enc = {
            kind: "full_aes",
            key: deriveAesKey(nonce, this.opts.password),
          };
        else
          throw new Error(
            `Baichuan login: unknown encType=0x${encType.toString(16)}`,
          );

        // 2) modern login with username/password hashes
        const userHash = md5StrModern(`${this.opts.username}${nonce}`);
        const passHash = md5StrModern(`${this.opts.password}${nonce}`);
        const loginXml = buildLoginXml(userHash, passHash);

        this.logDebug("login_hash", {
          username: this.opts.username,
          nonce,
          userHash,
          passHashLength: passHash.length,
          loginXmlLength: loginXml.length,
          loginXmlPreview: loginXml.substring(0, 200),
        });

        // For login, explicitly use channelId 250 (host) and no extension XML
        // This ensures correct BCEncrypt channelId offset for firmwares that depend on it.
        // Use sendFrame directly (not sendXml from ReolinkBaichuanApi) to avoid recursion
        // since sendXml might call login() which would cause infinite recursion
        // Don't pass channel to use host channelId (device-specific: 250 or 0)
        // For the login message itself, some firmwares expect BCEncrypt even if AES is supported.
        // However if negotiation says "none" (0xDD00), sending BC-encrypted login will fail.
        const loginEnc: EncryptionProtocol =
          encType === 0x00 ? { kind: "none" } : { kind: "bc" };

        const replyFrame = await this.sendFrame({
          cmdId: 1,
          payloadXml: loginXml,
          extensionXml: "",
          messageClass: BC_CLASS_MODERN_24,
          channelIdOverride: effectiveHostChannelId,
          encryption: loginEnc,
          timeoutMs: 10_000,
        });

        const replyXml = this.tryDecryptXml(
          replyFrame.body,
          replyFrame.header.channelId,
          loginEnc,
        );

        // If login succeeded, camera replies with 200 in responseCode on modern frames.
        // responseCode 400 typically means authentication failed (bad credentials)
        // responseCode 200 means success
        this.logDebug("login_reply", {
          replyLength: replyXml.length,
          replyPreview: replyXml.substring(0, 200),
          startsWithXml: replyXml.startsWith("<?xml"),
        });

        // Check if reply is empty.
        // This is commonly seen on sleeping/waking battery cameras, but can also indicate bad credentials.
        if (replyXml.length === 0) {
          throw new Error(
            "Baichuan login failed: empty reply (camera may be sleeping/waking, session may be stale, or username/password may be invalid)",
          );
        }

        if (!replyXml.startsWith("<?xml")) {
          const preview =
            replyXml.length > 0 ? replyXml.substring(0, 100) : "(empty)";
          throw new Error(
            `Baichuan login: unexpected non-XML reply (length: ${replyXml.length}, preview: ${preview})`,
          );
        }

        this.loggedIn = true;
        // Persist the host channelId variant that worked, so future host-scoped commands use it.
        this.hostChannelId = effectiveHostChannelId;
        return;
      } catch (e) {
        lastError = e;
        this.loggedIn = false;

        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as any).message)
            : String(e);
        const isNetworkUnreachable =
          msg.includes("EHOSTUNREACH") || msg.includes("ENETUNREACH");
        const looksLikeNegotiationFailure =
          msg.includes("timeout waiting for nonce") ||
          msg.includes("expected encryption info") ||
          msg.includes("Baichuan socket closed") ||
          msg.includes("ECONNRESET") ||
          msg.includes("EPIPE");

        // Some NVR/HomeHub firmwares expect host channelId=0 (PCAP-observed). If negotiation fails,
        // automatically try the alternate host channelId on the next attempt.
        if (looksLikeNegotiationFailure && effectiveHostChannelId === 250) {
          effectiveHostChannelId = 0;
        }

        // If negotiation is failing, try a less aggressive encryption mode on next attempt.
        // Prefer stepping down full_aes -> aes -> bc -> none.
        if (looksLikeNegotiationFailure) {
          if (effectiveMaxEncryption === "full_aes") {
            effectiveMaxEncryption = "aes";
          } else if (effectiveMaxEncryption === "aes") {
            effectiveMaxEncryption = "bc";
          } else if (effectiveMaxEncryption === "bc") {
            effectiveMaxEncryption = "none";
          }
        }
        try {
          await this.close({
            reason: isNetworkUnreachable
              ? "tcp_unreachable"
              : looksLikeNegotiationFailure
                ? "login_negotiation_failed"
                : "login_failed",
          });
        } catch {
          // ignore
        }

        // If we can't route to the host, retrying encryption negotiation won't help.
        // Fail fast so callers like autodetect can fallback to UDP/relay quickly.
        if (isNetworkUnreachable) {
          throw e;
        }

        if (attempt < maxAttempts) {
          // Backoff: give the camera time to wake up.
          await sleep(1500);
          continue;
        }
        throw e;
      }
    }

    // Should be unreachable.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
