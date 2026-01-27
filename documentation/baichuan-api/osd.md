# OSD & Display Settings

Methods for configuring On-Screen Display (OSD) settings.

## Table of Contents

- [getOsd](#getosd)
- [setOsd](#setosd)
- [getOsdDatetime](#getosddatetime)
- [getGeneralXml](#getgeneralxml)
- [setGeneralXml](#setgeneralxml)
- [getSystemGeneral](#getsystemgeneral)

---

## getOsd

Gets the On-Screen Display configuration.

```typescript
const osd = await api.getOsd(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<OsdConfig>`

```typescript
interface OsdConfig {
  channel: number;
  osdChannel: {
    enable: number; // 0 = disabled, 1 = enabled
    name: string; // Camera name displayed on screen
    pos: string; // Position: "Upper-Left", "Upper-Right", "Lower-Left", "Lower-Right"
  };
  osdTime: {
    enable: number; // 0 = disabled, 1 = enabled
    pos: string; // Position
  };
  watermark: number; // Watermark enabled (0/1)
  bgcolor?: number; // Background color enabled (0/1)
}
```

### Example

```typescript
const osd = await api.getOsd();
console.log(`Camera name: ${osd.osdChannel.name}`);
console.log(`Name visible: ${osd.osdChannel.enable === 1}`);
console.log(`Time visible: ${osd.osdTime.enable === 1}`);
```

---

## setOsd

Sets the On-Screen Display configuration.

```typescript
await api.setOsd(osd: OsdConfig, channel?: number);
// or
await api.setOsd(channel: number, osd: OsdConfig);
```

### Parameters

| Parameter | Type        | Required | Default | Description       |
| --------- | ----------- | -------- | ------- | ----------------- |
| `osd`     | `OsdConfig` | ✅       | -       | OSD configuration |
| `channel` | `number`    | ❌       | `0`     | Channel number    |

### Returns

`Promise<void>`

### Example

```typescript
// Get current config
const osd = await api.getOsd();

// Update camera name
osd.osdChannel.name = "Front Door Camera";
osd.osdChannel.enable = 1;

// Show timestamp
osd.osdTime.enable = 1;
osd.osdTime.pos = "Lower-Right";

// Apply changes
await api.setOsd(osd);
console.log("OSD updated");
```

### Hide All OSD Elements

```typescript
const osd = await api.getOsd();
osd.osdChannel.enable = 0;
osd.osdTime.enable = 0;
osd.watermark = 0;
await api.setOsd(osd);
```

### Position Reference

| Position        | Description         |
| --------------- | ------------------- |
| `"Upper-Left"`  | Top-left corner     |
| `"Upper-Right"` | Top-right corner    |
| `"Lower-Left"`  | Bottom-left corner  |
| `"Lower-Right"` | Bottom-right corner |

---

## getOsdDatetime

Gets OSD datetime configuration details.

```typescript
const datetime = await api.getOsdDatetime(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<BaichuanGetOsdDatetimeResult>`

```typescript
interface BaichuanGetOsdDatetimeResult {
  osdDatetime?: {
    channelId?: number;
    enable?: boolean;
    topLeftX?: number;
    topLeftY?: number;
    width?: number;
    height?: number;
    language?: string;
  };
  osdChannelName?: {
    channelId?: number;
    name?: string;
    enable?: boolean;
    topLeftX?: number;
    topLeftY?: number;
    enWatermark?: boolean;
    enBgcolor?: boolean;
  };
}
```

---

## getGeneralXml

Gets general settings as raw XML.

```typescript
const xml = await api.getGeneralXml(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<string>` - Raw XML configuration

---

## setGeneralXml

Sets general settings from raw XML.

```typescript
await api.setGeneralXml(xml: string);
// or with channel
await api.setGeneralXml(channel: number | undefined, xml: string);
```

### Parameters

| Parameter | Type     | Required | Description           |
| --------- | -------- | -------- | --------------------- |
| `channel` | `number` | ❌       | Channel number        |
| `xml`     | `string` | ✅       | Raw XML configuration |

### Returns

`Promise<void>`

---

## getSystemGeneral

Gets general system settings.

```typescript
const general = await api.getSystemGeneral(options?: {
  channel?: number;
  timeoutMs?: number;
});
```

### Parameters

| Parameter           | Type     | Required | Default | Description    |
| ------------------- | -------- | -------- | ------- | -------------- |
| `options.channel`   | `number` | ❌       | `0`     | Channel number |
| `options.timeoutMs` | `number` | ❌       | `10000` | Timeout        |

### Returns

`Promise<SystemGeneralConfig>`

---

## Complete OSD Setup Example

```typescript
async function setupOsdForAllChannels(cameraName: string) {
  const channelCount = await api.getChannelCount();

  for (let ch = 0; ch < channelCount; ch++) {
    try {
      const osd = await api.getOsd(ch);

      // Set camera name with channel number
      osd.osdChannel.name = `${cameraName} - CH${ch + 1}`;
      osd.osdChannel.enable = 1;
      osd.osdChannel.pos = "Upper-Left";

      // Enable timestamp
      osd.osdTime.enable = 1;
      osd.osdTime.pos = "Lower-Right";

      // Enable watermark
      osd.watermark = 1;

      await api.setOsd(ch, osd);
      console.log(`Channel ${ch} OSD configured`);
    } catch (error) {
      console.log(`Channel ${ch} skipped (offline?)`);
    }
  }
}

await setupOsdForAllChannels("Office");
```

---

[← Back to Baichuan API](./README.md)
