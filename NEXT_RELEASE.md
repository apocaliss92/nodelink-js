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

### Features

- New `api.onObjectDetections(cb)` / `offObjectDetections(cb?)` API mirroring `onSimpleEvent`. Reference-counted lifecycle: opens a dedicated substream on the first listener and closes it with the last. Every event carries the AI class label (people / vehicle / animal / face), confidence and normalized box coordinates — no need to manage a video stream yourself.
- Decoded AI Mark `additionalHeader` (TLV chain + LZ4F-compressed inner payload) end-to-end. Boxes are now emitted with class label and confidence, mirroring the SDK's own dispatch via the static `s_tlv_types_map` table.
- Manager UI: reboot camera button in the right detail panel (with confirmation step).
- Manager UI: snapshot download button — captures a JPEG from the camera and downloads it directly to the browser.
- Manager UI: detection box overlay with per-class colours (people=cyan, vehicle=violet, animal=orange, face=pink), toggle checkbox on the floating stream panel.
- Manager UI: detection SSE is lazy-attached — `onObjectDetections` is activated only when the first overlay client connects and stops when the last disconnects, so idle UIs cost zero extra substream bandwidth.

### Fixes

- Multi-class wrapper dedup for detection boxes. Reolink cameras emit the same box in multiple class arrays (people + vehicle, or all three for animals); the decoder now dedupes by exact coords and picks the most specific class (animal > people > vehicle), matching what the SDK app does.
- Build hardening for nested TLV: walker now tolerates non-LZ4F box-length variants (type=4 len=13/14, type=2 len=10) and recovers gracefully from malformed sub-trees.
- WebRTC native H.265 4K mainStream: client now reassembles chunked DataChannel messages before feeding the WebCodecs decoder. Previously the decoder failed with "A key frame is required after configure()" because each chunk was decoded as if it were a complete frame. Server prepends a uniform 4-byte chunk header `[u16 BE chunkIndex][u16 BE totalChunks]` to every binary message so the client can reassemble unambiguously.
