import { xmlEscape } from "../../../protocol/xml";
import type { WallClockParts } from "./wallClock";

export type RecordingReplayStreamType = "mainStream" | "subStream";
export type RecordingReplayIFrameMode = "b" | "i" | "both" | true | false;

export const parseRecStartParamIfPresent = (
  fileName: string,
): string | undefined => {
  const m = /Rec(\w{3})(?:_|_DST)(\d{8})_(\d{6})_.*/.exec(fileName);
  if (!m) return undefined;
  return `${m[2]}${m[3]}`;
};

/**
 * The name of the replay session to stop: `CCYYYYMMDDHHMMSS`, where `CC` is the
 * two-digit 1-based channel and the rest is the recording's start instant.
 *
 * Measured off the Reolink app. Standalone (capture 2026-09-22): eleven cmd 7
 * stops, every one `01` + the `Rec*_YYYYMMDD_HHMMSS` start of the file being
 * replayed. Hub (capture 2026-09-20): the same shape, but the SECOND child —
 * XML `<channelId>1</channelId>`, file under `…-Videocamera porta retro/` —
 * was stopped with `0220260918181308`, while the first child's stops were
 * `01…`. The prefix is the channel, not a constant.
 *
 * If the caller already holds a `CCxxxxxxxxxxxxxx` name, it is kept as-is.
 */
export const buildReplayStopNameFromFileName = (
  fileName: string,
  channel = 0,
): string | undefined => {
  const trimmed = (fileName ?? "").trim();
  if (/^\d{2}\d{14}$/.test(trimmed)) return trimmed;
  const start = parseRecStartParamIfPresent(fileName);
  if (!start) return undefined;
  const prefix = String(channel + 1).padStart(2, "0");
  return `${prefix}${start}`;
};

export const buildFileInfoListReplayByIdXml = (params: {
  channel: number;
  /** Optional override for the <channelId> value inside the XML payload. */
  xmlChannelId?: number;
  id: string;
  uid?: string;
  streamType?: RecordingReplayStreamType;
  iframeReplay?: RecordingReplayIFrameMode;
}): string => {
  const st = params.streamType ?? "mainStream";
  const supportSub = st === "subStream" ? 1 : 0;
  const xmlCh = params.xmlChannelId ?? params.channel;
  const iframe = params.iframeReplay;
  const iframeXml =
    iframe === true || iframe === "both"
      ? "<bIframeReplay>1</bIframeReplay><iIframeReplay>1</iIframeReplay>"
      : iframe === "b"
        ? "<bIframeReplay>1</bIframeReplay>"
        : iframe === "i"
          ? "<iIframeReplay>1</iIframeReplay>"
          : "";

  // Build the XML without empty lines when optional fields are absent.
  // PCAP analysis shows the app does NOT include <uid> for standalone cameras.
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    "<body>",
    '<FileInfoList version="1.1">',
    "<FileInfo>",
    `<channelId>${xmlCh}</channelId>`,
    `<Id>${xmlEscape(params.id)}</Id>`,
  ];
  if (params.uid) {
    lines.push(`<uid>${xmlEscape(params.uid)}</uid>`);
  }
  lines.push(
    `<supportSub>${supportSub}</supportSub>`,
    "<playSpeed>1</playSpeed>",
    `<streamType>${xmlEscape(st)}</streamType>`,
  );
  if (iframeXml) {
    lines.push(iframeXml);
  }
  lines.push("</FileInfo>", "</FileInfoList>", "</body>");
  return lines.join("\n");
};

export const buildFileInfoListReplayByNameXml = (params: {
  channel: number;
  /** Optional override for the <channelId> value inside the XML payload. */
  xmlChannelId?: number;
  name: string;
  uid?: string;
  streamType?: RecordingReplayStreamType;
  iframeReplay?: RecordingReplayIFrameMode;
}): string => {
  const st = params.streamType ?? "mainStream";
  const supportSub = st === "subStream" ? 1 : 0;
  const xmlCh = params.xmlChannelId ?? params.channel;
  const iframe = params.iframeReplay;
  const iframeXml =
    iframe === true || iframe === "both"
      ? "<bIframeReplay>1</bIframeReplay><iIframeReplay>1</iIframeReplay>"
      : iframe === "b"
        ? "<bIframeReplay>1</bIframeReplay>"
        : iframe === "i"
          ? "<iIframeReplay>1</iIframeReplay>"
          : "";

  // Build the XML without empty lines when optional fields are absent.
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    "<body>",
    '<FileInfoList version="1.1">',
    "<FileInfo>",
    `<channelId>${xmlCh}</channelId>`,
    `<Id>${xmlEscape(params.name)}</Id>`,
  ];
  if (params.uid) {
    lines.push(`<uid>${xmlEscape(params.uid)}</uid>`);
  }
  lines.push(
    `<supportSub>${supportSub}</supportSub>`,
    "<playSpeed>1</playSpeed>",
    `<streamType>${xmlEscape(st)}</streamType>`,
  );
  if (iframeXml) {
    lines.push(iframeXml);
  }
  lines.push("</FileInfo>", "</FileInfoList>", "</body>");
  return lines.join("\n");
};

