import { BCUDP_MAGIC_ACK, BCUDP_MAGIC_DATA, BCUDP_MAGIC_NEGO } from "./constants.js";
import { bcudpCrc32 } from "./crc.js";
import { bcudpXmlDecrypt, bcudpXmlEncrypt } from "./xmlCrypto.js";

export type BcUdpPacket =
  | { kind: "discovery"; tid: number; xml: string }
  | { kind: "ack"; connectionId: number; groupId: number; packetId: number; maybeLatency: number; payload: Buffer }
  | { kind: "data"; connectionId: number; packetId: number; payload: Buffer };

function readI32LE(buf: Buffer, offset: number): number {
  return buf.readInt32LE(offset);
}

export function encodeDiscoveryPacket(tid: number, xml: string): Buffer {
  const xmlBytes = Buffer.from(xml, "utf8");
  const enc = bcudpXmlEncrypt(tid, xmlBytes);
  const checksum = bcudpCrc32(enc);

  const header = Buffer.alloc(20);
  header.writeUInt32LE(BCUDP_MAGIC_NEGO, 0);
  header.writeUInt32LE(enc.length >>> 0, 4);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(tid >>> 0, 12);
  header.writeUInt32LE(checksum >>> 0, 16);
  return Buffer.concat([header, enc]);
}

export function encodeAckPacket(params: {
  connectionId: number;
  groupId: number;
  packetId: number;
  maybeLatency?: number;
  payload?: Buffer;
}): Buffer {
  const payload = params.payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(BCUDP_MAGIC_ACK, 0);
  header.writeInt32LE(params.connectionId | 0, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(params.groupId >>> 0, 12);
  header.writeUInt32LE(params.packetId >>> 0, 16);
  header.writeUInt32LE((params.maybeLatency ?? 0) >>> 0, 20);
  header.writeUInt32LE(payload.length >>> 0, 24);
  return Buffer.concat([header, payload]);
}

export function encodeDataPacket(params: { connectionId: number; packetId: number; payload: Buffer }): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(BCUDP_MAGIC_DATA, 0);
  header.writeInt32LE(params.connectionId | 0, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(params.packetId >>> 0, 12);
  header.writeUInt32LE(params.payload.length >>> 0, 16);
  return Buffer.concat([header, params.payload]);
}

export function decodeBcUdpPacket(buf: Buffer): BcUdpPacket {
  if (buf.length < 4) throw new Error("BCUDP packet too short");
  const magic = buf.readUInt32LE(0);

  if (magic === BCUDP_MAGIC_NEGO) {
    if (buf.length < 20) throw new Error("BCUDP discovery header too short");
    const payloadSize = buf.readUInt32LE(4);
    const unknownA = buf.readUInt32LE(8);
    if (unknownA !== 1) throw new Error(`BCUDP discovery unknownA expected 1, got ${unknownA}`);
    const tid = buf.readUInt32LE(12);
    const checksum = buf.readUInt32LE(16);
    const enc = buf.subarray(20);
    if (enc.length < payloadSize) throw new Error("BCUDP discovery payload truncated");
    const encSlice = enc.subarray(0, payloadSize);
    const actual = bcudpCrc32(encSlice);
    if ((checksum >>> 0) !== (actual >>> 0)) throw new Error("BCUDP discovery CRC mismatch");
    const plain = bcudpXmlDecrypt(tid, encSlice);
    return { kind: "discovery", tid, xml: plain.toString("utf8") };
  }

  if (magic === BCUDP_MAGIC_ACK) {
    if (buf.length < 28) throw new Error("BCUDP ack header too short");
    const connectionId = readI32LE(buf, 4);
    const unknownA = buf.readUInt32LE(8);
    if (unknownA !== 0) throw new Error(`BCUDP ack unknownA expected 0, got ${unknownA}`);
    const groupId = buf.readUInt32LE(12);
    const packetId = buf.readUInt32LE(16);
    const maybeLatency = buf.readUInt32LE(20);
    const payloadSize = buf.readUInt32LE(24);
    const payload = buf.subarray(28);
    if (payload.length < payloadSize) throw new Error("BCUDP ack payload truncated");
    return { kind: "ack", connectionId, groupId, packetId, maybeLatency, payload: payload.subarray(0, payloadSize) };
  }

  if (magic === BCUDP_MAGIC_DATA) {
    if (buf.length < 20) throw new Error("BCUDP data header too short");
    const connectionId = readI32LE(buf, 4);
    const unknownA = buf.readUInt32LE(8);
    if (unknownA !== 0) throw new Error(`BCUDP data unknownA expected 0, got ${unknownA}`);
    const packetId = buf.readUInt32LE(12);
    const payloadSize = buf.readUInt32LE(16);
    const payload = buf.subarray(20);
    if (payload.length < payloadSize) throw new Error("BCUDP data payload truncated");
    return { kind: "data", connectionId, packetId, payload: payload.subarray(0, payloadSize) };
  }

  throw new Error(`Unknown BCUDP magic 0x${magic.toString(16)}`);
}

