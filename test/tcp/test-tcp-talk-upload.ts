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
  // This matches the Reolink TalkAbility lengthPerEncoder relationship used by neolink.
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

async function main(): Promise<void> {
  const host = config.tcp.host;
  const username = config.tcp.username;
  const password = config.tcp.password;

  if (!host) throw new Error("Missing TCP_HOST in .env");
  if (!password) throw new Error("Missing TCP_PASSWORD in .env");

  log("Starting talk upload test", { host, username });

  const debugEnabled = envBool(process.env.BAICHUAN_DEBUG, false);
  const debugOptions = {
    enabled: debugEnabled,
    traceTalk: envBool(process.env.BAICHUAN_TRACE_TALK, false),
    traceStream: envBool(process.env.BAICHUAN_TRACE_STREAM, false),
    debugH264: envBool(process.env.BAICHUAN_DEBUG_H264, debugEnabled),
    debugParamSets: envBool(process.env.BAICHUAN_DEBUG_PARAMSETS, false),
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

    const sampleSeconds = 3.5;
    const sampleRate = session.info.audioConfig.sampleRate;
    const blockSizeBytes = session.info.blockSize;

    const pcm = generateSinePcm(sampleRate, sampleSeconds);
    const adpcm = encodeImaAdpcm(pcm, blockSizeBytes);

    log("Uploading audio", {
      seconds: sampleSeconds,
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
