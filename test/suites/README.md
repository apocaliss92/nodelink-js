# Camera Test Suites

Test suites for validating Baichuan protocol implementation across different camera types.

## Suites

### H264 Suite (`h264-suite.mjs`)

Tests for H264-capable cameras (e.g., TrackMix PoE at 192.168.50.226).

```bash
# Run H264 suite
node test/suites/h264-suite.mjs --password YOUR_PASSWORD

# With custom host
node test/suites/h264-suite.mjs --host 192.168.50.226 --password YOUR_PASSWORD --verbose

# Run specific test
node test/suites/h264-suite.mjs --only replayRecording --password YOUR_PASSWORD

# Skip tests
node test/suites/h264-suite.mjs --skip ptzCapabilities,livePreview --password YOUR_PASSWORD
```

### H265 Suite (`h265-suite.mjs`)

Tests for H265-capable cameras (e.g., CX810 at 192.168.1.170).

**Important Notes for H265:**

- H265 cameras require `msgNum=0` for cmdId=5 (FileInfoList_Replay)
- XML payload must not have empty lines
- Some H265 cameras have stricter XML validation

```bash
# Run H265 suite
node test/suites/h265-suite.mjs --password YOUR_PASSWORD

# With custom host
node test/suites/h265-suite.mjs --host 192.168.1.170 --password YOUR_PASSWORD --verbose
```

### Run All (`run-all.mjs`)

Run both suites sequentially:

```bash
# Run all suites
node test/suites/run-all.mjs --password YOUR_PASSWORD

# Only H264
node test/suites/run-all.mjs --h264-only --password YOUR_PASSWORD

# Only H265
node test/suites/run-all.mjs --h265-only --password YOUR_PASSWORD

# Custom hosts
node test/suites/run-all.mjs \
  --h264-host 192.168.50.226 \
  --h265-host 192.168.1.170 \
  --password YOUR_PASSWORD \
  --verbose
```

## Environment Variables

```bash
export REOLINK_PASSWORD="your_password"
export H264_HOST="192.168.50.226"
export H265_HOST="192.168.1.170"

# Then run without --password
node test/suites/run-all.mjs
```

## Test Coverage

Each suite tests:

| Test               | Description              | H264 | H265 |
| ------------------ | ------------------------ | ---- | ---- |
| `connect`          | Authenticate with camera | ✓    | ✓    |
| `getDeviceInfo`    | Get device info          | ✓    | ✓    |
| `getAbilities`     | Get capabilities         | ✓    | ✓    |
| `searchRecordings` | Search recordings        | ✓    | ✓    |
| `replayRecording`  | Replay video (cmdId=5)   | ✓    | ✓\*  |
| `getThumbnail`     | Get recording thumbnail  | ✓    | ✓    |
| `livePreview`      | Live video preview       | ✓    | ✓    |
| `getSnapshot`      | Live snapshot            | ✓    | ✓    |
| `ptzCapabilities`  | Check PTZ support        | ✓    | ✓    |
| `disconnect`       | Graceful disconnect      | ✓    | ✓    |

\* H265 replay is particularly important as it validates the cmdId=5 fix.

## Common Issues

### H265 Replay Returns 400

If H265 replay fails with responseCode=400:

1. Check that `msgNum=0` is set for cmdId=5
2. Verify XML has no empty lines (use `array.join()` pattern)
3. Ensure file exists on camera (search recordings first)

### Connection Timeout

- Verify camera IP is correct
- Check network connectivity
- Ensure port 9000 is not blocked

### No Recordings Found

- Camera may not have SD card
- Time range may not contain recordings
- Check camera timezone settings

## Adding New Tests

To add a new test, add an object to the `tests` array:

```javascript
{
  name: 'myNewTest',
  description: 'Description of what this tests',
  fn: async (client) => {
    // Test implementation
    // Use assert(), assertEqual(), etc.
    const result = await client.someMethod();
    assert(result, 'Should return result');
  },
}
```
