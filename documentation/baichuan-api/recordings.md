# Recordings & Playback

Methods for searching, downloading, and playing back recorded video clips.

## Table of Contents

- [getVideoclips](#getvideoclips)
- [downloadRecording](#downloadrecording)
- [downloadRecordingDemuxed](#downloadrecordingdemuxed)
- [getRecordingVideo](#getrecordingvideo)
- [getRecordingThumbnail](#getrecordingthumbnail)
- [getVideoclipThumbnail](#getvideoclipthumbnail)
- [getVideoclipThumbnailJpeg](#getvideoclipthumbnailJpeg)
- [snapshotFromRecording](#snapshotfromrecording)
- [startRecordingReplayStream](#startrecordingreplaystream)
- [createRecordingReplayMp4Stream](#createrecordingreplaymp4stream)
- [createRecordingDownloadMp4Stream](#createrecordingdownloadmp4stream)
- [getRecordingPlaybackUrls](#getrecordingplaybackurls)
- [getVodRtmpUrl](#getvodrtmpurl)
- [predownloadRecordingMp4](#predownloadrecordingmp4)
- [getDayRecords](#getdayrecords)
- [getRecordCfg](#getrecordcfg)
- [getRecordSchedule](#getrecordschedule)

---

## getVideoclips

Searches for recorded video clips within a time range.

```typescript
const recordings = await api.getVideoclips(params: GetVideoclipsParams);
```

### Parameters

| Parameter           | Type       | Required | Default  | Description                      |
| ------------------- | ---------- | -------- | -------- | -------------------------------- |
| `params.channel`    | `number`   | ❌       | `0`      | Channel number                   |
| `params.startTime`  | `Date`     | ✅       | -        | Start of search range            |
| `params.endTime`    | `Date`     | ✅       | -        | End of search range              |
| `params.streamType` | `string`   | ❌       | `"main"` | Stream type: `"main"` or `"sub"` |
| `params.eventTypes` | `string[]` | ❌       | -        | Filter by event types            |

### Returns

`Promise<RecordingFile[]>`

```typescript
interface RecordingFile {
  filename: string;
  startTime: Date;
  endTime: Date;
  size: number;
  frameRate?: number;
  width?: number;
  height?: number;
  eventType?: string;
}
```

### Example

```typescript
const recordings = await api.getVideoclips({
  channel: 0,
  startTime: new Date("2024-01-15T00:00:00"),
  endTime: new Date("2024-01-15T23:59:59"),
});

console.log(`Found ${recordings.length} recordings`);
for (const rec of recordings) {
  console.log(`${rec.filename}: ${rec.startTime} - ${rec.endTime}`);
}
```

---

## downloadRecording

Downloads a complete recording file as a buffer.

```typescript
const buffer = await api.downloadRecording(params: DownloadRecordingParams);
```

### Parameters

| Parameter          | Type     | Required | Default | Description                     |
| ------------------ | -------- | -------- | ------- | ------------------------------- |
| `params.filename`  | `string` | ✅       | -       | Recording filename              |
| `params.channel`   | `number` | ❌       | `0`     | Channel number                  |
| `params.startTime` | `Date`   | ❌       | -       | Start time (if not in filename) |
| `params.endTime`   | `Date`   | ❌       | -       | End time (if not in filename)   |

### Returns

`Promise<Buffer>` - Complete recording file

### Example

```typescript
import { writeFileSync } from "node:fs";

const recordings = await api.getVideoclips({
  startTime: new Date("2024-01-15T10:00:00"),
  endTime: new Date("2024-01-15T10:05:00"),
});

if (recordings.length > 0) {
  const buffer = await api.downloadRecording({
    filename: recordings[0].filename,
  });
  writeFileSync("recording.mp4", buffer);
  console.log(`Downloaded ${buffer.length} bytes`);
}
```

---

## downloadRecordingDemuxed

Downloads a recording with separate video and audio tracks.

```typescript
const { video, audio } = await api.downloadRecordingDemuxed(params: DownloadRecordingParams);
```

### Returns

```typescript
Promise<{
  video: Buffer[];
  audio: Buffer[];
  videoType: string;
  audioType: string;
}>;
```

---

## getRecordingVideo

Gets recording video as a stream with callbacks.

```typescript
await api.getRecordingVideo(params: {
  filename: string;
  channel?: number;
  onVideoAccessUnit?: (unit: VideoAccessUnit) => void;
  onAudioFrame?: (frame: AudioFrame) => void;
});
```

### Parameters

| Parameter                  | Type       | Required | Description          |
| -------------------------- | ---------- | -------- | -------------------- |
| `params.filename`          | `string`   | ✅       | Recording filename   |
| `params.channel`           | `number`   | ❌       | Channel number       |
| `params.onVideoAccessUnit` | `function` | ❌       | Video frame callback |
| `params.onAudioFrame`      | `function` | ❌       | Audio frame callback |

### Example

```typescript
await api.getRecordingVideo({
  filename: "Rec_20240115_100000_main.mp4",
  onVideoAccessUnit: ({ annexB, microseconds }) => {
    console.log(`Video frame: ${annexB.length} bytes at ${microseconds}µs`);
  },
  onAudioFrame: ({ audioType, data }) => {
    console.log(`Audio: ${audioType}, ${data.length} bytes`);
  },
});
```

---

## getRecordingThumbnail

Gets a thumbnail image from a recording.

```typescript
const thumbnail = await api.getRecordingThumbnail(params: {
  filename: string;
  channel?: number;
  offsetMs?: number;
});
```

### Parameters

| Parameter         | Type     | Required | Default | Description             |
| ----------------- | -------- | -------- | ------- | ----------------------- |
| `params.filename` | `string` | ✅       | -       | Recording filename      |
| `params.channel`  | `number` | ❌       | `0`     | Channel number          |
| `params.offsetMs` | `number` | ❌       | `0`     | Offset from start in ms |

### Returns

`Promise<Buffer>` - JPEG image data

---

## getVideoclipThumbnail

Gets a thumbnail for a video clip.

```typescript
const thumbnail = await api.getVideoclipThumbnail(params: {
  channel?: number;
  startTime: Date;
  endTime: Date;
});
```

### Returns

`Promise<Buffer>` - Thumbnail image data

---

## getVideoclipThumbnailJpeg

Gets a JPEG thumbnail for a video clip.

```typescript
const jpeg = await api.getVideoclipThumbnailJpeg(params: {
  channel?: number;
  filename?: string;
  startTime?: Date;
  endTime?: Date;
});
```

### Returns

`Promise<Buffer>` - JPEG image data

### Example

```typescript
import { writeFileSync } from "node:fs";

const recordings = await api.getVideoclips({
  startTime: new Date("2024-01-15T10:00:00"),
  endTime: new Date("2024-01-15T12:00:00"),
});

for (const rec of recordings.slice(0, 5)) {
  const thumbnail = await api.getVideoclipThumbnailJpeg({
    filename: rec.filename,
  });
  writeFileSync(`thumb_${rec.filename}.jpg`, thumbnail);
}
```

---

## snapshotFromRecording

Extracts a snapshot frame from a recording.

```typescript
const snapshot = await api.snapshotFromRecording(params: {
  filename: string;
  channel?: number;
  offsetMs?: number;
  format?: "jpeg" | "png";
});
```

### Parameters

| Parameter         | Type     | Required | Default  | Description        |
| ----------------- | -------- | -------- | -------- | ------------------ |
| `params.filename` | `string` | ✅       | -        | Recording filename |
| `params.channel`  | `number` | ❌       | `0`      | Channel number     |
| `params.offsetMs` | `number` | ❌       | `0`      | Offset from start  |
| `params.format`   | `string` | ❌       | `"jpeg"` | Output format      |

### Returns

`Promise<Buffer>` - Image data

---

## startRecordingReplayStream

Starts a replay stream for a recording.

```typescript
const stream = await api.startRecordingReplayStream(params: {
  filename: string;
  channel?: number;
  onVideoFrame?: (frame: VideoFrame) => void;
  onAudioFrame?: (frame: AudioFrame) => void;
});
```

### Returns

Stream control object for playback management.

---

## createRecordingReplayMp4Stream

Creates an MP4 stream from a recording for replay.

```typescript
const mp4Stream = await api.createRecordingReplayMp4Stream(params: {
  filename: string;
  channel?: number;
  startTime?: Date;
  endTime?: Date;
});
```

### Returns

`Promise<Readable>` - Node.js readable stream of MP4 data

---

## createRecordingDownloadMp4Stream

Creates an MP4 download stream from a recording.

```typescript
const mp4Stream = await api.createRecordingDownloadMp4Stream(params: {
  filename: string;
  channel?: number;
});
```

### Returns

`Promise<Readable>` - Node.js readable stream of MP4 data

### Example

```typescript
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const mp4Stream = await api.createRecordingDownloadMp4Stream({
  filename: "Rec_20240115_100000_main.mp4",
});

await pipeline(mp4Stream, createWriteStream("output.mp4"));
console.log("Download complete");
```

---

## getRecordingPlaybackUrls

Gets playback URLs for a recording.

```typescript
const urls = await api.getRecordingPlaybackUrls(params: {
  filename: string;
  channel?: number;
});
```

### Returns

```typescript
Promise<{
  rtmpUrl?: string;
  httpUrl?: string;
  rtspUrl?: string;
}>;
```

---

## getVodRtmpUrl

Gets the RTMP URL for Video-on-Demand playback.

```typescript
const rtmpUrl = await api.getVodRtmpUrl(params: {
  filename: string;
  channel?: number;
});
```

### Returns

`Promise<string>` - RTMP playback URL

---

## predownloadRecordingMp4

Pre-downloads a recording MP4 to camera storage for faster access.

```typescript
await api.predownloadRecordingMp4(params: {
  filename: string;
  channel?: number;
});
```

---

## getDayRecords

Gets a summary of recordings for specific days.

```typescript
const dayRecords = await api.getDayRecords(params: {
  channel?: number;
  year: number;
  month: number;
});
```

### Returns

Array of days in the month that have recordings.

### Example

```typescript
const days = await api.getDayRecords({
  year: 2024,
  month: 1,
});
console.log("Days with recordings:", days);
// [1, 3, 5, 7, 10, 15, ...]
```

---

## getRecordCfg

Gets recording configuration.

```typescript
const config = await api.getRecordCfg(channel?: number);
```

### Returns

`Promise<BaichuanRecordCfg>`

---

## getRecordSchedule

Gets recording schedule configuration.

```typescript
const schedule = await api.getRecordSchedule(channel?: number);
```

### Returns

`Promise<BaichuanRecordSchedule>`

---

[← Back to Baichuan API](./README.md)
