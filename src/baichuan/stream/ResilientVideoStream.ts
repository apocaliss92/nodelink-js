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
 * A BCUDP session can also be ended on a schedule (observed: ~30 min after it
 * opens, on cameras that never sleep). `renewAfterMs` replaces the session
 * BEFORE that, make-before-break: a second session is opened and started while
 * the first keeps delivering, and the consumer is switched over on the second
 * session's first keyframe; only then is the first closed. If a second session
 * cannot be obtained (the camera refuses a concurrent one, or it never
 * delivers a keyframe) the renewal falls back to a proactive reopen at the
 * next keyframe of the old session (a short gap instead of the ~16 s of an
 * unplanned loss plus rediscovery).
 *
 * Recovery is bounded (`maxRecoveryMs`) and every step is logged. Only when the
 * budget is spent does the consumer see `error` + `close`.
 *
 * Recovery never wakes a camera on its own. A battery camera ends its session
 * or goes silent when it falls asleep, and reopening a session then is a wake
 * nobody asked for — repeated for the whole budget, so the camera would never
 * sleep again. Before EVERY attempt the stream asks `recoveryGuard`; a refusal
 * (or a guard that throws) discards the session and ends the consumer's stream
 * with `error` + `close`. Dialling again is the consumer's decision.
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
  /**
   * Identity of the transport the session rides on. Streams that share one
   * (main and sub of a channel) pass the same object, so a stream that lost
   * its video can tell a dead transport from one still carrying a sibling.
   */
  transport?: object;
}

export interface ResilientOpenContext {
  purpose: "initial" | "recovery" | "renewal";
  /** Alternates 0/1 per renewal so two live sessions never share a key. */
  renewalId?: number;
}

export interface ResilientStreamLogger {
  info?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** Whether a recovery attempt may open a session right now. */
export type ResilientRecoveryVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ResilientVideoStreamOptions {
  /**
   * Opens a session and returns an UN-started stream on it. `ctx.purpose`
   * is "renewal" when the session will run NEXT TO the live one (make-before-
   * break): it must not be the pooled session the live stream rides on, so the
   * opener needs a distinct session key (`ctx.renewalId` alternates 0/1).
   */
  openSession: (ctx?: ResilientOpenContext) => Promise<ResilientStreamSession>;
  /**
   * Asked before every recovery attempt. Refuse when opening a session would
   * wake a camera that is asleep (or may be). Absent: recovery is always
   * allowed (a camera that never sleeps).
   */
  recoveryGuard?: () => ResilientRecoveryVerdict;
  /** Media silence after which the source is declared lost. 0 disables. */
  silenceMs?: number;
  /** How long one `start()` may take before the session is discarded. */
  startTimeoutMs?: number;
  /** Total time one outage may last before the consumer is told. */
  maxRecoveryMs?: number;
  /** First retry delay; doubles per failed attempt up to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /**
   * Replace the session proactively once it is this old (ms). 0 or absent:
   * never. Meant for transports whose sessions the camera ends on a schedule.
   */
  renewAfterMs?: number;
  /** How long a renewal session may take to deliver its first keyframe. */
  renewKeyframeTimeoutMs?: number;
  /** Wait before retrying a failed renewal. */
  renewRetryDelayMs?: number;
  /** Failed renewals tolerated before falling back to a proactive reopen. */
  maxRenewAttempts?: number;
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
  renewKeyframeTimeoutMs: 15_000,
  renewRetryDelayMs: 30_000,
  maxRenewAttempts: 2,
} as const;

/** Session age at which a BCUDP stream is renewed by default (cameras end it at ~30 min). */
export const UDP_SESSION_RENEW_AFTER_MS = 27 * 60_000;

/** A second session being brought up next to the live one. */
type RenewalCandidate = {
  session: ResilientStreamSession;
  openedAt: number;
  /** Last parameter-set header it announced; replayed on switch-over. */
  header: unknown[] | undefined;
  onAccessUnit: Listener;
  onHeader: Listener;
  onFail: Listener;
  deadline: ReturnType<typeof setTimeout> | null;
};

type Outage = { reason: string; lostAt: number; attempts: number };

/** When each shared transport last delivered video, to any stream on it. */
const transportLastVideoAt = new WeakMap<object, number>();

export class ResilientVideoStream extends EventEmitter<{
  videoAccessUnit: [AccessUnit];
  additionalHeader: [unknown];
  audioFrame: [Buffer];
  error: [Error];
  close: [];
  recovering: [{ reason: string }];
  recovered: [ResilientRecoveryInfo];
  renewed: [{ previousAgeMs: number }];
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
  /** Last video from the current session only (0 until it delivers). */
  private lastVideoAt = 0;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveries = 0;

