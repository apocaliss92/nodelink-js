/**
 * Motion-detection zone grid helpers.
 *
 * Reolink's GetMdAlarm response (cmd_id=46) carries the active detection
 * region as a base64-encoded bitmap inside `<scope><valueTable>...</valueTable></scope>`.
 * The bitmap has one bit per grid cell:
 *
 *   <scope>
 *     <columns>96</columns>
 *     <rows>64</rows>
 *     <valueTable>{base64 of columns*rows bits, packed MSB-first per byte}</valueTable>
 *   </scope>
 *
 * The same shape is reused by AI detection (`<AiDetectCfg><area>...</area>`)
 * — only the column/row counts differ across firmwares. Use the helpers
 * here to round-trip between the camera's base64 string and a flat boolean
 * grid the UI can render and edit.
 */

export interface MotionZoneScope {
  columns: number;
  rows: number;
  /** Flat `columns × rows` array, row-major. `true` = cell included. */
  cells: boolean[];
}

/**
 * Decode the base64 `valueTable` from a `<scope>` (or `<area>`) into a flat
 * boolean grid. Bytes are packed MSB-first: bit 7 of byte 0 is cell (0,0).
 *
 * Throws if the base64 contains too few bytes for `columns*rows` bits.
 */
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

/**
 * Encode a flat boolean grid back into the base64 `valueTable` the camera
 * expects. Bytes are packed MSB-first to match `decodeMotionScopeBitmap`.
 *
 * `scope.cells.length` must equal `scope.columns * scope.rows`. Missing
 * cells are treated as `false`.
 */
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

/**
 * Convenience: build an "everything enabled" grid of the given dimensions.
 * Useful when the camera response has no `<valueTable>` and we want to
 * start the user off with a clean slate.
 */
export function fullCoverageScope(columns: number, rows: number): MotionZoneScope {
  return {
    columns,
    rows,
    cells: new Array<boolean>(columns * rows).fill(true),
  };
}

// ───────────────────────── Base64 helpers ─────────────────────────
// We don't use `Buffer` here because this module is also imported by
// the browser-side React tab. `Uint8Array` works in both environments.

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
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const stripped = padded.replace(/=+$/, "");
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
