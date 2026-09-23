import {
  BC_MAGIC,
  BC_MAGIC_REV,
  BC_MIN_PLAUSIBLE_PAYLOAD_OFFSET,
  bcHeaderHasPayloadOffset,
  bcHeaderIsKnown20,
} from "./constants";

/**
 * How long this frame's header is: 20 bytes, or 24 with a `payloadOffset`.
 *
 * A known class answers on its own, exactly as it always has. An UNKNOWN class
 * is decided by looking at bytes [20..24) and asking whether they could be a
 * payloadOffset for this body.
 *
 * ## Why an allow-list was not enough
 *
 * `messageClass` is not always a class. Measured 2026-09-23 on an E1 Outdoor
 * PoE (v3.1.0.5223) and a Home Hub (v3.3.0.456): after a `<ReplaySeek>`
 * (cmd 123) the camera stamps every cmd 5 frame's `[responseCode|messageClass]`
 * u32 with a WALL-CLOCK SECOND — `0x6ab3_7cfc` = 1 790 128 892, whose high half
 * `0x6ab3` then lands in `messageClass`. It changes every second, so no
 * allow-list can ever contain it. Read as a 20-byte header those frames come
 * out shifted by four bytes: the extension/payload split is lost, `encryptLen`
 * is never seen, and the first 1 024 bytes of every chunk stay encrypted. That
 * is why in-clip seek looked impossible.
 *
 * A false positive needs four body bytes that read as a u32 in
 * `[20, bodyLen]` — on the order of 1e-5 for a 40 KB body of ciphertext — and
 * it can only happen on a class we have never seen, which today is decoded to
 * garbage anyway. A false NEGATIVE is the old behaviour exactly.
 */
export function bcHeaderLen(
  messageClass: number,
  buf: AnyBuffer,
  bodyLen: number,
): 20 | 24 {
  if (bcHeaderHasPayloadOffset(messageClass)) return 24;
  if (bcHeaderIsKnown20(messageClass)) return 20;
  if (buf.length < 24) {
    // Undecidable yet. Ask the caller for the four bytes that decide it; the
    // stream parser already treats this as "wait for 24".
    throw new Error("not enough data for Baichuan header (needs 24 bytes)");
  }
  const candidate = buf.readUInt32LE(20);
  return candidate >= BC_MIN_PLAUSIBLE_PAYLOAD_OFFSET && candidate <= bodyLen
    ? 24
    : 20;
}

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

  const headerLen = bcHeaderLen(messageClass, buf, bodyLen);
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
 *
 * Accumulation strategy: incoming chunks are appended to a pending list
 * (O(1) per chunk) and only concatenated into a contiguous `this.buffer`
 * when a parse is actually attempted. This avoids the previous O(n²)
 * behavior where every TCP chunk re-copied the whole retained buffer —
 * costly for large video frames fragmented across many small chunks.
 *
 * The observable behavior (the exact sequence of frames emitted, magic
 * realignment, multi-message chunks, waiting for a complete body) is
 * identical to the prior `Buffer.concat`-per-chunk implementation.
 */
export class BaichuanFrameParser {
  /** Retained-but-unconsumed contiguous bytes from previous push() calls. */
  private buffer: AnyBuffer = Buffer.alloc(0) as AnyBuffer;
  /** Chunks received since the last materialization, not yet concatenated. */
  private pending: AnyBuffer[] = [];
  /** Total bytes held in `pending` (kept in sync to avoid re-summing). */
  private pendingLen = 0;
  /**
   * Total contiguous bytes (`buffer` + `pending`) required before the next
   * parse attempt can make progress. While buffered bytes stay below this,
   * incoming chunks are merely stashed in `pending` with no copy. This is
   * the mechanism that turns the worst case (a large frame fragmented over
   * many small TCP chunks) from O(n²) into O(n): we concatenate once, when
   * enough bytes have arrived, instead of on every chunk.
   *
   * Starts at 4 — the minimum needed to inspect the magic header.
   */
  private needed = 4;

  /**
   * Collapse `this.buffer` + all `pending` chunks into a single contiguous
   * buffer. The retained leftover is copied at most once per materialize(),
   * and materialize() only runs when `needed` bytes are available — so a
   * fragmented frame is assembled with a single concat, not one per chunk.
   */
  private materialize(): void {
    if (this.pendingLen === 0) return;
    if (this.buffer.length === 0 && this.pending.length === 1) {
      // Fast path: single chunk, no leftover — adopt it without copying.
      this.buffer = this.pending[0]!;
    } else {
      const parts =
        this.buffer.length === 0 ? this.pending : [this.buffer, ...this.pending];
      this.buffer = Buffer.concat(parts) as AnyBuffer;
    }
    this.pending = [];
    this.pendingLen = 0;
  }

  /** Total buffered bytes, whether materialized or still pending. */
  private get available(): number {
    return this.buffer.length + this.pendingLen;
  }

  push(chunk: Buffer): BaichuanFrame[] {
    if (chunk.length === 0) return [];
    // Defer concatenation: stash the chunk (O(1)). We only materialize and
    // parse once enough bytes are available to advance past the point where
    // the previous parse stopped — see `needed`.
    this.pending.push(chunk as AnyBuffer);
    this.pendingLen += chunk.length;
    if (this.available < this.needed) return [];

    this.materialize();
    const out: BaichuanFrame[] = [];

    while (true) {
      // Need at least 4 to check magic
      if (this.buffer.length < 4) {
        this.needed = 4;
        break;
      }

      // Realign to magic if needed
      if (!this.buffer.subarray(0, 4).equals(BC_MAGIC) && !this.buffer.subarray(0, 4).equals(BC_MAGIC_REV)) {
        const idx = this.buffer.indexOf(BC_MAGIC);
        const idxRev = this.buffer.indexOf(BC_MAGIC_REV);
        const next = idx === -1 ? idxRev : idxRev === -1 ? idx : Math.min(idx, idxRev);
        if (next === -1) {
          // keep only last 3 bytes in case they start a magic prefix
          this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3));
          this.needed = 4;
          break;
        }
        this.buffer = this.buffer.subarray(next);
        if (this.buffer.length < 20) {
          this.needed = 20;
          break;
        }
      }

      if (this.buffer.length < 20) {
        this.needed = 20;
        break;
      }
      let headerInfo: ReturnType<typeof decodeHeader>;
      try {
        headerInfo = decodeHeader(this.buffer);
      } catch {
        // not enough for 24 bytes or invalid; wait for more
        this.needed = 24;
        break;
      }

      const { header, headerLen, messageKey } = headerInfo;
      const frameLen = headerLen + header.bodyLen;
      if (this.buffer.length < frameLen) {
        this.needed = frameLen;
        break;
      }

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
      // Emitted a frame; the next iteration re-derives `needed`. Reset to the
      // minimum so a fully-consumed buffer still re-arms on the next push.
      this.needed = 4;
    }

    return out;
  }
}

