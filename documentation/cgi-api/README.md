# CGI API Reference

The `ReolinkCgiApi` class provides HTTP-based access to Reolink cameras through the CGI interface (port 80/443).

## Quick Start

```typescript
import { ReolinkCgiApi } from "@apocaliss92/nodelink-js";

const cgi = new ReolinkCgiApi({
  host: "192.168.1.100",
  port: 80,
  username: "admin",
  password: "your-password",
});

// API calls are automatically authenticated
const deviceInfo = await cgi.getInfo();
console.log(`Camera: ${deviceInfo.model}`);
```

## Table of Contents

- [Constructor](#constructor)
- [Authentication](#authentication)
- [Device Information](#device-information)
- [Channels & NVR](#channels--nvr)
- [Encoding & Streams](#encoding--streams)
- [Events & Detection](#events--detection)
- [Camera Settings](#camera-settings)
- [Recordings & Playback](#recordings--playback)
- [Network](#network)
- [Raw Commands](#raw-commands)

---

## Constructor

```typescript
const cgi = new ReolinkCgiApi(options: ReolinkCgiApiOptions);
```

### Options

| Parameter  | Type      | Required | Default | Description          |
| ---------- | --------- | -------- | ------- | -------------------- |
| `host`     | `string`  | ✅       | -       | Camera IP address    |
| `port`     | `number`  | ❌       | `80`    | HTTP port            |
| `username` | `string`  | ✅       | -       | Login username       |
| `password` | `string`  | ✅       | -       | Login password       |
| `https`    | `boolean` | ❌       | `false` | Use HTTPS            |
| `timeout`  | `number`  | ❌       | `30000` | Request timeout (ms) |

---

## Authentication

### login

Explicitly logs in to obtain a session token.

```typescript
await cgi.login();
```

### logout

Logs out and invalidates the session token.

```typescript
await cgi.logout();
```

> Note: Most methods automatically handle authentication. Explicit login is rarely needed.

---

## Device Information

### getInfo / GetDevInfo

Gets device information.

```typescript
const info = await cgi.getInfo();
// or
const rawInfo = await cgi.GetDevInfo();
```

#### Returns

```typescript
interface ReolinkDeviceInfo {
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  hardwareVersion: string;
  name: string;
  channelCount: number;
  // ... additional fields
}
```

#### Example

```typescript
const info = await cgi.getInfo();
console.log(`Model: ${info.model}`);
console.log(`Firmware: ${info.firmwareVersion}`);
console.log(`Channels: ${info.channelCount}`);
```

---

### GetAbility

Gets device abilities/capabilities.

```typescript
const abilities = await cgi.GetAbility();
```

#### Returns

`Promise<Array<ReolinkCmdResponseExt<CgiAbility>>>`

---

## Channels & NVR

### getChannels

Gets information about all channels.

```typescript
const channels = await cgi.getChannels(options?: {
  useChannelNumFallback?: boolean;
});
```

#### Returns

```typescript
Promise<{
  channels: ChannelInfo[];
  count: number;
}>;
```

---

### getDevicesInfo

Gets detailed device information for all channels (NVR).

```typescript
const devices = await cgi.getDevicesInfo(options?: {
  useChannelNumFallback?: boolean;
});
```

---

### getNvrInfo

Gets NVR-specific information.

```typescript
const nvrInfo = await cgi.getNvrInfo();
```

---

### GetChannelstatus

Gets status of all channels.

```typescript
const status = await cgi.GetChannelstatus();
```

#### Returns

```typescript
Promise<ReolinkCmdResponse<CgiGetChannelstatusValue>>;
```

```typescript
interface CgiGetChannelstatusValue {
  status?: Array<{
    channel: number;
    name?: string;
    online?: number;
    sleep?: number;
    uid?: string;
    typeInfo?: string;
  }>;
}
```

---

### GetChnTypeInfo

Gets channel type information.

```typescript
const typeInfo = await cgi.GetChnTypeInfo(channel?: number);
```

---

## Encoding & Streams

### GetEnc

Gets encoding configuration.

```typescript
const enc = await cgi.GetEnc(channel?: number);
```

#### Returns

```typescript
Promise<Array<ReolinkCmdResponseExt<CgiEncValue>>>;
```

```typescript
interface CgiEnc {
  audio: number;
  channel: number;
  mainStream: {
    bitRate: number;
    frameRate: number;
    gop: number;
    height: number;
    width: number;
    profile: string;
    size: string;
    vType: string; // "h264" or "h265"
  };
  subStream: {
    bitRate: number;
    frameRate: number;
    gop: number;
    height: number;
    width: number;
    profile: string;
    size: string;
    vType: string;
  };
}
```

#### Example

```typescript
const encResponse = await cgi.GetEnc(0);
const enc = encResponse[0].value.Enc;
console.log(
  `Main: ${enc.mainStream.width}x${enc.mainStream.height} @ ${enc.mainStream.frameRate}fps (${enc.mainStream.vType})`,
);
console.log(
  `Sub: ${enc.subStream.width}x${enc.subStream.height} @ ${enc.subStream.frameRate}fps`,
);
```

---

### getEncoderConfiguration

Gets parsed encoder configuration.

```typescript
const enc = await cgi.getEncoderConfiguration(channel: number);
```

#### Returns

`Promise<CgiEnc | undefined>`

---

### GetRtspUrl / getRtspUrl

Gets RTSP URLs for a channel.

```typescript
const urls = await cgi.GetRtspUrl(channel: number);
// or simplified
const url = await cgi.getRtspUrl(channel: number);
```

#### Example

```typescript
const rtspUrl = await cgi.getRtspUrl(0);
console.log(`RTSP URL: ${rtspUrl}`);
// rtsp://192.168.1.100:554/h264Preview_01_main
```

---

## Events & Detection

### GetAiState

Gets AI detection state.

```typescript
const aiState = await cgi.GetAiState(channel?: number);
```

#### Returns

```typescript
Promise<ReolinkCmdResponse<CgiAiStateValue>[]>;
```

---

### GetMdState

Gets motion detection state.

```typescript
const mdState = await cgi.GetMdState(channel?: number);
```

---

### GetEvents

Gets events configuration.

```typescript
const events = await cgi.GetEvents(channel?: number);
```

---

### getAllChannelsEvents

Gets events for all channels.

```typescript
const allEvents = await cgi.getAllChannelsEvents(options?: {
  channels?: number[];
});
```

---

## Camera Settings

### GetOsd / getOsd

Gets OSD configuration.

```typescript
const osd = await cgi.GetOsd(channel?: number);
// or parsed
const osdConfig = await cgi.getOsd(channel: number);
```

---

### SetOsd / setOsd

Sets OSD configuration.

```typescript
await cgi.SetOsd(channel: number, osd: OsdConfig);
// or
await cgi.setOsd(channel: number, osd: any);
```

---

### GetWhiteLed / SetWhiteLed

Gets/sets white LED state.

```typescript
const led = await cgi.GetWhiteLed(channel?: number);
await cgi.SetWhiteLed(channel: number, config: WhiteLedConfig);
```

---

### setWhiteLedState

Simplified white LED control.

```typescript
await cgi.setWhiteLedState(channel: number, on: boolean);
```

---

### GetPirInfo / SetPirInfo

Gets/sets PIR sensor configuration.

```typescript
const pir = await cgi.GetPirInfo(channel?: number);
await cgi.SetPirInfo(channel: number, config: PirConfig);
```

---

### getPirState / setPirState

Simplified PIR control.

```typescript
const pirState = await cgi.getPirState(channel: number);
await cgi.setPirState(channel: number, on: boolean);
```

---

### getSiren / setSiren

Gets/sets siren state.

```typescript
const siren = await cgi.getSiren(channel: number);
await cgi.setSiren(channel: number, on: boolean, durationMs?: number);
```

---

## Battery

### GetBatteryInfo

Gets battery information.

```typescript
const battery = await cgi.GetBatteryInfo(channel?: number);
```

---

### getAllChannelsBatteryInfo

Gets battery info for all channels.

```typescript
const batteries = await cgi.getAllChannelsBatteryInfo(options?: {
  channels?: number[];
});
```

---

## Recordings & Playback

### getVideoclips

Searches for video recordings.

```typescript
const recordings = await cgi.getVideoclips(params: {
  channel?: number;
  startTime: Date;
  endTime: Date;
  streamType?: "main" | "sub";
});
```

#### Returns

`Promise<RecordingFile[]>`

#### Example

```typescript
const recordings = await cgi.getVideoclips({
  channel: 0,
  startTime: new Date("2024-01-15T00:00:00"),
  endTime: new Date("2024-01-15T23:59:59"),
});

console.log(`Found ${recordings.length} recordings`);
```

---

### getVideoclipThumbnailJpeg

Gets a thumbnail for a recording.

```typescript
const thumbnail = await cgi.getVideoclipThumbnailJpeg(params: {
  channel?: number;
  filename: string;
});
```

#### Returns

`Promise<Buffer>` - JPEG image

---

### prepareNvrVodDownload

Prepares VOD download on NVR.

```typescript
const prepared = await cgi.prepareNvrVodDownload(params: {
  channel: number;
  filename: string;
});
```

---

### getVodUrl

Gets VOD playback URL.

```typescript
const url = await cgi.getVodUrl(params: {
  channel: number;
  filename: string;
});
```

---

### downloadVod

Downloads a recording.

```typescript
const buffer = await cgi.downloadVod(params: {
  channel: number;
  filename: string;
});
```

---

## Snapshots

### jpegSnapshot

Captures a JPEG snapshot.

```typescript
const jpeg = await cgi.jpegSnapshot(channel?: number);
```

#### Returns

`Promise<Buffer>` - JPEG image data

#### Example

```typescript
import { writeFileSync } from "node:fs";

const snapshot = await cgi.jpegSnapshot(0);
writeFileSync("snapshot.jpg", snapshot);
```

---

## Network

### GetNetPort / SetNetPort

Gets/sets network port configuration.

```typescript
const ports = await cgi.GetNetPort();
await cgi.SetNetPort(config: NetPortConfig);
```

---

### GetLocalLink / getLocalLink

Gets network link information.

```typescript
const link = await cgi.GetLocalLink(channel?: number);
// or parsed
const linkInfo = await cgi.getLocalLink(channel: number);
```

---

### GetWifiSignal

Gets WiFi signal strength.

```typescript
const signal = await cgi.GetWifiSignal(channel?: number);
```

---

## System

### Reboot

Reboots the camera.

```typescript
await cgi.Reboot(channel?: number);
```

---

### GetPtzPreset

Gets PTZ presets.

```typescript
const presets = await cgi.GetPtzPreset(channel?: number);
```

---

### AudioAlarmPlay

Plays an audio alarm.

```typescript
await cgi.AudioAlarmPlay(channel: number, config: AudioAlarmConfig);
```

---

### GetAudioAlarmV20

Gets audio alarm configuration.

```typescript
const audioAlarm = await cgi.GetAudioAlarmV20(channel?: number);
```

---

## Raw Commands

### call

Executes a single CGI command.

```typescript
const response = await cgi.call<TValue, TParam>(
  cmd: string,
  params?: TParam,
  options?: CallOptions
);
```

#### Example

```typescript
const response = await cgi.call("GetDevInfo");
console.log(response);
```

---

### callMany

Executes multiple CGI commands in one request.

```typescript
const responses = await cgi.callMany<TValue>(
  requests: ReolinkCmdRequest[]
);
```

#### Example

```typescript
const responses = await cgi.callMany([
  { cmd: "GetDevInfo" },
  { cmd: "GetEnc", param: { channel: 0 } },
  { cmd: "GetOsd", param: { channel: 0 } },
]);
```

---

## Diagnostics

### collectNvrDiagnostics

Collects comprehensive NVR diagnostics.

```typescript
const diagnostics = await cgi.collectNvrDiagnostics(options: {
  outputDir: string;
});
```

---

### getStatusInfo

Gets status information for channels.

```typescript
const status = await cgi.getStatusInfo(channelsMap: Map<number, DeviceInputData>);
```

---

## Error Handling

```typescript
try {
  const info = await cgi.getInfo();
} catch (error) {
  if (error.response?.status === 401) {
    console.error("Authentication failed");
  } else if (error.code === "ECONNREFUSED") {
    console.error("Cannot connect to camera");
  } else {
    console.error("Error:", error.message);
  }
}
```

---

## CGI vs Baichuan API

| Feature        | CGI API                  | Baichuan API         |
| -------------- | ------------------------ | -------------------- |
| Protocol       | HTTP/HTTPS               | Binary TCP           |
| Port           | 80/443                   | 9000                 |
| Authentication | Per-request              | Session-based        |
| Streaming      | ❌                       | ✅                   |
| Events         | Polling                  | Push                 |
| Two-way Audio  | ❌                       | ✅                   |
| Best For       | Configuration, snapshots | Streaming, real-time |

---

[← Back to Main Documentation](../README.md)
