/**
 * Pure-JS IMA-ADPCM helpers for browser-side audio.
 *
 * Manager native intercom does **not** encode ADPCM in the browser anymore:
 * `WebRTCInlinePlayer` sends raw PCM Int16 over the DataChannel and the
 * library encodes with `encodeImaAdpcm` (correct Reolink block framing).
 * {@link floatToPcm16} is what the player uses.
 *
 * {@link ImaAdpcmEncoder} remains for experiments / alternate clients. Note
 * that a naive "nibble stream + optional 4-byte header from encoder state"
 * does **not** match Reolink TalkSession blocks (first sample as predictor,
 * step index reset per block) — prefer server-side `encodeImaAdpcm`.
 */

const STEP_TABLE: number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

const INDEX_TABLE: number[] = [
  -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];

const clampPredictor = (v: number): number =>
  v > 32767 ? 32767 : v < -32768 ? -32768 : v;
const clampStepIndex = (v: number): number => (v < 0 ? 0 : v > 88 ? 88 : v);

export class ImaAdpcmEncoder {
  private predictor = 0;
  private stepIndex = 0;

  reset(): void {
    this.predictor = 0;
    this.stepIndex = 0;
  }

  /**
   * Encode `pcm` (16-bit signed mono samples) into IMA-ADPCM nibbles.
   * Returns a new `Uint8Array` whose length is `Math.ceil(pcm.length / 2)`.
   *
   * The first nibble of each output byte holds the FIRST sample of the
   * matching pair — same packing order WAV and Reolink both use.
   */
  encode(pcm: Int16Array): Uint8Array {
    const out = new Uint8Array(Math.ceil(pcm.length / 2));
    let outIdx = 0;
    let pending = -1;
    for (let i = 0; i < pcm.length; i++) {
      const nibble = this.encodeSample(pcm[i] ?? 0);
      if (pending === -1) {
        pending = nibble;
      } else {
        // Two samples → one byte. Low nibble is the FIRST sample of the
        // pair, high nibble is the SECOND — that's the WAV / IMA convention.
        out[outIdx++] = (pending & 0x0f) | ((nibble & 0x0f) << 4);
        pending = -1;
      }
    }
    if (pending !== -1) {
      // Odd-length input: pad the high nibble with a silent (0) sample.
      out[outIdx++] = pending & 0x0f;
    }
    return out;
  }

  private encodeSample(sample: number): number {
    let diff = sample - this.predictor;
    let sign = 0;
    if (diff < 0) {
      sign = 8;
      diff = -diff;
    }
    const step = STEP_TABLE[this.stepIndex] ?? 0;
    let nibble = 0;
    let diffq = step >> 3;
    if (diff >= step) {
      nibble = 4;
      diff -= step;
      diffq += step;
    }
    if (diff >= step >> 1) {
      nibble |= 2;
      diff -= step >> 1;
      diffq += step >> 1;
    }
    if (diff >= step >> 2) {
      nibble |= 1;
      diffq += step >> 2;
    }
    nibble |= sign;
    if (sign) this.predictor = clampPredictor(this.predictor - diffq);
    else this.predictor = clampPredictor(this.predictor + diffq);
    this.stepIndex = clampStepIndex(
      this.stepIndex + (INDEX_TABLE[nibble] ?? 0),
    );
    return nibble;
  }
}

/**
 * Convert a Float32 sample buffer (browser-native AudioWorklet output, range
 * `[-1, 1]`) into a 16-bit signed PCM `Int16Array` ready for IMA-ADPCM.
 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
    // Use 0x7fff (32767) not 0x8000 to avoid overflow on -1.0.
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}
