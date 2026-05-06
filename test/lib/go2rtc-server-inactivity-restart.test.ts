/**
 * Regression test for issue #16: AC-powered camera (e.g. Reolink Doorbell) loses
 * its native stream after a transient camera-side outage (daily maintenance
 * reboot, network blip) and Go2rtcTcpServer never restarts it. The user must
 * manually restart the container or force-disconnect to recover.
 *
 * Root cause:
 *   The streamHealthTimer's inactivity-timeout handler set
 *   `this.nativeStreamActive = false` BEFORE calling `fanout.stop()`. The
 *   `onEnd` callback uses `if (!this.nativeStreamActive) return` to skip
 *   redundant cleanup when stopNativeStream() was the trigger — so when the
 *   timeout path also flipped the flag, onEnd's auto-restart branch became
 *   unreachable. The comment above the bad line claimed "the onEnd callback
 *   will auto-restart if clients are connected or prestartStream is enabled",
 *   but the code prevented exactly that.
 *
 * Fix: leave nativeStreamActive=true in the inactivity-timeout path. onEnd
 * sets it to false itself as part of its own cleanup, so explicit stops still
 * short-circuit correctly via stopNativeStream() which sets the flag first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Go2rtcTcpServer } from "../../src/baichuan/stream/Go2rtcTcpServer.js";
import * as helpers from "../../src/rfc/helpers.js";

vi.mock("../../src/rfc/helpers.js", () => ({
  createNativeStream: vi.fn(),
}));

/**
 * Simulates an AC-powered camera that yields one keyframe then goes silent
 * (e.g. firmware-internal reboot during overnight maintenance window).
 */
/**
 * Yields one keyframe then waits for an external `triggerEnd()` call before
 * returning. Lets the test orchestrate the exact moment the source ends so
 * we can flip Go2rtcTcpServer's internal flags between "frame received" and
 * "source ended" — reproducing the race condition from issue #16 where the
 * inactivity handler's synchronous flag flip suppressed onEnd's auto-restart.
 */
function makeControllableGenerator(): {
  gen: AsyncGenerator<unknown, void, unknown>;
  triggerEnd: () => void;
} {
  let resolveEnd: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  const gen = (async function* () {
    yield {
      audio: false,
      data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x33]),
      codec: "H264" as string | null,
      sampleRate: null as number | null,
      microseconds: 1_000_000 as number | null,
      videoType: "H264" as "H264" | "H265",
      isKeyframe: true,
    };
    await ended;
  })();
  return {
    gen,
    triggerEnd: () => resolveEnd?.(),
  };
}

