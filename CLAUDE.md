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
| `src/baichuan/stream/` | Streaming outputs: RTSP, HLS, MJPEG, WebRTC, MPEG-TS muxing, H264/H265 converters |
| `src/reolink/cgi/` | Alternative HTTP/CGI API for cameras |
| `src/bcudp/` | UDP transport for battery cameras |
| `src/multifocal/` | Dual-lens composite streams (TrackMix, Duo cameras) |

### Manager UI (`app/`)

Separate npm project using `file://..` symlink to the library. Tech stack: Express + tRPC + Zod (backend), React + Vite (frontend). The tRPC router in `app/src/routers/baichuan.ts` wraps all `ReolinkBaichuanApi` methods. Connection pooling lives in `app/src/connection-manager.ts`.

### Build Pipeline

- **tsup** bundles `src/index.ts` → ESM + CJS output in `dist/`
- **api-extractor** rolls up `.d.ts` files into a single `dist/index.d.ts`
- **nx** orchestrates builds across library and app workspaces

## Adding New API Methods — Checklist

1. **`src/protocol/constants.ts`** — Add `BC_CMD_ID_*` constant(s)
2. **`src/reolink/baichuan/types.ts`** — Add response/param interface(s)
3. **`src/reolink/baichuan/utils/`** — Add XML builders and parsers in the relevant util file
4. **`src/reolink/baichuan/ReolinkBaichuanApi.ts`** — Add public method(s), import new constants/utils/types
5. **`src/reolink/baichuan/capabilities.ts`** — Update `DeviceCapabilities` if the feature requires a capability flag
6. **`app/src/routers/baichuan.ts`** — Add tRPC procedure(s) (query for GET, mutation for SET)
7. **`documentation/baichuan-api/`** — Update the relevant `.md` file: add to ToC and add a section with signature, parameters table, return type, and example
8. **`README.md`** — Update the root README if the new feature adds a user-facing capability (new section, usage example, or entry in the features/API tables)
9. **`npm run build`** — Rebuild before testing consumers

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
