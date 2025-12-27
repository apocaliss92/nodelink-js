import { describe, expect, it } from "vitest";
import { BC_CLASS_MODERN_24, BC_MAGIC } from "../src/protocol/constants.js";
import { BaichuanFrameParser, decodeHeader, encodeHeader } from "../src/protocol/framing.js";

describe("framing", () => {
  it("encodeHeader/decodeHeader roundtrip (24 byte)", () => {
    const header = encodeHeader({
      magic: BC_MAGIC,
      cmdId: 93,
      bodyLen: 10,
      channelId: 250,
      streamType: 0,
      msgNum: 123,
      responseCode: 0,
      messageClass: BC_CLASS_MODERN_24,
      payloadOffset: 4,
    });
    const dec = decodeHeader(header);
    expect(dec.header.cmdId).toBe(93);
    expect(dec.header.bodyLen).toBe(10);
    expect(dec.header.payloadOffset).toBe(4);
    expect(dec.header.messageClass).toBe(BC_CLASS_MODERN_24);
  });

  it("parser yields frames across chunks", () => {
    const header = encodeHeader({
      cmdId: 93,
      bodyLen: 5,
      channelId: 250,
      streamType: 0,
      msgNum: 1,
      responseCode: 200,
      messageClass: BC_CLASS_MODERN_24,
      payloadOffset: 0,
    });
    const body = Buffer.from("abcde", "utf8");
    const wire = Buffer.concat([header, body]);

    const p = new BaichuanFrameParser();
    const a = p.push(wire.subarray(0, 7));
    expect(a.length).toBe(0);
    const b = p.push(wire.subarray(7));
    expect(b.length).toBe(1);
    expect(b[0]!.header.cmdId).toBe(93);
    expect(b[0]!.body.toString("utf8")).toBe("abcde");
  });
});

