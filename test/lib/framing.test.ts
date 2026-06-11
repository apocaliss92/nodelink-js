import { describe, it, expect } from "vitest";
import {
  encodeHeader,
  decodeHeader,
  BaichuanFrameParser,
  type BaichuanHeader,
} from "../../src/protocol/framing";
import { BC_MAGIC, BC_CLASS_MODERN_24, BC_CLASS_LEGACY } from "../../src/protocol/constants";

/** Build a complete on-the-wire Baichuan frame (header + body) for tests. */
function makeFrame(
  cmdId: number,
  body: Buffer,
  messageClass: number = BC_CLASS_LEGACY,
  payloadOffset = 0,
): Buffer {
  const header = encodeHeader({
    cmdId,
    bodyLen: body.length,
    channelId: 0,
    streamType: 0,
    msgNum: cmdId,
    responseCode: 200,
    messageClass,
    payloadOffset,
  });
  return Buffer.concat([header as Buffer, body]);
}

/** Feed a byte stream through the parser one slice at a time. */
function feedInChunks(
  parser: BaichuanFrameParser,
  data: Buffer,
  chunkSize: number,
): ReturnType<BaichuanFrameParser["push"]> {
  const all: ReturnType<BaichuanFrameParser["push"]> = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    const slice = data.subarray(i, Math.min(i + chunkSize, data.length));
    all.push(...parser.push(slice as Buffer));
  }
  return all;
}

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

