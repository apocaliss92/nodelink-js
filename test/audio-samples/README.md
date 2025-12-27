# Audio Samples per Test 2-Way Audio

Questa cartella contiene file audio di test per i test 2-way audio.

## File disponibili

- `test-tone.wav`: Tono di test generato (440Hz, 1 secondo, PCM 16-bit, 8kHz, mono)
- `generate-test-audio.js`: Script per generare il file audio di test

## Supporto formati audio

I test utilizzano la libreria `audio-decode` che supporta automaticamente:
- **WAV** (qualsiasi sample rate)
- **MP3**
- **OGG Vorbis**
- **FLAC**
- **Opus**
- E altri formati comuni

**Nessun parsing manuale richiesto!** La libreria gestisce automaticamente la decodifica.

## Formato output

L'audio viene automaticamente convertito a:
- **Sample rate**: 8000 Hz (se diverso, viene avvisato - resampling richiederebbe libreria aggiuntiva)
- **Bit depth**: 16-bit PCM
- **Channels**: 1 (mono) - solo il primo canale viene utilizzato

## Generazione file audio

Per generare un nuovo file audio di test:

```bash
node generate-test-audio.js
```

## Conversione con ffmpeg (opzionale)

Per convertire un file audio esistente al formato ottimale (8kHz, mono, 16-bit):

```bash
ffmpeg -i input.mp3 -ar 8000 -ac 1 -sample_fmt s16 -f wav output.wav
```

**Nota**: Non è necessario - `audio-decode` gestisce automaticamente la conversione!

## Utilizzo nei test

I test caricano automaticamente `test-tone.wav` se disponibile, altrimenti usano dati di test (silenzio).

Puoi anche usare file MP3, OGG, FLAC, etc. - basta rinominarli o modificare il percorso nel test.

