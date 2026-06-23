import { getCameras } from "./settings-store.js";
import { sanitizeCameraName } from "./camera-name.js";

/**
 * Resolve an SMTP recipient local-id to a known cameraId.
 *
 * The library's `resolveCameraIdFromRecipient` strips the `cam-` prefix from
 * `cam-<id>@<domain>` and feeds the captured `<id>` here. We match it against
 * the camera's id (case-insensitive) or its sanitized name.
 *
 * IMPORTANT: read the camera list LIVE via `getCameras()` on every call. Do
 * NOT capture a settings snapshot — `saveSettings()` reassigns the store's
 * settings object on every change, so a boot-time snapshot goes stale the
 * moment the user adds or edits a camera, and every delivery is then rejected
 * with `550 Unknown recipient` (issue #35: an NVR doorbell whose recipient
 * matched its camera id exactly was still rejected because it was configured
 * after server boot).
 */
export function resolveEmailPushCameraId(
  candidate: string,
): string | undefined {
  const lower = candidate.toLowerCase();
  const match = getCameras().find(
    (c) =>
      c.id.toLowerCase() === lower ||
      sanitizeCameraName(c.name).toLowerCase() === lower,
  );
  return match?.id;
}