function buildMockApi() {
  return {
    client: {
      getTransport: () => "tcp" as const,
      getDebugConfig: () => ({ debugRtsp: false }),
    },
    isReady: true,
    isClosed: false,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    createDedicatedSession: vi.fn().mockResolvedValue({
      client: {},
      release: vi.fn().mockResolvedValue(undefined),
    }),
    isStreamProfileRejected: () => false,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

function buildAcServer(api: any) {
  return new Go2rtcTcpServer({
    api,
    channel: 0,
    profile: "main",
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: true, // AC-powered camera (the doorbell case)
    gracePeriodMs: 10_000,
    streamTimeoutMs: 15_000, // mirrors production default
    logger: {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  });
}

describe("Go2rtcTcpServer – inactivity-timeout auto-restart (issue #16)", () => {
  // Real timers — this test races microtasks intentionally and does not need
  // synthetic time advancement.
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onEnd auto-restarts even when nativeStreamActive was already flipped to false (issue #16 race)", async () => {
    // Reproduces the pre-fix bug without relying on fake-timer +
    // async-generator-cancellation interactions:
    //
    // Pre-fix: the streamHealthTimer's inactivity handler set
    // `nativeStreamActive = false` synchronously, then called `fanout.stop()`
    // fire-and-forget. When the fanout's pump unwound and onEnd fired, the
    // early-return guard `if (!nativeStreamActive) return` matched and the
    // auto-restart branch was unreachable.
    //
    // Post-fix: onEnd's guard keys off `nativeStreamStopping` (set only by
    // explicit stopNativeStream()), so the inactivity-timer's flag flip no
    // longer suppresses the restart.
    //
    // We simulate the exact race here: yield a frame to drive the pump into
    // the consume loop, manually flip nativeStreamActive=false the way the
    // inactivity handler would, then end the source so onEnd fires. The fix
    // makes the test pass; the pre-fix behavior would leave createCount at 1.
    let createCount = 0;
    let pendingTriggerEnd: (() => void) | null = null;

    vi.mocked(helpers.createNativeStream).mockImplementation((() => {
      createCount++;
      const { gen, triggerEnd } = makeControllableGenerator();
      pendingTriggerEnd = triggerEnd;
      return gen as any;
    }) as any);

    const api = buildMockApi();
    const server = buildAcServer(api);
    const s = server as any;
    s.active = true;
    s.connectedClients.add("127.0.0.1:54321");
    s.clientSockets.set("127.0.0.1:54321", { destroy: vi.fn() });

    await s.startNativeStream();
    // Let the pump consume the first frame so totalFramesReceived > 0 and
    // hadFrames=true (matters for onEnd's branch selection).
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(s.totalFramesReceived).toBeGreaterThan(0);
    expect(createCount).toBe(1);

    // Reproduce the inactivity-handler's synchronous flag flip — pre-fix this
    // suppressed onEnd's auto-restart.
    s.nativeStreamActive = false;
    s.nativeFanout = null;

    // End the source so the pump exits and onEnd fires.
    pendingTriggerEnd!();
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(createCount).toBeGreaterThanOrEqual(2);
  });

  it("schedules an unbounded retry when ensureConnected throws (issue #16 'never reestablishes' case)", async () => {
    // Real timers because we need setTimeout-based retry scheduling to fire.
    vi.useFakeTimers();

    let createCount = 0;
    vi.mocked(helpers.createNativeStream).mockImplementation((() => {
      createCount++;
      const { gen } = makeControllableGenerator();
      return gen as any;
    }) as any);

    // First two ensureConnected attempts fail (camera in maintenance reboot).
    // Third attempt: api.isReady is flipped to true by the test, so the code
    // path skips ensureConnected entirely and proceeds to start the fanout.
    const ensureConnected = vi
      .fn()
      .mockRejectedValueOnce(new Error("Baichuan timeout cmdId=3"))
      .mockRejectedValueOnce(new Error("Baichuan timeout cmdId=3"))
      .mockResolvedValue(undefined);

    const api: any = {
      client: {
        getTransport: () => "tcp" as const,
        getDebugConfig: () => ({ debugRtsp: false }),
      },
      isReady: false, // forces the ensureConnected branch
      isClosed: false,
      ensureConnected,
      createDedicatedSession: vi.fn().mockResolvedValue({
        client: {},
        release: vi.fn().mockResolvedValue(undefined),
      }),
      isStreamProfileRejected: () => false,
      logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };

    const server = buildAcServer(api);
    const s = server as any;
    s.active = true;
    s.connectedClients.add("127.0.0.1:54321");
    s.clientSockets.set("127.0.0.1:54321", { destroy: vi.fn() });

    // First attempt: ensureConnected rejects → retry scheduled (5 s).
    await s.startNativeStream();
    expect(ensureConnected).toHaveBeenCalledTimes(1);
    expect(createCount).toBe(0); // never got past ensureConnected
    expect(s.nativeStreamRetryTimer).toBeDefined();

    // Second attempt fires after 5 s, also rejects → backoff doubles (10 s).
    api.isReady = false;
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(ensureConnected).toHaveBeenCalledTimes(2);
    expect(createCount).toBe(0);
    expect(s.nativeStreamRetryTimer).toBeDefined();

    // Third attempt fires after another 10 s — by now the camera has come
    // back online, so api.isReady=true and the ensureConnected block is
    // skipped. The fanout starts and createCount finally increments.
    api.isReady = true;
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // ensureConnected is no longer called once the API reports ready.
    expect(ensureConnected).toHaveBeenCalledTimes(2);
    expect(createCount).toBe(1);
    expect(s.nativeStreamActive).toBe(true);

    vi.useRealTimers();
  });
});
