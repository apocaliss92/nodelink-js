import { getXmlText } from "../../protocol/xml";
import type { RecordingFile } from "./types";
import { parseRecordingFileName } from "./recordingFileName";

type TalkAbility = import("./types").TalkAbility;
type TalkAudioConfig = import("./types").TalkAudioConfig;

export const getXmlTexts = <T extends string>(xml: string, tags: readonly T[]): Partial<Record<T, string>> => {
  const out: Partial<Record<T, string>> = {};
  for (const tag of tags) {
    const v = getXmlText(xml, tag);
    if (v !== undefined) out[tag] = v;
  }
  return out;
};

export const getXmlBlocks = (xml: string, tagName: string): string[] => {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "g");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(xml))) {
    out.push(match[1] ?? "");
  }
  return out;
};

export const parseXmlDateTimeBlock = (block: string): Date | undefined => {
  const year = Number.parseInt(getXmlText(block, "year") ?? "", 10);
  const month = Number.parseInt(getXmlText(block, "month") ?? "", 10);
  const day = Number.parseInt(getXmlText(block, "day") ?? "", 10);
  const hour = Number.parseInt(getXmlText(block, "hour") ?? "", 10);
  const minute = Number.parseInt(getXmlText(block, "minute") ?? "", 10);
  const second = Number.parseInt(getXmlText(block, "second") ?? "", 10);

  if ([year, month, day, hour, minute, second].every(Number.isFinite)) {
    // Treat as UTC to avoid timezone shifts when serializing to JSON.
    // Camera timestamps are typically in local time, but we parse as UTC to preserve
    // the exact values without timezone conversion artifacts.
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }

  // Some firmwares encode the timestamp as plain text instead of nested tags.
  const text = block.replace(/<[^>]*>/g, "").trim();
  const m = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return undefined;
  const y = Number.parseInt(m[1] ?? "", 10);
  const mo = Number.parseInt(m[2] ?? "", 10);
  const da = Number.parseInt(m[3] ?? "", 10);
  const ho = Number.parseInt(m[4] ?? "0", 10);
  const mi = Number.parseInt(m[5] ?? "0", 10);
  const se = Number.parseInt(m[6] ?? "0", 10);
  if (![y, mo, da, ho, mi, se].every(Number.isFinite)) return undefined;
  return new Date(Date.UTC(y, mo - 1, da, ho, mi, se));
};

