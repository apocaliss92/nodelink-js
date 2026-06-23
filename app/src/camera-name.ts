// Pure, dependency-free camera-name helpers. Kept in their own module so
// lightweight consumers (e.g. the email-push resolver) can use them without
// pulling in the heavy rtsp-manager module and its file logger.

/** Sanitize a camera name for use in a URL path (`Camera Studio` => `camera_studio`). */
export function sanitizeCameraName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
