<table>
  <tr>
    <td><img src="app/client/public/icon-512x512.png" alt="nodelink.js" width="256" height="256"></td>
    <td>
      <h1>nodelink.js</h1>
      <p>A TypeScript library for interacting with Reolink IP cameras and NVRs using the proprietary Baichuan protocol and CGI API.</p>
    </td>
  </tr>
</table>

## Credits

This library is inspired by and based on the reverse engineering work done by:

- **[neolink](https://github.com/thirtythreeforty/neolink)** - Rust implementation of Baichuan protocol
- **[reolink_aio](https://github.com/starkillerOG/reolink_aio)** - Python async library for Reolink cameras

## Features

- 🔌 **Baichuan Native Protocol** - Direct binary protocol for low-level camera control
- 🌐 **CGI HTTP API** - RESTful API for camera configuration and management
- 📺 **RTSP Server** - Stream camera feeds via standard RTSP protocol
- 📡 **RFC 4571 Server** - Low-latency TCP streaming for home automation integrations
- 🎤 **Two-way Audio (Intercom)** - Full duplex audio communication
- 📹 **Video Clips & Recordings** - Download and manage recorded footage
- 🔍 **Device Discovery** - Automatic camera detection via UDP broadcast
- 🎯 **PTZ Control** - Pan, Tilt, Zoom, and Preset management
- 🔔 **Motion & AI Events** - Real-time event notifications and subscriptions
- 📷 **Multifocal Support** - Composite streams for dual-lens cameras (TrackMix, Duo)

---

## 🖥️ Manager UI (Web Dashboard)

The library includes a **complete web-based management interface** for easy camera configuration and streaming control without writing code.

<p align="center">
  <b>Features:</b>
</p>

- 🎛️ **Camera Management** - Add, configure, and monitor multiple cameras
- 📡 **NVR / Hub Support** - Add NVRs as first-class entities, discover channels, and manage child cameras. All cameras on an NVR share a single connection (like Scrypted). Connect/disconnect at the NVR level; add or remove cameras at any time via channel discovery
- 🔋 **Battery Camera Support** - Cameras are auto-detected as battery-powered when they emit sleep/wake events. Per-camera battery mode setting: **Stream Only** (default — camera sleeps when no stream clients) or **Always On** (stays awake while connected). Live awake/sleeping badge on each camera card. Controls and stream discovery are paused while the camera sleeps to avoid unnecessary wake-ups
- 💡 **Camera Controls** - Toggle floodlight, siren, floodlight-on-motion, siren-on-motion, PTZ auto-tracking, and PIR sensor directly from the camera card. PTZ directional controls and preset navigation via a dedicated modal
- 📹 **Live Streaming via go2rtc** - WebRTC, MSE/MP4, HLS, RTSP, and snapshot output powered by an embedded go2rtc restreamer. Stream options are cached so battery cameras show available streams even while sleeping
- 🔔 **Real-time Events** - Per-camera event viewer with live SSE updates (motion, doorbell, people, vehicle, animal, face, package, day/night, sleep/wake). Events are broadcast via SSE, NDJSON stream, and MQTT
- 📊 **Real-time Logs** - Monitor camera events, system logs, and go2rtc process output
- ⚙️ **Settings** - Configure go2rtc ports, auto-start options, MQTT broker, and Home Assistant discovery
- 📱 **PWA Support** - Install as a Progressive Web App on mobile devices
- 🌐 **Responsive Design** - Works on desktop, tablet, and mobile

### External Requirements

To run the Manager UI outside Docker, you need:

Some features also rely on external binaries that must be available on the host when running outside Docker:

Install examples:

```bash
# macOS
brew install ffmpeg

# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg
```

If you use the Docker image, FFmpeg is already included (see Docker Deployment below).

### Quick Start (Development)

```bash
cd app
npm install
npm run dev
```

### Production Build

```bash
cd app
npm run build
npm start
```

Open http://localhost:3000 in your browser.

### SSO (Authentik) via Trusted Proxy

See [documentation/authentik-nginx.md](documentation/authentik-nginx.md) for a step-by-step Authentik + NGINX setup and the required environment variables.

### Docker Deployment (Recommended)

The easiest way to run the Manager UI is with Docker:

```bash
# Using pre-built image
docker pull ghcr.io/apocaliss92/nodelink-js-manager:latest

docker run -d \
  --name nodelink-manager \
  --network host \
  -v nodelink-data:/data \
  ghcr.io/apocaliss92/nodelink-js-manager:latest
```

Or with Docker Compose:

```bash
docker-compose up -d
```

#### WebRTC in Docker (bridge network)

If you run the container in **bridge** mode (i.e. with `ports:` mappings), WebRTC needs two things to work reliably:

1. **A fixed UDP port range** exposed from container → host.
2. ICE candidates that contain an address the browser can reach (usually your **host LAN IP**) — configured in **Settings → WebRTC (ICE)**.

Otherwise WebRTC may get stuck and you may see warnings like:

```text
Video data channel not open for session ...: connecting
```

Recommended example:

```yaml
services:
  nodelink-manager:
    ports:
      - "3000:3000"   # Web UI and API
      - "11984:11984"  # go2rtc API + dashboard
      - "18554:18554"  # go2rtc RTSP output
      - "18555:18555/udp" # go2rtc WebRTC ICE
    # Then configure Settings → go2rtc:
    # - ICE servers if needed for NAT traversal
```

Notes:

- The **Additional host addresses** setting should be an IP address that your browser can reach (typically the host machine IP on your LAN).
- If you use `network_mode: host`, you usually **don’t need** any of the above (no port mapping).

**Environment Variables:**

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `DATA_PATH` | `/data` | Directory for settings.json and logs |
| `GO2RTC_PATH` | (auto) | Path to go2rtc binary (falls back to bundled `go2rtc-static`) |
| `GO2RTC_API_PORT` | `11984` | go2rtc REST API + web dashboard port |
| `GO2RTC_RTSP_PORT` | `18554` | go2rtc RTSP output port |
| `GO2RTC_WEBRTC_PORT` | `18555` | go2rtc WebRTC ICE port |

Environment variables override `settings.json` values. Ports are also configurable in Settings → go2rtc.

**WebRTC / ICE (Docker bridge mode):**

- Configure the UDP port mapping in Docker.
- Configure ICE options in **Settings → WebRTC (ICE)**.

**Dashboard authentication (optional):**

| Variable         | Default | Description                                                                                                             |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AUTH_ENABLED`   | (unset) | Enable auth when set to `1/true` (or disable with `0/false`). If unset, auth auto-enables when `ADMIN_PASSWORD` is set. |
| `ADMIN_PASSWORD` | (unset) | Sets the `admin` password. This credential works for both the web login form and HTTP Basic auth.                       |

### Streaming via go2rtc

All streaming is handled by an embedded **go2rtc** process (default API port `11984`, RTSP port `18554`). go2rtc provides:

| Format | URL | Notes |
|--------|-----|-------|
| **WebRTC** | `POST http://HOST:11984/api/webrtc?src={name}` | WHEP signaling (SDP offer/answer) |
| **MSE/MP4** | `http://HOST:11984/api/stream.mp4?src={name}` | Fragmented MP4 for browsers |
| **HLS** | `http://HOST:11984/api/stream.m3u8?src={name}` | Adaptive streaming |
| **RTSP** | `rtsp://HOST:18554/{name}` | For VLC, ffmpeg, NVR software |
| **Snapshot** | `http://HOST:11984/api/frame.jpeg?src={name}` | Single JPEG (requires ffmpeg) |
| **Dashboard** | `http://HOST:11984/` | go2rtc web UI |

Stream names follow the pattern `{sanitized_camera_name}_{profile}` (e.g. `studio_main`, `garage_sub`).

go2rtc has CORS enabled (`origin: "*"`) so browser-based players can connect directly.

### Authentication

When authentication is enabled (see `AUTH_ENABLED` / `ADMIN_PASSWORD`), the Manager API endpoints are protected. go2rtc streaming endpoints are currently unauthenticated (accessible on the local network).

- Manager API: `Authorization: Bearer <token>` header or session cookie
- WebSocket logs: `?token=...` in the WS URL

Examples:

```bash
# RTSP via go2rtc (no auth)
ffmpeg -rtsp_transport tcp -i “rtsp://HOST:18554/studio_main” -f null -
vlc “rtsp://HOST:18554/studio_main”

# WebRTC WHEP signaling
curl -X POST “http://HOST:11984/api/webrtc?src=studio_main” \
  -H “Content-Type: application/sdp” \
  --data-binary @offer.sdp

# Snapshot
curl -o snap.jpg “http://HOST:11984/api/frame.jpeg?src=studio_main”

# WebSocket logs (auth)
ws://HOST:3000/ws/logs?token=YOUR_TOKEN
```

If authentication is disabled, these endpoints work without credentials.

Tip: a personal token is ideal for integrations (Home Assistant, scripts, etc.) because it does not expire.

📖 **[Full Docker documentation →](./DOCKER.md)**

---

## Manager REST API

The Manager UI exposes a REST API for integrations, scripts, and third-party apps. Key endpoints:

| Category | Endpoints |
|----------|-----------|
| **Auth** | `GET /api/auth/config`, `POST /api/auth/login`, `POST /api/auth/personal-token` |
| **go2rtc Streaming** | Served directly by go2rtc (default port `11984`): WebRTC, MSE/MP4, HLS, RTSP, Snapshot |
| **go2rtc Management** | tRPC: `go2rtc.start`, `go2rtc.stop`, `go2rtc.status`, `go2rtc.listStreams` |
| **Events** | `GET /api/events/sse` (SSE), `GET /api/events/stream` (NDJSON), `GET /api/events/status` |
| **System** | `GET /api/health`, `GET /api/metrics`, `GET /api/updates` |

**Streaming** — All video output (WebRTC, MSE, HLS, RTSP, snapshots) is handled by an embedded go2rtc restreamer. The Manager creates internal RTSP servers per stream and registers them with go2rtc, which provides multi-format output with audio support.

**Events** — Real-time camera events (motion, doorbell, people, vehicle, etc.) via Server-Sent Events or NDJSON stream. When MQTT is configured, events are also published to the broker.

📖 **[Full Manager API documentation →](./documentation/manager-api.md)**

---

## 📚 Full API Documentation

For detailed method-by-method documentation, see the [documentation](./documentation/) folder:

### Baichuan Protocol API

| Section                                                    | Description                                     |
| ---------------------------------------------------------- | ----------------------------------------------- |
| [**Overview**](./documentation/baichuan-api/README.md)     | API overview and quick start                    |
| [Connection](./documentation/baichuan-api/connection.md)   | Login, logout, ping, reboot, dedicated sessions |
| [Device Info](./documentation/baichuan-api/device-info.md) | Device information, channels, capabilities      |
| [Streaming](./documentation/baichuan-api/streaming.md)     | Live video streams, codec configuration         |
| [Recordings](./documentation/baichuan-api/recordings.md)   | Search, download, replay recorded clips         |
| [PTZ Control](./documentation/baichuan-api/ptz.md)         | Pan, tilt, zoom, presets                        |
| [Events](./documentation/baichuan-api/events.md)           | Motion, AI, doorbell event subscriptions        |
| [Intercom](./documentation/baichuan-api/intercom.md)       | Two-way audio, talk sessions                    |
| [Snapshots](./documentation/baichuan-api/snapshots.md)     | Capture images, thumbnails                      |
| [Detection](./documentation/baichuan-api/detection.md)     | Motion, AI, PIR, autotracking settings          |
| [Lights & Chime](./documentation/baichuan-api/lights.md)   | Spotlight, floodlight, siren, chime/DingDong    |
| [Battery](./documentation/baichuan-api/battery.md)         | Battery status, sleep/wake management           |
| [OSD](./documentation/baichuan-api/osd.md)                 | On-screen display configuration                 |
| [Network](./documentation/baichuan-api/network.md)         | Network, WiFi, storage, system settings         |

### CGI HTTP API

| Section                                                    | Description                         |
| ---------------------------------------------------------- | ----------------------------------- |
| [**CGI API Reference**](./documentation/cgi-api/README.md) | Complete HTTP/CGI API documentation |

### Additional Features

| Section                                           | Description                           |
| ------------------------------------------------- | ------------------------------------- |
| [**Manager REST API**](./documentation/manager-api.md) | HTTP API for auth, streaming, events, metrics |
| [Streaming Servers](./documentation/streaming.md) | RTSP, RFC4571, HTTP streaming servers |
| [Network Discovery](./documentation/discovery.md) | Automatic camera discovery via UDP    |

---

## Installation

```bash
npm install @apocaliss92/nodelink-js
```

## Quick Start

### Baichuan Native API

The Baichuan API provides direct access to camera functions through the proprietary binary protocol:

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000, // Baichuan port
  username: "admin",
  password: "your-password",
});

