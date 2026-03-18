# Docker Deployment

This guide explains how to deploy **Nodelink.js Manager** using Docker.

## External Dependencies

The Docker image **already includes FFmpeg** (installed in the runtime stage), so you don't need to install it on the host when using Docker.

The image is based on **node:22-alpine**.

If you run the app directly on your machine (without Docker), make sure `ffmpeg` is installed and available in `PATH`.

## Quick Start

### Using Pre-built Image from GHCR (Recommended)

```bash
# Pull the latest image
docker pull ghcr.io/apocaliss92/nodelink-js-manager:latest

# Or pull a specific version
docker pull ghcr.io/apocaliss92/nodelink-js-manager:0.1.0

# Run the container
docker run -d \
  --name nodelink-manager \
  --network host \
  -v nodelink-data:/data \
  ghcr.io/apocaliss92/nodelink-js-manager:latest
```

### Using Docker Compose

```bash
# Download docker-compose.yml
wget https://raw.githubusercontent.com/apocaliss92/nodelink-js/main/docker-compose.yml

# Start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Build Locally

```bash
# Clone the repository
git clone https://github.com/apocaliss92/nodelink-js.git
cd nodelink-js

# Build the image
docker build -t nodelink-manager .

# Run the container
docker run -d \
  --name nodelink-manager \
  --network host \
  -v nodelink-data:/data \
  nodelink-manager
```

## Configuration

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Web UI and API port |
| `DATA_PATH` | `/data` | Directory for settings.json and logs |
| `GO2RTC_PATH` | (auto) | Path to go2rtc binary (falls back to bundled `go2rtc-static`) |
| `GO2RTC_API_PORT` | `11984` | go2rtc REST API + web dashboard port |
| `GO2RTC_RTSP_PORT` | `18554` | go2rtc RTSP output port |
| `GO2RTC_WEBRTC_PORT` | `18555` | go2rtc WebRTC ICE port |

**Dashboard authentication (optional):**

| Variable         | Default | Description                                                                                                             |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AUTH_ENABLED`   | (unset) | Enable auth when set to `1/true` (or disable with `0/false`). If unset, auth auto-enables when `ADMIN_PASSWORD` is set. |
| `ADMIN_PASSWORD` | (unset) | Sets the `admin` password. This credential works for both the web login form and HTTP Basic auth.                       |

SSO / reverse-proxy auth:

- Authentik + NGINX trusted proxy guide: [documentation/authentik-nginx.md](documentation/authentik-nginx.md)

## Network Mode

### Host Network (Default)

```yaml
network_mode: host
```

Benefits:

- Direct access to cameras on local network
- No port mapping required
- Better performance for RTSP streaming

### Bridge Network (Alternative)

If you prefer network isolation, modify `docker-compose.yml`:

```yaml
# Remove or comment out:
# network_mode: host

# Add:
ports:
  - "3000:3000"
  - "8554-8564:8554-8564"
```

### WebRTC in Bridge Mode (ICE / UDP Ports)

When using bridge mode, WebRTC needs **UDP ports** to be reachable from the browser.

If the container advertises ICE candidates that point to the container IP (e.g. `172.x.x.x`) or uses random UDP ports that are not mapped, WebRTC may never connect and you can see logs like:

```text
Video data channel not open for session ...: connecting
```

Recommended configuration:

1. Publish a dedicated UDP port range:

```yaml
ports:
  - "3000:3000" # Web UI and API
  - "8554:8554" # RTSP proxy
  - "50000-50100:50000-50100/udp" # WebRTC / ICE UDP
```

2. Tell the app to use (and advertise) the same range + a reachable host address:

```yaml
# Configure in Settings → WebRTC (ICE):
# - ICE UDP port range: 50000-50100
# - Additional host addresses: 192.168.1.123
```

Notes:

- The **Additional host addresses** setting should be the **host LAN IP** (or another IP reachable by the browser).
- If you use `network_mode: host`, you typically don’t need to publish a UDP range.

## Data Persistence

Data is persisted in the `nodelink-data` volume:

```bash
# Backup settings
docker cp nodelink-manager:/data/settings.json ./backup-settings.json

# Restore settings
docker cp ./backup-settings.json nodelink-manager:/data/settings.json
docker restart nodelink-manager
```

## Health Check

The container includes an automatic health check:

```bash
# Check status
docker inspect --format='{{.State.Health.Status}}' nodelink-manager

# Health endpoint
curl http://localhost:3000/health
```

## Updating

```bash
# Rebuild with new version
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Troubleshooting

### Logs

```bash
# Container logs
docker-compose logs -f nodelink-manager

# Application logs
docker exec nodelink-manager cat /data/logs/app-*.log
```

### Restart

```bash
docker-compose restart
```

### Shell into Container

```bash
docker exec -it nodelink-manager sh
```