  private readonly renewAfterMs: number;
  private readonly renewKeyframeTimeoutMs: number;
  private readonly renewRetryDelayMs: number;
  private readonly maxRenewAttempts: number;
  /** When the live session was opened (its age base). */
  private sessionOpenedAt = 0;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewing = false;
  private renewalCount = 0;
  private renewFailures = 0;
  /** After failed renewals: reopen proactively at the next keyframe. */
  private renewFallbackArmed = false;
  private candidate: RenewalCandidate | null = null;

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
    this.renewAfterMs = Math.max(0, opts.renewAfterMs ?? 0);
    this.renewKeyframeTimeoutMs = Math.max(
      1,
      opts.renewKeyframeTimeoutMs ?? d.renewKeyframeTimeoutMs,
    );
    this.renewRetryDelayMs = Math.max(
      1,
      opts.renewRetryDelayMs ?? d.renewRetryDelayMs,
    );
    this.maxRenewAttempts = Math.max(
      1,
      opts.maxRenewAttempts ?? d.maxRenewAttempts,
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
    // stop() during the await above already tore everything down: do not
    // arm a watch nobody will clear.
    if (this.stopped) return;
    this.started = true;
    this.lastMediaAt = Date.now();
    this.startSilenceWatch();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopSilenceWatch();
    this.clearRenewTimer();
    await this.abandonCandidate("stopped");
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.dropSession(false, "stopped");
    this.emit("close");
  }

  private async openAndStart(
    purpose: "initial" | "recovery" = "initial",
  ): Promise<void> {
    const session = await this.opts.openSession({ purpose });
    if (this.stopped) {
      await session.release().catch(() => {});
      throw new Error("ResilientVideoStream stopped while opening a session");
    }
    this.session = session;
    this.lastVideoAt = 0;
    this.attach(session.stream);
    try {
      await this.startWithDeadline(session.stream);
    } catch (e) {
      // A start that failed or never answered leaves a session the firmware
      // may have abandoned; it must not be handed to the next attempt.
      await this.dropSession(true, `start failed: ${errorMessage(e)}`);
      throw e;
    }
    this.sessionOpenedAt = Date.now();
    this.renewFallbackArmed = false;
    this.renewFailures = 0;
    this.scheduleRenewal(this.renewAfterMs);
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
    // Decided before the stop: stopping takes time a sibling keeps using.
    const discard = invalidate && !this.siblingStillFlowing(session);
    if (invalidate && !discard) {
      this.logger?.warn?.(
        `${this.prefix} the transport still carries another stream; keeping it and asking again on it`,
      );
    }
    await session.stream.stop().catch(() => {});
    if (discard) await session.invalidate(reason).catch(() => {});
    else await session.release().catch(() => {});
  }

  /**
   * A transport that delivered video to another stream after this one last
   * saw any is alive: only this stream's request is stuck, and closing the
   * transport would cut the stream that works.
   */
  private siblingStillFlowing(session: ResilientStreamSession): boolean {
    if (!session.transport) return false;
    const transportAt = transportLastVideoAt.get(session.transport);
    if (transportAt === undefined) return false;
    const window = this.silenceMs > 0 ? this.silenceMs : 10_000;
    return (
      transportAt > this.lastVideoAt && Date.now() - transportAt < window
    );
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
    // The watch must never keep the process alive on its own.
    this.silenceTimer.unref?.();
  }

