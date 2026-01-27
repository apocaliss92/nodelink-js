# Network & System Settings

Methods for network configuration and system settings.

## Table of Contents

- [Network Configuration](#network-configuration)
  - [getNetworkInfo](#getnetworkinfo)
  - [getNetPort](#getnetport)
  - [setNetPort](#setnetport)
  - [setPortEnabled](#setportenabled)
- [WiFi](#wifi)
  - [getWifi](#getwifi)
  - [getWifiSignal](#getwifisignal)
- [Audio Configuration](#audio-configuration)
  - [getAudioCfg](#getaudiocfg)
- [Storage](#storage)
  - [getHddInfoList](#gethddinfolist)
- [System](#system)
  - [reboot](#reboot)
  - [getDayNightThreshold](#getdaynightthreshold)
  - [getTimelapseCfg](#gettimeLapsecfg)

---

## Network Configuration

### getNetworkInfo

Gets network configuration information.

```typescript
const networkInfo = await api.getNetworkInfo(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<ReolinkBaichuanNetworkInfo>`

```typescript
interface ReolinkBaichuanNetworkInfo {
  ip?: string;
  mac?: string;
  activeLink?: string;
}
```

### Example

```typescript
const network = await api.getNetworkInfo();
console.log(`IP: ${network.ip}`);
console.log(`MAC: ${network.mac}`);
console.log(`Active Link: ${network.activeLink}`);
```

---

### getNetPort

Gets network port configuration.

```typescript
const ports = await api.getNetPort();
```

### Returns

`Promise<ReolinkBaichuanPorts>` - Object containing port configurations

### Example

```typescript
const ports = await api.getNetPort();
console.log("Configured ports:", JSON.stringify(ports, null, 2));
// {
//   "http": { "port": 80 },
//   "https": { "port": 443 },
//   "rtsp": { "port": 554 },
//   "rtmp": { "port": 1935 },
//   "onvif": { "port": 8000 }
// }
```

---

### setNetPort

Sets network port configuration.

```typescript
await api.setNetPort(netPort: ReolinkBaichuanPorts);
```

### Parameters

| Parameter | Type                   | Required | Description        |
| --------- | ---------------------- | -------- | ------------------ |
| `netPort` | `ReolinkBaichuanPorts` | ✅       | Port configuration |

### Returns

`Promise<void>`

### Example

```typescript
// Get current ports
const ports = await api.getNetPort();

// Modify RTSP port
if (ports.rtsp) {
  ports.rtsp.port = 8554;
}

// Apply changes
await api.setNetPort(ports);
console.log("Ports updated");

// Note: May require reboot to take effect
await api.reboot();
```

---

### setPortEnabled

Enables or disables a specific network service port.

```typescript
await api.setPortEnabled(params: {
  service: string;
  enabled: boolean;
});
```

### Parameters

| Parameter        | Type      | Required | Description                                   |
| ---------------- | --------- | -------- | --------------------------------------------- |
| `params.service` | `string`  | ✅       | Service name (http, https, rtsp, rtmp, onvif) |
| `params.enabled` | `boolean` | ✅       | Enable/disable service                        |

### Returns

`Promise<void>`

### Example

```typescript
// Enable ONVIF
await api.setPortEnabled({ service: "onvif", enabled: true });

// Disable RTMP
await api.setPortEnabled({ service: "rtmp", enabled: false });
```

---

## WiFi

### getWifi

Gets WiFi configuration.

```typescript
const wifi = await api.getWifi(channel?: number);
```

### Returns

WiFi configuration including SSID and connection status.

---

### getWifiSignal

Gets WiFi signal strength.

```typescript
const signal = await api.getWifiSignal(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

WiFi signal information.

### Example

```typescript
const wifi = await api.getWifi();
const signal = await api.getWifiSignal();
console.log(`WiFi SSID: ${wifi.ssid}`);
console.log(`Signal Strength: ${signal.level} dBm`);
```

---

## Audio Configuration

### getAudioCfg

Gets audio configuration.

```typescript
const audioCfg = await api.getAudioCfg(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

Audio configuration including codec, sample rate, and volume settings.

---

## Storage

### getHddInfoList

Gets storage/HDD information.

```typescript
const hddInfo = await api.getHddInfoList(options?: {
  timeoutMs?: number;
});
```

### Parameters

| Parameter           | Type     | Required | Default | Description |
| ------------------- | -------- | -------- | ------- | ----------- |
| `options.timeoutMs` | `number` | ❌       | `10000` | Timeout     |

### Returns

Storage information including capacity, used space, and status.

### Example

```typescript
const storage = await api.getHddInfoList();
console.log("Storage devices:", storage);
// {
//   totalSpace: 128000000000, // bytes
//   usedSpace: 64000000000,
//   freeSpace: 64000000000,
//   status: "normal"
// }
```

---

## System

### reboot

Reboots the camera.

```typescript
await api.reboot(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description                  |
| --------- | -------- | -------- | ------- | ---------------------------- |
| `channel` | `number` | ❌       | -       | Channel to reboot (NVR only) |

### Returns

`Promise<void>`

### Example

```typescript
console.log("Rebooting camera...");
await api.reboot();

// Wait for reboot (typically 60-120 seconds)
await new Promise((r) => setTimeout(r, 90000));

// Reconnect
await api.login();
console.log("Camera is back online");
```

---

### getDayNightThreshold

Gets day/night switching threshold configuration.

```typescript
const threshold = await api.getDayNightThreshold(channel?: number);
```

### Returns

Day/night IR switching configuration.

---

### getTimelapseCfg

Gets timelapse recording configuration.

```typescript
const timelapse = await api.getTimelapseCfg(channel?: number);
```

### Returns

Timelapse configuration if supported.

---

## Diagnostics

### runAllDiagnosticsConsecutively

Runs comprehensive diagnostics on the camera.

```typescript
const diagnostics = await api.runAllDiagnosticsConsecutively(params: {
  outputDir: string;
});
```

### Parameters

| Parameter          | Type     | Required | Description                        |
| ------------------ | -------- | -------- | ---------------------------------- |
| `params.outputDir` | `string` | ✅       | Directory to save diagnostic files |

### Returns

Comprehensive diagnostic information including network, storage, and system status.

### Example

```typescript
const diagnostics = await api.runAllDiagnosticsConsecutively({
  outputDir: "./diagnostics",
});
console.log("Diagnostics saved to ./diagnostics");
```

---

## Complete Network Check Example

```typescript
async function networkHealthCheck() {
  const report: string[] = [];

  // Network info
  const network = await api.getNetworkInfo();
  report.push(`IP Address: ${network.ip}`);
  report.push(`MAC Address: ${network.mac}`);
  report.push(`Connection: ${network.activeLink}`);

  // Ports
  const ports = await api.getNetPort();
  report.push("\nConfigured Ports:");
  for (const [service, config] of Object.entries(ports)) {
    report.push(`  ${service}: ${config.port}`);
  }

  // WiFi (if applicable)
  try {
    const signal = await api.getWifiSignal();
    report.push(`\nWiFi Signal: ${signal.level} dBm`);
  } catch {
    report.push("\nWiFi: Not applicable (wired connection)");
  }

  // Storage
  try {
    const storage = await api.getHddInfoList();
    report.push("\nStorage:");
    report.push(`  Status: ${storage.status}`);
    report.push(
      `  Used: ${Math.round(storage.usedSpace / 1e9)}GB / ${Math.round(storage.totalSpace / 1e9)}GB`,
    );
  } catch {
    report.push("\nStorage: Not available");
  }

  return report.join("\n");
}

const healthReport = await networkHealthCheck();
console.log(healthReport);
```

---

[← Back to Baichuan API](./README.md)
