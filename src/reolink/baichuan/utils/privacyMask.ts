/**
 * Privacy-mask (Shelter) helpers.
 *
 * Reolink's GetMask response (cmd_id=52) carries up to `maxNum` rectangular
 * zones inside `<shelterList>` plus up to `maxTrackShelterNum` PTZ-tracking
 * zones inside `<trackShelterList>` (the tracking zones move with the PTZ
 * preset they were saved at — see `pPos`/`tPos`/`zPos`).
 *
 * Wire encoding observed on E1 Zoom firmware: every coordinate is a 32-bit
 * integer packing `(pixel << 16) | canvas_dimension`. The canvas dimension
 * is the camera's mask coord-space and is identical across all coords of
 * the same axis in the same response (so it can be lifted from any rect
 * in the list). For E1 Zoom we observe 540 × 304 (16:9-ish). Different
 * firmwares can ship different canvases — never assume the constants.
 *
 *   value = pixel * 65536 + canvas_dim
 *   pixel = value >>> 16
 *   canvas_dim = value & 0xFFFF
 *
 * To keep consumers (UI) decoupled from the wire encoding we surface
 * rectangles with normalized 0..1 coordinates and a `canvas` block that
 * remembers the original dimensions for an exact round-trip on SET.
 *
 * This mirrors the motion-zone helper pattern: pure encode/decode utilities
 * that can be used from both the library and the React UI.
 */

import { getXmlText } from "../../../protocol/xml";

export interface ShelterCanvas {
  /** Camera-reported X canvas dimension (low-16 of every X coord on the wire). */
  width: number;
  /** Camera-reported Y canvas dimension (low-16 of every Y coord on the wire). */
  height: number;
}

/**
 * E1 Zoom default canvas (camera-observed). Used as a fallback when the
 * GET response carries no rectangles to extract canvas dims from. Caller
 * can always override via the explicit `canvas` argument.
 */
export const DEFAULT_SHELTER_CANVAS: ShelterCanvas = {
  width: 540,
  height: 304,
};

export interface ShelterRect {
  /** Stable id (camera assigns `<id>` 0..maxNum-1; tracking rects use `<name>`). */
  id: number;
  /** Zone active flag. */
  enable: boolean;
  /** Z-order; observed values 0 on the wire. */
  layer: number;
  /** Color (camera-side enum). */
  color: number;
  /** Top-left X, 0..1 of the camera mask canvas. */
  x: number;
  /** Top-left Y, 0..1 of the camera mask canvas. */
  y: number;
  /** Width, 0..1 of the camera mask canvas. */
  width: number;
  /** Height, 0..1 of the camera mask canvas. */
  height: number;
}

export interface TrackShelterRect extends ShelterRect {
  /** PTZ pan position the tracking mask is anchored to. -1 = unset. */
  pPos: number;
  /** PTZ tilt position the tracking mask is anchored to. -1 = unset. */
  tPos: number;
  /** PTZ zoom position the tracking mask is anchored to. -1 = unset. */
  zPos: number;
}

export interface PrivacyMaskZones {
  enable: boolean;
  maxNum: number;
  shelterList: ShelterRect[];
  trackEnable: boolean;
  maxTrackShelterNum: number;
  trackShelterList: TrackShelterRect[];
  canvas: ShelterCanvas;
}

/**
 * Decode a single wire coordinate into its `{pixel, canvas}` pair.
 * Zero values are sentinel "uninitialized" and surface as `canvas=0`.
 */
export function decodeShelterCoord(value: number): {
  pixel: number;
  canvas: number;
} {
  const v = (value | 0) >>> 0;
  return { pixel: v >>> 16, canvas: v & 0xffff };
}

/**
 * Encode a `(pixel, canvas)` pair into the camera wire value.
 * Negative inputs are clamped to 0; values are floored to 16-bit pixels.
 */
