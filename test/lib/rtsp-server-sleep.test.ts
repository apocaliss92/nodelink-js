/**
 * Regression tests for the battery-camera "sleeping watchdog" bug (v0.4.2-beta.14).
 *
 * Scenario:
 *   1. User closes stream (VLC / web preview disconnects).
 *   2. go2rtc immediately reconnects as an RTSP client.
 *   3. Camera is sleeping; it never sends frames.
 *   4. BUG (pre-fix): BaichuanVideoStream watchdog fires at 60 s idle and
 *      restarts the native stream, waking the battery camera unnecessarily.
 *   5. FIX: noFrameDeadlineTimer fires after ~30 s when firstFrameReceived is
 *      still false, stops the stream regardless of connected clients.
 *
 * These tests drive the BaichuanRtspServer state machine directly (via
 * `(server as any)`) and mock createNativeStream so no real camera is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaichuanRtspServer } from "../../src/baichuan/stream/BaichuanRtspServer.js";
import * as helpers from "../../src/rfc/helpers.js";

// ---------------------------------------------------------------------------
// Module-level mock — intercepts the import inside BaichuanRtspServer.ts.
// ---------------------------------------------------------------------------
vi.mock("../../src/rfc/helpers.js", () => ({
  createNativeStream: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Generator factories
// ---------------------------------------------------------------------------

/** Simulates a sleeping camera: starts but never delivers a frame. */
function makeSleepingGenerator() {
  return (async function* () {
    await new Promise<never>(() => {}); // hangs forever
  })();
}

/** Simulates an awake camera: delivers one synthetic H.264 frame then hangs. */
function makeAwakeGenerator() {
  return (async function* () {
    yield {
      audio: false,
      data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]), // minimal IDR NAL
      codec: "H264" as string | null,
      sampleRate: null as number | null,
      microseconds: null as number | null,
      videoType: "H264" as "H264" | "H265",
    };
    await new Promise<never>(() => {}); // hang after frame (live stream)
  })();
}

/**
 * Simulates a camera that yields one frame then drops the stream (connection lost).
 * Used to test the onEnd → restart path.
 */
function makeFrameThenEndGenerator() {
  return (async function* () {
    yield {
      audio: false,
      data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]),
      codec: "H264" as string | null,
      sampleRate: null as number | null,
      microseconds: null as number | null,
      videoType: "H264" as "H264" | "H265",
    };
    // stream ends after first frame (simulates mid-session drop)
  })();
}

/** Simulates a camera that ends the stream immediately without any frames. */
function makeImmediateEndGenerator() {
  return (async function* () {
    // yields nothing — stream ends right away
  })();
}

// ---------------------------------------------------------------------------
// Helper builders
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
    },
  } as any;
}

/**
 * Minimal flow stub — replaces the real rtspFlow created in the constructor
 * so tests do not require keep-alive timers or real codec negotiation.
 * getFmtp returns `hasParamSets: false` by default (no SPS/PPS → no
 * markFirstFrameReceived call from the fanout's onFrame path).
 * Override per test when you need markFirstFrameReceived to fire.
 */
function buildMockFlow(opts: { hasParamSets?: boolean } = {}) {
  return {
    startKeepAlive: vi.fn().mockResolvedValue(undefined),
    stopKeepAlive: vi.fn(),
    extractParameterSets: vi.fn(),
    getFmtp: vi.fn().mockReturnValue({ hasParamSets: opts.hasParamSets ?? false }),
    videoType: "H264",
  };
}

/**
 * Creates a BaichuanRtspServer with battery-camera timing (15 s prime, 30 s deadline)
 * and replaces its flow with a mock so no real network setup is performed.
 *
 * nativeStreamPrimeIdleStopMs = 15 000  →  noFrameDeadlineMs = min(30 000, 30 000) = 30 000
 */