export const buildFileInfoListStopXml = (params: {
  channel: number;
  name: string;
  streamType?: RecordingReplayStreamType;
}): string => {
  const st = params.streamType ?? "mainStream";

  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${params.channel}</channelId>
<name>${xmlEscape(params.name)}</name>
<streamType>${xmlEscape(st)}</streamType>
</FileInfo>
</FileInfoList>
</body>`;
};

/**
 * The position a replay was asked for, and the position that actually ARRIVED.
 *
 * These are not the same number and a caller must never assume they are.
 * Measured 2026-09-23: asked +33 s and +34 s inside one clip, an E1 Outdoor
 * PoE (v3.1.0.5223) delivered the SAME keyframe both times (byte-identical
 * transfers), rounding UP to the next I-frame; a Home Hub child
 * (v3.3.0.456) rounded DOWN — asked +45 s, delivered +43 s. A player that
 * trusts the value it asked for drifts by up to one GOP per seek.
 */
export interface ReplaySeekOutcome {
  /** What the caller asked for, or `null` when it asked for nothing. */
  requestedAt: Date | null;
  /**
   * Where the stream really began, read back from the first I-frame's
   * wall clock. `null` when no I-frame was seen (an audio-only or truncated
   * transfer), which is not a failure — it is simply unknown.
   */
  deliveredAt: Date | null;
  /** `deliveredAt - requestedAt` in ms; `null` when either is unknown. */
  driftMs: number | null;
  /** Whether the camera accepted the `<ReplaySeek>` command at all. */
  seekApplied: boolean;
  /** Why a seek was not applied, or why the read-back is unavailable. */
  reason?: string;
}

/**
 * The widest gap we will accept between the instant asked for and the instant
 * delivered before saying so on the line.
 *
 * One GOP. Measured GOP on both probed devices is ~2 s (E1 Outdoor PoE: 38
 * I-frames across 75.61 s; Home Hub child: 33 across 65.53 s), and the two
 * round in OPPOSITE directions on the same request — so the window has to be
 * symmetric and at least a full GOP wide on each side. 3 s leaves headroom for
 * a camera configured with a longer GOP without hiding a real failure (a seek
 * the camera ignored lands at the clip start, tens of seconds away).
 */
export const REPLAY_SEEK_MAX_DRIFT_MS = 3_000;

/**
 * `<ReplaySeek>` (cmd 123) — position the NEXT replay of this channel.
 *
 * Byte-for-byte the shape the official Reolink app sends: no extension
 * (`payloadOffset` 0), `msgNum` 0, and `<seq>` a unix second. Confirmed in
 * `app/data/captures/cap-muchgow3-97ecb9` (24 occurrences, standalone) and
 * `test/fixtures/recordings/hub/replayseek-123-request.xml` (hub).
 *
 * `parts` is the CAMERA's wall clock — every Baichuan recording timestamp is,
 * with no offset on the wire. Use `wallClockParts(date, timeZone)`.
 */
export const buildReplaySeekXml = (params: {
  channel: number;
  parts: WallClockParts;
  /** Defaults to the current unix second, as the app does. */
  seq?: number;
}): string => {
  const p = params.parts;
  const seq = params.seq ?? Math.floor(Date.now() / 1000);
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<ReplaySeek version="1.1">
<channelId>${params.channel}</channelId>
<seq>${seq}</seq>
<seekTime>
<year>${p.year}</year>
<month>${p.month}</month>
<day>${p.day}</day>
<hour>${p.hour}</hour>
<minute>${p.minute}</minute>
<second>${p.second}</second>
</seekTime>
</ReplaySeek>
</body>
`;
};

const BC_IFRAME_MAGIC_MIN = 0x63643030;
const BC_IFRAME_MAGIC_MAX = 0x63643039;
/** An additional header wider than this is not one; it is a bad guess. */
const BC_MAX_ADDITIONAL_HEADER = 4096;

/**
 * The wall clock of the first I-frame in a decrypted cmd 5 chunk, or
 * `undefined` when there is none in it.
 *
 * This is the read-back that proves a seek landed. The u32 at offset 24 of a
 * BcMedia I-frame is the frame's wall clock expressed as seconds-since-epoch
 * READ IN UTC — i.e. `new Date(t * 1000)` in UTC spells the camera's local
 * time, which is the same convention as every other recording timestamp on
 * this wire (see `utils/wallClock.ts`). Verified 2026-09-23: a clip whose
 * name says `_193129_` produced a first I-frame of 1 790 105 489, and
 * `new Date(1790105489000).toISOString()` is `…T19:31:29Z`.
 */
export const readFirstIframeWallClock = (
  chunk: Buffer,
): WallClockParts | undefined => {
  const limit = chunk.length - 28;
  for (let i = 0; i <= limit; i++) {
    const magic = chunk.readUInt32LE(i);
    if (magic < BC_IFRAME_MAGIC_MIN || magic > BC_IFRAME_MAGIC_MAX) continue;
    const videoType = chunk.toString("utf8", i + 4, i + 8);
    if (videoType !== "H264" && videoType !== "H265") continue;
    const additionalHeaderSize = chunk.readUInt32LE(i + 12);
    if (additionalHeaderSize < 4 || additionalHeaderSize > BC_MAX_ADDITIONAL_HEADER)
      continue;
    const t = chunk.readUInt32LE(i + 24);
    // A plausible wall clock, not a random four bytes that survived the scan.
    if (t < 1_000_000_000 || t > 4_000_000_000) continue;
    const d = new Date(t * 1000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }
  return undefined;
};
