/**
 * A stream the consumer opened must survive the loss of its source.
 *
 * Reproduced on two DC-powered battery cameras streaming over BCUDP:
 *   - the camera sends D2C_DISC mid-stream and the socket is gone;
 *   - the firmware stops sending media while the session stays up, and a
 *     stream request repeated on that same session is never answered.
 * Both used to end the consumer's stream (the RFC4571 server closed and every
 * client was dropped), leaving holes of 20 s to several minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  ResilientVideoStream,
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

/** A consumer that only ever holds the one stream object. */
const consume = (stream: ResilientVideoStream) => {
  const seen = { frames: [] as number[], closed: 0, errors: [] as Error[] };
  stream.on("videoAccessUnit", (au) => seen.frames.push(au.microseconds));
  stream.on("close", () => seen.closed++);
  stream.on("error", (e) => seen.errors.push(e));
  return seen;
};

describe("ResilientVideoStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("survives a D2C_DISC mid-stream: same consumer stream, new session, video resumes", async () => {
    const sessions: FakeSession[] = [];
    const openSession = vi.fn(async () => {
      const s = makeSession();
      sessions.push(s);
      return s;
    });
    const stream = new ResilientVideoStream({ openSession, silenceMs: 10_000 });
    const seen = consume(stream);
    const recovered = vi.fn();
    stream.on("recovered", recovered);

    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", frame(true, 1));
    sessions[0]!.stream.emit("videoAccessUnit", frame(false, 2));

    // The camera drops the transport: the native stream closes.
    sessions[0]!.stream.emit("close");
    await vi.advanceTimersByTimeAsync(0);

    expect(seen.closed).toBe(0);
    expect(seen.errors).toHaveLength(0);
    // The dead session is discarded, never handed back for reuse.
    expect(sessions[0]!.invalidate).toHaveBeenCalledOnce();
    expect(sessions[0]!.release).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(sessions[1]!.stream.start).toHaveBeenCalledOnce();
    expect(stream.isRecovering()).toBe(true);

    sessions[1]!.stream.emit("videoAccessUnit", frame(true, 3));
    expect(seen.frames).toEqual([1, 2, 3]);
    expect(stream.isRecovering()).toBe(false);
    expect(recovered).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1 }),
    );
    expect(seen.closed).toBe(0);

    await stream.stop();
    expect(seen.closed).toBe(1);
    expect(sessions[1]!.release).toHaveBeenCalledOnce();
    expect(sessions[1]!.invalidate).not.toHaveBeenCalled();
  });

  it("survives a silent pause: the session that went quiet is discarded and video resumes on a new one", async () => {
    const sessions: FakeSession[] = [];
    const openSession = vi.fn(async () => {
      const s = makeSession();
      sessions.push(s);
      return s;
    });
    const stream = new ResilientVideoStream({ openSession, silenceMs: 10_000 });
    const seen = consume(stream);

    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", frame(true, 1));

    // Media flowing: nothing happens.
    await vi.advanceTimersByTimeAsync(9_000);
    sessions[0]!.stream.emit("videoAccessUnit", frame(false, 2));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(openSession).toHaveBeenCalledOnce();

    // The firmware stops sending; nothing is closed, nothing errors.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(openSession).toHaveBeenCalledTimes(2);
    expect(sessions[0]!.stream.stop).toHaveBeenCalledOnce();
    expect(sessions[0]!.invalidate).toHaveBeenCalledOnce();
    expect(seen.closed).toBe(0);

    sessions[1]!.stream.emit("videoAccessUnit", frame(true, 3));
    expect(seen.frames).toEqual([1, 2, 3]);
    expect(stream.getRecoveryCount()).toBe(1);

    await stream.stop();
  });

  it("holds delta frames back until the first keyframe of the new session", async () => {
    const sessions: FakeSession[] = [];
    const stream = new ResilientVideoStream({
      openSession: async () => {
        const s = makeSession();
        sessions.push(s);
        return s;
      },
    });
    const seen = consume(stream);

    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", frame(true, 1));
    sessions[0]!.stream.emit("close");
    await vi.advanceTimersByTimeAsync(0);

    sessions[1]!.stream.emit("videoAccessUnit", frame(false, 2));
    expect(seen.frames).toEqual([1]);
    sessions[1]!.stream.emit("videoAccessUnit", frame(true, 3));
    sessions[1]!.stream.emit("videoAccessUnit", frame(false, 4));
    expect(seen.frames).toEqual([1, 3, 4]);

    await stream.stop();
  });

  it("discards a session whose stream request is never answered and tries the next one", async () => {
    const sessions: FakeSession[] = [];
    const stream = new ResilientVideoStream({
      startTimeoutMs: 15_000,
      retryDelayMs: 1_000,
      openSession: async () => {
        const s = makeSession();
        // The second session is one the firmware has abandoned.
        if (sessions.length === 1) {
          s.stream.start = vi.fn(() => new Promise<void>(() => {}));
        }
        sessions.push(s);
        return s;
      },
    });
    const seen = consume(stream);

    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", frame(true, 1));
    sessions[0]!.stream.emit("close");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sessions[1]!.invalidate).toHaveBeenCalledOnce();
    expect(seen.closed).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessions).toHaveLength(3);
    sessions[2]!.stream.emit("videoAccessUnit", frame(true, 2));
    expect(seen.frames).toEqual([1, 2]);

    await stream.stop();
  });

  it("waits out a refused session (camera cooldown) with a growing delay", async () => {
    const sessions: FakeSession[] = [];
    let refusals = 3;
    const openSession = vi.fn(async () => {
      if (sessions.length >= 1 && refusals-- > 0) {
        throw new Error("host in cooldown after D2C_DISC");
      }
      const s = makeSession();
      sessions.push(s);
      return s;
    });
    const stream = new ResilientVideoStream({
      openSession,
      retryDelayMs: 1_000,
      maxRetryDelayMs: 15_000,
    });
    const seen = consume(stream);

    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", frame(true, 1));
    sessions[0]!.stream.emit("close");

    await vi.advanceTimersByTimeAsync(0);
    expect(openSession).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(openSession).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(openSession).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(openSession).toHaveBeenCalledTimes(5);

    sessions[1]!.stream.emit("videoAccessUnit", frame(true, 2));
    expect(seen.frames).toEqual([1, 2]);
    expect(seen.closed).toBe(0);

    await stream.stop();
  });

  it("is bounded: tells the consumer once the recovery budget is spent", async () => {
    const sessions: FakeSession[] = [];
    const openSession = vi.fn(async () => {
      if (sessions.length >= 1) throw new Error("camera unreachable");
      const s = makeSession();
      sessions.push(s);
      return s;
    });
    const stream = new ResilientVideoStream({
      openSession,
      maxRecoveryMs: 60_000,
      retryDelayMs: 1_000,
      maxRetryDelayMs: 15_000,
    });
    const seen = consume(stream);

    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", frame(true, 1));
    sessions[0]!.stream.emit("close");

    await vi.advanceTimersByTimeAsync(59_000);
    expect(seen.closed).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen.closed).toBe(1);
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]!.message).toMatch(/not recovered/);

    const attempts = openSession.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(openSession).toHaveBeenCalledTimes(attempts);
  });

  it("does not reopen anything after stop()", async () => {
    const sessions: FakeSession[] = [];
    const openSession = vi.fn(async () => {
      const s = makeSession();
      sessions.push(s);
      return s;
    });
    const stream = new ResilientVideoStream({ openSession, silenceMs: 10_000 });
    await stream.start();
    const first = sessions[0]!;
    await stream.stop();

    first.stream.emit("close");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openSession).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
  });

  it("fails start() when the first session cannot deliver: nothing to keep alive yet", async () => {
    const stream = new ResilientVideoStream({
      openSession: async () => {
        throw new Error("login failed");
      },
    });
    await expect(stream.start()).rejects.toThrow("login failed");
  });
});
