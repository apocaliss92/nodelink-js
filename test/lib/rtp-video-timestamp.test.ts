import { describe, it, expect } from "vitest";
import {
  deriveRtpVideoTimestamp,
  type RtpVideoTimestampState,
} from "../../src/baichuan/stream/rtpVideoTimestamp";

const U32 = 0x1_0000_0000; // 2^32
const CLOCK = 90000; // RTP video clock (Hz)
const FPS = 20;
const FRAME_US = 1_000_000 / FPS; // 50_000 µs between frames
const TICKS_PER_FRAME = Math.round((FRAME_US * CLOCK) / 1_000_000); // 4500

/** Fresh anchor state, mirroring how the RTSP server seeds resources. */
function initialState(): RtpVideoTimestampState {
  return { baseTimestamp: 0, timestamp: 0 };
}

/** Wire value: the camera emits a 32-bit µs clock that wraps at 2^32. */
function rawUs(trueUs: number): number {
  return trueUs % U32;
}

describe("deriveRtpVideoTimestamp", () => {
  it("anchors on the first frame without advancing the RTP timestamp", () => {
    const { timestamp, state } = deriveRtpVideoTimestamp(
      initialState(),
      1_000_000,
      CLOCK,
    );
    expect(timestamp).toBe(0);
    expect(state.baseUnwrappedUs).toBe(1_000_000);
  });

  it("ignores null/undefined/non-finite microseconds", () => {
    const seeded = deriveRtpVideoTimestamp(initialState(), 1_000_000, CLOCK)
      .state;
    for (const bad of [null, undefined, NaN, Infinity]) {
      const { timestamp, state } = deriveRtpVideoTimestamp(seeded, bad, CLOCK);
      expect(timestamp).toBe(seeded.timestamp);
      expect(state).toBe(seeded);
    }
  });

  it("paces a normal short run linearly at the source rate", () => {
    let state = initialState();
    let prev = 0;
    for (let i = 0; i < 200; i++) {
      const res = deriveRtpVideoTimestamp(state, i * FRAME_US, CLOCK);
      state = res.state;
      if (i > 0) {
        expect((res.timestamp - prev) >>> 0).toBe(TICKS_PER_FRAME);
      }
      prev = res.timestamp;
    }
  });

  // The core regression: a stream that runs past 2^32 µs of *elapsed* time
  // (≈ 71.6 min) must keep advancing at the source rate, not flatline.
  it("keeps advancing past the 2^32 µs elapsed boundary (no flatline)", () => {
    const baseTrueUs = 1_000_000_000; // arbitrary camera-clock phase
    // Enough frames to cross 2^32 µs of elapsed time, plus margin.
    const totalFrames = Math.ceil(U32 / FRAME_US) + 500;

    let state = deriveRtpVideoTimestamp(
      initialState(),
      rawUs(baseTrueUs),
      CLOCK,
    ).state;

    let prev = 0;
    let crossed = false;
    for (let i = 1; i <= totalFrames; i++) {
      const trueUs = baseTrueUs + i * FRAME_US;
      const res = deriveRtpVideoTimestamp(state, rawUs(trueUs), CLOCK);
      state = res.state;

      // Every step advances by exactly one frame in the 90 kHz clock,
      // accounting for the legitimate 32-bit RTP timestamp wrap.
      expect((res.timestamp - prev) >>> 0).toBe(TICKS_PER_FRAME);
      prev = res.timestamp;

      const elapsedUs = i * FRAME_US;
      if (elapsedUs > U32) crossed = true;
    }
    expect(crossed).toBe(true);
    // Unwrapped accumulator tracks true elapsed exactly.
    expect(state.unwrappedUs).toBe(baseTrueUs + totalFrames * FRAME_US);
  });

  // Proves the OLD modular-only formula is what broke: it flatlines after
  // the boundary. This documents the bug the new helper fixes.
  it("legacy modular-only formula DID flatline (documents the bug)", () => {
    const baseRaw = 1_000_000_000;
    const totalFrames = Math.ceil(U32 / FRAME_US) + 500;
    let prev = 0;
    let last = 0;
    let flatlinedTicks = 0;
    for (let i = 1; i <= totalFrames; i++) {
      const curUs = rawUs(baseRaw + i * FRAME_US);
      const deltaUs = (curUs - (baseRaw % U32)) >>> 0; // legacy modular delta
      let ts = (0 + Math.round((deltaUs * CLOCK) / 1_000_000)) >>> 0;
      if (ts <= last >>> 0) ts = ((last >>> 0) + 1) >>> 0; // legacy monotonic guard
      last = ts;
      const inc = (ts - prev) >>> 0;
      if (i > Math.ceil(U32 / FRAME_US) + 10 && inc === 1) flatlinedTicks++;
      prev = ts;
    }
    // After the boundary the legacy formula pins the increment to +1 tick.
    expect(flatlinedTicks).toBeGreaterThan(0);
  });

  it("treats small backward jitter as no advance, not a 2^32 jump", () => {
    let state = deriveRtpVideoTimestamp(initialState(), 1_000_000, CLOCK).state;
    state = deriveRtpVideoTimestamp(state, 1_050_000, CLOCK).state; // +50ms
    const after = deriveRtpVideoTimestamp(state, 1_049_000, CLOCK); // -1ms blip
    // No huge forward leap; timestamp does not regress wildly.
    expect((after.timestamp - state.timestamp) >>> 0).toBeLessThan(
      TICKS_PER_FRAME,
    );
  });
});
