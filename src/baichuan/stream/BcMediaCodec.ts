/**
 * BcMedia Codec - Assembles fragmented BcMedia packets from stream
 * 
 * BcMedia packets can be fragmented across multiple Baichuan frames.
 * This codec buffers incomplete packets and assembles them when complete.
 */

import { parseBcMedia, type BcMedia } from "./BcMediaParser";
import type { Logger } from "../../debug/DebugConfig";

export class BcMediaCodec {
  private buffer: Buffer = Buffer.alloc(0);
  private strict: boolean;
  private amountSkipped: number = 0;
  private logger: Logger | undefined;

  constructor(strict: boolean = false, logger?: Logger) {
    this.strict = strict;
    this.logger = logger;
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
            this.logger?.warn(`[BcMediaCodec] Recovered stream after skipping ${this.amountSkipped} bytes`);
          } else {
            this.logger?.warn(`[BcMediaCodec] Recovered stream after skipping ${this.amountSkipped} bytes`);
          }
          this.amountSkipped = 0;
        }
        
        results.push(result.media);
        this.buffer = this.buffer.subarray(result.consumed);
      } else {
        // No complete packet yet.
        // If the buffer does NOT start with a known magic,
        // in non-strict mode we drop the whole buffer (prevents desync and "fake" packets).
        const isKnownMagic = (magic: number): boolean => {
          const isInfoV1 = magic === 0x31303031;
          const isInfoV2 = magic === 0x32303031;
          const isIFrame = magic >= 0x63643030 && magic <= 0x63643039;
          const isPFrame = magic >= 0x63643130 && magic <= 0x63643139;
          const isAac = magic === 0x62773530;
          const isAdpcm = magic === 0x62773130;
          return isInfoV1 || isInfoV2 || isIFrame || isPFrame || isAac || isAdpcm;
        };

        const magic = this.buffer.readUInt32LE(0);
        const startsWithKnownMagic = isKnownMagic(magic);

        if (startsWithKnownMagic) {
          // Likely incomplete: wait for more data.
          break;
        }

        // Doesn't start with a valid magic: corrupted or misaligned stream.
        if (this.strict) {
          throw new Error(`[BcMediaCodec] Invalid data in stream (no valid magic at buffer start, len=${this.buffer.length})`);
        }

        if (this.amountSkipped === 0) {
          this.logger?.warn(`[BcMediaCodec] Error in stream, attempting to recover...`);
        }

        // Non-strict recovery: find the next known magic.
        // On some Hub/NVR tele streams we observe repeated fixed-size padding blocks
        // (commonly 528 bytes, sometimes 1056). A fast-path avoids O(n) scans for every packet.
        let next = -1;
        for (const off of [528, 1056, 1584]) {
          if (this.buffer.length >= off + 4 && isKnownMagic(this.buffer.readUInt32LE(off))) {
            next = off;
            break;
          }
        }

        // Fallback: linear scan for the next magic.
        if (next < 0) {
          for (let i = 1; i <= this.buffer.length - 4; i++) {
            if (isKnownMagic(this.buffer.readUInt32LE(i))) {
              next = i;
              break;
            }
          }
        }

        if (next > 0) {
          this.amountSkipped += next;
          this.buffer = this.buffer.subarray(next);
          continue;
        }

        // No magic found: keep a short tail so that a 4-byte magic split across chunks can be reconstructed.
        if (this.buffer.length > 3) {
          const keep = 3;
          this.amountSkipped += this.buffer.length - keep;
          this.buffer = this.buffer.subarray(this.buffer.length - keep);
        }
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

