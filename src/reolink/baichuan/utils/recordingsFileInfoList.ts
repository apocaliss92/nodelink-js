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

/**
 * Build XML for FileInfoList OPEN for file download (cmdId=14).
 * This is different from listing - it opens a file for binary data retrieval.
 */
export const buildFileInfoListDownloadOpenXml = (params: {
  uid: string;
  channel: number;
  fileName: string;
}): string => {
  const name = params.fileName.split("/").filter(Boolean).at(-1) ?? params.fileName;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<uid>${xmlEscape(params.uid)}</uid>
<channelId>${params.channel}</channelId>
<fileName>${xmlEscape(params.fileName)}</fileName>
<name>${xmlEscape(name)}</name>
<Id>${xmlEscape(params.fileName)}</Id>
</FileInfo>
</FileInfoList>
</body>`;
};

/**
 * Build XML for FileInfoList GET/CLOSE for file download (cmdId=15/16).
 */
export const buildFileInfoListDownloadPageXml = (params: {
  uid: string;
  channel: number;
  handle: number;
}): string => {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${params.channel}</channelId>
<uid>${xmlEscape(params.uid)}</uid>
<handle>${params.handle}</handle>
</FileInfo>
</FileInfoList>
</body>`;
};

export type SendBinaryLike = (params: {
  cmdId: number;
  channel?: number;
  payloadXml?: string;
  timeoutMs?: number;
}) => Promise<Buffer>;

/**
 * Download a recording using the paged FileInfoList method (cmdId=14 OPEN, 15 GET, 16 CLOSE).
 * This is observed in PCAP for TrackMix PoE cameras where cmdId=5/13 return empty.
 */
export const downloadRecordingViaFileInfoListPaged = async (params: {
  sendXml: SendXmlLike;
  sendBinary: SendBinaryLike;
  channel: number;
  uid: string;
  fileName: string;
  maxIterations?: number;
  timeoutMs?: number;
}): Promise<Buffer> => {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const maxIterations = params.maxIterations ?? 1000;

  const openXml = buildFileInfoListDownloadOpenXml({
    uid: params.uid,
    channel: params.channel,
    fileName: params.fileName,
  });

  // OPEN the file (cmdId=14)
  const openResp = await params.sendXml({
    cmdId: BC_CMD_ID_FILE_INFO_LIST_OPEN,
    payloadXml: openXml,
    timeoutMs,
  });

  const handle = parseFileInfoListHandle(openResp);

  const pageXml = buildFileInfoListDownloadPageXml({
    channel: params.channel,
    uid: params.uid,
    handle,
  });

  const chunks: Buffer[] = [];

  try {
    for (let i = 0; i < maxIterations; i++) {
      let resp: Buffer;
      try {
        // GET data chunk (cmdId=15) - returns binary data
        resp = await params.sendBinary({
          cmdId: BC_CMD_ID_FILE_INFO_LIST_GET,
          payloadXml: pageXml,
          timeoutMs,
        });
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        // 400 or empty response = end of data
        if (errorMsg.includes("responseCode 400") || errorMsg.includes("empty")) break;
        throw e;
      }

      if (resp.length === 0) break;
      chunks.push(resp);

      // Check if this is the last chunk (smaller than expected)
      // Typical chunks are 26KB+, a smaller chunk indicates end
      if (resp.length < 10000) break;
    }
  } finally {
    try {
      // CLOSE the file (cmdId=16)
      await params.sendXml({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_CLOSE,
        payloadXml: pageXml,
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    } catch {
      // ignore close errors
    }
  }

  return Buffer.concat(chunks);
};
