/**
 * News feed — in-app changelog / announcements shown to the user.
 *
 * Append new items at the TOP of the array. Each item MUST have a unique
 * stable `id`. The `NewsModal` compares `items[0].id` against the value
 * stored in localStorage (`nodelink.lastSeenNewsId`) to decide whether to
 * auto-open on mount.
 */

import type { ReactNode } from "react";

export interface NewsItem {
  /** Stable unique id — e.g. "2026-04-20-local-restreamer". */
  id: string;
  /** ISO date shown in the modal. */
  date: string;
  /** Short title displayed as the item header. */
  title: string;
  /** Body rendered inside the modal. Plain JSX, no markdown parser needed. */
  body: ReactNode;
}

export const NEWS_ITEMS: NewsItem[] = [
  {
    id: "2026-04-20-unified-rtsp-auth",
    date: "2026-04-20",
    title: "Unified RTSP auth: dashboard users are now RTSP users",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          The local RTSP restreamer now authenticates clients against the
          same{" "}
          <strong className="text-[var(--color-foreground)]">
            dashboard users
          </strong>{" "}
          you manage in{" "}
          <strong className="text-[var(--color-foreground)]">
            Settings → Auth → Users
          </strong>
          . No separate user list, no duplicate credentials.
        </p>
        <p>
          Digest authentication uses the pre-computed{" "}
          <code className="rounded bg-[var(--color-surface-hover)] px-1 text-[11px]">
            HA1
          </code>{" "}
          that is persisted once at password-set time; the server never has
          to hold the plaintext password in memory.
        </p>
        <p className="text-[11px] text-[var(--color-foreground-subtle)]">
          If you have dashboard users created before this update you may need
          to reset their password once (same value is fine) so the HA1 gets
          regenerated. Enable{" "}
          <em>Require auth for RTSP connections</em> in the Auth tab to turn
          auth on.
        </p>
      </div>
    ),
  },
  {
    id: "2026-04-20-local-restreamer",
    date: "2026-04-20",
    title: "New: local RTSP restreamer (drop go2rtc)",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          You can now pick the streaming backend in{" "}
          <strong className="text-[var(--color-foreground)]">
            Settings → go2rtc → Restreamer backend
          </strong>
          :
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong className="text-[var(--color-foreground)]">go2rtc</strong>{" "}
            (default) — keeps the go2rtc sidecar and all its outputs: RTSP,
            WebRTC, HLS, MJPEG, MSE.
          </li>
          <li>
            <strong className="text-[var(--color-foreground)]">local</strong> —
            uses the library&apos;s built-in{" "}
            <code className="rounded bg-[var(--color-surface-hover)] px-1 text-[11px]">
              BaichuanRtspServer
            </code>{" "}
            directly. Only RTSP is served. WebRTC, HLS, MJPEG and MSE previews
            are disabled; snapshots (CGI) still work.
          </li>
        </ul>
        <p>
          Pick <strong className="text-[var(--color-foreground)]">local</strong>{" "}
          if you only consume RTSP (Frigate, Scrypted RTSP, VLC, ffmpeg) and
          want to skip the go2rtc sidecar, its binary download, and its ffmpeg
          transcoding path.
        </p>
        <p className="text-[11px] text-[var(--color-foreground-subtle)]">
          The local port defaults to 8554 and is configurable in the same
          settings card. Restart the app after changing the restreamer mode.
        </p>
      </div>
    ),
  },
];
