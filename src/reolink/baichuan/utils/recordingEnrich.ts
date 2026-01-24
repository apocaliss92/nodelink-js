import type {
  EnrichedRecordingFile,
  RecordingDetectionClass,
  RecordingFile,
} from "../types";
import { parseRecordingFileName } from "../recordingFileName";

export const parseRecordTypeFlags = (
  recordType?: string,
): {
  hasPerson: boolean;
  hasVehicle: boolean;
  hasAnimal: boolean;
  hasFace: boolean;
  hasMotion: boolean;
  hasSchedule: boolean;
  hasDoorbell: boolean;
  hasPackage: boolean;
  hasRf: boolean;
  hasOther: boolean;
} => {
  const flags = {
    hasPerson: false,
    hasVehicle: false,
    hasAnimal: false,
    hasFace: false,
    hasMotion: false,
    hasSchedule: false,
    hasDoorbell: false,
    hasPackage: false,
    hasRf: false,
    hasOther: false,
  };

  if (!recordType) return flags;

  const types = recordType
    .toLowerCase()
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const t of types) {
    if (t === "people" || t === "person") flags.hasPerson = true;
    else if (t === "vehicle" || t === "car") flags.hasVehicle = true;
    else if (t === "dog_cat" || t === "animal" || t === "pet")
      flags.hasAnimal = true;
    else if (t === "face") flags.hasFace = true;
    else if (t === "md" || t === "motion") flags.hasMotion = true;
    else if (t === "sched" || t === "schedule" || t === "timer")
      flags.hasSchedule = true;
    else if (t === "visitor" || t === "doorbell") flags.hasDoorbell = true;
    else if (t === "package") flags.hasPackage = true;
    else if (t === "rf" || t === "io" || t === "pir") flags.hasRf = true;
    else if (t === "other" || t === "manual") flags.hasOther = true;
  }

  return flags;
};

export const enrichRecordingFile = (
  rec: RecordingFile,
  rtmpUrl?: string,
): EnrichedRecordingFile => {
  const parsed =
    rec.parsedFileName ??
    (rec.fileName ? parseRecordingFileName(rec.fileName) : undefined);

  const startTime = rec.startTime ?? parsed?.start;
  const endTime = rec.endTime ?? parsed?.end;

  const startTimeMs = startTime?.getTime() ?? 0;
  const endTimeMs = endTime?.getTime() ?? startTimeMs;

  let durationMs = parsed?.durationMs ?? 0;
  if (durationMs === 0 && endTimeMs > startTimeMs) {
    durationMs = endTimeMs - startTimeMs;
  }

  const hexFlags = parsed?.flags;
  const typeFlags = parseRecordTypeFlags(rec.recordType);

  const hasPerson = (hexFlags?.aiPerson ?? false) || typeFlags.hasPerson;
  const hasVehicle = (hexFlags?.aiVehicle ?? false) || typeFlags.hasVehicle;
  const hasAnimal = (hexFlags?.aiAnimal ?? false) || typeFlags.hasAnimal;
  const hasFace = (hexFlags?.aiFace ?? false) || typeFlags.hasFace;
  const hasMotion = (hexFlags?.motion ?? false) || typeFlags.hasMotion;
  const hasSchedule = (hexFlags?.schedule ?? false) || typeFlags.hasSchedule;
  const hasDoorbell = (hexFlags?.doorbell ?? false) || typeFlags.hasDoorbell;
  const hasPackage = (hexFlags?.package ?? false) || typeFlags.hasPackage;
  const hasRf = (hexFlags?.rf ?? false) || typeFlags.hasRf;
  const hasOther = (hexFlags?.aiOther ?? false) || typeFlags.hasOther;

  const detectionClasses: RecordingDetectionClass[] = [];
  if (hasPerson) detectionClasses.push("person");
  if (hasVehicle) detectionClasses.push("vehicle");
  if (hasAnimal) detectionClasses.push("animal");
  if (hasFace) detectionClasses.push("face");
  if (hasPackage) detectionClasses.push("package");
  if (hasDoorbell) detectionClasses.push("doorbell");
  if (hasRf) detectionClasses.push("rf");
  if (hasOther) detectionClasses.push("other");
  if (hasMotion) detectionClasses.push("motion");
  if (hasSchedule) detectionClasses.push("schedule");

  const enriched: EnrichedRecordingFile = {
    fileName: rec.fileName,
    id: rec.id ?? rec.fileName,
    startTimeMs,
    endTimeMs,
    durationMs,
    hasPerson,
    hasVehicle,
    hasAnimal,
    hasFace,
    hasMotion,
    hasSchedule,
    hasDoorbell,
    hasPackage,
    hasRf,
    hasOther,
    detectionClasses,
    streamHint: parsed?.streamHint ?? "unknown",
    devType: parsed?.devType ?? "cam",
    raw: rec,
  };

  if (rec.sizeBytes !== undefined) enriched.sizeBytes = rec.sizeBytes;
  if (rec.recordType) enriched.recordType = rec.recordType;
  if (rtmpUrl) enriched.rtmpUrl = rtmpUrl;
  if (parsed) enriched.parsedFileName = parsed;

  return enriched;
};
