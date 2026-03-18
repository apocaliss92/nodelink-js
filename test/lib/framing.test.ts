import { describe, it, expect } from "vitest";
import { encodeHeader, decodeHeader, type BaichuanHeader } from "../../src/protocol/framing";
import { BC_MAGIC, BC_CLASS_MODERN_24, BC_CLASS_LEGACY } from "../../src/protocol/constants";

// BC_CLASS_MODERN_24 (0x6414) = 24-byte header with payloadOffset
// BC_CLASS_LEGACY (0x6514) = 20-byte header without payloadOffset

describe("Baichuan binary framing", () => {
  describe("encodeHeader / decodeHeader round-trip", () => {
    it("round-trips a 20-byte legacy header", () => {
      const h: Omit<BaichuanHeader, "magic"> = {
        cmdId: 1,
        bodyLen: 128,
        channelId: 0,
        streamType: 0,
        msgNum: 42,
        responseCode: 200,
        messageClass: BC_CLASS_LEGACY,
      };
      const encoded = encodeHeader(h);
      expect(encoded.length).toBe(20);

      const { header, headerLen } = decodeHeader(encoded);
      expect(headerLen).toBe(20);
      expect(header.cmdId).toBe(1);
      expect(header.bodyLen).toBe(128);
      expect(header.msgNum).toBe(42);
      expect(header.responseCode).toBe(200);
    });

    it("round-trips a 24-byte modern header with payloadOffset", () => {
      const h: Omit<BaichuanHeader, "magic"> = {
        cmdId: 80,
        bodyLen: 256,
        channelId: 0,
        streamType: 0,
        msgNum: 1,
        responseCode: 200,
        messageClass: BC_CLASS_MODERN_24,
        payloadOffset: 32,
      };
      const encoded = encodeHeader(h);
      expect(encoded.length).toBe(24);

      const { header, headerLen } = decodeHeader(encoded);
      expect(headerLen).toBe(24);
      expect(header.cmdId).toBe(80);
      expect(header.payloadOffset).toBe(32);
    });

    it("magic bytes are correct", () => {
      const encoded = encodeHeader({
        cmdId: 1, bodyLen: 0, channelId: 0, streamType: 0,
        msgNum: 0, responseCode: 0, messageClass: BC_CLASS_LEGACY,
      });
      expect(encoded.subarray(0, 4)).toEqual(BC_MAGIC);
    });
  });

  describe("decodeHeader validation", () => {
    it("throws on too-short buffer", () => {
      expect(() => decodeHeader(Buffer.alloc(10) as any)).toThrow("not enough data");
    });

    it("throws on invalid magic", () => {
      const buf = Buffer.alloc(20);
      buf.writeUInt32BE(0xdeadbeef, 0);
      expect(() => decodeHeader(buf as any)).toThrow("invalid Baichuan magic");
    });

    it("extracts channelId for NVR", () => {
      const encoded = encodeHeader({
        cmdId: 80, bodyLen: 100, channelId: 3, streamType: 0,
        msgNum: 5, responseCode: 200, messageClass: BC_CLASS_LEGACY,
      });
      const { header } = decodeHeader(encoded);
      expect(header.channelId).toBe(3);
    });

    it("extracts streamType for video", () => {
      const encoded = encodeHeader({
        cmdId: 3, bodyLen: 50000, channelId: 0, streamType: 2,
        msgNum: 100, responseCode: 200, messageClass: BC_CLASS_MODERN_24,
      });
      const { header } = decodeHeader(encoded);
      expect(header.streamType).toBe(2);
    });
  });

  describe("messageClass determines header size", () => {
    it("BC_CLASS_MODERN_24 (0x6414) → 24 bytes", () => {
      const enc = encodeHeader({
        cmdId: 1, bodyLen: 0, channelId: 0, streamType: 0,
        msgNum: 0, responseCode: 0, messageClass: BC_CLASS_MODERN_24,
      });
      expect(enc.length).toBe(24);
    });

    it("BC_CLASS_LEGACY (0x6514) → 20 bytes", () => {
      const enc = encodeHeader({
        cmdId: 1, bodyLen: 0, channelId: 0, streamType: 0,
        msgNum: 0, responseCode: 0, messageClass: BC_CLASS_LEGACY,
      });
      expect(enc.length).toBe(20);
    });

    it("0x0000 (alt modern) → 24 bytes", () => {
      const enc = encodeHeader({
        cmdId: 1, bodyLen: 0, channelId: 0, streamType: 0,
        msgNum: 0, responseCode: 0, messageClass: 0x0000,
      });
      expect(enc.length).toBe(24);
    });
  });
});
