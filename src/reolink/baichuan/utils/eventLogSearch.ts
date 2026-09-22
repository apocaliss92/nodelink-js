/**
 * cmd 516/517/518 `<findEventLog>` — the Home Hub's CROSS-CHANNEL event list.
 *
 * This is the catalog the official app draws its Events tab from, and it is
 * both faster and richer than walking each channel's recordings: one search
 * spans every child of the hub, carries the event class per row, and — unlike
 * every other recordings search here — is NOT bounded to a single day.
 * Measured 2026-09-20 against a Home Hub v3.3.0.456: 59 events over three
 * children and three days in 2 372 ms, and 1 886 events over 20 days in
 * 11 908 ms, each row carrying its `alarmType`. The equivalent per-channel
 * FileInfoList pass carries no class at all.
 *
 * HUB ONLY. A standalone E1 Outdoor PoE (v3.1.0.5223) answers cmd 516 with
 * an EMPTY BODY — no envelope, no handle — so `searchEventLog` refuses with
 * a named error instead of reading the silence as "no events".
 *
 * Wire shape, from the official app captured 2026-09-20 (no Extension on any
 * of the three commands):
 *
 *   open (516):
 *     <findEventLog version="1.1">
 *       <logTypeBits>1</logTypeBits><notSearchVideo>1</notSearchVideo>
 *       <onlySearchCluster>0</onlySearchCluster><desc>0</desc><chnbits>0</chnbits>
 *       <alarmType>md,people,vehicle,dog_cat,visitor,package</alarmType>  (CSV, NO space)
 *       <eventAlarmType><i>md</i>…</eventAlarmType>
 *       <startTime>…</startTime><endTime>…</endTime>
 *       <devices><deviceInfo><uid>…</uid><logicChnBitmap>3</logicChnBitmap></deviceInfo>…</devices>
 *     </findEventLog>
 *   → `<findEventLog>{ handle, maxEventCount }` — 60 in both captures.
 *
 *   get   (517): `{ handle, maxEventCount }` → `<eventLogInfo>{ handle,
 *         bFinished, eventLogList }`, 60 `<eventLog>` rows on a full page.
 *   close (518): `{ handle }`.
 *
 * Four things the capture and the live probe SETTLE, against the
 * obvious reading:
 *
 * - **The window MUST be written newest-first**: `startTime` is the LATER
 *   instant and `endTime` the earlier one (10 Sep 23:59:59 → 8 Sep 00:00:00;
 *   the "all history" variant ends at 1 Jan 1970). This is not a style: the
 *   same window written FORWARDS answered ZERO rows in 191 ms, measured live
 *   2026-09-20 on the hub. `desc` was `0` throughout, so `desc` is NOT what
 *   orders the rows — the window's direction is. `desc`'s own meaning stays
 *   unknown and it is sent as the app sends it.
 * - **The channel selection travels as `<devices>`**, a list of
 *   `{ uid, logicChnBitmap }`, NOT through `chnbits`. Measured the same day:
 *   `chnbits: 3` answered exactly what `chnbits: 0` did (59 events either
 *   way, same rows), while cutting `devices` down to ONE child turned those
 *   59 into 10, all from that child. `chnbits` is exposed, defaulted to 0,
 *   and never derived from the device list.
 * - **Pages repeat, rarely.** 1 886 events over 20 days needed ~32 pages of
 *   60 and carried 5 duplicate rows across page boundaries, with the merge
 *   across children not perfectly monotonic at a boundary. `searchEventLog`
 *   dedupes on (uid, logicChn, startTime, alarmType) and leaves the order
 *   the device chose.
 * - **The handle to page with is the OPEN handle**, and it advances: 1 886
 *   rows came back from repeated gets carrying handle 0. The reply carries a
 *   DIFFERENT handle (1) — recorded on the page, never used.
 *
 * Row shape: `{ uid, logicChn, bHasRecFile, bEncrypted, bDeleted, alarmType,
 * startTime, endTime }` — no file name. `bHasRecFile` was `0` on 12 of the
 * 60 captured rows, and on 515 of 1 886 live, so an event is NOT a promise
 * of a clip; a consumer that wants the file must join on `findAlarmVideo` /
 * FileInfoList by channel and window. `alarmType` is an OPEN vocabulary, carried through verbatim.
 */

