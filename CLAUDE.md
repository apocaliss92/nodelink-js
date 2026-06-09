# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypeScript library (`@apocaliss92/nodelink-js`) implementing the Reolink Baichuan binary protocol (port 9000) for direct IP camera and NVR communication. Also includes a web-based Manager UI (`app/`) built with Express + tRPC + React.

The library is consumed by external projects (e.g., `scrypted-reolink-native` which symlinks this repo).

## Commands

```bash
npm run build          # Build library (tsup bundle + api-extractor types → dist/)
npm run typecheck      # Type-check without emitting
npm run lint           # ESLint (flat config, TS rules)
npm run app:dev        # Run Manager UI in dev mode (via nx)
npm run rtsp-server    # Build + run standalone RTSP server CLI
```

Always rebuild after changing `src/` so `dist/` is updated for consumers.

No test suite exists — there is no `npm test` command.

## Architecture

### Three-Layer Protocol Stack

1. **Protocol layer** (`src/protocol/`) — Binary framing, XOR/AES encryption, XML builders. The Baichuan wire format uses a magic header (`f0 de bc 0a`), 20/24-byte binary headers, and XML payloads encrypted with XOR or AES-128-CFB.

2. **Client layer** (`src/client/BaichuanClient.ts`) — TCP/UDP socket management, request-response correlation (via `cmdId:msgNum` keys), encryption negotiation, event emission. Handles battery camera fallback to UDP (BCUDP).

3. **API layer** (`src/reolink/baichuan/ReolinkBaichuanApi.ts`) — The main public class (~15k lines). Wraps a **socket pool** of `BaichuanClient` instances, manages dedicated streaming sessions, caches capabilities, and implements 100+ public methods.

### Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/reolink/baichuan/utils/` | ~26 modules: each handles XML parsing/building for one feature area (PTZ, events, recordings, chime, etc.) |
| `src/reolink/baichuan/capabilities.ts` | Device capability detection from Support/Abilities XML |
| `src/reolink/baichuan/types.ts` | All API request/response type definitions |
| `src/baichuan/stream/` | Streaming: BaichuanRtspServer (RTSP video), BaichuanRtspBackchannelServer (RTSP talk-back for Frigate), BaichuanWebRTCServer (in-process WebRTC via werift), H264/H265 converters |
| `src/reolink/cgi/` | Alternative HTTP/CGI API for cameras |
| `src/bcudp/` | UDP transport for battery cameras |
| `src/multifocal/` | Dual-lens composite streams (TrackMix, Duo cameras) |

### Streaming pipeline

- **RTSP**: every camera stream is served by `BaichuanRtspServer` plugged into a single shared `LocalRtspMux` (`app/src/local-rtsp-mux.ts`) listening on `settings.localRtsp.port` (default `8554`). Video paths take `/<sanitizedCameraName>/<profile>`. The mux reads the first request line, dispatches by path, and hands the socket to the matching `BaichuanRtspServer` via `injectSocket()`.
- **RTSP backchannel (Frigate 2-way audio)**: same mux, path `/<sanitizedCameraName>` (no profile suffix). Off by default — flip `settings.talk.enabled`. See `app/src/backchannel-manager.ts`.
- **WebRTC preview**: `BaichuanWebRTCServer` (werift, in-process). Driven by the `webrtc.*` tRPC router (`app/src/routers/webrtc.ts`) — browser calls `webrtc.create({cameraId,profile})`, receives an offer, posts back an answer, and optionally trickles ICE.

The bundled `go2rtc` sidecar was removed (see release notes). Frigate is still supported as a downstream consumer over RTSP; the Frigate config emitter (`app/src/routers/frigate.ts`) targets the LocalRtspMux URL.

### Manager UI (`app/`)