await api.login();

// Get device info
const deviceInfo = await api.getDeviceInfo();
console.log("Camera:", deviceInfo.name, deviceInfo.model);

// Get stream info
const streamInfo = await api.getStreamInfoList();

// Subscribe to events
api.onMotionAlarm((event) => {
  console.log("Motion detected:", event);
});

await api.close();
```

📖 **[View full Baichuan API documentation →](./documentation/baichuan-api/README.md)**

### CGI HTTP API

The CGI API provides HTTP-based access for configuration and management:

```typescript
import { ReolinkCgiApi } from "@apocaliss92/nodelink-js";

const cgi = new ReolinkCgiApi({
  host: "192.168.1.100",
  port: 80, // HTTP port
  username: "admin",
  password: "your-password",
});

// Get device info
const info = await cgi.getDevInfo();

// Get recording files
const recordings = await cgi.searchRecordings({
  startTime: new Date("2024-01-01"),
  endTime: new Date("2024-01-02"),
  channel: 0,
});

// Get encoding settings
const enc = await cgi.getEnc(0);
```

📖 **[View full CGI API documentation →](./documentation/cgi-api/README.md)**

## Streaming

### RTSP Server

Create a local RTSP server that restreams camera feeds:

```typescript
import {
  BaichuanRtspServer,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

const rtspServer = new BaichuanRtspServer({
  api,
  profile: "main", // main, sub, or ext
  channel: 0,
  port: 8554,
  logger: console,
});

await rtspServer.start();
// Stream available at rtsp://localhost:8554/stream
```

### RFC 4571 Server

Low-latency TCP streaming optimized for home automation systems like Scrypted:

```typescript
import {
  createRfc4571TcpServer,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

const server = await createRfc4571TcpServer({
  api,
  profile: "main",
  channel: 0,
  host: "0.0.0.0",
  logger: console,
  username: "admin",
  password: "your-password",
});

// Connect your home automation system to the server
```

## Two-Way Audio (Intercom)

Send and receive audio for intercom functionality:

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

// Start talk session
await api.startTalk();

// Send audio data (raw PCM or G.711)
await api.sendTalkAudio(audioBuffer);

// Stop talk session
await api.stopTalk();
```

## Video Clips & Recordings

Download and manage recorded video clips:

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

// Search recordings by date
const recordings = await api.searchRecordings({
  channel: 0,
  startTime: new Date("2024-01-01"),
  endTime: new Date("2024-01-02"),
});

// Download a recording
const stream = await api.downloadRecording(recordings[0].filename);

// Pipe to file
import { createWriteStream } from "node:fs";
stream.pipe(createWriteStream("recording.mp4"));
```

## Device Discovery

Automatically discover cameras on your network:

```typescript
import { AutodiscoveryClient } from "@apocaliss92/nodelink-js";

const discovery = new AutodiscoveryClient();

discovery.on("device", (device) => {
  console.log("Found camera:", device.ip, device.name, device.uid);
});

await discovery.startDiscovery();

// Stop after 10 seconds
setTimeout(() => {
  discovery.stopDiscovery();
}, 10000);
```

## PTZ Control

Control Pan-Tilt-Zoom cameras:

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

// Move camera
await api.ptzControl({ channel: 0, command: "Right", speed: 32 });
await api.ptzControl({ channel: 0, command: "Stop" });

// Go to preset
await api.ptzGotoPreset({ channel: 0, preset: 1 });

// Get current position
const position = await api.getPtzPosition(0);

// Zoom control
await api.setZoomFocus({ channel: 0, zoom: { pos: 100 } });
```

## Events & Notifications

Subscribe to real-time camera events:

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

// Subscribe to motion events
api.onMotionAlarm((event) => {
  console.log("Motion:", event.state, "at channel", event.channel);
});

// Subscribe to AI events (person, vehicle, pet, etc.)
api.onAiAlarm((event) => {
  console.log("AI detection:", event.type, event.state);
});

// Subscribe to doorbell events
api.onVisitor((event) => {
  console.log("Visitor detected");
});
```

## NVR & Multi-Channel Support

Work with NVRs and their connected channels:

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

// Get all channels info
const channels = await api.getChannelInfoAll();

// Stream from a specific channel
const rtspServer = new BaichuanRtspServer({
  api,
  profile: "main",
  channel: 2, // Channel index
  port: 8554,
  logger: console,
});
```

## Configuration

### Environment Variables

Create a `.env` file based on `env.template`:

```env
CAMERA_HOST=192.168.1.100
CAMERA_PORT=9000
CAMERA_USERNAME=admin
CAMERA_PASSWORD=your-password
```

### Logging

The library supports custom loggers:

```typescript
import { ReolinkBaichuanApi, createLogger } from "@apocaliss92/nodelink-js";

const logger = createLogger({ level: "debug" });

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
  logger,
});
```

## CLI Tools

### RTSP Server

Run a standalone RTSP server:

```bash
npm run rtsp-server
```

Configure via environment variables:

- `CAMERA_HOST` - Camera IP address
- `CAMERA_PORT` - Baichuan port (default: 9000)
- `CAMERA_USERNAME` - Username
- `CAMERA_PASSWORD` - Password
- `RTSP_PORT` - RTSP server port (default: 8554)

## Supported Devices

This library has been tested with:

- Reolink IP cameras (RLC series, E1 series, Argus series)
- Reolink NVRs (RLN series)
- Reolink Home Hub
- Reolink TrackMix and Duo (multifocal cameras)
- Reolink battery cameras (Argus, TrackMix WiFi Battery)

## API Reference

📖 **Full API documentation available in the [documentation](./documentation/) folder.**

- [Baichuan Protocol API](./documentation/baichuan-api/README.md) - Binary protocol (port 9000)
- [CGI HTTP API](./documentation/cgi-api/README.md) - HTTP REST API (port 80)
- [Manager REST API](./documentation/manager-api.md) - Web dashboard HTTP API (auth, streaming, events, metrics)
- [Streaming Servers](./documentation/streaming.md) - RTSP, RFC4571, HTTP servers
- [Network Discovery](./documentation/discovery.md) - UDP autodiscovery

## Disclaimer

This project is **not affiliated with, endorsed by, or connected to Reolink** in any way.

"Reolink" is a trademark of Reolink Innovation Inc.

This is an independent, community-driven open-source project created for **interoperability purposes** — enabling users to integrate their own Reolink devices with third-party home automation systems and custom applications.

No proprietary code, firmware, or copyrighted materials from Reolink are included in this project. The protocol implementation is based on publicly available reverse engineering efforts from the community.
