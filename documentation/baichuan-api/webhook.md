# Baichuan HaCfg Webhook Push (cmd 806 / 807)

HTTP wake/sleep push for battery cameras — the same path Home Assistant's `reolink_aio` uses as `bc_webhook`.

## Background

Battery cameras (and battery doorbells in Wired Power mode) close the Baichuan control socket via **idle disconnect**. While disconnected, native cmd 33 event push stops, so motion/PIR is lost even though doorbell presses may still arrive through other paths.

**HaCfg** lets the camera POST JSON to a consumer URL without keeping the control socket open:

| Cmd | Role |
|-----|------|
| **806** | Get `<HaCfg>` (enable / url / verify_cert) |
| **807** | Set `<HaCfg>` |

This is **independent** of the CGI developer webhook (`Support.webhook` / `GetWebHook`). On a Video Doorbell Gen 2, Support reports `webhook=0` while cmd 806 still returns a valid `<HaCfg>` block.

## Support detection

```ts
const supported = await api.probeBaichuanWebhookSupport();
// true when GET 806 returns a parseable <HaCfg>
```

`DeviceCapabilities.hasBaichuanWebhook` stays `false` until a successful probe/`getHaCfg` on that api instance. Do **not** gate on `Support.webhook` or `isDoorbell`.

## Camera-side API

```ts
const cfg = await api.getHaCfg();
// { enable: false, url: "", verifyCert: true } | undefined

await api.setHaCfg({
  enable: true,
  url: "http://192.168.1.10:9081/webhook/cam-abc",
  verifyCert: false,
});

await api.setupBaichuanWebhookToManager({
  url: "http://192.168.1.10:9081/webhook/cam-abc",
});
// SET + verify GET; throws if the camera echoes a different URL
```

After arming, callers that also want connected-socket push should call `subscribeEvents()` (cmd 31) — same as reolink_aio.

## Payload shapes

The camera POSTs JSON. Two shapes are recognised:

```json
{ "data": { "event": "wake", "reason": "pir" } }
```

```json
{ "data": { "event": "wake", "reason": "doorbell" } }
```

```json
{ "data": { "event": "sleep" } }
```

```json
{ "uid": "…", "cmd": 33, "xml": "<AlarmEventList/>", "ext_xml": "…" }
```

Mapping into `onSimpleEvent`:

| Event | Reason | Simple types |
|-------|--------|--------------|
| `wake` | `pir` | `motion`, `awake` |
| `wake` | `doorbell` | `doorbell`, `awake` |
| `wake` | other | `awake` |
| `sleep` | — | `sleeping` |
| `test` | — | (none) |

## Library HTTP intake

```ts
import {
  createBaichuanWebhookServer,
  onBaichuanWebhookEvent,
  parseBaichuanWebhookBody,
} from "@apocaliss92/nodelink-js";

const srv = createBaichuanWebhookServer({
  config: { port: 9081, bindHost: "0.0.0.0", pathPrefix: "/webhook" },
  cameraResolver: (id) => id,
});
await srv.start();

// Or bridge into an api:
const api = new ReolinkBaichuanApi({
  host,
  username,
  password,
  baichuanWebhookCameraId: "cam-abc",
});
```

Manager UI: **Settings → Baichuan Webhook**. Per-camera arming: `baichuanWebhook.setupCamera`.

## Scrypted

The Scrypted plugin exposes `webhook/baichuan/{deviceId}` on its existing `HttpRequestHandler`. HaCfg is armed only via the per-camera **Auto-configure Baichuan Webhook** button (never on init), so another consumer’s URL (e.g. Home Assistant) is not overwritten. **Battery sleep push → Notification method** (`auto` / `webhook` / `email`) filters which transport Scrypted considers; events carry `source: "baichuan" | "email" | "baichuanWebhook"` on `ReolinkSimpleEvent`.

### Wired Power Mode (Doorbell Gen 2)

In adapter / Wired Power Mode the doorbell often **never sleeps**, so it does not POST `wake`/`sleep`. Instead HaCfg forwards normal Baichuan **cmd 33** (`AlarmEventList`) JSON:

`{ "cmd": 33, "xml": "<AlarmEventList>…</AlarmEventList>", "uid": "…" }`

Use `mapBaichuanWebhookParsedToSimpleEvents` / `mapBaichuanWebhookAlarmXmlToSimpleEvents`:

| Camera report | Mapped type |
|---------------|-------------|
| `status=none`, `AItype=other` | `motion` |
| `status=none`, `AItype=people` | `people` |
| `status=visitor` | `doorbell` |
| `status=none`, `AItype=none` | _(ignore)_ |

In `auto` mode, E-mail Push is kept until the first non-empty HaCfg delivery arrives (probe alone must not silence SMTP).

## Related

- [Email Push](./email.md) — SMTP alternative for firmwares without HaCfg
- [Battery / power source](./battery.md) — Wired Power vs Battery Power (cmd 805)
