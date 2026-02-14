# Manager REST API

The nodelink-manager web application exposes a REST API for authentication, streaming, events, and system monitoring. All endpoints (except auth config and health) require authentication when `AUTH_ENABLED` is set.

**Base URL:** `http://HOST:3000` (or your configured port)

---

## Table of Contents

- [Authentication](#authentication)
- [Health & Updates](#health--updates)
- [Metrics](#metrics)
- [Streaming (MJPEG, HLS, WebRTC)](#streaming-mjpeg-hls-webrtc)
- [Events (SSE, JSON stream)](#events-sse-json-stream)
- [MQTT Topics](#mqtt-topics-when-configured)

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
    "nodeVersion": "v20.10.0",
    "uptimeSeconds": 3600,
    "memory": {
      "rss": 123456789,
      "heapUsed": 45678901,
      "heapTotal": 56789012,
      "external": 1234567,
      "arrayBuffers": 234567
    },
    "cpu": {
      "percent": 2.5,
      "userUs": 100000,
      "systemUs": 50000,
      "windowMs": 1000
    },
    "eventLoop": {
      "utilization": 0.1
    }
  },
  "system": {
    "cpuCount": 8,
    "loadAvg": [1.2, 1.1, 1.0],
    "totalMem": 17179869184,
    "freeMem": 8589934592
  }
}
```

---

## Streaming (MJPEG, HLS, WebRTC)

### MJPEG

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mpeg/:cameraName/:profile` | Start MJPEG stream (alias: `/api/stream/:cameraName/:profile`) |
| DELETE | `/api/mpeg/:cameraId/:profile` | Stop stream (legacy; streams auto-stop when no clients) |
| GET | `/api/mjpeg/status` | MJPEG stream status |

**Profiles:** `main`, `sub`, `ext`

**Auth:** `?token=YOUR_TOKEN` (query string) or session cookie

**Example:**
```
http://HOST:3000/api/mpeg/living_room/main?token=YOUR_TOKEN
```

### HLS

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/hls/:cameraName/:profile/:asset` | Playlist (`playlist.m3u8`) or segments (`segment_00001.ts`) |
| GET | `/api/hls/status` | HLS status |

**Auth:** `?token=YOUR_TOKEN` (query string) or session cookie

**Example:**
```
http://HOST:3000/api/hls/living_room/main/playlist.m3u8?token=YOUR_TOKEN
```

### WebRTC

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webrtc/session` | Create session (returns offer SDP) |
| POST | `/api/webrtc/session/:sessionId/answer` | Send answer SDP |
| POST | `/api/webrtc/session/:sessionId/ice` | Add ICE candidate |
| DELETE | `/api/webrtc/session/:sessionId` | Close session |
| GET | `/api/webrtc/status` | WebRTC status |

**Auth:** `Authorization: Bearer YOUR_TOKEN` header

**Create session request:**
```json
{
  "cameraName": "living_room",
  "profile": "main",
  "enableIntercom": false
}
```

**Create session response:**
```json
{
  "sessionId": "uuid-...",
  "offer": "v=0\r\n..."
}
```

**Answer request:**
```json
{
  "sdp": "v=0\r\n...",
  "type": "answer"
}
```

**ICE candidate request:**
```json
{
  "candidate": "candidate:...",
  "sdpMid": "0",
  "sdpMLineIndex": 0
}
```

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

**Example line:**
```json
{"cameraId":"...","cameraName":"Living Room","cameraNameSlug":"living_room","type":"motion","channel":0,"timestamp":1705312800000,"timestampIso":"2024-01-15T10:00:00.000Z"}
```

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
| `type` | string | Camera: `motion`, `doorbell`, `people`, `vehicle`, `animal`, `face`, `package`, `daynight`, etc. System: `camera_connected`, `camera_disconnected`, `stream_clients` |
| `channel` | number | Channel (0-based) |
| `timestamp` | number | Unix timestamp (ms) |
| `timestampIso` | string | ISO 8601 |
| `streamType` | string | (stream_clients only) `mjpeg`, `hls`, `webrtc`, `rtsp` |
| `profile` | string | (stream_clients only) `main`, `sub`, `ext` |
| `clientCount` | number | (stream_clients only) Number of connected clients |

---

## MQTT Topics (when configured)

When MQTT is enabled in Settings, the Manager publishes to the broker. Default `topicPrefix` is `nodelink-js`.

### Event topics (events-manager)

| Topic | Payload | Description |
|-------|---------|--------------|
| `{topicPrefix}/{cameraNameSlug}/{type}` | JSON | Per-camera, per-event-type. Example: `nodelink-js/living_room/motion` |
| `{topicPrefix}/all` | JSON | All events from all cameras (same payload as above) |

**Event types for `{type}`:**
- Camera: `motion`, `doorbell`, `people`, `vehicle`, `animal`, `face`, `package`, `daynight`, etc.
- System: `camera_connected`, `camera_disconnected`, `stream_clients`

**Examples:**
```
nodelink-js/living_room/motion
nodelink-js/garage/doorbell
nodelink-js/living_room/camera_connected
nodelink-js/living_room/camera_disconnected
nodelink-js/living_room/stream_clients
nodelink-js/all
```

Payload is the same JSON as SSE/stream (see [Event payload fields](#event-payload-fields)).

### Home Assistant topics (when HA integration enabled)

| Topic | Payload | Description |
|-------|---------|-------------|
| `{discoveryPrefix}/sensor/{uniqueId}/config` | JSON | MQTT discovery config (retained). `uniqueId` = `nodelink_{cameraId}` |
| `{stateTopicPrefix}/camera/{cameraNameSlug}/state` | JSON | Camera device state (retained). Polled at `pollIntervalSeconds` |

**Settings:**
- `discoveryPrefix` — default `homeassistant`
- `stateTopicPrefix` — defaults to `topicPrefix` (e.g. `nodelink-js`)

**Examples:**
```
homeassistant/sensor/nodelink_cam_123/config
nodelink-js/camera/living_room/state
```

State payload includes: `cameraId`, `cameraName`, `cameraNameSlug`, `channel`, `timestamp`, plus optional `info`, `batteryInfo`, `motionAlarm`, `aiState`, `wifiSignal`, etc.

---

## tRPC API

The Manager also exposes a tRPC API at `/api/trpc` for cameras, settings, logs, and events. Use the tRPC panel at `/panel` (requires auth) to explore procedures.

---

[← Back to Main Documentation](./README.md)
