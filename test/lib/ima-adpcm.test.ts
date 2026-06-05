import { describe, it, expect } from "vitest";
import { encodeImaAdpcm } from "../../src/reolink/baichuan/utils/imaAdpcm";

// Reference implementation: a literal port of the encoder that has been
// running in scrypted-reolink-native/src/intercom.ts (line 502) for months.
// The test asserts that the new library-exported encoder is bit-exact with
// that reference so the Scrypted plugin can swap to importing from the lib
// without any change in the bytes the camera receives.
function referenceEncodeImaAdpcm(
  pcm: Int16Array,
  blockSizeBytes: number,
): Buffer {
  const samplesPerBlock = blockSizeBytes * 2 + 1;
  const totalBlocks = Math.ceil(pcm.length / samplesPerBlock);
  const outBlocks: Buffer[] = [];

  const imaIndexTable = Int8Array.from([
    -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
  ]);
  const imaStepTable = Int16Array.from([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41,
    45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209,
    230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876,
    963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749,
    3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767,
  ]);

  const clamp16 = (x: number) =>
    x > 32767 ? 32767 : x < -32768 ? -32768 : x | 0;

  let sampleIndex = 0;
  for (let b = 0; b < totalBlocks; b++) {
    const block = Buffer.alloc(4 + blockSizeBytes);
    const first = pcm[sampleIndex] ?? 0;
    let predictor = first;
    let index = 0;

    block.writeInt16LE(predictor, 0);
    block.writeUInt8(index, 2);
    block.writeUInt8(0, 3);
    sampleIndex++;

    const codes = new Uint8Array(blockSizeBytes * 2);
    for (let i = 0; i < codes.length; i++) {
      const sample = pcm[sampleIndex] ?? predictor;
      sampleIndex++;

      let diff = sample - predictor;
      let sign = 0;
      if (diff < 0) {
        sign = 8;
        diff = -diff;
      }

      let step = imaStepTable[index] ?? 7;
      let delta = 0;
      let vpdiff = step >> 3;

      if (diff >= step) {
        delta |= 4;
        diff -= step;
        vpdiff += step;
      }
      step >>= 1;
      if (diff >= step) {
        delta |= 2;
        diff -= step;
        vpdiff += step;
      }
      step >>= 1;
      if (diff >= step) {
        delta |= 1;
        vpdiff += step;
      }

      if (sign) predictor -= vpdiff;
      else predictor += vpdiff;
      predictor = clamp16(predictor);

      index += imaIndexTable[delta] ?? 0;
      if (index < 0) index = 0;
      if (index > 88) index = 88;

      codes[i] = (delta | sign) & 0x0f;
    }

    for (let i = 0; i < blockSizeBytes; i++) {
      const lo = codes[i * 2] ?? 0;
      const hi = codes[i * 2 + 1] ?? 0;
      block[4 + i] = (lo & 0x0f) | ((hi & 0x0f) << 4);
    }

    outBlocks.push(block);
  }

  return Buffer.concat(outBlocks);
}

// Deterministic PCM signal (silence, ramp, alternating, sine). No RNG so
// the test is reproducible across machines.
function makePcm(samples: number, pattern: "zero" | "ramp" | "alt" | "sine"): Int16Array {
  const buf = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    switch (pattern) {
      case "zero":
        buf[i] = 0;
        break;
      case "ramp":
        buf[i] = ((i * 17) % 65536) - 32768;
        break;
      case "alt":
        buf[i] = i % 2 === 0 ? 16384 : -16384;
        break;
      case "sine":
        // 220 Hz tone @ 16 kHz, amplitude 8000
        buf[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
        break;
    }
  }
  return buf;
}

describe("encodeImaAdpcm", () => {
  it("empty input returns empty buffer", () => {
    expect(encodeImaAdpcm(new Int16Array(0), 256).length).toBe(0);
  });

  it("rejects non-positive block size", () => {
    expect(() => encodeImaAdpcm(new Int16Array(10), 0)).toThrow(RangeError);
    expect(() => encodeImaAdpcm(new Int16Array(10), -16)).toThrow(RangeError);
    expect(() => encodeImaAdpcm(new Int16Array(10), 1.5)).toThrow(RangeError);
  });

  it("block layout: 4-byte header + blockSizeBytes payload per block", () => {
    const blockSizeBytes = 256;
    const samplesPerBlock = blockSizeBytes * 2 + 1; // 513 samples per block
    const pcm = makePcm(samplesPerBlock * 3, "sine");
    const out = encodeImaAdpcm(pcm, blockSizeBytes);

    expect(out.length).toBe(3 * (4 + blockSizeBytes));
    // First block predictor MUST equal the first PCM sample.
    expect(out.readInt16LE(0)).toBe(pcm[0]);
    // Reserved byte (offset 3) MUST be zero.
    expect(out.readUInt8(3)).toBe(0);
    // Step-table index in the header MUST start at 0.
    expect(out.readUInt8(2)).toBe(0);
  });

  it("bit-exact vs scrypted-reolink-native reference encoder — sine 16 kHz", () => {
    const blockSizeBytes = 256;
    const pcm = makePcm(513 * 4 + 100, "sine");
    expect(encodeImaAdpcm(pcm, blockSizeBytes).equals(
      referenceEncodeImaAdpcm(pcm, blockSizeBytes),
    )).toBe(true);
  });

  it("bit-exact vs reference — ramp pattern stresses predictor clamping", () => {
    const blockSizeBytes = 1024;
    const pcm = makePcm(2049 * 2, "ramp");
    expect(encodeImaAdpcm(pcm, blockSizeBytes).equals(
      referenceEncodeImaAdpcm(pcm, blockSizeBytes),
    )).toBe(true);
  });

  it("bit-exact vs reference — alternating samples stress sign bit handling", () => {
    const blockSizeBytes = 64;
    const pcm = makePcm(129 * 3 + 50, "alt");
    expect(encodeImaAdpcm(pcm, blockSizeBytes).equals(
      referenceEncodeImaAdpcm(pcm, blockSizeBytes),
    )).toBe(true);
  });

  it("bit-exact vs reference — pure silence (all zeros)", () => {
    const blockSizeBytes = 256;
    const pcm = makePcm(513 * 2, "zero");
    expect(encodeImaAdpcm(pcm, blockSizeBytes).equals(
      referenceEncodeImaAdpcm(pcm, blockSizeBytes),
    )).toBe(true);
  });

  it("handles tail shorter than one full block", () => {
    const blockSizeBytes = 256;
    // 600 samples = 1 full block (513) + 87 samples of tail.
    const pcm = makePcm(600, "sine");
    const out = encodeImaAdpcm(pcm, blockSizeBytes);

    // Two blocks because Math.ceil(600 / 513) = 2.
    expect(out.length).toBe(2 * (4 + blockSizeBytes));
    expect(out.equals(referenceEncodeImaAdpcm(pcm, blockSizeBytes))).toBe(true);
  });
});
