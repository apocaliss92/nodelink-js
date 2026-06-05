// Integer-factor linear-interpolation upsampler for voice-band PCM.
//
// Used by the RTSP backchannel bridge to map 8 kHz μ-law (RTP PCMU, the de-facto
// codec for ONVIF Backchannel) to the 16 kHz mono PCM that Reolink's TalkAbility
// advertises. Linear interpolation is good enough for telephone-quality voice
// and avoids pulling in a heavyweight DSP dependency; if higher fidelity is
// ever needed, swap in a polyphase FIR without changing the public signature.

function clamp16(x: number): number {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x | 0;
}

/**
 * Linearly interpolate `src` by an integer `factor` so the output has
 * `src.length * factor` samples (minus tail) at `factor` times the input rate.
 *
 * Example: `upsamplePcm16(eightKhz, 2)` produces a 16 kHz signal.
 *
 * Edge cases:
 * - Empty input returns an empty array.
 * - factor = 1 returns a copy of the input.
 * - factor < 1 or non-integer throws.
 * - The last sample is held (no extrapolation beyond src[n-1]).
 */
export function upsamplePcm16(src: Int16Array, factor: number): Int16Array {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError(
      `upsamplePcm16: factor must be a positive integer, got ${factor}`,
    );
  }
  if (src.length === 0) return new Int16Array(0);
  if (factor === 1) return Int16Array.from(src);

  const out = new Int16Array(src.length * factor);
  const last = src.length - 1;

  for (let i = 0; i < last; i++) {
    const a = src[i] as number;
    const b = src[i + 1] as number;
    const base = i * factor;
    for (let k = 0; k < factor; k++) {
      // Linear interpolation: a + (b - a) * k / factor.
      const v = a + Math.round(((b - a) * k) / factor);
      out[base + k] = clamp16(v);
    }
  }

  // Tail: hold the last input sample across the final `factor` output slots.
  const tail = (src[last] as number) | 0;
  for (let k = 0; k < factor; k++) {
    out[last * factor + k] = tail;
  }

  return out;
}
