# Bifocal/Multi-Focal Camera Stream Handling

This document explains how to handle video streams for bifocal/multi-focal cameras like Reolink TrackMix.

## Overview

Bifocal cameras (e.g., Reolink TrackMix) have two lenses:
- **Wide-angle lens** (channel 0): Provides a wider field of view
- **Telephoto lens** (channel 1): Provides a zoomed/telephoto view

These cameras are detected as `multifocal` devices with `channelNum = 2` (or sometimes 3).

## Stream Construction

### Basic Stream Setup

For bifocal cameras, you need to subscribe to streams for each channel separately:

```typescript
import { ReolinkBaichuanApi } from "@reolink/baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
  transport: "tcp",
});

await api.login();

// Subscribe to wide-angle stream (channel 0)
const wideStream = await api.subscribeVideoStream({
  channel: 0,
  profile: "main", // or "sub", "ext"
});

// Subscribe to telephoto stream (channel 1)
const teleStream = await api.subscribeVideoStream({
  channel: 1,
  profile: "main", // or "sub", "ext"
});

// Handle frames from both streams
wideStream.on("videoFrame", (frame) => {
  // Process wide-angle frames
  console.log(`Wide frame: ${frame.data.length} bytes`);
});

teleStream.on("videoFrame", (frame) => {
  // Process telephoto frames
  console.log(`Tele frame: ${frame.data.length} bytes`);
});
```

### Stream Profiles

Each channel supports the same stream profiles:
- `main`: Main stream (highest quality)
- `sub`: Sub stream (lower quality, lower bandwidth)
- `ext`: External stream (if supported)

You can subscribe to different profiles for each channel:

```typescript
// Wide-angle: main stream
const wideMain = await api.subscribeVideoStream({
  channel: 0,
  profile: "main",
});

// Telephoto: sub stream (to save bandwidth)
const teleSub = await api.subscribeVideoStream({
  channel: 1,
  profile: "sub",
});
```

## Auto-Tracking

Bifocal cameras like TrackMix support auto-tracking functionality. The `supportAutoTrackStream` capability indicates if auto-tracking is available.

### Checking Auto-Track Capability

```typescript
import { ReolinkCgiApi } from "@reolink/baichuan-js";

const cgi = new ReolinkCgiApi({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
});

await cgi.login();

const nvrInfo = await cgi.getNvrInfo();
const abilities = nvrInfo.abilities;

if (abilities?.supportAutoTrackStream?.value === 1) {
  console.log("Auto-tracking is supported");
}
```

### Auto-Tracking Modes

TrackMix cameras support different auto-tracking modes:
- **Digital Tracking**: Digital zoom within the wide-angle view
- **Digital Tracking First**: Starts with digital tracking, switches to pan/tilt if needed
- **Pan/Tilt Tracking First**: Uses pan/tilt movement to track objects

These settings are typically configured via the Reolink Client app or CGI API, not directly through Baichuan protocol.

## Implementation Notes

### Channel Detection

When detecting a bifocal camera:

```typescript
import { autoDetectDeviceType } from "@reolink/baichuan-js";

const result = await autoDetectDeviceType({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
});

if (result.type === "multifocal" && result.channelNum === 2) {
  // This is a bifocal camera
  // Channel 0 = wide-angle
  // Channel 1 = telephoto
}
```

### Stream Metadata

Get stream metadata for each channel:

```typescript
// Get metadata for wide-angle channel
const wideMetadata = await api.getStreamMetadata(0);
console.log(`Wide stream: ${wideMetadata.streams[0].width}x${wideMetadata.streams[0].height}`);

// Get metadata for telephoto channel
const teleMetadata = await api.getStreamMetadata(1);
console.log(`Tele stream: ${teleMetadata.streams[0].width}x${teleMetadata.streams[0].height}`);
```

### RTSP Streams

For RTSP streams, use the standard RTSP path format:

```typescript
import { buildRtspUrl } from "@reolink/baichuan-js";

// Wide-angle RTSP URL
const wideRtsp = buildRtspUrl({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
  channel: 0, // Wide-angle
  stream: "main",
});

// Telephoto RTSP URL
const teleRtsp = buildRtspUrl({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
  channel: 1, // Telephoto
  stream: "main",
});
```

## Reference Implementation Notes

Based on reference implementations (neolink/reolink-aio):

1. **Channel Mapping**: 
   - Channel 0 = Wide-angle lens
   - Channel 1 = Telephoto lens
   - Channel 2 = May exist for some models (e.g., 3-lens cameras)

2. **Stream Construction**:
   - Each channel is treated as an independent stream
   - Use `startVideoStream(channel, profile)` for each channel
   - The Preview XML includes `handle` and `streamType` but channel is in the header

3. **Auto-Tracking**:
   - Auto-tracking is typically configured via CGI API, not Baichuan
   - The `supportAutoTrackStream` capability indicates availability
   - Tracking modes are set via Reolink Client or CGI commands

## Example: Dual Stream Setup

```typescript
async function setupBifocalStreams(api: ReolinkBaichuanApi) {
  // Subscribe to both channels
  const wideStream = await api.subscribeVideoStream({
    channel: 0,
    profile: "main",
  });

  const teleStream = await api.subscribeVideoStream({
    channel: 1,
    profile: "main",
  });

  // Combine frames from both streams
  wideStream.on("videoFrame", (frame) => {
    // Process wide-angle frame
    handleWideFrame(frame);
  });

  teleStream.on("videoFrame", (frame) => {
    // Process telephoto frame
    handleTeleFrame(frame);
  });

  return {
    wideStream,
    teleStream,
    stop: async () => {
      await wideStream.stop();
      await teleStream.stop();
    },
  };
}
```

## Troubleshooting

1. **No channels detected**: Use `useChannelNumFallback: true` in `getChannels()` for multi-focal cameras
2. **Stream not starting**: Ensure you're using the correct channel number (0 or 1)
3. **Auto-tracking not working**: Verify `supportAutoTrackStream` capability and configure via CGI API

