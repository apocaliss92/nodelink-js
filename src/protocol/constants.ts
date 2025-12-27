export const BC_TCP_DEFAULT_PORT = 9000;

/** Magic header bytes: `f0 de bc 0a` */
export const BC_MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);

/**
 * Some cameras sometimes send a reversed-endian magic header for certain payloads (e.g. JPEG).
 * In Rust reference this appears as 0x0fedcba0 (LE bytes: a0 cb ed 0f).
 */
export const BC_MAGIC_REV = Buffer.from([0xa0, 0xcb, 0xed, 0x0f]);

/** Reolink "BCEncrypt" XOR key for XML payloads. */
export const BC_XML_KEY = Uint8Array.from([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]);

/** Fixed IV used by Reolink for AES-CFB. */
export const BC_AES_IV = Buffer.from("0123456789abcdef", "utf8");

export const BC_CLASS_LEGACY = 0x6514;
export const BC_CLASS_MODERN_20 = 0x6614;
export const BC_CLASS_MODERN_24 = 0x6414;
export const BC_CLASS_MODERN_24_ALT = 0x0000;

export function bcHeaderHasPayloadOffset(messageClass: number): boolean {
  return messageClass === BC_CLASS_MODERN_24 || messageClass === BC_CLASS_MODERN_24_ALT;
}

/**
 * Baichuan command IDs for video streaming.
 * Based on neolink model.rs implementation.
 * 
 * Reference: https://github.com/QuantumEntangledAndy/neolink/blob/master/crates/core/src/bc/model.rs
 * 
 * Values verified from neolink crates/core/src/bc/model.rs:
 * - MSG_ID_VIDEO = 3: Video and Audio Streams messages
 * - MSG_ID_VIDEO_STOP = 4: ID used to stop the video stream
 */
export const BC_CMD_ID_VIDEO = 3; // MSG_ID_VIDEO - Video and Audio Streams messages
export const BC_CMD_ID_VIDEO_STOP = 4; // MSG_ID_VIDEO_STOP - ID used to stop the video stream

