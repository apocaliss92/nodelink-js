# @apocaliss92/reolink-baichuan-js

A TypeScript library for interacting with Reolink IP cameras and NVRs using the proprietary Baichuan protocol and CGI API.

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

## Installation

```bash
npm install @apocaliss92/reolink-baichuan-js
```

## Quick Start

### Baichuan Native API

The Baichuan API provides direct access to camera functions through the proprietary binary protocol:

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000, // Baichuan port
  username: "admin",
  password: "your-password",
});

await api.connect();
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

### CGI HTTP API

The CGI API provides HTTP-based access for configuration and management:

```typescript
import { ReolinkCgiApi } from "@apocaliss92/reolink-baichuan-js";

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

## Streaming

### RTSP Server

Create a local RTSP server that restreams camera feeds:

```typescript
import { BaichuanRtspServer, ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

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
import { createRfc4571TcpServer, ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

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
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.connect();
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
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.connect();
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
import { AutodiscoveryClient } from "@apocaliss92/reolink-baichuan-js";

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
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.connect();
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
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.connect();
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
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.connect();
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
import { ReolinkBaichuanApi, createLogger } from "@apocaliss92/reolink-baichuan-js";

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

See the [TypeScript definitions](./dist/reolink-baichuan-js.d.ts) for the complete API.

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or pull request.
