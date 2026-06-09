import alawmulaw from "alawmulaw";

const { mulaw, alaw } = alawmulaw;

// Thin typed wrappers around the `alawmulaw` package so consumers don't depend
// on its untyped surface. Used to decode RTP PCMU (RFC 3551 payload type 0)
// and PCMA (payload type 8) bodies into linear 16-bit PCM before feeding the
// IMA ADPCM encoder that talks to Reolink TalkSession.

/**
 * Decode μ-law (G.711-U, "PCMU") bytes into signed 16-bit PCM samples.
 * Input is treated as one byte per sample at the source rate (usually 8 kHz mono).
 */
export function mulawToPcm16(bytes: Uint8Array | Buffer): Int16Array {
  if (bytes.length === 0) return new Int16Array(0);
  return mulaw.decode(bytes);
}

/**
 * Decode A-law (G.711-A, "PCMA") bytes into signed 16-bit PCM samples.
 * Some Reolink clients (and some non-Reolink WHEP gateways) advertise PCMA
 * instead of PCMU on the backchannel; supporting both keeps the bridge generic.
 */
export function alawToPcm16(bytes: Uint8Array | Buffer): Int16Array {
  if (bytes.length === 0) return new Int16Array(0);
  return alaw.decode(bytes);
}
