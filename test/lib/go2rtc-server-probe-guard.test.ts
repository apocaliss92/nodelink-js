/**
 * Tests for the battery-camera "probe wake loop" fix in Go2rtcTcpServer.
 *
 * Problem:
 *   go2rtc periodically reconnects to the Go2rtcTcpServer TCP port (~every 60s)
 *   even when no downstream client is watching, to "probe" if the source has data.
 *   For battery cameras (prestartStream=false + idle disconnect), each probe
 *   triggered startNativeStream() → ensureConnected() → camera woken → streaming
 *   starts → grace period fires → stream stops → repeat forever.
 *
 * Fix:
 *   `go2rtcConsumerCheck` callback option. When set AND the API is idle-disconnected,
 *   handleClient calls the check before startNativeStream(). If no consumers exist
 *   (probe), the socket is destroyed immediately without waking the camera.
 *
 * Test structure:
 *   1. BUG REPRODUCTION – without consumerCheck, every TCP connect wakes the camera
 *   2. FIX: probe rejected   – check returns false → socket destroyed, camera not woken
 *   3. FIX: real viewer      – check returns true  → stream starts, camera woken
 *   4. FIX: API already ready → check skipped, stream starts unconditionally
 *   5. FIX: check throws     → safe fallback, stream starts anyway
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
      if (socket.destroyed) return; // prevent re-entrant calls
      socket.destroyed = true;
      // Trigger registered 'close' handlers so removeClient fires
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
    isReady: false,   // idle-disconnected
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

function buildBatteryServer(
  api: any,
  go2rtcConsumerCheck?: () => Promise<boolean>,
) {
  return new Go2rtcTcpServer({
    api,
    channel: 0,
    profile: "sub",
    listenHost: "127.0.0.1",
    listenPort: 0,
    prestartStream: false,       // battery camera
    gracePeriodMs: 5_000,
    streamTimeoutMs: 10_000,
    go2rtcConsumerCheck,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  });
}

/**
 * Flush all pending microtasks.
 * The consumer-check path is a double-fire-and-forget
 * (handleClient → async lambda → startNativeStream), so we need enough
 * microtask ticks to drain the full promise chain.
 */
async function flushAsync() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Go2rtcTcpServer – battery-camera probe guard (go2rtcConsumerCheck)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Default: sleeping generator so startNativeStream doesn't crash
    vi.mocked(helpers.createNativeStream).mockReturnValue(
      makeSleepingGenerator() as any,
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. BUG REPRODUCTION: without consumerCheck, probe wakes camera
  // -------------------------------------------------------------------------
  it("(bug reproduction) wakes battery camera on every go2rtc probe when no consumerCheck is set", async () => {
    const api = buildIdleApi();
    const server = buildBatteryServer(api, /* no check */ undefined);
    const s = server as any;
    s.active = true; // bypass real TCP bind

    const socket = buildMockSocket();
    s.handleClient(socket);

    // Let the async startNativeStream flow complete
    await flushAsync();
    await vi.runAllTimersAsync();

    // Without the guard, startNativeStream() is called unconditionally →
    // ensureConnected() fires → camera is woken.
    expect(api.ensureConnected).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. FIX: consumerCheck returns false → socket destroyed, camera NOT woken
  // -------------------------------------------------------------------------
  it("rejects go2rtc probe connection without waking the camera when no consumers", async () => {
    const api = buildIdleApi();
    const consumerCheck = vi.fn().mockResolvedValue(false);
    const server = buildBatteryServer(api, consumerCheck);
    const s = server as any;
    s.active = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    // Let the consumer check resolve
    await flushAsync();
    await vi.runAllTimersAsync();

    // Consumer check was called
    expect(consumerCheck).toHaveBeenCalledTimes(1);

    // Socket must be destroyed (probe rejected)
    expect(socket.destroy).toHaveBeenCalled();

    // Camera must NOT have been woken — ensureConnected never called
    expect(api.ensureConnected).not.toHaveBeenCalled();

    // Native stream must not have started
    expect(s.nativeStreamActive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. FIX: consumerCheck returns true → stream starts, camera woken (real viewer)
  // -------------------------------------------------------------------------
  it("starts native stream when consumer check confirms real downstream consumers", async () => {
    const api = buildIdleApi();
    const consumerCheck = vi.fn().mockResolvedValue(true);
    const server = buildBatteryServer(api, consumerCheck);
    const s = server as any;
    s.active = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    await flushAsync();
    await vi.runAllTimersAsync();

    // Consumer check was called
    expect(consumerCheck).toHaveBeenCalledTimes(1);

    // Socket should NOT have been destroyed (it's a real viewer)
    expect(socket.destroy).not.toHaveBeenCalled();

    // Camera IS woken — ensureConnected fired inside startNativeStream
    // (api.isReady=false triggers ensureConnected call)
    expect(api.ensureConnected).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 4. FIX: API already ready (camera awake) → check skipped, stream starts
  // -------------------------------------------------------------------------
  it("skips consumer check when API is already connected and starts stream immediately", async () => {
    const api = buildReadyApi();             // isReady = true
    const consumerCheck = vi.fn().mockResolvedValue(false); // would reject if called
    const server = buildBatteryServer(api, consumerCheck);
    const s = server as any;
    s.active = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    await flushAsync();
    await vi.runAllTimersAsync();

    // Check must NOT be called — API already ready, no probe concern
    expect(consumerCheck).not.toHaveBeenCalled();

    // Socket must not be destroyed (not a probe rejection)
    expect(socket.destroy).not.toHaveBeenCalled();

    // API was not re-connected (already ready), but startNativeStream was called
    // — verified by createNativeStream being invoked (fanout created)
    expect(helpers.createNativeStream).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. FIX: consumerCheck throws → safe fallback, stream starts anyway
  // -------------------------------------------------------------------------
  it("falls back to starting native stream when consumer check throws", async () => {
    const api = buildIdleApi();
    const consumerCheck = vi.fn().mockRejectedValue(new Error("go2rtc unreachable"));
    const server = buildBatteryServer(api, consumerCheck);
    const s = server as any;
    s.active = true;

    const socket = buildMockSocket();
    s.handleClient(socket);

    await flushAsync();
    await vi.runAllTimersAsync();

    expect(consumerCheck).toHaveBeenCalledTimes(1);

    // Fallback: camera IS woken despite check throwing
    expect(api.ensureConnected).toHaveBeenCalledTimes(1);

    // Socket must not be destroyed (fallback allows streaming)
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Probe rejected while another client is already connected and streaming
  //    (second probe while native stream is active → check skipped, stream reused)
  // -------------------------------------------------------------------------
  it("skips check if native stream is already active (second probe or concurrent viewer)", async () => {
    const api = buildIdleApi();
    const consumerCheck = vi.fn().mockResolvedValue(false); // would block if checked
    const server = buildBatteryServer(api, consumerCheck);
    const s = server as any;
    s.active = true;
    s.nativeStreamActive = true; // simulate stream already running

    const socket = buildMockSocket();
    s.handleClient(socket);

    await flushAsync();
    await vi.runAllTimersAsync();

    // No check needed — stream already running
    expect(consumerCheck).not.toHaveBeenCalled();
    // Socket stays open (consumer gets fed by existing stream)
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
