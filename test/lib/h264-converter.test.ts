import { describe, it, expect } from "vitest";
import { convertToAnnexB } from "../../src/baichuan/stream/H264Converter";

describe("H264Converter", () => {
  it("passes through Annex-B data unchanged", () => {
    // Annex-B start code + NAL
    const annexB = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e]);
    const result = convertToAnnexB(annexB);
    // Should contain the start code
    expect(result[0]).toBe(0x00);
    expect(result[1]).toBe(0x00);
    expect(result[2]).toBe(0x00);
    expect(result[3]).toBe(0x01);
  });

  it("converts AVCC (length-prefixed) to Annex-B", () => {
    // AVCC: 4-byte length + NAL data
    const nalData = Buffer.from([0x67, 0x42, 0x00, 0x1e, 0x9a, 0x74]);
    const avcc = Buffer.alloc(4 + nalData.length);
    avcc.writeUInt32BE(nalData.length, 0);
    nalData.copy(avcc, 4);

    const result = convertToAnnexB(avcc);
    // Should have Annex-B start code
    expect(result.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01]));
    // Followed by the NAL data
    expect(result.subarray(4)).toEqual(nalData);
  });

  it("handles empty input", () => {
    const result = convertToAnnexB(Buffer.alloc(0));
    expect(result.length).toBe(0);
  });

  it("handles multiple NALs in AVCC format", () => {
    const nal1 = Buffer.from([0x67, 0x42, 0x00, 0x1e]);
    const nal2 = Buffer.from([0x68, 0xce, 0x38, 0x80]);
    const avcc = Buffer.alloc(4 + nal1.length + 4 + nal2.length);
    avcc.writeUInt32BE(nal1.length, 0);
    nal1.copy(avcc, 4);
    avcc.writeUInt32BE(nal2.length, 4 + nal1.length);
    nal2.copy(avcc, 8 + nal1.length);

    const result = convertToAnnexB(avcc);
    expect(result.length).toBeGreaterThan(0);
    // Should contain two start codes
    let startCodes = 0;
    for (let i = 0; i < result.length - 3; i++) {
      if (result[i] === 0 && result[i + 1] === 0 && result[i + 2] === 0 && result[i + 3] === 1) {
        startCodes++;
      }
    }
    expect(startCodes).toBe(2);
  });
});
