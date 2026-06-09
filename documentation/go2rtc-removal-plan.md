# Removing local go2rtc from the manager — plan

Status: **planning only**, no code changes yet. Phases below are sequenced
so each step ships a working manager; the user can stop at any phase and
keep a usable image.

## Goal

Drop the bundled `go2rtc` sidecar from the manager Docker image. The
library's own `BaichuanRtspServer` + `LocalRtspMux` (already in use when
`restreamer === "local"`) handles all camera video output. The
`BaichuanWebRTCServer` (`webrtc-native`, in-process via `werift`) handles
WebRTC for the in-browser preview.

Result: one less child process to ship, no `go2rtc-static` binary to
download at install time, no `/go2rtc/*` HTTP proxy, no YAML config
regeneration, no health-check loop, no port conflicts. Manager becomes
"RTSP + WebRTC + tRPC", end of story.

## What stays vs what goes

| Capability                   | After removal                                        |
|------------------------------|------------------------------------------------------|
| RTSP output (per camera)     | ✅ `LocalRtspMux` + `BaichuanRtspServer` (port 8554) |
| RTSP backchannel (2-way)     | ✅ Same mux, path `/<cameraName>` (just landed)      |
| WebRTC preview in UI         | ✅ `webrtc-native` (`werift` in-process)             |
| CGI snapshot (`/cgi-bin/...`)| ✅ Library CGI helper, unchanged                     |
| HLS output                   | ❌ Removed — Frigate does its own, browser uses WebRTC |
| MJPEG output                 | ❌ Removed (was a transcoding feature)               |
| MSE output                   | ❌ Removed                                           |
| MP4 transcoded streams       | ❌ Removed                                           |
| go2rtc transcoded snapshots  | ❌ Use raw CGI snapshot instead                      |

## Decisions to confirm before phase 1

1. **WebRTC default backend**: today `settings.webrtc.preferredBackend`
   defaults to `"auto"` (go2rtc preferred, native fallback). After the
   removal there's only native. Confirm we flip the default to
   `"native"` and remove the `"go2rtc"` and `"auto"` enum values entirely.

2. **Settings migration**: existing user data has
   `restreamer: "go2rtc"` and a populated `settings.go2rtc.*`. Two
   options:
   - **A.** Migration step on load: rewrite `restreamer` to `"local"`,
     drop `settings.go2rtc.*`, persist on next save. Transparent.
   - **B.** Hard cutover: schema-rejects old keys, user has to wipe
     `settings.json` once. Simpler code, worse UX.
   Recommended: A.

3. **Frigate integration**: the Frigate config builder
   (`app/src/routers/frigate.ts`) currently emits go2rtc streams
   pointing at the manager's go2rtc port (18554). After removal it
   should emit the LocalRtspMux URL (port 8554, no profile in
   backchannel path). Confirm OK.

4. **Compose / docs**: the README, `app/README.md` and `DOCKER.md`
   advertise WebRTC/HLS/MJPEG/MSE/snapshot URLs via go2rtc. After
   removal: rewrite the "what runs inside" section to one paragraph
   (RTSP + WebRTC), update default ports (drop 11984/18554/18555,
   keep 8554 + WebRTC range).

## Phases

### Phase 1 — Make `local` the only mode (no demolition yet)

Goal: stop offering go2rtc to new users while existing setups keep working.

- `settings.restreamer` becomes a hidden field, default flips to
  `"local"` for new installs. Existing settings honored until next save.
- Settings UI hides the restreamer tab toggle. The go2rtc-only preview
  buttons (HLS/MJPEG/MSE/MP4) become hidden permanently regardless of
  mode (they already are in `local`).
- `webrtc.preferredBackend` default → `"native"`.

This is reversible — code stays in tree. Ship + bake for one beta cycle.

### Phase 2 — Delete the go2rtc code paths

After phase 1 is stable in production:

