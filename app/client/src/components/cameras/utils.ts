import { getStoredAuthToken } from "../../authToken";
import type { CameraInfo, StreamProfile } from "./types";

export function withAuthTokenQuery(url: string): string {
  const token = getStoredAuthToken();
  if (!token) return url;
  const u = new URL(url, window.location.origin);
  u.searchParams.set("token", token);
  return u.toString();
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const token = getStoredAuthToken();
  const headers = new Headers(init?.headers ?? undefined);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-1000px";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      // ignore
    }
  }
}

export function statusBadge(status: CameraInfo["status"]) {
  if (status === "connected") return "badge ok";
  if (status === "error") return "badge err";
  return "badge";
}

export function streamKey(
  cameraId: string,
  profile: StreamProfile,
  channel: number,
) {
  return `${cameraId}:${profile}:${channel}`;
}

/** Canonical display name for a camera (used in stream names and UI labels). */
export function getCameraDisplayName(camera: CameraInfo): string {
  return camera.sanitizedName ?? camera.name ?? camera.host;
}

/**
 * Resolve the go2rtc stream name for a given camera + profile.
 * Uses the server-reported name when available, falls back to `displayName/profile`.
 */
export function getStreamName(
  camera: CameraInfo,
  profile: StreamProfile,
  rtspServer?: { go2rtcStreamName?: string },
): string {
  return rtspServer?.go2rtcStreamName ?? `${getCameraDisplayName(camera)}/${profile}`;
}

export function eventBadgeColor(type: string): string {
  const colors: Record<string, string> = {
    motion: "rgba(34, 197, 94, 0.25)",
    doorbell: "rgba(96, 165, 250, 0.3)",
    people: "rgba(124, 58, 237, 0.3)",
    vehicle: "rgba(245, 158, 11, 0.25)",
    animal: "rgba(234, 88, 12, 0.25)",
    face: "rgba(236, 72, 153, 0.25)",
    package: "rgba(20, 184, 166, 0.25)",
    daynight: "rgba(59, 130, 246, 0.25)",
    camera_connected: "rgba(34, 197, 94, 0.35)",
    camera_disconnected: "rgba(239, 68, 68, 0.25)",
    stream_clients: "rgba(59, 130, 246, 0.25)",
  };
  return colors[type] ?? "rgba(255, 255, 255, 0.06)";
}
