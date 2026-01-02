import { EventEmitter } from "node:events";
import net from "node:net";
import {
  BC_TCP_DEFAULT_PORT,
  BC_CLASS_LEGACY,
  BC_CLASS_MODERN_24,
  BC_CLASS_MODERN_24_ALT,
  BC_CMD_ID_UDP_KEEP_ALIVE,
  BC_CMD_ID_PING,
  BC_CMD_ID_GET_BATTERY_INFO,
  BC_CMD_ID_TALK_ABILITY,
  BC_CMD_ID_TALK_RESET,
  BC_CMD_ID_TALK_CONFIG,
  BC_CMD_ID_TALK,
} from "../protocol/constants";
import { aesDecrypt, aesEncrypt, bcDecrypt, bcEncrypt, deriveAesKey, md5StrModern, type EncryptionProtocol } from "../protocol/crypto";
import { BaichuanFrameParser, encodeHeader, type BaichuanFrame } from "../protocol/framing";
import { buildBinaryExtensionXml, buildChannelExtensionXml, buildLoginXml, getXmlText } from "../protocol/xml";
import { BcUdpStream } from "../bcudp/BcUdpStream";
import type { ReolinkEvent, SleepStatus } from "../reolink/baichuan/types";
import { eventTraceLog, normalizeDebugOptions, traceLog, talkTraceLog, type DebugOptions, type DebugConfig, type Logger } from "../debug/DebugConfig";
export type { Logger };

function isTalkCmd(cmdId: number): boolean {
  return cmdId === BC_CMD_ID_TALK_ABILITY || cmdId === BC_CMD_ID_TALK_RESET || cmdId === BC_CMD_ID_TALK_CONFIG || cmdId === BC_CMD_ID_TALK;
}

