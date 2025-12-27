import { BC_MAGIC, BC_MAGIC_REV, bcHeaderHasPayloadOffset } from "./constants.js";

export type AnyBuffer = Buffer<ArrayBufferLike>;

export type BaichuanHeader = {
  magic: AnyBuffer;
  cmdId: number;
  bodyLen: number;
  channelId: number;
  streamType: number;
  msgNum: number;
  responseCode: number;
  messageClass: number;
  payloadOffset?: number;
};

export type BaichuanFrame = {
  header: BaichuanHeader;
  /** Raw body bytes, exactly `bodyLen` bytes (extension+payload, if any). */
  body: AnyBuffer;
  /** `Buffer` slice of `body` for extension (can be empty). */
  extension: AnyBuffer;
  /** `Buffer` slice of `body` for payload (can be empty). */
  payload: AnyBuffer;
  /** Convenience key: u32 little-endian from header bytes [12..16]. */
  messageKey: number;
  /** Total raw bytes of this frame: header+body. */
  raw: AnyBuffer;
};

export function encodeHeader(h: Omit<BaichuanHeader, "magic"> & { magic?: AnyBuffer }): AnyBuffer {
  const hasOffset = bcHeaderHasPayloadOffset(h.messageClass);
  const headerLen = hasOffset ? 24 : 20;
  const buf = Buffer.alloc(headerLen) as AnyBuffer;

  const magic = (h.magic ?? (BC_MAGIC as AnyBuffer)) as AnyBuffer;
  if (magic.length !== 4) throw new Error("magic must be 4 bytes");
  magic.copy(buf, 0);

  buf.writeUInt32LE(h.cmdId >>> 0, 4);
  buf.writeUInt32LE(h.bodyLen >>> 0, 8);
  buf.writeUInt8(h.channelId & 0xff, 12);
  buf.writeUInt8(h.streamType & 0xff, 13);
  buf.writeUInt16LE(h.msgNum & 0xffff, 14);
  buf.writeUInt16LE(h.responseCode & 0xffff, 16);
  buf.writeUInt16LE(h.messageClass & 0xffff, 18);
  if (hasOffset) {
    buf.writeUInt32LE((h.payloadOffset ?? 0) >>> 0, 20);
  }
  return buf;
}

export function decodeHeader(buf: AnyBuffer): { header: BaichuanHeader; headerLen: number; messageKey: number } {
  if (buf.length < 20) throw new Error("not enough data for Baichuan header");

  const magic = buf.subarray(0, 4);
  if (!magic.equals(BC_MAGIC) && !magic.equals(BC_MAGIC_REV)) {
    throw new Error(`invalid Baichuan magic: ${magic.toString("hex")}`);
  }

  const cmdId = buf.readUInt32LE(4);
  const bodyLen = buf.readUInt32LE(8);
  const channelId = buf.readUInt8(12);
  const streamType = buf.readUInt8(13);
  const msgNum = buf.readUInt16LE(14);
  const responseCode = buf.readUInt16LE(16);
  const messageClass = buf.readUInt16LE(18);

  const headerLen = bcHeaderHasPayloadOffset(messageClass) ? 24 : 20;
  if (buf.length < headerLen) throw new Error("not enough data for Baichuan header (needs 24 bytes)");

  const messageKey = buf.readUInt32LE(12);
  const header: BaichuanHeader = {
    magic: Buffer.from(magic) as AnyBuffer,
    cmdId,
    bodyLen,
    channelId,
    streamType,
    msgNum,
    responseCode,
    messageClass,
  };
  if (headerLen === 24) {
    header.payloadOffset = buf.readUInt32LE(20);
  }

  return { header, headerLen, messageKey };
}

/**
 * Streaming parser for Baichuan TCP.
 * It follows the Python reference behavior:
 * - expects each message to start with the magic header
 * - supports multiple messages per TCP chunk
 * - waits for full body before emitting
 */
export class BaichuanFrameParser {
  private buffer: AnyBuffer = Buffer.alloc(0) as AnyBuffer;

  push(chunk: Buffer): BaichuanFrame[] {
    if (chunk.length === 0) return [];
    const c = chunk as AnyBuffer;
    this.buffer = this.buffer.length === 0 ? c : (Buffer.concat([this.buffer, c]) as AnyBuffer);
    const out: BaichuanFrame[] = [];

    while (true) {
      // Need at least 4 to check magic
      if (this.buffer.length < 4) break;

      // Realign to magic if needed
      if (!this.buffer.subarray(0, 4).equals(BC_MAGIC) && !this.buffer.subarray(0, 4).equals(BC_MAGIC_REV)) {
        const idx = this.buffer.indexOf(BC_MAGIC);
        const idxRev = this.buffer.indexOf(BC_MAGIC_REV);
        const next = idx === -1 ? idxRev : idxRev === -1 ? idx : Math.min(idx, idxRev);
        if (next === -1) {
          // keep only last 3 bytes in case they start a magic prefix
          this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3));
          break;
        }
        this.buffer = this.buffer.subarray(next);
        if (this.buffer.length < 20) break;
      }

      if (this.buffer.length < 20) break;
      let headerInfo: ReturnType<typeof decodeHeader>;
      try {
        headerInfo = decodeHeader(this.buffer);
      } catch {
        // not enough for 24 bytes or invalid; wait for more
        break;
      }

      const { header, headerLen, messageKey } = headerInfo;
      const frameLen = headerLen + header.bodyLen;
      if (this.buffer.length < frameLen) break;

      const raw = this.buffer.subarray(0, frameLen);
      const body = raw.subarray(headerLen);

      let extLen = 0;
      if (headerLen === 24) {
        const off = header.payloadOffset ?? 0;
        // payloadOffset==0 can mean "no extension", treat as extLen=0
        extLen = off > 0 ? Math.min(off, header.bodyLen) : 0;
      }
      const extension = body.subarray(0, extLen);
      const payload = body.subarray(extLen);

      out.push({ header, body, extension, payload, messageKey, raw });
      this.buffer = this.buffer.subarray(frameLen);
    }

    return out;
  }
}

