/**
 * Motion-detection per-time-band sensitivity schedule helper.
 *
 * Reolink's GetMdAlarm response (cmd_id=46) carries an array of
 * `<sensitivityInfo>` entries inside `<sensitivityInfoList>`:
 *
 *   <sensitivityInfoList>
 *     <sensitivityInfo>
 *       <id>0</id>
 *       <sensitivity>10</sensitivity>
 *       <beginHour>0</beginHour>  <beginMinute>0</beginMinute>
 *       <endHour>6</endHour>      <endMinute>0</endMinute>
 *     </sensitivityInfo>
 *     ... up to 4 bands by default ...
 *   </sensitivityInfoList>
 *
 * The camera-wide default lives in `<sensInfoNew><sensitivityDefault>`.
 * This helper builds the `<sensitivityInfoList>` fragment used by the
 * cmd_id=47 SetMdAlarm payload as part of a read-modify-write flow.
 */

export interface MotionSensitivityBand {
  /** 0-based band id (camera assigns 0..N-1). */
  id: number;
  /** Sensitivity for this band, 0..50 (higher = more sensitive). */
  sensitivity: number;
  /** Band start hour, 0..23. */
  beginHour: number;
  /** Band start minute, 0..59. */
  beginMinute: number;
  /** Band end hour, 0..23. */
  endHour: number;
  /** Band end minute, 0..59. */
  endMinute: number;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampSensitivity(value: number): number {
  return clampInt(value, 0, 50);
}

function clampHour(value: number): number {
  return clampInt(value, 0, 23);
}

function clampMinute(value: number): number {
  return clampInt(value, 0, 59);
}

/**
 * Build the `<sensitivityInfoList>` XML fragment from the typed bands.
 * Bands are emitted in id-ascending order; out-of-range scalars are
 * clamped to the firmware-accepted ranges.
 */
export function encodeMotionSensitivityListXml(
  bands: MotionSensitivityBand[],
): string {
  if (bands.length === 0) return "<sensitivityInfoList />";
  const sorted = [...bands].sort((a, b) => a.id - b.id);
  const parts: string[] = ["<sensitivityInfoList>"];
  for (const b of sorted) {
    parts.push(
      `<sensitivityInfo>` +
        `<id>${b.id | 0}</id>` +
        `<sensitivity>${clampSensitivity(b.sensitivity)}</sensitivity>` +
        `<beginHour>${clampHour(b.beginHour)}</beginHour>` +
        `<beginMinute>${clampMinute(b.beginMinute)}</beginMinute>` +
        `<endHour>${clampHour(b.endHour)}</endHour>` +
        `<endMinute>${clampMinute(b.endMinute)}</endMinute>` +
        `</sensitivityInfo>`,
    );
  }
  parts.push("</sensitivityInfoList>");
  return parts.join("");
}

/**
 * Patch the `<sensitivityInfoList>` block inside a `<MD>` response XML
 * (cmd_id=46 GET) with a new schedule. Used by `setMotionAlarmFull` as
 * part of the read-modify-write flow.
 */
export function patchMotionSensitivityListXml(
  currentXml: string,
  bands: MotionSensitivityBand[],
): string {
  const fragment = encodeMotionSensitivityListXml(bands);
  return currentXml.replace(
    /<sensitivityInfoList[\s\S]*?(?:\/>|<\/sensitivityInfoList>)/,
    fragment,
  );
}
