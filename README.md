# @reolink/baichuan-js

Mostly vibed TypeScript library implementing Reolink Baichuan protocol (control + streaming) with CGI and RTSP helpers. Full TypeScript support with comprehensive type definitions.

## Features

- ✅ **Full TypeScript support** with comprehensive type definitions
- ✅ **Baichuan Protocol** (TCP/UDP) for camera control and streaming
- ✅ **CGI/REST API** support for HTTP-based operations
- ✅ **Hybrid API** with automatic fallback (Baichuan → CGI)
- ✅ **Video/Audio Streaming** with H.264 decoding support
- ✅ **RTSP Server** and HTTP MPEG-TS proxy
- ✅ **NVR Support** for multi-channel systems
- ✅ **Battery Camera Support** via BCUDP (UDP protocol)
- ✅ **PTZ Control** (pan, tilt, zoom, presets)
- ✅ **Event Subscriptions** (motion, AI detection)
- ✅ **Two-way Audio** support
- ✅ **Device Abilities** detection

## Implementation Notes

This library was developed starting from reference implementations in Rust and Python for the Baichuan protocol,
adapted and rationalized for the TypeScript ecosystem. The reference sources are not part of the package and are
used only as technical documentation of the protocol.

## License

MIT
