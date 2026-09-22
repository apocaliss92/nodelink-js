/**
 * How fast a downloaded recording actually plays.
 *
 * The BcMedia `InfoV1`/`InfoV2` header carries the FILE's nominal frame rate,
 * and it is not the rate that was delivered: measured 2026-09-20 on a Home Hub
 * v3.3.0.456 child, a 43 s clip declared `fps 30` and delivered 661 access
 * units in 43.943 s of timestamps — 15.019. Muxing that at 30 would have made
 * the video half as long as its own audio. The access-unit timestamps are the
 * authority; the info header is the fallback, and its use is REPORTED so a
 * caller is never told a guess and a measurement in the same field.
 */

export type RecordingFpsSource = "timestamps" | "infoFps" | "unknown";

export interface RecordingVideoTiming {
  accessUnits: number;
  /** Frames per second, or `null` when nothing on the wire said. */
  fps: number | null;
  /** Seconds spanned by the access units, or `null` when unknown. */
  durationSeconds: number | null;
  /** The nominal rate of the info header, kept so a caller can see the gap. */
  infoFps: number | null;
  fpsSource: RecordingFpsSource;
}

/**
 * Snap a measured rate onto a broadcast rate when it is within a frame of it.
 * A camera that delivers 24.70 or 25.41 is a 25 fps camera; writing the raw
 * float into `-r` accumulates drift over a long clip.
 */
export const roundRecordingFps = (fps: number): number => {
  if (fps > 14 && fps < 16) return 15;
  if (fps > 23 && fps < 26) return 25;
  if (fps > 29 && fps < 31) return 30;
  return Math.round(fps * 100) / 100;
};

export const estimateVideoTiming = (params: {
  /** Presentation timestamps of the access units, in microseconds, in order. */
  timestampsUs: readonly number[];
  /** `fps` of the first InfoV1/InfoV2 header, when there was one. */
  infoFps?: number | null;
}): RecordingVideoTiming => {
  const { timestampsUs } = params;
  const infoFps =
    params.infoFps != null && params.infoFps > 0 ? params.infoFps : null;
  const accessUnits = timestampsUs.length;

  if (accessUnits >= 2) {
    const spanUs = timestampsUs[accessUnits - 1]! - timestampsUs[0]!;
    if (spanUs > 0) {
      const durationSeconds = spanUs / 1_000_000;
      return {
        accessUnits,
        fps: roundRecordingFps((accessUnits - 1) / durationSeconds),
        durationSeconds,
        infoFps,
        fpsSource: "timestamps",
      };
    }
  }

  if (infoFps != null) {
    return {
      accessUnits,
      fps: infoFps,
      durationSeconds: accessUnits > 0 ? accessUnits / infoFps : null,
      infoFps,
      fpsSource: "infoFps",
    };
  }

  return {
    accessUnits,
    fps: null,
    durationSeconds: null,
    infoFps,
    fpsSource: "unknown",
  };
};
