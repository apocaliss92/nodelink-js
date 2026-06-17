/**
 * RTP video timestamp derivation from the camera's BcMedia microseconds clock.
 *
 * The Baichuan wire format carries a per-frame presentation timestamp as a
 * **32-bit** little-endian microsecond value (`BcMediaParser` reads it via
 * `readUInt32LE`). A 32-bit µs counter wraps every 2^32 µs ≈ 71.58 minutes.
 *
 * A naive `delta = (curUs - baseUs) >>> 0` absorbs a *single* wrap of that
 * counter, but once the elapsed time since the connection started exceeds
 * 2^32 µs, the modular delta itself wraps back toward zero. The derived RTP
 * timestamp then collapses, a downstream monotonic guard pins it to
 * `last + 1`, and presentation time flatlines — long-lived consumers
 * (Frigate, go2rtc) stall and restart roughly every ~71 minutes.
 *
 * This helper unwraps the 32-bit camera clock into a monotonically increasing
 * accumulator (exact within `Number`'s 2^53 integer range — centuries of µs)
 * and derives the RTP timestamp from that, so pacing stays correct for the
 * entire lifetime of a stream.
 */

const U32 = 0x1_0000_0000; // 2^32
const DEFAULT_VIDEO_CLOCK_RATE = 90000;

export interface RtpVideoTimestampState {
  /** Unwrapped, monotonically increasing camera clock in microseconds. */
  unwrappedUs?: number;
  /** Last raw 32-bit µs value seen on the wire (for wrap detection). */
  lastRawUs?: number;
  /** Unwrapped µs captured at the first frame (the anchor). */
  baseUnwrappedUs?: number;
  /** RTP 90 kHz timestamp captured at the first frame (the anchor). */
  baseTimestamp: number;
  /** Current derived RTP timestamp (90 kHz, wraps naturally at 2^32). */
  timestamp: number;
}

export interface RtpVideoTimestampResult {
  /** RTP timestamp to stamp onto the next access unit's packets. */
  timestamp: number;
  /** New state to persist for the next call. */
  state: RtpVideoTimestampState;
}

/**
 * Derive the next RTP video timestamp from a raw BcMedia microseconds value.
 *
 * Pure and immutable: returns a new state object, never mutates the input.
 * If `frameMicroseconds` is unusable, the previous state is returned unchanged
 * (the caller is expected to fall back to a fixed-FPS increment).
 *
 * @param state - Persisted state from the previous call.
 * @param frameMicroseconds - Raw 32-bit µs value for this frame (may wrap).
 * @param clockRate - RTP clock rate in Hz (defaults to 90 kHz for video).
 */
export function deriveRtpVideoTimestamp(
  state: Readonly<RtpVideoTimestampState>,
  frameMicroseconds: number | null | undefined,
  clockRate: number = DEFAULT_VIDEO_CLOCK_RATE,
): RtpVideoTimestampResult {
  if (
    frameMicroseconds === null ||
    frameMicroseconds === undefined ||
    !Number.isFinite(frameMicroseconds)
  ) {
    return { timestamp: state.timestamp, state };
  }

  const curRaw = frameMicroseconds >>> 0;

  // First usable frame: anchor both clocks; leave the RTP timestamp as-is.
  if (state.baseUnwrappedUs === undefined) {
    return {
      timestamp: state.timestamp,
      state: {
        ...state,
        unwrappedUs: curRaw,
        lastRawUs: curRaw,
        baseUnwrappedUs: curRaw,
        baseTimestamp: state.timestamp,
      },
    };
  }

  // Unwrap the 32-bit camera µs clock into a monotonic accumulator.
  // A forward delta near 2^32 is overwhelmingly more likely to be a small
  // backward step (out-of-order frame / jitter) than a genuine ~71-min jump
  // between two consecutive frames, so clamp it to zero advance.
  const lastRaw = state.lastRawUs ?? curRaw;
  let forwardDelta = (curRaw - lastRaw) >>> 0;
  if (forwardDelta > U32 / 2) forwardDelta = 0;

  const unwrappedUs = (state.unwrappedUs ?? curRaw) + forwardDelta;
  const deltaUs = unwrappedUs - state.baseUnwrappedUs;
  const timestamp =
    (state.baseTimestamp + Math.round((deltaUs * clockRate) / 1_000_000)) >>> 0;

  return {
    timestamp,
    state: { ...state, unwrappedUs, lastRawUs: curRaw, timestamp },
  };
}
