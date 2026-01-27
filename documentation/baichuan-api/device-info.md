# Device Information

Methods for retrieving device information and capabilities.

## Table of Contents

- [getInfo](#getinfo)
- [getChannelInfo](#getchannelinfo)
- [getAllChannelsInfo](#getallchannelsinfo)
- [getChannelIdentity](#getchannelidentity)
- [getChannelCount](#getchannelcount)
- [isNvrDevice](#isnvrdevice)
- [getNvrChannelsSummary](#getnvrchannelssummary)
- [getNvrDeviceGroups](#getnvrdevicegroups)
- [getNetworkInfo](#getnetworkinfo)
- [getNetPort](#getnetport)
- [getPorts](#getports)
- [getAbilityInfo](#getabilityinfo)
- [getAbilityVersion](#getabilityversion)
- [getSupportInfo](#getsupportinfo)
- [getDeviceCapabilities](#getdevicecapabilities)
- [getDualLensChannelInfo](#getduallenschannelinfo)

---

## getInfo

Gets comprehensive device information.

```typescript
const info = await api.getInfo(options?: { channel?: number });
```

### Parameters

| Parameter         | Type     | Required | Default | Description    |
| ----------------- | -------- | -------- | ------- | -------------- |
| `options.channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<ReolinkDeviceInfo>`

```typescript
interface ReolinkDeviceInfo {
  name: string;
  model: string;
  serialNumber?: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  uid?: string;
  channelCount?: number;
  // ... additional fields
}
```

### Example

```typescript
const deviceInfo = await api.getInfo();
console.log(`Model: ${deviceInfo.model}`);
console.log(`Firmware: ${deviceInfo.firmwareVersion}`);
console.log(`Serial: ${deviceInfo.serialNumber}`);
```

---

## getChannelInfo

Gets information for a specific channel.

```typescript
const channelInfo = await api.getChannelInfo(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<ReolinkBaichuanChannelInfo>`

```typescript
interface ReolinkBaichuanChannelInfo {
  typeInfo?: string;
  firmVer?: string;
  firmwareVersion?: string;
  boardInfo?: string;
  pakSuffix?: string;
  name?: string;
}
```

---

## getAllChannelsInfo

Gets information for all channels (useful for NVR/Hub).

```typescript
const allChannels = await api.getAllChannelsInfo(options?: {
  includeOffline?: boolean;
  timeoutMs?: number;
});
```

### Parameters

| Parameter                | Type      | Required | Default | Description              |
| ------------------------ | --------- | -------- | ------- | ------------------------ |
| `options.includeOffline` | `boolean` | ❌       | `false` | Include offline channels |
| `options.timeoutMs`      | `number`  | ❌       | `10000` | Timeout per channel      |

### Returns

`Promise<Map<number, ReolinkBaichuanChannelInfo>>`

### Example

```typescript
const channels = await api.getAllChannelsInfo({ includeOffline: true });
for (const [channelId, info] of channels) {
  console.log(`Channel ${channelId}: ${info.name} (${info.typeInfo})`);
}
```

---

## getChannelIdentity

Gets the identity (model, name) for a specific channel.

```typescript
const identity = await api.getChannelIdentity(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<ReolinkBaichuanChannelIdentity>`

```typescript
interface ReolinkBaichuanChannelIdentity {
  channel: number;
  model: string;
  name: string;
}
```

---

## getChannelCount

Gets the total number of channels.

```typescript
const count = await api.getChannelCount();
```

### Returns

`Promise<number>`

### Example

```typescript
const channelCount = await api.getChannelCount();
console.log(`Device has ${channelCount} channels`);
```

---

## isNvrDevice

Checks if the connected device is an NVR or Hub.

```typescript
const isNvr = await api.isNvrDevice();
```

### Returns

`Promise<boolean>`

### Example

```typescript
if (await api.isNvrDevice()) {
  console.log("Connected to an NVR/Hub");
  const channels = await api.getAllChannelsInfo();
  // Work with multiple cameras
} else {
  console.log("Connected to a single camera");
}
```

---

## getNvrChannelsSummary

Gets a summary of all NVR/Hub channels with device information.

```typescript
const summary = await api.getNvrChannelsSummary(options?: {
  useCgi?: boolean;
  timeoutMs?: number;
});
```

### Parameters

| Parameter           | Type      | Required | Default | Description                     |
| ------------------- | --------- | -------- | ------- | ------------------------------- |
| `options.useCgi`    | `boolean` | ❌       | `false` | Use CGI API for additional info |
| `options.timeoutMs` | `number`  | ❌       | `10000` | Timeout for operations          |

### Returns

`Promise<ReolinkNvrChannelInfo[]>`

```typescript
interface ReolinkNvrChannelInfo {
  channel: number;
  model?: string;
  name?: string;
  uid?: string;
  online?: boolean;
  sleep?: boolean;
  firmwareVersion?: string;
  source: "baichuan" | "cgi";
}
```

---

## getNvrDeviceGroups

Groups NVR channels by physical device (useful for multifocal cameras).

```typescript
const groups = await api.getNvrDeviceGroups(options?: {
  timeoutMs?: number;
});
```

### Returns

`Promise<ReolinkNvrDeviceGroupsResult>`

```typescript
interface ReolinkNvrDeviceGroupsResult {
  channels: number[];
  groups: ReolinkNvrDeviceGroupSummary[];
  channelToGroup: Record<number, string>;
}

interface ReolinkNvrDeviceGroupSummary {
  key: string;
  uid?: string;
  serialNumber?: string;
  name?: string;
  model?: string;
  channels: number[];
  isMultifocal: boolean;
  reason: string;
}
```

### Example

```typescript
const result = await api.getNvrDeviceGroups();
for (const group of result.groups) {
  console.log(`Device: ${group.name}`);
  console.log(`  Channels: ${group.channels.join(", ")}`);
  console.log(`  Multifocal: ${group.isMultifocal}`);
}
```

---

## getNetworkInfo

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

---

## getNetPort

Gets network port configuration.

```typescript
const ports = await api.getNetPort();
```

### Returns

`Promise<ReolinkBaichuanPorts>`

### Example

```typescript
const ports = await api.getNetPort();
console.log("HTTP Port:", ports.http?.port);
console.log("RTSP Port:", ports.rtsp?.port);
console.log("RTMP Port:", ports.rtmp?.port);
```

---

## getPorts

Alias for `getNetPort()`.

```typescript
const ports = await api.getPorts();
```

---

## getAbilityInfo

Gets detailed device abilities and features.

```typescript
const abilities = await api.getAbilityInfo();
```

### Returns

`Promise<DeviceAbilities>` - Comprehensive ability structure

---

## getAbilityVersion

Gets the ability version for specific features.

```typescript
const version = await api.getAbilityVersion(abilityName: string);
```

### Parameters

| Parameter     | Type     | Required | Description         |
| ------------- | -------- | -------- | ------------------- |
| `abilityName` | `string` | ✅       | Name of the ability |

### Returns

`Promise<number | undefined>`

---

## getSupportInfo

Gets support configuration for various features.

```typescript
const support = await api.getSupportInfo(options?: {
  channel?: number;
  timeoutMs?: number;
});
```

### Returns

`Promise<SupportConfig>`

---

## getDeviceCapabilities

Gets aggregated device capabilities in a structured format.

```typescript
const capabilities = await api.getDeviceCapabilities(channel?: number);
```

### Returns

`Promise<DeviceCapabilities>`

```typescript
interface DeviceCapabilities {
  ptz: boolean;
  zoom: boolean;
  audio: boolean;
  twoWayAudio: boolean;
  siren: boolean;
  floodlight: boolean;
  battery: boolean;
  doorbell: boolean;
  ai: {
    person: boolean;
    vehicle: boolean;
    pet: boolean;
    face: boolean;
    package: boolean;
  };
  // ... more capabilities
}
```

### Example

```typescript
const caps = await api.getDeviceCapabilities();
if (caps.ptz) {
  console.log("Camera supports PTZ");
}
if (caps.ai.person) {
  console.log("Camera supports person detection");
}
```

---

## getDualLensChannelInfo

Gets channel information for dual-lens/multifocal cameras.

```typescript
const dualLensInfo = await api.getDualLensChannelInfo(options?: {
  channel?: number;
  onNvr?: boolean;
});
```

### Parameters

| Parameter         | Type      | Required | Default | Description        |
| ----------------- | --------- | -------- | ------- | ------------------ |
| `options.channel` | `number`  | ❌       | `0`     | Channel number     |
| `options.onNvr`   | `boolean` | ❌       | `false` | Whether on NVR/Hub |

### Returns

Information about dual-lens configuration including which channels correspond to wide/tele lenses.

---

[← Back to Baichuan API](./README.md)
