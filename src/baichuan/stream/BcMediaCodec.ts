/**
 * BcMedia Codec - Assembles fragmented BcMedia packets from stream
 * Based on neolink crates/core/src/bcmedia/codex.rs
 * 
 * BcMedia packets can be fragmented across multiple Baichuan frames.
 * This codec buffers incomplete packets and assembles them when complete.
 */

import { parseBcMedia, type BcMedia } from "./BcMediaParser";

export class BcMediaCodec {
  private buffer: Buffer = Buffer.alloc(0);
  private strict: boolean;
  private amountSkipped: number = 0;

  constructor(strict: boolean = false) {
    this.strict = strict;
  }

  /**
   * Push data into the codec buffer and try to parse complete BcMedia packets.
   * Returns an array of complete BcMedia packets found.
   * 
   * @param chunk - New data chunk to add to buffer
   * @returns Array of complete BcMedia packets (empty if none complete yet)
   */
  decode(chunk: Buffer): BcMedia[] {
    // Append new chunk to buffer
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const results: BcMedia[] = [];

    // Try to parse packets from buffer
    while (this.buffer.length >= 4) { // Need at least 4 bytes for magic
      const result = parseBcMedia(this.buffer);
      
      if (result) {
        // Complete packet found
        if (this.amountSkipped > 0) {
          // Log recovery if we had to skip data
          if (this.strict) {
            console.warn(`[BcMediaCodec] Recovered stream after skipping ${this.amountSkipped} bytes`);
          } else {
            console.warn(`[BcMediaCodec] Recovered stream after skipping ${this.amountSkipped} bytes`);
          }
          this.amountSkipped = 0;
        }
        
        results.push(result.media);
        this.buffer = this.buffer.subarray(result.consumed);
      } else {
        // No complete packet yet.
        // Follow neolink's approach: if the buffer does NOT start with a known magic,
        // in non-strict mode we drop the whole buffer (prevents desync and "fake" packets).
        const magic = this.buffer.readUInt32LE(0);
        const isInfoV1 = magic === 0x31303031;
        const isInfoV2 = magic === 0x32303031;
        const isIFrame = magic >= 0x63643030 && magic <= 0x63643039;
        const isPFrame = magic >= 0x63643130 && magic <= 0x63643139;
        const isAac = magic === 0x62773530;
        const isAdpcm = magic === 0x62773130;
        const isKnownMagic = isInfoV1 || isInfoV2 || isIFrame || isPFrame || isAac || isAdpcm;

        if (isKnownMagic) {
          // Likely incomplete: wait for more data.
          break;
        }

        // Doesn't start with a valid magic: corrupted or misaligned stream.
        if (this.strict) {
          throw new Error(`[BcMediaCodec] Invalid data in stream (no valid magic at buffer start, len=${this.buffer.length})`);
        }

        if (this.amountSkipped === 0) {
          console.warn(`[BcMediaCodec] Error in stream, attempting to recover...`);
        }
        this.amountSkipped += this.buffer.length;
        this.buffer = Buffer.alloc(0);
        break;
      }
    }

    return results;
  }

  /**
   * Get remaining buffer (for debugging)
   */
  getRemainingBuffer(): Buffer {
    return this.buffer;
  }

  /**
   * Clear the buffer (useful for resetting the codec)
   */
  clear(): void {
    this.buffer = Buffer.alloc(0);
    this.amountSkipped = 0;
  }
}

