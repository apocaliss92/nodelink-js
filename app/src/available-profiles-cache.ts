import { TtlCache } from "@apocaliss92/nodelink-js";

/**
 * Which stream profiles a camera offers, cached per camera.
 *
 * `getAvailableProfiles()` answers this by calling `buildVideoStreamOptions()`,
 * which reads the encoder config off the camera — a Baichuan command that
 * **wakes a sleeping battery camera**. It runs on every API (re)connection via
 * `onApiConnected`, and the library's own cache lives on the
 * `ReolinkBaichuanApi` instance, which the manager rebuilds on each reconnect.
 * So a battery camera whose connection cycles was read, and woken, once per
 * cycle — measured at one wake every ~22s in issue #35.
 *
 * Keying by camera id instead of by connection is what actually breaks that
 * loop: a reconnect reuses the answer instead of going back to the camera.
 *
 * Profiles change only when someone edits the camera's stream configuration,
 * which is why {@link invalidateAvailableProfiles} exists — the ttl is a
 * backstop, not the primary correctness mechanism.
 */
export type AvailableProfile = "main" | "sub" | "ext";

/**
 * Long enough to absorb a reconnect loop (the reported one cycled every ~22s)
 * while still re-reading often enough that a camera reconfigured outside the
 * manager is picked up on its own.
 */
export const AVAILABLE_PROFILES_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const availableProfilesCache = new TtlCache<AvailableProfile[]>(
  AVAILABLE_PROFILES_TTL_MS,
);

/**
 * Per-profile stream metadata, shared across RTSP server instances.
 *
 * `BaichuanRtspServer` caches this on itself, but the manager rebuilds the
 * server whenever the camera reconnects, so that cache is always cold and the
 * camera is read — and woken — again. Handing the server this cache lets a
 * rebuilt instance reuse what its predecessor already fetched.
 *
 * Same ttl and the same invalidation hook as the profile list: both are
 * derived from the camera's encoder configuration.
 */
export const streamMetadataCache = new TtlCache<{
  frameRate: number;
  width?: number;
  height?: number;
}>(AVAILABLE_PROFILES_TTL_MS);

/** Drop the cached profiles for one camera, leaving every other camera alone. */
export function invalidateAvailableProfiles(cameraId: string): void {
  availableProfilesCache.delete(cameraId);
}
