// `alawmulaw` is a CJS-only package without an `exports` field. Two
// consumers care about this:
//
// 1. Native Node ESM. When Node loads our dist/index.js it can use
//    `import { mulaw, alaw } from "alawmulaw"` if cjs-module-lexer can
//    pick the names out of the CJS module — but on this version it
//    cannot, so the only stable form is a default + destructure.
// 2. Webpack (e.g. the Scrypted plugin bundling our ESM dist). Webpack
//    does static analysis and rejects the default import with
//    "export 'default' was not found" because `alawmulaw` has no real
//    `default` export.
//
// `import * as ns from "alawmulaw"` is the one syntax that works for
// both: Node treats the namespace as the CJS module.exports, and
// webpack hoists the named members from the namespace.
import * as alawmulaw from "alawmulaw";

const { mulaw, alaw } = alawmulaw as unknown as {
  mulaw: { decode(bytes: Uint8Array | Buffer): Int16Array };
  alaw: { decode(bytes: Uint8Array | Buffer): Int16Array };
};

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
