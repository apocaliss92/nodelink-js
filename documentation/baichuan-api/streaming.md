# Video Streaming

Methods for live video streaming from Reolink cameras.

## Table of Contents

- [startVideoStream](#startvideostream)
- [stopVideoStream](#stopvideostream)
- [createRtspStream](#creatertspstream)
- [getRtspUrl](#getrtspurl)
- [getStreamInfoList](#getstreaminfolist)
- [getStreamMetadata](#getstreammetadata)
- [buildVideoStreamOptions](#buildvideostreamoptions)
- [getEncXml](#getencxml)
- [setEncXml](#setencxml)
- [setStreamVideoCodec](#setstreamvideocodec)

---

## startVideoStream

Starts a native video stream from the camera.

```typescript
const stream = await api.startVideoStream(options: StartVideoStreamOptions);
```

### Parameters

| Parameter              | Type                       | Required | Default  | Description                                   |
| ---------------------- | -------------------------- | -------- | -------- | --------------------------------------------- |
| `options.channel`      | `number`                   | ❌       | `0`      | Channel number                                |
| `options.profile`      | `StreamProfile`            | ❌       | `"main"` | Stream profile: `"main"`, `"sub"`, or `"ext"` |
| `options.variant`      | `NativeVideoStreamVariant` | ❌       | -        | Variant for TrackMix cameras                  |
| `options.onVideoFrame` | `function`                 | ❌       | -        | Callback for video frames                     |
| `options.onAudioFrame` | `function`                 | ❌       | -        | Callback for audio frames                     |

### Stream Profiles

| Profile | Description                    | Typical Resolution |
| ------- | ------------------------------ | ------------------ |
| `main`  | Main/High quality stream       | 4K/2K/1080p        |
| `sub`   | Sub/Low quality stream         | 640x480 or similar |
| `ext`   | Extended stream (if available) | Varies             |

### Returns

`Promise<BaichuanVideoStream>` - Stream object with control methods

### Example

```typescript
const stream = await api.startVideoStream({
  channel: 0,
  profile: "main",
  onVideoFrame: (frame) => {
    console.log(
      `Video frame: ${frame.data.length} bytes, keyframe: ${frame.isKeyframe}`,
    );
  },
  onAudioFrame: (frame) => {
    console.log(`Audio frame: ${frame.data.length} bytes`);
  },
});

// Stop after 30 seconds
setTimeout(async () => {
  await stream.stop();
}, 30000);
```

---

## stopVideoStream

Stops an active video stream.

```typescript
await api.stopVideoStream(stream: BaichuanVideoStream);
```

### Parameters

| Parameter | Type                  | Required | Description    |
| --------- | --------------------- | -------- | -------------- |
| `stream`  | `BaichuanVideoStream` | ✅       | Stream to stop |

### Returns

`Promise<void>`

---

## createRtspStream

Creates an RTSP server for the camera stream.

```typescript
const rtspServer = await api.createRtspStream(options: RtspStreamOptions);
// or with channel
const rtspServer = await api.createRtspStream(channel: number, options: RtspStreamOptions);
```

### Parameters

| Parameter         | Type            | Required | Default     | Description         |
| ----------------- | --------------- | -------- | ----------- | ------------------- |
| `channel`         | `number`        | ❌       | `0`         | Channel number      |
| `options.profile` | `StreamProfile` | ❌       | `"main"`    | Stream profile      |
| `options.listenPort` | `number`     | ❌       | `8554`        | Port to listen on     |
| `options.listenHost` | `string`     | ❌       | `"127.0.0.1"` | Host to listen on     |

### Returns

`Promise<BaichuanRtspServer>`

### Example

```typescript
const rtspServer = await api.createRtspStream({
  profile: "main",
  listenPort: 8554,
});

await rtspServer.start();
console.log("RTSP URL:", rtspServer.url);
// rtsp://localhost:8554/stream

// Clean up when done
await rtspServer.stop();
```

---

## getRtspUrl

Gets the native RTSP URL for the camera.

```typescript
const url = await api.getRtspUrl(channel: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ✅       | -       | Channel number |

### Returns

`Promise<string>` - RTSP URL

### Example

```typescript
const rtspUrl = await api.getRtspUrl(0);
console.log("Native RTSP URL:", rtspUrl);
// rtsp://192.168.1.100:554/h264Preview_01_main
```

---

## getStreamInfoList

Gets available stream information for all profiles.

```typescript
const streamInfo = await api.getStreamInfoList(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<StreamInfoList>`

### Example

```typescript
const streams = await api.getStreamInfoList();
console.log("Main stream:", streams.mainStream);
console.log("Sub stream:", streams.subStream);
// {
//   resolution: "3840x2160",
//   codec: "H265",
//   fps: 15,
//   bitrate: 8192
// }
```

---

## getStreamMetadata

Gets metadata for a channel's streams including codec information.

```typescript
const metadata = await api.getStreamMetadata(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<ChannelStreamMetadata>`

---

## buildVideoStreamOptions

Builds optimal video stream options based on device capabilities.

```typescript
const options = await api.buildVideoStreamOptions(options?: {
  channel?: number;
  profile?: StreamProfile;
  variant?: NativeVideoStreamVariant;
  onNvr?: boolean;
});
```

### Returns

Configuration object for starting a video stream with optimal settings.

---

## getEncXml

Gets encoder configuration as raw XML.

```typescript
const encXml = await api.getEncXml(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<string>` - Raw XML configuration

---

## setEncXml

Sets encoder configuration from raw XML.

```typescript
await api.setEncXml(xml: string);
// or with channel
await api.setEncXml(channel: number, xml: string);
```

### Parameters

| Parameter | Type     | Required | Description           |
| --------- | -------- | -------- | --------------------- |
| `channel` | `number` | ❌       | Channel number        |
| `xml`     | `string` | ✅       | Raw XML configuration |

### Returns

`Promise<void>`

---

## setStreamVideoCodec

Sets the video codec for a specific stream.

```typescript
await api.setStreamVideoCodec(
  codec: "H264" | "H265",
  profile?: StreamProfile
);
// or with channel
await api.setStreamVideoCodec(
  channel: number,
  codec: "H264" | "H265",
  profile?: StreamProfile
);
```

### Parameters

| Parameter | Type                 | Required | Default  | Description    |
| --------- | -------------------- | -------- | -------- | -------------- |
| `channel` | `number`             | ❌       | `0`      | Channel number |
| `codec`   | `"H264"` \| `"H265"` | ✅       | -        | Video codec    |
| `profile` | `StreamProfile`      | ❌       | `"main"` | Stream profile |

### Returns

`Promise<void>`

### Example

```typescript
// Switch main stream to H.264
await api.setStreamVideoCodec("H264", "main");

// Switch sub stream to H.265 on channel 1
await api.setStreamVideoCodec(1, "H265", "sub");
```

---

[← Back to Baichuan API](./README.md)
