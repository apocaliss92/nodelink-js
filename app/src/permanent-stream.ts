/**
 * Maps a camera's Manager-level `permanentStream` config to the library's
 * `AlwaysOnOptions`. Single source of truth so every consumer that builds a
 * stream (the shared stream-pool, the RTSP manager, …) derives the same
 * always-on behavior from the unified Manager settings.
 *
 * Per-consumer overrides (e.g. RTSP query params) are intentionally NOT handled
 * here yet — they'll layer on top later.
 */

import type { AlwaysOnOptions, AlwaysOnTrigger } from "@apocaliss92/nodelink-js";

interface PermanentStreamConfig {
  enabled?: boolean;
  triggers?: string[];
  windowSeconds?: number;
  idleFps?: number;
  placeholderText?: string;
  placeholderOpacity?: number;
  placeholderEnabled?: boolean;
}

/**
 * Build the `alwaysOn` option from a camera config, or `undefined` when the
 * camera has no permanent-stream enabled. Only explicitly-set fields are
 * included so the library defaults apply (respects exactOptionalPropertyTypes).
 */
export function buildAlwaysOnOptions(
  camera: { permanentStream?: PermanentStreamConfig } | undefined,
): AlwaysOnOptions | undefined {
  const ps = camera?.permanentStream;
  if (!ps?.enabled) return undefined;

  return {
    enabled: true,
    ...(ps.triggers && ps.triggers.length > 0
      ? { triggers: ps.triggers as AlwaysOnTrigger[] }
      : {}),
    ...(ps.windowSeconds !== undefined
      ? { windowMs: ps.windowSeconds * 1000 }
      : {}),
    ...(ps.idleFps !== undefined ? { idleFps: ps.idleFps } : {}),
    ...(ps.placeholderEnabled !== undefined ||
    ps.placeholderText !== undefined ||
    ps.placeholderOpacity !== undefined
      ? {
          placeholder: {
            ...(ps.placeholderEnabled !== undefined
              ? { enabled: ps.placeholderEnabled }
              : {}),
            ...(ps.placeholderText !== undefined
              ? { text: ps.placeholderText }
              : {}),
            ...(ps.placeholderOpacity !== undefined
              ? { opacity: ps.placeholderOpacity }
              : {}),
          },
        }
      : {}),
  };
}