Separate npm project using `file://..` symlink to the library. Tech stack: Express + tRPC + Zod (backend), React + Vite (frontend). The tRPC router in `app/src/routers/baichuan.ts` wraps all `ReolinkBaichuanApi` methods. Connection pooling lives in `app/src/rtsp-manager.ts`.

**Default ports (configurable in settings):**
| Service | Port | Notes |
|---------|------|-------|
| Manager UI/API | 3000 | Express + tRPC |
| RTSP (video + backchannel) | 8554 | `settings.localRtsp.port`, LocalRtspMux dispatches per path |
| WebRTC ICE (native) | configurable via `settings.webrtc.icePortRange` | werift binds whatever the user sets |

**Key tRPC routers:**
- `rtsp.*` — stream lifecycle (registers a `BaichuanRtspServer` route on `LocalRtspMux`)
- `webrtc.*` — in-process WebRTC signaling (offer/answer/ICE/close)
- `talk.*` — backchannel status (mux mode, listed routes)
- `cameras.*` — camera CRUD, connection management

### Build Pipeline

- **tsup** bundles `src/index.ts` → ESM + CJS output in `dist/`
- **api-extractor** rolls up `.d.ts` files into a single `dist/index.d.ts`
- **nx** orchestrates builds across library and app workspaces

## Testing Policy (MANDATORY)

**Every code change MUST include tests.** This is non-negotiable for both new features and bug fixes.

### Rules

1. **New features** — Write tests BEFORE or alongside the implementation. No feature is complete without tests.
2. **Bug fixes** — Write a test that reproduces the bug FIRST, verify it fails, then fix the code and verify the test passes. This prevents regressions.
3. **Protocol changes** — Capture real request/response fixtures from a camera (`npx tsx test/capture-protocol-fixtures.ts`) and add fixture-based tests.
4. **Refactoring** — Existing tests must still pass. Add tests for any edge cases discovered during refactoring.

### Test Structure

```
test/
├── lib/                    # Library tests (protocol, converters, framing)
│   ├── crypto.test.ts      # XOR/AES encryption
│   ├── framing.test.ts     # Binary header encode/decode
│   ├── xml-parsing.test.ts # XML builders/parsers
│   ├── h264-converter.test.ts
│   ├── h265-converter.test.ts
│   ├── bcmedia.test.ts     # Stream frame analysis
│   ├── nvr.test.ts         # NVR multi-channel, socket isolation, battery
│   ├── fixtures-validation.test.ts
│   └── protocol-responses.test.ts
├── app/                    # Manager app tests
│   ├── settings-schema.test.ts
│   ├── frigate-config.test.ts
│   ├── frigate-client.test.ts   # Mock HTTP server
│   ├── rtsp-manager.test.ts
│   └── events-manager.test.ts
├── fixtures/               # Captured from real cameras (committed to git)
│   ├── protocol/           # XML response fixtures
│   ├── nvr/                # NVR multi-channel fixtures
│   └── *.json, *.bin       # Stream frames, keyframes
├── capture-fixtures.ts             # Re-capture stream fixtures
├── capture-protocol-fixtures.ts    # Re-capture protocol XML fixtures
├── capture-nvr-fixtures.ts         # Re-capture NVR multi-channel fixtures
├── capture-model-fixtures.ts       # Full model capability dump (all cameras)
└── capture-diagnostic-fixtures.ts  # H.265 stream diagnostic fixtures
```

### Commands

```bash
npm test              # Run all tests (must pass before any commit)
npm run test:watch    # Watch mode during development
npx tsx test/capture-fixtures.ts           # Re-capture stream fixtures
npx tsx test/capture-protocol-fixtures.ts  # Re-capture protocol fixtures
npx tsx test/capture-nvr-fixtures.ts       # Re-capture NVR fixtures
npx tsx test/capture-model-fixtures.ts     # Full model dump (all cameras in .env)
npx tsx test/capture-model-fixtures.ts --runs 3  # 3 runs for confirmation
```

### Model Fixture Capture (Diagnostics Dump)

