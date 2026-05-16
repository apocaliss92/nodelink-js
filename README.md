<p align="center">
  <img src="app/client/public/brand/logo-wide-light.svg" alt="Nodelink.js" width="420">
  <br><br>
  A TypeScript library for interacting with Reolink IP cameras and NVRs using the proprietary Baichuan protocol and CGI API. Includes a full-featured web-based Manager UI.
</p>

## Components

### [Manager UI (Web Dashboard)](./app/README.md)

A complete web-based management interface for camera configuration and live streaming — no code required. Docker deployment, go2rtc restreamer, real-time events, MQTT, Home Assistant integration.

### [Library (`@apocaliss92/nodelink-js`)](./documentation/baichuan-api/README.md)

TypeScript library implementing the Reolink Baichuan binary protocol (port 9000) for direct camera/NVR communication. Streaming, events, PTZ, intercom, recordings, battery cameras, multifocal support.

```bash
npm install @apocaliss92/nodelink-js
```

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
});

await api.login();
const info = await api.getInfo();
await api.onSimpleEvent((event) => {
  console.log(event.type, "on channel", event.channel);
});
```

---

## Email Push for Battery Cameras

Battery cameras (Argus, Go, …) can't reliably keep a TCP/ONVIF push subscription alive while sleeping. The manager app embeds an SMTP server so the camera can deliver motion alerts via email — the most resilient path for sleep-heavy devices.

**Flow**:

1. Enable the manager's built-in SMTP server (**Settings → Email Push**, default port `2525`).
2. Each camera gets a unique recipient `cam-<id>@<domain>` (`emailPush.getCameraAddress`).
3. From the camera's **Email Push** tab in the manager UI, click **Auto-configure** — the manager pushes the right SMTP server, recipients and 24/7 schedule to the camera via Baichuan (`baichuan.setupEmailPushToManager`).
4. On motion, the camera sends an email. The manager parses it, classifies the trigger (people/vehicle/motion), saves the snapshot under `${DATA_PATH}/email-push/<cameraId>/`, and emits a synthetic motion event into the same bus used by native Baichuan push — so MQTT, Home Assistant, Frigate, etc. see it transparently.

See [documentation/baichuan-api/email.md](./documentation/baichuan-api/email.md) for the full API and [documentation/baichuan-api/time.md](./documentation/baichuan-api/time.md) for the related NTP / DST / system clock setters.

**Key tRPC procedures**:

- `emailPush.status`, `emailPush.start/stop/restart`, `emailPush.updateSettings`
- `emailPush.getCameraAddress`, `emailPush.listCameraAddresses`
- `emailPush.recentEvents`, `emailPush.injectTestEvent`
- `baichuan.getEmail`, `baichuan.setEmail`, `baichuan.testEmail`
- `baichuan.getEmailTask`, `baichuan.setEmailTask`
- `baichuan.setupEmailPushToManager` (one-shot orchestrator)

---

## Contributing: Share Your Camera Fixtures

Help improve device support by sharing the API responses from your camera model. The diagnostics dump captures all capability and configuration data (credentials, IPs, and serial numbers are **automatically sanitized**).

There are three ways to generate a dump:

**1. From the Manager UI** — Open a camera's detail panel and click the **"Dump"** button (next to Debug). The dump runs on the server and downloads a sanitized zip file automatically. Results are also available in the **Reports** section alongside stream analysis reports.

<p align="center">
  <img src="documentation/screenshots/manager-ui-camera-detail.png" alt="Manager UI — Camera detail panel with Analyze and Dump buttons" width="800">
</p>

**2. Via CLI script** — For developers with a local clone:

```bash
git clone https://github.com/apocaliss92/nodelink-js.git && cd nodelink-js && npm install
# Configure your camera in .env (see env.template)
npx tsx test/capture-model-fixtures.ts
```

**3. Via the library API** — From any project that depends on `@apocaliss92/nodelink-js`:

```typescript
import { ReolinkBaichuanApi, captureModelFixtures } from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({ host: "192.168.1.100", port: 9000, username: "admin", password: "your-password" });
await api.login();
await captureModelFixtures({ api, channel: 0, outDir: "./my-camera-dump", log: console.log });
await api.close();
```

Then open a PR with the generated fixtures. Each new camera model helps us detect capabilities more accurately and prevents regressions. If your model isn't listed in [Supported Devices](#supported-devices), your contribution is especially valuable.

---

## API Documentation

| Section | Description |
| --- | --- |
| [Baichuan Protocol API](./documentation/baichuan-api/README.md) | Binary protocol (port 9000) — streaming, events, PTZ, intercom, recordings |
| [CGI HTTP API](./documentation/cgi-api/README.md) | HTTP REST API (port 80) — configuration, settings, system administration |
| [Manager REST API](./documentation/manager-api.md) | Web dashboard HTTP API — auth, streaming, events, metrics |
| [Streaming Servers](./documentation/streaming.md) | RTSP, RFC4571, HTTP servers |
| [Network Discovery](./documentation/discovery.md) | UDP autodiscovery |

## Supported Devices

<!-- AUTO-UPDATED: regenerated from test/fixtures/models/ folders -->
<!-- To update: npx tsx test/capture-model-fixtures.ts then update this list -->

Devices with captured fixtures (verified API compatibility):

| Model | Type | Firmware |
| --- | --- | --- |
| E1 Outdoor PoE | Wired camera | v3.1.0.5223 |
| E1 Zoom | Wired camera (H.265, PTZ) | v3.2.0.4741 |
| RLC-810A | Wired camera (8MP) | v3.1.0.1162 |
| B400 | Wired camera (4MP) | v3.0.0.183 |
| Argus 3E | Battery camera (via Home Hub) | v3.0.0.3623 |
| Argus PT Ultra | Battery camera with PTZ (via Home Hub) | v3.0.0.3911 |
| Reolink Home Hub | NVR / Hub | v3.3.0.456 |

Also expected to work with other Reolink devices using the Baichuan protocol (port 9000): RLC series, RLN NVRs, TrackMix, Duo, and other Argus battery cameras.

## Credits

Based on the reverse engineering work of:

- **[neolink](https://github.com/thirtythreeforty/neolink)** - Rust implementation of Baichuan protocol
- **[reolink_aio](https://github.com/starkillerOG/reolink_aio)** - Python async library for Reolink cameras

## Disclaimer

This project is **not affiliated with, endorsed by, or connected to Reolink** in any way. "Reolink" is a trademark of Reolink Innovation Inc. This is an independent, community-driven open-source project created for **interoperability purposes**. No proprietary code or firmware from Reolink is included. The protocol implementation is based on publicly available reverse engineering efforts.
