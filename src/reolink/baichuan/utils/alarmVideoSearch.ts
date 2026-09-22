/**
 * cmd 272/273/274 `<findAlarmVideo>` — the EVENT WINDOWS inside one camera's
 * recordings, for one camera-local day.
 *
 * This is not a second file listing. A FileInfoList search (cmd 14/15/16)
 * answers with FILES — one `.mp4` per recording segment, named after the
 * segment. `findAlarmVideo` answers with the ALARM WINDOWS inside those
 * files: several rows can name the same `fileName`, each with its own
 * `alarmType` and its own start/end.
 *
 * Measured live 2026-09-20 on the standalone E1 Outdoor PoE, 19 September:
 * 1 271 windows over 539 files, 1 to 13 windows per file, and **every one of
 * the 1 271 inside its file's own window, none outside**. The union of a
 * file's `alarmType`s equalled the file's `recordType` on 501 of the 539.
 *
 * `fileName` here is exactly a FileInfoList `<name>` (`01` + YYYYMMDD +
 * HHMMSS), so the two surfaces JOIN on it — and which file set you get is
 * `streamType`'s doing: `0` returned all 539 of the cmd 14 `mainStream`
 * names and `1` all 539 of the `subStream` ones. The official app sends 0.
 *
 * The window is ONE camera-local day and the firmware enforces it silently:
 * an 18→19 September window answered 462 windows all dated 18 September.
 * `api.searchAlarmVideos` clamps rather than let the rest disappear.
 *
 * Wire shape, from the official app captured 2026-09-20 on a standalone E1
 * Outdoor PoE (v3.1.0.5223) and on a Reolink Home Hub (v3.3.0.456, child
 * channel 0). Unlike cmd 14/15/16, this family DOES carry an Extension:
 *
 *   open (272), Extension `<channelId>N</channelId>`, body:
 *     <findAlarmVideo version="1.1">
 *       <channelId>N</channelId><uid>…</uid><logicChnBitmap>255</logicChnBitmap>
 *       <streamType>0</streamType><notSearchVideo>0</notSearchVideo>
 *       <startTime>…</startTime><endTime>…</endTime>
 *       <alarmType>md, pir, …</alarmType>          (CSV, comma-SPACE)
 *       <eventAlarmType><i>md</i>…</eventAlarmType>
 *     </findAlarmVideo>
 *   → `<findAlarmVideo>{ channelId, fileHandle }`
 *
 *   get (273) and close (274) send the SAME body byte for byte:
 *   Extension `{ channelId }` + `<findAlarmVideo>{ channelId, fileHandle }`.
 *   A get answers `<alarmVideoInfo>{ channelId, fileHandle, bFinished,
 *   alarmVideoList }` — 30 `<alarmVideo>` rows per full page on the
 *   standalone (145 pages for one busy day), 29 in one page on the hub.
 *
 * Row shape: `{ fileName, bEncrypted, alarmType, fileId, startTime, endTime }`
 * on a standalone; a Home Hub adds `{ uid, logicChn, bHasRecFile, bDeleted }`
 * BEFORE `bEncrypted`. `fileId` was empty on all 86 captured rows.
 *
 * `alarmType` is an OPEN vocabulary: it is carried through as the string the
 * camera wrote. `md`, `people`, `dog_cat` and `other` were observed; a
 * firmware inventing a type must reach the caller as itself, never as a
 * throw and never as a default.
 */

import {
  BC_CMD_ID_FIND_ALARM_VIDEO_CLOSE,
  BC_CMD_ID_FIND_ALARM_VIDEO_GET,
  BC_CMD_ID_FIND_ALARM_VIDEO_OPEN,
} from "../../../protocol/constants";
import { getXmlText, xmlEscape } from "../../../protocol/xml";
import { getXmlBlocks, parseXmlDateTimeBlock } from "../xmlUtils";
import { xmlDateTimePayload } from "./recordings";
import type { SendXmlLike } from "./recordingsFileInfoList";