Captures all API responses from every configured camera for capability detection, regression testing, and debugging. This is the same `captureModelFixtures()` function used by the Scrypted plugin's "Dump Model Fixtures" button.

**Setup:** Configure cameras in `.env` (see `env.template`): `TCP_HOST`, `TCP265_HOST`, `NVR_HOST`, `HUB_HOST` with corresponding credentials.

**What it does:**
1. Connects to each camera/NVR in `.env`
2. For standalone cameras: dumps all 25+ API methods + stream combination test (3 pairs)
3. For NVR/Hub: detects active channels (skips empty/sleeping), dumps each camera's API, then runs per-camera stream combo test (NOT cross-camera — only that camera's own profiles)
4. Outputs to `test/fixtures/models/<ModelName>/channels/0/`
5. Sensitive data (IPs, MACs, serial numbers, credentials) is automatically sanitized

**Output per camera:** `device-info.json`, `support-info.json`, `capabilities.json`, `stream-metadata.json`, `motion-alarm.json`, `ai-state.json`, `talk-ability.json`, `ptz-presets.json`, `stream-combination-test.json`, `_summary.json`, and more.

**When to re-capture:**
- After adding new API methods (to verify they work on real hardware)
- After protocol changes that affect XML parsing
- When supporting a new camera model
- To update test fixtures with latest firmware responses

### CI

Tests run automatically on every push/PR via `.github/workflows/ci.yml`. **PRs with failing tests will not be merged.**

## Adding New API Methods — Checklist

1. **`src/protocol/constants.ts`** — Add `BC_CMD_ID_*` constant(s)
2. **`src/reolink/baichuan/types.ts`** — Add response/param interface(s)
3. **`src/reolink/baichuan/utils/`** — Add XML builders and parsers in the relevant util file
4. **`src/reolink/baichuan/ReolinkBaichuanApi.ts`** — Add public method(s), import new constants/utils/types
5. **`src/reolink/baichuan/capabilities.ts`** — Update `DeviceCapabilities` if the feature requires a capability flag
6. **`app/src/routers/baichuan.ts`** — Add tRPC procedure(s) (query for GET, mutation for SET)
7. **`test/`** — **Add tests** for new XML parsers, protocol responses, and tRPC procedures
8. **`documentation/baichuan-api/`** — Update the relevant `.md` file
9. **`README.md`** — Update if the feature adds a user-facing capability
10. **`npm test && npm run build`** — Tests pass and rebuild before testing consumers

## Capability Flags

Capability flags live in `DeviceCapabilities` (`types.ts`) and are computed in `capabilities.ts` from Support/Abilities XML responses. The fallback path is in `ReolinkBaichuanApi.ts` (`getCapabilitiesFromNvrChannelItem`). Always update all three locations when adding a new flag.

## Protocol Notes

- All commands use Baichuan binary framing with `cmdId` + optional XML payload
- Channel is passed in the packet header; some commands also include it in the XML body
- Battery cameras may return 400 when sleeping — treat as transient, not unsupported
- XML fragments from the protocol have multiple top-level tags; the parser wraps them in a synthetic root
- Streaming decryption (AES-128-CFB) is stateful across fragmented frames; new BcMedia packets reset cipher state via magic bytes
- `cmd_id 483` = hardwired chime (battery doorbells only)
- `cmd_id 609/610` = wireless chime silent mode (paired Reolink Chime receiver)

## Robustness Mechanisms

- **Socket pool** with exponential backoff cooldowns (5s → 120s) on repeated failures
- **Event subscription watchdog** monitors silence (5-minute threshold), auto-resubscribes
- **Storm detection** (disconnect storms, ECONNRESET storms) triggers device reboot as last resort
- **Three-tier caching**: push cache (settings), capabilities cache (5-min TTL), recording metadata cache
- **Idle disconnect** for battery cameras closes socket after inactivity period
