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
- [searchAlarmVideos](#searchalarmvideos)
- [searchEventLog](#searcheventlog)
- [getRecordCfg](#getrecordcfg)
- [getRecordSchedule](#getrecordschedule)

---

## getVideoclips

Lists the recordings of ONE camera-local day via Baichuan FileInfoList (cmd 14 open → cmd 15 pages → cmd 16 close). Works for a standalone camera (channel 0) and for a channel behind an NVR/Home Hub over the hub's connection.

```typescript
const recordings = await api.getVideoclips(params: GetVideoclipsParams);
```

### Parameters (`GetVideoclipsParams`)

| Parameter                | Type                  | Required | Default                                                      | Description                                                                                                                                                |
| ------------------------ | --------------------- | -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params.channel`         | `number`              | ❌       | `0`                                                          | Logical channel. Required for an NVR/Hub child.                                                                                                            |
| `params.start`           | `Date`                | ✅       | -                                                            | Start of the search window.                                                                                                                                |
| `params.end`             | `Date`                | ✅       | -                                                            | End of the search window. **Clamped to 23:59:59.999 of `start`'s camera-local day** — Reolink answers one day per search; loop for a range.                |
| `params.timeZone`        | `string`              | ❌       | `recordingsTimeZone`, then host local                        | IANA zone of the camera's wall clock. The wire carries local time with no offset; this says how to write the window and read the timestamps.               |
| `params.streamType`      | `RecordingStreamType` | ❌       | `"subStream"`                                                | `"mainStream"` / `"subStream"` / `"externStream"`.                                                                                                         |
| `params.recordType`      | `string`              | ❌       | `DEFAULT_RECORDING_SEARCH_RECORD_TYPES` (the app's 16 types) | Comma-separated record types. A narrower list silently returns fewer files.                                                                                |
| `params.fileRecordTypes` | `readonly string[]`   | ❌       | `DEFAULT_RECORDING_SEARCH_FILE_RECORD_TYPES` (19 items)      | `<fileRecordType>` item list the app sends beside `recordType`; omitted when a custom `recordType` is given without it.                                    |
| `params.uid`             | `string`              | ❌       | discovered                                                   | Device UID (standalone) or child UID (NVR/Hub). Standalone: discovered with cmd 114 `GetUid`. NVR/Hub: from the cmd 145 push cache, or pass it explicitly. |
| `params.maxIterations`   | `number`              | ❌       | `50`                                                         | Page ceiling (≈40 files per page). A day with more clips is silently truncated.                                                                            |
| `params.timeoutMs`       | `number`              | ❌       | `15000`                                                      | Per-request timeout.                                                                                                                                       |

### Returns

`Promise<RecordingFile[]>` — de-duplicated by `fileName`.

```typescript
interface RecordingFile {
  /** Camera-provided identifier: the `<Id>` path when present, else `<name>`. This is the handle every byte-fetching call takes. */
  fileName: string;
  name?: string;
  id?: string;
  sizeBytes?: number;
  /** e.g. "md", "md,people", "none" (hub children) */
  recordType?: string;
  startTime?: Date;
  endTime?: Date;
  parsedFileName?: ParsedRecordingFileName;
  detectionClasses?: RecordingDetectionClass[];
}
```

Neither firmware captured (E1 Outdoor PoE v3.1.0.5223, Home Hub v3.3.0.456) sends `<bFinished>`; a listing ends on the first page shorter than 40 entries.

A search lists ONE stream's files. The official app runs a `subStream` and a `mainStream` search back to back for the same day; the two sets are twins (`RecS…` / `RecM…`) with different `name`/`Id` whose start seconds differ by 0–4 s, so match them by start time, not by name.

### Example

```typescript
const api = new ReolinkBaichuanApi({
  host,
  username,
  password,
  recordingsTimeZone: "Europe/Rome",
});
await api.login();

const dayStart = dateFromWallClock(
  { year: 2026, month: 9, day: 19, hour: 0, minute: 0, second: 0 },
  "Europe/Rome",
);
const recordings = await api.getVideoclips({
  channel: 0,
  start: dayStart,
  end: new Date(dayStart.getTime() + 86_400_000 - 1),
});
for (const rec of recordings) {
  console.log(
    `${rec.fileName}: ${rec.startTime?.toISOString()} – ${rec.endTime?.toISOString()} (${rec.recordType})`,
  );
}
```

---

## downloadRecording

Fetches a recording's bytes over Baichuan only (cmd 5 replay download, then cmd 13 and the paged cmd 14/15/16 as fallbacks). The result is the camera's own **BcMedia frame stream** (video + audio packets), not an MP4 — mux it (see `downloadRecordingDemuxed`).

```typescript
const buffer = await api.downloadRecording(params: DownloadRecordingParams);
```

### Parameters (`DownloadRecordingParams`)

| Parameter              | Type     | Required | Default    | Description                                                                                                                                                              |
| ---------------------- | -------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `params.channel`       | `number` | ✅       | -          | Logical channel.                                                                                                                                                         |
| `params.fileName`      | `string` | ✅       | -          | `RecordingFile.fileName` from `getVideoclips`.                                                                                                                           |
| `params.uid`           | `string` | ❌       | discovered | Child UID for an NVR/Hub channel (not sent for a standalone camera).                                                                                                     |
| `params.timeoutMs`     | `number` | ❌       | `120000`   | Ceiling on the whole transfer.                                                                                                                                           |
| `params.idleTimeoutMs` | `number` | ❌       | `2000`     | Completion window: the transfer is complete once no chunk arrived for this long. Nothing on the wire marks the end (no 201, no trailing frame). Raise it on a slow link. |

### Returns

`Promise<Buffer>` — the concatenated BcMedia stream, starting with the 32-byte stream header.

### Example

```typescript
const recordings = await api.getVideoclips({ channel: 0, start, end });
const clip = recordings[0];
const bcMedia = await api.downloadRecording({
  channel: 0,
  fileName: clip.fileName,
});
```

---

## downloadRecordingDemuxed

`downloadRecording` followed by a BcMedia demux: the video as Annex-B, **the
audio as its own elementary stream**, and the frame rate the mux needs.

```typescript
const { annexB, videoType, audio, stats } =
  await api.downloadRecordingDemuxed(params: DownloadRecordingParams);
```

Takes the same parameters as [`downloadRecording`](#downloadrecording).

### Returns

```typescript
Promise<{
  /** Concatenated video access units in Annex-B form (H.264 or H.265) */
  annexB: Buffer;
  /** Detected from the NALs — NOT from the BcMedia header, which lies (see below) */
  videoType: BcMediaVideoType | null;
  /** `null` only when no audio packet arrived at all */
  audio: RecordingAudioTrack | null;
  stats: {
    bytesIn: number;
    bytesOut: number;
    packets: number;
    videoPackets: number;
    audioPackets: number;
    audioBytes: number;
    keyframes: number;
    /** The DELIVERED frame rate — what `ffmpeg -r` must be given */
    fps: number | null;
    durationSeconds: number | null;
    /** The info header's nominal rate, which is NOT the delivered one */
    infoFps: number | null;
    fpsSource: "timestamps" | "infoFps" | "unknown";
  };
}>;
```

```typescript
interface RecordingAudioTrack {
  codec: "Aac" | "Adpcm";
  /** `adts` = self-delimiting AAC frames; `adpcm` = Reolink blocks; `unknown` = do not copy */
  format: "adts" | "adpcm" | "unknown";
  /** The frames concatenated, exactly as the camera sent them */
  data: Buffer;
  frames: number;
  bytes: number;
  /** `null` when the wire does not say — never a default */
  sampleRate: number | null;
  channels: number | null;
  durationSeconds: number | null;
}
```

### The audio was always there

The cmd 5 download has always carried the audio inside the same BcMedia
stream; until 0.7.10 this method registered no `onAudioFrame` and dropped it
on the floor, so a consumer that wanted sound had to go through
`getRecordingVideo` — which muxes with `frag_keyframe+empty_moov`, i.e. no
`moov` first and no known duration, costing exactly the seek and the duration
an MP4 is wanted for.

Measured 2026-09-20, read-only, one session per device:

| | E1 Outdoor PoE v3.1.0.5223, standalone | Home Hub v3.3.0.456, child ch 0 |
| --- | --- | --- |
| clip | 2 s | 43 s |
| listed `sizeL` | 2 208 022 | 11 922 199 |
| received | **1 967 336 B in 2 662 ms** | **11 680 272 B in 9 074 ms** |
| video | 51 AUs, **H.264**, 2 keyframes | 661 AUs, **H.265**, 23 keyframes |
| audio | **32 AAC frames, 16 608 B** | **688 AAC frames, 357 072 B** |
| info header fps | 25 | 30 |
| delivered fps (timestamps) | 24.704 → 25 | **15.019 → 15** |

A longer clip on the same standalone: 21 779 592 B in 6 799 ms, 676 AUs +
**426 AAC frames (221 094 B)**.

### The audio codec, per camera

Both devices, both topologies: **AAC-LC, 16 kHz, mono, one ADTS frame per
BcMedia packet, 519 bytes each** (`fff1 6040 40ff fc…`; the ADTS
`frame_length` field equals the packet length, so the concatenation in
`audio.data` is a complete elementary stream that ffmpeg can walk unaided).
No camera here produced ADPCM; if one does, `format` is `adpcm`, `sampleRate`
and `channels` are `null` (the wire does not say) and it must be transcoded,
not copied.

### Two things the wire gets wrong, and the library corrects

- **The BcMedia frame header lies about the codec on a Home Hub child**: every
  I/P packet declares `H264` while the payload is H.265. `videoType` comes
  from `detectVideoCodecFromNal`, not from that header.
- **`InfoV1`/`InfoV2` `fps` is the file's nominal rate, not the delivered
  one**: the hub child declared 30 and delivered 15.019. Mux at the declared
  rate and the video comes out half as long as its own audio. Use
  `stats.fps`; `stats.fpsSource` tells you whether it was measured
  (`timestamps`) or fallen back to (`infoFps`).

### Muxing it: how to keep faststart, duration and Range

Two inputs, one `ffmpeg`, stream copy on both tracks:

```typescript
const { annexB, videoType, audio, stats } = await api.downloadRecordingDemuxed({
  channel: 0,
  fileName: clip.fileName,
});

await writeFile(videoPath, annexB); // .h264 or .hevc
if (audio?.format === "adts") await writeFile(audioPath, audio.data); // .aac

const args = [
  "-r", String(stats.fps ?? 15),
  "-f", videoType === "H265" ? "hevc" : "h264", "-i", videoPath,
  ...(audio?.format === "adts" ? ["-f", "aac", "-i", audioPath] : []),
  "-c:v", "copy",
  ...(audio?.format === "adts" ? ["-c:a", "copy", "-bsf:a", "aac_adtstoasc"] : []),
  "-movflags", "+faststart",
  "-f", "mp4", outPath,
];
```

Verified end-to-end on both devices: `moov` lands before `mdat`, the format
duration is real, and the two tracks agree — 27.263 561 s of video against
27.264 000 s of audio on a 27 s standalone clip (0.4 ms over 27 s), 44.010 920
against 44.032 000 on the 43 s hub clip (21 ms over 44 s).

---

## getRecordingVideo

`downloadRecording` + demux + **an ffmpeg mux the library runs itself**,
returning a ready MP4 with video and audio.

```typescript
const { mp4, stats } = await api.getRecordingVideo(params: DownloadRecordingParams & {
  /** Path to the ffmpeg binary (default: "ffmpeg" from PATH) */
  ffmpegPath?: string;
});
```

### Returns

```typescript
Promise<{
  mp4: Buffer;
  stats: {
    bytesIn: number;
    videoBytesOut: number;
    audioBytesOut: number;
    videoPackets: number;
    audioPackets: number;
    keyframes: number;
    fps: number;
    durationSeconds: number;
    videoCodec: "H264" | "H265";
    audioCodec: "Aac" | "Adpcm" | null;
    hasAudio: boolean;
  };
}>;
```

> **It muxes `frag_keyframe+empty_moov+default_base_moof`** — a fragmented MP4
> with no `moov` first and no declared duration. That is fine for feeding a
> player a stream, and wrong for a file a consumer will seek or serve over
> Range. For that, use `downloadRecordingDemuxed` and run your own mux with
> `-movflags +faststart` (recipe above).

---

## getRecordingThumbnail

Gets a thumbnail image from a recording.

```typescript
const thumbnail = await api.getRecordingThumbnail(params: {
  fileName: string;
  channel?: number;
  offsetMs?: number;
});
```

### Parameters

| Parameter         | Type     | Required | Default | Description             |
| ----------------- | -------- | -------- | ------- | ----------------------- |
| `params.fileName` | `string` | ✅       | -       | Recording filename      |
| `params.channel`  | `number` | ❌       | `0`     | Channel number          |
| `params.offsetMs` | `number` | ❌       | `0`     | Offset from start in ms |

### Returns

`Promise<Buffer>` - JPEG image data

---

## getVideoclipThumbnail

Fetches an I-frame from a recording via CoverPreview (cmd 298). Addressed by **time**, never by file name: pass the clip's full `startTime`/`endTime`. Requests are serialised per host (the camera rejects concurrent CoverPreviews with 400) and queued up to 50.

```typescript
const snap = await api.getVideoclipThumbnail(params: {
  channel?: number;
  /** Clip start */
  time: Date;
  /** Clip end. A window not after `time` is widened to 10 s (the camera answers 400 to end == start). */
  endTime?: Date;
  snapType?: "main" | "sub"; // default "sub"
  /** Required for an NVR/Hub child when the cmd 145 push has not arrived */
  uid?: string;
  isNvr?: boolean;
  timeZone?: string;
  timeoutMs?: number;
});
```

### Returns

`Promise<VideoclipThumbnailResult>` — `{ frame: Buffer /* raw H.264/H.265 I-frame */, encoding, frameLength, streamInfo: { width?, height?, frameRate? }, frameTime? }`. Decode with ffmpeg or use the JPEG wrappers below.

---

## getVideoclipThumbnailJpeg

`getVideoclipThumbnail` followed by an ffmpeg decode to JPEG (`ffmpeg` on `PATH`, or `ffmpegPath`).

```typescript
const jpeg = await api.getVideoclipThumbnailJpeg(params: {
  channel?: number;
  time: Date;
  endTime?: Date;
  snapType?: "main" | "sub";
  uid?: string;
  isNvr?: boolean;
  timeZone?: string;
  timeoutMs?: number;
  ffmpegPath?: string;
});
```

`getVideoclipThumbnailJpegRaw(params)` takes the same parameters plus `jpegQuality` and returns `{ jpeg, snapshot }`.

### Returns

`Promise<Buffer>` - JPEG image data

### Example

```typescript
import { writeFileSync } from "node:fs";

const recordings = await api.getVideoclips({
  channel: 1,
  uid: childUid,
  start,
  end,
});
for (const rec of recordings.slice(0, 5)) {
  const jpeg = await api.getVideoclipThumbnailJpeg({
    channel: 1,
    uid: childUid,
    isNvr: true,
    time: rec.startTime!,
    endTime: rec.endTime,
  });
  writeFileSync(`thumb_${rec.name}.jpg`, jpeg);
}
```

---

## snapshotFromRecording

Extracts a snapshot frame from a recording.

```typescript
const snapshot = await api.snapshotFromRecording(params: {
  fileName: string;
  channel?: number;
  offsetMs?: number;
  format?: "jpeg" | "png";
});
```

### Parameters

| Parameter         | Type     | Required | Default  | Description        |
| ----------------- | -------- | -------- | -------- | ------------------ |
| `params.fileName` | `string` | ✅       | -        | Recording filename |
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
  fileName: string;
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
  fileName: string;
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
  fileName: string;
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
  fileName: "Rec_20240115_100000_main.mp4",
});

await pipeline(mp4Stream, createWriteStream("output.mp4"));
console.log("Download complete");
```

---

## getRecordingPlaybackUrls

Gets playback URLs for a recording.

```typescript
const urls = await api.getRecordingPlaybackUrls(params: {
  fileName: string;
  channel?: number;
});
```

### Returns

```typescript
Promise<{ rtmpVodUrl: string }>;
```

Note: the URL carries the credentials in its query string, and `ensureEnabled` (default `true`) **switches the camera's RTMP port on** before answering — a write hidden in a getter. Pass `ensureEnabled: false` when you only want the string.

```typescript

```

---

## getVodRtmpUrl

Gets the RTMP URL for Video-on-Demand playback.

```typescript
const rtmpUrl = await api.getVodRtmpUrl(params: {
  fileName: string;
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
  fileName: string;
  channel?: number;
});
```

---

## getDayRecords

The recording calendar (cmd 142 `<DayRecords>`): which days of one calendar month have footage on one channel. Captured from the official app on a standalone E1 Outdoor PoE (v3.1.0.5223) and on a Reolink Home Hub (v3.3.0.456, child channel 0); verified live on hub channels 0, 1 and 3.

```typescript
const cal = await api.getDayRecords(params: {
  year: number;      // Gregorian
  month: number;     // 1-12; the window is the whole calendar month on the camera's clock
  channel?: number;  // default 0
  uid?: string;      // resolved like getVideoclips when omitted (cmd 114 standalone / cmd 145 push on a Hub)
  timeoutMs?: number;
});
// → { index: 0, channelId: 0, days: [{ day: 2, type: "normal" }, { day: 3, type: "normal" }, …] }
```

- A day with no footage is absent; an empty month is `days: []`.
- `type` is an open vocabulary (`normal` is the only value observed).
- On a Hub the **UID selects the camera** and `channelId` is echoed back; a request naming channel 1 with channel 0's UID answers channel 0's days. On a standalone camera the UID is ignored.
- No time zone is involved: a calendar month is a calendar month on the camera's own clock.
- Before 0.7.8 this method sent no body and always answered `responseCode 400`.

### getDayRecordsForChannels

Several channels of a Hub in ONE request (verified live with three).

```typescript
const byChannel = await api.getDayRecordsForChannels({
  year: 2026,
  month: 9,
  entries: [
    { channel: 0, uid: childUid0 },
    { channel: 1, uid: childUid1 },
    { channel: 3, uid: childUid3 },
  ],
});
byChannel.get(3)?.days; // → [{ day: 1, type: "normal" }, …]
```

Builders and parser are exported for tests and tooling: `buildDayRecordsXml`, `parseDayRecordsXml`, `daysInMonth`.

---

## searchAlarmVideos

The alarm **windows** inside one camera's recordings for one camera-local day
(cmd 272 open → 273 pages → 274 close, `<findAlarmVideo>`). **This is not a
second `getVideoclips`.** `getVideoclips` answers with FILES; this answers
with the event windows INSIDE those files — several rows can name the same
file, each with its own class and its own start/end.

```typescript
const windows = await api.searchAlarmVideos(params: {
  channel?: number;            // default 0
  uid?: string;                // resolved like getVideoclips when omitted
  start: Date;                 // camera wall clock
  end: Date;                   // clamped to 23:59:59.999 of start's local day
  streamType?: number;         // 0 = main (default, what the app sends), 1 = sub
  logicChnBitmap?: number;     // default 255
  notSearchVideo?: number;     // default 0
  alarmType?: string;          // CSV; default DEFAULT_ALARM_VIDEO_SEARCH_ALARM_TYPES (17)
  eventAlarmTypes?: readonly string[]; // default the app's 19 items
  timeZone?: string;           // defaults to recordingsTimeZone
  maxPages?: number;           // default 200
  timeoutMs?: number;
});
// → [{ fileName, alarmType, alarmTypes, encrypted, fileId?, startTime, endTime,
//      uid?, logicChn?, hasRecFile?, deleted? }, …]
```

Measured live 2026-09-20 on a standalone E1 Outdoor PoE (v3.1.0.5223),
19 September:

- **1 271 windows over 539 files, 1 to 13 per file**, and every one of the
  1 271 contained in its own file's window (none outside).
- The union of a file's `alarmType`s equalled the file's `recordType` on
  **501 of the 539** files.
- `fileName` is exactly a `getVideoclips` `name` (`01` + `YYYYMMDD` +
  `HHMMSS`), so **the two surfaces join on it**.
- **`streamType` selects the file set** and it is NUMERIC here, unlike
  `getVideoclips`'s `subStream` / `mainStream` string: `0` returned all 539
  main-stream names, `1` all 539 sub-stream ones. The official app sends `0`.
- **One camera-local day, enforced by the firmware.** An 18→19 September
  window answered 462 windows all dated 18 September, on the standalone and
  on a hub child alike. `end` is therefore clamped to the end of `start`'s
  local day (and the clamp is trace-logged) rather than letting the device
  drop the rest silently. A wider range is the caller's loop, one call a day.
- `alarmType` is an **open vocabulary** — parsed as the string the camera
  wrote (`md`, `people`, `dog_cat`, `other` seen), never enumerated.
- Unlike cmd 14/15/16, this family DOES carry
  `<Extension><channelId>N</channelId></Extension>`. The frame header stays
  at the session default; `channel` is never handed to `sendXml`.
- `fileId` was empty on every row observed, captured and live.
- The 273 get and the 274 close send the same body byte for byte.

On a Home Hub each row additionally carries `uid`, `logicChn`, `hasRecFile`
and `deleted`.

Builders and parsers are exported: `buildFindAlarmVideoExtensionXml`,
`buildFindAlarmVideoOpenXml`, `buildFindAlarmVideoPageXml`,
`parseFindAlarmVideoHandle`, `parseAlarmVideoPageXml`,
`searchAlarmVideosViaFindAlarmVideo`,
`DEFAULT_ALARM_VIDEO_SEARCH_ALARM_TYPES`,
`DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES`.

---

## searchEventLog

The Home Hub's **cross-channel event list** (cmd 516 open → 517 pages → 518
close, `<findEventLog>`) — one search across every child, each row carrying
its event class, and NOT bounded to a single day. This is the catalog the
official app's Events tab is drawn from, and the fastest way to ask a hub
"what happened".

**Hub only.** A standalone camera answers the open with an EMPTY BODY (17 ms,
measured), and this method throws naming that rather than returning an empty
list.

```typescript
const events = await api.searchEventLog(params: {
  devices?: ReadonlyArray<{ uid: string; logicChnBitmap?: number }>;
                              // default: every child the cmd 145 push knows
  start: Date;                // the EARLIER instant
  end: Date;                  // the LATER instant
  alarmType?: string;         // CSV; default DEFAULT_EVENT_LOG_SEARCH_ALARM_TYPES (6)
  eventAlarmTypes?: readonly string[]; // default the app's 6 items
  maxEventCount?: number;     // rows per page; default what the open grants (60)
  logTypeBits?: number;       // default 1
  notSearchVideo?: number;    // default 1
  onlySearchCluster?: number; // default 0
  desc?: number;              // default 0 — NOT the sort order
  chnbits?: number;           // default 0 — measured inert
  timeZone?: string;          // defaults to recordingsTimeZone
  maxPages?: number;          // default 100
  timeoutMs?: number;
});
// → [{ uid, logicChn, hasRecFile, encrypted, deleted, alarmType, alarmTypes,
//      startTime, endTime }, …]  newest first
```

Measured live 2026-09-20 on a Home Hub v3.3.0.456 with three children:

- **59 events over three children and three days in 2 372 ms**; 1 886 events
  over 20 days in 11 908 ms. Every row carries its class; the equivalent
  per-channel `getVideoclips` pass carries none.
- **The window is written BACKWARDS on the wire** (`startTime` = the later
  instant). That is not a style choice: the same window written forwards
  answered **zero rows** in 191 ms. `desc` stayed `0` throughout, so `desc`
  is not what orders the rows.
- **`<devices>` is what selects the channels, not `chnbits`.** `chnbits: 3`
  answered exactly what `chnbits: 0` did (59 events, same rows), while
  cutting `devices` to ONE child turned those 59 into 10, all from that
  child. What a non-zero `chnbits` is for remains **unknown**; it is exposed
  and defaulted to 0, never derived from `devices`.
- **`hasRecFile` is often false** — 515 of those 1 886 events had no
  recording file. An event is not a promise of a clip; a consumer that wants
  the file joins on `searchAlarmVideos` / `getVideoclips` by channel and
  window.
- **Paging** uses the handle the OPEN returned (the reply to a get carries a
  different one — `1` for a request sent with `0` — recorded on the page and
  never used). Rows repeat rarely across page boundaries (5 of 1 886) and the
  cross-child merge is not perfectly monotonic at a boundary, so the result
  is deduped on `(uid, logicChn, startTime, alarmType)` with the device's own
  order preserved.
- `alarmType` is an **open vocabulary** (`md`, `people`, `dog_cat` seen).
- No Extension on any of the three commands.

Builders and parsers are exported: `buildFindEventLogOpenXml`,
`buildFindEventLogGetXml`, `buildFindEventLogCloseXml`,
`parseFindEventLogOpenXml`, `parseEventLogPageXml`,
`searchEventLogViaFindEventLog`, `DEFAULT_EVENT_LOG_SEARCH_ALARM_TYPES`,
`DEFAULT_EVENT_LOG_SEARCH_EVENT_ALARM_TYPES`,
`DEFAULT_EVENT_LOG_MAX_EVENT_COUNT`. The low-level builder takes the raw wire
`startTime` / `endTime`, so an experiment with a forward window is still
expressible.

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

## Replay is a SESSION, and what the Reolink app really does (capture, 2026-09-22)

Captured off the app against a standalone (`Cameretta Daniel`, 158 s, 5 937
cmd-5 frames). Four questions were asked of it; the answers change what a
consumer can build.

**1. There is no in-session seek, and no time-addressed replay.** Eight replay
requests in the whole session, each naming a full FILE path in `<Id>`, always
`mainStream`. The `01YYYYMMDDHHMMSS` shape appears **only** in the 591 *stop*
payloads, as the name of the session being closed — never as a replay target.

**2. The single timeline is built by the APP.** It maps a timeline position to
the file that contains that instant and opens a replay on it. Moving far
backwards or forwards is simply a replay on a different file:

```
1  speed=1   RecM03_…_051358_051559   (121 s)
2  speed=1   RecM03_…_045646_045711   ← backwards = another file
3  speed=1   RecM03_…_052404_052604   ← forwards  = another file
4  speed=1   RecM03_…_061242_061442
5  speed=8   RecM03_…_061242_061442   ← SAME file, reopened at speed 8
```

It reads as continuous because the files are **120–300 s**: choosing the right
file *is* the seek, with an error the eye does not catch. **The camera's own
files are the index** — a consumer that wants a scrubbable timeline does not
need to build one.

**3. `playSpeed` is real and we never used it.** Row 5 is the same file
reopened at **8**. Both builders here hardcode `<playSpeed>1</playSpeed>`.
Fast scrub in the app is this, not I-frame replay.

**4. `bIframeReplay` / `iIframeReplay` were never sent.** Zero occurrences.
The library exposes them (`iframeReplay`) and the app does not use them; they
remain untested against a real firmware.

### What this forbids

Seeking *inside* one recording is not something the camera offers. A consumer
that wants it must keep the bytes it has already received — the protocol will
not replay from an offset. Forward-only playback plus `playSpeed` is what the
wire actually supports.