export type BaichuanClientOptions = {
  host: string;
  port?: number;
  username: string;
  password: string;
  /** UID used for BCUDP discovery (typical for battery cameras). Required for `transport: "udp"` and UDP fallback in `auto`. */
  uid?: string;
  /**
   * For NVR: logical channel index (0-based).
   * For standalone cameras: usually 0.
   */
  channel?: number;
  /** If true, emits additional debug events. */
  debug?: boolean;
  /** Structured debug/tracing/dump options (preferred over env-based toggles). */
  debugOptions?: DebugOptions;
  /** Logger instance (e.g. console). If provided, debug logs will be sent here. */
  logger?: Logger;
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
}> {
  private readonly opts: BaichuanClientOptions;
  private readonly debugCfg: DebugConfig;
  private readonly logger: Logger;

  private tcpSocket: net.Socket | undefined;
  private udpSocket: BcUdpStream | undefined;
  private transport: "tcp" | "udp" = "tcp";
  private readonly parser = new BaichuanFrameParser();
  private readonly pending = new Map<PendingKey, { resolve: (f: BaichuanFrame) => void; reject: (e: Error) => void }>();
  private socketClosed = false;

  private msgNum = 0;
  loggedIn = false; // Public to allow ReolinkBaichuanApi to check login status
  subscribed = false; // Public to allow ReolinkBaichuanApi to check subscription status

  private keepAliveTimer: NodeJS.Timeout | undefined;
  private keepAlivePingInFlight = false;

  private lastD2cDiscAtMs: number | undefined;

  private sleepProbeTimer: NodeJS.Timeout | undefined;
  private sleepProbeInFlight = false;
  private lastSleepProbe:
    | {
        atMs: number;
        status: SleepStatus;
        cmdId: number;
        channel: number;
        xml?: string;
      }
    | undefined;

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

  // Ring-buffer of the last received frames (metadata only). Used for sleep inference heuristics.
  private readonly rxHistory: Array<{
    atMs: number;
    cmdId: number;
    responseCode: number;
    msgNum: number;
    channelId: number;
    streamType: number;
  }> = [];

  enc: EncryptionProtocol = { kind: "none" }; // Public to allow ReolinkBaichuanApi to access for audio decryption
  private nonce?: string;
  
  // Video stream subscriptions: map of cmdId -> Set of msgNum that are subscribed
  // Similar to neolink's connection.subscribe(MSG_ID_VIDEO, msg_num)
  private videoSubscriptions = new Map<number, Set<number>>();

  // Throttled per-stream frame tracing (rx cmd_id=3 stream frames can be extremely chatty).
  private streamTraceStats = new Map<number, { lastLogMs: number; frames: number }>();

  constructor(options: BaichuanClientOptions) {
    super();
    this.opts = options;
    this.logger = options.logger ?? console;
    // Back-compat: `debug: true` enables generic debug logs.
    this.debugCfg = normalizeDebugOptions({ ...(options.debug ? { enabled: true } : {}), ...(options.debugOptions ?? {}) });
  }

  private logDebug(event: string, data?: unknown): void {
    if (this.opts.debug) {
      this.logger.debug(`[BaichuanClient] ${event}`, data);
      this.emit("debug", event, data);
    }
  }

  getTransport(): "tcp" | "udp" {
    return this.transport;
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

  /** Latest active sleep probe result (if any). Intended for battery/BCUDP only. */
  getLastSleepProbe(opts?: { maxAgeMs?: number }):
    | {
        atMs: number;
        status: SleepStatus;
        cmdId: number;
        channel: number;
        xml?: string;
      }
    | undefined {
    const p = this.lastSleepProbe;
    if (!p) return undefined;
    const maxAgeMs = opts?.maxAgeMs;
    if (maxAgeMs != null && Date.now() - p.atMs > maxAgeMs) return undefined;
    return p;
  }

  /**
   * True when recent inbound traffic is only UDP keepalive (cmd_id=234).
   * This is used as a heuristic for "low traffic" windows where doing a single probe is less disruptive.
   */
  isAckOnlyLowTraffic(opts?: { windowMs?: number; requireRx?: boolean }): boolean {
    if (this.transport !== "udp") return false;
    const windowMs = opts?.windowMs ?? 3000;
    const since = Date.now() - windowMs;
    const recent = this.rxHistory.filter((h) => h.atMs >= since);
    if (opts?.requireRx ?? true) {
      if (recent.length === 0) return false;
    }
    for (const h of recent) {
      // Treat keepalive + battery info frames as "low traffic".
      // Battery info does not reliably indicate the camera is awake.
      if (h.cmdId !== BC_CMD_ID_UDP_KEEP_ALIVE && h.cmdId !== 252 && h.cmdId !== 253) return false;
    }
    return true;
  }

  /**
   * Single active sleep probe with short timeout.
   * - On response: awake (and caches decrypted XML if present)
   * - On timeout: sleeping
   * - On other errors: unknown
   */
  async probeSleepStatusOnce(opts?: { channel?: number; timeoutMs?: number; cmdId?: number }): Promise<SleepStatus> {
    if (this.transport !== "udp") {
      const status: SleepStatus = { state: "unknown", reason: "sleep probe supported only for UDP/battery" };
      this.lastSleepProbe = { atMs: Date.now(), status, cmdId: opts?.cmdId ?? BC_CMD_ID_GET_BATTERY_INFO, channel: opts?.channel ?? 0 };
      return status;
    }

    // Avoid implicitly forcing a reconnect/login as part of a "sleep check".
    if (!this.isSocketConnected()) {
      const status: SleepStatus = { state: "unknown", reason: "udp socket not connected" };
      this.lastSleepProbe = { atMs: Date.now(), status, cmdId: opts?.cmdId ?? BC_CMD_ID_GET_BATTERY_INFO, channel: opts?.channel ?? 0 };
      return status;
    }
    if (!this.loggedIn) {
      const status: SleepStatus = { state: "unknown", reason: "not logged in" };
      this.lastSleepProbe = { atMs: Date.now(), status, cmdId: opts?.cmdId ?? BC_CMD_ID_GET_BATTERY_INFO, channel: opts?.channel ?? 0 };
      return status;
    }

    if (this.sleepProbeInFlight) {
      return this.lastSleepProbe?.status ?? { state: "unknown", reason: "sleep probe in-flight" };
    }

    this.sleepProbeInFlight = true;
    try {
      const channel = opts?.channel ?? this.opts.channel ?? 0;
      const cmdId = opts?.cmdId ?? BC_CMD_ID_GET_BATTERY_INFO;
      const timeoutMs = opts?.timeoutMs ?? 700;

      const frame = await this.sendFrame({ cmdId, channel, timeoutMs });
      const status: SleepStatus = {
        state: frame.header.responseCode === 200 ? "awake" : "unknown",
        reason: `probe cmdId=${cmdId} responseCode=${frame.header.responseCode}`,
      };

      const atMs = Date.now();
      if (frame.body.length > 0) {
        const xml = this.tryDecryptXml(frame.body, frame.header.channelId, this.enc);
        this.lastSleepProbe = { atMs, status, cmdId, channel, xml };
      } else {
        this.lastSleepProbe = { atMs, status, cmdId, channel };
      }

      return status;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes("Baichuan timeout") || msg.toLowerCase().includes("timeout");
      const cmdId = opts?.cmdId ?? BC_CMD_ID_GET_BATTERY_INFO;
      const channel = opts?.channel ?? this.opts.channel ?? 0;
      const timeoutMs = opts?.timeoutMs ?? 700;
      const status: SleepStatus = isTimeout
        ? { state: "sleeping", reason: `probe timeout cmdId=${cmdId} timeoutMs=${timeoutMs}` }
        : { state: "unknown", reason: `probe error cmdId=${cmdId}: ${msg}` };
      this.lastSleepProbe = { atMs: Date.now(), status, cmdId, channel };
      return status;
    } finally {
      this.sleepProbeInFlight = false;
    }
  }

  /** Timestamp (ms) of the last received Baichuan frame, if any. */
  getLastRxAtMs(): number | undefined {
    return this.lastRxAtMs;
  }

  /** Timestamp (ms) when the camera sent BCUDP disconnect (D2C_DISC), if observed. */
  getLastD2cDiscAtMs(): number | undefined {
    return this.lastD2cDiscAtMs;
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

  /**
   * Best-effort sleep heuristic for battery/BCUDP cameras.
   *
   * This does NOT send any request to the camera.
   * If there has been no inbound traffic for `idleMs`, the camera is *likely* sleeping
   * (or the network path is down).
   */
  isProbablySleeping(idleMs = 15_000): boolean {
    if (this.transport !== "udp") return false;
    const last = this.lastRxAtMs;
    if (last == null) return false;
    return Date.now() - last >= idleMs;
  }

  getDebugConfig(): DebugConfig {
    return this.debugCfg;
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
      return this.udpSocket !== undefined && this.udpSocket.isConnected();
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
    // - UDP/BCUDP: neolink-style dynamic keepalive.
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

    // Neolink-style default: do NOT send periodic keepalive just because we're subscribed.
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

    this.logDebug("udp_keepalive_ping_tx", { msgNum, channelId: 0, streamType: 0 });
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
      await this.connectUdp();
      return;
    }
    // auto: try TCP first, then fallback to UDP (like neolink)
    try {
      // Neolink uses a timeout for TCP discovery (TCP_WAIT = 4 seconds)
      // We use Promise.race to timeout TCP connection attempt
      await Promise.race([
        this.connectTcp(),
        new Promise<void>((_, reject) => 
          setTimeout(() => reject(new Error("TCP connection timeout (falling back to UDP)")), 4000)
        )
      ]);
    } catch (e) {
      this.logDebug("auto:tcp_failed", e);
      // Fallback to UDP discovery (like neolink "local discovery")
      // Requires UID.
      if (!this.opts.uid) {
        throw new Error("TCP connection failed and UDP fallback requires `options.uid` (BCUDP discovery UID).");
      }
      await this.connectUdp();
    }
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
    sock.on("close", () => {
      this.stopKeepAlive();
      this.stopSleepProbeScheduler();
      this.socketClosed = true;
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
    sock.on("error", (err) => this.emit("error", err));

    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", (e) => reject(e));
    });

    this.startKeepAlive();
  }

  private async connectUdp(): Promise<void> {
    if (this.udpSocket) {
      // If the camera terminated the session (e.g. D2C_DISC), BcUdpStream closes its internal socket
      // but this.udpSocket reference may still be set. Treat that as disconnected and rebuild.
      if (this.udpSocket.isConnected()) {
        this.transport = "udp";
        return;
      }
      this.udpSocket = undefined;
      this.loggedIn = false;
      this.subscribed = false;
    }
    if (!this.opts.uid) {
      throw new Error("Baichuan UDP requested but `options.uid` is not set (required for BCUDP discovery).");
    }
    const sock = new BcUdpStream({ mode: "uid", uid: this.opts.uid });
    this.udpSocket = sock;
    this.transport = "udp";
    this.socketClosed = false;

    sock.on("data", (chunk) => {
      const frames = this.parser.push(chunk);
      for (const f of frames) this.handleFrame(f);
    });
    sock.on("close", () => {
      this.stopKeepAlive();
      this.stopSleepProbeScheduler();
      this.socketClosed = true;
      // Mark BCUDP socket as disconnected, so the next operation will reconnect.
      if (this.udpSocket === sock) this.udpSocket = undefined;
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
            p.reject(new Error("Baichuan UDP stream closed"));
          } catch (e) {
            // Ignore errors from rejecting promises (they may already be handled)
          }
        });
      }
    });
    sock.on("error", (err) => {
      if (err?.message?.includes("D2C_DISC")) {
        this.lastD2cDiscAtMs = Date.now();
        // Treat as a strong signal that the camera intentionally closed the session.
        // Also store a sleeping probe result for consumers that prefer cached probe state.
        this.lastSleepProbe = {
          atMs: this.lastD2cDiscAtMs,
          status: { state: "sleeping", reason: "bcudp disconnect by camera (D2C_DISC)" },
          cmdId: BC_CMD_ID_GET_BATTERY_INFO,
          channel: this.opts.channel ?? 0,
        };
      }
      this.emit("error", err);
    });
    
    // Forward BcUdpStream debug events
    sock.on("debug", (event: string, data?: unknown) => {
      this.logDebug(`udp_${event}`, data);
    });

    await sock.connect();
    this.startKeepAlive();
    this.startSleepProbeScheduler();
  }

  async close(): Promise<void> {
    this.stopKeepAlive();
    this.stopSleepProbeScheduler();
    const tcp = this.tcpSocket;
    this.tcpSocket = undefined;
    if (tcp) {
      await new Promise<void>((resolve) => {
        tcp.once("close", () => resolve());
        tcp.destroy();
      });
    }
    const udp = this.udpSocket;
    this.udpSocket = undefined;
    if (udp) await udp.close();
  }

  private startSleepProbeScheduler(): void {
    if (this.sleepProbeTimer) return;
    if (this.transport !== "udp") return;
    if (!this.isSocketConnected()) return;
    if (!this.loggedIn) return;

    this.sleepProbeTimer = setInterval(() => {
      if (this.transport !== "udp") return;
      if (!this.isSocketConnected()) return;
      if (!this.loggedIn) return;
      if (this.hasActiveVideoSubscriptionsInternal()) return;
      if (this.pending.size > 0) return;
      if (!this.isAckOnlyLowTraffic({ windowMs: 3000, requireRx: true })) return;

      const minIntervalMs = 5000;
      const lastAt = this.lastSleepProbe?.atMs;
      if (lastAt != null && Date.now() - lastAt < minIntervalMs) return;

      void this.probeSleepStatusOnce({ timeoutMs: 700, cmdId: BC_CMD_ID_GET_BATTERY_INFO });
    }, 1000);
    this.sleepProbeTimer.unref?.();
  }

  private stopSleepProbeScheduler(): void {
    if (!this.sleepProbeTimer) return;
    clearInterval(this.sleepProbeTimer);
    this.sleepProbeTimer = undefined;
    this.sleepProbeInFlight = false;
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

    // Battery cameras (BCUDP) expect the client to respond to UDP keep-alive frames.
    // Neolink handles this by replying with response_code=200 using the same msg_num/channel_id/stream_type.
    // If we don't, the camera can stop sending stream data after a couple seconds.
    if (this.transport === "udp" && frame.header.cmdId === BC_CMD_ID_UDP_KEEP_ALIVE) {
      // Only respond to requests (responseCode typically 0). If we ever see a 200 here, it's already a response.
      if (frame.header.responseCode !== 200) {
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

          this.logDebug("udp_keepalive_rx", { msgNum: frame.header.msgNum, channelId: frame.header.channelId, streamType: frame.header.streamType });
          this.writeWire(header);
          this.logDebug("udp_keepalive_tx", { msgNum: frame.header.msgNum, channelId: frame.header.channelId, streamType: frame.header.streamType });
        } catch (e) {
          // Keepalive failures shouldn't crash the client; log when debug is enabled.
          this.logDebug("udp_keepalive_error", e);
        }
        // We handled the request, so we're done with this frame.
        return;
      }
      // If responseCode === 200, it's a response to OUR ping. Fall through to pending resolution.
    }

    if (this.debugCfg.traceTalk && isTalkCmd(frame.header.cmdId)) {
      talkTraceLog(
        this.debugCfg, this.logger,
        "BaichuanTalk",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`
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
    // Similar to neolink's subscribe mechanism: frames with matching cmdId and msgNum
    const subscribedMsgNums = this.videoSubscriptions.get(frame.header.cmdId);
    if (subscribedMsgNums && subscribedMsgNums.size > 0) {
      // If there are active subscriptions for this cmdId (typically MSG_ID_VIDEO=3),
      // emit only frames that match msgNum. This prevents mixing old/parallel streams.
      if (subscribedMsgNums.has(frame.header.msgNum)) {
        if (this.debugCfg.traceStream && frame.header.cmdId === 3) {
          const now = Date.now();
          const key = frame.header.msgNum;
          const s = this.streamTraceStats.get(key) ?? { lastLogMs: now, frames: 0 };
          s.frames++;

          // Throttle per-frame logs to keep BCUDP ACK/keepalive responsive.
          if (now - s.lastLogMs >= 500) {
            traceLog(
              this.debugCfg,
              this.logger,
              "BaichuanTrace",
              `rx stream frames cmdId=3 msgNum=${frame.header.msgNum} frames=${s.frames} lastChannelId=${frame.header.channelId} lastBodyLen=${frame.body.length} lastPayloadLen=${frame.payload.length} lastPayloadOffset=${frame.header.payloadOffset ?? 0}`
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

    // No subscription: behave as before (generic push)
    this.emit("push", frame);

    // Parse events (cmd_id 33 = AlarmEventList push)
    if (frame.header.cmdId === 33) {
      try {
        const events = this.parseEvents(frame);
        for (const event of events) {
          eventTraceLog(
            this.debugCfg,
            this.logger,
            "BaichuanEvent",
            `dispatch cmdId=33 msgNum=${frame.header.msgNum} channelId=${frame.header.channelId} type=${event.type} eventChannel=${event.channel}` +
              (event.type === "ai" ? ` aiType=${(event.ai as any)?.type ?? "unknown"} detected=${(event.ai as any)?.detected ?? ""}` : "") +
              (event.type === "motion" ? ` source=${(event.motion as any)?.source ?? ""}` : "")
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
   * Similar to neolink's connection.subscribe(MSG_ID_VIDEO, msg_num).
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
  }

  /**
   * Parses event frame (cmd_id 33) into one or more ReolinkEvent.
   * Primary format (neolink): <AlarmEventList><AlarmEvent>...</AlarmEvent>...</AlarmEventList>
   * Fallback format (seen on some firmwares): <Event>...</Event>
   */
  private parseEvents(frame: BaichuanFrame): ReolinkEvent[] {
    const body = frame.body;
    if (body.length === 0) return [];

    const xml = this.tryDecryptXml(body, frame.header.channelId, this.enc);
    if (!xml || !xml.startsWith("<?xml")) return [];

    // Default channel from frame header (channelId 250 = host, 1+ = channels)
    const fallbackChannelId = frame.header.channelId;
    const fallbackChannel = fallbackChannelId === 250 ? 0 : Math.max(0, fallbackChannelId - 1);

    const now = Date.now();

    // 1) Neolink format: AlarmEventList
    if (xml.includes("<AlarmEventList")) {
      const out: ReolinkEvent[] = [];
      const alarmEventMatches = xml.matchAll(/<AlarmEvent\b[^>]*>([\s\S]*?)<\/AlarmEvent>/g);
      for (const match of alarmEventMatches) {
        const alarmXml = match[1] ?? "";
        const channelText = getXmlText(alarmXml, "channelId");
        const channel = channelText !== undefined ? Number(channelText) : fallbackChannel;
        const status = (getXmlText(alarmXml, "status") ?? "").trim();
        const statusUpper = status.toUpperCase();

        // Some firmwares may attach AI type in different tag names.
        const aiTypeRaw = (getXmlText(alarmXml, "AItype") ?? getXmlText(alarmXml, "aiType") ?? getXmlText(alarmXml, "aitype") ?? "").trim();

        // Unlike older implementations, a single AlarmEvent may encode multiple independent states
        // (e.g. motion + ai + visitor). Emit all applicable events.

        // Motion (MD) OR PIR should both map to motion for consumers like Scrypted.
        if (statusUpper.includes("MD")) {
          out.push({
            channel,
            type: "motion",
            motion: { channel, state: true, timestamp: now, source: "md" },
            timestamp: now,
          });
        }

        if (statusUpper.includes("PIR")) {
          out.push({
            channel,
            type: "motion",
            motion: { channel, state: true, timestamp: now, source: "pir" },
            timestamp: now,
          });
        }

        const aiTypeToken = aiTypeRaw
          ? aiTypeRaw
              .split(",")
              .map((t) => t.trim())
              .find((t) => t.length > 0 && t.toLowerCase() !== "none")
          : undefined;
        if (aiTypeToken) {
          const aiTypeMap: Record<string, "people" | "vehicle" | "dog_cat" | "face" | "package" | "other"> = {
            people: "people",
            vehicle: "vehicle",
            dog_cat: "dog_cat",
            face: "face",
            package: "package",
          };
          out.push({
            channel,
            type: "ai",
            ai: {
              channel,
              type: aiTypeMap[aiTypeToken.toLowerCase()] ?? "other",
              detected: true,
              timestamp: now,
            },
            timestamp: now,
          });
        } else if (statusUpper.includes("AI")) {
          // Some firmwares signal AI without an explicit AItype.
          out.push({
            channel,
            type: "ai",
            ai: { channel, type: "other", detected: true, timestamp: now },
            timestamp: now,
          });
        }

        // Doorbell/visitor notification.
        if (statusUpper.includes("VIS")) {
          out.push({ channel, type: "visitor", timestamp: now });
        }

        if (statusUpper.includes("DN")) {
          out.push({ channel, type: "daynight", timestamp: now });
        }
      }
      return out;
    }

    // 2) Fallback format: <Event>
    const eventMatch = xml.match(/<Event\b[^>]*>([\s\S]*?)<\/Event>/);
    if (!eventMatch) return [];

    const eventXml = eventMatch[1] ?? "";
    const status = (getXmlText(eventXml, "status") ?? "").trim();
    const statusUpper = status.toUpperCase();
    const aiTypeRaw = (getXmlText(eventXml, "AItype") ?? getXmlText(eventXml, "aiType") ?? getXmlText(eventXml, "aitype") ?? "").trim();

    const out: ReolinkEvent[] = [];

    if (statusUpper.includes("MD")) {
      out.push({
        channel: fallbackChannel,
        type: "motion",
        motion: { channel: fallbackChannel, state: true, timestamp: now, source: "md" },
        timestamp: now,
      });
    }

    if (statusUpper.includes("PIR")) {
      out.push({
        channel: fallbackChannel,
        type: "motion",
        motion: { channel: fallbackChannel, state: true, timestamp: now, source: "pir" },
        timestamp: now,
      });
    }

    const aiTypeToken = aiTypeRaw
      ? aiTypeRaw
          .split(",")
          .map((t) => t.trim())
          .find((t) => t.length > 0 && t.toLowerCase() !== "none")
      : undefined;
    if (aiTypeToken) {
      const aiTypeMap: Record<string, "people" | "vehicle" | "dog_cat" | "face" | "package" | "other"> = {
        people: "people",
        vehicle: "vehicle",
        dog_cat: "dog_cat",
        face: "face",
        package: "package",
      };
      out.push({
        channel: fallbackChannel,
        type: "ai",
        ai: {
          channel: fallbackChannel,
          type: aiTypeMap[aiTypeToken.toLowerCase()] ?? "other",
          detected: true,
          timestamp: now,
        },
        timestamp: now,
      });
    } else if (statusUpper.includes("AI")) {
      out.push({
        channel: fallbackChannel,
        type: "ai",
        ai: { channel: fallbackChannel, type: "other", detected: true, timestamp: now },
        timestamp: now,
      });
    }

    if (statusUpper.includes("VIS")) {
      out.push({ channel: fallbackChannel, type: "visitor", timestamp: now });
    }

    if (statusUpper.includes("DN")) {
      out.push({ channel: fallbackChannel, type: "daynight", timestamp: now });
    }

    return out;
  }

  private nextMsgNum(): number {
    this.msgNum = (this.msgNum + 1) & 0xffff;
    return this.msgNum;
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
    if (this.transport !== "tcp") throw new Error("Internal: requireSocket called while not using TCP");
    if (!this.tcpSocket || this.tcpSocket.destroyed) throw new Error("Baichuan TCP socket is not connected");
    return this.tcpSocket;
  }

  private writeWire(wire: Buffer): void {
    this.lastTxAtMs = Date.now();
    if (this.transport === "tcp") {
      this.requireSocket().write(wire);
      return;
    }
    if (!this.udpSocket) throw new Error("Baichuan UDP stream is not connected");
    this.udpSocket.write(wire);
  }

  private encodeBodyXml(extXml: string, payloadXml: string, channelId: number, enc: EncryptionProtocol): Buffer {
    const extBuf = Buffer.from(extXml, "utf8");
    const payloadBuf = Buffer.from(payloadXml, "utf8");

    if (enc.kind === "none") return Buffer.concat([extBuf, payloadBuf]);
    if (enc.kind === "bc") return Buffer.concat([bcEncrypt(extBuf, channelId), bcEncrypt(payloadBuf, channelId)]);
    if (enc.kind === "aes" || enc.kind === "full_aes") return Buffer.concat([aesEncrypt(extBuf, enc.key), aesEncrypt(payloadBuf, enc.key)]);
    // exhaustive
    return Buffer.concat([extBuf, payloadBuf]);
  }

  private encodeBodyBinary(extXml: string, payload: Buffer, channelId: number, enc: EncryptionProtocol): Buffer {
    const extBuf = Buffer.from(extXml, "utf8");

    // Neolink behavior: binary payloads are sent unencrypted, while the Extension is still encrypted.
    if (enc.kind === "none") return Buffer.concat([extBuf, payload]);
    if (enc.kind === "bc") return Buffer.concat([bcEncrypt(extBuf, channelId), payload]);
    if (enc.kind === "aes" || enc.kind === "full_aes") return Buffer.concat([aesEncrypt(extBuf, enc.key), payload]);
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
  }): Promise<void> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId = params.channelIdOverride ?? (params.channel == null ? 250 : channel + 1);

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
    const bodyBytes = this.encodeBodyBinary(extXml, params.payload, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    this.logDebug("tx", { cmdId, msgNum, channelId, messageClass, bodyLen, binaryPayload: true });
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg, this.logger,
        "BaichuanTalk",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset} binaryPayloadLen=${params.payload.length}`
      );
    }
    this.writeWire(wire);
  }

  tryDecryptXml(buf: Buffer, channelId: number, preferred: EncryptionProtocol): string {
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
  }): Promise<string> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId = params.channelIdOverride ?? (params.channel == null ? 250 : channel + 1); // default: reolink_aio-style

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml = params.extensionXml ?? (params.channel != null ? buildChannelExtensionXml(channel) : "");
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
    if (this.debugCfg.traceStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(this.debugCfg, this.logger, "BaichuanTrace", `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`);
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg, this.logger,
        "BaichuanTalk",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`
      );
    }
    this.writeWire(wire);

    const frame = await framePromise;
    this.logDebug("rx", { cmdId: frame.header.cmdId, responseCode: frame.header.responseCode, msgNum: frame.header.msgNum });
    if (this.debugCfg.traceStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(this.debugCfg, this.logger, "BaichuanTrace", `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`);
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg, this.logger,
        "BaichuanTalk",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`
      );
    }

    // Check responseCode for errors (400 = bad request/auth failure, 200 = success)
    // Some cameras return 400 with empty body when authentication fails
    if (frame.header.responseCode === 400) {
      // Try to decrypt anyway in case there's an error message, but don't fail if body is empty
      const body = frame.body;
      if (body.length === 0) {
        // Empty body with 400 typically means authentication failure
        throw new Error("Baichuan authentication failed (responseCode 400, empty body) - check username/password");
      }
      // If body is not empty, try to decrypt and return it (might contain error details)
    }

    // split + decrypt (extension/payload concatenated as in body)
    const body = frame.body;
    if (body.length === 0) return "";

    // For modern 24-byte frames: extension+payload; we decrypt full body as one stream just like references do.
    // (In practice extension and payload are separately encrypted but concatenation preserves it.)
    const xml = this.tryDecryptXml(body, frame.header.channelId, enc);
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
  }): Promise<BaichuanFrame> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId = params.channelIdOverride ?? (params.channel == null ? 250 : channel + 1);

    const msgNum = params.msgNumOverride ?? this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml = params.extensionXml ?? (params.channel != null ? buildChannelExtensionXml(channel) : "");
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
    let timeoutHandle: NodeJS.Timeout | undefined;
    const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
      rejectFn = reject;
      const t = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`Baichuan timeout cmdId=${cmdId} msgNum=${msgNum}`));
      }, timeoutMs);
      timeoutHandle = t;
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
    if (this.debugCfg.traceStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(this.debugCfg, this.logger, "BaichuanTrace", `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`);
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg, this.logger,
        "BaichuanTalk",
        `tx cmdId=${cmdId} msgNum=${msgNum} channelId=${channelId} streamType=${params.streamType ?? 0} class=0x${messageClass.toString(16)} bodyLen=${bodyLen} payloadOffset=${payloadOffset}`
      );
    }
    try {
      this.writeWire(wire);
    } catch (e) {
      this.pending.delete(pendingKey);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const err = e instanceof Error ? e : new Error(String(e));
      rejectFn?.(err);
    }

    const frame = await framePromise;
    this.logDebug("rx", { cmdId: frame.header.cmdId, responseCode: frame.header.responseCode, msgNum: frame.header.msgNum });
    if (this.debugCfg.traceStream && (cmdId === 3 || cmdId === 4)) {
      traceLog(this.debugCfg, this.logger, "BaichuanTrace", `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`);
    }
    if (this.debugCfg.traceTalk && isTalkCmd(cmdId)) {
      talkTraceLog(
        this.debugCfg, this.logger,
        "BaichuanTalk",
        `rx cmdId=${frame.header.cmdId} msgNum=${frame.header.msgNum} responseCode=${frame.header.responseCode} channelId=${frame.header.channelId} bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? 0}`
      );
    }
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
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    streamType?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
  }): Promise<Buffer> {
    // Snapshot (cmdId=109) is special: many firmwares deliver the binary payload via unsolicited "push" frames
    // and do not necessarily reply on the request's cmdId:msgNum pending slot. In that case, waiting on
    // `pending` will timeout. Handle it by sending without pending and collecting push chunks.
    if (params.cmdId === 109) {
      return await this.sendBinarySnapshot109(params);
    }

    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId = params.channelIdOverride ?? (params.channel == null ? 250 : channel + 1);

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml =
      params.extensionXml ?? (params.channel != null ? buildBinaryExtensionXml(channel) : buildBinaryExtensionXml(undefined));
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

    this.logDebug("tx", { cmdId, msgNum, channelId, messageClass, bodyLen, binary: true });
    this.writeWire(wire);

    const frame = await framePromise;
    this.logDebug("rx", { cmdId: frame.header.cmdId, responseCode: frame.header.responseCode, msgNum: frame.header.msgNum, binary: true });

    if (frame.header.responseCode === 400) {
      const body = frame.body;
      if (body.length === 0) {
        throw new Error("Baichuan binary request failed (responseCode 400, empty body)");
      }
    }

    // IMPORTANT: `body` can include an XML Extension prefix; for binary data use `payload`.
    const payload = frame.payload;
    if (payload.length === 0) return Buffer.alloc(0);

    const decrypted = this.tryDecryptBinary(payload, frame.header.channelId, enc);
    return decrypted;
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
    const channelId = params.channelIdOverride ?? (params.channel == null ? 250 : channel + 1);

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    // Per Snap (cmdId=109) la request usa solo channelId (niente <binaryData>1</binaryData>).
    // I chunk binari in risposta saranno marcati con <binaryData>1</binaryData> nella Extension.
    const extXml = params.extensionXml ?? (params.channel != null ? buildChannelExtensionXml(channel) : "");
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
        if (frame.header.msgNum === msgNum && frame.header.responseCode >= 400) {
          fail(new Error(`Baichuan snapshot request rejected (cmdId=${cmdId} msgNum=${msgNum} responseCode=${frame.header.responseCode})`));
          return;
        }

        try {
          // Snapshot flow (neolink):
          // - reply 1: XML body (no binaryData)
          // - reply 2..n: Extension has <binaryData>1</binaryData>, payload is binary chunks (responseCode 200/201)
          let isBinaryChunk = false;
          if (frame.extension.length > 0) {
            const extDec = this.tryDecryptXml(frame.extension, frame.header.channelId, enc);
            if (extDec.includes("<binaryData>1</binaryData>")) {
              isBinaryChunk = true;
            }
          }

          // If extension isn't present/parseable, fallback to heuristic: payload contains JPEG SOI.
          const decrypted = this.tryDecryptBinary(frame.payload, frame.header.channelId, enc);
          if (decrypted.length === 0) return;

          const head = decrypted.subarray(0, Math.min(16, decrypted.length)).toString("utf8");
          const looksLikeXml = head.startsWith("<?xml") || head.trimStart().startsWith("<");
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
        fail(new Error(`Baichuan timeout waiting snapshot push cmdId=${cmdId} msgNum=${msgNum}`));
      }, timeoutMs);

      // Attach listener BEFORE sending request to avoid missing the first chunk.
      // Use "frame" (not "push") so we also see frames that would otherwise be consumed by `pending`.
      this.on("frame", onFrame);

      try {
        this.logDebug("tx", { cmdId, msgNum, channelId, messageClass, bodyLen, binary: true, snapshot: true });
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
  tryDecryptBinary(buf: Buffer, channelId: number, preferred: EncryptionProtocol): Buffer {
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
      (preferred.kind !== "bc" && this.enc.kind !== "none" && (this.enc.kind === "aes" || this.enc.kind === "full_aes") ? tryAs(this.enc) : null) ??
      (preferred.kind !== "bc" ? tryAs({ kind: "bc" }) : null) ??
      tryAs({ kind: "none" }) ??
      buf // Return as-is if decryption fails
    );
  }

  /**
   * Login flow: legacy "upgrade" -> receive nonce/encryption -> modern login.
   * Ispirato a `neolink` (Rust) e `reolink_aio` (Python).
   */
  async login(maxEncryption: MaxEncryption = "full_aes"): Promise<void> {
    if (this.loggedIn) return;

    const maxAttempts = 3;
    let lastError: unknown;

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // 1) legacy header-only login upgrade to obtain nonce + encryption type

    // 1) legacy header-only login upgrade to obtain nonce + encryption type
    // IMPORTANT (neolink): AES request uses 0xdc12.
    // Some cameras will close the socket if you request an unsupported enc byte (es. 0xdc02).
    const encByte =
      maxEncryption === "none"
        ? 0xdc00
        : maxEncryption === "bc"
          ? 0xdc01
          : /* aes/full_aes */ 0xdc12;

    await this.connect();
    // legacy login is supported on both transports

    const msgNum = this.nextMsgNum();
    const cmdId = 1;
    const channelId = 250; // host

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
    if ((resp >>> 8) !== 0xdd) throw new Error(`Baichuan login: expected encryption info (0xDDxx), got 0x${resp.toString(16)}`);
    const encType = resp & 0xff;

    // During negotiation the payload is at most BCEncrypt (even if AES is supported).
    const nonceXml = this.tryDecryptXml(nonceFrame.body, nonceFrame.header.channelId, encType === 0x00 ? { kind: "none" } : { kind: "bc" });
    const nonce = getXmlText(nonceXml, "nonce");
    if (!nonce) throw new Error("Baichuan login: nonce not found in XML");
    this.nonce = nonce;

    // set encryption mode for post-login traffic
    if (encType === 0x00) this.enc = { kind: "none" };
    else if (encType === 0x01) this.enc = { kind: "bc" };
    else if (encType === 0x02) this.enc = { kind: "aes", key: deriveAesKey(nonce, this.opts.password) };
    else if (encType === 0x12) this.enc = { kind: "full_aes", key: deriveAesKey(nonce, this.opts.password) };
    else throw new Error(`Baichuan login: unknown encType=0x${encType.toString(16)}`);

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
      loginXmlPreview: loginXml.substring(0, 200)
    });

    // For login, explicitly use channelId 250 (host) and no extension XML
    // This ensures correct BCEncrypt channelId offset (channelId 250 = 0xFA = offset 250)
    // Use sendFrame directly (not sendXml from ReolinkBaichuanApi) to avoid recursion
    // since sendXml might call login() which would cause infinite recursion
    // Don't pass channel to use channelId 250 (host)
    const replyFrame = await this.sendFrame({
      cmdId: 1,
      payloadXml: loginXml,
      extensionXml: "",
      messageClass: BC_CLASS_MODERN_24,
      // For the login message itself, many firmwares expect BCEncrypt regardless of negotiated encryption.
      // This matches neolink/reolink-aio behavior: always use BCEncrypt for login.
      encryption: { kind: "bc" },
      timeoutMs: 10_000,
    });
    
    const replyXml = this.tryDecryptXml(replyFrame.body, replyFrame.header.channelId, { kind: "bc" });

    // If login succeeded, camera replies with 200 in responseCode on modern frames.
    // responseCode 400 typically means authentication failed (bad credentials)
    // responseCode 200 means success
    this.logDebug("login_reply", { 
        replyLength: replyXml.length, 
        replyPreview: replyXml.substring(0, 200),
        startsWithXml: replyXml.startsWith("<?xml")
      });
    
        // Check if reply is empty.
        // This is commonly seen on sleeping/waking battery cameras, but can also indicate bad credentials.
        if (replyXml.length === 0) {
          throw new Error(
            "Baichuan login failed: empty reply (camera may be sleeping/waking, session may be stale, or username/password may be invalid)",
          );
        }
    
    if (!replyXml.startsWith("<?xml")) {
      const preview = replyXml.length > 0 ? replyXml.substring(0, 100) : "(empty)";
      throw new Error(`Baichuan login: unexpected non-XML reply (length: ${replyXml.length}, preview: ${preview})`);
    }

        this.loggedIn = true;
        return;
      } catch (e) {
        lastError = e;
        this.loggedIn = false;
        try {
          await this.close();
        } catch {
          // ignore
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

