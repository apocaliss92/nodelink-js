/**
 * Overlay POSITION vocabulary for the Reolink OSD (`GetOsdDatetime` /
 * `SetOsdDatetime`, cmd_id 44/45).
 *
 * The camera anchors each overlay with `topLeftX` / `topLeftY`. These are
 * **not** pixels and not preset strings: each axis is a NORMALISED 16.16
 * fixed-point coordinate whose far edge is `65536` (= 1.0) and whose start
 * edge is `0` — several firmwares echo `1` for the start edge, which is the
 * same edge one unit in.
 *
 * That is not a guess. It was read off live cameras against placements the
 * operator had configured by hand in the Reolink app:
 *
 * ```
 *   device 3825 (channel name BOTTOM-RIGHT, timestamp TOP-RIGHT, watermark ON)
 *     OsdChannelName { topLeftX: 65536, topLeftY: 65536, enWatermark: true }
 *     OsdDatetime    { topLeftX: 65536, topLeftY: 1 }
 *   device 592   OsdChannelName { 1, 65536 }  OsdDatetime { 1, 1 }
 *   device 618   OsdChannelName { 0, 0 }      OsdDatetime { 1, 1 }
 * ```
 *
 * Only the four corner pairs are OFFERED as writable values — they are the
 * only ones a real camera has been observed to hold. A camera that holds
 * something else (a hand-dragged placement) decodes to `custom` and keeps
 * its raw pair: callers show it and write nothing.
 */

/** The far edge of either axis — 1.0 in the camera's 16.16 space. */
export const OSD_POSITION_MAX = 65_536;

/** The start edge. Cameras echo `0` or `1`; both render at the same edge. */
export const OSD_POSITION_MIN = 0;

/**
 * How far from an edge a coordinate may sit and still BE that edge. The
 * observed start-edge values are 0 and 1, so the tolerance only has to
 * absorb that one-unit echo; anything further in is a real custom placement
 * and must be reported as such rather than snapped to a corner.
 */
export const OSD_POSITION_EDGE_TOLERANCE = 16;

export const OSD_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export type OsdCorner = (typeof OSD_CORNERS)[number];

/** A camera-side coordinate pair, in the 16.16 space described above. */
export interface OsdCoords {
  readonly x: number;
  readonly y: number;
}

/**
 * What the camera reported about one overlay's anchor.
 *
 * Three states, not two: `unknown` (the camera never told us) must never
 * collapse into a corner, and `custom` must never be rounded to one, because
 * both would claim a placement the camera does not hold.
 */
export type OsdPositionReading =
  | { readonly kind: "corner"; readonly corner: OsdCorner }
  | { readonly kind: "custom"; readonly x: number; readonly y: number }
  | { readonly kind: "unknown" };

function isStartEdge(value: number): boolean {
  return value <= OSD_POSITION_MIN + OSD_POSITION_EDGE_TOLERANCE;
}

function isEndEdge(value: number): boolean {
  return value >= OSD_POSITION_MAX - OSD_POSITION_EDGE_TOLERANCE;
}

/** Decode a reported `(topLeftX, topLeftY)` pair into a corner. */
export function readOsdPosition(
  x: number | null | undefined,
  y: number | null | undefined,
): OsdPositionReading {
  if (typeof x !== "number" || typeof y !== "number") return { kind: "unknown" };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { kind: "unknown" };
  const horizontal = isStartEdge(x) ? "left" : isEndEdge(x) ? "right" : null;
  const vertical = isStartEdge(y) ? "top" : isEndEdge(y) ? "bottom" : null;
  if (horizontal === null || vertical === null)
    return { kind: "custom", x, y };
  return { kind: "corner", corner: `${vertical}-${horizontal}` };
}

/** The coordinate pair to WRITE for a corner. */
export function coordsForOsdCorner(corner: OsdCorner): OsdCoords {
  const x = corner.endsWith("-right") ? OSD_POSITION_MAX : OSD_POSITION_MIN;
  const y = corner.startsWith("bottom-") ? OSD_POSITION_MAX : OSD_POSITION_MIN;
  return { x, y };
}

/** Narrow an untyped value (a form field, a config blob) to the vocabulary. */
export function isOsdCorner(value: unknown): value is OsdCorner {
  return (
    typeof value === "string" &&
    (OSD_CORNERS as readonly string[]).includes(value)
  );
}

/** The raw pair, for a "custom" label — so an unmapped value is reportable. */
export function formatOsdCoords(x: number, y: number): string {
  return `x=${x}, y=${y}`;
}

/** Operator-facing corner labels. */
export const OSD_CORNER_LABELS: Readonly<Record<OsdCorner, string>> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};
