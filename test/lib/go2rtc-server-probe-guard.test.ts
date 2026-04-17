/**
 * Regression tests for the battery-camera "wake on real consumer" behavior
 * in Go2rtcTcpServer.
 *
 * Context (issue #8 — beta.16 regression):
 *   A previous version of this file tested a `go2rtcConsumerCheck` callback
 *   that tried to distinguish "real viewer" from "go2rtc probe" by reading
 *   go2rtc's `/api/streams` response and checking `streamInfo.consumers`.
 *   That approach was fundamentally broken: real go2rtc 1.9.x always reports
 *   `consumers: null` for TCP sources until media starts flowing, and media
 *   never flows unless we wake the camera first — chicken-and-egg. The guard
 *   therefore rejected *every* real viewer, leaving battery cameras
 *   permanently unreachable.
 *
 *   Two users confirmed the regression in issue #8 (comments
 *   issuecomment-4262851152 and issuecomment-4263338206): real RTSP clients
 *   would fail with `[rtsp] error="streams: EOF"` because our server
 *   destroyed the connection before the camera could wake up.
 *
 * Current contract (post-fix):
 *   Every TCP connection from go2rtc represents a real downstream consumer.
 *   Starting the native stream is therefore unconditional — the camera will
 *   wake even when it was idle-disconnected. The awake→sleep→awake loop that
 *   motivated the probe guard is addressed elsewhere: when the native stream
 *   ends for a battery camera, we drop all TCP clients (propagating EOF to
 *   go2rtc) instead of auto-restarting. This forces the next consumer to
 *   open a *new* TCP connection, which is then handled as a fresh wake-up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Go2rtcTcpServer } from "../../src/baichuan/stream/Go2rtcTcpServer.js";
import * as helpers from "../../src/rfc/helpers.js";

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------
vi.mock("../../src/rfc/helpers.js", () => ({
  createNativeStream: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hangs forever — simulates a battery camera that never sends frames. */
function makeSleepingGenerator() {
  // eslint-disable-next-line require-yield
  return (async function* () {
    await new Promise<never>(() => {});
  })();
}

/** Yields a single video frame then ends — simulates a camera that briefly
 * streams (hadFrames=true) and then the native stream closes (as happens
 * when a battery camera returns to sleep after the grace period). */
function makeBriefGenerator() {
  return (async function* () {
    yield {
      audio: false,
      data: Buffer.alloc(0),
      codec: null,
      sampleRate: null,
      microseconds: 0,
      videoType: "H264" as const,
      isKeyframe: true,
    };
  })();
}

/**
 * Minimal net.Socket mock for handleClient testing.
 * Tracks destroy() calls and exposes event handlers so tests can fire them.
 * Guards against re-entrant destroy() calls to prevent infinite recursion
 * (cleanup handler in handleClient calls socket.destroy() which would otherwise
 * re-fire close handlers → cleanup → destroy → loop).
 */
function buildMockSocket() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const socket = {
    setNoDelay: vi.fn(),
    remoteAddress: "127.0.0.1",
    remotePort: 54321,
    destroyed: false,
    destroy: vi.fn().mockImplementation(() => {
      if (socket.destroyed) return;
      socket.destroyed = true;
      for (const h of handlers["close"] ?? []) h(false);
    }),
    on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
      return socket;
    }),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  };
  return socket;
}