import {
  BC_CMD_ID_FIND_EVENT_LOG_CLOSE,
  BC_CMD_ID_FIND_EVENT_LOG_GET,
  BC_CMD_ID_FIND_EVENT_LOG_OPEN,
} from "../../../protocol/constants";
import { getXmlText, xmlEscape } from "../../../protocol/xml";
import { getXmlBlocks, parseXmlDateTimeBlock } from "../xmlUtils";
import { xmlDateTimePayload } from "./recordings";
import type { SendXmlLike } from "./recordingsFileInfoList";

/** The `alarmType` CSV the app sends on a 516 open — six types, no spaces. */
export const DEFAULT_EVENT_LOG_SEARCH_ALARM_TYPES =
  "md,people,vehicle,dog_cat,visitor,package";

/**
 * The `<eventAlarmType>` items the app sends beside it. Same six types, a
 * DIFFERENT order (`package` second rather than last) — reproduced verbatim.
 */
export const DEFAULT_EVENT_LOG_SEARCH_EVENT_ALARM_TYPES: readonly string[] = [
  "md",
  "package",
  "people",
  "vehicle",
  "dog_cat",
  "visitor",
];

/** The `maxEventCount` the hub answered with, and the app then asked for. */
export const DEFAULT_EVENT_LOG_MAX_EVENT_COUNT = 60;

/** One child of the hub, as the open request names it. */
export interface EventLogDevice {
  uid: string;
  /** Observed 3 for every child. Default 3. */
  logicChnBitmap?: number;
}

/** One row of the hub's event list. */
export interface EventLogEntry {
  /** The child device the event happened on. */
  uid: string;
  /** Logical channel inside that child (0 on every captured row). */
  logicChn: number;
  /**
   * Whether a recording file exists for this event. `false` on 12 of the 60
   * captured rows: an event is not a promise of a clip.
   */
  hasRecFile: boolean;
  encrypted: boolean;
  deleted: boolean;
  /** The event class the hub wrote, verbatim. Open vocabulary. */
  alarmType: string;
  /** `alarmType` split on commas and trimmed. */
  alarmTypes: string[];
  startTime?: Date;
  endTime?: Date;
}

/** The reply to a 516 open. */
export interface EventLogSearchHandle {
  handle: number;
  /** Page size the hub grants. 60 in both captures. */
  maxEventCount: number;
}

/** One 517 page. */
export interface EventLogPage {
  /**
   * The handle the REPLY carries. The hub answered `1` to a get sent with
   * handle `0`, so this is not necessarily the handle to page with — the
   * app kept sending the OPEN handle and so does this library.
   */
  handle: number;
  /** `bFinished` as written; `undefined` when the tag is absent. */
  finished?: boolean;
  events: EventLogEntry[];
}

export interface BuildFindEventLogOpenParams {
  /**
   * The wire's `startTime`. The app writes the LATER instant here — the
   * window is descending and the rows come back newest first.
   */
  startTime: Date;
  /** The wire's `endTime`: the EARLIER instant in the app's captures. */
  endTime: Date;
  /** One entry per child of the hub. At least one is required. */
  devices: readonly EventLogDevice[];
  /** Observed 1. */
  logTypeBits?: number;
  /** Observed 1 — the app does not want the video, only the log. */
  notSearchVideo?: number;
  /** Observed 0. */
  onlySearchCluster?: number;
  /**
   * Observed 0 while the window itself was descending, so this is NOT the
   * sort order the app relies on. Meaning unknown; sent as captured.
   */
  desc?: number;
  /**
   * Observed 0 while three children were selected through `<devices>`.
   * Meaning unknown; never derived from `devices`.
   */
  chnbits?: number;
  /** CSV; default {@link DEFAULT_EVENT_LOG_SEARCH_ALARM_TYPES}. */
  alarmType?: string;
  /**
   * `<eventAlarmType>` items; default
   * {@link DEFAULT_EVENT_LOG_SEARCH_EVENT_ALARM_TYPES}. An empty array omits
   * the element.
   */
  eventAlarmTypes?: readonly string[];
  /** IANA zone of the hub's wall clock. Host local when omitted. */
  timeZone?: string;
}

