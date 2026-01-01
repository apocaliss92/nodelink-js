# @reolink/baichuan-js

TypeScript library implementing Reolink Baichuan protocol (control + streaming) with CGI and RTSP helpers. Full TypeScript support with comprehensive type definitions.

## Features

- ✅ **Full TypeScript support** with comprehensive type definitions
- ✅ **Baichuan Protocol** (TCP/UDP) for camera control and streaming
- ✅ **CGI/REST API** support for HTTP-based operations
- ✅ **Hybrid API** with automatic fallback (Baichuan → CGI)
- ✅ **Video/Audio Streaming** with H.264 decoding support
- ✅ **RTSP Server** and HTTP MPEG-TS proxy
- ✅ **NVR Support** for multi-channel systems
- ✅ **Battery Camera Support** via BCUDP (UDP protocol)
- ✅ **PTZ Control** (pan, tilt, zoom, presets)
- ✅ **Event Subscriptions** (motion, AI detection)
- ✅ **Two-way Audio** support
- ✅ **Device Abilities** detection

## Installation

```bash
npm install @reolink/baichuan-js
```

## Quick Start

### Basic Usage (Baichuan API)

```typescript
import { ReolinkBaichuanApi } from "@reolink/baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.50",
  username: "admin",
  password: "your-password",
  transport: "tcp", // or "udp" for battery cameras
});

await api.login();

// Get device info
const devInfo = await api.GetDevInfo();

// Get PTZ presets
const presets = await api.getPtzPresets(0);

// Move to preset
await api.moveToPtzPreset(0, 1);

// Get device abilities
const abilities = await api.getAbilityInfo("admin");

await api.close();
```

### Hybrid API (Automatic Fallback)

```typescript
import { ReolinkHybridApi } from "@reolink/baichuan-js";

const api = new ReolinkHybridApi({
  cgi: {
    host: "192.168.1.50",
    username: "admin",
    password: "your-password",
    useHttps: false,
  },
  baichuan: {
    host: "192.168.1.50",
    username: "admin",
    password: "your-password",
    transport: "tcp",
  },
});

await api.login();

// Tries Baichuan first, falls back to CGI if needed
const devInfo = await api.GetDevInfo();
await api.Reboot();

await api.close();
```

### Video Streaming

```typescript
import { ReolinkBaichuanApi } from "@reolink/baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.50",
  username: "admin",
  password: "your-password",
});

await api.login();

// Subscribe to video stream
const stream = await api.subscribeVideoStream({
  channel: 0,
  profile: "main", // or "sub", "ext"
});

stream.on("videoFrame", (frame) => {
  // frame.data contains H.264 Annex-B bytes
  // frame.isKeyframe indicates if it's an I-frame
  console.log(`Received frame: ${frame.data.length} bytes, keyframe: ${frame.isKeyframe}`);
});

stream.on("audioFrame", (frame) => {
  // frame.data contains audio data
  console.log(`Received audio: ${frame.data.length} bytes`);
});

// Stop streaming
await stream.stop();
await api.close();
```

### Battery Cameras (BCUDP)

```typescript
import { ReolinkBaichuanApi } from "@reolink/baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "255.255.255.255", // Broadcast for discovery
  username: "admin",
  password: "your-password",
  uid: "YOUR_CAMERA_UID",
  transport: "udp",
});

await api.login();
// Use API as normal...
```

### RTSP Server

```typescript
import { createRtspProxyServer } from "@reolink/baichuan-js";

const server = createRtspProxyServer({
  listenPort: 8080,
  host: "192.168.1.50",
  username: "admin",
  password: "your-password",
  rtspTransport: "tcp",
});

server.listen(8080);
// Access via: rtsp://localhost:8080/stream?channel=0&profile=main
```

## API Reference

### ReolinkBaichuanApi

Main API for Baichuan protocol operations.

#### Methods

- `login()` - Authenticate with camera
- `GetDevInfo()` - Get device information
- `getPtzPresets(channel)` - Get PTZ presets
- `moveToPtzPreset(channel, presetId)` - Move to PTZ preset
- `setPtzPreset(channel, presetId, name)` - Save current position as preset
- `ptz(channel, command)` - Send PTZ control command
- `getBatteryInfo(channel)` - Get battery status (battery cameras)
- `getPirInfo(channel)` - Get PIR sensor state
- `setPirInfo(channel, params)` - Set PIR sensor state
- `setMotionDetection(channel, enabled, sensitivity?)` - Configure motion detection
- `setAiDetection(channel, aiType, sensitivity?, stayTime?)` - Configure AI detection
- `getSiren(channel?)` - Get siren/audio alarm status
- `setSiren(channel?, on?, duration?)` - Control siren/audio alarm
- `getWhiteLedState(channel)` - Get white LED/floodlight state
- `setWhiteLedState(channel, on?, brightness?)` - Control white LED/floodlight
- `getAbilityInfo(username)` - Get device capabilities
- `subscribeVideoStream(options)` - Subscribe to video/audio stream
- `subscribeEvents()` - Subscribe to camera events (motion, AI)
- `close()` - Close connection

### ReolinkCgiApi

HTTP/REST API for camera operations.

### ReolinkHybridApi

Hybrid API that tries Baichuan first, falls back to CGI.

### Types

All TypeScript types are exported from the main module:

```typescript
import type {
  PtzPreset,
  PtzCommand,
  BatteryInfo,
  PirState,
  WhiteLedState,
  AbilityInfo,
  DeviceAbilities,
  StreamMetadata,
  ReolinkEvent,
  // ... and more
} from "@reolink/baichuan-js";
```

## Examples

See the `test/` directory for comprehensive examples:
- `test/tcp/test-tcp-new-apis.ts` - New API examples
- `test/tcp/test-tcp-video-stream-record.ts` - Video streaming and recording
- `test/tcp/test-tcp-audio.ts` - Two-way audio examples

## Development

```bash
# Build
npm run build

# Type check
npm run typecheck

# Run tests
npm run test:tcp:new-apis
```

## Implementation Notes

This library is based on:
- `neolink` (Rust): `crates/core/src/bc/*` + `crates/core/src/bc_protocol/*`
- `reolink_aio` (Python): `reolink_aio/baichuan/*`

## License

MIT
