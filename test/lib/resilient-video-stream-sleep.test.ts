/**
 * A self-healing stream must never wake a camera on its own.
 *
 * A battery camera ends its session (D2C_DISC) or goes silent when it falls
 * asleep. Reopening a session then is a wake nobody asked for, and the
 * recovery keeps asking for up to its whole budget, so the camera would never
 * sleep. The recovery asks a guard first; a refusal ends the consumer's stream
 * (the consumer decides whether to dial again, which is a wake IT asked for)
 * and the session that carried it is discarded, never handed out again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  ResilientVideoStream,
  type ResilientRecoveryVerdict,
  type ResilientStreamSession,
} from "../../src/baichuan/stream/ResilientVideoStream";
import { resolveRecoveryGuard } from "../../src/rfc/rfc4571-server";

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

const keyframe = (microseconds: number) => ({
  data: Buffer.from([0, 0, 0, 1, 0x65]),
  isKeyframe: true,
  videoType: "H264" as const,
  microseconds,
});

const ASLEEP: ResilientRecoveryVerdict = {
  allowed: false,
  reason: "camera asleep",
};
const AWAKE: ResilientRecoveryVerdict = { allowed: true };

const setup = (guard: () => ResilientRecoveryVerdict) => {
  const sessions: FakeSession[] = [];
  const openSession = vi.fn(async () => {
    const s = makeSession();
    sessions.push(s);
    return s;
  });
  const stream = new ResilientVideoStream({
    openSession,
    silenceMs: 10_000,
    retryDelayMs: 1_000,
    recoveryGuard: guard,
  });
  const seen = { closed: 0, errors: [] as Error[], recovering: 0 };
  stream.on("close", () => seen.closed++);
  stream.on("error", (e) => seen.errors.push(e));
  stream.on("recovering", () => seen.recovering++);
  return { sessions, openSession, stream, seen };
};

describe("ResilientVideoStream sleep awareness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a camera that ended its session to sleep is not reopened: the stream ends, the session is discarded", async () => {
    const { sessions, openSession, stream, seen } = setup(() => ASLEEP);
    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", keyframe(1));

    sessions[0]!.stream.emit("close");
    await vi.advanceTimersByTimeAsync(0);

    expect(openSession).toHaveBeenCalledOnce();
    expect(sessions[0]!.invalidate).toHaveBeenCalledOnce();
    expect(sessions[0]!.release).not.toHaveBeenCalled();
    expect(seen.recovering).toBe(0);
    expect(seen.closed).toBe(1);
    expect(seen.errors[0]?.message).toContain("camera asleep");

    // Nothing is armed behind the consumer's back.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(openSession).toHaveBeenCalledOnce();
  });

  it("a silent session on a sleeping camera is not re-requested either", async () => {
    const { sessions, openSession, stream, seen } = setup(() => ASLEEP);
    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", keyframe(1));

    await vi.advanceTimersByTimeAsync(11_000);

    expect(openSession).toHaveBeenCalledOnce();
    expect(sessions[0]!.invalidate).toHaveBeenCalledOnce();
    expect(seen.closed).toBe(1);
  });

  it("the guard is asked before every attempt: a camera that falls asleep mid-outage stops the retries", async () => {
    let verdict: ResilientRecoveryVerdict = AWAKE;
    const { sessions, openSession, stream, seen } = setup(() => verdict);
    await stream.start();
    sessions[0]!.stream.emit("videoAccessUnit", keyframe(1));

    sessions[0]!.stream.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(seen.recovering).toBe(1);

    // The second session is accepted but stays silent; the camera sleeps.
    verdict = ASLEEP;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(openSession).toHaveBeenCalledTimes(2);
    expect(sessions[1]!.invalidate).toHaveBeenCalledOnce();
    expect(seen.closed).toBe(1);
  });

  it("an awake camera still recovers as before", async () => {
    const { sessions, openSession, stream, seen } = setup(() => AWAKE);
    await stream.start();
    sessions[0]!.stream.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(openSession).toHaveBeenCalledTimes(2);
    sessions[1]!.stream.emit("videoAccessUnit", keyframe(2));
    expect(stream.isRecovering()).toBe(false);
    expect(seen.closed).toBe(0);
    await stream.stop();
  });

  it("a guard that throws refuses: not knowing is not permission to wake", async () => {
    const { sessions, openSession, stream, seen } = setup(() => {
      throw new Error("no sleep state");
    });
    await stream.start();
    sessions[0]!.stream.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(openSession).toHaveBeenCalledOnce();
    expect(seen.closed).toBe(1);
  });
});

describe("resolveRecoveryGuard (rfc4571 server default)", () => {
  it("a caller that says the camera sleeps gets no recovery, whatever the transport", () => {
    expect(resolveRecoveryGuard({ sleeps: true }, () => "tcp")().allowed).toBe(
      false,
    );
  });

  it("a caller that says it never sleeps always recovers, even over BCUDP", () => {
    expect(resolveRecoveryGuard({ sleeps: false }, () => "udp")().allowed).toBe(
      true,
    );
  });

  it("unset: BCUDP is treated as a sleeper, TCP is not", () => {
    expect(resolveRecoveryGuard(undefined, () => "udp")().allowed).toBe(false);
    expect(resolveRecoveryGuard(undefined, () => "tcp")().allowed).toBe(true);
  });

  it("the caller's own guard wins and is asked every time", () => {
    let calls = 0;
    const guard = resolveRecoveryGuard(
      {
        sleeps: true,
        recoveryGuard: () => {
          calls++;
          return { allowed: true };
        },
      },
      () => "udp",
    );
    expect(guard().allowed).toBe(true);
    guard();
    expect(calls).toBe(2);
  });
});
