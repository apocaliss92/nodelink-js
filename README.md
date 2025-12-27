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

## Note sul protocollo (in breve)

- **Header**: 20 o 24 byte (in base a `messageClass`), magic `f0debc0a`
- **Modern messages**: XML cifrato con **BCEncrypt (XOR)** o **AES-128-CFB** (IV fisso `0123456789abcdef`)
- **Login**: richiesta legacy → risposta con `<nonce>` + tipo cifratura → login moderno con hash MD5 (troncato)

