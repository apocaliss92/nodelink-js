/**
 * cmd 142 `<DayRecords>` — the calendar's "which days of a month have
 * footage", one entry per channel.
 *
 * Wire shape, from the official app captured 2026-09-20 on a standalone E1
 * Outdoor PoE (v3.1.0.5223) and on a Reolink Home Hub (v3.3.0.456, child
 * channel 0), then verified live on channels 0, 1 and 3 of the same hub:
 *
 *   request  (responseCode 0, class 0x6414, NO Extension, header channelId =
 *             session counter in the app, hostChannelId 250 accepted):
 *     <DayRecords version="1.1">
 *       <startTime>y/m/1 00:00:00</startTime><endTime>y/m/last 23:59:59</endTime>
 *       <DayRecordList><DayRecord><index>i</index><channelId>ch</channelId><uid>…</uid></DayRecord>…</DayRecordList>
 *     </DayRecords>
 *   response (responseCode 200): the same envelope, each DayRecord carrying
 *     <dayTypeList><dayType><index>N</index><type>normal</type></dayType>…</dayTypeList>
 *     where `index` is the day of month MINUS ONE and a day with no footage
 *     is simply absent (12 September missing on one camera, 1 September on
 *     the other, same month). An empty month answers `<dayTypeList/>`.
 *
 * `type` is an open vocabulary: only `normal` was observed. It is parsed as
 * a string, never enumerated.
 *
 * The month window is a CALENDAR month in the camera's own wall clock —
 * there is no instant to convert, so no time zone is involved.
 */

import { getXmlText, xmlEscape } from "../../../protocol/xml";
import { getXmlBlocks } from "../xmlUtils";

export interface DayRecordsChannelEntry {
  /** Logical channel (0 on a standalone camera). */
  channel: number;
  /**
   * Device UID. On a Home Hub the UID is what SELECTS the camera — a
   * request naming channel 1 with channel 0's UID is answered with channel
   * 0's days (verified live 2026-09-20). On a standalone camera the value is
   * echoed and ignored (a wrong or empty UID still answers).
   */
  uid: string;
}

export interface DayRecordDay {
  /** 1-based day of month. */
  day: number;
  /** Open vocabulary; `normal` is the only value observed so far. */
  type: string;
}

export interface DayRecordsChannelResult {
  /** Position in the request's `DayRecordList`. */
  index: number;
  /** The channel the device echoed. */
  channelId: number;
  /** Days with footage, ascending. Empty when the month has none. */
  days: DayRecordDay[];
}

export interface DayRecordsResult {
  year: number;
  /** 1-12 */
  month: number;
  records: DayRecordsChannelResult[];
}

/** Days in `month` (1-12) of `year`, Gregorian. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function assertMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new RangeError(`DayRecords: year out of range: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`DayRecords: month must be 1-12, got ${month}`);
  }
}

export function buildDayRecordsXml(params: {
  year: number;
  month: number;
  entries: readonly DayRecordsChannelEntry[];
}): string {
  assertMonth(params.year, params.month);
  if (params.entries.length === 0) {
    throw new RangeError("DayRecords: at least one channel entry is required");
  }
  const last = daysInMonth(params.year, params.month);
  const list = params.entries
    .map(
      (e, i) =>
        `<DayRecord>\n<index>${i}</index>\n<channelId>${e.channel}</channelId>\n<uid>${xmlEscape(e.uid)}</uid>\n</DayRecord>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<DayRecords version="1.1">
<startTime>
<year>${params.year}</year>
<month>${params.month}</month>
<day>1</day>
<hour>0</hour>
<minute>0</minute>
<second>0</second>
</startTime>
<endTime>
<year>${params.year}</year>
<month>${params.month}</month>
<day>${last}</day>
<hour>23</hour>
<minute>59</minute>
<second>59</second>
</endTime>
<DayRecordList>
${list}
</DayRecordList>
</DayRecords>
</body>`;
}

const int = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Parse a cmd 142 reply. Throws when the envelope is not a `<DayRecords>`
 * block — a 400 with an empty body is what the camera answers to a request
 * without the month payload, and that must not read as "no days".
 */
export function parseDayRecordsXml(xml: string): DayRecordsResult {
  const envelope = getXmlBlocks(xml, "DayRecords")[0];
  if (envelope === undefined) {
    throw new Error("DayRecords: reply carries no <DayRecords> block");
  }
  const start = getXmlBlocks(envelope, "startTime")[0] ?? "";
  const year = int(getXmlText(start, "year"));
  const month = int(getXmlText(start, "month"));
  if (year === undefined || month === undefined) {
    throw new Error("DayRecords: reply carries no <startTime> year/month");
  }
  const records: DayRecordsChannelResult[] = [];
  for (const rec of getXmlBlocks(envelope, "DayRecord")) {
    // `getXmlBlocks(rec, "index")` would also match the day indexes inside
    // dayTypeList; the record's own index is the first one.
    const index = int(getXmlText(rec, "index")) ?? records.length;
    const channelId = int(getXmlText(rec, "channelId")) ?? 0;
    const days: DayRecordDay[] = [];
    for (const dt of getXmlBlocks(rec, "dayType")) {
      const idx = int(getXmlText(dt, "index"));
      if (idx === undefined) continue;
      days.push({ day: idx + 1, type: (getXmlText(dt, "type") ?? "").trim() });
    }
    days.sort((a, b) => a.day - b.day);
    records.push({ index, channelId, days });
  }
  return { year, month, records };
}
