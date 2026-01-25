import {
  BC_CMD_ID_FILE_INFO_LIST_CLOSE,
  BC_CMD_ID_FILE_INFO_LIST_GET,
  BC_CMD_ID_FILE_INFO_LIST_OPEN,
} from "../../../protocol/constants";
import { getXmlText, xmlEscape } from "../../../protocol/xml";
import type { RecordingFile, RecordingStreamType } from "../types";
import { parseRecordingFilesFromXml } from "../xmlUtils";
import { xmlDateTimePayload } from "./recordings";

export type SendXmlLike = (params: {
  cmdId: number;
  channel?: number;
  payloadXml?: string;
  timeoutMs?: number;
}) => Promise<string>;

export const buildFileInfoListOpenXml = (params: {
  uid: string;
  channel: number;
  streamType: RecordingStreamType;
  recordType: string;
  start: Date;
  end: Date;
}): string => {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<uid>${xmlEscape(params.uid)}</uid>
<searchAITrack>1</searchAITrack>
<channelId>${params.channel}</channelId>
<logicChnBitmap>255</logicChnBitmap>
<streamType>${xmlEscape(params.streamType)}</streamType>
<recordType>${xmlEscape(params.recordType)}</recordType>
${xmlDateTimePayload("startTime", params.start)}
${xmlDateTimePayload("endTime", params.end)}
</FileInfo>
</FileInfoList>
</body>`;
};

export const buildFileInfoListPageXml = (params: {
  channel: number;
  uid: string;
  handle: number;
}): string => {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${params.channel}</channelId>
<uid>${xmlEscape(params.uid)}</uid>
<searchAITrack>1</searchAITrack>
<handle>${params.handle}</handle>
</FileInfo>
</FileInfoList>
</body>`;
};

export const parseFileInfoListHandle = (openRespXml: string): number => {
  const handleText = getXmlText(openRespXml, "handle");
  if (!handleText) throw new Error("FileInfoList open did not return <handle>");

  const handle = Number.parseInt(handleText, 10);
  if (!Number.isFinite(handle)) {
    throw new Error(`FileInfoList open returned invalid handle: ${handleText}`);
  }

  return handle;
};

export const dedupeRecordingFiles = (
  files: RecordingFile[],
): RecordingFile[] => {
  const seen = new Set<string>();
  return files.filter((f) => {
    if (seen.has(f.fileName)) return false;
    seen.add(f.fileName);
    return true;
  });
};

export const listRecordingsViaFileInfoList = async (params: {
  sendXml: SendXmlLike;
  channel: number;
  uid: string;
  streamType: RecordingStreamType;
  recordType: string;
  start: Date;
  end: Date;
  maxIterations: number;
  timeoutMs?: number;
}): Promise<RecordingFile[]> => {
  const timeoutMs = params.timeoutMs ?? 15_000;

  const openXml = buildFileInfoListOpenXml({
    uid: params.uid,
    channel: params.channel,
    streamType: params.streamType,
    recordType: params.recordType,
    start: params.start,
    end: params.end,
  });

  // NOTE: For FileInfoList, we do NOT pass channel to sendXml for header calculation.
  // The channel is only passed inside the XML payload (<channelId>).
  // Passing channel causes channelId=channel+1 in the Baichuan header, which NVRs reject (400).
  // Without channel, sendXml uses hostChannelId (250) which is correct.
  const openResp = await params.sendXml({
    cmdId: BC_CMD_ID_FILE_INFO_LIST_OPEN,
    // channel is NOT passed here - only in XML payload
    payloadXml: openXml,
    timeoutMs,
  });

  const handle = parseFileInfoListHandle(openResp);

  const pageXml = buildFileInfoListPageXml({
    channel: params.channel,
    uid: params.uid,
    handle,
  });

  const files: RecordingFile[] = [];
  const TYPICAL_PAGE_SIZE = 40;

  try {
    for (let i = 0; i < params.maxIterations; i++) {
      let resp: string;
      try {
        resp = await params.sendXml({
          cmdId: BC_CMD_ID_FILE_INFO_LIST_GET,
          // channel is NOT passed here - only in XML payload
          payloadXml: pageXml,
          timeoutMs,
        });
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        if (errorMsg.includes("responseCode 400, empty body")) break;
        throw e;
      }

      const pageFiles = parseRecordingFilesFromXml(resp);
      files.push(...pageFiles);

      const bFinishedText =
        getXmlText(resp, "bFinished") ?? getXmlText(resp, "finished");
      if (bFinishedText != null) {
        if (bFinishedText.trim() === "1") break;
      } else if (
        pageFiles.length === 0 ||
        pageFiles.length < TYPICAL_PAGE_SIZE
      ) {
        break;
      }
    }
  } finally {
    try {
      await params.sendXml({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_CLOSE,
        // channel is NOT passed here - only in XML payload
        payloadXml: pageXml,
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    } catch {
      // ignore
    }
  }

  return files;
};
