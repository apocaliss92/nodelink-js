# Istruzioni per Cursor (IDE) — `baichuan-protocol`

Questa guida serve a far lavorare Cursor in modo consistente su questo repository (libreria TypeScript/Node per Reolink Baichuan/BCUDP + CGI + RTSP proxy).

## Setup rapido

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Struttura del progetto (dove intervenire)

- **Baichuan (TCP/BCUDP)**: `src/client/BaichuanClient.ts`
- **Framing Baichuan (20/24 byte)**: `src/protocol/framing.ts`
- **Crypto Baichuan (BCEncrypt/AES)**: `src/protocol/crypto.ts`
- **BCUDP (UDP affidabile con ACK/resend)**: `src/bcudp/*`
- **API CGI (HTTP)**:
  - client token/refresh: `src/reolink/http/ReolinkHttpClient.ts`
  - API CGI: `src/reolink/cgi/ReolinkCgiApi.ts`
- **API Baichuan**: `src/reolink/baichuan/ReolinkBaichuanApi.ts`
- **API Ibrida (Baichuan→fallback CGI)**: `src/reolink/hybrid/ReolinkHybridApi.ts`
- **API NVR**:
  - CGI: `src/reolink/nvr/ReolinkNvrCgiApi.ts`
  - Baichuan: `src/reolink/nvr/ReolinkNvrBaichuanApi.ts`
  - Hybrid: `src/reolink/nvr/ReolinkNvrHybridApi.ts`
- **RTSP URL builder**: `src/rtsp/urls.ts`
- **RTSP proxy server (HTTP MPEG-TS via ffmpeg)**: `src/rtsp/server.ts`

### Nota su `_refs/`
La cartella `_refs/` contiene repository clonati di riferimento (neolink/reolink_aio) ed è **ignorata** da git. Non va usata come “codice prodotto”.

## Comandi di qualità (da far eseguire a Cursor prima di chiudere una modifica)

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Testing di integrazione con una camera locale (opt-in)

I test di integrazione sono in `test/integration/reolink.local.test.ts` e sono **skippati** se mancano le env.

### Variabili d’ambiente

Obbligatorie:
- `REOLINK_HOST`
- `REOLINK_USER`
- `REOLINK_PASS`

Opzionali:
- `REOLINK_CGI_PORT` (es. `80` o `443`)
- `REOLINK_CGI_HTTPS=1` (abilita HTTPS per CGI)
- `REOLINK_BC_TRANSPORT=tcp|udp|auto`
- `REOLINK_UID` (necessario se usi BCUDP `mode: "uid"`)
- `REOLINK_ALLOW_REBOOT=1` (abilita il reboot durante l’integrazione)

Esempio:

```bash
export REOLINK_HOST=192.168.1.50
export REOLINK_USER=admin
export REOLINK_PASS='password'
export REOLINK_BC_TRANSPORT=auto
export REOLINK_UID='XXXXXXXXXXXX'
npm test
```

## Debugging / logging consigliato

- **BaichuanClient**: usa `debug: true` nelle options e ascolta l’evento `debug`.
- **BCUDP**: `BcUdpStream` emette `error` (e può essere esteso per log più verbosi).
- **CGI**: gli errori includono status/response text; in caso di firmware “strani” controlla la risposta raw.

## Linee guida per Cursor (prompt operativo)

Copia/incolla questo testo come “Project instructions” in Cursor se vuoi:

> Stai lavorando su una libreria TypeScript/Node per Reolink.
> - Mantieni API separate per protocollo: Baichuan/BCUDP e CGI.
> - L’API ibrida deve provare Baichuan e fare fallback a CGI per ogni operazione.
> - Non introdurre breaking changes inutili: aggiungi metodi/option compatibili.
> - Non toccare `_refs/` (solo consultazione).
> - Dopo modifiche: esegui `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
> - I test di integrazione devono essere opt-in via env e non devono fallire in CI se env non sono presenti.

## Roadmap tecnica suggerita (per espansioni future)

- Espandere `ReolinkBaichuanApi` con i `cmd_id` mancanti (snapshot binario, stream start/stop, PTZ completo, floodlight, PIR, battery, ecc.)
- Espandere `ReolinkCgiApi` con wrapper fortemente tipizzati per i comandi più usati (Get/Set per rete, encoding, OSD, AI, motion, ecc.)
- NVR: aggiungere helper “bulk” per stream/encoding su tutte le camere collegate
- RTSP: aggiungere un proxy HLS opzionale e un healthcheck per ffmpeg

