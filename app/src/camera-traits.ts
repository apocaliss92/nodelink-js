/**
 * Derived camera traits.
 *
 * Until 0.4.20 the manager carried an explicit `isBattery: boolean` field
 * per camera and made behavioural decisions on it (force UDP transport,
 * skip ping keepalive, skip the reconnect watchdog, …). The flag had two
 * problems:
 *
 *   1. **Ambiguity at first connect.** A freshly added battery camera
 *      with the default `isBattery: false` + `transport: "auto"` would
 *      still hit a 4-second TCP timeout on every connect because nothing
 *      told the lib to skip TCP. The reactive `auto-mark` heuristic in
 *      `events-manager` flipped the flag only on the first
 *      sleeping/awake event — too late to avoid the per-cycle cost and
 *      the noisy `ECONNREFUSED` log.
 *
 *   2. **Two sources of truth.** The persisted `transport` already
 *      uniquely identifies a battery camera in this codebase — the only
 *      writer that produces `transport: "udp"` is the battery path in
 *      `rtsp-manager.ts`, plus the `events-manager`-side
 *      "Persisted resolved transport" hook added in 0.4.20. Keeping
 *      `isBattery` alongside it duplicated the signal and forced every
 *      consumer to read both.
 *
 * From 0.4.21 the battery-ness of a camera is derived solely from
 * `transport === "udp"`. Settings files written by older versions are
 * migrated at startup by `migrateLegacyBatteryCamera` (which sets
 * `transport: "udp"` when the legacy `isBattery: true` flag is found and
 * then drops the flag). New writes never set the field.
 */

/**
 * Whether a camera should behave as a battery camera at runtime.
 *
 * Rules:
 * - **Standalone** cameras: `transport === "udp"` is the single source of
 *   truth (set by the user, by discovery, or by the
 *   "Persisted resolved transport" hook in `events-manager`).
 * - **NVR children** share the parent Hub's TCP connection, so the
 *   `transport` field can't disambiguate them. For that case the
 *   explicit `isBattery` flag is retained — it's set by the NVR channel
 *   discovery flow when the Hub reports an Argus / Go child on a
 *   sub-channel.
 */
export function isBatteryCamera(
  camera:
    | { transport?: string; nvrId?: string; isBattery?: boolean }
    | undefined,
): boolean {
  if (!camera) return false;
  if (camera.nvrId) return camera.isBattery === true;
  return camera.transport === "udp";
}

/**
 * One-shot migration: standalone cameras with the legacy `isBattery: true`
 * field get their `transport` set to `"udp"`. The caller is responsible
 * for stripping the obsolete `isBattery` key on standalone cams; NVR
 * children keep the flag because they share the parent's TCP transport
 * and the field is still the only per-child battery signal.
 *
 * Returns `true` if the camera's `transport` was mutated.
 */
export function migrateLegacyBatteryCamera<
  T extends { transport?: string; isBattery?: boolean; nvrId?: string },
>(camera: T): boolean {
  // NVR children: nothing to do — keep the flag.
  if (camera.nvrId) return false;
  if (camera.isBattery === true && camera.transport !== "udp") {
    camera.transport = "udp";
    return true;
  }
  return false;
}
