import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  convertToAnnexB,
  isH265Irap,
  splitAnnexBToNalPayloads,
} from "../../src/baichuan/stream/H265Converter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

describe("H265Converter", () => {
  it("converts raw keyframe to Annex-B", () => {
    const rawPath = path.join(FIXTURES_DIR, "raw-keyframe-h265.bin");
    if (!fs.existsSync(rawPath)) return; // skip if fixture not available

    const raw = fs.readFileSync(rawPath);
    const annexB = convertToAnnexB(raw);

    expect(annexB.length).toBeGreaterThan(0);
    // Should start with Annex-B start code
    expect(annexB[0]).toBe(0x00);
    expect(annexB[1]).toBe(0x00);
  });

  it("detects IRAP NAL types", () => {
    // BLA_W_LP = 16, IDR_W_RADL = 19, IDR_N_LP = 20, CRA = 21
    expect(isH265Irap(16)).toBe(true);
    expect(isH265Irap(19)).toBe(true);
    expect(isH265Irap(20)).toBe(true);
    expect(isH265Irap(21)).toBe(true);
    // Non-IRAP
    expect(isH265Irap(0)).toBe(false); // TRAIL_N
    expect(isH265Irap(1)).toBe(false); // TRAIL_R
    expect(isH265Irap(32)).toBe(false); // VPS
    expect(isH265Irap(33)).toBe(false); // SPS
    expect(isH265Irap(34)).toBe(false); // PPS
  });

  it("splits Annex-B into NAL payloads", () => {
    // Two NALs with start codes
    const annexB = Buffer.from([
      0x00, 0x00, 0x00, 0x01, 0x40, 0x01, // VPS (type 32)
      0x00, 0x00, 0x00, 0x01, 0x42, 0x01, // SPS (type 33)
    ]);

    const nals = splitAnnexBToNalPayloads(annexB);
    expect(nals.length).toBe(2);
    expect(nals[0]![0]).toBe(0x40); // VPS header byte
    expect(nals[1]![0]).toBe(0x42); // SPS header byte
  });

  it("extracts NALs from captured keyframe", () => {
    const rawPath = path.join(FIXTURES_DIR, "raw-keyframe-h265.bin");
    if (!fs.existsSync(rawPath)) return;

    const raw = fs.readFileSync(rawPath);
    const annexB = convertToAnnexB(raw);
    const nals = splitAnnexBToNalPayloads(annexB);

    expect(nals.length).toBeGreaterThan(0);

    // A keyframe should contain VPS (32), SPS (33), PPS (34), and IDR (19 or 20)
    const nalTypes = nals.map((n) => (n[0]! >> 1) & 0x3f);
    expect(nalTypes).toContain(32); // VPS
    expect(nalTypes).toContain(33); // SPS
    expect(nalTypes).toContain(34); // PPS

    // Should have at least one IRAP
    const hasIrap = nalTypes.some((t) => isH265Irap(t));
    expect(hasIrap).toBe(true);
  });
});
