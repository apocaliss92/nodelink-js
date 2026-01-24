import { xmlEscape } from "../../../protocol/xml";

export type RecordingReplayStreamType = "mainStream" | "subStream";
export type RecordingReplayIFrameMode = "b" | "i" | "both" | true | false;

export const parseRecStartParamIfPresent = (fileName: string): string | undefined => {
  const m = /Rec(\w{3})(?:_|_DST)(\d{8})_(\d{6})_.*/.exec(fileName);
  if (!m) return undefined;
  return `${m[2]}${m[3]}`;
};

/**
 * Some firmwares want a stop <name> like: 01YYYYMMDDHHMMSS (derived from Rec*_YYYYMMDD_HHMMSS).
 * If the caller already has a 01xxxxxxxxxxxxxx name, keep it.
 */
export const buildReplayStopNameFromFileName = (fileName: string): string | undefined => {
  const trimmed = (fileName ?? "").trim();
  if (/^01\d{14}$/.test(trimmed)) return trimmed;
  const start = parseRecStartParamIfPresent(fileName);
  if (!start) return undefined;
  return `01${start}`;
};

export const buildFileInfoListReplayByIdXml = (params: {
  channel: number;
  id: string;
  streamType?: RecordingReplayStreamType;
  iframeReplay?: RecordingReplayIFrameMode;
}): string => {
  const st = params.streamType ?? "mainStream";
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
<channelId>${params.channel}</channelId>
<Id>${xmlEscape(params.id)}</Id>
<supportSub>0</supportSub>
<playSpeed>1</playSpeed>
<streamType>${xmlEscape(st)}</streamType>
${iframeXml}
</FileInfo>
</FileInfoList>
</body>`;
};

export const buildFileInfoListReplayByNameXml = (params: {
  channel: number;
  name: string;
  streamType?: RecordingReplayStreamType;
  iframeReplay?: RecordingReplayIFrameMode;
}): string => {
  const st = params.streamType ?? "mainStream";
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
<channelId>${params.channel}</channelId>
<name>${xmlEscape(params.name)}</name>
<supportSub>0</supportSub>
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
