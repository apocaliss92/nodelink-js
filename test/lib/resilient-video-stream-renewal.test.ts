/**
 * Make-before-break renewal. BCUDP sessions on always-on cameras are ended by
 * the camera ~30 min after they open; the stream replaces its session first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
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
    expect(seen.frames).toEqual([1, 2, 1000]);
    expect(seen.renewed).toBe(1);
    expect(seen.recovering).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(old!.stream.stop).toHaveBeenCalledTimes(1);
    expect(old!.invalidate).toHaveBeenCalledTimes(1);
    expect(fresh.invalidate).not.toHaveBeenCalled();

    // Frames from the retired session no longer reach the consumer.
    old!.stream.emit("videoAccessUnit", frame(true, 5));
    fresh.stream.emit("videoAccessUnit", frame(false, 1001));
    expect(seen.frames).toEqual([1, 2, 1000, 1001]);

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
});
