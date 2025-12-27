# Cursor (IDE) instructions — `baichuan-protocol`

This guide helps Cursor work consistently on this repository (TypeScript/Node library for Reolink Baichuan/BCUDP + CGI + RTSP proxy).

## Quick setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Project structure (where to work)

- **Baichuan (TCP/BCUDP)**: `src/client/BaichuanClient.ts`
- **Framing Baichuan (20/24 byte)**: `src/protocol/framing.ts`
- **Crypto Baichuan (BCEncrypt/AES)**: `src/protocol/crypto.ts`
- **BCUDP (reliable UDP with ACK/resend)**: `src/bcudp/*`
- **API CGI (HTTP)**:
  - token + refresh: `src/reolink/http/ReolinkHttpClient.ts`
  - CGI API: `src/reolink/cgi/ReolinkCgiApi.ts`
- **API Baichuan**: `src/reolink/baichuan/ReolinkBaichuanApi.ts`
- **Hybrid API (Baichuan → CGI fallback)**: `src/reolink/hybrid/ReolinkHybridApi.ts`
- **API NVR**:
  - CGI: `src/reolink/nvr/ReolinkNvrCgiApi.ts`
  - Baichuan: `src/reolink/nvr/ReolinkNvrBaichuanApi.ts`
  - Hybrid: `src/reolink/nvr/ReolinkNvrHybridApi.ts`
- **RTSP URL builder**: `src/rtsp/urls.ts`
- **RTSP proxy server (HTTP MPEG-TS via ffmpeg)**: `src/rtsp/server.ts`

### Note about `_refs/`
The `_refs/` folder contains cloned reference repositories (neolink/reolink_aio) and is **git-ignored**. Do not use it as product code.

## Quality commands (run before finishing a change)

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Integration testing with a local camera (opt-in)

Integration tests are in `test/integration/reolink.local.test.ts` and are **skipped** unless env vars are provided.

### Environment variables

Required:
- `REOLINK_HOST`
- `REOLINK_USER`
- `REOLINK_PASS`

Optional:
- `REOLINK_CGI_PORT` (e.g. `80` or `443`)
- `REOLINK_CGI_HTTPS=1` (enable HTTPS for CGI)
- `REOLINK_BC_TRANSPORT=tcp|udp|auto`
- `REOLINK_UID` (required if you use BCUDP `mode: "uid"`)
- `REOLINK_ALLOW_REBOOT=1` (allows reboot during integration tests)

Example:

```bash
export REOLINK_HOST=192.168.1.50
export REOLINK_USER=admin
export REOLINK_PASS='password'
export REOLINK_BC_TRANSPORT=auto
export REOLINK_UID='XXXXXXXXXXXX'
npm test
```

## Recommended debugging / logging

- **BaichuanClient**: use `debug: true` and listen to the `debug` event.
- **BCUDP**: `BcUdpStream` emits `error` (you can extend it for more verbose logs).
- **CGI**: errors include status/response text; for odd firmwares inspect the raw response.

## Cursor guidelines (project instructions)

Copy/paste this as "Project instructions" in Cursor:

> You are working on a TypeScript/Node library for Reolink.
> - Keep protocol-specific APIs separate: Baichuan/BCUDP and CGI.
> - The hybrid API must try Baichuan first and fall back to CGI per operation.
> - Avoid unnecessary breaking changes: add compatible methods/options.
> - Do not modify `_refs/` (reference only).
> - After changes run: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
> - Integration tests must be opt-in via env and must not fail in CI when env is missing.
> - IMPORTANT: All repository text must be English (docs, comments, messages, tests). Do not add Italian text.

## Suggested technical roadmap (future extensions)

- Expand `ReolinkBaichuanApi` with missing `cmd_id`s (binary snapshot, stream start/stop, full PTZ, floodlight, PIR, battery, etc.)
- Expand `ReolinkCgiApi` with strongly-typed wrappers for common commands (Get/Set network, encoding, OSD, AI, motion, etc.)
- NVR: add bulk helpers for stream/encoding across all connected cameras
- RTSP: add optional HLS proxy and an ffmpeg healthcheck