/**
 * The `alarmType` CSV the official app sends on a `findAlarmVideo` open —
 * 17 types, separated by a comma AND a space, identical on both topologies.
 * A narrower list silently returns fewer windows.
 */
export const DEFAULT_ALARM_VIDEO_SEARCH_ALARM_TYPES =
  "md, pir, other, package, io, people, face, vehicle, dog_cat, visitor, cry, crossline, intrude, loitering, legacy, loss, answer";

/**
 * The `<eventAlarmType>` item list the app sends beside `alarmType`. Note it
 * is NOT the same set: it drops `package` and adds `nonmotorveh`, `tamper`
 * and `lmsg` (19 items against the CSV's 17). Reproduced verbatim rather
 * than reconciled — a firmware parser may well care.
 */
export const DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES: readonly string[] = [
  "md",
  "pir",
  "other",
  "io",
  "people",
  "face",
  "vehicle",
  "dog_cat",
  "visitor",
  "cry",
  "crossline",
  "intrude",
  "loitering",
  "legacy",
  "loss",
  "answer",
  "nonmotorveh",
  "tamper",
  "lmsg",
];

/** One alarm window inside a recording file. */
export interface AlarmVideoWindow {
  /**
   * The recording file the window lives in — the same name a FileInfoList
   * search returns, so the two surfaces join on it.
   */
  fileName: string;
  /**
   * The event class the camera wrote, verbatim. Open vocabulary.
   */
  alarmType: string;
  /**
   * `alarmType` split on commas and trimmed. One entry in every captured
   * row; the field exists because the request side is a CSV and a firmware
   * answering with one would otherwise be unreadable.
   */
  alarmTypes: string[];
  encrypted: boolean;
  /** Empty on every captured row (86/86); carried through when present. */
  fileId?: string;
  startTime?: Date;
  endTime?: Date;
  /** Hub rows only: the child device the window belongs to. */
  uid?: string;
  /** Hub rows only: the logical channel inside that child (0 on all rows). */
  logicChn?: number;
  /** Hub rows only: whether a recording file exists for the window. */
  hasRecFile?: boolean;
  /** Hub rows only. */
  deleted?: boolean;
}

/** The reply to a 272 open. */
export interface AlarmVideoSearchHandle {
  channelId: number;
  fileHandle: number;
}

/** One 273 page. */
export interface AlarmVideoPage extends AlarmVideoSearchHandle {
  /**
   * `bFinished` as the device wrote it. `undefined` when the tag is absent —
   * which is NOT the same as "more pages": the caller decides, and this type
   * refuses to guess for it.
   */
  finished?: boolean;
  windows: AlarmVideoWindow[];
}

export interface BuildFindAlarmVideoOpenParams {
  channel: number;
  uid: string;
  /** Observed 255 on both topologies. */
  logicChnBitmap?: number;
  /**
   * NUMERIC here, unlike FileInfoList's `subStream`/`mainStream` string,
   * and it selects the FILE SET: measured 2026-09-20 on the standalone,
   * `0` → the 539 main-stream names, `1` → the 539 sub-stream ones
   * (539/539 against the matching cmd 14 listing, either way). The app
   * sends 0. Default 0.
   */
  streamType?: number;
  /** Observed 0. */
  notSearchVideo?: number;
  start: Date;
  end: Date;
  /** CSV; default {@link DEFAULT_ALARM_VIDEO_SEARCH_ALARM_TYPES}. */
  alarmType?: string;
  /**
   * `<eventAlarmType>` items. Default
   * {@link DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES}; an empty array
   * omits the element.
   */
  eventAlarmTypes?: readonly string[];
  /** IANA zone of the camera's wall clock. Host local when omitted. */
  timeZone?: string;
}