/** API mock simulating battery-camera idle-disconnect state (isReady=false). */
function buildIdleApi() {
  return {
    client: {
      getTransport: () => "tcp" as const,
      getDebugConfig: () => ({ debugRtsp: false }),
    },
    isReady: false,
    isClosed: false,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    createDedicatedSession: vi.fn().mockResolvedValue({
      client: {},
      release: vi.fn().mockResolvedValue(undefined),
    }),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

/** API mock simulating AC camera (or battery camera that is currently connected). */
function buildReadyApi() {
  return { ...buildIdleApi(), isReady: true } as any;
}

function buildBatteryServer(api: any) {
  return new Go2rtcTcpServer({
    api,
    channel: 0,
    profile: "sub",
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: false,
    gracePeriodMs: 5_000,
    streamTimeoutMs: 10_000,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  });
}

async function flushAsync() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Go2rtcTcpServer – battery-camera wake-on-connect (issue #8 regression)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(helpers.createNativeStream).mockReturnValue(
      makeSleepingGenerator() as any,
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. REGRESSION GUARD: every real TCP connect wakes an idle battery camera
  //    (previously the probe guard rejected all connections because go2rtc's
  //    consumers field is always null during the wake-up window)
  // -------------------------------------------------------------------------
  it("wakes a sleeping battery camera on every incoming TCP connection", async () => {
    const api = buildIdleApi();
    const server = buildBatteryServer(api);
    const s = server as any;
    s.active = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    await flushAsync();
    await vi.runAllTimersAsync();

    // ensureConnected was called exactly once — the camera is being woken
    expect(api.ensureConnected).toHaveBeenCalledTimes(1);
    // The socket was NOT destroyed (no probe rejection anymore)
    expect(socket.destroy).not.toHaveBeenCalled();
    // Native stream started
    expect(helpers.createNativeStream).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. When API is already ready (camera awake), stream starts immediately
  //    without re-connecting.
  // -------------------------------------------------------------------------
  it("starts native stream without reconnecting when API is already ready", async () => {
    const api = buildReadyApi();
    const server = buildBatteryServer(api);
    const s = server as any;
    s.active = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    await flushAsync();
    await vi.runAllTimersAsync();

    // API already ready → no ensureConnected needed
    expect(api.ensureConnected).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(helpers.createNativeStream).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. When native stream is already active, a second connection reuses it
  //    without spawning another native stream instance.
  // -------------------------------------------------------------------------
  it("reuses the running native stream for a concurrent second TCP client", async () => {
    const api = buildIdleApi();
    const server = buildBatteryServer(api);
    const s = server as any;
    s.active = true;
    s.nativeStreamActive = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    await flushAsync();
    await vi.runAllTimersAsync();

    // Stream was already running — no reconnect, no new createNativeStream call
    expect(api.ensureConnected).not.toHaveBeenCalled();
    expect(helpers.createNativeStream).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. AWAKE→SLEEP→AWAKE loop guard: when the battery native stream ends
  //    (camera slept), all open TCP clients are dropped so go2rtc propagates
  //    EOF to its consumers. Without this the old code would immediately
  //    restart the native stream and re-wake the camera — creating the
  //    ~60s loop reported in issue #8.
  // -------------------------------------------------------------------------
  it("drops open TCP clients when battery native stream ends (no auto-restart loop)", async () => {
    // First call yields a frame then ends. Second call (shouldn't happen —
    // that's the whole point of the test) returns a sleeping generator so
    // the test can't OOM via infinite restart.
    vi.mocked(helpers.createNativeStream)
      .mockReturnValueOnce(makeBriefGenerator() as any)
      .mockReturnValue(makeSleepingGenerator() as any);

    const api = buildIdleApi();
    const server = buildBatteryServer(api);
    const s = server as any;
    s.active = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    // Wait for the brief stream to emit its single frame and then end,
    // triggering the onEnd callback that exercises the drop-clients path.
    await flushAsync();
    await vi.runAllTimersAsync();
    await flushAsync();

    // createNativeStream was called exactly ONCE. No auto-restart.
    expect(helpers.createNativeStream).toHaveBeenCalledTimes(1);

    // The TCP client socket was destroyed by the onEnd handler so go2rtc
    // sees EOF and won't hold its RTSP consumer open against a dead source.
    expect(socket.destroy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. AC camera (prestartStream=true) should still auto-restart on EOF
  //    (the drop-client behavior is battery-only). Use mockReturnValueOnce
  //    for the first (ending) generator, then a sleeping generator forever
  //    so the restart eventually stabilizes and the test does not OOM.
  // -------------------------------------------------------------------------
  it("auto-restarts native stream on EOF for AC cameras (prestart=true)", async () => {
    vi.mocked(helpers.createNativeStream)
      .mockReturnValueOnce(makeBriefGenerator() as any)
      .mockReturnValue(makeSleepingGenerator() as any);

    const api = buildReadyApi();
    const server = new Go2rtcTcpServer({
      api,
      channel: 0,
      profile: "main",
      listenHost: "127.0.0.1",
      listenPort: 0,
      prestartStream: true,
      gracePeriodMs: 5_000,
      streamTimeoutMs: 10_000,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const s = server as any;
    s.active = true;

    // Kick off native stream (no client needed — prestart behavior)
    await s.startNativeStream();
    await flushAsync();
    await vi.runAllTimersAsync();
    await flushAsync();

    // Exactly two calls: initial + single restart after EOF
    expect(helpers.createNativeStream.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
