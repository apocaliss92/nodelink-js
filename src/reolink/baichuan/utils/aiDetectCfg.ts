/**
 * AI-detection per-type config helpers (cmd_id 342 GET / 345 SET full).
 *
 * Each AI type (people, dog_cat, vehicle, face, package, ...) carries its
 * own `<AiDetectCfg>` block:
 *
 *   <AiDetectCfg version="1.1">
 *     <chn>0</chn>
 *     <type>people</type>
 *     <sensitivity>60</sensitivity>
 *     <stayTime>0</stayTime>
 *     <minTargetHeight>0.5</minTargetHeight>
 *     <minTargetWidth>0.5</minTargetWidth>
 *     <maxTargetHeight>0.5</maxTargetHeight>
 *     <maxTargetWidth>0.5</maxTargetWidth>
 *     <width>60</width> <height>33</height>
 *     <area>{base64 width*height bitmap}</area>
 *   </AiDetectCfg>
 *
 * cmd_id=343 (`SetAiAlarm`) only edits sensitivity + stayTime. The full
 * setter is cmd_id=345 — it accepts the entire block including the area
 * bitmap and target size thresholds. The bitmap layout is identical to
 * the motion-detection `<valueTable>` so we reuse the motion-zone
 * helpers for encode/decode.
 *
 * Target size fields are camera-side fractions in [0,1] of the frame.
 */

import { getXmlText } from "../../../protocol/xml";

export interface AiDetectCfgZone {
  chn: number;
  type: string;
  sensitivity: number;
  stayTime: number;
  minTargetWidth: number;
  minTargetHeight: number;
  maxTargetWidth: number;
  maxTargetHeight: number;
  /** Grid columns (width) for the `<area>` bitmap. */
  width: number;
  /** Grid rows (height) for the `<area>` bitmap. */
  height: number;
  /** Raw base64 area bitmap (use `decodeMotionScopeBitmap` to expand). */
  area: string;
}

/**
 * Parse an `<AiDetectCfg>` response body (cmd_id=342) into a typed zone.
 * Throws if the required fields aren't present.
 */
export function decodeAiDetectCfg(xml: string): AiDetectCfgZone {
  const type = getXmlText(xml, "type");
  if (type == null) throw new Error("AiDetectCfg: missing <type>");

  return {
    chn: Number(getXmlText(xml, "chn") ?? "0") | 0,
    type,
    sensitivity: Number(getXmlText(xml, "sensitivity") ?? "0") | 0,
    stayTime: Number(getXmlText(xml, "stayTime") ?? "0") | 0,
    minTargetWidth: Number(getXmlText(xml, "minTargetWidth") ?? "0"),
    minTargetHeight: Number(getXmlText(xml, "minTargetHeight") ?? "0"),
    maxTargetWidth: Number(getXmlText(xml, "maxTargetWidth") ?? "0"),
    maxTargetHeight: Number(getXmlText(xml, "maxTargetHeight") ?? "0"),
    width: Number(getXmlText(xml, "width") ?? "0") | 0,
    height: Number(getXmlText(xml, "height") ?? "0") | 0,
    area: getXmlText(xml, "area") ?? "",
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function fmtFraction(value: number): string {
  // Reolink wire format: scientific notation with 6 decimal places AND
  // a 2-digit exponent (e.g. "5.000000e-01" for 0.5, "0.000000e+00" for
  // 0, "1.000000e+00" for 1). Node's toExponential(6) gives a 1-digit
  // exponent, so we manually pad. Wire-confirmed via pcap capture
  // (May 2026, E1 Zoom firmware); deviating from this format makes the
  // camera silently ignore the field even though it returns 200.
  const v = clamp01(value);
  const e = v.toExponential(6); // e.g. "5.000000e-1" or "0.000000e+0"
  return e.replace(/e([+-])(\d)$/, "e$10$2");
}

/**
 * Patch an existing cmd_id=342 GET response body, replacing only the
 * tags whose new value was supplied. Use this to build the cmd_id=345
 * SetAiDetectCfg payload (read-modify-write).
 */
export function patchAiDetectCfgXml(
  currentXml: string,
  patch: Partial<
    Pick<
      AiDetectCfgZone,
      | "sensitivity"
      | "stayTime"
      | "minTargetWidth"
      | "minTargetHeight"
      | "maxTargetWidth"
      | "maxTargetHeight"
      | "area"
    >
  >,
): string {
  let out = currentXml;
  if (patch.sensitivity !== undefined) {
    out = out.replace(
      /<sensitivity>[^<]*<\/sensitivity>/,
      `<sensitivity>${patch.sensitivity | 0}</sensitivity>`,
    );
  }
  if (patch.stayTime !== undefined) {
    out = out.replace(
      /<stayTime>[^<]*<\/stayTime>/,
      `<stayTime>${patch.stayTime | 0}</stayTime>`,
    );
  }
  if (patch.minTargetWidth !== undefined) {
    out = out.replace(
      /<minTargetWidth>[^<]*<\/minTargetWidth>/,
      `<minTargetWidth>${fmtFraction(patch.minTargetWidth)}</minTargetWidth>`,
    );
  }
  if (patch.minTargetHeight !== undefined) {
    out = out.replace(
      /<minTargetHeight>[^<]*<\/minTargetHeight>/,
      `<minTargetHeight>${fmtFraction(patch.minTargetHeight)}</minTargetHeight>`,
    );
  }
  if (patch.maxTargetWidth !== undefined) {
    out = out.replace(
      /<maxTargetWidth>[^<]*<\/maxTargetWidth>/,
      `<maxTargetWidth>${fmtFraction(patch.maxTargetWidth)}</maxTargetWidth>`,
    );
  }
  if (patch.maxTargetHeight !== undefined) {
    out = out.replace(
      /<maxTargetHeight>[^<]*<\/maxTargetHeight>/,
      `<maxTargetHeight>${fmtFraction(patch.maxTargetHeight)}</maxTargetHeight>`,
    );
  }
  if (patch.area !== undefined) {
    out = out.replace(
      /<area>[^<]*<\/area>/,
      `<area>${patch.area}</area>`,
    );
  }
  return out;
}