export const parseRecordingFilesFromXml = (xml: string): RecordingFile[] => {
  const out: RecordingFile[] = [];

  // FileInfoList commonly returns <FileInfo> blocks with <name> and/or <Id>.
  const fileInfoBlocks = getXmlBlocks(xml, "FileInfo");
  for (const b of fileInfoBlocks) {
    const id = getXmlText(b, "Id") ?? getXmlText(b, "ID") ?? getXmlText(b, "id");
    const name = getXmlText(b, "name") ?? getXmlText(b, "fileName");
    const chosen = (id ?? name)?.trim();
    if (!chosen) continue;

    const item: RecordingFile = { fileName: chosen };
    if (name != null && name.trim()) item.name = name.trim();
    if (id != null && id.trim()) item.id = id.trim();

    const recordType = getXmlText(b, "type") ?? getXmlText(b, "recordType") ?? getXmlText(b, "alarmType");
    if (recordType != null) item.recordType = recordType;

    const sizeText = getXmlText(b, "size") ?? getXmlText(b, "fileSize");
    const sizeBytes = sizeText ? Number.parseInt(sizeText, 10) : undefined;
    if (sizeBytes != null && Number.isFinite(sizeBytes)) item.sizeBytes = sizeBytes;

    const start = getXmlBlocks(b, "startTime")[0];
    const end = getXmlBlocks(b, "endTime")[0];
    const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
    const endDt = end ? parseXmlDateTimeBlock(end) : undefined;
    if (startDt) item.startTime = startDt;
    if (endDt) item.endTime = endDt;

    const parsed = parseRecordingFileName(item.name ?? item.fileName);
    if (parsed) {
      item.parsedFileName = parsed;
      if (!item.startTime) item.startTime = parsed.start;
      if (!item.endTime) item.endTime = parsed.end;
    }

    out.push(item);
  }

  // Preferred: parse <File> blocks.
  const fileBlocks = getXmlBlocks(xml, "File");
  for (const b of fileBlocks) {
    const fileName = (getXmlText(b, "fileName") ?? getXmlText(b, "name"))?.trim();
    if (!fileName) continue;

    const sizeText = getXmlText(b, "size") ?? getXmlText(b, "fileSize");
    const sizeBytes = sizeText ? Number.parseInt(sizeText, 10) : undefined;
    const recordType = getXmlText(b, "type") ?? getXmlText(b, "recordType") ?? getXmlText(b, "alarmType");

    const start = getXmlBlocks(b, "startTime")[0];
    const end = getXmlBlocks(b, "endTime")[0];

    const item: RecordingFile = { fileName };
    if (sizeBytes != null && Number.isFinite(sizeBytes)) item.sizeBytes = sizeBytes;
    if (recordType != null) item.recordType = recordType;

    const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
    const endDt = end ? parseXmlDateTimeBlock(end) : undefined;
    if (startDt) item.startTime = startDt;
    if (endDt) item.endTime = endDt;

    const parsed = parseRecordingFileName(item.fileName);
    if (parsed) {
      item.parsedFileName = parsed;
      if (!item.startTime) item.startTime = parsed.start;
      if (!item.endTime) item.endTime = parsed.end;
    }

    out.push(item);
  }

  // Fallback: any <fileName> tags.
  if (out.length === 0) {
    const re = /<fileName>([\s\S]*?)<\/fileName>/g;
    const seenNames = new Set<string>();
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = re.exec(xml))) {
      const fileName = (match[1] ?? "").trim();
      if (!fileName) continue;
      if (seenNames.has(fileName)) continue;
      seenNames.add(fileName);

      const item: RecordingFile = { fileName };
      const parsed = parseRecordingFileName(fileName);
      if (parsed) {
        item.parsedFileName = parsed;
        item.startTime = parsed.start;
        item.endTime = parsed.end;
      }
      out.push(item);
    }
  }

  // Alarm video list: <alarmVideo><fileName>...</fileName><alarmType>...</alarmType>...</alarmVideo>
  const alarmBlocks = getXmlBlocks(xml, "alarmVideo");
  if (alarmBlocks.length > 0) {
    const byName = new Map<string, RecordingFile>();
    for (const existing of out) {
      const key = existing.fileName.trim();
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, existing);
    }

    for (const b of alarmBlocks) {
      const fileNameRaw = getXmlText(b, "fileName") ?? getXmlText(b, "name");
      const fileName = fileNameRaw?.trim();
      if (!fileName) continue;

      const alarmType = getXmlText(b, "alarmType")?.trim();
      const start = getXmlBlocks(b, "startTime")[0];
      const end = getXmlBlocks(b, "endTime")[0];
      const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
      const endDt = end ? parseXmlDateTimeBlock(end) : undefined;

      const target = byName.get(fileName) ?? { fileName };
      if (alarmType) target.recordType = alarmType;
      if (startDt) target.startTime = startDt;
      if (endDt) target.endTime = endDt;

      if (!target.parsedFileName) {
        const parsed = parseRecordingFileName(target.fileName);
        if (parsed) {
          target.parsedFileName = parsed;
          if (!target.startTime) target.startTime = parsed.start;
          if (!target.endTime) target.endTime = parsed.end;
        }
      }

      if (!byName.has(fileName)) {
        out.push(target);
        byName.set(fileName, target);
      }
    }
  }

  // De-dup by fileName.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = f.fileName.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function parseTalkAudioConfig(block: string): TalkAudioConfig | null {
  const audioType = getXmlText(block, "audioType");
  const sampleRate = Number.parseInt(getXmlText(block, "sampleRate") ?? "", 10);
  const samplePrecision = Number.parseInt(getXmlText(block, "samplePrecision") ?? "", 10);
  const lengthPerEncoder = Number.parseInt(getXmlText(block, "lengthPerEncoder") ?? "", 10);
  const soundTrack = getXmlText(block, "soundTrack");
  const priorityText = getXmlText(block, "priority");

  if (!audioType || !Number.isFinite(sampleRate) || !Number.isFinite(samplePrecision) || !Number.isFinite(lengthPerEncoder) || !soundTrack) {
    return null;
  }

  const config: TalkAudioConfig = {
    audioType,
    sampleRate,
    samplePrecision,
    lengthPerEncoder,
    soundTrack,
  };

  if (priorityText !== undefined) {
    const pr = Number.parseInt(priorityText, 10);
    if (Number.isFinite(pr)) config.priority = pr;
  }

  return config;
}

export const parseTalkAbilityXml = (xml: string): TalkAbility => {
  const talkAbilityBlock = getXmlBlocks(xml, "TalkAbility")[0];
  if (!talkAbilityBlock) {
    throw new Error("TalkAbility XML not found in response");
  }

  const duplexListBlocks = getXmlBlocks(talkAbilityBlock, "duplexList");
  const duplexList = duplexListBlocks.map((b) => getXmlText(b, "duplex")).filter((v): v is string => Boolean(v));

  const audioStreamModeListBlocks = getXmlBlocks(talkAbilityBlock, "audioStreamModeList");
  const audioStreamModeList = audioStreamModeListBlocks.map((b) => getXmlText(b, "audioStreamMode")).filter((v): v is string => Boolean(v));

  const audioConfigBlocks = getXmlBlocks(talkAbilityBlock, "audioConfig");
  const audioConfigList = audioConfigBlocks.map(parseTalkAudioConfig).filter((v): v is TalkAudioConfig => Boolean(v));

  return {
    duplexList,
    audioStreamModeList,
    audioConfigList,
  };
};
