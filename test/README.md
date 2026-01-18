# Integration tests (real devices)

Questa repo include una suite di integration test che parla con device reali (camera TCP, camera UDP/battery, NVR).

## Setup

1) Crea un file di config locale (non committato):

- copia `test/devices.config.template.json` in `test/devices.config.json`
- aggiorna IP/UID/canali

Il JSON supporta placeholder di variabili d'ambiente:
- `${VAR}`
- `${VAR:-default}` (fallback se la variabile non esiste)
- `$VAR` (solo se la stringa è *esattamente* `$VAR`)

2) Imposta le credenziali in `.env` (o variabili d'ambiente):

- Per device TCP standalone:
	- `TCP_USERNAME=...`
	- `TCP_PASSWORD=...`
- Per device UDP/battery:
	- `UDP_USERNAME=...`
	- `UDP_PASSWORD=...`
- Per NVR:
	- `NVR_USERNAME=...`
	- `NVR_PASSWORD=...`

Opzionali (usati dalla suite `streams`):
- `RECORD_DURATION=10` (secondi, default 5)
- `FFMPEG_BIN=/path/to/ffmpeg` (default `ffmpeg` in PATH)
- `REOLINK_TEST_ARTIFACTS_DIR=test/artifacts` (default `test/artifacts`)

## Esecuzione

- `npm run test:integration`

Note:
- I test sono *safe-by-default*: eseguono solo chiamate principalmente read-only.
- Alcune suite (streaming/recordings/ptz/setters) possono essere lente o invasive: abilitarle via `suites` nel config.
- La suite `streams` salva JPEG + MP4 sotto `test/artifacts/` (ignorato da git).
