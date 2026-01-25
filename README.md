# @reolink/baichuan-js

Mostly vibed TypeScript library implementing Reolink Baichuan protocol (control + streaming) with CGI and RTSP helpers. Full TypeScript support with comprehensive type definitions.

## Features

- ✅ **Full TypeScript support** with comprehensive type definitions
- ✅ **Baichuan Protocol** (TCP/UDP) for camera control and streaming
- ✅ **CGI/REST API** support for HTTP-based operations
- ✅ **Hybrid API** with automatic fallback (Baichuan → CGI)
- ✅ **Video/Audio Streaming** with H.264/H.265 decoding support
- ✅ **RTSP Server** and HTTP MPEG-TS proxy
- ✅ **Multifocal Camera Support** with composite stream (PIP)
- ✅ **RTSP Server CLI** for standalone RTSP server deployment
- ✅ **NVR Support** for multi-channel systems
- ✅ **Battery Camera Support** via BCUDP (UDP protocol)
- ✅ **PTZ Control** (pan, tilt, zoom, presets)
- ✅ **Event Subscriptions** (motion, AI detection)
- ✅ **Two-way Audio** support
- ✅ **Device Abilities** detection

## Quick Start

### Basic Usage

```typescript
import { ReolinkBaichuanApi } from "@reolink/baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
  transport: "tcp",
});

await api.login();

// Get device info
const info = await api.getInfo();
console.log(`Device: ${info.type}`);

// Subscribe to video stream
const stream = await api.subscribeVideoStream({
  channel: 0,
  profile: "main",
});

stream.on("videoFrame", (frame) => {
  console.log(`Frame: ${frame.length} bytes`);
});
```

## Multifocal Camera Composite Stream

For multifocal cameras (e.g., Reolink TrackMix), you can combine the wider and tele streams into a single composite stream with configurable picture-in-picture (PIP).

### Basic Example

```typescript
import { CompositeRtspServer } from "@reolink/baichuan-js";

const rtspServer = new CompositeRtspServer({
  api,
  widerChannel: 0, // Wide-angle channel
  teleChannel: 1, // Telephoto channel
  widerProfile: "main", // Profile for wider stream
  teleProfile: "sub", // Profile for tele stream
  pipPosition: "bottom-right", // PIP position
  pipSize: 0.25, // PIP size (25% of screen)
  pipMargin: 10, // Margin from edge in pixels
  listenPort: 8554,
});

await rtspServer.start();
// Server available at: rtsp://127.0.0.1:8554/composite
```

### Available PIP Positions

- `top-left`, `top-right`, `bottom-left`, `bottom-right`
- `center`, `top-center`, `bottom-center`
- `left-center`, `right-center`

### Direct Stream Access

You can also use `CompositeStream` directly for programmatic access:

```typescript
import { CompositeStream } from "@reolink/baichuan-js";

const compositeStream = new CompositeStream({
  api,
  widerChannel: 0,
  teleChannel: 1,
  widerProfile: "main",
  teleProfile: "sub",
  pipPosition: "bottom-right",
  pipSize: 0.25,
});

await compositeStream.start();

compositeStream.on("videoFrame", (frame) => {
  // Process composite frame
});
```

See [docs/MULTIFOCAL_COMPOSITE.md](docs/MULTIFOCAL_COMPOSITE.md) for detailed documentation.

## RTSP Server CLI

The library includes a CLI tool to start a standalone RTSP server from the command line.

### Installation

After building the project:

```bash
npm run build
```

### Basic Usage

```bash
npm run rtsp-server -- --host 192.168.1.100 --username admin --password pass
```

### Options

**Required:**

- `--host <ip>`: Camera IP address
- `--username <user>` or `-u`: Username
- `--password <pass>` or `-p`: Password

**Optional:**

