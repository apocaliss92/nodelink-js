import type { ParsedRecordingFileName, RecordingDevType, RecordingVodFlags, RecordingVodStreamHint } from "./types";

type FlagSpec = Record<string, readonly [number, number]>;

const FLAGS_CAM_V2: FlagSpec = {
  resolution_index: [0, 7],
  tv_system: [7, 1],
  framerate: [8, 7],
  audio_index: [15, 2],
  ai_pd: [17, 1],
  ai_fd: [18, 1],
  ai_vd: [19, 1],
  ai_ad: [20, 1],
  encoder_type_index: [21, 2],
  is_schedule_record: [23, 1],
  is_motion_record: [24, 1],
  is_rf_record: [25, 1],
  is_doorbell_record: [26, 1],
  ai_other: [27, 1],
};

const FLAGS_HUB_V0: FlagSpec = {
  resolution_index: [0, 7],
  tv_system: [7, 1],
  framerate: [8, 7],
  audio_index: [15, 2],
  ai_pd: [17, 1],
  ai_fd: [18, 1],
  ai_vd: [19, 1],
  ai_ad: [20, 1],
  encoder_type_index: [21, 2],
  is_schedule_record: [23, 1],
  is_motion_record: [24, 1],
  is_rf_record: [25, 1],
  is_doorbell_record: [26, 1],
  is_ai_other_record: [27, 1],
  picture_layout_index: [28, 7],
  package_delivered: [35, 1],
  package_takenaway: [36, 1],
};

const FLAGS_HUB_V1: FlagSpec = {
  ...FLAGS_HUB_V0,
  package_event: [37, 1],
};

const FLAGS_HUB_V2: FlagSpec = {
  resolution_index: [0, 7],
  tv_system: [7, 1],
  framerate: [8, 7],
  audio_index: [15, 2],
  ai_pd: [17, 1],
  ai_fd: [18, 1],
  ai_vd: [19, 1],
  ai_ad: [20, 1],
  ai_other: [21, 2],
  encoder_type_index: [23, 1],
  is_schedule_record: [24, 1],
  is_motion_record: [25, 1],
  is_rf_record: [26, 1],
  is_doorbell_record: [27, 1],
  picture_layout_index: [28, 7],
  package_delivered: [35, 1],
  package_takenaway: [36, 1],
  package_event: [37, 1],
  upload_flag: [38, 1],
};

const FLAGS_MAPPING: Record<RecordingDevType, Record<number, FlagSpec>> = {
  cam: {
    2: FLAGS_CAM_V2,
    3: FLAGS_CAM_V2,
    4: FLAGS_CAM_V2,
    7: FLAGS_CAM_V2,
    9: FLAGS_CAM_V2,
    10: FLAGS_CAM_V2,
  },
  hub: {
    0: FLAGS_HUB_V0,
    1: FLAGS_HUB_V1,
    2: FLAGS_HUB_V2,
  },
};

function decodeHexToFlags(hexValue: string, mapping: FlagSpec): Record<string, number> | undefined {
  if (!hexValue) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(hexValue)) return undefined;

  const bitLen = hexValue.length * 4;
  const hexInt = BigInt(`0x${hexValue}`);
  const bin = hexInt.toString(2).padStart(bitLen, "0");
  const revBin = bin.split("").reverse().join("");
  const revInt = BigInt(`0b${revBin}`);

  const out: Record<string, number> = {};
  for (const [flag, [bitPosition, bitSize]] of Object.entries(mapping)) {
    const pos = BigInt(bitPosition);
    const size = BigInt(bitSize);
    const mask = ((1n << size) - 1n) << pos;
    const segRev = (revInt & mask) >> pos;
    const segBin = segRev.toString(2).padStart(bitSize, "0").split("").reverse().join("");
    out[flag] = Number.parseInt(segBin, 2);
  }
  return out;
}

function decodeKnownFlags(devType: RecordingDevType, version: number, hexValue: string): { raw: Record<string, number>; flags: RecordingVodFlags } | undefined {
  const versions = FLAGS_MAPPING[devType];
  const mapping = versions[version] ?? versions[Math.max(...Object.keys(versions).map((k) => Number(k)))];
  if (!mapping) return undefined;
  const raw = decodeHexToFlags(hexValue, mapping);
  if (!raw) return undefined;

  const flags: RecordingVodFlags = {
    aiPerson: raw.ai_pd === 1,
    aiVehicle: raw.ai_vd === 1,
    aiAnimal: raw.ai_ad === 1,
    aiFace: raw.ai_fd === 1,
    aiOther: (raw.is_ai_other_record === 1) || (raw.ai_other === 1) || (raw.ai_other ?? 0) > 0,
    schedule: raw.is_schedule_record === 1,
    motion: raw.is_motion_record === 1,
    rf: raw.is_rf_record === 1,
    doorbell: raw.is_doorbell_record === 1,
    package: (raw.package_event === 1) || (raw.package_delivered === 1) || (raw.package_takenaway === 1),
  };

  return { raw, flags };
}

