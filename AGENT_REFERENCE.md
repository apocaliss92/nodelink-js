# Agent Reference - Reolink Baichuan JS

Questo file contiene le nozioni di base e gli errori frequenti da evitare quando si lavora su questo progetto.

## Configurazione Ambiente

### File .env

- Il file di configurazione è `.env` (NON `env`)
- Path corretto: `require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })`
- Variabili principali:
  - `TCP_HOST`, `TCP_USERNAME`, `TCP_PASSWORD` - Camera TCP standalone
  - `TCP265_HOST`, `TCP265_USERNAME`, `TCP265_PASSWORD` - Camera H.265
  - `NVR_HOST`, `NVR_USERNAME`, `NVR_PASSWORD`, `NVR_UID` - Home Hub/NVR
  - `UDP_HOST`, `UDP_USERNAME`, `UDP_PASSWORD`, `UDP_UID` - Camera batteria

## API Recordings

### getVideoclips - Ricerca Registrazioni

**IMPORTANTE: La ricerca deve essere ristretta ad UN SOLO GIORNO**

Le registrazioni Reolink sono organizzate per giorno. La ricerca cross-day non funziona correttamente.

```javascript
// ❌ SBAGLIATO - Cross-day
const files = await api.getVideoclips({
  channel: 0,
  start: new Date(Date.now() - 24 * 60 * 60 * 1000), // Ieri
  end: new Date(), // Oggi
});

// ✅ CORRETTO - Solo oggi
const now = new Date();
const startOfDay = new Date(
  now.getFullYear(),
  now.getMonth(),
  now.getDate(),
  0,
  0,
  0,
);
const files = await api.getVideoclips({
  channel: 0,
  start: startOfDay,
  end: now,
});
```

### downloadRecording - Download Registrazione

```javascript
const data = await api.downloadRecording({
  channel: 0,
  fileName: "RecS03_20260125_000128_000151.mp4",
  streamType: "subStream",
  timeoutMs: 120000,
});
// Restituisce Buffer con dati H.264 raw
```

### startRecordingReplayStream - Streaming Registrazione

```javascript
const stream = await api.startRecordingReplayStream({
  channel: 0,
  fileName: "RecS03_20260125_000128_000151.mp4",
  streamType: "subStream",
});

// IMPORTANTE: L'evento è 'videoAccessUnit', NON 'media'
stream.on("videoAccessUnit", (au) => {
  console.log("Frame:", au.frameType, au.data.length, "bytes");
});

stream.on("end", () => {
  console.log("Stream ended");
});
```

## NVR vs Standalone

### Determinazione Tipo Device

**NON usare il formato del path per determinare se è NVR o standalone.**

```javascript
// ❌ SBAGLIATO - Basato su path
const isNvr = fileName.includes("/");

// ✅ CORRETTO - Basato su channelCount
const channelCount = await api.getChannelCount();
const isNvr = await api.isNvrDevice(); // channelCount > 1
```

### Channel Count

- Standalone camera: `channelCount = 1`
- NVR/Home Hub: `channelCount > 1` (es. 8, 16)

## Eventi e Stream

### Nomi Eventi Corretti

- Video frames: `videoAccessUnit` (NON `media`)
- Audio frames: `audioAccessUnit`
- End of stream: `end`
- Errors: `error`

## Errori Comuni da Evitare

1. **Date cross-day in getVideoclips** - Sempre restringere a un solo giorno
2. **Evento 'media' invece di 'videoAccessUnit'** - Usare `videoAccessUnit`
3. **Path 'env' invece di '.env'** - Il file è `.env`
4. **Variabili CAMERA*\* invece di TCP*\*** - Usare `TCP_HOST`, `TCP_USERNAME`, etc.
5. **NVR detection basata su path** - Usare `isNvrDevice()` basato su channelCount
6. **getRecordingFiles invece di getVideoclips** - Il metodo è `getVideoclips`

## Streaming vs Download - Encryption

### Download (cmdId=5 via sendBinary)

- I dati tornano in un buffer singolo
- Tutto viene decriptato insieme con fresh IV
- Funziona correttamente per tutti i frame

### Streaming (cmdId=5 via BaichuanVideoStream)

- I dati arrivano in chunk separati
- **IMPORTANTE: Partial Encryption Pattern**
  - **I-frame**: L'intero chunk è criptato → Fresh IV decryption funziona
  - **P-frame**: Solo l'header BcMedia è criptato, il payload video è IN CHIARO!
    - Se decripti tutto con fresh IV, corrompi il payload video
    - Soluzione: Decripta solo i primi N bytes (header), lascia il resto
    - N = 24 + additionalHeaderSize (per video frames)

### Come Riconoscere il Pattern

```javascript
// Decripta con fresh IV per leggere l'header
const decrypted = aesDecrypt(raw, key);
const magic = decrypted.readUInt32LE(0);
const additionalHeaderSize = decrypted.readUInt32LE(12);
const headerLen = 24 + additionalHeaderSize;

// Controlla se i raw bytes al payload hanno start code H.264
const rawPayload = raw.subarray(headerLen);
const hasRawStartCode = rawPayload[0] === 0 && rawPayload[1] === 0 && ...;

if (hasRawStartCode) {
  // P-frame: usa partial decryption
  const headerDecrypted = aesDecrypt(raw.subarray(0, headerLen), key);
  const clearPayload = raw.subarray(headerLen);
  return Buffer.concat([headerDecrypted, clearPayload]);
} else {
  // I-frame: usa full decryption
  return decrypted;
}
```

## Build e Test

```bash
# Compilare dopo modifiche a src/
npm run build

# Eseguire test
node fullTest/test-name.cjs
```

## Frame Rate e Timing

- I dati scaricati sono H.264 raw senza container
- Per convertire in MP4: `ffmpeg -f h264 -i input.h264 -c:v copy output.mp4`
- Frame rate tipico: 25fps per subStream
