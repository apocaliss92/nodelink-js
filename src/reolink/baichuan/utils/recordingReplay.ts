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
 * Some firmwares want a stop <name> like: 01YYYYMMDDHHMMSS (derived from Rec*_YYYYMMDD_HHMMSS).
 * If the caller already has a 01xxxxxxxxxxxxxx name, keep it.
 */
export const buildReplayStopNameFromFileName = (
  fileName: string,
): string | undefined => {
  const trimmed = (fileName ?? "").trim();
  if (/^01\d{14}$/.test(trimmed)) return trimmed;
  const start = parseRecStartParamIfPresent(fileName);
  if (!start) return undefined;
  return `01${start}`;
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

  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${xmlCh}</channelId>
<Id>${xmlEscape(params.id)}</Id>
${params.uid ? `<uid>${xmlEscape(params.uid)}</uid>` : ""}
<supportSub>${supportSub}</supportSub>
<playSpeed>1</playSpeed>
<streamType>${xmlEscape(st)}</streamType>
${iframeXml}
</FileInfo>
</FileInfoList>
</body>`;
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

  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${xmlCh}</channelId>
<name>${xmlEscape(params.name)}</name>
<fileName>${xmlEscape(params.name)}</fileName>
<Id>${xmlEscape(params.name)}</Id>
${params.uid ? `<uid>${xmlEscape(params.uid)}</uid>` : ""}
<supportSub>${supportSub}</supportSub>
<playSpeed>1</playSpeed>
<streamType>${xmlEscape(st)}</streamType>
${iframeXml}
</FileInfo>
</FileInfoList>
</body>`;
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
