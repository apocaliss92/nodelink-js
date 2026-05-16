import type {
  OsdDateFormat,
  SystemGeneralConfig,
  SystemGeneralPatch,
  TimeFormat,
} from "../types";
import {
  ensureXmlHeader,
  getXmlText,
  xmlEscape,
} from "../../../protocol/xml";

const parseNumberSafe = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

const parseInt01 = (text: string | undefined): 0 | 1 | undefined => {
  if (text === undefined) return undefined;
  return text.trim() === "1" ? 1 : 0;
};

const VALID_OSD_FORMATS: readonly OsdDateFormat[] = ["DMY", "MDY", "YMD"];

const normalizeOsdFormat = (text: string | undefined): OsdDateFormat => {
  const t = (text ?? "").trim();
  return (VALID_OSD_FORMATS as readonly string[]).includes(t)
    ? (t as OsdDateFormat)
    : "YMD";
};

/**
 * Parse the `<SystemGeneral>` block from a GetSystemGeneral (cmdId=104)
 * response.
 */
export function parseSystemGeneralFromXml(xml: string): SystemGeneralConfig {
  return {
    timeZone: parseNumberSafe(getXmlText(xml, "timeZone")) ?? 0,
    osdFormat: normalizeOsdFormat(getXmlText(xml, "osdFormat")),
    year: parseNumberSafe(getXmlText(xml, "year")) ?? 0,
    month: parseNumberSafe(getXmlText(xml, "month")) ?? 0,
    day: parseNumberSafe(getXmlText(xml, "day")) ?? 0,
    hour: parseNumberSafe(getXmlText(xml, "hour")) ?? 0,
    minute: parseNumberSafe(getXmlText(xml, "minute")) ?? 0,
    second: parseNumberSafe(getXmlText(xml, "second")) ?? 0,
    deviceId: parseNumberSafe(getXmlText(xml, "deviceId")) ?? 0,
    timeFormat: (parseInt01(getXmlText(xml, "timeFormat")) ??
      0) as TimeFormat,
    language: getXmlText(xml, "language") ?? "English",
    deviceName: getXmlText(xml, "deviceName") ?? "",
    loginLock: parseInt01(getXmlText(xml, "loginLock")) ?? 0,
    lockTime: parseNumberSafe(getXmlText(xml, "lockTime")) ?? 0,
    allowedTimes: parseNumberSafe(getXmlText(xml, "allowedTimes")) ?? 0,
    isDst: parseInt01(getXmlText(xml, "isDst")) ?? 0,
  };
}

/**
 * Build the SetSystemGeneral XML body (cmdId=105).
 *
 * Reolink's SET accepts partial payloads — include only the fields you want
 * to change. The camera reads a `<year>0</year>` marker as "do not set
 * manual clock", and a `<deviceNameOnly>1</deviceNameOnly>` flag (alongside
 * `<deviceName>`) as "ignore all other fields and only rename".
 *
 * Pcap-confirmed shapes from the Reolink Client (2026-05-16):
 *   <SystemGeneral><timeZone>-3600</timeZone><year>0</year></SystemGeneral>
 *   <SystemGeneral><osdFormat>YMD</osdFormat><timeFormat>0</timeFormat><year>0</year></SystemGeneral>
 *   <SystemGeneral><year>0</year><deviceName>Studio</deviceName><deviceNameOnly>1</deviceNameOnly></SystemGeneral>
 */
export function buildSetSystemGeneralXml(patch: SystemGeneralPatch): string {
  const parts: string[] = [];

  // When only deviceName is patched, the Reolink Client uses a dedicated
  // shape: year=0 + deviceName + deviceNameOnly=1. Mirror that exactly.
  const isDeviceNameOnly =
    patch.deviceName !== undefined &&
    patch.timeZone === undefined &&
    patch.osdFormat === undefined &&
    patch.timeFormat === undefined &&
    patch.language === undefined &&
    patch.loginLock === undefined &&
    patch.lockTime === undefined &&
    patch.allowedTimes === undefined &&
    patch.manualTime === undefined;

  if (isDeviceNameOnly) {
    parts.push("<year>0</year>");
    parts.push(`<deviceName>${xmlEscape(patch.deviceName!)}</deviceName>`);
    parts.push("<deviceNameOnly>1</deviceNameOnly>");
  } else if (patch.manualTime !== undefined) {
    // Manual clock set — include year/month/day/hour/minute/second; do NOT
    // emit the year=0 marker.
    const mt = patch.manualTime;
    if (patch.timeZone !== undefined)
      parts.push(`<timeZone>${patch.timeZone}</timeZone>`);
    if (patch.osdFormat !== undefined)
      parts.push(`<osdFormat>${patch.osdFormat}</osdFormat>`);
    parts.push(`<year>${mt.year}</year>`);
    parts.push(`<month>${mt.month}</month>`);
    parts.push(`<day>${mt.day}</day>`);
    parts.push(`<hour>${mt.hour}</hour>`);
    parts.push(`<minute>${mt.minute}</minute>`);
    parts.push(`<second>${mt.second}</second>`);
    if (patch.timeFormat !== undefined)
      parts.push(`<timeFormat>${patch.timeFormat}</timeFormat>`);
    if (patch.language !== undefined)
      parts.push(`<language>${xmlEscape(patch.language)}</language>`);
    if (patch.deviceName !== undefined)
      parts.push(`<deviceName>${xmlEscape(patch.deviceName)}</deviceName>`);
    if (patch.loginLock !== undefined)
      parts.push(`<loginLock>${patch.loginLock}</loginLock>`);
    if (patch.lockTime !== undefined)
      parts.push(`<lockTime>${patch.lockTime}</lockTime>`);
    if (patch.allowedTimes !== undefined)
      parts.push(`<allowedTimes>${patch.allowedTimes}</allowedTimes>`);
  } else {
    // Generic partial — emit specified fields + year=0 marker.
    if (patch.timeZone !== undefined)
      parts.push(`<timeZone>${patch.timeZone}</timeZone>`);
    if (patch.osdFormat !== undefined)
      parts.push(`<osdFormat>${patch.osdFormat}</osdFormat>`);
    if (patch.timeFormat !== undefined)
      parts.push(`<timeFormat>${patch.timeFormat}</timeFormat>`);
    if (patch.language !== undefined)
      parts.push(`<language>${xmlEscape(patch.language)}</language>`);
    if (patch.loginLock !== undefined)
      parts.push(`<loginLock>${patch.loginLock}</loginLock>`);
    if (patch.lockTime !== undefined)
      parts.push(`<lockTime>${patch.lockTime}</lockTime>`);
    if (patch.allowedTimes !== undefined)
      parts.push(`<allowedTimes>${patch.allowedTimes}</allowedTimes>`);
    parts.push("<year>0</year>");
  }

  return ensureXmlHeader(
    `<body>` +
      `<SystemGeneral version="1.1">${parts.join("")}</SystemGeneral>` +
      `</body>`,
  );
}
