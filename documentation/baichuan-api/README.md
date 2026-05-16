# Baichuan API Reference

The `ReolinkBaichuanApi` class provides direct access to Reolink cameras through the proprietary Baichuan binary protocol (port 9000).

## Installation

```bash
npm install @apocaliss92/nodelink-js
```

## Quick Start

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

// Get device info
const deviceInfo = await api.getInfo();
console.log("Camera:", deviceInfo.name, deviceInfo.type);

// Get stream info
const streamInfo = await api.getStreamInfoList(0);

// Subscribe to events (motion, doorbell, people, vehicle, animal, etc.)
await api.onSimpleEvent((event) => {
  console.log("Event:", event.type, "channel:", event.channel);
});

await api.close();
```

Also available: **[CGI HTTP API](../cgi-api/README.md)** for HTTP-based configuration (port 80).

## Documentation Sections

### Core

- **[Connection & Session](./connection.md)** - Login, logout, ping, reboot, dedicated sessions
- **[Device Information](./device-info.md)** - Device info, channels, capabilities, NVR support

### Streaming & Media

- **[Video Streaming](./streaming.md)** - Live streams, RTSP server, codec configuration
- **[Recordings & Playback](./recordings.md)** - Search, download, replay video clips
- **[Images & Snapshots](./snapshots.md)** - Capture snapshots, thumbnails

### Controls

- **[PTZ Control](./ptz.md)** - Pan, tilt, zoom, presets
- **[Events & Notifications](./events.md)** - Subscribe to motion, AI, doorbell events
- **[Two-Way Audio](./intercom.md)** - Intercom, talk sessions

### Configuration

- **[Detection Settings](./detection.md)** - Motion, AI, PIR, autotracking
- **[Lights & Accessories](./lights.md)** - Spotlight, floodlight, siren, chime/DingDong
- **[Battery & Sleep](./battery.md)** - Battery status, wake-up
- **[OSD & Display](./osd.md)** - On-screen display, camera name
- **[Network & System](./network.md)** - Ports, WiFi, storage, reboot
- **[Email & Email Push](./email.md)** - SMTP config, schedule, manager-side intake, auto-configure
- **[Time, NTP, DST, Auto-Reboot](./time.md)** - Clock, time zone, NTP, DST, scheduled reboot

---

## Constructor Options

```typescript
interface ReolinkBaichuanApiOptions {
  /** Camera IP address or hostname */
  host: string;
  /** Baichuan protocol port (default: 9000) */
  port?: number;
  /** Login username */
  username: string;
  /** Login password */
  password: string;
  /** Default channel for operations (default: 0) */
  channel?: number;
  /** Custom logger instance */
  logger?: Logger;
  /** Default timeout for operations in ms (default: 30000) */
  timeoutMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}
```

---

## Streaming

### RTSP Server

```typescript
import { BaichuanRtspServer, ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

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
  listenPort: 8554,
  logger: console,
});

