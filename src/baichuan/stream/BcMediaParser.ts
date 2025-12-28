/**
 * BcMedia Parser - Parses Baichuan media packets (video/audio frames)
 * Based on neolink crates/core/src/bcmedia/*
 * 
 * BcMedia packets have magic headers that identify the packet type:
 * - InfoV1: 0x31303031
 * - InfoV2: 0x32303031
 * - IFrame: 0x63643030 - 0x63643039 (includes channel number)
 * - PFrame: 0x63643130 - 0x63643139 (includes channel number)
 * - AAC: 0x62773530
 * - ADPCM: 0x62773130
 */

export type BcMediaType = "InfoV1" | "InfoV2" | "Iframe" | "Pframe" | "Aac" | "Adpcm";

export interface BcMediaIframe {
  type: "Iframe";
  videoType: "H264" | "H265";
  microseconds: number;
  time?: number;
  data: Buffer; // Raw video data (H.264/H.265 NAL units)
}

export interface BcMediaPframe {
  type: "Pframe";
  videoType: "H264" | "H265";
  microseconds: number;
  data: Buffer; // Raw video data (H.264/H.265 NAL units)
}

export interface BcMediaInfoV1 {
  type: "InfoV1";
  videoWidth: number;
  videoHeight: number;
  fps: number;
  startYear: number;
  startMonth: number;
  startDay: number;
  startHour: number;
  startMin: number;
  startSeconds: number;
  endYear: number;
  endMonth: number;
  endDay: number;
  endHour: number;
  endMin: number;
  endSeconds: number;
}

export interface BcMediaInfoV2 {
  type: "InfoV2";
  videoWidth: number;
  videoHeight: number;
  fps: number;
  startYear: number;
  startMonth: number;
  startDay: number;
  startHour: number;
  startMin: number;
  startSeconds: number;
  endYear: number;
  endMonth: number;
  endDay: number;
  endHour: number;
  endMin: number;
  endSeconds: number;
}

export interface BcMediaAac {
  type: "Aac";
  data: Buffer; // Raw AAC audio data
}

export interface BcMediaAdpcm {
  type: "Adpcm";
  data: Buffer; // Raw ADPCM audio data
}

export type BcMedia = BcMediaIframe | BcMediaPframe | BcMediaInfoV1 | BcMediaInfoV2 | BcMediaAac | BcMediaAdpcm;

// Magic headers (u32 little-endian)
const MAGIC_INFO_V1 = 0x31303031;
const MAGIC_INFO_V2 = 0x32303031;
const MAGIC_IFRAME_START = 0x63643030; // "cd00"
const MAGIC_IFRAME_END = 0x63643039; // "cd09"
const MAGIC_PFRAME_START = 0x63643130; // "cd10"
const MAGIC_PFRAME_END = 0x63643139; // "cd19"
const MAGIC_AAC = 0x62773530; // "bw50"
const MAGIC_ADPCM = 0x62773130; // "bw10"

const PAD_SIZE = 8; // Media packets use 8 byte padding

/**
 * Parse BcMedia packet from binary data.
 * Based on neolink crates/core/src/bcmedia/de.rs
 */
export function parseBcMedia(buf: Buffer): { media: BcMedia; consumed: number } | null {
  if (buf.length < 4) return null;

  const magic = buf.readUInt32LE(0);

  // Check magic header
  if (magic === MAGIC_INFO_V1) {
    return parseInfoV1(buf);
  } else if (magic === MAGIC_INFO_V2) {
    return parseInfoV2(buf);
  } else if (magic >= MAGIC_IFRAME_START && magic <= MAGIC_IFRAME_END) {
    return parseIframe(buf);
  } else if (magic >= MAGIC_PFRAME_START && magic <= MAGIC_PFRAME_END) {
    return parsePframe(buf);
  } else if (magic === MAGIC_AAC) {
    return parseAac(buf);
  } else if (magic === MAGIC_ADPCM) {
    return parseAdpcm(buf);
  }

  return null;
}

function parseInfoV1(buf: Buffer): { media: BcMediaInfoV1; consumed: number } | null {
  if (buf.length < 32) return null;

  const headerSize = buf.readUInt32LE(4);
  if (headerSize !== 32) return null;

  const media: BcMediaInfoV1 = {
    type: "InfoV1",
    videoWidth: buf.readUInt32LE(8),
    videoHeight: buf.readUInt32LE(12),
    fps: buf.readUInt8(17),
    startYear: buf.readUInt8(18),
    startMonth: buf.readUInt8(19),
    startDay: buf.readUInt8(20),
    startHour: buf.readUInt8(21),
    startMin: buf.readUInt8(22),
    startSeconds: buf.readUInt8(23),
    endYear: buf.readUInt8(24),
    endMonth: buf.readUInt8(25),
    endDay: buf.readUInt8(26),
    endHour: buf.readUInt8(27),
    endMin: buf.readUInt8(28),
    endSeconds: buf.readUInt8(29),
  };

  return { media, consumed: 32 };
}

