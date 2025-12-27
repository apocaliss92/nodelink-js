import { describe, expect, it } from "vitest";
import { bcudpXmlDecrypt, bcudpXmlEncrypt } from "../src/bcudp/xmlCrypto.js";
import { decodeBcUdpPacket, encodeAckPacket, encodeDataPacket, encodeDiscoveryPacket } from "../src/bcudp/packets.js";

describe("bcudp", () => {
  it("xml crypto roundtrip", () => {
    const tid = 87;
    const plain = Buffer.from("<P2P><C2D_HB><cid>1</cid><did>2</did></C2D_HB></P2P>", "utf8");
    const enc = bcudpXmlEncrypt(tid, plain);
    const dec = bcudpXmlDecrypt(tid, enc);
    expect(dec.toString("utf8")).toBe(plain.toString("utf8"));
  });

  it("discovery encode/decode roundtrip", () => {
    const tid = 96;
    const xml = "<P2P><C2D_DISC><cid>82000</cid><did>80</did></C2D_DISC></P2P>";
    const buf = encodeDiscoveryPacket(tid, xml);
    const p = decodeBcUdpPacket(buf);
    expect(p.kind).toBe("discovery");
    if (p.kind === "discovery") {
      expect(p.tid).toBe(tid);
      expect(p.xml).toBe(xml);
    }
  });

  it("ack encode/decode roundtrip", () => {
    const payload = Buffer.from([0, 1, 1, 0, 1]);
    const buf = encodeAckPacket({ connectionId: 80, groupId: 0, packetId: 2439, maybeLatency: 0, payload });
    const p = decodeBcUdpPacket(buf);
    expect(p.kind).toBe("ack");
    if (p.kind === "ack") {
      expect(p.connectionId).toBe(80);
      expect(p.packetId).toBe(2439);
      expect(p.payload.equals(payload)).toBe(true);
    }
  });

  it("data encode/decode roundtrip", () => {
    const payload = Buffer.from("hello", "utf8");
    const buf = encodeDataPacket({ connectionId: 82000, packetId: 1, payload });
    const p = decodeBcUdpPacket(buf);
    expect(p.kind).toBe("data");
    if (p.kind === "data") {
      expect(p.connectionId).toBe(82000);
      expect(p.packetId).toBe(1);
      expect(p.payload.toString("utf8")).toBe("hello");
    }
  });
});

