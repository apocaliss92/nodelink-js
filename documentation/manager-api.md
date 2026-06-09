# Manager REST API

The nodelink-manager web application exposes a REST API for authentication, events, and system monitoring. All endpoints (except auth config and health) require authentication when `AUTH_ENABLED` is set.

**Base URL:** `http://HOST:3000` (or your configured port)

---

## Table of Contents

- [Authentication](#authentication)
- [Health & Updates](#health--updates)
- [Metrics](#metrics)
- [Streaming (RTSP + WebRTC)](#streaming-rtsp--webrtc)
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

## Streaming (RTSP + WebRTC)

The manager exposes camera video in two ways:

1. **RTSP** — every camera/profile is published through a single shared TCP listener (`LocalRtspMux`). External consumers (Frigate, Home Assistant, VLC, NVR software) consume the camera over this URL.
2. **WebRTC** — in-process server (`BaichuanWebRTCServer`, werift) used by the UI's inline preview and any browser that needs sub-second latency. Driven through tRPC, no intermediate restreamer.

Snapshots are taken straight from the camera's own CGI endpoint — the manager does not transcode or cache JPEGs.

### Architecture

```
                                ┌─ Profile main ─┐
Camera ── Baichuan Protocol ────┼─ Profile sub  ─┼─▶ LocalRtspMux (TCP 8554)
                                └─ Profile ext  ─┘        │
                                                          ├─▶ rtsp://HOST:8554/{cameraName}/{profile}   (video)
                                                          └─▶ rtsp://HOST:8554/{cameraName}              (talk, optional)

Camera ── Baichuan Protocol ───▶ BaichuanWebRTCServer ──▶ tRPC webrtc.* ──▶ Browser <video>
```

All camera profiles share the same RTSP port; clients pick the profile via the URL path.

### Ports & Settings

| Service | Default | Setting | Description |
|---------|---------|---------|-------------|
| Manager UI/API | `3000` | `PORT` env / `settings.port` | Express + tRPC |
| Shared RTSP mux | `8554` | `settings.localRtsp.port` | Video for every camera, plus the optional talk backchannel on the same port |
| Talk backchannel | (off) | `settings.talk.enabled` | When `true`, exposes `rtsp://HOST:8554/{cameraName}` (no profile) for Frigate-style two-way audio |
| WebRTC ICE UDP range | (ephemeral) | `settings.webrtc.icePortRange` | e.g. `"50000-50100"` for firewall/Docker bridge mode |
| WebRTC extra hosts | (empty) | `settings.webrtc.iceAdditionalHostAddresses` | CSV of additional host IPs to advertise as ICE candidates |
| Data directory | `.` | `DATA_PATH` env | Settings file + logs |

There are no environment variables for the RTSP port or WebRTC — those are set through the dashboard's **Settings -> RTSP** and **Settings -> WebRTC (ICE)** panels.

### RTSP URLs

| Output | URL | Notes |
|--------|-----|-------|
| **Video** | `rtsp://HOST:8554/{cameraName}/{profile}` | `{profile}` ∈ `main` / `sub` / `ext`. `{cameraName}` is the sanitized camera slug (lowercase, no spaces). |
| **Talk backchannel** | `rtsp://HOST:8554/{cameraName}` | No profile in the path. Off by default — enable in **Settings -> RTSP -> "RTSP Backchannel"**. Used by Frigate's RTSP RECORD for two-way audio. |

The camera slug is the same one used everywhere else in the manager: event payloads (`cameraNameSlug`), MQTT topics, and Home Assistant discovery.

For multi-channel devices (NVR / Hub), each child camera has its own slug — the URL doesn't carry a channel index.

### Authentication on the RTSP mux

By default the RTSP mux is unauthenticated and only intended for the LAN. Set `settings.localRtsp.requireAuth: true` to make the mux demand the camera credentials over RTSP Basic/Digest. The talk backchannel inherits the same setting.

### Removed outputs

The following endpoints existed in earlier builds and are gone:

- HLS (`/api/stream.m3u8`)
- MJPEG / MJPEG snapshot (`/api/stream.mjpeg`, `/api/frame.jpeg`)
- MSE / fMP4 (`/api/stream.mp4`)
- Any transcoded snapshot endpoint
- The `restreamer`, `settings.go2rtc.*`, and `webrtc.preferredBackend` settings

For browser previews use the WebRTC tRPC flow below; for everything else use the RTSP URLs above. Snapshots come straight from the camera's CGI (`/cgi-bin/api.cgi?cmd=Snap...`).

---

## WebRTC preview

The Manager runs an in-process WebRTC server (`BaichuanWebRTCServer` from the library) that streams native Baichuan frames straight to the browser — no intermediate RTSP/MSE hop. It powers the dashboard's inline preview and any custom client that wants sub-second latency with frame-accurate overlays (e.g. AI detection boxes).

### Signaling flow (server-driven offer)

The native server **generates the offer**. The browser answers, sets the local description, and optionally trickles ICE candidates back. Every step is a tRPC call:

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

The Manager also exposes a tRPC API at `/api/trpc` for cameras, settings, logs, events, RTSP lifecycle, and WebRTC preview signaling. Use the tRPC panel at `/panel` (requires auth) to explore all procedures.

Key routers: `cameras`, `rtsp`, `webrtc`, `settings`, `baichuan`, `events`, `logs`

---

[← Back to Main Documentation](./README.md)