- Delete `app/src/go2rtc-manager.ts`.
- Delete `app/src/routers/go2rtc.ts` and unhook from `app/src/router.ts`.
- Delete the `restreamer === "go2rtc"` branch of `app/src/rtsp-manager.ts`
  (lines ~1368–1450 — `Go2rtcTcpServer` registration + WebRTC companion
  transcode). Keep only the `LocalRtspMux` path.
- Remove the `/go2rtc/*` Express proxy in `app/src/server.ts` (lines
  274–321). Remove `initGo2rtc` / `stopGo2rtc` imports from boot/shutdown.
- Delete `settings.go2rtc.*` from the schema. Remove the `restreamer`
  enum (keep field as legacy alias for one release for the migration
  step, then remove in phase 3).
- Drop `go2rtc-static` from `app/package.json`.
- Remove the go2rtc binary download step from `Dockerfile` (the curl
  step that fetches `go2rtc_linux_*`).
- Update `app/src/routers/frigate.ts` to emit LocalRtspMux URLs only.
- Frontend cleanup:
  - `app/client/src/components/cameras/utils.ts`:
    `resolveGo2rtcStreamName` / `resolveGo2rtcWebrtcStreamName` deleted.
  - `StreamProfileCard.tsx`: drop HLS/MP4/MSE/snapshot/preview URL
    builders. Keep RTSP copy + WebRTC preview (via `webrtc-native`).
  - `StreamPlayer.tsx`: route WebRTC through the existing native WHEP
    handler instead of go2rtc WHEP.
  - `CameraDetailPage.tsx`: simplify the preview gating logic.
  - `SettingsPage.tsx`: delete the go2rtc tab + Frigate-yaml snippet
    builder. Adjust the Talk card to drop the "go2rtc mode" branch
    (single port mode is the only mode now).

### Phase 3 — Cleanup

- Remove the `restreamer` legacy alias.
- Remove `_migrationsApplied` entries we added for the cutover.
- Update `CLAUDE.md`, `README.md`, `app/README.md`, `DOCKER.md`,
  `documentation/manager-api.md`, `documentation/frigate-backchannel.md`
  to drop every go2rtc mention.
- Drop the `webrtc.preferredBackend` setting entirely (only `native`
  remains; nothing to choose).

## Test plan per phase

- **Phase 1**: existing test suite still passes; new users see only RTSP +
  WebRTC in the UI; existing users keep working (no behavior change for
  them, just hidden controls).
- **Phase 2**: full E2E with a real camera — connect, start stream, copy
  RTSP URL, play in VLC, open WebRTC preview in browser, run analyzer,
  verify Frigate config builder emits a working YAML.
- **Phase 3**: docs build clean, no stale refs to go2rtc, fresh
  `settings.json` on first boot has no go2rtc keys.

## Risks

- **WebRTC reachability**: `webrtc-native` uses werift. We've already
  seen the user's "connectionState: failed" report; that pattern
  (container IP advertised in ICE) is independent of which WebRTC
  backend runs. Removing go2rtc doesn't make it worse — but we should
  ship the ICE-host-advertised setting work BEFORE phase 2 so the
  native backend is the recommended path with confidence.
- **Existing users on `restreamer: "go2rtc"`**: phase 1's migration
  flips them silently to `"local"`. This changes the URL shape served
  to existing consumers (Frigate yaml emitted by the manager will use
  port 8554 instead of 18554, no profile-less paths break, but the
  user has to refresh the Frigate side). Mitigation: clear release
  notes + a one-time banner in the UI on first load post-upgrade.
- **HLS/MJPEG consumers in the wild**: anyone today using
  `http://manager:11984/api/stream.m3u8?src=...` will lose that
  endpoint. Mitigation: same release notes + tell them to switch to
  RTSP (every NVR/Frigate/Home Assistant client supports it natively).

## Estimated effort

| Phase | Work | Reversibility |
|-------|------|---------------|
| 1     | ~3h (settings flip + UI hide + migration helper) | Trivial — just flip flags back |
| 2     | ~1d (delete files, simplify branches, fix frontend, smoke test in Docker) | Hard — restoring needs the deleted files |
| 3     | ~1h (docs + cleanup) | n/a |
