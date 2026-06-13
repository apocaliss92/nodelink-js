// src/baichuan/stream/alwaysOnTypes.ts

/** Event types (from ReolinkSimpleEventType) that may open a live window. */
export type AlwaysOnTrigger =
  | "motion"
  | "doorbell"
  | "people"
  | "vehicle"
  | "animal"
  | "face"
  | "package";

export interface PlaceholderOptions {
  /** Decorate the still (dim + text). Falls back to raw keyframe if ffmpeg is unavailable. Default true. */
  enabled?: boolean;
  /** Overlay text. Default "Sleeping". */
  text?: string;
  /** Dim factor 0..1 (1 = original brightness). Default 0.5. */
  opacity?: number;
}

export interface AlwaysOnOptions {
  enabled: boolean;
  /** Event types that open a live window. Default ["motion", "doorbell"]. */
  triggers?: AlwaysOnTrigger[];
  /** Live window duration after a trigger (ms), extended by new events. Default 15000. */
  windowMs?: number;
  /** Placeholder repeat rate while idle (fps). Default 1. */
  idleFps?: number;
  /** Wake once on start to capture an initial keyframe. Default true. */
  primeOnStart?: boolean;
  /** Placeholder appearance. */
  placeholder?: PlaceholderOptions;
}

export const ALWAYS_ON_DEFAULTS = {
  triggers: ["motion", "doorbell"] as AlwaysOnTrigger[],
  windowMs: 15_000,
  idleFps: 1,
  primeOnStart: true,
  placeholder: { enabled: true, text: "Sleeping", opacity: 0.5 } as Required<PlaceholderOptions>,
};
