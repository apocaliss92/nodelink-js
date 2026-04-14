/**
 * Regression tests for the battery-camera "sleeping restart loop" bug in
 * Go2rtcTcpServer.
 *
 * Scenario:
 *   1. go2rtc connects via TCP (client connected).
 *   2. Camera is sleeping — it never sends frames.
 *   3. BUG (pre-fix): streamHealthTimer fires after streamTimeoutMs, stops the
 *      fanout → onEnd fires → clients still connected → RESTART → loop repeats,
 *      waking the battery camera on every timeout cycle.
 *   4. FIX: onEnd checks lastFrameAt === 0 (no frames ever received) combined
 *      with prestartStream=false → skip restart and log "camera sleeping".
 *
 * Pattern mirrors test/lib/rtsp-server-sleep.test.ts. Uses vi.mock to intercept
 * createNativeStream so no real camera is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Go2rtcTcpServer } from "../../src/baichuan/stream/Go2rtcTcpServer.js";
import * as helpers from "../../src/rfc/helpers.js";

// ---------------------------------------------------------------------------
// Module-level mock — intercepts the import inside Go2rtcTcpServer.ts.
// ---------------------------------------------------------------------------
vi.mock("../../src/rfc/helpers.js", () => ({
  createNativeStream: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Generator factories
// ---------------------------------------------------------------------------

/** Simulates a sleeping battery camera: starts but never delivers a frame. */
function makeSleepingGenerator() {
  // eslint-disable-next-line require-yield
  return (async function* () {
    await new Promise<never>(() => {}); // hangs forever
  })();
}

/** Simulates an awake camera: delivers one IDR video frame then hangs. */
function makeAwakeGenerator() {
  return (async function* () {
    yield {
      audio: false,
      // Minimal Annex-B H.264 IDR NAL (start code + NAL type 0x65)
      data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x33]),
      codec: "H264" as string | null,
      sampleRate: null as number | null,
      microseconds: 1_000_000 as number | null,
      videoType: "H264" as "H264" | "H265",
      isKeyframe: true,
    };
    await new Promise<never>(() => {}); // hang after first frame (live stream)
  })();
}

/**
 * Simulates a camera that yields one frame then drops the connection.
 * Used to verify the onEnd → restart path for non-sleeping cameras.
 */
function makeFrameThenEndGenerator() {
  return (async function* () {
    yield {
      audio: false,
      data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x33]),
      codec: "H264" as string | null,
      sampleRate: null as number | null,
      microseconds: 1_000_000 as number | null,
      videoType: "H264" as "H264" | "H265",
      isKeyframe: true,
    };
    // stream ends — simulates mid-session drop
  })();
}

