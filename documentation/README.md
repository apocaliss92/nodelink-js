# API Documentation

Full project overview, installation, and examples: **[Main README](../README.md)**

## Baichuan Protocol API (port 9000)

| Section                                      | Description                                  |
| -------------------------------------------- | -------------------------------------------- |
| [**Overview**](./baichuan-api/README.md)     | API reference, constructor, events           |
| [Connection](./baichuan-api/connection.md)   | Login, logout, ping, reboot                  |
| [Device Info](./baichuan-api/device-info.md) | Device information, channels, capabilities   |
| [Streaming](./baichuan-api/streaming.md)     | Live video streams, codec configuration      |
| [Recordings](./baichuan-api/recordings.md)   | Search, download, replay                     |
| [PTZ Control](./baichuan-api/ptz.md)         | Pan, tilt, zoom, presets                     |
| [Events](./baichuan-api/events.md)           | Motion, AI, doorbell event subscriptions     |
| [Intercom](./baichuan-api/intercom.md)       | Two-way audio, talk sessions                 |
| [Snapshots](./baichuan-api/snapshots.md)     | Capture images, thumbnails                   |
| [Detection](./baichuan-api/detection.md)     | Motion, AI, PIR, autotracking settings       |
| [Lights](./baichuan-api/lights.md)           | Spotlight, floodlight, siren, chime/DingDong |
| [Battery](./baichuan-api/battery.md)         | Battery status, sleep/wake management        |
| [OSD](./baichuan-api/osd.md)                 | On-screen display configuration              |
| [Network](./baichuan-api/network.md)         | Network, WiFi, storage, system settings      |

## CGI HTTP API (port 80)

| Section                                       | Description                         |
| --------------------------------------------- | ----------------------------------- |
| [**CGI API Reference**](./cgi-api/README.md)  | Complete HTTP/CGI API documentation |

## Additional

| Section                                            | Description                                  |
| -------------------------------------------------- | -------------------------------------------- |
| [Manager REST API](./manager-api.md)               | Auth, streaming, events, metrics             |
| [Streaming Servers](./streaming.md)                | RTSP, RFC4571, HTTP servers                  |
| [Network Discovery](./discovery.md)                | UDP autodiscovery                            |
| [Authentik + NGINX](./authentik-nginx.md)          | SSO / Trusted Proxy setup                   |
