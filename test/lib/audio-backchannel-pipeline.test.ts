import { describe, it, expect } from "vitest";
import { mulaw, alaw } from "alawmulaw";
import {
  mulawToPcm16,
  alawToPcm16,
} from "../../src/reolink/baichuan/utils/audioMulaw";
import { upsamplePcm16 } from "../../src/reolink/baichuan/utils/audioResample";
import { encodeImaAdpcm } from "../../src/reolink/baichuan/utils/imaAdpcm";

// Tests cover the audio pipeline used by the RTSP backchannel bridge:
//   RTP PCMU bytes ──mulawToPcm16──▶ PCM16 @ 8 kHz
//                  ──upsamplePcm16(2)──▶ PCM16 @ 16 kHz
//                  ──encodeImaAdpcm──▶ ADPCM blocks for TalkSession.sendAudio()
//
// Each link is verified in isolation, then end-to-end with a synthesized voice
// tone, so we can pinpoint where a regression lives if the audio path breaks.

function sineMulaw(samples: number, freqHz: number, sampleRateHz: number, amp = 8000): Uint8Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRateHz));
  }
  return mulaw.encode(pcm);
}

describe("mulawToPcm16 / alawToPcm16", () => {
  it("returns empty Int16Array for empty input", () => {
    expect(mulawToPcm16(Buffer.alloc(0))).toEqual(new Int16Array(0));
    expect(alawToPcm16(Buffer.alloc(0))).toEqual(new Int16Array(0));
  });

  it("μ-law round-trip preserves amplitude within G.711 quantization", () => {
    // G.711 μ-law has ~14-bit dynamic range; reconstruction error stays
    // well under 5% of full-scale for mid-amplitude voice signals.
    const original = new Int16Array(256);
    for (let i = 0; i < original.length; i++) {
      original[i] = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / 8000));
    }
    const encoded = mulaw.encode(original);
    const decoded = mulawToPcm16(encoded);

    expect(decoded.length).toBe(original.length);
    let maxErr = 0;
    for (let i = 0; i < original.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((decoded[i] ?? 0) - (original[i] ?? 0)));
    }
    expect(maxErr).toBeLessThan(1600); // < 5% of 32768 full-scale.
  });

  it("A-law round-trip preserves amplitude similarly", () => {
    const original = new Int16Array(256);
    for (let i = 0; i < original.length; i++) {
      original[i] = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / 8000));
    }
    const encoded = alaw.encode(original);
    const decoded = alawToPcm16(encoded);

    expect(decoded.length).toBe(original.length);
    let maxErr = 0;
    for (let i = 0; i < original.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((decoded[i] ?? 0) - (original[i] ?? 0)));
    }
    expect(maxErr).toBeLessThan(1600);
  });
});

describe("upsamplePcm16", () => {
  it("factor=1 returns a copy with same content", () => {
    const src = Int16Array.from([1, 2, 3, 4]);
    const out = upsamplePcm16(src, 1);
    expect(out).not.toBe(src); // copy
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it("rejects non-integer or non-positive factors", () => {
    expect(() => upsamplePcm16(Int16Array.from([1, 2]), 0)).toThrow(RangeError);
    expect(() => upsamplePcm16(Int16Array.from([1, 2]), -2)).toThrow(RangeError);
    expect(() => upsamplePcm16(Int16Array.from([1, 2]), 1.5)).toThrow(RangeError);
  });

  it("factor=2 produces length*2 samples and interpolates between neighbours", () => {
    const src = Int16Array.from([0, 1000, -1000, 500]);
    const out = upsamplePcm16(src, 2);

    expect(out.length).toBe(src.length * 2);
    // Original samples sit at positions 0, 2, 4, 6.
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(1000);
    expect(out[4]).toBe(-1000);
    expect(out[6]).toBe(500);
    // Interpolated positions are halfway between neighbours.
    expect(out[1]).toBe(500); // (0 + 1000) / 2
    expect(out[3]).toBe(0); // (1000 + -1000) / 2
    expect(out[5]).toBe(-250); // (-1000 + 500) / 2
    // Tail holds the last input sample.
    expect(out[7]).toBe(500);
  });

  it("preserves peak amplitude for sine input across an upsampling step", () => {
    const inSamples = 200;
    const src = new Int16Array(inSamples);
    for (let i = 0; i < inSamples; i++) {
      src[i] = Math.round(15000 * Math.sin((2 * Math.PI * 220 * i) / 8000));
    }
    const out = upsamplePcm16(src, 2);

    let peakIn = 0;
    let peakOut = 0;
    for (const v of src) peakIn = Math.max(peakIn, Math.abs(v));
    for (const v of out) peakOut = Math.max(peakOut, Math.abs(v));

    // Peak can only equal or drop slightly due to interpolation rounding.
    expect(peakOut).toBeLessThanOrEqual(peakIn);
    expect(peakOut).toBeGreaterThan(peakIn * 0.95);
  });
});

describe("end-to-end backchannel pipeline (RTP PCMU → ADPCM blocks)", () => {
  it("encodes a 220 Hz tone without throwing and produces well-formed ADPCM blocks", () => {
    // Simulate ~640 ms of voice as 5 RTP frames of 160 samples each (the
    // standard 20 ms G.711 packetization).
    const RTP_FRAMES = 32;
    const SAMPLES_PER_FRAME = 160;
    const BLOCK_SIZE_BYTES = 256;
    const SAMPLES_PER_ADPCM_BLOCK = BLOCK_SIZE_BYTES * 2 + 1;

    let totalAdpcmBytes = 0;
    let totalAdpcmBlocks = 0;
    let pcmTail = new Int16Array(0);

    for (let f = 0; f < RTP_FRAMES; f++) {
      const mulawBytes = sineMulaw(
        SAMPLES_PER_FRAME,
        220,
        8000,
        8000,
      );
      const pcm8k = mulawToPcm16(mulawBytes);
      expect(pcm8k.length).toBe(SAMPLES_PER_FRAME);

      const pcm16k = upsamplePcm16(pcm8k, 2);
      expect(pcm16k.length).toBe(SAMPLES_PER_FRAME * 2);

      // Concat into a rolling buffer and flush whole ADPCM blocks.
      const merged = new Int16Array(pcmTail.length + pcm16k.length);
      merged.set(pcmTail, 0);
      merged.set(pcm16k, pcmTail.length);

      const fullBlocks = Math.floor(merged.length / SAMPLES_PER_ADPCM_BLOCK);
      if (fullBlocks > 0) {
        const consumed = fullBlocks * SAMPLES_PER_ADPCM_BLOCK;
        const adpcm = encodeImaAdpcm(
          merged.subarray(0, consumed),
          BLOCK_SIZE_BYTES,
        );
        expect(adpcm.length).toBe(fullBlocks * (4 + BLOCK_SIZE_BYTES));
        totalAdpcmBytes += adpcm.length;
        totalAdpcmBlocks += fullBlocks;
        pcmTail = merged.subarray(consumed);
      } else {
        pcmTail = merged;
      }
    }

    // 32 frames × 160 samples × 2x upsample = 10 240 samples @ 16 kHz.
    // 10 240 / 513 = 19.96 → 19 full blocks at 260 bytes = 4 940 ADPCM bytes.
    expect(totalAdpcmBlocks).toBe(19);
    expect(totalAdpcmBytes).toBe(totalAdpcmBlocks * (4 + BLOCK_SIZE_BYTES));

    // Tail < 1 full block.
    expect(pcmTail.length).toBeLessThan(SAMPLES_PER_ADPCM_BLOCK);
  });
});
