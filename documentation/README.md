# Documentation

Welcome to the `@apocaliss92/nodelink-js` API documentation.

This library provides two main APIs for interacting with Reolink cameras:

---

## APIs

### 🔌 [Baichuan Protocol API](./baichuan-api/README.md)

The Baichuan API uses the proprietary binary protocol on port **9000**. It provides:

- Real-time video streaming
- Two-way audio (intercom)
- PTZ control
- Event subscriptions
- Recording download
- Battery camera support

**Best for:** Real-time streaming, low-latency operations, intercom

### 🌐 [CGI HTTP API](./cgi-api/README.md)

The CGI API uses HTTP requests on port **80**. It provides:

- Device configuration
- Encoding settings
- User management
- Network settings
- System administration

**Best for:** Configuration, settings management, integrations

---

## Additional Features

### 📺 [Streaming Servers](./streaming.md)

Create local streaming servers:

- **RTSP Server** - Standard RTSP streaming
- **RFC 4571 Server** - Low-latency TCP for home automation
- **HTTP Server** - Browser-compatible streaming

### 🔍 [Network Discovery](./discovery.md)

Automatically discover Reolink devices on your network using UDP broadcast.

---

## Baichuan API Documentation

| Section                                      | Description                  |
| -------------------------------------------- | ---------------------------- |
| [Connection](./baichuan-api/connection.md)   | Login, logout, ping, reboot  |
| [Device Info](./baichuan-api/device-info.md) | Device information, channels |
| [Streaming](./baichuan-api/streaming.md)     | Live video streams           |
| [Recordings](./baichuan-api/recordings.md)   | Search, download, replay     |
| [PTZ Control](./baichuan-api/ptz.md)         | Pan, tilt, zoom, presets     |
| [Events](./baichuan-api/events.md)           | Motion, AI, doorbell events  |
| [Intercom](./baichuan-api/intercom.md)       | Two-way audio                |
| [Snapshots](./baichuan-api/snapshots.md)     | Capture images               |
| [Detection](./baichuan-api/detection.md)     | Motion, AI settings          |
| [Lights](./baichuan-api/lights.md)           | Spotlight, siren             |
| [Battery](./baichuan-api/battery.md)         | Battery status, sleep        |
| [OSD](./baichuan-api/osd.md)                 | On-screen display            |
| [Network](./baichuan-api/network.md)         | Network, WiFi, storage       |

---

## Quick Links

- [Main README](../README.md)
- [npm package](https://www.npmjs.com/package/@apocaliss92/nodelink-js)
- [GitHub Repository](https://github.com/apocaliss92/nodelink-js)