function parseInfoV2(buf: Buffer): { media: BcMediaInfoV2; consumed: number } | null {
  if (buf.length < 32) return null;

  const headerSize = buf.readUInt32LE(4);
  if (headerSize !== 32) return null;

  const media: BcMediaInfoV2 = {
    type: "InfoV2",
    videoWidth: buf.readUInt32LE(8),
    videoHeight: buf.readUInt32LE(12),
    fps: buf.readUInt8(17),
    startYear: buf.readUInt8(18),
    startMonth: buf.readUInt8(19),
    startDay: buf.readUInt8(20),
    startHour: buf.readUInt8(21),
    startMin: buf.readUInt8(22),
    startSeconds: buf.readUInt8(23),
    endYear: buf.readUInt8(24),
    endMonth: buf.readUInt8(25),
    endDay: buf.readUInt8(26),
    endHour: buf.readUInt8(27),
    endMin: buf.readUInt8(28),
    endSeconds: buf.readUInt8(29),
  };

  return { media, consumed: 32 };
}

function parseIframe(buf: Buffer): { media: BcMediaIframe; consumed: number } | null {
  if (buf.length < 20) return null;

  // Magic (4) + "H264"/"H265" (4) = 8 bytes minimum
  const videoTypeStr = buf.toString("utf8", 4, 8);
  if (videoTypeStr !== "H264" && videoTypeStr !== "H265") return null;

  const videoType = videoTypeStr as "H264" | "H265";
  const payloadSize = buf.readUInt32LE(8);
  const additionalHeaderSize = buf.readUInt32LE(12);
  const microseconds = buf.readUInt32LE(16);

  // Calculate total size: magic(4) + videoType(4) + payloadSize(4) + additionalHeaderSize(4) + microseconds(4) + unknown(4) + additionalHeader + payload + padding
  let offset = 20; // magic(4) + videoType(4) + payloadSize(4) + additionalHeaderSize(4) + microseconds(4)
  const unknown = buf.readUInt32LE(offset);
  offset += 4;

  let time: number | undefined;
  if (additionalHeaderSize >= 4) {
    time = buf.readUInt32LE(offset);
    offset += 4;
  }

  // Skip remaining additional header
  if (additionalHeaderSize > 4) {
    offset += additionalHeaderSize - 4;
  }

  // Read payload data
  if (buf.length < offset + payloadSize) return null;
  const data = buf.subarray(offset, offset + payloadSize);
  offset += payloadSize;

  // Skip padding (8-byte aligned)
  const padSize = payloadSize % PAD_SIZE === 0 ? 0 : PAD_SIZE - (payloadSize % PAD_SIZE);
  if (buf.length < offset + padSize) return null;
  offset += padSize;

  const media: BcMediaIframe = {
    type: "Iframe",
    videoType,
    microseconds,
    ...(time !== undefined ? { time } : {}),
    data,
  };

  return { media, consumed: offset };
}

function parsePframe(buf: Buffer): { media: BcMediaPframe; consumed: number } | null {
  if (buf.length < 20) return null;

  // Magic (4) + "H264"/"H265" (4) = 8 bytes minimum
  const videoTypeStr = buf.toString("utf8", 4, 8);
  if (videoTypeStr !== "H264" && videoTypeStr !== "H265") return null;

  const videoType = videoTypeStr as "H264" | "H265";
  const payloadSize = buf.readUInt32LE(8);
  const additionalHeaderSize = buf.readUInt32LE(12);
  const microseconds = buf.readUInt32LE(16);

  // Calculate total size
  let offset = 20; // magic(4) + videoType(4) + payloadSize(4) + additionalHeaderSize(4) + microseconds(4)
  const unknown = buf.readUInt32LE(offset);
  offset += 4;

  // Skip additional header
  if (buf.length < offset + additionalHeaderSize) return null;
  offset += additionalHeaderSize;

  // Read payload data
  if (buf.length < offset + payloadSize) return null;
  const data = buf.subarray(offset, offset + payloadSize);
  offset += payloadSize;

  // Skip padding (8-byte aligned)
  const padSize = payloadSize % PAD_SIZE === 0 ? 0 : PAD_SIZE - (payloadSize % PAD_SIZE);
  if (buf.length < offset + padSize) return null;
  offset += padSize;

  const media: BcMediaPframe = {
    type: "Pframe",
    videoType,
    microseconds,
    data,
  };

  return { media, consumed: offset };
}

function parseAac(buf: Buffer): { media: BcMediaAac; consumed: number } | null {
  if (buf.length < 12) return null;

  const payloadSize = buf.readUInt16LE(4);
  const payloadSizeB = buf.readUInt16LE(6);

  if (payloadSize !== payloadSizeB) return null;

  if (buf.length < 8 + payloadSize) return null;
  const data = buf.subarray(8, 8 + payloadSize);

  const media: BcMediaAac = {
    type: "Aac",
    data,
  };

  return { media, consumed: 8 + payloadSize };
}

function parseAdpcm(buf: Buffer): { media: BcMediaAdpcm; consumed: number } | null {
  if (buf.length < 10) return null;

  const payloadSize = buf.readUInt16LE(4);
  const payloadSizeB = buf.readUInt16LE(6);

  if (payloadSize !== payloadSizeB) return null;

  // Check for MAGIC_HEADER_BCMEDIA_ADPCM_DATA (0x0100)
  const magicData = buf.readUInt16LE(8);
  if (magicData !== 0x0100) return null;

  if (buf.length < 10 + payloadSize) return null;
  const data = buf.subarray(10, 10 + payloadSize);

  const media: BcMediaAdpcm = {
    type: "Adpcm",
    data,
  };

  return { media, consumed: 10 + payloadSize };
}

