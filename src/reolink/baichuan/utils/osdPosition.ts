/**
 * Overlay POSITION vocabulary for the Reolink OSD (`GetOsdDatetime` /
 * `SetOsdDatetime`, cmd_id 44/45).
 *
 * The camera anchors each overlay with `topLeftX` / `topLeftY`. These are
 * **not** pixels and not preset strings: each axis is a NORMALISED 16.16
 * fixed-point coordinate whose far edge is `65536` (= 1.0) and whose start
 * edge is reported as `0` or `1` — the same edge, one unit apart. We READ both
 * and WRITE `1`, because a camera that was handed `0` stored it and refused to
 * render it (see `OSD_POSITION_START_WRITE`).
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

/**
 * The start edge as a camera REPORTS it. Cameras echo `0` or `1`, and both
 * mean the same edge — this is the floor the reader measures tolerance from.
 * What we WRITE is {@link OSD_POSITION_START_WRITE}, which is not the same
 * question.
 */
export const OSD_POSITION_MIN = 0;

/**
 * The start edge we WRITE.
 *
 * `1` is what the Reolink app writes most of the time, so it is the safest
 * value to send — but be clear about what that is and is not.
 *
 * It was briefly believed that `0` was the reason an overlay would not move:
 * device 3825 stored a `(65536, 0)` and never rendered it. **A packet capture
 * of the app's own traffic on 2026-09-19 disproved that.** Sweeping the
 * timestamp through all four corners, the app wrote top-left as `(0,0)` on one
 * save and `(1,1)` on the next, and both took effect. `0` and `1` are the same
 * edge to this firmware, exactly as {@link OSD_POSITION_MIN} always said.
 *
 * The real reason those writes did nothing was addressing: cmd 45 carried no
 * `<Extension><channelId>`, so on a hub child it named no channel. See
 * `setOsdDatetime`.
 *
 * We keep writing `1` because it is what the app writes and there is no reason
 * to differ — not because `0` is broken.
 */
export const OSD_POSITION_START_WRITE = 1;

/**
 * How far from an edge a coordinate may sit and still BE that edge. The
 * observed start-edge values are 0 and 1, so the tolerance only has to
 * absorb that one-unit echo; anything further in is a real custom placement
 * and must be reported as such rather than snapped to a corner.
 */
export const OSD_POSITION_EDGE_TOLERANCE = 16;

/**
 * The CENTRE of an axis.
 *
 * Not a coordinate — a vocabulary entry, one past the far edge. Captured on
 * 2026-09-19 while the operator placed the timestamp top-centre and the
 * channel name bottom-centre:
 *
 * ```
 * OsdDatetime    (65537, 1)       ← centre, top
 * OsdChannelName (65537, 65536)   ← centre, bottom
 * ```
 *
 * It must be tested BEFORE the far edge: `65537` sits inside
 * {@link OSD_POSITION_EDGE_TOLERANCE} of `65536`, so a naive edge test reads
 * every centred overlay as right/bottom — which is exactly what this library
 * did to the eight `(65537, 65536)` writes in the Home Hub capture.
 */
export const OSD_POSITION_CENTER = 65_537;

export const OSD_CORNERS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
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
  // Centre FIRST: 65537 is within the edge tolerance of 65536 and would
  // otherwise read as the far edge. Only the x axis has been observed
  // centred; a centred y stays `custom` rather than being invented.
  const horizontal =
    x === OSD_POSITION_CENTER
      ? "center"
      : isStartEdge(x)
        ? "left"
        : isEndEdge(x)
          ? "right"
          : null;
  const vertical = isStartEdge(y) ? "top" : isEndEdge(y) ? "bottom" : null;
  if (horizontal === null || vertical === null)
    return { kind: "custom", x, y };
  return { kind: "corner", corner: `${vertical}-${horizontal}` };
}

/**
 * The coordinate pair to WRITE for a corner. The start edge is
 * {@link OSD_POSITION_START_WRITE}, not {@link OSD_POSITION_MIN} — see that
 * constant for the camera that accepted a `0`, stored it, and ignored it.
 */
export function coordsForOsdCorner(corner: OsdCorner): OsdCoords {
  const x = corner.endsWith("-center")
    ? OSD_POSITION_CENTER
    : corner.endsWith("-right")
      ? OSD_POSITION_MAX
      : OSD_POSITION_START_WRITE;
  const y = corner.startsWith("bottom-")
    ? OSD_POSITION_MAX
    : OSD_POSITION_START_WRITE;
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
  "top-center": "Top centre",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom centre",
  "bottom-right": "Bottom right",
};