const itemList = (tag: string, items: readonly string[]): string =>
  items.length === 0
    ? ""
    : `\n<${tag}>\n${items.map((t) => `<i>${xmlEscape(t)}</i>`).join("\n")}\n</${tag}>`;

export const buildFindEventLogOpenXml = (
  params: BuildFindEventLogOpenParams,
): string => {
  if (params.devices.length === 0) {
    throw new RangeError("findEventLog: at least one device is required");
  }
  const alarmType = params.alarmType ?? DEFAULT_EVENT_LOG_SEARCH_ALARM_TYPES;
  const eventAlarmTypes =
    params.eventAlarmTypes ?? DEFAULT_EVENT_LOG_SEARCH_EVENT_ALARM_TYPES;
  const devices = params.devices
    .map(
      (d) =>
        `<deviceInfo>\n<uid>${xmlEscape(d.uid)}</uid>\n<logicChnBitmap>${d.logicChnBitmap ?? 3}</logicChnBitmap>\n</deviceInfo>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findEventLog version="1.1">
<logTypeBits>${params.logTypeBits ?? 1}</logTypeBits>
<notSearchVideo>${params.notSearchVideo ?? 1}</notSearchVideo>
<onlySearchCluster>${params.onlySearchCluster ?? 0}</onlySearchCluster>
<desc>${params.desc ?? 0}</desc>
<chnbits>${params.chnbits ?? 0}</chnbits>
<alarmType>${xmlEscape(alarmType)}</alarmType>${itemList("eventAlarmType", eventAlarmTypes)}
${xmlDateTimePayload("startTime", params.startTime, params.timeZone)}
${xmlDateTimePayload("endTime", params.endTime, params.timeZone)}
<devices>
${devices}
</devices>
</findEventLog>
</body>`;
};

export const buildFindEventLogGetXml = (params: {
  handle: number;
  maxEventCount: number;
}): string =>
  `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findEventLog version="1.1">
<handle>${params.handle}</handle>
<maxEventCount>${params.maxEventCount}</maxEventCount>
</findEventLog>
</body>`;

export const buildFindEventLogCloseXml = (params: {
  handle: number;
}): string =>
  `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findEventLog version="1.1">
<handle>${params.handle}</handle>
</findEventLog>
</body>`;

const int = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
};

const bool = (s: string | undefined): boolean | undefined =>
  s === undefined ? undefined : s.trim() === "1";

/**
 * Parse the 516 reply. A standalone camera answers with an empty body; that
 * is a refusal, not an empty result, so this throws and names it.
 */
export const parseFindEventLogOpenXml = (
  xml: string,
): EventLogSearchHandle => {
  const envelope = getXmlBlocks(xml, "findEventLog")[0];
  if (envelope === undefined) {
    throw new Error(
      "findEventLog: open answered no <findEventLog> block (cmd 516 is Hub-only — a standalone camera answers with an empty body)",
    );
  }
  const handle = int(getXmlText(envelope, "handle"));
  if (handle === undefined) {
    throw new Error("findEventLog: open reply carries no <handle>");
  }
  return {
    handle,
    maxEventCount:
      int(getXmlText(envelope, "maxEventCount")) ??
      DEFAULT_EVENT_LOG_MAX_EVENT_COUNT,
  };
};

