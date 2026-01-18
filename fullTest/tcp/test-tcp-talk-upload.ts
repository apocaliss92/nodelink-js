#!/usr/bin/env node
/**
 * TCP -> Talk (two-way audio) upload validation test.
 *
 * Goal: push ~3.5s of ADPCM (DVI4/IMA-style) audio to the camera using Baichuan Talk.
 *
 * Requires .env:
 *  - TCP_HOST / TCP_USERNAME / TCP_PASSWORD
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n" || v === "off") return false;
  return defaultValue;
}

function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[INFO] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("=".repeat(60));
}

function logSuccess(message: string) {
  console.log(`\n[OK] ${message}`);
}

function clamp16(x: number): number {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x | 0;
}

function applyGainToPcm(pcm: Int16Array, gain: number, softClip: boolean): Int16Array {
  if (!Number.isFinite(gain) || gain <= 0) return pcm;

  // Soft-clip keeps loud samples audible without turning into harsh square waves.
  // This isn't "hi-fi" but helps with talkback speakers/mics and ADPCM.
  const drive = 2.25;
  const norm = softClip ? Math.tanh(drive) : 1;

  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = (pcm[i] ?? 0) / 32768;
    let x = v * gain;
    if (softClip) {
      x = Math.tanh(x * drive) / norm;
    }
    out[i] = clamp16(Math.round(x * 32767));
  }
  return out;
}

const imaIndexTable = Int8Array.from([
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]);

const imaStepTable = Int16Array.from([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);

function encodeImaAdpcm(pcm: Int16Array, blockSizeBytes: number): Buffer {
  // Block layout: 4-byte header + blockSizeBytes of nibbles (2 samples per byte).
  // This matches the Reolink TalkAbility lengthPerEncoder relationship.
  const samplesPerBlock = blockSizeBytes * 2 + 1;
  const totalBlocks = Math.ceil(pcm.length / samplesPerBlock);
  const outBlocks: Buffer[] = [];

  let sampleIndex = 0;
  let predictor = 0;
  let index = 0;

  for (let b = 0; b < totalBlocks; b++) {
    const block = Buffer.alloc(4 + blockSizeBytes);

    // header
    const first = pcm[sampleIndex] ?? 0;
    predictor = first;
    // start each block with a conservative index
    index = 0;

    block.writeInt16LE(predictor, 0);
    block.writeUInt8(index, 2);
    block.writeUInt8(0, 3);

    sampleIndex++;

    // Encode 2*blockSizeBytes samples into nibbles.
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

    // pack nibbles: low nibble first, then high nibble
    for (let i = 0; i < blockSizeBytes; i++) {
      const lo = codes[i * 2] ?? 0;
      const hi = codes[i * 2 + 1] ?? 0;
      block[4 + i] = (lo & 0x0f) | ((hi & 0x0f) << 4);
    }

    outBlocks.push(block);
  }

  return Buffer.concat(outBlocks);
}

function generateSinePcm(sampleRate: number, seconds: number, hz = 1000, amplitude = 0.8): Int16Array {
  const total = Math.max(1, Math.floor(sampleRate * seconds));
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const v = Math.sin(2 * Math.PI * hz * t) * amplitude;
    pcm[i] = clamp16(Math.round(v * 32767));
  }
  return pcm;
}

function midiToHz(noteNumber: number): number {
  // A4 = 69 = 440Hz
  return 440 * Math.pow(2, (noteNumber - 69) / 12);
}

function generateMelodyPcm(sampleRate: number, seconds: number): Int16Array {
  // Simple original arpeggio melody, deterministic and copyright-safe.
  // Two octaves around C major-ish, with a light envelope to reduce clicks.
  const total = Math.max(1, Math.floor(sampleRate * seconds));
  const pcm = new Int16Array(total);

  type Note = { midi: number; durMs: number; amp: number };

  // C4=60. Progression-like arpeggio: C-E-G-E | A-C-E-C | F-A-C-A | G-B-D-B
  const pattern: Note[] = [
    { midi: 60, durMs: 220, amp: 0.95 },
    { midi: 64, durMs: 220, amp: 0.95 },
    { midi: 67, durMs: 220, amp: 0.95 },
    { midi: 64, durMs: 220, amp: 0.95 },
    { midi: 69, durMs: 220, amp: 0.95 },
    { midi: 72, durMs: 220, amp: 0.95 },
    { midi: 76, durMs: 220, amp: 0.95 },
    { midi: 72, durMs: 220, amp: 0.95 },
    { midi: 65, durMs: 220, amp: 0.95 },
    { midi: 69, durMs: 220, amp: 0.95 },
    { midi: 72, durMs: 220, amp: 0.95 },
    { midi: 69, durMs: 220, amp: 0.95 },
    { midi: 67, durMs: 220, amp: 0.95 },
    { midi: 71, durMs: 220, amp: 0.95 },
    { midi: 74, durMs: 220, amp: 0.95 },
    { midi: 71, durMs: 220, amp: 0.95 },
  ];

  const attackMs = 8;
  const releaseMs = 25;
  const globalAmp = 1.0;

  let i = 0;
  let noteIndex = 0;
  while (i < total) {
    const note = pattern[noteIndex % pattern.length]!;
    noteIndex++;

    const durSamples = Math.max(1, Math.floor((note.durMs / 1000) * sampleRate));
    const start = i;
    const end = Math.min(total, start + durSamples);
    const hz = midiToHz(note.midi);

    const attackSamples = Math.max(1, Math.floor((attackMs / 1000) * sampleRate));
    const releaseSamples = Math.max(1, Math.floor((releaseMs / 1000) * sampleRate));
    const noteLen = end - start;

    for (let s = 0; s < noteLen; s++) {
      const t = (start + s) / sampleRate;

      // Fundamental + 2nd harmonic, gentle.
      const wave = Math.sin(2 * Math.PI * hz * t) + 0.25 * Math.sin(2 * Math.PI * hz * 2 * t);

      // Linear attack/release envelope.
      let env = 1;
      if (s < attackSamples) env = s / attackSamples;
      const relStart = Math.max(0, noteLen - releaseSamples);
      if (s >= relStart) env *= Math.max(0, (noteLen - s) / releaseSamples);

      const v = wave * (note.amp * globalAmp) * env;
      pcm[start + s] = clamp16(Math.round(v * 32767));
    }

    i = end;
  }

  return pcm;
}

async function main(): Promise<void> {
  const host = config.tcp265.host;
  const username = config.tcp265.username;
  const password = config.tcp265.password;

  if (!host) throw new Error("Missing TCP_HOST in .env");
  if (!password) throw new Error("Missing TCP_PASSWORD in .env");

  log("Starting talk upload test", { host, username });

  const debugEnabled = envBool(process.env.BAICHUAN_DEBUG, false);
  const debugOptions = {
    enabled: debugEnabled,
    traceTalk: envBool(process.env.BAICHUAN_TRACE_TALK, false),
    traceNativeStream:
      envBool(process.env.BAICHUAN_TRACE_NATIVE_STREAM, false) ||
      envBool(process.env.BAICHUAN_TRACE_STREAM, false) ||
      envBool(process.env.BAICHUAN_DEBUG_H264, debugEnabled) ||
      envBool(process.env.BAICHUAN_DEBUG_PARAMSETS, false),
  } as const;

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    debugOptions,
  });

  try {
    const session = await api.createTalkSession(0);
    log("Talk session created", session.info);

    const sampleSeconds = Number.parseFloat(process.env.TALK_SECONDS ?? "8") || 8;
    const sampleRate = session.info.audioConfig.sampleRate;
    const blockSizeBytes = session.info.blockSize;

    const sampleType = (process.env.TALK_SAMPLE ?? "melody").trim().toLowerCase();
    const talkGain = Number.parseFloat(process.env.TALK_GAIN ?? "2.0") || 2.0;
    const talkSoftClip = envBool(process.env.TALK_SOFTCLIP, true);

    const pcmRaw = sampleType === "sine"
      ? generateSinePcm(sampleRate, sampleSeconds, 900, 0.95)
      : generateMelodyPcm(sampleRate, sampleSeconds);
    const pcm = applyGainToPcm(pcmRaw, talkGain, talkSoftClip);
    const adpcm = encodeImaAdpcm(pcm, blockSizeBytes);

    log("Uploading audio", {
      seconds: sampleSeconds,
      sampleType,
      talkGain,
      talkSoftClip,
      sampleRate,
      blockSizeBytes,
      fullBlockSizeBytes: session.info.fullBlockSize,
      pcmSamples: pcm.length,
      adpcmBytes: adpcm.length,
    });

    await session.sendAudio(adpcm);
    await session.stop();

    logSuccess("Talk upload completed");
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error("\n[ERROR] Talk upload test failed");
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exitCode = 1;
});
