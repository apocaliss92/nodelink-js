// IMA ADPCM (4-bit per sample) encoder used to feed Reolink Baichuan talk sessions.
//
// Reolink's TalkAbility advertises `audioType=adpcm`, `samplePrecision=16`,
// `lengthPerEncoder=N` (block size in payload bytes). Each block we send must be:
//   4-byte header — int16 predictor (LE), uint8 step-table index, uint8 reserved (0)
//   N bytes        — 4-bit deltas packed two per byte, low nibble first
//
// The encoder is stateless across blocks: each block resets predictor/index to
// the first sample so the camera can recover without inter-block context.

const IMA_INDEX_TABLE: ReadonlyArray<number> = [
  -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];

const IMA_STEP_TABLE: ReadonlyArray<number> = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

function clamp16(x: number): number {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x | 0;
}

/**
 * Encode 16-bit signed PCM into IMA ADPCM blocks ready for `TalkSession.sendAudio()`.
 *
 * @param pcm 16-bit signed mono PCM samples (typically 16 kHz per Reolink TalkAbility).
 * @param blockSizeBytes Number of ADPCM payload bytes per block. The block encodes
 *   `blockSizeBytes * 2 + 1` samples (one in the header + two per payload byte).
 *   Reolink's default `lengthPerEncoder=1024` corresponds to a 4-byte header +
 *   1020 payload bytes per Baichuan ADPCM frame; the caller chooses what to pass.
 * @returns Concatenated blocks, each `4 + blockSizeBytes` bytes long. An empty
 *   `pcm` yields an empty buffer.
 */
export function encodeImaAdpcm(
  pcm: Int16Array,
  blockSizeBytes: number,
): Buffer {
  if (pcm.length === 0) return Buffer.alloc(0);
  if (!Number.isInteger(blockSizeBytes) || blockSizeBytes <= 0) {
    throw new RangeError(
      `encodeImaAdpcm: blockSizeBytes must be a positive integer, got ${blockSizeBytes}`,
    );
  }

  const samplesPerBlock = blockSizeBytes * 2 + 1;
  const totalBlocks = Math.ceil(pcm.length / samplesPerBlock);
  const out = Buffer.alloc(totalBlocks * (4 + blockSizeBytes));

  let sampleIndex = 0;
  let outOffset = 0;

  for (let b = 0; b < totalBlocks; b++) {
    const blockStart = outOffset;
    const first = pcm[sampleIndex] ?? 0;
    let predictor = first;
    let index = 0;

    out.writeInt16LE(predictor, blockStart);
    out.writeUInt8(index, blockStart + 2);
    out.writeUInt8(0, blockStart + 3);
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

      let step = IMA_STEP_TABLE[index] ?? 7;
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

      predictor = clamp16(sign ? predictor - vpdiff : predictor + vpdiff);

      index += IMA_INDEX_TABLE[delta] ?? 0;
      if (index < 0) index = 0;
      if (index > 88) index = 88;

      codes[i] = (delta | sign) & 0x0f;
    }

    // Pack nibbles: low nibble first, then high nibble.
    for (let i = 0; i < blockSizeBytes; i++) {
      const lo = codes[i * 2] ?? 0;
      const hi = codes[i * 2 + 1] ?? 0;
      out[blockStart + 4 + i] = (lo & 0x0f) | ((hi & 0x0f) << 4);
    }

    outOffset += 4 + blockSizeBytes;
  }

  return out;
}
