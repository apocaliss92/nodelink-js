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
- Embedded SMTP intake for reliable motion alerts on battery cameras (see below)
- PWA support, responsive design

## Email Push for Battery Cameras

Battery cameras drop TCP/ONVIF push subscriptions while sleeping. The manager embeds an SMTP server so cameras can deliver alerts via e-mail — the most resilient path for sleep-heavy devices. Every accepted e-mail is parsed, classified (`MD` / `people` / `vehicle`), and emitted on the same event bus that native Baichuan push uses, so downstream consumers (Home Assistant, MQTT, Frigate adapters, the in-app events feed) see motion events transparently.

### Server pane — Settings → Email Push

The manager exposes the whole server lifecycle from this single pane:

- **Server status** (running, port, bind host, accepted/rejected counts, last error)
- **Connection settings** — port (default `2525`), bind host, virtual domain, max message size
- **Auth** — username + password used by cameras for `AUTH LOGIN/PLAIN`. Random `nodelink-<hex>` / 18-byte base64url credentials are generated on first boot; **Regenerate random credentials** rotates them in one click. The username is auto-wrapped as `<user@domain>` when written to the camera so MAIL FROM stays RFC-compliant.
- **TLS** — optional STARTTLS using `cert.pem`/`key.pem` from the configured TLS directory.
- **Recent events** — accordion list of the last 300 deliveries (timestamp, camera, inferred type, subject, body excerpt). One-row-per-event with on-demand details so it stays scrollable inside the modal.

Saving any field triggers a hot restart of the SMTP server — no manual stop/start needed.

### Per-camera pane — Camera modal → Email Push tab

Each camera has its own tab to wire the camera to the manager's intake:

1. **Auto-configure** — one click pushes the manager-side SMTP target (host, port, AUTH, recipient, sender nickname) and a 24/7 trigger schedule down to the camera over Baichuan. The recipient is `cam-<cameraId>@<domain>`; cameras hosted under an NVR don't show this tab (the NVR handles mail centrally).
2. **Send test e-mail** — asks the camera to perform a real SMTP send against its saved target. Returns within ~60s with success / 482 failure.
3. **Read current config** — shows what's actually on the camera (smtp server, port, recipient, schedule) so you can verify before/after Auto-configure.
4. **Manual edit** — every Baichuan e-mail field is exposed if you need to point the camera elsewhere or pre-fill it from the Reolink app yourself.

### Manual flow (no Auto-configure)

If you'd rather configure the camera from the Reolink app:

- **SMTP server**: the manager host's LAN address (the *Recommended camera-facing host* shown in the server pane)
- **Port**: `2525` (or whatever you changed it to)
- **Sender / username**: the auto-generated `nodelink-<hex>` (auto-wrapped to `<user@<domain>>` is also accepted)
- **Password**: from the Auth group
- **TLS**: off (unless you've configured certs)
- **Recipient**: `cam-<cameraId>@<domain>` — copy it from the camera's Email Push tab

### Persistence & data layout

- Server settings live in `settings.json` under the `emailPush.*` keys
- Recent events are kept in an in-memory ring (last 300) for the UI; they are not written to disk
- Snapshots attached to motion e-mails are kept in memory only — they're republished to MQTT (when configured) within the 5s per-camera debounce window and dropped afterwards

### Internals (since 0.4.32)

The manager doesn't subscribe to the email-push bus per-module any more. The Baichuan api created in `rtsp-manager` for each configured camera is constructed with `emailPushCameraId: camera.id`, and the lib auto-bridges every matching SMTP delivery into that api's `simpleEventListeners`. Both consumers (`events-manager` for SSE/JSON broadcast, `homeassistant-mqtt` for entity republish + snapshot capture) listen via the existing `api.onSimpleEvent` registration, so native Baichuan push and SMTP-delivered motion now flow through the same code path — fixing the snapshot republish regression on battery cameras that only deliver via SMTP ([#32](https://github.com/apocaliss92/nodelink-js/issues/32)).

See [../README.md#email-push-for-battery-cameras](../README.md#email-push-for-battery-cameras) and [../documentation/baichuan-api/email.md](../documentation/baichuan-api/email.md) for the underlying tRPC + Baichuan APIs.

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
