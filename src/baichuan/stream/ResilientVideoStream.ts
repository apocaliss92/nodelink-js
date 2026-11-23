// src/baichuan/stream/ResilientVideoStream.ts
import { EventEmitter } from "node:events";

/**
 * A live stream that survives the loss of its source.
 *
 * A camera can stop a stream it was asked for in three ways, and none of them
 * is the consumer's business:
 *   - the transport dies (BCUDP `D2C_DISC`, an idle disconnect, a socket
 *     rebuild) and the inner stream emits `close` / `error`;
 *   - the firmware goes silent while the session stays up (keepalives keep
 *     flowing, media does not);
 *   - a stream request on a session the firmware has abandoned is never
 *     answered.
 *
 * In all three the session that carried the stream is useless: asking the same
 * session for the stream again is not answered either, so recovery here is
 * always "discard that session, open a new one, ask again". The consumer keeps
 * the same object and the same listeners; it sees a pause, then video that
 * resumes on a keyframe.
 *
 * Recovery is bounded (`maxRecoveryMs`) and every step is logged. Only when the
 * budget is spent does the consumer see `error` + `close`.
 */

type AccessUnit = {
  data: Buffer;
  isKeyframe: boolean;
  videoType: "H264" | "H265";
  microseconds: number;
  time?: number;
};

type Listener = (...args: unknown[]) => void;

/** The part of a native live stream the wrapper drives. */
export interface ResilientInnerStream {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  consumePendingStartupError?(): Error | undefined;
}

/** One transport session plus the (un-started) stream that rides on it. */
export interface ResilientStreamSession {
  stream: ResilientInnerStream;
  /** Give the session back in a reusable state. */
  release: () => Promise<void>;
  /** Discard the session: its transport must never be handed out again. */
  invalidate: (reason: string) => Promise<void>;
}

