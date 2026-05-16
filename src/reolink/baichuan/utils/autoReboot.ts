import type {
  AutoRebootConfig,
  AutoRebootConfigPatch,
  DayOfWeek,
} from "../types";
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
  "everyday",
];

const normalizeWeekday = (text: string | undefined): DayOfWeek => {
  const t = (text ?? "").trim();
  return VALID_WEEKDAYS.includes(t) ? (t as DayOfWeek) : "Sunday";
};

/**
 * Parse the `<AutoReboot>` block returned by GetAutoReboot (cmdId=101).
 */
export function parseAutoRebootFromXml(xml: string): AutoRebootConfig {
  return {
    enable: parseInt01(getXmlText(xml, "enable")) ?? 0,
    weekDay: normalizeWeekday(getXmlText(xml, "weekDay")),
    hour: parseNumberSafe(getXmlText(xml, "hour")) ?? 0,
    minute: parseNumberSafe(getXmlText(xml, "minute")) ?? 0,
    second: parseNumberSafe(getXmlText(xml, "second")) ?? 0,
  };
}

/**
 * Build the SetAutoReboot XML body (cmdId=100).
 */
export function buildSetAutoRebootXml(
  current: AutoRebootConfig,
  patch: AutoRebootConfigPatch,
): string {
  const merged: AutoRebootConfig = { ...current, ...patch };
  return ensureXmlHeader(
    `<body>` +
      `<AutoReboot version="1.1">` +
      `<enable>${merged.enable}</enable>` +
      `<weekDay>${xmlEscape(merged.weekDay)}</weekDay>` +
      `<hour>${merged.hour}</hour>` +
      `<minute>${merged.minute}</minute>` +
      `<second>${merged.second}</second>` +
      `</AutoReboot>` +
      `</body>`,
  );
}
