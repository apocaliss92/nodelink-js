import { describe, expect, it } from "vitest";
import {
  normalizeIntercomPayload,
  prepareIntercomAudioForTalk,
} from "../../src/baichuan/stream/BaichuanWebRTCServer";
import { encodeImaAdpcm } from "../../src/reolink/baichuan/utils/imaAdpcm";

describe("normalizeIntercomPayload", () => {
  it("accepts Node Buffer (werift DC path)", () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(normalizeIntercomPayload(buf)?.equals(buf)).toBe(true);
  });

  it("accepts ArrayBuffer", () => {
    const ab = new Uint8Array([4, 5, 6]).buffer;
    expect(normalizeIntercomPayload(ab)?.equals(Buffer.from([4, 5, 6]))).toBe(
      true,
    );
  });

  it("accepts TypedArray views with non-zero byteOffset", () => {
    const backing = new ArrayBuffer(8);
    const view = new Uint8Array(backing, 2, 3);
    view.set([7, 8, 9]);
    expect(normalizeIntercomPayload(view)?.equals(Buffer.from([7, 8, 9]))).toBe(
      true,
    );
  });

  it("returns null for non-binary payloads", () => {
    expect(normalizeIntercomPayload("nope")).toBeNull();
    expect(normalizeIntercomPayload(null)).toBeNull();
    expect(normalizeIntercomPayload(undefined)).toBeNull();
  });
});

describe("prepareIntercomAudioForTalk", () => {
  it("encodes 1024-sample PCM Int16 LE via encodeImaAdpcm (516-byte block)", () => {
    const pcm = new Int16Array(1024);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(4000 * Math.sin((2 * Math.PI * i) / 40));
    }
    const raw = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(raw.length).toBe(2048);

    const out = prepareIntercomAudioForTalk(raw);
    expect(out.length).toBe(516);
    expect(out.equals(encodeImaAdpcm(pcm, 512))).toBe(true);
    // First sample is 0 → zero predictor header; body should still have energy.
    expect(out.subarray(4).some((b) => b !== 0)).toBe(true);
  });

  it("encodes 1025-sample PCM (one full block of samplesPerBlock)", () => {
    const pcm = new Int16Array(1025);
    pcm[0] = 1000;
    for (let i = 1; i < pcm.length; i++) pcm[i] = 500;
    const raw = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(raw.length).toBe(2050);
    const out = prepareIntercomAudioForTalk(raw);
    expect(out.length).toBe(516);
    expect(out.readInt16LE(0)).toBe(1000);
    expect(out[2]).toBe(0);
  });

  it("prepends zero header for legacy 512-byte nibble payloads", () => {
    const nibbles = Buffer.alloc(512, 0x12);
    const out = prepareIntercomAudioForTalk(nibbles);
    expect(out.length).toBe(516);
    expect(out.readUInt32LE(0)).toBe(0);
    expect(out.subarray(4).equals(nibbles)).toBe(true);
  });

  it("passes through existing 516-byte full blocks", () => {
    const full = Buffer.alloc(516, 0xab);
    expect(prepareIntercomAudioForTalk(full).equals(full)).toBe(true);
  });

  it("encodes PCM sitting at an odd byteOffset without throwing", () => {
    // werift hands us subarrays of pooled / SCTP-reassembled buffers, so
    // byteOffset is arbitrary. `new Int16Array(buf.buffer, byteOffset, …)`
    // requires a 2-byte-aligned offset and throws RangeError otherwise —
    // swallowed by the caller's try/catch, so the mic goes silent again with
    // nothing but an error line to show for it.
    const pcm = new Int16Array(1024);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(4000 * Math.sin((2 * Math.PI * i) / 40));
    }
    const aligned = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

    // Same bytes, shifted one byte into a larger backing buffer.
    const backing = Buffer.alloc(aligned.length + 1);
    aligned.copy(backing, 1);
    const misaligned = backing.subarray(1);
    expect(misaligned.byteOffset % 2).toBe(1);
    expect(misaligned.equals(aligned)).toBe(true);

    const out = prepareIntercomAudioForTalk(misaligned);
    expect(out.length).toBe(516);
    // Byte-identical to the aligned path — the copy must not reinterpret.
    expect(out.equals(prepareIntercomAudioForTalk(aligned))).toBe(true);
  });
});