export interface ResilientStreamLogger {
  info?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ResilientVideoStreamOptions {
  /** Opens a session and returns an UN-started stream on it. */
  openSession: () => Promise<ResilientStreamSession>;
  /** Media silence after which the source is declared lost. 0 disables. */
  silenceMs?: number;
  /** How long one `start()` may take before the session is discarded. */
  startTimeoutMs?: number;
  /** Total time one outage may last before the consumer is told. */
  maxRecoveryMs?: number;
  /** First retry delay; doubles per failed attempt up to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Prefix for log lines (e.g. `ch=0 profile=main`). */
  label?: string;
  logger?: ResilientStreamLogger;
}

export interface ResilientRecoveryInfo {
  reason: string;
  /** Milliseconds between the loss and the first video frame after it. */
  outageMs: number;
  attempts: number;
}

export const RESILIENT_STREAM_DEFAULTS = {
  silenceMs: 10_000,
  startTimeoutMs: 15_000,
  maxRecoveryMs: 10 * 60_000,
  retryDelayMs: 1_000,
  maxRetryDelayMs: 15_000,
} as const;

type Outage = { reason: string; lostAt: number; attempts: number };

export class ResilientVideoStream extends EventEmitter<{
  videoAccessUnit: [AccessUnit];
  additionalHeader: [unknown];
  audioFrame: [Buffer];
  error: [Error];
  close: [];
  recovering: [{ reason: string }];
  recovered: [ResilientRecoveryInfo];
}> {
  private readonly silenceMs: number;
  private readonly startTimeoutMs: number;
  private readonly maxRecoveryMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly logger: ResilientStreamLogger | undefined;
  private readonly prefix: string;

  private session: ResilientStreamSession | null = null;
  private stopped = false;
  private started = false;
  /** Set while the source is lost; cleared by the first video frame after it. */
  private outage: Outage | null = null;
  /** True while a recovery attempt (teardown + reopen) is in flight. */
  private reopening = false;
  private lastMediaAt = 0;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveries = 0;

  constructor(private readonly opts: ResilientVideoStreamOptions) {
    super();
    const d = RESILIENT_STREAM_DEFAULTS;
    this.silenceMs = Math.max(0, opts.silenceMs ?? d.silenceMs);
    this.startTimeoutMs = Math.max(1, opts.startTimeoutMs ?? d.startTimeoutMs);
    this.maxRecoveryMs = Math.max(0, opts.maxRecoveryMs ?? d.maxRecoveryMs);
    this.retryDelayMs = Math.max(1, opts.retryDelayMs ?? d.retryDelayMs);
    this.maxRetryDelayMs = Math.max(
      this.retryDelayMs,
      opts.maxRetryDelayMs ?? d.maxRetryDelayMs,
    );
    this.logger = opts.logger;
    this.prefix = `[ResilientVideoStream${opts.label ? ` ${opts.label}` : ""}]`;
  }

  /** Number of outages this stream has recovered from. */
  getRecoveryCount(): number {
    return this.recoveries;
  }

  isRecovering(): boolean {
    return this.outage !== null;
  }

  consumePendingStartupError(): Error | undefined {
    return this.session?.stream.consumePendingStartupError?.();
  }

  /**
   * Opens the first session. A failure here is the caller's: nothing was
   * delivered yet, so there is no stream to keep alive.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error("ResilientVideoStream is stopped");
    if (this.started) return;
    await this.openAndStart();
    this.started = true;
    this.lastMediaAt = Date.now();
    this.startSilenceWatch();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopSilenceWatch();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.dropSession(false, "stopped");
    this.emit("close");
  }

  private async openAndStart(): Promise<void> {
    const session = await this.opts.openSession();
    if (this.stopped) {
      await session.release().catch(() => {});
      throw new Error("ResilientVideoStream stopped while opening a session");
    }
    this.session = session;
    this.attach(session.stream);
    try {
      await this.startWithDeadline(session.stream);
    } catch (e) {
      // A start that failed or never answered leaves a session the firmware
      // may have abandoned; it must not be handed to the next attempt.
      await this.dropSession(true, `start failed: ${errorMessage(e)}`);
      throw e;
    }
  }

  private async startWithDeadline(stream: ResilientInnerStream): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startPromise = stream.start();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`stream start not answered in ${this.startTimeoutMs}ms`),
          ),
        this.startTimeoutMs,
      );
    });
    try {
      await Promise.race([startPromise, deadline]);
    } catch (e) {
      // The losing start may still settle later; it must not be unhandled.
      startPromise.catch(() => {});
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private attach(stream: ResilientInnerStream): void {
    stream.on("videoAccessUnit", this.onAccessUnit);
    stream.on("additionalHeader", this.onAdditionalHeader);
    stream.on("audioFrame", this.onAudioFrame);
    stream.on("error", this.onInnerError);
    stream.on("close", this.onInnerClose);
  }

  private detach(stream: ResilientInnerStream): void {
    stream.off("videoAccessUnit", this.onAccessUnit);
    stream.off("additionalHeader", this.onAdditionalHeader);
    stream.off("audioFrame", this.onAudioFrame);
    stream.off("error", this.onInnerError);
    stream.off("close", this.onInnerClose);
  }

  /** Detaches and stops the current inner stream, then returns its session. */
  private async dropSession(invalidate: boolean, reason: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.detach(session.stream);
    await session.stream.stop().catch(() => {});
    if (invalidate) await session.invalidate(reason).catch(() => {});
    else await session.release().catch(() => {});
  }

  private startSilenceWatch(): void {
    if (this.silenceMs <= 0 || this.silenceTimer) return;
    const tickMs = Math.max(50, Math.min(1000, Math.floor(this.silenceMs / 4)));
    this.silenceTimer = setInterval(() => {
      if (this.stopped || this.reopening || this.retryTimer) return;
      const silentFor = Date.now() - this.lastMediaAt;
      if (silentFor < this.silenceMs) return;
      this.sourceLost(`no media for ${silentFor}ms`);
    }, tickMs);
  }

  private stopSilenceWatch(): void {
    if (!this.silenceTimer) return;
    clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  /** Entry point for every way the source can be lost. */
  private sourceLost(reason: string): void {
    if (this.stopped || !this.started) return;
    if (this.reopening || this.retryTimer) return;
    if (!this.outage) {
      this.outage = { reason, lostAt: Date.now(), attempts: 0 };
      this.logger?.warn?.(
        `${this.prefix} source lost (${reason}); recovering on a new session`,
      );
      this.emit("recovering", { reason });
    } else {
      this.logger?.warn?.(
        `${this.prefix} still no video after attempt ${this.outage.attempts} (${reason}); retrying`,
      );
    }
    void this.reopen(reason);
  }

  private async reopen(reason: string): Promise<void> {
    const outage = this.outage;
    if (!outage || this.stopped || this.reopening) return;
    this.reopening = true;
    try {
      await this.dropSession(true, reason);
      if (this.stopped) return;
      if (Date.now() - outage.lostAt >= this.maxRecoveryMs) {
        this.giveUp(outage);
        return;
      }
      outage.attempts++;
      try {
        await this.openAndStart();
        // Video must follow within the silence window, or this attempt
        // counts as failed and the watch opens the next one.
        this.lastMediaAt = Date.now();
        this.logger?.debug?.(
          `${this.prefix} attempt ${outage.attempts}: stream re-requested, waiting for video`,
        );
      } catch (e) {
        if (this.stopped) return;
        const delay = Math.min(
          this.maxRetryDelayMs,
          this.retryDelayMs * 2 ** Math.min(outage.attempts - 1, 10),
        );
        this.logger?.warn?.(
          `${this.prefix} attempt ${outage.attempts} failed (${errorMessage(e)}); next in ${delay}ms`,
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.reopen(reason);
        }, delay);
      }
    } finally {
      this.reopening = false;
    }
  }

  private giveUp(outage: Outage): void {
    const err = new Error(
      `${this.prefix} source not recovered after ${Date.now() - outage.lostAt}ms and ${outage.attempts} attempt(s) (${outage.reason})`,
    );
    this.logger?.warn?.(err.message);
    this.stopped = true;
    this.stopSilenceWatch();
    if (this.listenerCount("error") > 0) this.emit("error", err);
    this.emit("close");
  }

  private onAccessUnit = (...args: unknown[]): void => {
    const au = args[0] as AccessUnit;
    this.lastMediaAt = Date.now();
    const outage = this.outage;
    if (outage) {
      // A new session starts mid-GOP as far as the consumer's decoder is
      // concerned: hold delta frames back until the first keyframe.
      if (!au.isKeyframe) return;
      this.outage = null;
      this.recoveries++;
      const info: ResilientRecoveryInfo = {
        reason: outage.reason,
        outageMs: Date.now() - outage.lostAt,
        attempts: outage.attempts,
      };
      (this.logger?.info ?? this.logger?.log)?.call(
        this.logger,
        `${this.prefix} recovered after ${info.outageMs}ms attempts=${info.attempts} (${info.reason})`,
      );
      this.emit("recovered", info);
    }
    this.emit("videoAccessUnit", au);
  };

  private onAdditionalHeader = (...args: unknown[]): void => {
    this.emit("additionalHeader", args[0]);
  };

  private onAudioFrame = (...args: unknown[]): void => {
    if (this.outage) return;
    this.emit("audioFrame", args[0] as Buffer);
  };

  private onInnerError = (...args: unknown[]): void => {
    this.sourceLost(`stream error: ${errorMessage(args[0])}`);
  };

  private onInnerClose = (): void => {
    this.sourceLost("stream closed by the camera or the transport");
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