describe("BaichuanFrameParser streaming accumulation", () => {
  it("reassembles a single large frame split across many tiny chunks", () => {
    // Body large enough to be fragmented across many small TCP reads.
    const body = Buffer.alloc(5000);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
    const frame = makeFrame(3, body, BC_CLASS_MODERN_24, 0);

    const parser = new BaichuanFrameParser();
    // 1-byte chunks: the pathological fragmentation case the optimization targets.
    const frames = feedInChunks(parser, frame, 1);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.header.cmdId).toBe(3);
    expect(frames[0]!.header.bodyLen).toBe(body.length);
    expect(Buffer.compare(frames[0]!.body as Buffer, body)).toBe(0);
    expect(Buffer.compare(frames[0]!.raw as Buffer, frame)).toBe(0);
  });

  it("emits identical frames regardless of chunk size (1, 3, 7, whole)", () => {
    const body = Buffer.from("a".repeat(1234), "utf8");
    const frame = makeFrame(80, body, BC_CLASS_LEGACY);

    const collect = (chunkSize: number) => {
      const p = new BaichuanFrameParser();
      const fs = feedInChunks(p, frame, chunkSize);
      return fs.map((f) => ({
        cmdId: f.header.cmdId,
        bodyLen: f.header.bodyLen,
        body: (f.body as Buffer).toString("hex"),
      }));
    };

    const whole = collect(frame.length);
    expect(whole).toHaveLength(1);
    for (const size of [1, 3, 7, 100]) {
      expect(collect(size)).toEqual(whole);
    }
  });

  it("parses multiple messages delivered in a single chunk", () => {
    const f1 = makeFrame(1, Buffer.from("first"), BC_CLASS_LEGACY);
    const f2 = makeFrame(2, Buffer.from("second-body"), BC_CLASS_MODERN_24, 0);
    const f3 = makeFrame(3, Buffer.from("third!"), BC_CLASS_LEGACY);
    const combined = Buffer.concat([f1, f2, f3]);

    const parser = new BaichuanFrameParser();
    const frames = parser.push(combined as Buffer);

    expect(frames.map((f) => f.header.cmdId)).toEqual([1, 2, 3]);
    expect((frames[0]!.body as Buffer).toString()).toBe("first");
    expect((frames[1]!.body as Buffer).toString()).toBe("second-body");
    expect((frames[2]!.body as Buffer).toString()).toBe("third!");
  });

  it("parses multiple messages split across chunk boundaries", () => {
    const f1 = makeFrame(1, Buffer.from("alpha"), BC_CLASS_LEGACY);
    const f2 = makeFrame(2, Buffer.from("beta-payload"), BC_CLASS_LEGACY);
    const combined = Buffer.concat([f1, f2]);

    const parser = new BaichuanFrameParser();
    // Tiny chunks force frame boundaries to land mid-header and mid-body.
    const frames = feedInChunks(parser, combined, 2);

    expect(frames.map((f) => f.header.cmdId)).toEqual([1, 2]);
    expect((frames[0]!.body as Buffer).toString()).toBe("alpha");
    expect((frames[1]!.body as Buffer).toString()).toBe("beta-payload");
  });

  it("realigns to the magic when the stream has leading junk bytes", () => {
    const junk = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]);
    const frame = makeFrame(46, Buffer.from("realigned"), BC_CLASS_LEGACY);
    const stream = Buffer.concat([junk, frame]);

    const parser = new BaichuanFrameParser();
    const frames = parser.push(stream as Buffer);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.header.cmdId).toBe(46);
    expect((frames[0]!.body as Buffer).toString()).toBe("realigned");
  });

  it("realigns across chunks when junk and magic are split (1-byte chunks)", () => {
    // Junk bytes that include a partial magic prefix to stress realignment.
    const junk = Buffer.from([0xf0, 0xde, 0x00, 0x99, 0xf0]);
    const frame = makeFrame(33, Buffer.from("payload-after-junk"), BC_CLASS_LEGACY);
    const stream = Buffer.concat([junk, frame]);

    const parser = new BaichuanFrameParser();
    const frames = feedInChunks(parser, stream, 1);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.header.cmdId).toBe(33);
    expect((frames[0]!.body as Buffer).toString()).toBe("payload-after-junk");
  });

  it("waits for a complete body before emitting (partial frame held back)", () => {
    const body = Buffer.from("incomplete-until-the-end");
    const frame = makeFrame(3, body, BC_CLASS_LEGACY);

    const parser = new BaichuanFrameParser();
    // Feed everything except the last byte: nothing should be emitted yet.
    const partial = parser.push(frame.subarray(0, frame.length - 1) as Buffer);
    expect(partial).toHaveLength(0);

    // Final byte completes the frame.
    const rest = parser.push(frame.subarray(frame.length - 1) as Buffer);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.header.cmdId).toBe(3);
    expect((rest[0]!.body as Buffer).toString()).toBe(body.toString());
  });

  it("splits extension and payload at payloadOffset for 24-byte frames", () => {
    const ext = Buffer.from("EXTN");
    const payload = Buffer.from("the-actual-payload");
    const body = Buffer.concat([ext, payload]);
    const frame = makeFrame(3, body, BC_CLASS_MODERN_24, ext.length);

    const parser = new BaichuanFrameParser();
    const frames = feedInChunks(parser, frame, 3);

    expect(frames).toHaveLength(1);
    expect((frames[0]!.extension as Buffer).toString()).toBe("EXTN");
    expect((frames[0]!.payload as Buffer).toString()).toBe("the-actual-payload");
  });

  it("handles two frames where the first is fragmented and second is whole", () => {
    const big = Buffer.alloc(3000, 0x42);
    const f1 = makeFrame(3, big, BC_CLASS_MODERN_24, 0);
    const f2 = makeFrame(4, Buffer.from("stop"), BC_CLASS_LEGACY);

    const parser = new BaichuanFrameParser();
    const out: number[] = [];
    // Fragment f1 heavily, then deliver f2 in one shot.
    for (let i = 0; i < f1.length; i += 5) {
      const slice = f1.subarray(i, Math.min(i + 5, f1.length));
      out.push(...parser.push(slice as Buffer).map((f) => f.header.cmdId));
    }
    out.push(...parser.push(f2 as Buffer).map((f) => f.header.cmdId));

    expect(out).toEqual([3, 4]);
  });

  it("returns [] for an empty chunk", () => {
    const parser = new BaichuanFrameParser();
    expect(parser.push(Buffer.alloc(0) as Buffer)).toEqual([]);
  });
});