/** Parse one 517 page. */
export const parseEventLogPageXml = (
  xml: string,
  options?: { timeZone?: string },
): EventLogPage => {
  const envelope = getXmlBlocks(xml, "eventLogInfo")[0];
  if (envelope === undefined) {
    throw new Error("findEventLog: page reply carries no <eventLogInfo>");
  }
  const timeZone = options?.timeZone;
  const finished = bool(getXmlText(envelope, "bFinished"));
  const events: EventLogEntry[] = [];
  for (const row of getXmlBlocks(envelope, "eventLog")) {
    const alarmType = (getXmlText(row, "alarmType") ?? "").trim();
    const start = getXmlBlocks(row, "startTime")[0];
    const end = getXmlBlocks(row, "endTime")[0];
    const startTime = start
      ? parseXmlDateTimeBlock(start, timeZone)
      : undefined;
    const endTime = end ? parseXmlDateTimeBlock(end, timeZone) : undefined;
    events.push({
      uid: (getXmlText(row, "uid") ?? "").trim(),
      logicChn: int(getXmlText(row, "logicChn")) ?? 0,
      hasRecFile: bool(getXmlText(row, "bHasRecFile")) ?? false,
      encrypted: bool(getXmlText(row, "bEncrypted")) ?? false,
      deleted: bool(getXmlText(row, "bDeleted")) ?? false,
      alarmType,
      alarmTypes: alarmType
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    });
  }
  return {
    handle: int(getXmlText(envelope, "handle")) ?? 0,
    ...(finished !== undefined ? { finished } : {}),
    events,
  };
};

export interface SearchEventLogLowLevelParams
  extends BuildFindEventLogOpenParams {
  sendXml: SendXmlLike;
  /**
   * Page size asked for on every 517. Defaults to whatever the open reply
   * granted (60 in the captures).
   */
  maxEventCount?: number;
  /** Bound on the paging loop. */
  maxPages: number;
  timeoutMs?: number;
}

/**
 * Open → page → close, closing the handle in a `finally` so no error path
 * leaks it. None of the three commands carries an Extension.
 */
export const searchEventLogViaFindEventLog = async (
  params: SearchEventLogLowLevelParams,
): Promise<EventLogEntry[]> => {
  const timeoutMs = params.timeoutMs ?? 15_000;
  const openResp = await params.sendXml({
    cmdId: BC_CMD_ID_FIND_EVENT_LOG_OPEN,
    payloadXml: buildFindEventLogOpenXml(params),
    timeoutMs,
  });
  const opened = parseFindEventLogOpenXml(openResp);
  const maxEventCount = params.maxEventCount ?? opened.maxEventCount;

  // The app pages with the handle the OPEN returned, even though the reply
  // to a get carries a different one (0 out, 1 back). Only one get was
  // captured, so the reply's handle is exposed on the page and not used.
  const getXml = buildFindEventLogGetXml({
    handle: opened.handle,
    maxEventCount,
  });
  const events: EventLogEntry[] = [];

  try {
    for (let i = 0; i < params.maxPages; i++) {
      let resp: string;
      try {
        resp = await params.sendXml({
          cmdId: BC_CMD_ID_FIND_EVENT_LOG_GET,
          payloadXml: getXml,
          timeoutMs,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("responseCode 400, empty body")) break;
        throw e;
      }
      const page = parseEventLogPageXml(
        resp,
        params.timeZone !== undefined
          ? { timeZone: params.timeZone }
          : undefined,
      );
      events.push(...page.events);
      if (page.finished === true) break;
      if (page.finished === undefined && page.events.length === 0) break;
    }
  } finally {
    try {
      await params.sendXml({
        cmdId: BC_CMD_ID_FIND_EVENT_LOG_CLOSE,
        payloadXml: buildFindEventLogCloseXml({ handle: opened.handle }),
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    } catch {
      // Never mask the error that brought us here.
    }
  }

  return events;
};
