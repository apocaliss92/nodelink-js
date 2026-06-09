<!--
  Write your changelog entries here before releasing.
  This file is included in the GitHub release notes and then
  moved to CHANGELOG.md automatically by the release workflow.

  Use markdown. Example:

  ### Features
  - Added floodlight detection for doorbells
  - Stream combination testing in diagnostics dump

  ### Fixes
  - Fixed false PTZ detection on RLC-510WA (ptzControl ≠ physical PTZ)
  - Fixed D340W doorbell falsely detected as having floodlight
-->

### Breaking changes

- **go2rtc has been removed from the manager.** The bundled sidecar is gone — no more `go2rtc-static` binary download, no more YAML config generation, no more `/go2rtc/*` proxy. Streaming is now handled by two in-process components only: `BaichuanRtspServer` plugged into a single shared `LocalRtspMux` (RTSP, default port `8554`) and `BaichuanWebRTCServer` (in-process WebRTC via werift, for the in-browser preview).
- **HLS, MSE, MJPEG, transcoded MP4 and transcoded snapshot outputs are gone.** They only existed because go2rtc generated them. Consumers must switch to RTSP (every NVR / Frigate / Home Assistant card / ffmpeg client speaks it natively) or to the WebRTC preview built into the manager. CGI snapshots from the camera continue to work.
- **Bridge-mode Docker port mappings change.** Drop `11984`, `18554` and `18555`. Keep `3000` (UI/API), `8554` (RTSP + Frigate two-way audio path) and the WebRTC ICE UDP range configured in **Settings → WebRTC (ICE)**. `network_mode: host` continues to work without changes.
- **Settings migration is silent on first boot.** `restreamer`, `settings.go2rtc.*`, `settings.webrtc.preferredBackend` and the legacy `talk` block are stripped from `settings.json` automatically (Zod drops unknown keys; marker migrations force the rewrite). The Settings UI is shorter: the Restreamer tab is replaced by a smaller RTSP tab with the mux port and the Frigate config builder.
- **Frigate config builder targets the new endpoint.** The emitted YAML uses `rtsp://<host>:<localRtsp.port>/<cameraName>/<profile>` for video and `rtsp://<host>:<localRtsp.port>/<cameraName>?backchannel=1` for two-way audio — both on the same port.

### Features

- Stream **analyzer** now scores server-side health deterministically. Each report gains:
  - `video.droppedFrames` / `video.duplicatedFrames` (parsed from ffmpeg's `dup=` / `drop=` counters in the progress line — previously not captured)
  - `video.expectedFps` (from the camera's own `getStreamMetadata.frameRate` for the analyzed profile)
  - `verdict: { severity, reasons, fpsDeltaPct, dropRatePct }` — a top-line `ok` / `warn` / `error` plus the list of signals that contributed. Lets the UI answer "is the server stream healthy?" without forcing the reader to interpret every field.
- **RTSP backchannel is always on.** The `talk.enabled` toggle has been removed; the multiplexed backchannel listener attaches to the LocalRtspMux at boot and starts serving every connected camera under `/<cameraName>` automatically.
- New **Capture** page (server + UI) drives a live tshark capture against a chosen camera, parses Baichuan frames in real time, classifies cmd_ids as known/unknown, and walks the user through the auth handshake checklist (started → nonce captured → login successful). Sanitized JSON export and redacted `.pcapng` export — login XML bodies wiped, TCP checksums recomputed, nonce kept so maintainers can decrypt locally. Past captures persist under Reports → Packet Captures.
- Docker image now ships with `tshark` (Alpine package) and the `setcap` for `dumpcap`; compose file documents the `cap_add: NET_RAW, NET_ADMIN` requirement.
- New **Stream settings** panel in the camera detail tab. Reads `getEncOptions` (cmd_146) + `getStreamMetadata` (cmd_56) and renders one editor per profile (main / sub / ext) with selectors populated only from values the camera reports as supported. Per-profile Apply button calls `setEnc` and re-reads on success.
- New `api.onObjectDetections(cb, { channel?, profile? })` / `offObjectDetections(cb?, { channel?, profile? })` API mirroring `onSimpleEvent`. Listeners and substreams are tracked per `(channel, profile)` tuple — required so NVR/Hub child cameras subscribe on their own channel; defaults are `channel: 0`, `profile: "sub"`. Reference-counted lifecycle ensures the matching stream is running on the first listener for a tuple and closes it on the last. Every event carries the AI class label (people / vehicle / animal / face), confidence and normalized box coordinates — no need to manage a video stream yourself.
- Decoded AI Mark `additionalHeader` (TLV chain + LZ4F-compressed inner payload) end-to-end. Boxes are now emitted with class label and confidence, mirroring the SDK's own dispatch via the static `s_tlv_types_map` table.
- Manager UI: reboot camera button in the right detail panel (with confirmation step).
- Manager UI: snapshot download button — captures a JPEG from the camera and downloads it directly to the browser.
- Manager UI: detection box overlay with per-class colours (people=cyan, vehicle=violet, animal=orange, face=pink), toggle checkbox on the floating stream panel.
- Manager UI: detection SSE is lazy-attached — `onObjectDetections` is activated only when the first overlay client connects and stops when the last disconnects, so idle UIs cost zero extra substream bandwidth.

### Fixes

- Multi-class wrapper dedup for detection boxes. Reolink cameras emit the same box in multiple class arrays (people + vehicle, or all three for animals); the decoder now dedupes by exact coords and picks the most specific class (animal > people > vehicle), matching what the SDK app does.
- Build hardening for nested TLV: walker now tolerates non-LZ4F box-length variants (type=4 len=13/14, type=2 len=10) and recovers gracefully from malformed sub-trees.
- WebRTC native H.265 4K mainStream: client now reassembles chunked DataChannel messages before feeding the WebCodecs decoder. Previously the decoder failed with "A key frame is required after configure()" because each chunk was decoded as if it were a complete frame. Server prepends a uniform 4-byte chunk header `[u16 BE chunkIndex][u16 BE totalChunks]` to every binary message so the client can reassemble unambiguously.
- Detection box overlay no longer stretches into the letterboxed black bars when the stream container aspect ratio doesn't match the camera frame. Boxes are now mapped into the actual displayed picture rect using the video's intrinsic dimensions.
- WebRTC inline player gains mute/unmute and fullscreen controls that work for both modes (HTML5 `<video>` for RTP H.264 and `<canvas>` for WebCodecs H.265). Previously the canvas mode had no playback controls at all.
