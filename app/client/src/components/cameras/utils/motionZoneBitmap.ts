/**
 * Browser-side mirror of the library's `motionZone` helpers.
 *
 * The library exposes the same functions under
 * `@apocaliss92/nodelink-js`, but importing from the package root pulls
 * Node's `crypto` (via the protocol crypto module) into the Vite bundle
 * — Vite externalises it and the browser build fails. The helpers
 * themselves are pure-JS, no Node deps, so we just duplicate them here
 * and keep the wire format documented next to the encoder/decoder pair.
 *
 *   <scope>
 *     <columns>96</columns>
 *     <rows>64</rows>
 *     <valueTable>{base64 of columns*rows bits, MSB-first per byte}</valueTable>
 *   </scope>
 */

export interface MotionZoneScope {
  columns: number;
  rows: number;
  cells: boolean[];
}

export function decodeMotionScopeBitmap(
  valueTable: string,
  columns: number,
  rows: number,
): MotionZoneScope {
  const trimmed = valueTable.trim().replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes = base64DecodeToBytes(trimmed);
  const total = columns * rows;
  if (bytes.length * 8 < total) {
    throw new Error(
      `valueTable too short: have ${bytes.length * 8} bits, need ${total}`,
    );
  }
  const cells = new Array<boolean>(total);
  for (let i = 0; i < total; i++) {
    const byteIdx = i >> 3;
    const bitIdx = 7 - (i & 7);
    cells[i] = ((bytes[byteIdx] ?? 0) >> bitIdx) & 1 ? true : false;
  }
  return { columns, rows, cells };
}

export function encodeMotionScopeBitmap(scope: MotionZoneScope): string {
  const total = scope.columns * scope.rows;
  const bytes = new Uint8Array(Math.ceil(total / 8));
  for (let i = 0; i < total; i++) {
    if (!scope.cells[i]) continue;
    const byteIdx = i >> 3;
    const bitIdx = 7 - (i & 7);
    bytes[byteIdx] = (bytes[byteIdx] ?? 0) | (1 << bitIdx);
  }
  return base64EncodeBytes(bytes);
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64EncodeBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += B64_ALPHABET[b0 >> 2]!;
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f]! : "=";
  }
  return out;
}

function base64DecodeToBytes(b64: string): Uint8Array {
  const stripped = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((stripped.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let outIdx = 0;
  for (const ch of stripped) {
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIdx);
}