await rtspServer.start();
// Stream available at rtsp://localhost:8554/stream
```

### RFC 4571 Server

```typescript
import { createRfc4571TcpServer, ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

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
```

---

## Events

Subscribe to real-time events using `onSimpleEvent()`:

| Event Type  | Description                               |
| ----------- | ----------------------------------------- |
| `motion`    | Motion detection triggered                |
| `people`    | Person detected (AI)                      |
| `vehicle`   | Vehicle detected (AI)                     |
| `animal`    | Animal detected (AI)                      |
| `face`      | Face detected (AI)                        |
| `package`   | Package detected (AI)                     |
| `doorbell`  | Doorbell pressed                          |
| `sleeping`  | Battery camera entered sleep              |
| `awake`     | Battery camera woke up                    |
| `daynight`  | Day/night mode changed                    |

```typescript
await api.onSimpleEvent((event) => {
  switch (event.type) {
    case "motion":
      console.log("Motion detected on channel", event.channel);
      break;
    case "people":
    case "vehicle":
    case "animal":
      console.log("AI detection:", event.type, "on channel", event.channel);
      break;
    case "doorbell":
      console.log("Visitor detected");
      break;
  }
});
```

The API also emits low-level EventEmitter events:

| Event        | Description            |
| ------------ | ---------------------- |
| `disconnect` | Connection lost        |
| `reconnect`  | Connection restored    |

---

## Two-Way Audio (Intercom)

```typescript
// Create a dedicated talk session (recommended)
const session = await api.createDedicatedTalkSession(0);

// Send audio data (ADPCM DVI4 with 4-byte predictor header per block)
await session.sendAudio(adpcmBuffer);

// Stop talk session
await session.stop();
```

---

## Video Clips & Recordings

```typescript
// Search recordings by date
const recordings = await api.getVideoclips({
  channel: 0,
  start: new Date("2024-01-01"),
  end: new Date("2024-01-02"),
});

// Download a recording
const buffer = await api.downloadRecording({
  channel: 0,
  fileName: recordings[0].fileName,
});

import { writeFileSync } from "node:fs";
writeFileSync("recording.mp4", buffer);
```

---

## PTZ Control

```typescript
// Move camera
await api.ptz(0, { action: "start", command: "Right", speed: 32 });
await api.ptz(0, { action: "stop", command: "Right" });

// Go to preset
await api.moveToPtzPreset(0, 1);

// Get current position
const position = await api.getPtzPosition(0);

// Zoom control
await api.zoomToFactor(0, 100);
```

---

## Device Discovery

```typescript
import { AutodiscoveryClient } from "@apocaliss92/nodelink-js";

const discovery = new AutodiscoveryClient();

discovery.on("device", (device) => {
  console.log("Found camera:", device.ip, device.name, device.uid);
});

await discovery.startDiscovery();
setTimeout(() => discovery.stopDiscovery(), 10000);
```

---

## Multi-Channel (NVR/Hub) Support

```typescript
// Check if connected to NVR
if (await api.isNvrDevice()) {
  const channelCount = await api.getChannelCount();
  console.log(`NVR has ${channelCount} channels`);

  const channels = await api.getAllChannelsInfo();
  for (const [ch, info] of channels) {
    console.log(`Channel ${ch}: ${info.typeInfo}`);
  }
}

// Stream from a specific channel
const rtspServer = new BaichuanRtspServer({
  api,
  profile: "main",
  channel: 2,
  listenPort: 8554,
  logger: console,
});
```

---

## Diagnostics & Capability Dump

Capture all API responses from a camera to diagnose supported features and generate fixture files:

```typescript
import { ReolinkBaichuanApi, captureModelFixtures } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

const result = await captureModelFixtures({
  api,
  channel: 0,
  outDir: "./diagnostics/my-camera",
  log: console.log,
});

console.log(`Captured: ${result.summary.ok}/${result.summary.total} ok, ${result.summary.failed} failed`);
await api.close();
```

The dump calls 25+ API methods. Sensitive data is automatically sanitized. Some methods (e.g. `getMotionAlarm` cmdId 46, `getAiState` cmdId 342) may return 400 on certain models — these are recorded in the summary without stopping the dump.

CLI shortcut for all configured cameras:

```bash
npx tsx test/capture-model-fixtures.ts --runs 3
```

---

## Error Handling

```typescript
try {
  await api.login();
  const snapshot = await api.getSnapshot();
} catch (error) {
  if (error.code === "ECONNREFUSED") {
    console.error("Cannot connect to camera");
  } else if (error.code === "TIMEOUT") {
    console.error("Operation timed out");
  } else {
    console.error("Error:", error);
  }
} finally {
  await api.close();
}
```

---

## CLI Tools

Run a standalone RTSP server:

```bash
npm run rtsp-server
```

Configure via: `CAMERA_HOST`, `CAMERA_PORT` (default: 9000), `CAMERA_USERNAME`, `CAMERA_PASSWORD`, `RTSP_PORT` (default: 8554).

---

## TypeScript Types

All types are exported from the main package:

```typescript
import type {
  OsdConfig,
  PtzCommand,
  PtzPreset,
  PtzPosition,
  BatteryInfo,
  WhiteLedState,
  SirenState,
  AIState,
  RecordingFile,
  StreamProfile,
  // ... and more
} from "@apocaliss92/nodelink-js";
```

---

[← Back to Main Documentation](../README.md)
