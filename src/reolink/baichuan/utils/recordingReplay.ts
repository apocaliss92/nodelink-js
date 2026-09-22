import { xmlEscape } from "../../../protocol/xml";

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
