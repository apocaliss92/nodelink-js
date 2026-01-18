import { BC_CLASS_FILE_DOWNLOAD, BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD } from "../../../protocol/constants";
import { buildBinaryExtensionXml, xmlEscape } from "../../../protocol/xml";

export const getRecordingNameFromFileName = (fileName: string): string => {
  if (!fileName.includes("/")) return fileName;
  return fileName.split("/").filter(Boolean).at(-1) ?? fileName;
};

export const buildFileInfoListDownloadXml = (params: { channel: number; uid: string; fileName: string }): string => {
  const name = getRecordingNameFromFileName(params.fileName);

  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${params.channel}</channelId>
<uid>${xmlEscape(params.uid)}</uid>
<fileName>${xmlEscape(params.fileName)}</fileName>
<name>${xmlEscape(name)}</name>
<Id>${xmlEscape(params.fileName)}</Id>
</FileInfo>
</FileInfoList>
</body>`;
};

export const sanitizeDownloadFilename = (fileName: string): string => {
  return fileName.replaceAll("/", "_").replaceAll("\\", "_");
};

export const buildHttpVodSourceCandidates = (fileName: string): string[] => {
  const out: string[] = [];
  const pushUnique = (s: string | undefined) => {
    const v = s?.trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };

  pushUnique(fileName);
  pushUnique(fileName.replace(/^\/mnt\/[a-zA-Z0-9]+\//, ""));
  pushUnique(fileName.replace(/^\//, ""));

  return out;
};

export const parseRecStartParamIfPresent = (fileName: string): string | undefined => {
  const m = /Rec(\w{3})(?:_|_DST)(\d{8})_(\d{6})_.*/.exec(fileName);
  if (!m) return undefined;
  return `${m[2]}${m[3]}`;
};

export type SendBinaryLike = (params: {
  cmdId: number;
  channel?: number;
  messageClass?: number;
  extensionXml?: string;
  payloadXml?: string;
  timeoutMs?: number;
}) => Promise<Buffer>;

export const downloadRecordingViaFileInfoList = async (params: {
  sendBinary: SendBinaryLike;
  channel: number;
  uid: string;
  fileName: string;
  timeoutMs?: number;
}): Promise<Buffer> => {
  const payloadXml = buildFileInfoListDownloadXml({
    channel: params.channel,
    uid: params.uid,
    fileName: params.fileName,
  });

  return await params.sendBinary({
    cmdId: BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
    channel: params.channel,
    messageClass: BC_CLASS_FILE_DOWNLOAD,
    extensionXml: buildBinaryExtensionXml(params.channel),
    payloadXml,
    timeoutMs: params.timeoutMs ?? 120_000,
  });
};
