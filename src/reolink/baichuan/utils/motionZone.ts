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
  /** Active region width (effective grid columns, `<width>` in MD). */
  width: number;
  /** Active region height (effective grid rows, `<height>` in MD). */
  height: number;
  /** Bitmap columns reported by `<scope><columns>`. */
  columns: number;
  /** Bitmap rows reported by `<scope><rows>`. */
  rows: number;
  /** Flat `width × height` array, row-major. `true` = cell included. */
  cells: boolean[];
}

/**
 * Decode the base64 `valueTable` from a `<scope>` (or `<area>`) into a flat
 * boolean grid. Bytes are packed MSB-first: bit 7 of byte 0 is cell (0,0).
 *
 * The camera ships TWO pairs of dimensions: `<scope><columns>×<rows>`
 * (bitmap size — typically 96×64) and `<width>×<height>` in the parent
 * block (the effective motion grid — typically smaller, e.g. 60×33 on
 * E1 Zoom). The user-editable region matches `width × height`, not the
 * full bitmap; bits past that are camera-side padding that stays 0.
 *
 * When `width`/`height` are omitted we treat the whole bitmap as the
 * active region (back-compat).
 *
 * Throws if the base64 contains too few bytes for `columns*rows` bits.
 */
export function decodeMotionScopeBitmap(
  valueTable: string,
  columns: number,
  rows: number,
  width: number = columns,
  height: number = rows,
): MotionZoneScope {
  const trimmed = valueTable.trim().replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes = base64DecodeToBytes(trimmed);
  const totalBits = columns * rows;
  if (bytes.length * 8 < totalBits) {
    throw new Error(
      `valueTable too short: have ${bytes.length * 8} bits, need ${totalBits}`,
    );
  }
  const w = Math.min(width, columns);
  const h = Math.min(height, rows);
  const cells = new Array<boolean>(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const bitIndex = r * columns + c;
      const byteIdx = bitIndex >> 3;
      const bitIdx = 7 - (bitIndex & 7);
      cells[r * w + c] = ((bytes[byteIdx] ?? 0) >> bitIdx) & 1 ? true : false;
    }
  }
  return { width: w, height: h, columns, rows, cells };
}

/**
 * Encode a `width × height` boolean grid back into the camera's
 * `columns × rows` `valueTable`. Bits outside the active region stay 0,
 * matching what the camera ships on the way down.
 *
 * `scope.cells.length` must equal `scope.width * scope.height`.
 */
export function encodeMotionScopeBitmap(scope: MotionZoneScope): string {
  const bytes = new Uint8Array(Math.ceil((scope.columns * scope.rows) / 8));
  for (let r = 0; r < scope.height; r++) {
    for (let c = 0; c < scope.width; c++) {
      const on = scope.cells[r * scope.width + c];
      if (!on) continue;
      const bitIndex = r * scope.columns + c;
      const byteIdx = bitIndex >> 3;
      const bitIdx = 7 - (bitIndex & 7);
      bytes[byteIdx] = (bytes[byteIdx] ?? 0) | (1 << bitIdx);
    }
  }
  return base64EncodeBytes(bytes);
}

/**
 * Convenience: build an "everything enabled" grid of the given dimensions.
 * Useful when the camera response has no `<valueTable>` and we want to
 * start the user off with a clean slate.
 */
export function fullCoverageScope(
  columns: number,
  rows: number,
  width: number = columns,
  height: number = rows,
): MotionZoneScope {
  return {
    width,
    height,
    columns,
    rows,
    cells: new Array<boolean>(width * height).fill(true),
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
