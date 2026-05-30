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
    id: "2026-05-30-email-events",
    date: "2026-05-30",
    title: "Reliable motion alerts for battery cameras (e-mail push)",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          Battery cameras like Argus, Go and Solo can&apos;t keep a live
          connection open while they sleep, so motion events used to arrive
          late — or get lost entirely. The manager now ships with a built-in
          mail receiver that catches the alert e-mails the camera sends
          when something happens. The result: motion, person, vehicle and
          animal detections light up in real time, exactly like an
          AC-powered camera, with{" "}
          <strong className="text-[var(--color-foreground)]">
            zero extra services to install
          </strong>
          .
        </p>
        <p>
          Setup is one click. Open a camera&apos;s settings → tab{" "}
          <strong className="text-[var(--color-foreground)]">
            E-mail Push
          </strong>
          {" "}→{" "}
          <strong className="text-[var(--color-foreground)]">
            Auto-configure
          </strong>
          . The manager pushes the right server, credentials and 24/7
          schedule to the camera for you. Press{" "}
          <strong className="text-[var(--color-foreground)]">
            Verify delivery
          </strong>
          {" "}right after to see the first test mail land in seconds.
        </p>
        <p>
          The events show up everywhere the manager already publishes:
          dashboard, MQTT topics, Home Assistant (with a fresh{" "}
          <strong className="text-[var(--color-foreground)]">snapshot</strong>{" "}
          attached to each detection), Frigate, and the SSE / JSON event
          stream. You can also browse the last{" "}
          <strong className="text-[var(--color-foreground)]">300 received
          e-mails</strong>{" "}from{" "}
          <strong className="text-[var(--color-foreground)]">Settings →
          E-mail Push</strong>
          {" "}— handy when a new camera doesn&apos;t seem to be talking.
        </p>
        <p>
          New installs get the receiver on by default, with random
          credentials generated on first boot. Existing installs are
          migrated automatically — no manual editing of settings.json
          required.
        </p>
      </div>
    ),
  },
  {
    id: "2026-05-15-talk-to-camera",
    date: "2026-05-15",
    title: "Talk to the camera from the browser",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          The stream player gained two-way audio. While a native WebRTC
          stream is open, a microphone button appears in the controls bar
          — press it to start talking to the camera. Press it again to
          stop.
        </p>
        <p>
          The player also has dedicated{" "}
          <strong className="text-[var(--color-foreground)]">play / stop</strong>{" "}
          buttons now (no more auto-start surprises) and a proper{" "}
          <strong className="text-[var(--color-foreground)]">fullscreen</strong>{" "}
          toggle that works for both H.264 and H.265 streams.
        </p>
      </div>
    ),
  },
  {
    id: "2026-05-15-webrtc-docs",
    date: "2026-05-15",
    title: "WebRTC endpoints documented",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          The Manager has two WebRTC backends — go2rtc and the in-process
          native server — and each one establishes a session differently.
          The docs now spell out the full signaling flow for both.
        </p>
        <p>
          See{" "}
          <strong className="text-[var(--color-foreground)]">
            documentation/manager-api.md
          </strong>{" "}
          for the endpoint reference, including the H.265 chunk format and
          a ready-to-paste browser snippet.
        </p>
      </div>
    ),
  },
  {
    id: "2026-05-15-packet-capture",
    date: "2026-05-15",
    title: "New: packet capture & analysis from a camera",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          A new <strong className="text-[var(--color-foreground)]">Capture</strong>{" "}
          page in the side menu starts a live wireshark/tshark capture against
          a single camera. The page guides you through the steps:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Pick a camera + network interface and start the capture.</li>
          <li>Open the Reolink app to perform the action you want to debug.</li>
          <li>Watch known and unknown commands fill the live tables as the camera responds.</li>
          <li>Stop and download a sanitized JSON or a redacted .pcapng — login bytes are wiped before either file leaves the server, the rest is preserved so we can reproduce the issue.</li>
        </ul>
        <p>
          Past captures appear under{" "}
          <strong className="text-[var(--color-foreground)]">Reports</strong> →
          Packet Captures so you can re-download or delete them later.
        </p>
      </div>
    ),
  },
  {
    id: "2026-05-15-stream-settings",
    date: "2026-05-15",
    title: "Stream settings editor in the camera panel",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          A new <strong className="text-[var(--color-foreground)]">Stream settings</strong>{" "}
          button in the right detail panel lets you tweak resolution, codec,
          frame rate, bitrate and audio for each profile.
        </p>
        <p>
          Dropdowns are populated from what the camera actually reports as
          supported (no more guessing values that the device will reject).
        </p>
      </div>
    ),
  },
  {
    id: "2026-05-15-ai-detection-overlay",
    date: "2026-05-15",
    title: "AI detection boxes on the live stream",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          The stream panel now draws coloured boxes around what the
          camera detects, with the class and confidence right on the
          picture:{" "}
          <span style={{ color: "#22d3ee" }}>cyan</span> for people,{" "}
          <span style={{ color: "#a78bfa" }}>violet</span> for vehicles,{" "}
          <span style={{ color: "#fb923c" }}>orange</span> for animals,{" "}
          <span style={{ color: "#f472b6" }}>pink</span> for faces.
        </p>
        <p>
          Use the{" "}
          <strong className="text-[var(--color-foreground)]">
            Show detection boxes
          </strong>{" "}
          checkbox at the top of each stream window to turn the overlay
          on or off.
        </p>
      </div>
    ),
  },
  {
    id: "2026-05-15-h265-mainstream-fix",
    date: "2026-05-15",
    title: "H.265 4K main streams now play in the browser",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          Opening the main stream of a 4K H.265 camera used to show a
          black screen. It now plays end-to-end.
        </p>
        <p>
          The stream window also gained a mute and fullscreen button
          that work for every camera and codec.
        </p>
      </div>
    ),
  },
  {
    id: "2026-05-15-snapshot-reboot",
    date: "2026-05-15",
    title: "Snapshot and Reboot buttons",
    body: (
      <div className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <p>
          Two new actions in the right-side camera panel:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong className="text-[var(--color-foreground)]">
              Snapshot
            </strong>{" "}
            — saves a JPEG of the current camera view to your computer.
          </li>
          <li>
            <strong className="text-[var(--color-foreground)]">
              Reboot camera
            </strong>{" "}
            — restarts the camera (with a confirmation step so a misclick
            doesn't take it offline).
          </li>
        </ul>
      </div>
    ),
  },
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
