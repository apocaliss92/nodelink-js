# Two-Way Audio (Intercom)

Methods for two-way audio communication with the camera.

## Table of Contents

- [getTalkAbility](#gettalkability)
- [getTwoWayAudioConfig](#gettwowayaudioconfig)
- [talkConfig](#talkconfig)
- [talkReset](#talkreset)
- [createTalkSession](#createtalksession)
- [createDedicatedTalkSession](#creatededicatedtalksession)

---

## getTalkAbility

Gets the two-way audio capabilities of the camera.

```typescript
const ability = await api.getTalkAbility(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<TalkAbility>`

```typescript
interface TalkAbility {
  /** Supported audio codecs for sending audio */
  sendCodecs: AudioCodec[];
  /** Supported audio codecs for receiving audio */
  receiveCodecs: AudioCodec[];
  /** Whether duplex (simultaneous send/receive) is supported */
  duplex: boolean;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of channels (1 = mono, 2 = stereo) */
  channels: number;
  /** Bits per sample */
  bitsPerSample: number;
}

type AudioCodec = "PCM" | "G711_ALAW" | "G711_ULAW" | "AAC" | "ADPCM";
```

### Example

```typescript
const ability = await api.getTalkAbility();
console.log("Supported send codecs:", ability.sendCodecs);
console.log("Duplex supported:", ability.duplex);
console.log("Sample rate:", ability.sampleRate);
```

---

## getTwoWayAudioConfig

Gets the current two-way audio configuration.

```typescript
const config = await api.getTwoWayAudioConfig(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<TwoWayAudioConfig>`

---

## talkConfig

Configures the talk session parameters.

```typescript
await api.talkConfig(config: TalkConfigParams);
```

### Parameters

| Parameter           | Type         | Required | Default | Description        |
| ------------------- | ------------ | -------- | ------- | ------------------ |
| `config.channel`    | `number`     | ❌       | `0`     | Channel number     |
| `config.codec`      | `AudioCodec` | ❌       | Auto    | Audio codec to use |
| `config.sampleRate` | `number`     | ❌       | `8000`  | Sample rate in Hz  |
| `config.channels`   | `number`     | ❌       | `1`     | Audio channels     |

### Returns

`Promise<void>`

---

## talkReset

Resets the talk session.

```typescript
await api.talkReset(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<void>`

---

## createTalkSession

Creates a two-way audio session for sending audio to the camera.

```typescript
const session = await api.createTalkSession(options?: TalkSessionOptions);
```

### Parameters

| Parameter            | Type         | Required | Default | Description                 |
| -------------------- | ------------ | -------- | ------- | --------------------------- |
| `options.channel`    | `number`     | ❌       | `0`     | Channel number              |
| `options.codec`      | `AudioCodec` | ❌       | Auto    | Audio codec                 |
| `options.sampleRate` | `number`     | ❌       | `8000`  | Sample rate in Hz           |
| `options.onAudio`    | `function`   | ❌       | -       | Callback for received audio |

### Returns

`Promise<TalkSession>`

```typescript
interface TalkSession {
  /** Send audio data to the camera */
  send(data: Buffer): Promise<void>;
  /** Stop the talk session */
  stop(): Promise<void>;
  /** Whether the session is active */
  active: boolean;
}
```

### Example

```typescript
// Create a talk session
const session = await api.createTalkSession({
  channel: 0,
  onAudio: (audio) => {
    // Handle audio received from camera
    console.log(`Received ${audio.length} bytes of audio`);
  },
});

// Send audio (raw PCM or encoded based on codec)
const audioData = Buffer.from(/* your audio data */);
await session.send(audioData);

// Stop when done
await session.stop();
```

### Full Duplex Example

```typescript
import { spawn } from "node:child_process";

// Create session with duplex audio
const session = await api.createTalkSession({
  channel: 0,
  onAudio: (audio) => {
    // Play received audio through speakers
    process.stdout.write(audio);
  },
});

// Capture microphone input and send
const mic = spawn("arecord", [
  "-f",
  "S16_LE",
  "-r",
  "8000",
  "-c",
  "1",
  "-t",
  "raw",
]);

mic.stdout.on("data", async (chunk) => {
  await session.send(chunk);
});

// Stop after 30 seconds
setTimeout(async () => {
  mic.kill();
  await session.stop();
}, 30000);
```

---

## createDedicatedTalkSession

Creates a talk session on a dedicated connection (recommended for concurrent operations).

```typescript
const session = await api.createDedicatedTalkSession(options?: TalkSessionOptions);
```

### Parameters

Same as `createTalkSession`.

### Returns

`Promise<TalkSession>` - Session on a dedicated API connection

### Example

```typescript
// Create dedicated session for intercom
// This won't interfere with other API operations
const session = await api.createDedicatedTalkSession({
  channel: 0,
});

// Use session...
await session.send(audioData);

// Stop closes the dedicated connection automatically
await session.stop();
```

---

## Audio Format Requirements

### PCM (Raw Audio)

| Parameter   | Value         |
| ----------- | ------------- |
| Sample Rate | 8000 Hz       |
| Channels    | 1 (Mono)      |
| Bit Depth   | 16-bit        |
| Byte Order  | Little Endian |
| Format      | Signed        |

### G.711 A-Law / U-Law

| Parameter   | Value    |
| ----------- | -------- |
| Sample Rate | 8000 Hz  |
| Channels    | 1 (Mono) |
| Bit Depth   | 8-bit    |

### Converting Audio with FFmpeg

```bash
# Convert WAV to raw PCM
ffmpeg -i input.wav -f s16le -ar 8000 -ac 1 output.pcm

# Convert to G.711 A-Law
ffmpeg -i input.wav -f alaw -ar 8000 -ac 1 output.alaw
```

### Code Example: Convert and Send

```typescript
import { spawn } from "node:child_process";

const session = await api.createTalkSession();

// Convert MP3 to PCM and send
const ffmpeg = spawn("ffmpeg", [
  "-i",
  "message.mp3",
  "-f",
  "s16le",
  "-ar",
  "8000",
  "-ac",
  "1",
  "-",
]);

ffmpeg.stdout.on("data", async (chunk) => {
  await session.send(chunk);
});

ffmpeg.on("close", async () => {
  await session.stop();
});
```

---

## Doorbell Intercom Example

```typescript
// When doorbell is pressed
api.on("visitor", async (event) => {
  console.log("Doorbell pressed!");

  // Get snapshot
  const snapshot = await api.getSnapshot();

  // Play welcome message
  const session = await api.createTalkSession();

  const ffmpeg = spawn("ffmpeg", [
    "-i",
    "welcome.mp3",
    "-f",
    "s16le",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-",
  ]);

  ffmpeg.stdout.on("data", (chunk) => session.send(chunk));
  ffmpeg.on("close", () => session.stop());
});
```

---

[← Back to Baichuan API](./README.md)
