import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { BC_AES_IV, BC_XML_KEY } from "./constants";

export type EncryptionProtocol =
  | { kind: "none" }
  | { kind: "bc" }
  | { kind: "aes"; key: Buffer }
  | { kind: "full_aes"; key: Buffer };

export function md5HexUpper(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
}

/**
 * MD5 "modern" formatting used by Baichuan:
 * - MD5 hex uppercase
 * - truncate to 31 chars
 */
export function md5StrModern(input: string): string {
  return md5HexUpper(input).slice(0, 31);
}

/**
 * AES key derivation used by Reolink:
 * keyString = md5_str_modern(`${nonce}-${password}`).slice(0,16)
 * keyBytes = UTF-8 bytes of that string (16 bytes)
 */
export function deriveAesKey(nonce: string, password: string): Buffer {
  const keyStr = md5StrModern(`${nonce}-${password}`).slice(0, 16);
  return Buffer.from(keyStr, "utf8");
}

export function bcEncrypt(buf: Buffer, offset: number): Buffer {
  const off = offset & 0xff;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const key = BC_XML_KEY[(off + i) % BC_XML_KEY.length]!;
    out[i] = buf[i]! ^ key ^ off;
  }
  return out;
}

export function bcDecrypt(buf: Buffer, offset: number): Buffer {
  // XOR is symmetric
  return bcEncrypt(buf, offset);
}

export function aesEncrypt(buf: Buffer, key: Buffer): Buffer {
  if (buf.length === 0) return Buffer.alloc(0);
  const cipher = createCipheriv("aes-128-cfb", key, BC_AES_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

export function aesDecrypt(buf: Buffer, key: Buffer): Buffer {
  if (buf.length === 0) return Buffer.alloc(0);
  const decipher = createDecipheriv("aes-128-cfb", key, BC_AES_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}

/**
 * Stateful AES-128-CFB stream decryptor.
 *
 * AES-128-CFB mode requires maintaining cipher state across chunk boundaries.
 * When a large BcMedia packet (e.g., a 400KB I-frame) is fragmented into multiple
 * Baichuan frames, each frame must be decrypted using the cipher state from the
 * previous frame, NOT a fresh IV.
 *
 * The first frame of a new BcMedia packet starts with a recognizable magic
 * (e.g., "cd00", "1001", "1002"). This signals we should reset the cipher state.
 * Subsequent frames (continuations) should use the continued cipher state.
 *
 * Usage:
 * ```ts
 * const decryptor = new AesStreamDecryptor(key);
 *
 * for (const frame of baichuanFrames) {
 *   // Try fresh IV to detect new packet
 *   const freshDecrypted = aesDecrypt(frame.payload, key);
 *   if (startsWithBcMediaMagic(freshDecrypted)) {
 *     // New packet - reset and decrypt with fresh state
 *     decryptor.reset();
 *     const decrypted = decryptor.update(frame.payload);
 *   } else {
 *     // Continuation - use existing state
 *     const decrypted = decryptor.update(frame.payload);
 *   }
 * }
 * ```
 */
export class AesStreamDecryptor {
  private decipher: ReturnType<typeof createDecipheriv> | null = null;
  private readonly key: Buffer;

  constructor(key: Buffer) {
    this.key = key;
  }

  /**
   * Reset the cipher state (start decrypting with fresh IV).
   * Call this when a new BcMedia packet is detected.
   */
  reset(): void {
    this.decipher = createDecipheriv("aes-128-cfb", this.key, BC_AES_IV);
    this.decipher.setAutoPadding(false);
  }

  /**
   * Decrypt a chunk using the current cipher state.
   * Automatically resets if no cipher exists.
   *
   * @param buf - Encrypted buffer to decrypt
   * @returns Decrypted buffer
   */
  update(buf: Buffer): Buffer {
    if (buf.length === 0) return Buffer.alloc(0);
    if (!this.decipher) this.reset();
    return this.decipher!.update(buf);
  }

  /**
   * Check if the decryptor has been initialized.
   */
  isInitialized(): boolean {
    return this.decipher !== null;
  }
}