/** Simulates a camera that ends the stream immediately without any frames. */
function makeImmediateEndGenerator() {
  return (async function* () {
    // yields nothing — stream ends right away
  })();
}

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function buildMockApi() {
  return {
    client: {
      getTransport: () => "udp" as const,
      getDebugConfig: () => ({ debugRtsp: false }),
    },
    isReady: true,
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

/**
 * Creates a Go2rtcTcpServer with battery-camera timing (no prestart, short
 * timeout) and skips the real TCP server bind so tests are fully synchronous.
 *
 * streamTimeoutMs = 20 000  (20 s, fast enough for fake timers)
 * prestartStream  = false   (battery camera — on-demand only)
 */
function buildServer(api: any) {
  const server = new Go2rtcTcpServer({
    api,
    channel: 0,
    profile: "main",
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: false,
    gracePeriodMs: 10_000,
    streamTimeoutMs: 20_000,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  });
  return server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Go2rtcTcpServer – sleeping-camera restart-loop fix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Core fix: sleeping camera — stream timeout fires, no restart
  // -------------------------------------------------------------------------
  it("stops the stream after streamTimeoutMs when no frames arrive and does NOT restart", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(
      makeSleepingGenerator() as any,
    );

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;
    s.active = true; // simulate server already started (skips real TCP bind)

    // Simulate go2rtc connected — this is the bug scenario
    s.connectedClients.add("127.0.0.1:54321");
    s.clientSockets.set("127.0.0.1:54321", { destroy: vi.fn() });

    // Manually trigger startNativeStream (no real TCP server)
    await s.startNativeStream();

    expect(s.nativeStreamActive).toBe(true);
    expect(s.streamHealthTimer).toBeDefined();

    // Just before the 20 s timeout — stream still active
    await vi.advanceTimersByTimeAsync(19_999);
    expect(s.nativeStreamActive).toBe(true);

    // Past the timeout — health monitor force-stops the fanout → onEnd fires
    // With the fix: hadFrames=false + prestartStream=false → no restart
    await vi.advanceTimersByTimeAsync(5_001);
    await vi.runAllTimersAsync();

    expect(s.nativeStreamActive).toBe(false);

    // createNativeStream was called exactly once — no restart loop
    expect(helpers.createNativeStream).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 2. Immediate-end generator (sleeping camera without timeout — generator
  //    ends right away): same fix applies, onEnd must not restart
  // -------------------------------------------------------------------------
  it("does not restart after immediate stream end when no frames were received", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(
      makeImmediateEndGenerator() as any,
    );

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;
    s.active = true;

    s.connectedClients.add("127.0.0.1:54321");
    s.clientSockets.set("127.0.0.1:54321", { destroy: vi.fn() });

    await s.startNativeStream();

    // Run all microtasks so the generator finishes and onEnd fires
    await vi.runAllTimersAsync();

    expect(s.nativeStreamActive).toBe(false);
    // Only one call — no restart after sleeping end
    expect(helpers.createNativeStream).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 3. Awake camera — first frame arrives → stream stays alive, no timeout stop
  // -------------------------------------------------------------------------
  it("does not stop the stream when frames arrive normally (camera awake)", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(
      makeAwakeGenerator() as any,
    );

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;
    s.active = true;

    s.connectedClients.add("127.0.0.1:54321");
    s.clientSockets.set("127.0.0.1:54321", { destroy: vi.fn() });

    await s.startNativeStream();

    // Flush microtasks to let the async generator pump deliver the frame.
    // Using multiple Promise.resolve() instead of runAllTimersAsync so that
    // the health monitor interval is NOT advanced (avoids triggering the
    // silence timeout which is 20 s in this test).
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Frame must have been delivered
    expect(s.totalFramesReceived).toBeGreaterThan(0);
    expect(s.lastFrameAt).toBeGreaterThan(0);

    // Advance half the timeout — health monitor fires at +5 s but
    // silenceMs = 5 s < 20 s → no stop
    await vi.advanceTimersByTimeAsync(5_000);

    // Stream must still be alive
    expect(s.nativeStreamActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Camera was awake (had frames), stream drops → RESTART (normal behavior)
  // -------------------------------------------------------------------------
  it("restarts the stream in onEnd when camera had been sending frames", async () => {
    // First call: one frame then stream ends naturally (mid-session drop)
    // Second call: immediate-end so the test can settle cleanly
    vi.mocked(helpers.createNativeStream)
      .mockReturnValueOnce(makeFrameThenEndGenerator() as any)
      .mockReturnValueOnce(makeImmediateEndGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;
    s.active = true;

    s.connectedClients.add("127.0.0.1:54321");
    s.clientSockets.set("127.0.0.1:54321", { destroy: vi.fn() });

    await s.startNativeStream();

    // Let the first generator produce the frame then end → onEnd → restart
    await vi.runAllTimersAsync();

    // totalFramesReceived was incremented by onFrame → hadFrames=true in closure
    expect(s.totalFramesReceived).toBeGreaterThan(0);

    // createNativeStream called twice: initial + restart (hadFrames=true → skipRestart=false)
    expect(helpers.createNativeStream).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 5. prestartStream=true (AC camera) — stream ends immediately with no frames
  //    but SHOULD restart because AC cameras are always expected online
  // -------------------------------------------------------------------------
  it("restarts in onEnd for prestartStream=true even when no frames received (AC camera momentarily offline)", async () => {
    // First call: ends immediately with no frames (AC camera unreachable at start)
    // Second call: sleeping generator (hangs) so the test can assert without looping
    vi.mocked(helpers.createNativeStream)
      .mockReturnValueOnce(makeImmediateEndGenerator() as any)
      .mockReturnValueOnce(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = new Go2rtcTcpServer({
      api,
      channel: 0,
      profile: "main",
      listenHost: "127.0.0.1",
      listenPort: 0,
      prestartStream: true, // AC camera — always retry
      gracePeriodMs: 10_000,
      streamTimeoutMs: 20_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const s = server as any;
    s.active = true;

    await s.startNativeStream();

    // Flush microtasks to let the immediate-end generator finish → onEnd fires
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // prestartStream=true overrides the !hadFrames guard → restart must happen
    expect(helpers.createNativeStream).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 6. Grace timer fires after last client disconnects → stream stops
  //    (this is the normal battery-camera idle path, not the sleeping path)
  // -------------------------------------------------------------------------
  it("stops via grace timer when the last client disconnects (no frames scenario)", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(
      makeSleepingGenerator() as any,
    );

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;
    s.active = true;
    s.connectedClients.add("127.0.0.1:54321");
    s.clientSockets.set("127.0.0.1:54321", { destroy: vi.fn() });

    await s.startNativeStream();
    expect(s.nativeStreamActive).toBe(true);

    // Simulate client disconnect
    s.connectedClients.delete("127.0.0.1:54321");
    s.clientSockets.delete("127.0.0.1:54321");
    s.scheduleStop();

    // Before grace period — still active
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.nativeStreamActive).toBe(true);

    // Past grace period — stream stops
    await vi.advanceTimersByTimeAsync(1_002);
    expect(s.nativeStreamActive).toBe(false);

    // No restart (clientCount is 0)
    expect(helpers.createNativeStream).toHaveBeenCalledTimes(1);
  });
});
