# Streaming Servers

This library provides several streaming server implementations for restreaming camera feeds.

## Table of Contents

- [RTSP Server](#rtsp-server)
- [RFC 4571 Server](#rfc-4571-server)
- [HTTP Stream Server](#http-stream-server)

---

## RTSP Server

The `BaichuanRtspServer` creates a local RTSP server that restreams camera feeds using FFmpeg.

### Basic Usage

```typescript
import {
  BaichuanRtspServer,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

const rtspServer = new BaichuanRtspServer({
  api,
  profile: "main",
  channel: 0,
  listenPort: 8554,
  logger: console,
});

await rtspServer.start();
console.log("RTSP URL:", rtspServer.url);
// rtsp://localhost:8554/stream
```

### Constructor Options

```typescript
interface BaichuanRtspServerOptions {
  /** Baichuan API instance */
  api: ReolinkBaichuanApi;
  /** Stream profile: "main", "sub", or "ext" */
  profile: StreamProfile;
  /** Channel number (default: 0) */
  channel?: number;
  /** Port to listen on (default: 8554) */
  listenPort?: number;
  /** Host to listen on (default: "127.0.0.1") */
  listenHost?: string;
  /** Logger instance */
  logger?: Console;
  /** For multifocal cameras (TrackMix, Duo) */
  variant?: NativeVideoStreamVariant;
}
```

### Methods

#### start()

Starts the RTSP server.

```typescript
await rtspServer.start();
```

#### stop()

Stops the RTSP server.

```typescript
await rtspServer.stop();
```

#### url

Gets the RTSP URL for clients to connect.

```typescript
const url = rtspServer.url;
// rtsp://localhost:8554/stream
```

### Events

```typescript
rtspServer.on("clientConnect", (client) => {
  console.log("Client connected:", client.id);
});

rtspServer.on("clientDisconnect", (client) => {
  console.log("Client disconnected:", client.id);
});

rtspServer.on("error", (error) => {
  console.error("Server error:", error);
});
```

### Multi-Channel Example

```typescript
const servers: BaichuanRtspServer[] = [];

// Create RTSP server for each channel
const channelCount = await api.getChannelCount();
for (let ch = 0; ch < channelCount; ch++) {
  const server = new BaichuanRtspServer({
    api,
    profile: "sub",
    channel: ch,
    listenPort: 8554 + ch,
    logger: console,
  });
  await server.start();
  servers.push(server);
  console.log(`Channel ${ch}: rtsp://localhost:${8554 + ch}/stream`);
}

// Cleanup
for (const server of servers) {
  await server.stop();
}
```

---

## RFC 4571 Server

The RFC 4571 server provides low-latency TCP streaming optimized for home automation integrations like Scrypted.

### Basic Usage

```typescript
import {
  createRfc4571TcpServer,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

const server = await createRfc4571TcpServer({
  api,
  profile: "main",
  channel: 0,
  host: "0.0.0.0",
  logger: console,
  username: "admin",
  password: "your-password",
});

console.log("Server listening on port:", server.port);
console.log("SDP:", server.sdp);
```

### Options

```typescript
interface Rfc4571TcpServerOptions {
  /** Baichuan API instance */
  api?: ReolinkBaichuanApi;
  /** API factory for lazy creation */
  getApi?: (ctx?: Rfc4571ApiFactoryContext) => Promise<ReolinkBaichuanApi>;
  /** Channel number (undefined = composite stream) */
  channel?: number;
  /** Stream profile */
  profile: StreamProfile;
  /** For TrackMix cameras */
  variant?: NativeVideoStreamVariant;
  /** Logger */
  logger: Console;
  /** Server bind host */
  host?: string;
  /** RTP video payload type (default: 96) */
  videoPayloadType?: number;
  /** RTP audio payload type (default: 97) */
  audioPayloadType?: number;
  /** Expected video codec for validation */
  expectedVideoType?: VideoType;
  /** Timeout for keyframe extraction */
  keyframeTimeoutMs?: number;
  /** Auto-restart on no packets */
  uptimeRestartMs?: number;
  /** Auto-close when idle */
  idleTeardownMs?: number;
  /** Close API on teardown */
  closeApiOnTeardown?: boolean;
  /** Auth username */
  username: string;
  /** Auth password */
  password: string;
  /** Require authentication */
  requireAuth?: boolean;
  /** Composite stream options */
  compositeOptions?: CompositeStreamPipOptions;
}
```

### Server Properties

```typescript
interface Rfc4571TcpServer {
  /** TCP server port */
  port: number;
  /** SDP for the stream */
  sdp: string;
  /** Video codec type */
  videoType: VideoType;
  /** Audio codec type */
  audioType?: string;
  /** Stop the server */
  stop(): Promise<void>;
  /** Current client count */
  clientCount: number;
}
```

### Replay Server

For playing back recordings:

```typescript
import { createRfc4571TcpServerForReplay } from "@apocaliss92/nodelink-js";

const replayServer = await createRfc4571TcpServerForReplay({
  api,
  channel: 0,
  filename: "Rec_20240115_100000_main.mp4",
  logger: console,
  username: "admin",
  password: "your-password",
});

console.log("Replay server on port:", replayServer.port);
```

---

## HTTP Stream Server

The `BaichuanHttpStreamServer` provides HTTP-based streaming.

### Basic Usage

```typescript
import {
  BaichuanHttpStreamServer,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();

const httpServer = new BaichuanHttpStreamServer({
  api,
  profile: "main",
  channel: 0,
  port: 8080,
});

await httpServer.start();
// Access at http://localhost:8080/stream
```

---

## Composite Streams (Multifocal Cameras)

For dual-lens cameras like TrackMix and Duo:

```typescript
import { createRfc4571TcpServer } from "@apocaliss92/nodelink-js";

// Create composite stream (combines both lenses)
const server = await createRfc4571TcpServer({
  api,
  profile: "main",
  channel: undefined, // undefined = composite mode
  logger: console,
  username: "admin",
  password: "your-password",
  compositeOptions: {
    widerProfile: "sub",
    teleProfile: "main",
  },
});
```

---

## Stream Profiles

| Profile | Description             | Typical Use                |
| ------- | ----------------------- | -------------------------- |
| `main`  | High quality            | Recording, primary viewing |
| `sub`   | Low quality             | Thumbnails, multi-view     |
| `ext`   | Extended (if available) | Additional stream          |

---

## Best Practices

### Resource Management

```typescript
// Always clean up servers
try {
  const server = new BaichuanRtspServer({ ... });
  await server.start();
  // Use server...
} finally {
  await server.stop();
}
```

### Multiple Concurrent Streams

```typescript
// Use dedicated API sessions for each stream
const mainApi = await api.createDedicatedSession();
const subApi = await api.createDedicatedSession();

const mainServer = new BaichuanRtspServer({
  api: mainApi,
  profile: "main",
  listenPort: 8554,
});

const subServer = new BaichuanRtspServer({
  api: subApi,
  profile: "sub",
  listenPort: 8555,
});
```

### Error Recovery

```typescript
const rtspServer = new BaichuanRtspServer({ ... });

rtspServer.on("error", async (error) => {
  console.error("Server error:", error);
  // Attempt restart
  await rtspServer.stop();
  await new Promise(r => setTimeout(r, 5000));
  await rtspServer.start();
});
```

---

[← Back to Main Documentation](./README.md)
