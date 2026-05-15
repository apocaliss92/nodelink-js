# Manager REST API

The nodelink-manager web application exposes a REST API for authentication, events, and system monitoring. All endpoints (except auth config and health) require authentication when `AUTH_ENABLED` is set.

**Base URL:** `http://HOST:3000` (or your configured port)

---

## Table of Contents

- [Authentication](#authentication)
- [Health & Updates](#health--updates)
- [Metrics](#metrics)
- [go2rtc Restreamer](#go2rtc-restreamer)
- [Events (SSE, JSON stream)](#events-sse-json-stream)
- [MQTT Topics](#mqtt-topics-when-configured)
- [tRPC API](#trpc-api)

---

## Authentication

### `GET /api/auth/config`

Returns auth configuration (no auth required).

**Response:**
```json
{
  "enabled": true
}
```

### `GET /api/auth/me`

Returns the current authenticated user. Requires session cookie or `Authorization: Bearer <token>`.

**Response:**
```json
{
  "user": {
    "username": "admin",
    "role": "admin"
  }
}
```

### `POST /api/auth/login`

Login with username and password.

**Request body:**
```json
{
  "username": "admin",
  "password": "your-password"
}
```

**Response:**
```json
{
  "user": { "username": "admin", "role": "admin" },
  "token": "eyJ..."
}
```

### `POST /api/auth/logout`

Logout and revoke the current session token.

### `POST /api/auth/personal-token`

Generate a long-lived personal token. Requires authentication.

**Response:**
```json
{
  "token": "eyJ..."
}
```

### `GET /api/auth/personal-token`

Get the stored personal token for the current user (if any). Requires authentication.

**Response:**
```json
{
  "token": "eyJ..."
}
```

---

## Health & Updates

### `GET /api/health`

Health check endpoint (no auth required).

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:00:00.000Z"
}
```

### `GET /api/updates`

Check for application updates (GitHub Releases).

**Query params:**
- `force=1` — bypass cache

**Response:**
```json
{
  "currentVersion": "1.0.0",
  "latestVersion": "1.1.0",
  "latestTag": "v1.1.0",
  "releaseUrl": "https://github.com/owner/repo/releases/tag/v1.1.0",
  "updateAvailable": true,
  "checkedAt": "2024-01-15T10:00:00.000Z"
}
```

---

## Metrics

### `GET /api/metrics`

Returns resource usage metrics (CPU, memory, event loop). When auth is enabled, requires admin role.

**Response:**
```json
{
  "timestamp": "2024-01-15T10:00:00.000Z",
  "process": {
    "pid": 12345,
    "nodeVersion": "v22.14.0",
    "uptimeSeconds": 3600,
    "memory": { "rss": 123456789, "heapUsed": 45678901 },
    "cpu": { "percent": 2.5 }
  }
}
```

---

## go2rtc Restreamer

All video streaming is handled by **go2rtc**, which runs as an embedded subprocess managed by the Manager. go2rtc provides WebRTC, MSE/MP4, HLS, RTSP, and snapshot output from camera streams.

### Architecture

```
Camera → Baichuan Protocol → BaichuanRtspServer (internal, loopback)
                                    ↓
                        rtsp://127.0.0.1:{port}/path
                                    ↓
                              go2rtc ingest
                                    ↓
                  WebRTC / MSE / HLS / RTSP / Snapshot
```

Each camera stream profile (main/sub/ext) runs an internal `BaichuanRtspServer` on a unique loopback port. The RTSP URL is registered with go2rtc, which handles all output formats with audio+video support.

### Ports & Environment Variables

| Service | Default | Env Variable | Description |
|---------|---------|-------------|-------------|
| Manager UI/API | 3000 | `PORT` | Express + tRPC |
| go2rtc API | 11984 | `GO2RTC_API_PORT` | REST API + web dashboard |
| go2rtc RTSP | 18554 | `GO2RTC_RTSP_PORT` | RTSP output for all streams |
| go2rtc WebRTC | 18555 | `GO2RTC_WEBRTC_PORT` | ICE/STUN for WebRTC |
| go2rtc binary | (auto) | `GO2RTC_PATH` | Path to binary (falls back to bundled `go2rtc-static`) |
| Data directory | `.` | `DATA_PATH` | Settings, logs, go2rtc.yaml |

Environment variables override `settings.json`. Ports are also configurable in Settings → go2rtc tab.

### go2rtc Stream Endpoints

All streaming endpoints are served directly by go2rtc on its API port (default `11984`). CORS is enabled (`origin: "*"`).

| Format | URL | Notes |
|--------|-----|-------|
| **WebRTC** (WHEP) | `POST http://HOST:11984/api/webrtc?src={name}` | Send SDP offer (`Content-Type: application/sdp`), receive SDP answer |
| **MSE/MP4** | `http://HOST:11984/api/stream.mp4?src={name}` | Fragmented MP4 via HTTP (Media Source Extensions) |
| **HLS** | `http://HOST:11984/api/stream.m3u8?src={name}` | HLS playlist + segments |
| **RTSP** | `rtsp://HOST:18554/{name}` | Standard RTSP (e.g. for VLC, ffmpeg) |
| **Snapshot** | `http://HOST:11984/api/frame.jpeg?src={name}` | Single JPEG frame (requires ffmpeg) |
| **go2rtc Dashboard** | `http://HOST:11984/` | Web UI for stream management and debugging |
| **MSE Player** | `http://HOST:11984/stream.html?src={name}` | Embedded MSE player page |

### Stream Naming Convention

Stream names are built from the camera name and profile:

```
{sanitized_camera_name}_{profile}
```

Examples:
- `studio_main` — Studio camera, main stream
- `cameretta_daniel_sub` — Cameretta Daniel camera, sub stream
- `garage_ext` — Garage camera, ext stream

For multifocal cameras with channel > 0: `{name}_{profile}_ch{channel}`

### go2rtc tRPC API

The Manager exposes go2rtc management via tRPC:

| Procedure | Type | Description |
|-----------|------|-------------|
| `go2rtc.status` | query | Get go2rtc status (running, apiUrl, streams) |
| `go2rtc.getSettings` | query | Get go2rtc configuration |
| `go2rtc.updateSettings` | mutation | Update go2rtc configuration |
| `go2rtc.start` | mutation | Start go2rtc process |
| `go2rtc.stop` | mutation | Stop go2rtc process |
| `go2rtc.restart` | mutation | Restart go2rtc process |
| `go2rtc.listStreams` | query | List registered streams |
| `go2rtc.addStream` | mutation | Add a custom stream source |
| `go2rtc.removeStream` | mutation | Remove a stream |
| `go2rtc.ensureBinary` | mutation | Resolve/download go2rtc binary |

### Known Limitations

- **MJPEG stream** (`/api/stream.mjpeg`) does not work for H264/H265 sources in go2rtc 1.9.4. Use **Snapshot** (`/api/frame.jpeg`) for single frames or **MSE/WebRTC** for live preview.
- **Audio over TCP** is not supported directly. Audio is delivered via the internal RTSP source (BaichuanRtspServer handles RTP audio). go2rtc re-exports audio via WebRTC, MSE, and HLS.
- **ffmpeg** must be installed for snapshot generation and H265 transcoding.

---

## Native WebRTC Backend

In addition to go2rtc, the Manager exposes an in-process WebRTC server
(`BaichuanWebRTCServer` from the library) that streams native Baichuan frames
to the browser **without an intermediate RTSP/MSE hop**. Useful when:

- you need precise frame timing (e.g. to overlay AI detection boxes that align
  with the decoded video frame)
- go2rtc is not available in your environment
- you want to ship two-way audio (intercom) on the same WebRTC peer connection

The backend is selected by `settings.webrtc.preferredBackend`:

| Value | Behaviour |
|-------|-----------|
| `auto` (default) | Use go2rtc if it's running; fall back to native otherwise. |
| `go2rtc` | Always go2rtc. Error surfaced if go2rtc is down. |
| `native` | Always `BaichuanWebRTCServer`. Required by the detection-box overlay. |

### Signaling flow (server-driven offer)

Unlike go2rtc (which takes the browser's offer via WHEP), the native server
**generates the offer**. The browser answers, sets the local description, and
optionally trickles ICE candidates back. Every step is a tRPC call:

```
1. POST /api/trpc/webrtc.create
     input  { cameraId, profile: "main"|"sub"|"ext", enableIntercom? }
     output { sessionId, offer: { type: "offer", sdp } }

2. (browser) RTCPeerConnection.setRemoteDescription(offer)
   (browser) const answer = await pc.createAnswer()
   (browser) await pc.setLocalDescription(answer)

3. POST /api/trpc/webrtc.answer
     input  { sessionId, sdp: { type: "answer", sdp } }
     output { success: true }

4. POST /api/trpc/webrtc.addIce    (optional, only if browser trickles ICE)
     input  { sessionId, candidate: RTCIceCandidateInit }
     output { success: true }

5. POST /api/trpc/webrtc.close     (on tear-down)
     input  { sessionId }
     output { success: true }
```

The server gathers ICE candidates fully (3 s timeout) before returning the
offer in step 1, so trickle ICE on the browser side is optional for LAN
deployments. `webrtc.status` (query, no parameters) returns the live session
list with per-session stats.

### Transport per codec

| Codec | Transport | Notes |
|-------|-----------|-------|
| **H.264** | RTP media track | Standard WebRTC. NAL units fragmented as FU-A when larger than 1200 bytes. SPS/PPS are cached and prepended to IDR frames if the camera ships them inline only. |
| **H.265** | RTCDataChannel `"video"` | Chrome/Safari can't decode H.265 over RTP, so the server pushes raw Annex-B bytes over a DataChannel and the browser decodes via **WebCodecs `VideoDecoder`**. |
| **Audio (AAC)** | RTP audio track (Opus) | An ffmpeg subprocess transcodes AAC ADTS → Opus on demand the first time the camera emits an audio frame; the resulting RTP is re-wrapped with the session SSRC. |
| **Intercom (browser → camera)** | RTCDataChannel `"intercom"` | Optional, enable via `enableIntercom: true` in `webrtc.create`. Browser sends ADPCM audio; server forwards it to the camera's Talk API. One-way. |

### H.265 DataChannel frame format

Frames over 16 KB are sent in chunks; every binary message carries a uniform
4-byte chunk header:

```
[0..1]  chunkIndex   (u16 BE)
[1..3]  totalChunks  (u16 BE)
[4..n]  payload
```

After reassembling all chunks, the concatenated payload starts with a
12-byte custom frame header:

```
[0..3]  frameNum   (u32 BE)
[4..7]  timestamp  (u32 BE, ms since epoch)
[8]     flags      (0x01 = H.265, 0x02 = H.264)
[9]     keyframe   (0 / 1)
[10..11] reserved  (u16 BE)
```

…followed by raw Annex-B bytes (start codes + NAL units). On the first video
frame the server also sends a plain JSON announcement string on the
DataChannel:

```json
{ "type": "codec", "codec": "H264" | "H265", "width": 0, "height": 0 }
```

so the browser knows whether to wire WebCodecs or just play the RTP track.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `webrtc.preferredBackend` | `auto` | `auto` / `go2rtc` / `native` |
| `webrtc.stunServers` | Google STUN | Array of STUN URLs used for ICE gathering. |
| `webrtc.icePortRange` | (empty) | e.g. `"10000-10100"` to constrain UDP ports for firewall pinholes. Empty = ephemeral. |
| `webrtc.iceAdditionalHostAddresses` | (empty) | CSV of extra host IPs to advertise as ICE host candidates (useful in NAT'd / Docker `bridge` mode). |

Authentication: all `webrtc.*` tRPC procedures inherit the dashboard's
session/Bearer-token auth. No separate token is needed.

### Minimal browser snippet

```ts
// 1. ask the server for an offer
const { sessionId, offer } = await trpcMutation("webrtc.create", {
  cameraId: "studio",
  profile: "main",
});

// 2. accept the offer, build an answer
const pc = new RTCPeerConnection({ iceServers: [...] });
pc.ondatachannel = (ev) => { /* handle "video" (H.265) and "intercom" channels */ };
pc.ontrack = (ev) => { /* attach ev.streams[0] to a <video> for H.264/audio */ };
await pc.setRemoteDescription(offer);
const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);

// 3. ship the answer
await trpcMutation("webrtc.answer", { sessionId, sdp: answer });

// 4. tear down
await trpcMutation("webrtc.close", { sessionId });
```

A full reference implementation lives in
[`app/client/src/components/cameras/WebRTCInlinePlayer.tsx`](../app/client/src/components/cameras/WebRTCInlinePlayer.tsx),
including H.265 chunk reassembly, codec announcement handling, and the
WebCodecs canvas swap.

---

## Events (SSE, JSON stream)

Real-time events from all connected cameras (motion, doorbell, people, vehicle, animal, etc.).

### `GET /api/events/sse`

Server-Sent Events stream. Each event is sent as:
```
data: {"cameraId":"...","cameraName":"Living Room","cameraNameSlug":"living_room","type":"motion","channel":0,"timestamp":1705312800000,"timestampIso":"2024-01-15T10:00:00.000Z"}

```

**Headers:** `Content-Type: text/event-stream`

### `GET /api/events/stream`

NDJSON stream (one JSON object per line).

**Headers:** `Content-Type: application/x-ndjson`

### `GET /api/events/status`

Returns events manager status.

**Response:**
```json
{
  "sseClients": 2,
  "jsonStreamClients": 0,
  "mqttConnected": true,
  "registeredCameras": 3
}
```

### Event payload fields

| Field | Type | Description |
|-------|------|-------------|
| `cameraId` | string | Camera ID |
| `cameraName` | string | Human-readable name |
| `cameraNameSlug` | string | Sanitized name for URLs |
| `type` | string | Camera: `motion`, `doorbell`, `people`, `vehicle`, `animal`, `face`, `package`, `daynight`, etc. System: `camera_connected`, `camera_disconnected` |
| `channel` | number | Channel (0-based) |
| `timestamp` | number | Unix timestamp (ms) |
| `timestampIso` | string | ISO 8601 |

---

## MQTT Topics (when configured)

When MQTT is enabled in Settings, the Manager publishes to the broker. Default `topicPrefix` is `nodelink-js`.

### Event topics (events-manager)

| Topic | Payload | Description |
|-------|---------|--------------|
| `{topicPrefix}/{cameraNameSlug}/{type}` | JSON | Per-camera, per-event-type. Example: `nodelink-js/living_room/motion` |
| `{topicPrefix}/all` | JSON | All events from all cameras |

### Home Assistant topics (when HA integration enabled)

| Topic | Payload | Description |
|-------|---------|-------------|
| `{discoveryPrefix}/sensor/{uniqueId}/config` | JSON | MQTT discovery config (retained) |
| `{stateTopicPrefix}/camera/{cameraNameSlug}/state` | JSON | Camera device state (retained) |

---

## tRPC API

The Manager also exposes a tRPC API at `/api/trpc` for cameras, settings, logs, events, and go2rtc management. Use the tRPC panel at `/panel` (requires auth) to explore all procedures.

Key routers: `cameras`, `rtsp`, `go2rtc`, `settings`, `baichuan`, `events`, `logs`

---

[← Back to Main Documentation](./README.md)
