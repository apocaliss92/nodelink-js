# Usage Examples

## Scrypted Plugin Integration

Example of how to use this library in a Scrypted plugin:

```typescript
import {
  ReolinkBaichuanApi,
  ReolinkHybridApi,
  type PtzPreset,
  type BatteryInfo,
  type AbilityInfo,
} from "@reolink/baichuan-js";

// Initialize API
const api = new ReolinkBaichuanApi({
  host: "192.168.1.50",
  username: "admin",
  password: "your-password",
  transport: "tcp", // or "udp" for battery cameras
  debugOptions: {
    debugH264: false,
    debugParamSets: false,
  },
});

// Login
await api.login();

// Get device information
const devInfo = await api.GetDevInfo();
console.log("Device:", devInfo.deviceName, devInfo.model);

// Get device abilities
const abilities = await api.getAbilityInfo("admin");
console.log("PTZ supported:", abilities[0]?.control_rw === 1);

// PTZ Operations
if (abilities[0]?.control_rw === 1) {
  // Get presets
  const presets: PtzPreset[] = await api.getPtzPresets(0);
  console.log("Presets:", presets);

  // Move to preset
  await api.moveToPtzPreset(0, 1);

  // PTZ control
  await api.ptz(0, {
    action: "start",
    command: "Up",
    speed: 0.5,
  });

  // Stop after delay (handled automatically)
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// Battery Info (for battery cameras)
const batteryInfo: BatteryInfo = await api.getBatteryInfo(0);
console.log("Battery:", batteryInfo.batteryPercent, "%");

// Motion Detection
await api.setMotionDetection(0, true, 50);

// AI Detection
await api.setAiDetection(0, "people", 50, 5);

// Siren/Audio Alarm
await api.setSiren(0, true, 10); // 10 seconds

// White LED/Floodlight
await api.setWhiteLedState(0, true, 80); // 80% brightness

// Video Streaming
const stream = await api.subscribeVideoStream({
  channel: 0,
  profile: "main",
});

stream.on("videoFrame", (frame) => {
  // Process H.264 frame
  if (frame.isKeyframe) {
    console.log("Keyframe received");
  }
});

stream.on("audioFrame", (frame) => {
  // Process audio frame
  console.log("Audio frame:", frame.data.length, "bytes");
});

// Events
await api.subscribeEvents();
api.on("event", (event) => {
  if (event.type === "motion") {
    console.log("Motion detected on channel", event.channel);
  } else if (event.type === "ai") {
    console.log("AI detection:", event.ai?.type);
  }
});

// Cleanup
await stream.stop();
await api.close();
```

## Hybrid API (Recommended for Scrypted)

The Hybrid API automatically falls back to CGI if Baichuan is not available:

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

// All operations work with automatic fallback
const devInfo = await api.GetDevInfo();
await api.Reboot();
await api.close();
```

## Type Safety

All types are exported for full TypeScript support:

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
  MotionEvent,
  AIEvent,
  OsdConfig,
  AIDetectionState,
} from "@reolink/baichuan-js";
```