- `--channel <num>`: Channel number (default: 0)
- `--profile <profile>`: Stream profile: `main`, `sub`, `ext` (default: `main`)
- `--port <port>`: RTSP server port (default: 8554)
- `--path <path>`: RTSP path (default: `/stream/<profile>`)
- `--uid <uid>`: UID for battery cameras (optional)
- `--transport <type>`: Transport: `tcp`, `udp`, `auto` (default: `auto`)

### Examples

```bash
# Basic server
npm run rtsp-server -- --host 192.168.1.100 -u admin -p pass

# Specific channel with sub profile
npm run rtsp-server -- --host 192.168.1.100 -u admin -p pass --channel 1 --profile sub

# Custom port
npm run rtsp-server -- --host 192.168.1.100 -u admin -p pass --port 8555

# Battery camera (UDP)
npm run rtsp-server -- --host 192.168.1.100 -u admin -p pass --uid ABC123 --transport udp
```

### Connecting with RTSP Clients

Once the server is running, connect with any RTSP client:

```bash
# VLC
vlc rtsp://127.0.0.1:8554/stream/main

# ffplay
ffplay rtsp://127.0.0.1:8554/stream/main
```

See [docs/RTSP_SERVER_CLI.md](docs/RTSP_SERVER_CLI.md) for detailed documentation.

## RTSP Server (Programmatic)

You can also create an RTSP server programmatically:

```typescript
import { BaichuanRtspServer } from "@reolink/baichuan-js";

const rtspServer = new BaichuanRtspServer({
  api,
  channel: 0,
  profile: "main",
  listenPort: 8554,
  path: "/stream/main",
});

await rtspServer.start();
console.log(`RTSP URL: ${rtspServer.getRtspUrl()}`);
```

## HTTP Endpoints Server (debug/dev)

There is a small HTTP server used for manual debugging and tooling.

```bash
npm run serve:baichuan:endpoints
```

### `GET /recordings`

Unified recordings entrypoint (internally calls `api.listRecordings({ enriched: true })`) and returns recordings already enriched with `detectionClasses`.

Query params:

- `channel` (number, default `0`)
- `uid` (string, optional; needed for some BCUDP/battery devices)
- `streamType` (`mainStream` | `subStream`, default `mainStream`)
- `start` / `end` (ISO datetime)
- `recordType` (optional)
- `count` (optional; returns only last N items)
- `alarms` (optional boolean, default `true`; best-effort merge with alarm events to complete detections)

Response:

- `{ recordings: EnrichedRecordingFile[], ... }`

## Bifocal/Multifocal Cameras

Bifocal cameras (e.g., Reolink TrackMix) have two lenses:

- **Wide-angle lens** (channel 0): Provides a wider field of view
- **Telephoto lens** (channel 1): Provides a zoomed/telephoto view

### Detecting Multifocal Cameras

```typescript
import { autoDetectDeviceType } from "@reolink/baichuan-js";

const result = await autoDetectDeviceType({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
});

if (result.type === "multifocal") {
  console.log("Multifocal camera detected");
  // Channel 0 = wide-angle
  // Channel 1 = telephoto
}
```

### Subscribing to Both Streams

```typescript
// Subscribe to wide-angle stream
const wideStream = await api.subscribeVideoStream({
  channel: 0,
  profile: "main",
});

// Subscribe to telephoto stream
const teleStream = await api.subscribeVideoStream({
  channel: 1,
  profile: "main",
});

wideStream.on("videoFrame", (frame) => {
  // Process wide-angle frames
});

teleStream.on("videoFrame", (frame) => {
  // Process telephoto frames
});
```

See [docs/BIFOCAL_CAMERAS.md](docs/BIFOCAL_CAMERAS.md) for detailed documentation.

## Implementation Notes

This library was developed starting from reference implementations in Rust and Python for the Baichuan protocol,
adapted and rationalized for the TypeScript ecosystem. The reference sources are not part of the package and are
used only as technical documentation of the protocol.

## Requirements

- Node.js >= 18
- `ffmpeg` installed (required for RTSP server and composite stream features)

## License

MIT
