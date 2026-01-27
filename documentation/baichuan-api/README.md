# Baichuan API Reference

The `ReolinkBaichuanApi` class provides direct access to Reolink cameras through the proprietary Baichuan binary protocol (port 9000).

## Quick Start

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

// Your code here...

await api.close();
```

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
- **[Lights & Accessories](./lights.md)** - Spotlight, floodlight, siren
- **[Battery & Sleep](./battery.md)** - Battery status, wake-up
- **[OSD & Display](./osd.md)** - On-screen display, camera name
- **[Network & System](./network.md)** - Ports, WiFi, storage, reboot

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

## Error Handling

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({ ... });

try {
  await api.login();
  const snapshot = await api.getSnapshot();
} catch (error) {
  if (error.code === "ECONNREFUSED") {
    console.error("Cannot connect to camera");
  } else if (error.code === "AUTH_FAILED") {
    console.error("Invalid credentials");
  } else if (error.code === "TIMEOUT") {
    console.error("Operation timed out");
  } else {
    console.error("Unknown error:", error);
  }
} finally {
  await api.close();
}
```

---

## Events

The API extends `EventEmitter` and emits various events:

| Event         | Description                               |
| ------------- | ----------------------------------------- |
| `motionAlarm` | Motion detection triggered                |
| `aiAlarm`     | AI detection (person, vehicle, pet, etc.) |
| `visitor`     | Doorbell pressed                          |
| `sleepStatus` | Battery camera sleep state changed        |
| `disconnect`  | Connection lost                           |
| `reconnect`   | Connection restored                       |

```typescript
api.on("motionAlarm", (event) => {
  console.log(`Motion on channel ${event.channel}: ${event.state}`);
});

api.on("aiAlarm", (event) => {
  console.log(`AI: ${event.type} - ${event.state}`);
});

api.on("disconnect", () => {
  console.log("Connection lost");
});
```

---

## Multi-Channel (NVR/Hub) Support

```typescript
// Check if connected to NVR
if (await api.isNvrDevice()) {
  // Get all channels
  const channelCount = await api.getChannelCount();
  console.log(`NVR has ${channelCount} channels`);

  // Get info for all channels
  const channels = await api.getAllChannelsInfo();
  for (const [ch, info] of channels) {
    console.log(`Channel ${ch}: ${info.name} (${info.typeInfo})`);
  }

  // Work with specific channel
  const snapshot = await api.getSnapshot({ channel: 2 });
}
```

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
} from "@apocaliss92/reolink-baichuan-js";
```

---

[← Back to Main Documentation](../README.md)
