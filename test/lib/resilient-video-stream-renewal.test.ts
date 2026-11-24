/**
 * Make-before-break renewal. BCUDP sessions on always-on cameras are ended by
 * the camera ~30 min after they open; the stream replaces its session first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolveRenewAfterMs } from "../../src/rfc/rfc4571-server";
import {
  UDP_SESSION_RENEW_AFTER_MS,
  ResilientVideoStream,
  type ResilientOpenContext,
  type ResilientStreamSession,
} from "../../src/baichuan/stream/ResilientVideoStream";

class FakeNativeStream extends EventEmitter {
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
}
type FakeSession = ResilientStreamSession & {
  stream: FakeNativeStream;
  release: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
};
const makeSession = (): FakeSession => ({
  stream: new FakeNativeStream(),
  release: vi.fn(async () => {}),
  invalidate: vi.fn(async () => {}),
});
const frame = (isKeyframe: boolean, microseconds: number) => ({
  data: Buffer.from([0, 0, 0, 1, isKeyframe ? 0x65 : 0x41]),
  isKeyframe,
  videoType: "H264" as const,
  microseconds,
});

const RENEW_MS = 27 * 60_000;

const setup = (extra: { failRenewalOpen?: boolean } = {}) => {
  const sessions: FakeSession[] = [];
  const contexts: (ResilientOpenContext | undefined)[] = [];
  const stream = new ResilientVideoStream({
    silenceMs: 0, // isolate renewal from the silence watch
    renewAfterMs: RENEW_MS,
    renewKeyframeTimeoutMs: 5_000,
    renewRetryDelayMs: 10_000,
    maxRenewAttempts: 2,
    openSession: async (ctx) => {
      contexts.push(ctx);
      if (ctx?.purpose === "renewal" && extra.failRenewalOpen)
        throw new Error("camera refused a second session");
      const s = makeSession();
      sessions.push(s);
      return s;
    },
  });
  const seen = { frames: [] as number[], recovering: 0, renewed: 0, closed: 0 };
  stream.on("videoAccessUnit", (au) => seen.frames.push(au.microseconds));
  stream.on("recovering", () => seen.recovering++);
  stream.on("renewed", () => seen.renewed++);
  stream.on("close", () => seen.closed++);
  return { stream, sessions, contexts, seen };
};

describe("ResilientVideoStream renewal (make-before-break)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens a second session at the renewal age and closes the old one only after the new session's first keyframe", async () => {
    const { stream, sessions, contexts, seen } = setup();
    await stream.start();
    const [old] = sessions;
    old!.stream.emit("videoAccessUnit", frame(true, 1));

    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(sessions).toHaveLength(2);
    expect(contexts[1]).toMatchObject({ purpose: "renewal" });
    const fresh = sessions[1]!;
    expect(fresh.stream.start).toHaveBeenCalled();

    // Old keeps serving; a non-keyframe from the new session changes nothing.
    old!.stream.emit("videoAccessUnit", frame(false, 2));
    fresh.stream.emit("videoAccessUnit", frame(false, 900));
    expect(seen.frames).toEqual([1, 2]);
    expect(old!.stream.stop).not.toHaveBeenCalled();
    expect(old!.invalidate).not.toHaveBeenCalled();

    // First keyframe of the new session: switch, then close the old.
    fresh.stream.emit("videoAccessUnit", frame(true, 1000));
    // continues the old timeline: last emitted (2) + one default 40 ms frame
    expect(seen.frames).toEqual([1, 2, 40002]);
    expect(seen.renewed).toBe(1);
    expect(seen.recovering).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(old!.stream.stop).toHaveBeenCalledTimes(1);
    expect(old!.invalidate).toHaveBeenCalledTimes(1);
    expect(fresh.invalidate).not.toHaveBeenCalled();

    // Frames from the retired session no longer reach the consumer.
    old!.stream.emit("videoAccessUnit", frame(true, 5));
    fresh.stream.emit("videoAccessUnit", frame(false, 1001));
    expect(seen.frames).toEqual([1, 2, 40002, 40003]);

    await stream.stop();
  });

  it("discards a second session that never delivers a keyframe and keeps the live one", async () => {
    const { stream, sessions, seen } = setup();
    await stream.start();
    const [old] = sessions;
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const fresh = sessions[1]!;
    await vi.advanceTimersByTimeAsync(5_000); // keyframe deadline
    expect(fresh.invalidate).toHaveBeenCalled();
    expect(old!.stream.stop).not.toHaveBeenCalled();
    old!.stream.emit("videoAccessUnit", frame(true, 7));
    expect(seen.frames).toEqual([7]);
    await stream.stop();
  });

  it("falls back to a proactive reopen at the next keyframe when a second session cannot be had", async () => {
    const { stream, sessions, seen } = setup({ failRenewalOpen: true });
    await stream.start();
    const [old] = sessions;
    old!.stream.emit("videoAccessUnit", frame(true, 1));

    await vi.advanceTimersByTimeAsync(RENEW_MS); // attempt 1 fails
    await vi.advanceTimersByTimeAsync(10_000); // attempt 2 fails -> fallback armed
    expect(old!.stream.stop).not.toHaveBeenCalled();
    expect(seen.recovering).toBe(0);

    old!.stream.emit("videoAccessUnit", frame(false, 2));
    expect(seen.recovering).toBe(0);
    old!.stream.emit("videoAccessUnit", frame(true, 3)); // keyframe boundary
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.recovering).toBe(1);
    expect(old!.invalidate).toHaveBeenCalled();
    expect(sessions).toHaveLength(2);
    await stream.stop();
  });

  it("does nothing when renewAfterMs is not set", async () => {
    const sessions: FakeSession[] = [];
    const stream = new ResilientVideoStream({
      silenceMs: 0,
      openSession: async () => {
        const s = makeSession();
        sessions.push(s);
        return s;
      },
    });
    await stream.start();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(sessions).toHaveLength(1);
    await stream.stop();
  });

  it("hands the consumer the new session's header before its keyframe and continues the timeline", async () => {
    const { stream, sessions } = setup();
    const events: string[] = [];
    stream.on("additionalHeader", (h) =>
      events.push(`header:${(h as { microseconds: number }).microseconds}`),
    );
    stream.on("videoAccessUnit", (au) => events.push(`au:${au.microseconds}`));
    await stream.start();
    const [old] = sessions;
    old!.stream.emit("videoAccessUnit", frame(true, 1_000_000));
    old!.stream.emit("videoAccessUnit", frame(false, 1_040_000));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const fresh = sessions[1]!;
    events.length = 0;
    // The second session runs on its own, much earlier camera clock, and its
    // header fires BEFORE the keyframe, while the candidate is still pending.
    fresh.stream.emit("additionalHeader", { microseconds: 500, raw: Buffer.alloc(0) });
    expect(events).toEqual([]);
    fresh.stream.emit("videoAccessUnit", frame(true, 500));
    fresh.stream.emit("additionalHeader", { microseconds: 40_500 });
    fresh.stream.emit("videoAccessUnit", frame(false, 40_500));
    // header replayed first, on the old timeline (last 1_040_000 + one 40 ms frame)
    expect(events).toEqual([
      "header:1080000",
      "au:1080000",
      "header:1120000",
      "au:1120000",
    ]);
    await stream.stop();
  });

  it("forces the old transport to be discarded in the proactive-reopen fallback, even when a sibling stream still flows on it", async () => {
    const transport = {};
    const sessions: FakeSession[] = [];
    const stream = new ResilientVideoStream({
      silenceMs: 0,
      renewAfterMs: RENEW_MS,
      renewRetryDelayMs: 10_000,
      maxRenewAttempts: 2,
      openSession: async (ctx) => {
        if (ctx?.purpose === "renewal") throw new Error("refused");
        const s = makeSession();
        s.transport = transport;
        sessions.push(s);
        return s;
      },
    });
    await stream.start();
    const [old] = sessions;
    old!.stream.emit("videoAccessUnit", frame(true, 1));
    // A sibling stream on the same transport delivered video after ours: an
    // ordinary recovery would release() the transport and re-ask on it.
    const sibling = new ResilientVideoStream({
      silenceMs: 0,
      openSession: async () => {
        const s = makeSession();
        s.transport = transport;
        return s;
      },
    });
    await sibling.start();
    const siblingSession = (sibling as unknown as { session: FakeSession })
      .session;
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    await vi.advanceTimersByTimeAsync(10_000);
    // The sibling delivers video right after ours does, a moment before the
    // fallback decides what to do with the transport.
    stream.once("videoAccessUnit", () => {
      vi.setSystemTime(Date.now() + 1);
      siblingSession.stream.emit("videoAccessUnit", frame(true, 9));
    });
    old!.stream.emit("videoAccessUnit", frame(true, 3));
    await vi.advanceTimersByTimeAsync(0);
    expect(old!.invalidate).toHaveBeenCalledTimes(1);
    expect(old!.release).not.toHaveBeenCalled();
    await stream.stop();
    await sibling.stop();
  });

  it("an unplanned loss during a renewal abandons the candidate and recovers on one new session", async () => {
    const { stream, sessions, seen } = setup();
    await stream.start();
    const [old] = sessions;
    old!.stream.emit("videoAccessUnit", frame(true, 1));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const candidate = sessions[1]!;
    expect(sessions).toHaveLength(2);

    old!.stream.emit("close"); // camera ends the old session mid-renewal
    await vi.advanceTimersByTimeAsync(0);
    expect(candidate.invalidate).toHaveBeenCalled();
    expect(seen.recovering).toBe(1);
    expect(sessions).toHaveLength(3);
    // The abandoned candidate can no longer take over.
    candidate.stream.emit("videoAccessUnit", frame(true, 2));
    expect(seen.frames).toEqual([1]);
    const recovered = sessions[2]!;
    recovered.stream.emit("videoAccessUnit", frame(true, 3));
    expect(seen.frames).toEqual([1, 3]);
    expect(seen.renewed).toBe(0);
    await stream.stop();
  });

  it("asks again when the guard refuses at renewal time, and renews once it allows", async () => {
    let allowed = false;
    const sessions: FakeSession[] = [];
    const stream = new ResilientVideoStream({
      silenceMs: 0,
      renewAfterMs: RENEW_MS,
      renewRetryDelayMs: 10_000,
      recoveryGuard: () =>
        allowed ? { allowed: true } : { allowed: false, reason: "probing" },
      openSession: async () => {
        const s = makeSession();
        sessions.push(s);
        return s;
      },
    });
    await stream.start();
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(sessions).toHaveLength(1); // refused, not forgotten
    allowed = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessions).toHaveLength(2);
    // Past the camera's deadline the retry stops.
    await stream.stop();
  });

  it("stops asking once the session is past the renewal window", async () => {
    const sessions: FakeSession[] = [];
    const stream = new ResilientVideoStream({
      silenceMs: 0,
      renewAfterMs: RENEW_MS,
      renewRetryDelayMs: 10_000,
      recoveryGuard: () => ({ allowed: false, reason: "asleep" }),
      openSession: async () => {
        const s = makeSession();
        sessions.push(s);
        return s;
      },
    });
    await stream.start();
    await vi.advanceTimersByTimeAsync(RENEW_MS + 200_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(sessions).toHaveLength(1);
    await stream.stop();
  });
});


describe("resolveRenewAfterMs", () => {
  it("defaults to 27 min on BCUDP and to never on TCP; the option wins", () => {
    expect(resolveRenewAfterMs(undefined, "udp")).toBe(UDP_SESSION_RENEW_AFTER_MS);
    expect(resolveRenewAfterMs(undefined, "tcp")).toBe(0);
    expect(resolveRenewAfterMs({ renewAfterMs: 0 }, "udp")).toBe(0);
    expect(resolveRenewAfterMs({ renewAfterMs: 60_000 }, "tcp")).toBe(60_000);
  });
});
