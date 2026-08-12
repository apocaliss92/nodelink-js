/**
 * DESCRIBE priming timeouts.
 *
 * On DESCRIBE the RTSP server briefly waits for the camera to deliver the
 * pieces the SDP needs — video parameter sets (SPS/PPS for H.264,
 * VPS/SPS/PPS for H.265) and the first AAC frame — so downstream decoders
 * (ffmpeg/Frigate/go2rtc) do not have to hunt for them in-band.
 *
 * The built-in windows are tuned for mains-powered cameras that answer in
 * ~1-2s. Battery cameras behind BCUDP have to wake up first and routinely
 * blow past them, producing an SDP with no `sprop-parameter-sets` and a
 * downstream decoder that hangs. Hence these are configurable per transport
 * (see issue #40).
 */

export type Transport = "tcp" | "udp";

/** Either one value for every transport, or a per-transport override. */
export type PrimingTimeoutOption =
  | number
  | { tcp?: number; udp?: number };

export interface PrimingDefaults {
  readonly tcp: number;
  readonly udp: number;
}

/**
 * Video parameter-set priming. UDP/battery transport starts slower, so it
 * gets a longer window than TCP.
 */
export const DEFAULT_VIDEO_PRIMING_MS: PrimingDefaults = {
  tcp: 3000,
  udp: 4000,
};

/**
 * Audio priming. Some cameras (notably Elite Floodlight WiFi) deliver the
 * first ADTS AAC frame noticeably later than video on a freshly started
 * native stream.
 */
export const DEFAULT_AUDIO_PRIMING_MS: PrimingDefaults = {
  tcp: 2000,
  udp: 3000,
};

/**
 * Upper bound for a configured priming window. A DESCRIBE blocks the client
 * for this long in the worst case, so an unbounded value would look like a
 * hung server rather than a slow camera.
 */
export const MAX_PRIMING_MS = 60_000;

/**
 * A priming window is valid when it is a non-negative integer number of ms.
 * `0` is meaningful — it means "answer immediately, don't wait".
 */
function isValidPrimingMs(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

/**
 * Resolve the effective priming window for a transport.
 *
 * Precedence: per-transport override → scalar override → built-in default.
 * Invalid entries (negative, fractional, NaN, Infinity) are ignored and fall
 * through to the default rather than throwing, so a bad setting degrades to
 * current behaviour instead of breaking every DESCRIBE.
 */
export function resolvePrimingMs(
  option: PrimingTimeoutOption | undefined,
  transport: Transport,
  defaults: PrimingDefaults,
): number {
  const fallback = defaults[transport];

  const configured =
    typeof option === "number" ? option : option?.[transport];

  if (!isValidPrimingMs(configured)) {
    return fallback;
  }

  return Math.min(configured, MAX_PRIMING_MS);
}
