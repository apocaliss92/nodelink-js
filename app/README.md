# Reolink API Tester & RTSP Manager

A simple web UI to test all Reolink API methods and manage RTSP streams.

## Features

- 🧪 **API Tester** - Interactive UI to test all Baichuan API methods
- 📹 **RTSP Manager** - Configure and manage RTSP streaming servers
- 💾 **Config Persistence** - Camera and server configurations saved to JSON
- 🔌 **Connection Pooling** - Automatic connection management with timeout

## Quick Start

```bash
# Install dependencies
npm install

# Dev (React + Vite + API server)
# - React UI: http://localhost:5173
# - API server: http://localhost:3000
npm run dev

# Or start production server
npm run build && npm start
```

In production mode, open http://localhost:3000.

## API Endpoints

### tRPC Panel UI

- `http://localhost:3000/panel` - Interactive UI to test all methods

### tRPC API

- `http://localhost:3000/api/trpc` - tRPC endpoint for programmatic access

## Configuration

Cameras and RTSP servers are stored in `config.json`:

```json
{
  "cameras": [
    {
      "id": "cam_1",
      "name": "Front Door",
      "host": "192.168.1.100",
      "port": 9000,
      "username": "admin",
      "password": "password123",
      "channels": 1
    }
  ],
  "rtspServers": [
    {
      "id": "rtsp_1",
      "cameraId": "cam_1",
      "channel": 0,
      "profile": "main",
      "port": 8554,
      "enabled": true
    }
  ]
}
```

## Available API Methods

### Configuration (`config.*`)

- `listCameras` - List all configured cameras
- `addCamera` - Add a new camera
- `updateCamera` - Update camera settings
- `deleteCamera` - Remove a camera
- `testCamera` - Test camera connection
- `listRtspServers` - List all RTSP server configs
- `addRtspServer` - Add new RTSP server
- `startRtspServer` - Start an RTSP server
- `stopRtspServer` - Stop an RTSP server
- `startAllRtspServers` - Start all configured servers
- `stopAllRtspServers` - Stop all running servers

### Baichuan API (`baichuan.*`)

- `getDeviceInfo` - Get device information
- `getAbility` - Get device capabilities
- `getStreamInfoList` - Get available streams
- `getChannelStatus` - Get channel connection status
- `searchRecordings` - Search recorded video clips
- `getSnapshot` - Capture a snapshot
- `ptzControl` - Send PTZ commands
- `getPtzPresets` - Get PTZ presets
- `ptzGotoPreset` - Go to preset position
- `getMotionDetection` - Get motion detection settings
- `setMotionDetection` - Configure motion detection
- `getWhiteLed` - Get spotlight settings
- `setWhiteLed` - Control spotlight
- `triggerSiren` - Activate siren
- `getBatteryInfo` - Get battery status
- And many more...

## Environment Variables

- `PORT` - Server port (default: 3000)

## Development

```bash
# Watch mode with hot reload
npm run dev

# Build for production
npm run build
```
