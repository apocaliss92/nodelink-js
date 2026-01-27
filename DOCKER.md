# Docker Deployment

This guide explains how to deploy the Reolink Dashboard application using Docker.

## Quick Start

### Build and Run with Docker Compose (Recommended)

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Manual Build

```bash
# Build the image
docker build -t reolink-dashboard .

# Run the container
docker run -d \
  --name reolink-dashboard \
  --network host \
  -v reolink-data:/data \
  reolink-dashboard
```

## Configuration

### Environment Variables

| Variable        | Default               | Description           |
| --------------- | --------------------- | --------------------- |
| `NODE_ENV`      | `production`          | Node.js environment   |
| `SETTINGS_PATH` | `/data/settings.json` | Settings file path    |
| `LOGS_PATH`     | `/data/logs`          | Logs directory        |

### Volumes

| Container Path        | Description                              |
| --------------------- | ---------------------------------------- |
| `/data`               | Persistent directory for settings & logs |
| `/data/settings.json` | Unified configuration file               |
| `/data/logs`          | Application logs directory               |

### Ports

| Port        | Description                    |
| ----------- | ------------------------------ |
| `3000`      | Web UI and API                 |
| `8554-8564` | RTSP port range (configurable) |

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

## Data Persistence

Data is persisted in the `reolink-data` volume:

```bash
# Backup settings
docker cp reolink-dashboard:/data/settings.json ./backup-settings.json

# Restore settings
docker cp ./backup-settings.json reolink-dashboard:/data/settings.json
docker restart reolink-dashboard
```

## Health Check

The container includes an automatic health check:

```bash
# Check status
docker inspect --format='{{.State.Health.Status}}' reolink-dashboard

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
docker-compose logs -f reolink-dashboard

# Application logs
docker exec reolink-dashboard cat /data/logs/app-*.log
```

### Restart

```bash
docker-compose restart
```

### Shell into Container

```bash
docker exec -it reolink-dashboard sh
```