  private stopSilenceWatch(): void {
    if (!this.silenceTimer) return;
    clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  /**
   * The guard's verdict, with a throw read as a refusal: not knowing whether
   * the camera sleeps is not permission to wake it.
   */
  private recoveryVerdict(): ResilientRecoveryVerdict {
    const guard = this.opts.recoveryGuard;
    if (!guard) return { allowed: true };
    try {
      return guard();
    } catch (e) {
      return {
        allowed: false,
        reason: `sleep state unknown (${errorMessage(e)})`,
      };
    }
  }

  /** Ends the stream without reopening: the camera must not be woken by us. */
  private async refuseRecovery(lost: string, refusal: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopSilenceWatch();
    this.clearRenewTimer();
    await this.abandonCandidate("recovery refused");
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.logger?.warn?.(
      `${this.prefix} source lost (${lost}); not recovering: ${refusal}`,
    );
    // The session is dead or belongs to a camera going to sleep: never reuse it.
    await this.dropSession(true, lost);
    const err = new Error(
      `${this.prefix} source lost (${lost}); recovery refused: ${refusal}`,
    );
    if (this.listenerCount("error") > 0) this.emit("error", err);
    this.emit("close");
  }

  /** Entry point for every way the source can be lost. */
  private sourceLost(reason: string): void {
    if (this.stopped || !this.started) return;
    if (this.reopening || this.retryTimer) return;
    // The live session is gone: an unplanned recovery takes over from any
    // renewal in flight (one new session at a time).
    this.clearRenewTimer();
    void this.abandonCandidate(`source lost (${reason})`);
    const verdict = this.recoveryVerdict();
    if (!verdict.allowed) {
      void this.refuseRecovery(reason, verdict.reason);
      return;
    }
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
    // A session that was accepted but delivers nothing (a sleeping battery
    // camera) must not be re-requested every silence window: that keeps the
    // camera awake. Every attempt after the first waits the same growing
    // delay a refused attempt does; it resets only with a real keyframe
    // (the outage ends and its attempt counter goes with it).
    const delay =
      this.outage.attempts > 0 ? this.backoffDelay(this.outage.attempts) : 0;
    if (delay === 0) {
      void this.reopen(reason);
      return;
    }
    this.logger?.warn?.(
      `${this.prefix} next attempt in ${delay}ms (silence after attempt ${this.outage.attempts})`,
    );
    // Do not leave the silent session open while waiting: an open session
    // is itself a reason for the camera to stay up.
    void this.dropSession(true, reason);
    this.scheduleReopen(reason, delay);
  }

  private backoffDelay(attempts: number): number {
    return Math.min(
      this.maxRetryDelayMs,
      this.retryDelayMs * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
    );
  }

  private scheduleReopen(reason: string, delay: number): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reopen(reason);
    }, delay);
    this.retryTimer.unref?.();
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
      // The camera may have fallen asleep during the wait.
      const verdict = this.recoveryVerdict();
      if (!verdict.allowed) {
        this.reopening = false;
        await this.refuseRecovery(reason, verdict.reason);
        return;
      }
      outage.attempts++;
      try {
        await this.openAndStart("recovery");
        // Video must follow within the silence window, or this attempt
        // counts as failed and the watch opens the next one.
        this.lastMediaAt = Date.now();
        this.logger?.debug?.(
          `${this.prefix} attempt ${outage.attempts}: stream re-requested, waiting for video`,
        );
      } catch (e) {
        if (this.stopped) return;
        const delay = this.backoffDelay(outage.attempts);
        this.logger?.warn?.(
          `${this.prefix} attempt ${outage.attempts} failed (${errorMessage(e)}); next in ${delay}ms`,
        );
        this.scheduleReopen(reason, delay);
      }
    } finally {
      this.reopening = false;
    }
  }

  // --- renewal (make-before-break) ---

  private clearRenewTimer(): void {
    if (!this.renewTimer) return;
    clearTimeout(this.renewTimer);
    this.renewTimer = null;
  }

  /** Arms the renewal for when the live session reaches `renewAfterMs`. */
  private scheduleRenewal(delayMs: number): void {
    this.clearRenewTimer();
    if (this.renewAfterMs <= 0 || this.stopped) return;
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      void this.renewSession();
    }, Math.max(0, delayMs));
    this.renewTimer.unref?.();
  }

  private async renewSession(): Promise<void> {
    if (this.stopped || !this.started) return;
    if (this.renewing || this.candidate) return;
    if (this.reopening || this.retryTimer || this.outage) {
      // An unplanned recovery owns the session right now; it opens a fresh one.
      return;
    }
    const verdict = this.recoveryVerdict();
    if (!verdict.allowed) {
      this.logger?.warn?.(
        `${this.prefix} session renewal skipped: ${verdict.reason}`,
      );
      return;
    }
    const age = Date.now() - this.sessionOpenedAt;
    this.renewing = true;
    this.logger?.info?.(
      `${this.prefix} renewing session at age=${age}ms (make-before-break)`,
    );
    const renewalId = this.renewalCount++ % 2;
    let session: ResilientStreamSession;
    try {
      session = await this.opts.openSession({ purpose: "renewal", renewalId });
    } catch (e) {
      this.renewing = false;
      this.renewalFailed(`could not open a second session: ${errorMessage(e)}`);
      return;
    }
    if (this.stopped || this.outage) {
      this.renewing = false;
      await session.invalidate("renewal no longer needed").catch(() => {});
      return;
    }
    const cand: RenewalCandidate = {
      session,
      openedAt: Date.now(),
      header: undefined,
      onAccessUnit: (...args) => this.onCandidateAccessUnit(cand, args[0] as AccessUnit),
      onHeader: (...args) => {
        cand.header = args;
      },
      onFail: (...args) => {
        void this.abandonCandidate(
          `renewal session failed: ${errorMessage(args[0])}`,
        ).then(() =>
          this.renewalFailed(`renewal session failed: ${errorMessage(args[0])}`),
        );
      },
      deadline: null,
    };
    this.candidate = cand;
    session.stream.on("videoAccessUnit", cand.onAccessUnit);
    session.stream.on("additionalHeader", cand.onHeader);
    session.stream.on("error", cand.onFail);
    session.stream.on("close", cand.onFail);
    try {
      await this.startWithDeadline(session.stream);
    } catch (e) {
      this.renewing = false;
      if (this.candidate !== cand) return;
      await this.abandonCandidate("start failed");
      this.renewalFailed(`second session did not start: ${errorMessage(e)}`);
      return;
    }
    this.renewing = false;
    if (this.candidate !== cand) return;
    cand.deadline = setTimeout(() => {
      cand.deadline = null;
      void this.abandonCandidate("no keyframe in time").then(() =>
        this.renewalFailed(
          `second session delivered no keyframe in ${this.renewKeyframeTimeoutMs}ms`,
        ),
      );
    }, this.renewKeyframeTimeoutMs);
    cand.deadline.unref?.();
  }

  /** First keyframe of the candidate: switch the consumer over, then close the old one. */
  private onCandidateAccessUnit(cand: RenewalCandidate, au: AccessUnit): void {
    if (this.candidate !== cand || !au.isKeyframe) return;
    const old = this.session;
    this.candidate = null;
    if (cand.deadline) clearTimeout(cand.deadline);
    cand.deadline = null;
    this.detachCandidate(cand);
    if (this.stopped) {
      void cand.session.invalidate("stopped").catch(() => {});
      return;
    }
    const previousAgeMs = Date.now() - this.sessionOpenedAt;
    if (old) this.detach(old.stream);
    this.session = cand.session;
    this.sessionOpenedAt = cand.openedAt;
    this.lastVideoAt = 0;
    this.renewFailures = 0;
    this.attach(cand.session.stream);
    // The consumer's decoder keeps its parameter sets; replay the new
    // session's own header ahead of its first keyframe.
    if (cand.header) this.emit("additionalHeader", cand.header[0]);
    this.onAccessUnit(au);
    this.scheduleRenewal(this.renewAfterMs);
    this.logger?.info?.(
      `${this.prefix} switched to the renewed session (previous age=${previousAgeMs}ms); closing the old one`,
    );
    this.emit("renewed", { previousAgeMs });
    if (old) {
      void (async () => {
        await old.stream.stop().catch(() => {});
        // Aged out: never hand this socket to anyone again.
        await old.invalidate("session renewed").catch(() => {});
      })();
    }
  }

  private detachCandidate(cand: RenewalCandidate): void {
    cand.session.stream.off("videoAccessUnit", cand.onAccessUnit);
    cand.session.stream.off("additionalHeader", cand.onHeader);
    cand.session.stream.off("error", cand.onFail);
    cand.session.stream.off("close", cand.onFail);
  }

  /** Discards a candidate that never took over. The live session is untouched. */
  private async abandonCandidate(reason: string): Promise<void> {
    const cand = this.candidate;
    if (!cand) return;
    this.candidate = null;
    if (cand.deadline) clearTimeout(cand.deadline);
    cand.deadline = null;
    this.detachCandidate(cand);
    await cand.session.stream.stop().catch(() => {});
    await cand.session.invalidate(reason).catch(() => {});
  }

  private renewalFailed(why: string): void {
    if (this.stopped) return;
    this.renewFailures++;
    if (this.renewFailures >= this.maxRenewAttempts) {
      this.logger?.warn?.(
        `${this.prefix} session renewal failed ${this.renewFailures}x (${why}); falling back to a proactive reopen at the next keyframe`,
      );
      this.renewFallbackArmed = true;
      return;
    }
    this.logger?.warn?.(
      `${this.prefix} session renewal failed (${why}); retrying in ${this.renewRetryDelayMs}ms`,
    );
    this.scheduleRenewal(this.renewRetryDelayMs);
  }

  /** Planned break-before-make renewal, entered right after a keyframe. */
  private proactiveReopen(): void {
    if (this.stopped || this.reopening || this.outage || this.retryTimer) return;
    const verdict = this.recoveryVerdict();
    if (!verdict.allowed) return;
    const reason = `proactive session renewal at age=${Date.now() - this.sessionOpenedAt}ms`;
    this.outage = { reason, lostAt: Date.now(), attempts: 0 };
    this.logger?.warn?.(`${this.prefix} ${reason}; reopening on a new session`);
    this.emit("recovering", { reason });
    void this.reopen(reason);
  }

  private giveUp(outage: Outage): void {
    const err = new Error(
      `${this.prefix} source not recovered after ${Date.now() - outage.lostAt}ms and ${outage.attempts} attempt(s) (${outage.reason})`,
    );
    this.logger?.warn?.(err.message);
    this.stopped = true;
    this.stopSilenceWatch();
    this.clearRenewTimer();
    void this.abandonCandidate("gave up");
    if (this.listenerCount("error") > 0) this.emit("error", err);
    this.emit("close");
  }

  private onAccessUnit = (...args: unknown[]): void => {
    const au = args[0] as AccessUnit;
    this.lastMediaAt = Date.now();
    this.lastVideoAt = this.lastMediaAt;
    const transport = this.session?.transport;
    if (transport) transportLastVideoAt.set(transport, this.lastMediaAt);
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
    if (this.renewFallbackArmed && au.isKeyframe && !this.outage) {
      this.renewFallbackArmed = false;
      this.proactiveReopen();
    }
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
