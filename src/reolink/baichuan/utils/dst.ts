import type { DstConfig, DstConfigPatch, DayOfWeek } from "../types";
import { ensureXmlHeader, getXmlText, xmlEscape } from "../../../protocol/xml";

const parseNumberSafe = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

const parseInt01 = (text: string | undefined): 0 | 1 | undefined => {
  if (text === undefined) return undefined;
  return text.trim() === "1" ? 1 : 0;
};

const VALID_WEEKDAYS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const normalizeWeekday = (text: string | undefined): DayOfWeek => {
  const t = (text ?? "").trim();
  return VALID_WEEKDAYS.includes(t) ? (t as DayOfWeek) : "Sunday";
};

/**
 * Parse the `<Dst>` block returned by GetDst (cmdId=106).
 */
export function parseDstConfigFromXml(xml: string): DstConfig {
  const cfg: DstConfig = {
    enable: parseInt01(getXmlText(xml, "enable")) ?? 0,
    offset: parseNumberSafe(getXmlText(xml, "offset")) ?? 1,
    startMonth: parseNumberSafe(getXmlText(xml, "startMonth")) ?? 3,
    startWeekIndex: parseNumberSafe(getXmlText(xml, "startWeekIndex")) ?? 5,
    startWeekday: normalizeWeekday(getXmlText(xml, "startWeekday")),
    startHour: parseNumberSafe(getXmlText(xml, "startHour")) ?? 2,
    startMinute: parseNumberSafe(getXmlText(xml, "startMinute")) ?? 0,
    startSecond: parseNumberSafe(getXmlText(xml, "startSecond")) ?? 0,
    endMonth: parseNumberSafe(getXmlText(xml, "endMonth")) ?? 10,
    endWeekIndex: parseNumberSafe(getXmlText(xml, "endWeekIndex")) ?? 4,
    endWeekday: normalizeWeekday(getXmlText(xml, "endWeekday")),
    endHour: parseNumberSafe(getXmlText(xml, "endHour")) ?? 3,
    endMinute: parseNumberSafe(getXmlText(xml, "endMinute")) ?? 0,
    endSecond: parseNumberSafe(getXmlText(xml, "endSecond")) ?? 0,
  };
  const version = parseNumberSafe(getXmlText(xml, "version"));
  if (version !== undefined) cfg.version = version;
  return cfg;
}

/**
 * Build the SetDst XML body (cmdId=107). Reolink expects the full `<Dst>`
 * block — patch is merged onto the current config by the caller.
 */
export function buildSetDstXml(current: DstConfig, patch: DstConfigPatch): string {
  const merged: DstConfig = { ...current, ...patch };
  return ensureXmlHeader(
    `<body>` +
      `<Dst version="1.1">` +
      `<enable>${merged.enable}</enable>` +
      `<offset>${merged.offset}</offset>` +
      `<startMonth>${merged.startMonth}</startMonth>` +
      `<startWeekIndex>${merged.startWeekIndex}</startWeekIndex>` +
      `<startWeekday>${xmlEscape(merged.startWeekday)}</startWeekday>` +
      `<startHour>${merged.startHour}</startHour>` +
      `<startMinute>${merged.startMinute}</startMinute>` +
      `<startSecond>${merged.startSecond}</startSecond>` +
      `<endMonth>${merged.endMonth}</endMonth>` +
      `<endWeekIndex>${merged.endWeekIndex}</endWeekIndex>` +
      `<endWeekday>${xmlEscape(merged.endWeekday)}</endWeekday>` +
      `<endHour>${merged.endHour}</endHour>` +
      `<endMinute>${merged.endMinute}</endMinute>` +
      `<endSecond>${merged.endSecond}</endSecond>` +
      `</Dst>` +
      `</body>`,
  );
}
