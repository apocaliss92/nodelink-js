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
});

await client.login("full_aes");

const xml = await client.sendXml({
  cmdId: 93, // ping
});

console.log(xml);
await client.close();
```

## Note sul protocollo (in breve)

- **Header**: 20 o 24 byte (in base a `messageClass`), magic `f0debc0a`
- **Modern messages**: XML cifrato con **BCEncrypt (XOR)** o **AES-128-CFB** (IV fisso `0123456789abcdef`)
- **Login**: richiesta legacy → risposta con `<nonce>` + tipo cifratura → login moderno con hash MD5 (troncato)

