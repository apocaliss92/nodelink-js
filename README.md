# Baichuan (Reolink) Protocol — TypeScript Library

Questa repository contiene una libreria **TypeScript/Node.js** per parlare il protocollo proprietario Reolink **Baichuan** (tipicamente su TCP porta `9000`) per:

- login/negoziazione cifratura (BCEncrypt / AES / FullAES)
- invio comandi XML e parsing del framing
- base per stream (video/audio) e push events

Implementazione derivata da:
- `neolink` (Rust): `crates/core/src/bc/*` + `crates/core/src/bc_protocol/*`
- `reolink_aio` (Python): `reolink_aio/baichuan/*`

## Installazione

```bash
npm install
```

## Build / Test

```bash
npm run build
npm test
```

## Esempio (login + comando XML)

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

## Camere a batteria (UDP / BCUDP)

Molti modelli a batteria usano **BCUDP** (UDP con ACK/resend/heartbeat) invece del TCP.
Puoi usare `transport: "udp"` e fornire `udp` in modalità `uid` (discovery locale):

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

## API “stile reolink_aio” (HTTP CGI + Baichuan)

Per coprire l’ampio set di funzionalità di `reolink_aio` (network settings, stream, reboot, info, NVR/canali, …) è disponibile `ReolinkApi`:

```ts
import { ReolinkApi } from "baichuan-protocol";

const api = new ReolinkApi({
  http: { host: "192.168.1.50", username: "admin", password: "••••••••", useHttps: false },
  baichuan: { host: "192.168.1.50", username: "admin", password: "••••••••", transport: "tcp" },
});

await api.login();
const devInfo = await api.getDevInfo();
const channels = await api.listChannels(); // NVR
await api.reboot(); // host reboot (o fallback Baichuan)
await api.logout();
```

### Comandi arbitrari (copre “tutto” reolink_aio lato HTTP)

```ts
await api.call("GetNetPort", {});
await api.call("SetNetPort", { NetPort: {/* ... */} });
```

## RTSP + server Node.js (proxy HTTP MPEG-TS)

La libreria include un helper per esporre RTSP via HTTP usando `ffmpeg`:

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
// poi: GET http://localhost:8080/stream?channel=0&profile=sub
```

## Note sul protocollo (in breve)

- **Header**: 20 o 24 byte (in base a `messageClass`), magic `f0debc0a`
- **Modern messages**: XML cifrato con **BCEncrypt (XOR)** o **AES-128-CFB** (IV fisso `0123456789abcdef`)
- **Login**: richiesta legacy → risposta con `<nonce>` + tipo cifratura → login moderno con hash MD5 (troncato)

