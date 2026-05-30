/**
 * Regression test for the createNativeStream abort-listener leak.
 *
 * Pre-fix: every idle sleep cycle inside the generator registered a fresh
 * `signal.addEventListener("abort", onAbort, { once: true })`. The `{ once }`
 * flag only auto-detaches the listener once it fires. When the sleep ended
 * via a frame arrival (the common case), the listener stayed attached and
 * accumulated linearly. Under live streaming at 30 fps this produced tens
 * of thousands of retained closures per hour, growing the heap and
 * progressively slowing the EventTarget dispatch path (visible CPU drift).
 *
 * Post-fix: a single lifetime listener is attached once and removed in the
 * `finally` block. This test asserts the listener count on the signal
 * stays bounded regardless of how many sleep cycles the generator goes
 * through.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks: stub BaichuanVideoStream so no real socket / camera is required.
// ---------------------------------------------------------------------------

class FakeVideoStream extends EventEmitter {
  async start(): Promise<void> {
    // no-op; the generator only awaits this once.
  }
  async stop(): Promise<void> {
    // no-op; cleanup path.
  }
}

let lastFakeStream: FakeVideoStream | null = null;

vi.mock("../../src/baichuan/stream/BaichuanVideoStream.js", () => ({
  BaichuanVideoStream: vi.fn().mockImplementation(function () {
    const s = new FakeVideoStream();
    lastFakeStream = s;
    return s;
  }),
}));

// Import AFTER vi.mock so the mocked BaichuanVideoStream is used.
import { createNativeStream } from "../../src/rfc/helpers.js";

// ---------------------------------------------------------------------------
// Helper: a minimal AbortSignal that exposes its current listener count.
// We wrap a native AbortController and count add/remove calls — the WHATWG
// AbortSignal API does not expose listener counts directly.
// ---------------------------------------------------------------------------

function makeCountedAbortController(): {
  controller: AbortController;
  signal: AbortSignal;
  abortListenerCount: () => number;
} {
  const controller = new AbortController();
  let count = 0;
  const realAdd = controller.signal.addEventListener.bind(controller.signal);
  const realRemove = controller.signal.removeEventListener.bind(controller.signal);
  // Intercept add/remove for the "abort" event only.
  controller.signal.addEventListener = ((
    type: string,
    listener: any,
    options?: any,
  ) => {
    if (type === "abort") count++;
    realAdd(type, listener, options);
  }) as typeof controller.signal.addEventListener;
  controller.signal.removeEventListener = ((
    type: string,
    listener: any,
    options?: any,
  ) => {
    if (type === "abort") count = Math.max(0, count - 1);
    realRemove(type, listener, options);
  }) as typeof controller.signal.removeEventListener;
  return {
    controller,
    signal: controller.signal,
    abortListenerCount: () => count,
  };
}

// ---------------------------------------------------------------------------
// Minimal ReolinkBaichuanApi stub. createNativeStream tries to acquire a
// dedicated session; we return a dummy client so it does not fall back to
// api.client (which we leave undefined to ensure the dedicated path is hit).
// ---------------------------------------------------------------------------

function buildMockApi() {
  return {
    client: {},
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    createDedicatedSession: vi.fn().mockResolvedValue({
      client: {},
      release: vi.fn().mockResolvedValue(undefined),
    }),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNativeStream — abort listener lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastFakeStream = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches at most one abort listener regardless of sleep cycles", async () => {
    const { controller, signal, abortListenerCount } = makeCountedAbortController();
    const api = buildMockApi();

    const gen = createNativeStream(api, 0, "main", { signal });

    // Drive past the 5 s codec-info race. After this point the generator is
    // sitting in its sleep/yield loop.
    const firstFramePromise = gen.next();
    await vi.advanceTimersByTimeAsync(5_000);

    // The generator is now alternating: short setTimeout(1000) sleeps
    // interleaved with frame deliveries from the fake stream's
    // videoAccessUnit emitter.
    expect(lastFakeStream).not.toBeNull();
    const fake = lastFakeStream!;

    // Helper: emit one synthetic H.264 frame.
    const emitFrame = () => {
      fake.emit("videoAccessUnit", {
        data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]),
        isKeyframe: true,
        videoType: "H264",
        microseconds: 0,
      });
    };

    // Resolve the first sleep with a frame so .next() returns.
    emitFrame();
    await firstFramePromise;

    // Run 200 sleep→frame cycles. Pre-fix this would attach 200 listeners.
    for (let i = 0; i < 200; i++) {
      const p = gen.next();
      // Let the generator enter the sleep promise.
      await Promise.resolve();
      // Advance a small slice so the setTimeout(1000) is set but not fired.
      await vi.advanceTimersByTimeAsync(10);
      emitFrame();
      await p;
    }

    // Post-fix: a single lifetime listener (≤ 1).
    expect(abortListenerCount()).toBeLessThanOrEqual(1);

    // Cleanly tear down the generator so the finally block runs.
    controller.abort();
    await gen.return(undefined);

    // After finally → listener removed.
    expect(abortListenerCount()).toBe(0);
  });

  it("aborting the signal wakes the idle sleep promptly", async () => {
    const { controller, signal, abortListenerCount } = makeCountedAbortController();
    const api = buildMockApi();

    const gen = createNativeStream(api, 0, "main", { signal });

    // Drive past codec-info race and into the sleep loop with no frames.
    const next = gen.next();
    await vi.advanceTimersByTimeAsync(5_000);
    // Let the empty queue path enter the sleep promise.
    await Promise.resolve();

    // Pre-fix: this would have N listeners by now (depending on cycles).
    // Post-fix: exactly one listener.
    expect(abortListenerCount()).toBe(1);

    // Aborting wakes the sleep and ends the loop without waiting for the
    // 1-second timeout.
    controller.abort();
    // The generator must complete; advance only a tiny slice — proves we
    // did not wait for the 1 s fallback timer.
    await vi.advanceTimersByTimeAsync(0);
    const result = await next;
    expect(result.done).toBe(true);

    // Finally has run → listener detached.
    expect(abortListenerCount()).toBe(0);
  });
});
