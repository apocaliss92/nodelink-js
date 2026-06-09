// `alawmulaw` is a UMD/CJS-only package whose named codecs live on
// `module.exports`. Different runtimes surface them differently:
//   - tsup CJS / webpack: __toESM interop hoists the names onto the
//     namespace, so `ns.mulaw`/`ns.alaw` work directly.
//   - Node ESM loading our ESM bundle: cjs-module-lexer can't see the
//     UMD-style `d.mulaw = ...; d.alaw = ...;` assignments in
//     `dist/alawmulaw.js`, so the namespace exposes only `default`
//     (= the full `module.exports`); `ns.mulaw`/`ns.alaw` are undefined
//     and calling `.decode()` on them throws.
// Probe both shapes at runtime so the same source works for every
// consumer (Node ESM via our dist, Node CJS via dist/index.cjs, and
// webpack-bundled consumers like the Scrypted plugin).
import * as alawmulawNs from "alawmulaw";

interface AlawmulawCodec {
  decode(bytes: Uint8Array | Buffer): Int16Array;
}

interface AlawmulawShape {
  mulaw: AlawmulawCodec;
  alaw: AlawmulawCodec;
}

function resolveAlawmulaw(): AlawmulawShape {
  const ns = alawmulawNs as unknown as Partial<AlawmulawShape> & {
    default?: Partial<AlawmulawShape>;
  };
  if (ns.mulaw && ns.alaw) {
    return { mulaw: ns.mulaw, alaw: ns.alaw };
  }
  const fallback = ns.default;
  if (fallback?.mulaw && fallback?.alaw) {
    return { mulaw: fallback.mulaw, alaw: fallback.alaw };
  }
  throw new Error(
    "alawmulaw: unable to resolve mulaw/alaw codecs from module exports",
  );
}

const { mulaw, alaw } = resolveAlawmulaw();

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
