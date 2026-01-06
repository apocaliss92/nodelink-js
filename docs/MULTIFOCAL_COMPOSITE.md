# Stream Composito Multifocal

Questo documento descrive come utilizzare il sistema di composizione multifocal per combinare gli stream di una telecamera multifocal (wider e tele) in un nuovo stream composito con picture-in-picture (PIP) configurabile.

## Panoramica

Le telecamere multifocal (come Reolink TrackMix) hanno due lenti:
- **Wide-angle lens** (channel 0): Fornisce un campo visivo più ampio
- **Telephoto lens** (channel 1): Fornisce una vista zoomata/teleobiettivo

Il sistema di composizione permette di:
- Combinare entrambi gli stream in un unico stream composito
- Posizionare il stream tele come PIP (picture-in-picture) sul wider
- Configurare posizione, dimensione e margine del PIP
- Esporre lo stream composito come server RTSP

## Utilizzo Base

### CompositeStream

```typescript
import { ReolinkBaichuanApi } from "@reolink/baichuan-js";
import { CompositeStream, type PipPosition } from "@reolink/baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.50",
  username: "admin",
  password: "password",
  transport: "tcp",
});

await api.login();

// Crea stream composito
const compositeStream = new CompositeStream({
  api,
  widerChannel: 0,      // Channel wider
  teleChannel: 1,       // Channel tele
  widerProfile: "main", // Profile per wider
  teleProfile: "sub",   // Profile per tele (può essere sub per risparmiare banda)
  pipPosition: "bottom-right", // Posizione PIP
  pipSize: 0.25,        // Dimensione PIP (25% dello schermo)
  pipMargin: 10,       // Margine dal bordo in pixel
  logger: console,
});

// Avvia stream
await compositeStream.start();

// Ascolta frame video compositi
compositeStream.on("videoFrame", (frame: Buffer) => {
  // Processa frame composito
  console.log(`Frame composito: ${frame.length} bytes`);
});

// Ferma stream
await compositeStream.stop();
```

### Posizioni PIP Disponibili

- `top-left`: In alto a sinistra
- `top-right`: In alto a destra
- `bottom-left`: In basso a sinistra
- `bottom-right`: In basso a destra (default)
- `center`: Al centro
- `top-center`: In alto al centro
- `bottom-center`: In basso al centro
- `left-center`: A sinistra al centro
- `right-center`: A destra al centro

### CompositeRtspServer

Per esporre lo stream composito come server RTSP:

```typescript
import { CompositeRtspServer } from "@reolink/baichuan-js";

const rtspServer = new CompositeRtspServer({
  api,
  widerChannel: 0,
  teleChannel: 1,
  widerProfile: "main",
  teleProfile: "sub",
  pipPosition: "bottom-right",
  pipSize: 0.25,
  pipMargin: 10,
  listenHost: "127.0.0.1",
  listenPort: 8554,
  path: "/composite",
  logger: console,
});

await rtspServer.start();

const rtspUrl = rtspServer.getRtspUrl();
console.log(`RTSP URL: ${rtspUrl}`);

// Il server è ora disponibile su rtsp://127.0.0.1:8554/composite
// Puoi connetterti con qualsiasi client RTSP (VLC, ffplay, ecc.)

// Ferma server
await rtspServer.stop();
```

## Esempio Completo

```typescript
import { ReolinkBaichuanApi } from "@reolink/baichuan-js";
import { CompositeRtspServer } from "@reolink/baichuan-js";

async function main() {
  const api = new ReolinkBaichuanApi({
    host: "192.168.1.50",
    username: "admin",
    password: "password",
    transport: "tcp",
  });

  await api.login();

  const rtspServer = new CompositeRtspServer({
    api,
    widerChannel: 0,
    teleChannel: 1,
    widerProfile: "main",
    teleProfile: "sub",
    pipPosition: "bottom-right",
    pipSize: 0.3, // 30% dello schermo
    pipMargin: 15,
    listenPort: 8554,
    path: "/composite",
  });

  await rtspServer.start();
  console.log(`Server RTSP composito: ${rtspServer.getRtspUrl()}`);

  // Gestisci shutdown graceful
  process.on("SIGINT", async () => {
    await rtspServer.stop();
    await api.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

## Configurazione Avanzata

### Dimensione PIP

La dimensione del PIP è specificata come frazione (0.0 - 1.0):
- `0.1` = 10% dello schermo
- `0.25` = 25% dello schermo (default)
- `0.5` = 50% dello schermo

### Margine

Il margine specifica la distanza in pixel dal bordo dello schermo per il PIP.

### Profile Stream

È possibile usare profili diversi per wider e tele:
- Wider: `main` (alta qualità)
- Tele: `sub` (bassa qualità per risparmiare banda)

Questo riduce il carico di rete mantenendo una buona qualità per il stream principale.

## Requisiti

- `ffmpeg` deve essere installato nel sistema
- La telecamera deve essere multifocal (rilevata come `type: "multifocal"`)

## Note Tecniche

- Il sistema usa `ffmpeg` per fare overlay video
- Lo stream composito viene ricodificato in H.264 per garantire compatibilità
- I frame vengono sincronizzati automaticamente da ffmpeg
- Il server RTSP supporta multiple connessioni simultanee

## Troubleshooting

1. **Stream non parte**: Verifica che la telecamera sia multifocal e che i canali 0 e 1 siano disponibili
2. **FFmpeg error**: Assicurati che `ffmpeg` sia installato e accessibile nel PATH
3. **Sincronizzazione**: Se i frame non sono sincronizzati, prova a usare lo stesso profile per entrambi gli stream
4. **Performance**: Per migliori performance, usa `sub` profile per il tele stream

