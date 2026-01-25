# Reolink Baichuan Test Suite

Offline test suite che lavora su fixture di dati video catturati, senza necessità di connessione live ai dispositivi.

## Struttura

```
test/
├── README.md                    # Questa guida
├── run-tests.mjs                # Entry point per eseguire tutti i test
├── capture-raw-data.mjs         # Script per catturare nuove fixture
├── fixtures/raw/                # Dati catturati (gitignore)
│   ├── tcp/                     # TrackMix PoE (H.264 full_aes)
│   ├── tcp265/                  # E1 Outdoor (H.265 full_aes)
│   └── nvr/                     # NVR RLN8-410 (3 canali)
├── utils/
│   ├── fixture-loader.mjs       # Caricamento e parsing fixture
│   └── test-runner.mjs          # Framework di test leggero
└── unit/
    ├── video-stream.test.mjs    # Test struttura video H.264/H.265
    ├── bcmedia.test.mjs         # Test parsing pacchetti BcMedia
    └── nvr-channels.test.mjs    # Test multi-canale NVR
```

## Esecuzione Test

```bash
# Tutti i test
node test/run-tests.mjs

# Solo test specifici
node test/run-tests.mjs video      # video-stream tests
node test/run-tests.mjs bcmedia    # bcmedia tests
node test/run-tests.mjs nvr        # nvr-channels tests
```

## Dispositivi Supportati

| Device              | Host           | Codec | Encryption | Canali |
| ------------------- | -------------- | ----- | ---------- | ------ |
| TCP (TrackMix PoE)  | 192.168.50.226 | H.264 | full_aes   | 0      |
| TCP265 (E1 Outdoor) | 192.168.1.170  | H.265 | full_aes   | 0      |
| NVR (RLN8-410)      | 192.168.1.161  | Mixed | full_aes   | 0,1,2  |

## Test Coverage

- **78 test totali** su 3 file di test
- Validazione struttura NAL H.264/H.265
- Verifica parametri SPS/PPS/VPS
- Test formato Annex-B
- Test metadati encryption
- Confronto live vs playback
- Test multi-canale NVR
