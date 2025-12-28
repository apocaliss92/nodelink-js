# Audio Samples for 2-Way Audio Tests

This folder contains audio sample files used by the 2-way audio tests.

## Available files

- `test-tone.wav`: Generated test tone (440Hz, 1 second, PCM 16-bit, 8kHz, mono)
- `generate-test-audio.js`: Script to generate the test audio file

## Supported audio formats

The tests use the `audio-decode` library, which can decode:

- **WAV** (any sample rate)
- **MP3**
- **OGG Vorbis**
- **FLAC**
- **Opus**
- And other common formats

No manual parsing is required; the library handles decoding.

## Output format

Audio is converted to:

- **Sample rate**: 8000 Hz (if different, a warning is printed; resampling would require an additional library)
- **Bit depth**: 16-bit PCM
- **Channels**: 1 (mono) - only the first channel is used

## Generate the test audio file

To generate a new test audio file:

```bash
node generate-test-audio.js
```

## ffmpeg conversion (optional)

To convert an existing audio file into the optimal format (8kHz, mono, 16-bit):

```bash
ffmpeg -i input.mp3 -ar 8000 -ac 1 -sample_fmt s16 -f wav output.wav
```

Note: this is not required; `audio-decode` handles decoding.

## Usage in tests

Tests automatically load `test-tone.wav` if present; otherwise they fall back to generated test data (silence).

You can also use MP3, OGG, FLAC, etc. by renaming or adjusting the path in the test script.

