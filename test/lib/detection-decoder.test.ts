import { describe, it, expect } from "vitest";
import {
  decodeDetectionHeader,
  hasStandardMarker,
} from "../../src/reolink/baichuan/utils/detection";

// Samples lifted verbatim from `npx tsx tools/pcap/iframe-header-scan.ts`
// against `pcap/motion boxes.pcapng` and `pcap/all-traffic.pcapng`.
// They represent the three distinct shapes we care about:
//  - 128B P-frame  (baseline, no overlay)
//  - 152B P-frame  (overlay block present, smallest variant)
//  - 192B P-frame  (overlay block present, common variant)
//  - 160B I-frame  (8-byte iframe prefix + 152B baseline-style block)
const PFRAME_128_HEX =
  "ff7800010b0001080ec0da4462a9b5919580927835ef19b249eb01" +
  "8173a8345d40e424968d5c8e74f3baad11c7275a75db5e2cb53fcd" +
  "3adb48e83fcf660c89bc1b7a7ee335a6e93efc3d692e8b79f233e0" +
  "62e31a79d670fdbd19e67b2597ba313ec7423fc966f4b593e74c72" +
  "1c60c025717556119de7fc44b1f02f3613ade947";
const PFRAME_152_HEX =
  "ff8f00010b0001080ef8be4362a9b59195808b7835ef19b2c564ff" +
  "313174d4a12ec996493842d4acb4ce809d6dd278e477b7c14f6b0c" +
  "cfe3e6148479f7eac7cd467bf8fdb913047bb8fcf6538e215f4dd9" +
  "63658c87067c842f310face13368f861ec900f896f39741d65e21b" +
  "13b23ece7d6ad567beecfa502a05312114554e177d47935f384ae4" +
  "70b864d3b17aca1732aaa2ad7e1e5a153f";
const PFRAME_192_HEX =
  "ffb900010b0001080e73f84f62a9b59195805d7835ef19b28937d7" +
  "301c8def546ca059c63f9b5a0a0b82d21dc5fb79adbf9a9bd6c148" +
  "7d79c6ed1332c16638e7984ad7ae233d08f95e904e2088d0eaa85f" +
  "99e4102369d4ef59edc97842c1cdb8ef461b97b2f63a01b1b7e065" +
  "0d72925141ac2eb2801e85579b99aff09ee9d8071298c695a6bdc5" +
  "2b589b198a0a0ae2dabf860a8b40bfbd264930effd835ccd105b15" +
  "4c292ad4d72d840c85394058ceb11b6149ba2999beb016a470bf1a" +
  "87c59e";
const IFRAME_160_HEX =
  "6c05066a2a01c300ff8f00010b000108008fd022105f0000000" +
  "27e000104006c7a342002740004224d186440a761000000f009" +
  "016000031d00010800249821105f0000000508002c8c4900010" +
  "08f030400800260010120000c1f0220000d0f63004f1f036300" +
  "4ff100040b00fc08000105e7030201010005f400318fd022340" +
  "1600208004dd47a33018000030400000000000000000025607" +
  "723000000000000";

function bufFromHex(hex: string): Buffer {
  return Buffer.from(hex.replace(/\s+/g, ""), "hex");
}

