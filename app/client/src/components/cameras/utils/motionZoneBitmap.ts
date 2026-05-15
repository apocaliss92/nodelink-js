/**
 * Browser-side mirror of the library's `motionZone` helpers.
 *
 * Wire format observed on E1 Zoom (cmd_46 GetMdAlarm):
 *
 *   <body>
 *     <MD>
 *       <width>60</width>          ← effective motion grid (active region)
 *       <height>33</height>
 *       <scope>
 *         <columns>96</columns>    ← bitmap dimensions in the valueTable
 *         <rows>64</rows>
 *         <valueTable>{base64 of columns*rows bits, MSB-first per byte}</valueTable>
 *       </scope>
 *     </MD>
 *   </body>
 *
 * The `valueTable` bitmap is `columns × rows` packed MSB-first. The CAMERA
 * however only honours the first `width × height` cells; bits past that
 * are padding (always 0 in captures). When we render the editor we want
 * to map a `width × height` grid over the WHOLE camera frame — otherwise
 * the painted area covers only the upper-left fraction of the image (we
 * stretched the 96×64 grid over the full frame and only the first 60×33
 * of those map to the real motion region).
 *
 * So the helpers below take BOTH the bitmap dimensions AND the active
 * region size. The decoder returns a `width × height` flat cell array;
 * the encoder writes a `columns × rows` bitmap where the first
 * `width × height` cells come from the user grid and the rest stay 0.
 *
 * Pure-JS / Uint8Array, works in browser and Node.
 */

export interface MotionZoneScope {
  /** Active region width (effective grid columns). */
  width: number;
  /** Active region height (effective grid rows). */
  height: number;
  /** Bitmap columns reported by `<scope><columns>`. */
  columns: number;
  /** Bitmap rows reported by `<scope><rows>`. */
  rows: number;
  /** Flat `width × height` boolean grid, row-major. */
  cells: boolean[];
}

/**
 * Decode the camera's `<valueTable>` bitmap into the user-facing
 * `width × height` grid. The remaining `columns × rows − width × height`
 * bits are camera-side padding and not surfaced.
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
 * Encode a user-edited `width × height` grid back into the camera's
 * `columns × rows` bitmap. Bits outside the active region stay 0 (same
 * pattern the camera ships when the GET returns).
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
