# Network Discovery

The `AutodiscoveryClient` allows automatic discovery of Reolink cameras on the local network.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Constructor](#constructor)
- [Methods](#methods)
- [Events](#events)
- [Device Info](#device-info)
- [Examples](#examples)

---

## Basic Usage

```typescript
import { AutodiscoveryClient } from "@apocaliss92/nodelink-js";

const discovery = new AutodiscoveryClient({
  logger: console,
});

discovery.on("device", (device) => {
  console.log("Found device:", device.ip, device.name);
});

await discovery.start();

// Wait for devices to be discovered
await new Promise((resolve) => setTimeout(resolve, 5000));

await discovery.stop();
```

---

## Constructor

```typescript
new AutodiscoveryClient(options?: AutodiscoveryOptions)
```

### Options

| Parameter          | Type      | Default             | Description              |
| ------------------ | --------- | ------------------- | ------------------------ |
| `logger`           | `Console` | `undefined`         | Logger instance          |
| `port`             | `number`  | `2000`              | UDP port for discovery   |
| `broadcastAddress` | `string`  | `"255.255.255.255"` | Broadcast address        |
| `timeout`          | `number`  | `5000`              | Discovery timeout (ms)   |
| `interface`        | `string`  | `undefined`         | Network interface to use |

### TypeScript Interface

```typescript
interface AutodiscoveryOptions {
  logger?: Console;
  port?: number;
  broadcastAddress?: string;
  timeout?: number;
  interface?: string;
}
```

---

## Methods

### start()

Starts the discovery process.

```typescript
await discovery.start();
```

**Returns:** `Promise<void>`

### stop()

Stops the discovery process and closes the UDP socket.

```typescript
await discovery.stop();
```

**Returns:** `Promise<void>`

### discover()

Performs a one-shot discovery and returns all found devices.

```typescript
const devices = await discovery.discover();
console.log("Found", devices.length, "devices");
```

**Returns:** `Promise<DiscoveredDevice[]>`

### getDevices()

Returns all devices discovered so far.

```typescript
const devices = discovery.getDevices();
```

**Returns:** `DiscoveredDevice[]`

---

## Events

### device

Emitted when a new device is discovered.

```typescript
discovery.on("device", (device: DiscoveredDevice) => {
  console.log("Found:", device.name, "at", device.ip);
});
```

### error

Emitted on discovery errors.

```typescript
discovery.on("error", (error: Error) => {
  console.error("Discovery error:", error);
});
```

---

## Device Info

### DiscoveredDevice Interface

```typescript
interface DiscoveredDevice {
  /** Device IP address */
  ip: string;
  /** Device MAC address */
  mac: string;
  /** Device name/hostname */
  name: string;
  /** Device model */
  model?: string;
  /** Device type (camera, NVR, hub) */
  deviceType?: string;
  /** Firmware version */
  firmware?: string;
  /** Hardware version */
  hardware?: string;
  /** Serial number (UID) */
  uid?: string;
  /** Whether Baichuan protocol is supported */
  baichuanSupported?: boolean;
  /** Baichuan port (usually 9000) */
  baichuanPort?: number;
  /** HTTP port (usually 80) */
  httpPort?: number;
  /** RTSP port (usually 554) */
  rtspPort?: number;
  /** RTMP port (usually 1935) */
  rtmpPort?: number;
  /** ONVIF port (usually 8000) */
  onvifPort?: number;
  /** Number of channels (for NVR) */
  channels?: number;
  /** Raw discovery data */
  raw?: unknown;
}
```

---

## Examples

### One-Shot Discovery

```typescript
import { AutodiscoveryClient } from "@apocaliss92/nodelink-js";

async function discoverDevices() {
  const discovery = new AutodiscoveryClient({
    logger: console,
    timeout: 10000, // 10 seconds
  });

  const devices = await discovery.discover();

  for (const device of devices) {
    console.log(`
Device: ${device.name}
  IP: ${device.ip}
  MAC: ${device.mac}
  Model: ${device.model}
  Firmware: ${device.firmware}
  Baichuan Port: ${device.baichuanPort}
    `);
  }

  return devices;
}
```

### Continuous Discovery

```typescript
import {
  AutodiscoveryClient,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js";

const discovery = new AutodiscoveryClient({
  logger: console,
});

const connectedDevices = new Map<string, ReolinkBaichuanApi>();

discovery.on("device", async (device) => {
  // Skip if already connected
  if (connectedDevices.has(device.ip)) return;

  console.log("New device found:", device.name, "at", device.ip);

  // Auto-connect to discovered devices
  try {
    const api = new ReolinkBaichuanApi({
      host: device.ip,
      port: device.baichuanPort || 9000,
      username: "admin",
      password: "your-password",
    });

    await api.login();
    connectedDevices.set(device.ip, api);
    console.log("Connected to", device.name);
  } catch (error) {
    console.error("Failed to connect to", device.name, error);
  }
});

await discovery.start();

// Keep running...
process.on("SIGINT", async () => {
  await discovery.stop();
  for (const api of connectedDevices.values()) {
    await api.close();
  }
  process.exit(0);
});
```

### Discovery with Network Interface

```typescript
import { AutodiscoveryClient } from "@apocaliss92/nodelink-js";

// Discover only on a specific network interface
const discovery = new AutodiscoveryClient({
  logger: console,
  interface: "eth0", // or "en0" on macOS
  broadcastAddress: "192.168.1.255",
});

const devices = await discovery.discover();
```

### Filter by Device Type

```typescript
import { AutodiscoveryClient } from "@apocaliss92/nodelink-js";

const discovery = new AutodiscoveryClient();
const devices = await discovery.discover();

// Filter cameras only
const cameras = devices.filter(
  (d) => d.deviceType === "camera" || !d.deviceType,
);

// Filter NVRs only
const nvrs = devices.filter((d) => d.deviceType === "nvr");

// Filter hubs only
const hubs = devices.filter((d) => d.deviceType === "hub");

console.log("Cameras:", cameras.length);
console.log("NVRs:", nvrs.length);
console.log("Hubs:", hubs.length);
```

### Build Device Map

```typescript
import { AutodiscoveryClient } from "@apocaliss92/nodelink-js";

interface DeviceConfig {
  host: string;
  port: number;
  name: string;
  model: string;
}

async function buildDeviceMap(): Promise<Map<string, DeviceConfig>> {
  const discovery = new AutodiscoveryClient();
  const devices = await discovery.discover();

  const deviceMap = new Map<string, DeviceConfig>();

  for (const device of devices) {
    deviceMap.set(device.mac, {
      host: device.ip,
      port: device.baichuanPort || 9000,
      name: device.name,
      model: device.model || "Unknown",
    });
  }

  return deviceMap;
}

// Usage
const devices = await buildDeviceMap();
console.log("Device map:", Object.fromEntries(devices));
```

---

## Discovery Protocol

The autodiscovery uses UDP broadcast packets on port 2000 (by default). The protocol sends a discovery request and listens for device responses containing:

- Device identification (name, model, serial)
- Network information (IP, MAC, ports)
- Firmware/hardware versions
- Supported features

### Ports Used

| Port | Protocol | Description         |
| ---- | -------- | ------------------- |
| 2000 | UDP      | Discovery broadcast |
| 9000 | TCP      | Baichuan protocol   |
| 80   | TCP      | HTTP/CGI API        |
| 554  | TCP      | RTSP                |
| 1935 | TCP      | RTMP                |
| 8000 | TCP      | ONVIF               |

---

## Troubleshooting

### No Devices Found

1. **Check network connectivity**: Ensure you're on the same subnet as the cameras
2. **Check firewall**: UDP port 2000 must be open for discovery
3. **Try specific interface**: Use the `interface` option to specify the network interface
4. **Increase timeout**: Some devices respond slowly

```typescript
const discovery = new AutodiscoveryClient({
  timeout: 15000, // 15 seconds
  broadcastAddress: "192.168.1.255", // Specific subnet
});
```

### Duplicate Devices

Devices may respond multiple times. The client deduplicates by MAC address.

### Partial Device Info

Some older cameras may not include all fields in their discovery response. Use the `raw` field to access the full response data.

---

[← Back to Main Documentation](./README.md)
