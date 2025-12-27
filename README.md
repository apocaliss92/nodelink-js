# Baichuan (Reolink) Protocol — TypeScript Library

This repository contains a **TypeScript/Node.js** library that implements the proprietary Reolink **Baichuan** protocol (typically TCP port `9000`) for:

- login / encryption negotiation (BCEncrypt / AES / FullAES)
- sending XML commands and parsing the framing
- foundations for streaming (video/audio) and push events

Implementation based on:
- `neolink` (Rust): `crates/core/src/bc/*` + `crates/core/src/bc_protocol/*`
- `reolink_aio` (Python): `reolink_aio/baichuan/*`

## Installation

```bash
npm install
```

## Build / Test

```bash
npm run build
npm test
```

## Example (login + XML command)

```ts
import { BaichuanClient } from "baichuan-protocol";

const client = new BaichuanClient({
  host: "192.168.1.50",
  username: "admin",
  password: "••••••••",
  debug: true,
  transport: "tcp",
});

await client.login("full_aes");

const xml = await client.sendXml({
  cmdId: 93, // ping
});

console.log(xml);
await client.close();
```

## Battery cameras (UDP / BCUDP)

Many battery models use **BCUDP** (UDP with ACK/resend/heartbeat) instead of TCP.
You can use `transport: "udp"` and provide `udp` in `uid` mode (local discovery):

```ts
import { BaichuanClient } from "baichuan-protocol";

const client = new BaichuanClient({
  host: "255.255.255.255",
  username: "admin",
  password: "••••••••",
  transport: "udp",
  udp: {
    mode: "uid",
    uid: "YOUR_CAMERA_UID",
    broadcast: true,
  },
});
await client.login();
```

## Separate APIs: Baichuan and CGI

- `ReolinkBaichuanApi`: operations via Baichuan/BCUDP
- `ReolinkCgiApi`: operations via HTTP CGI (reolink_aio-style)

## Hybrid API (Baichuan -> CGI fallback)

For each operation, it tries Baichuan first and falls back to CGI: `ReolinkHybridApi`.

```ts
import { ReolinkHybridApi } from "baichuan-protocol";

const api = new ReolinkHybridApi({
  cgi: { host: "192.168.1.50", username: "admin", password: "••••••••", useHttps: false },
  baichuan: { host: "192.168.1.50", username: "admin", password: "••••••••", transport: "tcp" },
});

await api.login();
const devInfo = await api.GetDevInfo();
await api.Reboot();
await api.close();
```

### Arbitrary commands (covers “everything” supported by reolink_aio over HTTP)

Note: for arbitrary commands use `ReolinkCgiApi.call(...)` (covers everything reolink_aio supports over HTTP).

## RTSP + server Node.js (proxy HTTP MPEG-TS)

The library includes a helper to expose RTSP over HTTP using `ffmpeg`:

```ts
import { createRtspProxyServer } from "baichuan-protocol";

const server = createRtspProxyServer({
  listenPort: 8080,
  host: "192.168.1.50",
  username: "admin",
  password: "••••••••",
  rtspTransport: "tcp",
});

server.listen(8080);
// then: GET http://localhost:8080/stream?channel=0&profile=sub
```

## Cursor (IDE) — instructions

See `CURSOR.md`.

## Protocol notes (short)

- **Header**: 20 or 24 bytes (depending on `messageClass`), magic `f0debc0a`
- **Modern messages**: XML encrypted with **BCEncrypt (XOR)** or **AES-128-CFB** (fixed IV `0123456789abcdef`)
- **Login**: legacy request → reply with `<nonce>` + encryption type → modern login with MD5 hashes (truncated)

