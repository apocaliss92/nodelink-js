# Manager UI (Web Dashboard)

A **complete web-based management interface** for camera configuration and streaming control without writing code. Built with Express + tRPC + React on top of the [`@apocaliss92/nodelink-js`](../README.md) library.

## Features

- Camera management with NVR/Hub support and channel discovery
- Battery camera support with auto-detection, sleep/wake events, and per-camera mode
- Camera controls: floodlight, siren, PTZ, auto-tracking, PIR sensor
- Live streaming via embedded go2rtc (WebRTC, MSE/MP4, HLS, RTSP, snapshots)
- Real-time events via SSE, NDJSON stream, and MQTT
- Real-time logs and go2rtc process output
- Settings for go2rtc ports, MQTT broker, and Home Assistant discovery
- PWA support, responsive design

## Docker Deployment (Recommended)

```bash
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

### WebRTC in Docker (bridge network)

If you run the container in **bridge** mode (i.e. with `ports:` mappings), WebRTC needs:

1. **A fixed UDP port range** exposed from container to host.
2. ICE candidates with a reachable address (usually your **host LAN IP**) — configured in **Settings -> WebRTC (ICE)**.

```yaml
services:
  nodelink-manager:
    ports:
      - "3000:3000"   # Web UI and API
      - "11984:11984"  # go2rtc API + dashboard
      - "18554:18554"  # go2rtc RTSP output
      - "18555:18555/udp" # go2rtc WebRTC ICE
```

With `network_mode: host`, no port mapping is needed.

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `DATA_PATH` | `/data` | Directory for settings.json and logs |
| `GO2RTC_PATH` | (auto) | Path to go2rtc binary (falls back to bundled `go2rtc-static`) |
| `GO2RTC_API_PORT` | `11984` | go2rtc REST API + web dashboard port |
| `GO2RTC_RTSP_PORT` | `18554` | go2rtc RTSP output port |
| `GO2RTC_WEBRTC_PORT` | `18555` | go2rtc WebRTC ICE port |
| `AUTH_ENABLED` | (unset) | Enable auth when set to `1/true`. Auto-enables when `ADMIN_PASSWORD` is set. |
| `ADMIN_PASSWORD` | (unset) | Sets the `admin` password for web login and HTTP Basic auth. |

Environment variables override `settings.json` values. Ports are also configurable in Settings.

## Development (without Docker)

```bash
# Requires ffmpeg installed on host (brew install ffmpeg / apt install ffmpeg)
npm install
npm run dev        # Development mode (server + client with hot reload)
# or
npm run build && npm start   # Production build
```

Open http://localhost:3000 in your browser.

## Streaming via go2rtc

All streaming is handled by an embedded **go2rtc** process:

| Format | URL | Notes |
|--------|-----|-------|
| **WebRTC** | `POST http://HOST:11984/api/webrtc?src={name}` | WHEP signaling |
| **MSE/MP4** | `http://HOST:11984/api/stream.mp4?src={name}` | Fragmented MP4 |
| **HLS** | `http://HOST:11984/api/stream.m3u8?src={name}` | Adaptive streaming |
| **RTSP** | `rtsp://HOST:18554/{name}` | For VLC, ffmpeg, NVR software |
| **Snapshot** | `http://HOST:11984/api/frame.jpeg?src={name}` | Single JPEG (requires ffmpeg) |
| **Dashboard** | `http://HOST:11984/` | go2rtc web UI |

Stream names follow the pattern `{sanitized_camera_name}_{profile}` (e.g. `studio_main`, `garage_sub`).

## Authentication

When enabled, Manager API endpoints require `Authorization: Bearer <token>` or session cookie. go2rtc streaming endpoints are unauthenticated (local network only).

```bash
# RTSP via go2rtc (no auth)
ffmpeg -rtsp_transport tcp -i "rtsp://HOST:18554/studio_main" -f null -

# Snapshot
curl -o snap.jpg "http://HOST:11984/api/frame.jpeg?src=studio_main"
```

## SSO (Authentik) via Trusted Proxy

See [../documentation/authentik-nginx.md](../documentation/authentik-nginx.md) for Authentik + NGINX setup.

## REST API

| Category | Endpoints |
|----------|-----------|
| **Auth** | `GET /api/auth/config`, `POST /api/auth/login`, `POST /api/auth/personal-token` |
| **go2rtc Streaming** | Served directly by go2rtc (port `11984`): WebRTC, MSE/MP4, HLS, RTSP, Snapshot |
| **go2rtc Management** | tRPC: `go2rtc.start`, `go2rtc.stop`, `go2rtc.status`, `go2rtc.listStreams` |
| **Events** | `GET /api/events/sse` (SSE), `GET /api/events/stream` (NDJSON), `GET /api/events/status` |
| **System** | `GET /api/health`, `GET /api/metrics`, `GET /api/updates` |

Full documentation: **[Manager API Reference](../documentation/manager-api.md)** | **[Docker documentation](../DOCKER.md)**