const itemList = (tag: string, items: readonly string[]): string =>
  items.length === 0
    ? ""
    : `\n<${tag}>\n${items.map((t) => `<i>${xmlEscape(t)}</i>`).join("\n")}\n</${tag}>`;

/** The Extension cmd 272/273/274 carry (cmd 14/15/16 carry none). */
export const buildFindAlarmVideoExtensionXml = (channel: number): string =>
  `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<channelId>${channel}</channelId>
</Extension>`;

export const buildFindAlarmVideoOpenXml = (
  params: BuildFindAlarmVideoOpenParams,
): string => {
  const alarmType = params.alarmType ?? DEFAULT_ALARM_VIDEO_SEARCH_ALARM_TYPES;
  const eventAlarmTypes =
    params.eventAlarmTypes ?? DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
<channelId>${params.channel}</channelId>
<uid>${xmlEscape(params.uid)}</uid>
<logicChnBitmap>${params.logicChnBitmap ?? 255}</logicChnBitmap>
<streamType>${params.streamType ?? 0}</streamType>
<notSearchVideo>${params.notSearchVideo ?? 0}</notSearchVideo>
${xmlDateTimePayload("startTime", params.start, params.timeZone)}
${xmlDateTimePayload("endTime", params.end, params.timeZone)}
<alarmType>${xmlEscape(alarmType)}</alarmType>${itemList("eventAlarmType", eventAlarmTypes)}
</findAlarmVideo>
</body>`;
};

/**
 * The body of a 273 get AND of a 274 close — byte-identical in the capture,
 * so one builder serves both.
 */
export const buildFindAlarmVideoPageXml = (params: {
  channel: number;
  fileHandle: number;
}): string =>
  `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
<channelId>${params.channel}</channelId>
<fileHandle>${params.fileHandle}</fileHandle>
</findAlarmVideo>
</body>`;

const int = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
};

const bool = (s: string | undefined): boolean | undefined =>
  s === undefined ? undefined : s.trim() === "1";

/**
 * Parse the 272 reply. Throws when the envelope is missing — an empty body
 * is what an unsupported firmware answers, and that must not read as
 * "handle 0".
 */
export const parseFindAlarmVideoHandle = (
  xml: string,
): AlarmVideoSearchHandle => {
  const envelope = getXmlBlocks(xml, "findAlarmVideo")[0];
  if (envelope === undefined) {
    throw new Error("findAlarmVideo: open reply carries no <findAlarmVideo>");
  }
  const fileHandle = int(getXmlText(envelope, "fileHandle"));
  if (fileHandle === undefined) {
    throw new Error("findAlarmVideo: open reply carries no <fileHandle>");
  }
  return { channelId: int(getXmlText(envelope, "channelId")) ?? 0, fileHandle };
};

/** Parse one 273 page. */
export const parseAlarmVideoPageXml = (
  xml: string,
  options?: { timeZone?: string },
): AlarmVideoPage => {
  const envelope = getXmlBlocks(xml, "alarmVideoInfo")[0];
  if (envelope === undefined) {
    throw new Error("findAlarmVideo: page reply carries no <alarmVideoInfo>");
  }
  const timeZone = options?.timeZone;
  const finished = bool(getXmlText(envelope, "bFinished"));
  const windows: AlarmVideoWindow[] = [];
  for (const row of getXmlBlocks(envelope, "alarmVideo")) {
    const fileName = (getXmlText(row, "fileName") ?? "").trim();
    if (!fileName) continue;
    const alarmType = (getXmlText(row, "alarmType") ?? "").trim();
    const start = getXmlBlocks(row, "startTime")[0];
    const end = getXmlBlocks(row, "endTime")[0];
    const startTime = start
      ? parseXmlDateTimeBlock(start, timeZone)
      : undefined;
    const endTime = end ? parseXmlDateTimeBlock(end, timeZone) : undefined;
    const fileId = getXmlText(row, "fileId");
    const uid = getXmlText(row, "uid")?.trim();
    const logicChn = int(getXmlText(row, "logicChn"));
    const hasRecFile = bool(getXmlText(row, "bHasRecFile"));
    const deleted = bool(getXmlText(row, "bDeleted"));
    windows.push({
      fileName,
      alarmType,
      alarmTypes: alarmType
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      encrypted: bool(getXmlText(row, "bEncrypted")) ?? false,
      ...(fileId !== undefined ? { fileId } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      ...(uid !== undefined && uid.length > 0 ? { uid } : {}),
      ...(logicChn !== undefined ? { logicChn } : {}),
      ...(hasRecFile !== undefined ? { hasRecFile } : {}),
      ...(deleted !== undefined ? { deleted } : {}),
    });
  }
  return {
    channelId: int(getXmlText(envelope, "channelId")) ?? 0,
    fileHandle: int(getXmlText(envelope, "fileHandle")) ?? 0,
    ...(finished !== undefined ? { finished } : {}),
    windows,
  };
};

export interface SearchAlarmVideosLowLevelParams
  extends BuildFindAlarmVideoOpenParams {
  sendXml: SendXmlLike;
  /**
   * Bound on the paging loop. One busy standalone day needed 145 pages, so
   * the default upstairs is generous; the bound still exists because a
   * firmware that never sets `bFinished` must not spin forever.
   */
  maxPages: number;
  timeoutMs?: number;
}

/**
 * Open → page → close, with the handle closed in a `finally` so an error on
 * any page still releases it.
 */
export const searchAlarmVideosViaFindAlarmVideo = async (
  params: SearchAlarmVideosLowLevelParams,
): Promise<AlarmVideoWindow[]> => {
  const timeoutMs = params.timeoutMs ?? 15_000;
  const extensionXml = buildFindAlarmVideoExtensionXml(params.channel);
  const openXml = buildFindAlarmVideoOpenXml(params);

  // The header channelId is a message counter in every app capture, so the
  // channel is named by the Extension and NOT by `sendXml`'s `channel`
  // (which would rewrite the header to channel+1 — the mistake cmd 14/15/16
  // documents).
  const openResp = await params.sendXml({
    cmdId: BC_CMD_ID_FIND_ALARM_VIDEO_OPEN,
    extensionXml,
    payloadXml: openXml,
    timeoutMs,
  });
  const { fileHandle } = parseFindAlarmVideoHandle(openResp);

  const pageXml = buildFindAlarmVideoPageXml({
    channel: params.channel,
    fileHandle,
  });
  const windows: AlarmVideoWindow[] = [];

  try {
    for (let i = 0; i < params.maxPages; i++) {
      let resp: string;
      try {
        resp = await params.sendXml({
          cmdId: BC_CMD_ID_FIND_ALARM_VIDEO_GET,
          extensionXml,
          payloadXml: pageXml,
          timeoutMs,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("responseCode 400, empty body")) break;
        throw e;
      }
      const page = parseAlarmVideoPageXml(
        resp,
        params.timeZone !== undefined
          ? { timeZone: params.timeZone }
          : undefined,
      );
      windows.push(...page.windows);
      // Only an explicit `bFinished 1` ends the search. `bFinished` was
      // present on every captured page (0 on the 30-row pages, 1 on the
      // 27-row last page and on the hub's single 29-row page), so an absent
      // flag is an unknown firmware: stop on an empty page rather than
      // guessing a page size.
      if (page.finished === true) break;
      if (page.finished === undefined && page.windows.length === 0) break;
    }
  } finally {
    try {
      await params.sendXml({
        cmdId: BC_CMD_ID_FIND_ALARM_VIDEO_CLOSE,
        extensionXml,
        payloadXml: pageXml,
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    } catch {
      // A close that fails leaves the handle to the firmware's own reaper;
      // it must never mask the error that brought us here.
    }
  }

  return windows;
};
