# Images & Snapshots

Methods for capturing images and snapshots.

## Table of Contents

- [getSnapshot](#getsnapshot)
- [snapshotFromRecording](#snapshotfromrecording)
- [getVideoclipThumbnailJpeg](#getvideoclipthumbnailJpeg)
- [generateMp4Screenshot](#generatemp4screenshot)

---

## getSnapshot

Captures a live snapshot from the camera.

```typescript
const snapshot = await api.getSnapshot(options?: SnapshotOptions);
```

### Parameters

| Parameter           | Type            | Required | Default  | Description                   |
| ------------------- | --------------- | -------- | -------- | ----------------------------- |
| `options.channel`   | `number`        | ❌       | `0`      | Channel number                |
| `options.profile`   | `StreamProfile` | ❌       | `"main"` | Stream profile for resolution |
| `options.onNvr`     | `boolean`       | ❌       | `false`  | Whether on NVR/Hub            |
| `options.timeoutMs` | `number`        | ❌       | `10000`  | Timeout in milliseconds       |

### Returns

`Promise<Buffer>` - JPEG image data

### Example

```typescript
import { writeFileSync } from "node:fs";

// Basic snapshot
const snapshot = await api.getSnapshot();
writeFileSync("snapshot.jpg", snapshot);
console.log(`Saved snapshot: ${snapshot.length} bytes`);

// High-quality snapshot from main stream
const hqSnapshot = await api.getSnapshot({
  channel: 0,
  profile: "main",
});
writeFileSync("snapshot_hq.jpg", hqSnapshot);

// Snapshot from sub stream (faster, lower resolution)
const lqSnapshot = await api.getSnapshot({
  profile: "sub",
});
writeFileSync("snapshot_lq.jpg", lqSnapshot);
```

### Multi-Channel Snapshots

```typescript
// Get snapshots from all NVR channels
const channelCount = await api.getChannelCount();
const snapshots = await Promise.all(
  Array.from({ length: channelCount }, (_, i) =>
    api.getSnapshot({ channel: i }).catch(() => null),
  ),
);

snapshots.forEach((snapshot, channel) => {
  if (snapshot) {
    writeFileSync(`channel_${channel}.jpg`, snapshot);
  }
});
```

---

## snapshotFromRecording

Extracts a snapshot frame from a recorded video.

```typescript
const snapshot = await api.snapshotFromRecording(params: {
  filename: string;
  channel?: number;
  offsetMs?: number;
  format?: "jpeg" | "png";
});
```

### Parameters

| Parameter         | Type     | Required | Default  | Description                       |
| ----------------- | -------- | -------- | -------- | --------------------------------- |
| `params.filename` | `string` | ✅       | -        | Recording filename                |
| `params.channel`  | `number` | ❌       | `0`      | Channel number                    |
| `params.offsetMs` | `number` | ❌       | `0`      | Offset from recording start in ms |
| `params.format`   | `string` | ❌       | `"jpeg"` | Output format                     |

### Returns

`Promise<Buffer>` - Image data in specified format

### Example

```typescript
// Get snapshot from beginning of recording
const snapshot = await api.snapshotFromRecording({
  filename: "Rec_20240115_100000_main.mp4",
});

// Get snapshot from 10 seconds into recording
const snapshot10s = await api.snapshotFromRecording({
  filename: "Rec_20240115_100000_main.mp4",
  offsetMs: 10000,
});

// Get PNG format
const pngSnapshot = await api.snapshotFromRecording({
  filename: "Rec_20240115_100000_main.mp4",
  format: "png",
});
```

---

## getVideoclipThumbnailJpeg

Gets a JPEG thumbnail for a video clip / recording.

```typescript
const thumbnail = await api.getVideoclipThumbnailJpeg(params: {
  channel?: number;
  filename?: string;
  startTime?: Date;
  endTime?: Date;
});
```

### Parameters

| Parameter          | Type     | Required | Description                 |
| ------------------ | -------- | -------- | --------------------------- |
| `params.channel`   | `number` | ❌       | Channel number              |
| `params.filename`  | `string` | ❌       | Recording filename          |
| `params.startTime` | `Date`   | ❌       | Start time (if no filename) |
| `params.endTime`   | `Date`   | ❌       | End time (if no filename)   |

### Returns

`Promise<Buffer>` - JPEG thumbnail data

### Example

```typescript
// Get thumbnail by filename
const thumb = await api.getVideoclipThumbnailJpeg({
  filename: "Rec_20240115_100000_main.mp4",
});
writeFileSync("thumb.jpg", thumb);

// Get thumbnail by time range
const thumbByTime = await api.getVideoclipThumbnailJpeg({
  channel: 0,
  startTime: new Date("2024-01-15T10:00:00"),
  endTime: new Date("2024-01-15T10:05:00"),
});
```

---

## generateMp4Screenshot

Generates a screenshot from an MP4 recording using FFmpeg.

```typescript
const screenshot = await api.generateMp4Screenshot(params: {
  filename: string;
  offsetMs?: number;
  quality?: number;
});
```

### Parameters

| Parameter         | Type     | Required | Default | Description                          |
| ----------------- | -------- | -------- | ------- | ------------------------------------ |
| `params.filename` | `string` | ✅       | -       | Recording filename                   |
| `params.offsetMs` | `number` | ❌       | `0`     | Offset from start in ms              |
| `params.quality`  | `number` | ❌       | `2`     | JPEG quality (2-31, lower is better) |

### Returns

`Promise<Buffer>` - JPEG image data

---

## Practical Examples

### Create Timeline Thumbnails

```typescript
async function generateTimelineThumbnails(
  filename: string,
  intervalMs: number = 5000,
) {
  const thumbnails: Buffer[] = [];
  let offset = 0;

  while (true) {
    try {
      const thumb = await api.snapshotFromRecording({
        filename,
        offsetMs: offset,
      });
      thumbnails.push(thumb);
      offset += intervalMs;
    } catch {
      break; // End of recording
    }
  }

  return thumbnails;
}

const thumbs = await generateTimelineThumbnails("Rec_20240115_100000_main.mp4");
thumbs.forEach((thumb, i) => {
  writeFileSync(`timeline_${i}.jpg`, thumb);
});
```

### Periodic Snapshot Capture

```typescript
async function capturePeriodicSnapshots(intervalMs: number, count: number) {
  const snapshots: { time: Date; data: Buffer }[] = [];

  for (let i = 0; i < count; i++) {
    const data = await api.getSnapshot();
    snapshots.push({ time: new Date(), data });

    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  return snapshots;
}

// Capture 10 snapshots, 1 second apart
const captures = await capturePeriodicSnapshots(1000, 10);
```

### Event-Triggered Snapshot

```typescript
api.on("motionAlarm", async (event) => {
  if (!event.state) return; // Only capture on motion start

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshot = await api.getSnapshot({ channel: event.channel });
  writeFileSync(`motion_${event.channel}_${timestamp}.jpg`, snapshot);
});
```

---

[← Back to Baichuan API](./README.md)