describe("decodeDetectionHeader", () => {
  it("validates the marker on a baseline 128B P-frame header", () => {
    const raw = bufFromHex(PFRAME_128_HEX);
    expect(raw.length).toBe(128);
    expect(hasStandardMarker(raw, 0)).toBe(true);
    const decoded = decodeDetectionHeader(raw, "Pframe");
    expect(decoded.state).toBe("no-overlay");
    expect(decoded.markerOffset).toBe(0);
    expect(decoded.blockLength).toBe(128);
    expect(decoded.boxes).toEqual([]);
    expect(decoded.counter).toBeDefined();
  });

  it("reports overlay-undecoded for a 152B P-frame header", () => {
    const raw = bufFromHex(PFRAME_152_HEX);
    expect(raw.length).toBe(152);
    const decoded = decodeDetectionHeader(raw, "Pframe");
    expect(decoded.state).toBe("overlay-undecoded");
    expect(decoded.blockLength).toBe(152);
    expect(decoded.boxes).toEqual([]);
  });

  it("reports overlay-undecoded for a 192B P-frame header", () => {
    const raw = bufFromHex(PFRAME_192_HEX);
    expect(raw.length).toBe(192);
    const decoded = decodeDetectionHeader(raw, "Pframe");
    expect(decoded.state).toBe("overlay-undecoded");
    expect(decoded.blockLength).toBe(192);
  });

  it("strips the 8-byte I-frame prefix before validating the marker", () => {
    const raw = bufFromHex(IFRAME_160_HEX);
    expect(raw.length).toBe(160);
    // Marker is NOT at offset 0 for I-frames; should appear at offset 8.
    expect(hasStandardMarker(raw, 0)).toBe(false);
    expect(hasStandardMarker(raw, 8)).toBe(true);
    const decoded = decodeDetectionHeader(raw, "Iframe");
    expect(decoded.state).toBe("overlay-undecoded");
    expect(decoded.markerOffset).toBe(8);
    expect(decoded.blockLength).toBe(152);
  });

  it("rejects buffers without the marker", () => {
    const garbage = Buffer.alloc(128, 0x42);
    const decoded = decodeDetectionHeader(garbage, "Pframe");
    expect(decoded.state).toBe("invalid-marker");
    expect(decoded.boxes).toEqual([]);
  });

  it("rejects buffers that are too short", () => {
    const tiny = Buffer.from("ff8f00010b00", "hex");
    const decoded = decodeDetectionHeader(tiny, "Pframe");
    expect(decoded.state).toBe("invalid-marker");
  });

  it("extracts a per-frame counter from P-frames", () => {
    // The two samples come from different frames of the same stream; counters
    // should differ (P-frames carry an incrementing counter at marker+0x08).
    const a = decodeDetectionHeader(bufFromHex(PFRAME_128_HEX), "Pframe");
    const b = decodeDetectionHeader(bufFromHex(PFRAME_152_HEX), "Pframe");
    expect(a.counter).toBeDefined();
    expect(b.counter).toBeDefined();
    expect(a.counter).not.toBe(b.counter);
  });

  /**
   * 200-byte P-frame additionalHeader captured live via DYLD_INSERT_LIBRARIES
   * hook of the Reolink macOS SDK. The hook log confirmed the SDK assigned
   * this box to `view0 class1` (= people view0). Our decoder should:
   *   1) decompress the LZ4F payload (action 2 dispatch)
   *   2) walk the resulting TLV stream
   *   3) find the box at (type1=1, type2=3)
   *   4) emit it normalized to [0,1] with label="people" and confidence
   */
  const PFRAME_200_PEOPLE_BOX_HEX =
    "ffb400010b00010800057c864ff000000002a3000104006c7a342002990004224d186440a786000000f009016d00032a00010800a5b8854ff0000000050800d17d9d000100ff070304008003e001040a00bd000b014c0128012200011d2d000b1f0220000d4f7100032e43000b27040e70004f6265000274002d4f0360000397000c0f63002d50040b00fc08340101020011056e0031057c865201f0030208000cf03a010000000003040000000000000000004995ebbafb040001010000f9040001010000000000";

  it("decompresses LZ4F payload and labels the box as 'people'", () => {
    const raw = bufFromHex(PFRAME_200_PEOPLE_BOX_HEX);
    expect(raw.length).toBe(200);
    const decoded = decodeDetectionHeader(raw, "Pframe");
    expect(decoded.state).toBe("overlay-decoded");
    expect(decoded.boxes.length).toBeGreaterThanOrEqual(1);
    // The SDK output for this exact sample was [189, 267, 332, 296, 34]
    // (= top-left/bottom-right in 896×480) → normalized to:
    //   x = 189/896 ≈ 0.2109
    //   y = 267/480 ≈ 0.5562
    //   width = (332-189)/896 ≈ 0.1596
    //   height = (296-267)/480 ≈ 0.0604
    const box = decoded.boxes[0]!;
    expect(box.label).toBe("people");
    expect(box.confidence).toBeCloseTo(0.34, 2);
    expect(box.x).toBeCloseTo(189 / 896, 3);
    expect(box.y).toBeCloseTo(267 / 480, 3);
    expect(box.width).toBeCloseTo((332 - 189) / 896, 3);
    expect(box.height).toBeCloseTo((296 - 267) / 480, 3);
  });
});