export function encodeShelterCoord(pixel: number, canvas: number): number {
  const p = Math.min(0xffff, Math.max(0, Math.floor(pixel)));
  const c = Math.min(0xffff, Math.max(0, Math.floor(canvas)));
  return p * 65536 + c;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function decodeRect<T extends Record<string, unknown>>(
  raw: T,
  canvas: ShelterCanvas,
  idKey: "id" | "name",
): {
  id: number;
  enable: boolean;
  layer: number;
  color: number;
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const xRaw = Number(raw["topLeftX"] ?? 0) | 0;
  const yRaw = Number(raw["topLeftY"] ?? 0) | 0;
  const wRaw = Number(raw["width"] ?? 0) | 0;
  const hRaw = Number(raw["height"] ?? 0) | 0;

  // Trust the camera-reported canvas dims; fall back to the externally-
  // provided canvas only when the wire value is the all-zero sentinel.
  const xPixel = decodeShelterCoord(xRaw).pixel;
  const yPixel = decodeShelterCoord(yRaw).pixel;
  const wPixel = decodeShelterCoord(wRaw).pixel;
  const hPixel = decodeShelterCoord(hRaw).pixel;

  return {
    id: Number(raw[idKey] ?? 0) | 0,
    enable: Number(raw["enable"] ?? 0) === 1,
    layer: Number(raw["layer"] ?? 0) | 0,
    color: Number(raw["color"] ?? 0) | 0,
    x: canvas.width > 0 ? xPixel / canvas.width : 0,
    y: canvas.height > 0 ? yPixel / canvas.height : 0,
    width: canvas.width > 0 ? wPixel / canvas.width : 0,
    height: canvas.height > 0 ? hPixel / canvas.height : 0,
  };
}

/**
 * Extract the camera canvas dimensions from the first non-empty rectangle
 * in the lists. Returns `DEFAULT_SHELTER_CANVAS` if every coord is zero.
 */
export function extractCanvasFromShelterXml(xml: string): ShelterCanvas {
  // Walk every `<topLeftX>`/`<topLeftY>` tag — the low-16 of any non-zero
  // value is the canvas dim. We pick the FIRST non-zero so we don't get
  // tricked by a mix of empty + populated rects (the low-16 marker is
  // identical across all rects of the same axis).
  const xMatch = xml.match(/<topLeftX>(\d+)<\/topLeftX>/g) ?? [];
  const yMatch = xml.match(/<topLeftY>(\d+)<\/topLeftY>/g) ?? [];
  let canvasX = 0;
  let canvasY = 0;
  for (const tag of xMatch) {
    const v = Number(tag.replace(/<\/?topLeftX>/g, "")) | 0;
    if (v > 0) {
      canvasX = v & 0xffff;
      break;
    }
  }
  for (const tag of yMatch) {
    const v = Number(tag.replace(/<\/?topLeftY>/g, "")) | 0;
    if (v > 0) {
      canvasY = v & 0xffff;
      break;
    }
  }
  return {
    width: canvasX > 0 ? canvasX : DEFAULT_SHELTER_CANVAS.width,
    height: canvasY > 0 ? canvasY : DEFAULT_SHELTER_CANVAS.height,
  };
}

type RawShelterTag = Partial<
  Record<
    | "id"
    | "name"
    | "enable"
    | "layer"
    | "color"
    | "topLeftX"
    | "topLeftY"
    | "width"
    | "height"
    | "pPos"
    | "tPos"
    | "zPos",
    string
  >
>;

function parseRectTags(block: string): RawShelterTag {
  const out: RawShelterTag = {};
  const grab = (tag: keyof RawShelterTag): void => {
    const m = block.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`));
    if (m && m[1] !== undefined) out[tag] = m[1];
  };
  grab("id");
  grab("name");
  grab("enable");
  grab("layer");
  grab("color");
  grab("topLeftX");
  grab("topLeftY");
  grab("width");
  grab("height");
  grab("pPos");
  grab("tPos");
  grab("zPos");
  return out;
}

/**
 * Parse the full `<Shelter>` block (the cmd_id=52 response body) into a
 * normalized {@link PrivacyMaskZones} structure with 0..1 coordinates.
 *
 * Accepts both the trimmed `<body>...</body>` payload and the raw XML
 * including the `<?xml?>` declaration.
 */
export function decodePrivacyMaskZones(xml: string): PrivacyMaskZones {
  const canvas = extractCanvasFromShelterXml(xml);

  const enable =
    Number(getXmlText(xml, "enable") ?? "0") === 1;
  const maxNum = Number(getXmlText(xml, "maxNum") ?? "0") | 0;
  const trackEnable =
    Number(getXmlText(xml, "trackEnable") ?? "0") === 1;
  const maxTrackShelterNum =
    Number(getXmlText(xml, "maxTrackShelterNum") ?? "0") | 0;

  const shelterList: ShelterRect[] = [];
  const shelterListBlock = xml.match(
    /<shelterList>([\s\S]*?)<\/shelterList>/,
  )?.[1];
  if (shelterListBlock) {
    const blocks = shelterListBlock.matchAll(
      /<Shelter>([\s\S]*?)<\/Shelter>/g,
    );
    for (const m of blocks) {
      const tags = parseRectTags(m[1] ?? "");
      const decoded = decodeRect(tags as Record<string, unknown>, canvas, "id");
      shelterList.push(decoded);
    }
  }

  const trackShelterList: TrackShelterRect[] = [];
  const trackBlock = xml.match(
    /<trackShelterList>([\s\S]*?)<\/trackShelterList>/,
  )?.[1];
  if (trackBlock) {
    const blocks = trackBlock.matchAll(
      /<trackShelter>([\s\S]*?)<\/trackShelter>/g,
    );
    for (const m of blocks) {
      const tags = parseRectTags(m[1] ?? "");
      const base = decodeRect(
        tags as Record<string, unknown>,
        canvas,
        "name",
      );
      trackShelterList.push({
        ...base,
        pPos: Number(tags.pPos ?? -1) | 0,
        tPos: Number(tags.tPos ?? -1) | 0,
        zPos: Number(tags.zPos ?? -1) | 0,
      });
    }
  }

  return {
    enable,
    maxNum,
    shelterList,
    trackEnable,
    maxTrackShelterNum,
    trackShelterList,
    canvas,
  };
}

function denormalizeRect(
  rect: ShelterRect,
  canvas: ShelterCanvas,
): {
  topLeftX: number;
  topLeftY: number;
  width: number;
  height: number;
} {
  // Round to nearest pixel — the camera stores integers, so re-quantize
  // before packing. Clamp to canvas to never produce out-of-range coords.
  const xPx = Math.min(canvas.width, Math.round(clamp01(rect.x) * canvas.width));
  const yPx = Math.min(canvas.height, Math.round(clamp01(rect.y) * canvas.height));
  const wPx = Math.min(
    canvas.width - xPx,
    Math.round(clamp01(rect.width) * canvas.width),
  );
  const hPx = Math.min(
    canvas.height - yPx,
    Math.round(clamp01(rect.height) * canvas.height),
  );
  return {
    topLeftX: encodeShelterCoord(xPx, canvas.width),
    topLeftY: encodeShelterCoord(yPx, canvas.height),
    width: encodeShelterCoord(wPx, canvas.width),
    height: encodeShelterCoord(hPx, canvas.height),
  };
}

/**
 * Build the `<shelterList>` XML fragment for the cmd_id=53 SetMask payload.
 * The camera always expects exactly `maxNum` `<Shelter>` entries — missing
 * ones get padded with disabled zero-rects, matching what the camera ships
 * on the read side.
 */
export function encodeShelterListXml(
  rects: ShelterRect[],
  canvas: ShelterCanvas,
  maxNum: number,
): string {
  if (maxNum <= 0) return "<shelterList />";
  const sorted = [...rects]
    .sort((a, b) => a.id - b.id)
    .slice(0, maxNum);
  const byId = new Map(sorted.map((r) => [r.id, r] as const));

  const parts: string[] = [];
  parts.push("<shelterList>");
  for (let id = 0; id < maxNum; id++) {
    const r = byId.get(id);
    if (r && r.enable) {
      const { topLeftX, topLeftY, width, height } = denormalizeRect(r, canvas);
      parts.push(
        `<Shelter>` +
          `<id>${id}</id>` +
          `<enable>1</enable>` +
          `<layer>${r.layer | 0}</layer>` +
          `<color>${r.color | 0}</color>` +
          `<topLeftX>${topLeftX}</topLeftX>` +
          `<topLeftY>${topLeftY}</topLeftY>` +
          `<width>${width}</width>` +
          `<height>${height}</height>` +
          `</Shelter>`,
      );
    } else if (r) {
      const { topLeftX, topLeftY, width, height } = denormalizeRect(r, canvas);
      parts.push(
        `<Shelter>` +
          `<id>${id}</id>` +
          `<enable>0</enable>` +
          `<layer>${r.layer | 0}</layer>` +
          `<color>${r.color | 0}</color>` +
          `<topLeftX>${topLeftX}</topLeftX>` +
          `<topLeftY>${topLeftY}</topLeftY>` +
          `<width>${width}</width>` +
          `<height>${height}</height>` +
          `</Shelter>`,
      );
    } else {
      parts.push(
        `<Shelter>` +
          `<id>${id}</id>` +
          `<enable>0</enable>` +
          `<layer>0</layer>` +
          `<color>0</color>` +
          `<topLeftX>0</topLeftX>` +
          `<topLeftY>0</topLeftY>` +
          `<width>0</width>` +
          `<height>0</height>` +
          `</Shelter>`,
      );
    }
  }
  parts.push("</shelterList>");
  return parts.join("");
}

/**
 * Build the `<trackShelterList>` fragment. PTZ-tracking masks carry their
 * anchor preset via `pPos/tPos/zPos`; -1 marks the slot as unset.
 */
export function encodeTrackShelterListXml(
  rects: TrackShelterRect[],
  canvas: ShelterCanvas,
  maxNum: number,
): string {
  if (maxNum <= 0) return "<trackShelterList />";
  const sorted = [...rects]
    .sort((a, b) => a.id - b.id)
    .slice(0, maxNum);
  const byId = new Map(sorted.map((r) => [r.id, r] as const));

  const parts: string[] = [];
  parts.push("<trackShelterList>");
  for (let id = 0; id < maxNum; id++) {
    const r = byId.get(id);
    if (r) {
      const { topLeftX, topLeftY, width, height } = denormalizeRect(r, canvas);
      parts.push(
        `<trackShelter>` +
          `<name>${id}</name>` +
          `<enable>${r.enable ? 1 : 0}</enable>` +
          `<layer>${r.layer | 0}</layer>` +
          `<color>${r.color | 0}</color>` +
          `<topLeftX>${topLeftX}</topLeftX>` +
          `<topLeftY>${topLeftY}</topLeftY>` +
          `<width>${width}</width>` +
          `<height>${height}</height>` +
          `<pPos>${r.pPos | 0}</pPos>` +
          `<tPos>${r.tPos | 0}</tPos>` +
          `<zPos>${r.zPos | 0}</zPos>` +
          `</trackShelter>`,
      );
    } else {
      parts.push(
        `<trackShelter>` +
          `<name>${id}</name>` +
          `<enable>0</enable>` +
          `<layer>0</layer>` +
          `<color>0</color>` +
          `<topLeftX>0</topLeftX>` +
          `<topLeftY>0</topLeftY>` +
          `<width>0</width>` +
          `<height>0</height>` +
          `<pPos>-1</pPos>` +
          `<tPos>-1</tPos>` +
          `<zPos>-1</zPos>` +
          `</trackShelter>`,
      );
    }
  }
  parts.push("</trackShelterList>");
  return parts.join("");
}

/**
 * Patch a `<Shelter>` block XML (cmd_id=52 response) by replacing the
 * `<shelterList>` / `<trackShelterList>` sub-blocks and the enable flags.
 * Use this to build the cmd_id=53 payload as a read-modify-write of the
 * camera's GET response — preserves any camera-specific extension tags.
 */
export function patchShelterXml(
  shelterXml: string,
  patch: {
    enable?: boolean;
    shelterList?: ShelterRect[];
    trackEnable?: boolean;
    trackShelterList?: TrackShelterRect[];
  },
  canvas: ShelterCanvas,
  maxNum: number,
  maxTrackShelterNum: number,
): string {
  let out = shelterXml;

  if (patch.enable !== undefined) {
    out = out.replace(
      /<enable>[^<]*<\/enable>/,
      `<enable>${patch.enable ? 1 : 0}</enable>`,
    );
  }

  if (patch.shelterList !== undefined) {
    const fragment = encodeShelterListXml(patch.shelterList, canvas, maxNum);
    out = out.replace(/<shelterList[\s\S]*?(?:\/>|<\/shelterList>)/, fragment);
  }

  if (patch.trackEnable !== undefined) {
    out = out.replace(
      /<trackEnable>[^<]*<\/trackEnable>/,
      `<trackEnable>${patch.trackEnable ? 1 : 0}</trackEnable>`,
    );
  }

  if (patch.trackShelterList !== undefined) {
    const fragment = encodeTrackShelterListXml(
      patch.trackShelterList,
      canvas,
      maxTrackShelterNum,
    );
    out = out.replace(
      /<trackShelterList[\s\S]*?(?:\/>|<\/trackShelterList>)/,
      fragment,
    );
  }

  return out;
}