function buildServer(api: any, flowOpts?: { hasParamSets?: boolean }) {
  const server = new BaichuanRtspServer({
    api,
    channel: 0,
    profile: "main",
    externalListener: true, // no real TCP server
    nativeStreamIdleStopMs: 15_000,
    nativeStreamPrimeIdleStopMs: 15_000,
    listenPort: 0,
  });
  (server as any).flow = buildMockFlow(flowOpts);
  return server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BaichuanRtspServer – sleeping-camera watchdog fix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Core fix: noFrameDeadlineTimer stops the stream on sleeping camera
  // -------------------------------------------------------------------------
  it("stops the stream after noFrameDeadlineMs when no frames arrive (sleeping camera)", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    // Simulate go2rtc connected — this is what prevents noClientAutoStopTimer
    // from acting and is the exact bug scenario.
    s.connectedClients.add("127.0.0.1:54321");

    await s.startNativeStream();

    expect(s.nativeStreamActive).toBe(true);
    expect(s.firstFrameReceived).toBe(false);
    // Deadline timer must be set
    expect(s.noFrameDeadlineTimer).toBeDefined();

    // Just before the 30 s deadline — stream still active
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.nativeStreamActive).toBe(true);

    // Past the deadline — stream must be stopped
    await vi.advanceTimersByTimeAsync(2);
    expect(s.nativeStreamActive).toBe(false);
    expect(s.noFrameDeadlineTimer).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. noClientAutoStopTimer fires but does NOT stop stream when client present
  //    (verifies the bug precondition — go2rtc cancels the only stopper)
  // -------------------------------------------------------------------------
  it("noClientAutoStopTimer does not fire when a client is connected", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    // Advance past noClientAutoStopTimer (15 s) but before noFrameDeadlineTimer (30 s)
    await vi.advanceTimersByTimeAsync(16_000);

    // Client is still there; noClientAutoStopTimer should not have stopped the stream
    expect(s.nativeStreamActive).toBe(true);

    // Confirm noFrameDeadlineTimer is still pending
    expect(s.noFrameDeadlineTimer).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 3. First frame clears the deadline timer (awake camera — normal operation)
  // -------------------------------------------------------------------------
  it("clears the deadline timer when the first frame arrives (camera awake)", async () => {
    // hasParamSets=true makes the onFrame handler call markFirstFrameReceived
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeAwakeGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api, { hasParamSets: true });
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    expect(s.noFrameDeadlineTimer).toBeDefined();

    // Let the generator pump run — the first frame is delivered as a microtask
    await vi.runAllTimersAsync();

    // Frame arrived → timer cleared, stream still active
    expect(s.noFrameDeadlineTimer).toBeUndefined();
    expect(s.nativeStreamActive).toBe(true);
    expect(s.firstFrameReceived).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. onEnd with hadFrames=false does NOT restart the stream
  //    (prevents the pre-fix loop: onEnd → restart → sleeping → 60 s watchdog)
  // -------------------------------------------------------------------------
  it("does not restart the stream in onEnd when camera never sent frames", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeImmediateEndGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    // go2rtc connected — in the old code this would trigger a restart
    s.connectedClients.add("127.0.0.1:54321");

    await s.startNativeStream();

    // Let the generator finish and all async callbacks (releaseAndRestart) settle
    await vi.runAllTimersAsync();

    const startSpy = vi.spyOn(s, "startNativeStream");

    // Advance past restart delay — no restart should be scheduled
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    // startNativeStream must NOT have been called again
    expect(startSpy).toHaveBeenCalledTimes(0);
    expect(s.nativeStreamActive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. onEnd WITH frames DOES restart (normal reconnect after real stream drop)
  //    Generator: yields one frame (sets hadFrames=true), then stream ends.
  // -------------------------------------------------------------------------
  it("restarts the stream in onEnd when camera had been sending frames", async () => {
    // First call: yields a frame then stream ends naturally (drop mid-session)
    // Second call (restart): ends immediately so the test can finish cleanly
    vi.mocked(helpers.createNativeStream)
      .mockReturnValueOnce(makeFrameThenEndGenerator() as any)
      .mockReturnValueOnce(makeImmediateEndGenerator() as any);

    const api = buildMockApi();
    // hasParamSets=true so the onFrame callback calls markFirstFrameReceived
    const server = buildServer(api, { hasParamSets: true });
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");

    // Start the stream; first frame will mark hadFrames=true, then stream ends
    await s.startNativeStream();

    // Set up spy AFTER the initial call so we only count restarts
    const startSpy = vi.spyOn(s, "startNativeStream");

    // Let microtasks run (generator ends → onEnd fires → releaseAndRestart queued)
    await vi.runAllTimersAsync();

    // Advance past the 500 ms restart delay inside releaseAndRestart
    await vi.advanceTimersByTimeAsync(600);
    await vi.runAllTimersAsync();

    // Exactly one restart (from onEnd after a real stream drop)
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 6. stopNativeStream cancels the deadline timer
  //    (uses a mock fanout.stop to avoid hanging on a never-resolving generator)
  // -------------------------------------------------------------------------
  it("cancels the deadline timer when stopNativeStream is called explicitly", async () => {
    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    // Manually replicate the state that startNativeStream would establish,
    // without running a real generator (which would hang on fake timers).
    s.nativeStreamActive = true;
    s.firstFrameResolve = () => {};
    s.firstAudioResolve = () => {};
    s.noFrameDeadlineTimer = setTimeout(() => {}, 30_000);
    // Replace fanout with a stub whose stop() resolves immediately
    s.nativeFanout = { stop: vi.fn().mockResolvedValue(undefined) };

    expect(s.noFrameDeadlineTimer).toBeDefined();

    await s.stopNativeStream();

    expect(s.noFrameDeadlineTimer).toBeUndefined();
    expect(s.nativeStreamActive).toBe(false);
  });

  // =========================================================================
  // Bug 3 — Battery camera wakeup has no effect (beta.14 regression)
  //
  // Scenario (from ticket log):
  //   [BaichuanClient] connected
  //   Publishing .../sleeping / battery / charger / sleeping
  //   [BaichuanClient] idle_disconnect
  //   Battery camera idle disconnect — RTSP listener retained
  //
  // Root cause: go2rtc registers an ffmpeg source that ingests from the
  // BaichuanRtspServer RTSP URL directly (Bug 2). ffmpeg fails with
  // "Invalid data found" → no RTSP client ever connects → noClientAutoStopTimer
  // fires → native stream stops → camera idle-disconnects immediately.
  // =========================================================================

  // -------------------------------------------------------------------------
  // 7. Bug 3 exact scenario: no RTSP client connects (simulates ffmpeg failure)
  //    noClientAutoStopTimer fires at 15 s → stops stream → camera goes back
  //    to sleep.  This proves the stream IS stopped before the camera can send
  //    any video, which matches the "no effect at all" wakeup report.
  // -------------------------------------------------------------------------
  it("Bug 3: noClientAutoStopTimer stops stream when no RTSP client connects (ffmpeg failure)", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    // go2rtc is NOT connected (ffmpeg source failed to open the RTSP URL)
    expect(s.connectedClients.size).toBe(0);

    await s.startNativeStream();

    expect(s.nativeStreamActive).toBe(true);
    // Both timers must be active after stream start
    expect(s.noClientAutoStopTimer).toBeDefined();
    expect(s.noFrameDeadlineTimer).toBeDefined();

    // Just before the 15 s noClientAutoStopTimer — stream still active
    await vi.advanceTimersByTimeAsync(14_999);
    expect(s.nativeStreamActive).toBe(true);

    // Past 15 s → noClientAutoStopTimer fires; connectedClients.size === 0 → stop
    await vi.advanceTimersByTimeAsync(2);
    expect(s.nativeStreamActive).toBe(false);
    // Both timers must be cleared by stopNativeStream
    expect(s.noClientAutoStopTimer).toBeUndefined();
    expect(s.noFrameDeadlineTimer).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8. Both timers are set on startNativeStream regardless of client count
  //    (verifies the stream can self-terminate via either path)
  // -------------------------------------------------------------------------
  it("both noClientAutoStopTimer and noFrameDeadlineTimer are set on stream start", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    await s.startNativeStream();

    expect(s.noClientAutoStopTimer).toBeDefined();  // fires at 15 s (no-PLAY guard)
    expect(s.noFrameDeadlineTimer).toBeDefined();   // fires at 30 s (sleeping guard)
  });

  // -------------------------------------------------------------------------
  // 9. noClientAutoStopTimer is a no-op when a client IS connected
  //    (avoids killing an active stream when go2rtc connects successfully)
  // -------------------------------------------------------------------------
  it("noClientAutoStopTimer does NOT stop stream when a client is connected at fire time", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    // Simulate go2rtc connected BEFORE the timer fires
    s.connectedClients.add("127.0.0.1:54321");

    await s.startNativeStream();

    // Advance past noClientAutoStopTimer (15 s)
    await vi.advanceTimersByTimeAsync(16_000);

    // Client is present → timer callback saw connectedClients.size > 0 → no-op
    expect(s.nativeStreamActive).toBe(true);
    // noFrameDeadlineTimer is still pending (will fire at 30 s)
    expect(s.noFrameDeadlineTimer).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 10. When noClientAutoStopTimer fires (no clients), it also clears
  //     noFrameDeadlineTimer — no double-stop race.
  // -------------------------------------------------------------------------
  it("noClientAutoStopTimer clears noFrameDeadlineTimer when it stops the stream", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    await s.startNativeStream();
    expect(s.noFrameDeadlineTimer).toBeDefined();

    // Let noClientAutoStopTimer fire (15 s, no clients connected)
    await vi.advanceTimersByTimeAsync(16_000);

    // stopNativeStream was called → clearNoFrameDeadlineTimer() → undefined
    expect(s.noFrameDeadlineTimer).toBeUndefined();
    expect(s.nativeStreamActive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 11. noClientAutoStopTimer fires 15 s BEFORE noFrameDeadlineTimer (30 s)
  //     when no clients are connected — the faster timer wins.
  // -------------------------------------------------------------------------
  it("noClientAutoStopTimer (15 s) fires before noFrameDeadlineTimer (30 s) when no clients", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    await s.startNativeStream();

    // At 15 s: noClientAutoStopTimer fires first → stream stops
    await vi.advanceTimersByTimeAsync(15_001);
    expect(s.nativeStreamActive).toBe(false);

    // noFrameDeadlineTimer must be cleared (no 30 s ghost timer)
    expect(s.noFrameDeadlineTimer).toBeUndefined();

    // Advancing to 30 s must not trigger any additional effects
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.nativeStreamActive).toBe(false); // still stopped, not restarted
  });

  // -------------------------------------------------------------------------
  // 12. noFrameDeadlineTimer (30 s) fires when a client IS connected but the
  //     camera is sleeping (the key scenario from test 1), confirming the
  //     noClientAutoStopTimer does NOT interfere.
  // -------------------------------------------------------------------------
  it("noFrameDeadlineTimer fires at 30 s even when noClientAutoStopTimer was a no-op (client present)", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    // go2rtc client connected → noClientAutoStopTimer will be a no-op
    s.connectedClients.add("127.0.0.1:54321");

    await s.startNativeStream();

    // 15 s passes: noClientAutoStopTimer fires but client is present → no-op
    await vi.advanceTimersByTimeAsync(16_000);
    expect(s.nativeStreamActive).toBe(true);
    expect(s.noFrameDeadlineTimer).toBeDefined();

    // 30 s passes: noFrameDeadlineTimer fires → camera sleeping → stop
    await vi.advanceTimersByTimeAsync(14_001);
    expect(s.nativeStreamActive).toBe(false);
    expect(s.noFrameDeadlineTimer).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 13. After noFrameDeadlineTimer stops the stream, a subsequent
  //     startNativeStream call resets both timers (on-demand reconnect works)
  // -------------------------------------------------------------------------
  it("timers are reset on subsequent startNativeStream after noFrameDeadlineTimer fired", async () => {
    // First call: sleeping → noFrameDeadlineTimer fires
    vi.mocked(helpers.createNativeStream)
      .mockReturnValueOnce(makeSleepingGenerator() as any)
      .mockReturnValueOnce(makeSleepingGenerator() as any); // second start also sleeping

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    // Let noFrameDeadlineTimer fire (30 s)
    await vi.advanceTimersByTimeAsync(31_000);
    expect(s.nativeStreamActive).toBe(false);

    // Simulate a new go2rtc connection attempt (on-demand wakeup)
    await s.startNativeStream();

    // Both timers must be freshly set for the new stream session
    expect(s.nativeStreamActive).toBe(true);
    expect(s.noFrameDeadlineTimer).toBeDefined();
    expect(s.noClientAutoStopTimer).toBeDefined();
  });

  // =========================================================================
  // Audio detection — ADTS AAC frame parsing (Bug 1 companion)
  //
  // These tests verify that BaichuanRtspServer correctly detects ADTS AAC
  // frames from any transport (TCP or UDP/BCUDP), as fixed in beta.13.
  // The audio regression in beta.14 is in buildGo2rtcSources (missing
  // #audio=copy in the ffmpeg transcode source), NOT in the server's detection.
  // These tests document that the server-side detection is correct.
  // =========================================================================

  // -------------------------------------------------------------------------
  // 14. isAdtsAacFrame detects ADTS syncword (0xFFF)
  // -------------------------------------------------------------------------
  it("isAdtsAacFrame returns true for valid ADTS syncword", () => {
    const isAdts = (BaichuanRtspServer as any).isAdtsAacFrame;

    // 0xFF 0xF1 = syncword (0xFFF) + ID=0 (MPEG-4) + protection_absent=1
    expect(isAdts(Buffer.from([0xff, 0xf1, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBe(true);
    // 0xFF 0xF9 = syncword + ID=1 (MPEG-2)
    expect(isAdts(Buffer.from([0xff, 0xf9, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBe(true);
  });

  it("isAdtsAacFrame returns false for video/non-AAC data", () => {
    const isAdts = (BaichuanRtspServer as any).isAdtsAacFrame;

    // Annex-B start code
    expect(isAdts(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]))).toBe(false);
    // Short buffer
    expect(isAdts(Buffer.from([0xff]))).toBe(false);
    // All zeros
    expect(isAdts(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 15. parseAdtsSamplingInfo extracts sample rate and channel config
  // -------------------------------------------------------------------------
  it("parseAdtsSamplingInfo extracts 44100 Hz, stereo from a typical ADTS header", () => {
    const parse = (BaichuanRtspServer as any).parseAdtsSamplingInfo;

    // ADTS header for LC, 44100 Hz (index=4), 2 channels:
    // byte0: 0xFF
    // byte1: 0xF1  (syncword=0xFFF, ID=0, layer=0, protection_absent=1)
    // byte2: bits: profile(2)=01 | samplingIdx(4)=0100 | private(1)=0 | channelConf MSB(1)=0
    //        = 0b01_0100_00 = 0x50
    // byte3: bits: channelConf(2)=10 | originality(1)=0 | home(1)=0 | ...
    //        = 0b10_00_0000 = 0x80
    // bytes 4-6: frame length etc (values don't matter for sampling info)
    const buf = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);
    const info = parse(buf);
    expect(info).not.toBeNull();
    expect(info!.sampleRate).toBe(44100);
    expect(info!.channels).toBe(2);
    expect(info!.configHex).toBeTruthy();
  });

  it("parseAdtsSamplingInfo returns null for non-ADTS data", () => {
    const parse = (BaichuanRtspServer as any).parseAdtsSamplingInfo;

    expect(parse(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x00, 0x00]))).toBeNull();
    expect(parse(Buffer.from([0xff, 0xf1]))).toBeNull(); // too short (< 7 bytes)
  });

  it("parseAdtsSamplingInfo returns null for unsupported sampling frequency index", () => {
    const parse = (BaichuanRtspServer as any).parseAdtsSamplingInfo;

    // Set sampling index to 13 (reserved/out-of-range)
    // byte2: profile(2)=01 | samplingIdx(4)=1101 | ... = 0b01_1101_00 = 0x74
    const buf = Buffer.from([0xff, 0xf1, 0x74, 0x80, 0x00, 0x1f, 0xfc]);
    expect(parse(buf)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 16. Audio is detected on first valid ADTS frame regardless of transport
  //     (regression from beta.13 removing the TCP-only guard)
  // -------------------------------------------------------------------------
  it("hasAudio is set after first ADTS AAC frame (transport-agnostic)", async () => {
    // Use an audio-yielding generator
    const audioFrame = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);
    const makeAudioGenerator = () =>
      (async function* () {
        yield { audio: true, data: audioFrame, codec: null, sampleRate: null, microseconds: null };
        await new Promise<never>(() => {});
      })();

    vi.mocked(helpers.createNativeStream).mockReturnValue(makeAudioGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    await s.startNativeStream();
    expect(s.hasAudio).toBe(false);

    // Let the generator pump run — audio frame arrives as microtask
    await vi.runAllTimersAsync();

    expect(s.hasAudio).toBe(true);
    expect(s.audioInfo).not.toBeNull();
    expect(s.audioInfo!.codec).toBe("aac-adts");
    expect(s.audioInfo!.sampleRate).toBe(44100);
  });
});

// =============================================================================
// Battery camera wakeup path — ensureConnected() scenarios
//
// Scenario from ticket (Bug 3):
//   [BaichuanClient] connected           ← camera woke for API/MQTT
//   Publishing .../sleeping / battery / charger / sleeping
//   [BaichuanClient] idle_disconnect     ← camera goes back to sleep
//   Battery camera idle disconnect — RTSP listener retained for on-demand streaming
//
// After the camera idle_disconnects, api.isReady = false.
// When go2rtc (with Bug 2 FIXED) reconnects as an RTSP client, BaichuanRtspServer
// calls startNativeStream(), which must call ensureConnected() to wake the camera.
// These tests cover every branch of that logic.
// =============================================================================

describe("BaichuanRtspServer — battery wakeup via ensureConnected()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── helpers ───────────────────────────────────────────────────────────────

  function buildIdleDisconnectedApi() {
    return {
      client: {
        getTransport: () => "udp" as const,
        getDebugConfig: () => ({ debugRtsp: false }),
      },
      isReady: false,   // camera is idle_disconnected — control socket closed
      isClosed: false,  // API object itself is still valid
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      createDedicatedSession: vi.fn().mockResolvedValue({
        client: {},
        release: vi.fn().mockResolvedValue(undefined),
      }),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as any;
  }

  function buildClosedApi() {
    return {
      client: {
        getTransport: () => "udp" as const,
        getDebugConfig: () => ({ debugRtsp: false }),
      },
      isReady: false,
      isClosed: true,   // API explicitly closed — no reconnect possible
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      createDedicatedSession: vi.fn().mockResolvedValue({
        client: {},
        release: vi.fn().mockResolvedValue(undefined),
      }),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as any;
  }

  // ─── A. Normal wakeup: idle_disconnect → ensureConnected succeeds ──────────

  // ---------------------------------------------------------------------------
  // 17. When api.isReady=false and api.isClosed=false, ensureConnected() is
  //     called before starting the native stream (the wakeup signal).
  // ---------------------------------------------------------------------------
  it("calls ensureConnected() when api is idle_disconnected before starting stream", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildIdleDisconnectedApi();
    const server = buildServer(api);
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");

    await s.startNativeStream();

    // Must have called ensureConnected() to wake the camera
    expect(api.ensureConnected).toHaveBeenCalledTimes(1);
    // Stream must have started after wakeup
    expect(s.nativeStreamActive).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 18. When api.isReady=true, ensureConnected() is NOT called
  //     (already connected — avoid unnecessary round-trips).
  // ---------------------------------------------------------------------------
  it("does NOT call ensureConnected() when api is already ready", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi(); // isReady = true
    const server = buildServer(api);
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    expect(api.ensureConnected).not.toHaveBeenCalled();
    expect(s.nativeStreamActive).toBe(true);
  });

  // ─── B. ensureConnected() fails ──────────────────────────────────────────

  // ---------------------------------------------------------------------------
  // 19. When ensureConnected() throws, the stream must NOT start.
  //     Camera stays sleeping; nativeStreamActive stays false.
  // ---------------------------------------------------------------------------
  it("aborts stream start when ensureConnected() fails", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildIdleDisconnectedApi();
    api.ensureConnected = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const server = buildServer(api);
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    // Stream must NOT have started
    expect(s.nativeStreamActive).toBe(false);
    // Timers must NOT be set (stream never started)
    expect(s.noFrameDeadlineTimer).toBeUndefined();
    expect(s.noClientAutoStopTimer).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 20. When ensureConnected() fails, createNativeStream is never called
  //     (the camera was never woken for streaming).
  // ---------------------------------------------------------------------------
  it("never calls createNativeStream when ensureConnected() fails", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildIdleDisconnectedApi();
    api.ensureConnected = vi.fn().mockRejectedValue(new Error("Timeout"));

    const server = buildServer(api);
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    expect(helpers.createNativeStream).not.toHaveBeenCalled();
  });

  // ─── C. api.isClosed=true — no reconnect attempt ─────────────────────────

  // ---------------------------------------------------------------------------
  // 21. When api.isClosed=true, startNativeStream exits immediately
  //     without calling ensureConnected().
  // ---------------------------------------------------------------------------
  it("does NOT call ensureConnected() when api is explicitly closed", async () => {
    const api = buildClosedApi();
    const server = buildServer(api);
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    expect(api.ensureConnected).not.toHaveBeenCalled();
    expect(s.nativeStreamActive).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 22. isClosed=true prevents stream start even if called multiple times
  //     (idempotent guard).
  // ---------------------------------------------------------------------------
  it("stream stays inactive on repeated startNativeStream calls when api is closed", async () => {
    const api = buildClosedApi();
    const server = buildServer(api);
    const s = server as any;

    await s.startNativeStream();
    await s.startNativeStream();

    expect(s.nativeStreamActive).toBe(false);
    expect(api.ensureConnected).not.toHaveBeenCalled();
  });

  // ─── D. RTSP client connect (SETUP) clears noClientAutoStopTimer ──────────
  //
  // When Bug 2 is fixed, go2rtc uses the native RTSP source → it connects as an
  // RTSP client at SETUP time → clearNoClientAutoStopTimer() is called.
  // This sequence must prevent the 15-s timer from killing the stream prematurely.

  // ---------------------------------------------------------------------------
  // 23. clearNoClientAutoStopTimer() cancels the timer so it does not fire
  //     after a client connects.
  // ---------------------------------------------------------------------------
  it("clearNoClientAutoStopTimer cancels the timer when called before it fires", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildMockApi();
    const server = buildServer(api);
    const s = server as any;

    await s.startNativeStream();
    expect(s.noClientAutoStopTimer).toBeDefined();

    // Simulate RTSP SETUP: client connects, timer cancelled
    s.connectedClients.add("127.0.0.1:54321");
    s.clearNoClientAutoStopTimer();

    expect(s.noClientAutoStopTimer).toBeUndefined();

    // Advance past the original 15 s window — timer was cancelled, no stop
    await vi.advanceTimersByTimeAsync(16_000);
    expect(s.nativeStreamActive).toBe(true); // still running, handled by noFrameDeadlineTimer
  });

  // ---------------------------------------------------------------------------
  // 24. Full wakeup sequence: idle_disconnect → RTSP client connects →
  //     ensureConnected() → stream starts → noFrameDeadlineTimer guards sleep.
  //
  // This is the end-to-end scenario that should work after Bug 2 is fixed:
  //   1. api.isReady=false (camera idle_disconnected after prior session)
  //   2. go2rtc connects as RTSP client (SETUP) → clears noClientAutoStopTimer
  //   3. startNativeStream → ensureConnected() wakes camera
  //   4. Camera is still sleeping (no frames) → noFrameDeadlineTimer fires at 30s
  // ---------------------------------------------------------------------------
  it("full wakeup sequence: idle_disconnect → ensureConnected → sleeping → deadline fires", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeSleepingGenerator() as any);

    const api = buildIdleDisconnectedApi();
    const server = buildServer(api);
    const s = server as any;

    // Step 1: RTSP client connects (SETUP) — simulates go2rtc connecting after Bug 2 fix
    s.connectedClients.add("127.0.0.1:54321");

    // Step 2: Simulate clearNoClientAutoStopTimer being called at SETUP
    // (in real code this happens at line 1103 before startNativeStream)
    // We call startNativeStream directly as the SETUP handler does.
    await s.startNativeStream();

    // ensureConnected() must have been called to wake the camera
    expect(api.ensureConnected).toHaveBeenCalledTimes(1);
    expect(s.nativeStreamActive).toBe(true);

    // noFrameDeadlineTimer must be set (camera may still be sleeping)
    expect(s.noFrameDeadlineTimer).toBeDefined();

    // noClientAutoStopTimer should also be set (reset on startNativeStream)
    // but client IS connected, so when it fires it will be a no-op.
    expect(s.noClientAutoStopTimer).toBeDefined();

    // Advance past 15 s — timer fires but client is present → no-op
    await vi.advanceTimersByTimeAsync(16_000);
    expect(s.nativeStreamActive).toBe(true); // camera still streaming attempt

    // Advance to 30 s — noFrameDeadlineTimer fires → camera sleeping → stop
    await vi.advanceTimersByTimeAsync(14_001);
    expect(s.nativeStreamActive).toBe(false);
    expect(s.noFrameDeadlineTimer).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 25. Full wakeup sequence: idle_disconnect → ensureConnected → camera AWAKE
  //     → frames arrive → stream stays alive (the happy path).
  // ---------------------------------------------------------------------------
  it("full wakeup sequence: idle_disconnect → ensureConnected → frames arrive → stream active", async () => {
    vi.mocked(helpers.createNativeStream).mockReturnValue(makeAwakeGenerator() as any);

    const api = buildIdleDisconnectedApi();
    const server = buildServer(api, { hasParamSets: true }); // SPS/PPS in first frame
    const s = server as any;

    s.connectedClients.add("127.0.0.1:54321");
    await s.startNativeStream();

    expect(api.ensureConnected).toHaveBeenCalledTimes(1);
    expect(s.nativeStreamActive).toBe(true);
    expect(s.noFrameDeadlineTimer).toBeDefined();

    // Let the generator pump run — first frame arrives (camera awake)
    await vi.runAllTimersAsync();

    // Frame received → deadline timer cleared, stream still active
    expect(s.firstFrameReceived).toBe(true);
    expect(s.noFrameDeadlineTimer).toBeUndefined();
    expect(s.nativeStreamActive).toBe(true);
  });
});