function parseDateTimeLocal(yyyymmdd: string, hhmmss: string): Date | undefined {
  if (!/^\d{8}$/.test(yyyymmdd)) return undefined;
  if (!/^\d{6}$/.test(hhmmss)) return undefined;
  const year = Number.parseInt(yyyymmdd.slice(0, 4), 10);
  const month = Number.parseInt(yyyymmdd.slice(4, 6), 10);
  const day = Number.parseInt(yyyymmdd.slice(6, 8), 10);
  const hour = Number.parseInt(hhmmss.slice(0, 2), 10);
  const minute = Number.parseInt(hhmmss.slice(2, 4), 10);
  const second = Number.parseInt(hhmmss.slice(4, 6), 10);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return undefined;
  // Parse as UTC to avoid timezone shifts when serializing to JSON.
  // This ensures dates from filenames match the exact values without timezone conversion.
  // The camera stores timestamps in local time in the filename, but we parse as UTC to preserve
  // the exact values when comparing with other UTC dates.
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/**
 * Best-effort parse of Reolink VOD recording filenames.
 *
 * Formats observed:
 * - Mp4Record/2020-12-22/RecM01_20201222_075939_080140_<HEX>_<SIZE>.mp4
 * - Mp4Record/2023-04-26/RecS02_DST20230426_145918_150032_<HEX>_<SIZE>.mp4
 * - .../RecS07_20250219_111146_111238_0_<HEX>_<SIZE>.mp4
 * - .../RecM02_DST20240827_090302_090334_0_800_800_<HEX>_<SIZE>.mp4
 * - 0120260107000000 (numeric identifier format: [channel][YYYYMMDD][HHMMSS])
 */
export function parseRecordingFileName(fileName: string): ParsedRecordingFileName | undefined {
  // Try numeric identifier format first (e.g., "0120260107000000")
  // Format: [channel][YYYYMMDD][HHMMSS] where channel is 2 digits, date is 8 digits, time is 6 digits
  const numericMatch = /^(\d{2})(\d{8})(\d{6})$/.exec(fileName);
  if (numericMatch) {
    const channelStr = numericMatch[1];
    const dateStr = numericMatch[2];
    const timeStr = numericMatch[3];
    if (channelStr && dateStr && timeStr) {
      const start = parseDateTimeLocal(dateStr, timeStr);
      if (start) {
        // For numeric format, assume 20 second duration (common for motion detection clips)
        const end = new Date(start.getTime() + 20_000);
        return {
          baseName: fileName,
          ext: "",
          streamHint: "main",
          version: 0,
          devType: "cam",
          start,
          end,
          durationMs: 20_000,
        };
      }
    }
  }
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return undefined;
  const ext = fileName.slice(dot + 1);
  const pathNoExt = fileName.slice(0, dot);
  const baseName = pathNoExt.split("/").filter(Boolean).at(-1);
  if (!baseName) return undefined;

  const parts = baseName.split("_");
  const prefix = parts[0] ?? "";
  if (!prefix.startsWith("Rec") || prefix.length !== 6) return undefined;

  const streamChar = prefix[3];
  const streamHint: RecordingVodStreamHint = streamChar === "M" ? "main" : streamChar === "S" ? "sub" : "unknown";

  const version = Number.parseInt(prefix.slice(4, 6), 16);
  if (!Number.isFinite(version)) return undefined;

  let devType: RecordingDevType = "cam";
  let startDate = "";
  let startTime = "";
  let endTime = "";
  let animalTypeRaw: string | undefined;
  let widthRaw: string | undefined;
  let heightRaw: string | undefined;
  let hexValue = "";

  if (parts.length === 6) {
    // RecM01_20201222_075939_080140_<HEX>_<SIZE>
    startDate = parts[1] ?? "";
    startTime = parts[2] ?? "";
    endTime = parts[3] ?? "";
    hexValue = parts[4] ?? "";
  } else if (parts.length === 7) {
    // RecS07_20250219_111146_111238_0_<HEX>_<SIZE>
    startDate = parts[1] ?? "";
    startTime = parts[2] ?? "";
    endTime = parts[3] ?? "";
    animalTypeRaw = parts[4];
    hexValue = parts[5] ?? "";
  } else if (parts.length === 9) {
    // RecM02_DST20240827_090302_090334_0_800_800_<HEX>_<SIZE>
    devType = "hub";
    startDate = parts[1] ?? "";
    startTime = parts[2] ?? "";
    endTime = parts[3] ?? "";
    animalTypeRaw = parts[4];
    widthRaw = parts[5];
    heightRaw = parts[6];
    hexValue = parts[7] ?? "";
  } else {
    return undefined;
  }

  startDate = startDate.toLowerCase().replace("dst", "");
  const start = parseDateTimeLocal(startDate, startTime);
  if (!start) return undefined;
  const end = endTime === "000000" ? start : parseDateTimeLocal(startDate, endTime);
  if (!end) return undefined;

  const durationMs = Math.max(0, end.getTime() - start.getTime());

  const parsed: ParsedRecordingFileName = {
    baseName,
    ext,
    streamHint,
    version,
    devType,
    start,
    end,
    durationMs,
  };

  const decoded = decodeKnownFlags(devType, version, hexValue);
  if (decoded) {
    parsed.flags = decoded.flags;
    parsed.rawFlags = decoded.raw;
  }

  if (animalTypeRaw != null) parsed.animalTypeRaw = animalTypeRaw;
  if (widthRaw != null) parsed.widthRaw = widthRaw;
  if (heightRaw != null) parsed.heightRaw = heightRaw;

  return parsed;
}
