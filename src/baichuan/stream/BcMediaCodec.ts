/**
 * BcMedia Codec - Assembles fragmented BcMedia packets from stream
 * Based on neolink crates/core/src/bcmedia/codex.rs
 * 
 * BcMedia packets can be fragmented across multiple Baichuan frames.
 * This codec buffers incomplete packets and assembles them when complete.
 */

import { parseBcMedia, type BcMedia } from "./BcMediaParser.js";

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
    while (this.buffer.length > 0) {
      const result = parseBcMedia(this.buffer);
      
      if (result) {
        // Complete packet found
        if (this.amountSkipped > 0) {
          // Log recovery if we had to skip data
          if (this.strict) {
            console.warn(`[BcMediaCodec] Recovered stream after skipping ${this.amountSkipped} bytes`);
          }
          this.amountSkipped = 0;
        }
        
        results.push(result.media);
        this.buffer = this.buffer.subarray(result.consumed);
      } else {
        // No complete packet found - check if we have enough data to determine if it's incomplete
        // For now, if buffer is small (< 100 bytes), wait for more data
        // If buffer is large but no magic found, might be corrupted
        if (this.buffer.length < 100) {
          // Likely incomplete - wait for more data
          break;
        }
        
        // Check if buffer starts with a known magic header
        if (this.buffer.length >= 4) {
          const magic = this.buffer.readUInt32LE(0);
          const knownMagics = [
            0x31303031, // InfoV1
            0x32303031, // InfoV2
            0x63643030, // IFrame start
            0x63643039, // IFrame end
            0x63643130, // PFrame start
            0x63643139, // PFrame end
            0x62773530, // AAC
            0x62773130, // ADPCM
          ];
          
          const isKnownMagic = knownMagics.some(m => magic >= m && magic <= m + 9);
          
          if (isKnownMagic) {
            // Looks like a valid magic but packet is incomplete - wait for more data
            break;
          }
        }
        
        // No valid magic found - might be corrupted
        if (this.strict) {
          throw new Error(`[BcMediaCodec] Invalid data in stream (no valid magic found), buffer length: ${this.buffer.length}`);
        } else {
          // Skip one byte and try again (similar to neolink's error recovery)
          if (this.amountSkipped === 0) {
            console.warn(`[BcMediaCodec] Error in stream, attempting to recover...`);
          }
          this.amountSkipped += 1;
          this.buffer = this.buffer.subarray(1);
        }
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

