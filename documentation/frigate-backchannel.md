# Frigate 2-Way Audio (RTSP Backchannel)

The library ships a dedicated `BaichuanRtspBackchannelServer` — a small,
profile-independent RTSP listener that exposes ONLY the client→camera
talk-back leg of a Reolink camera. It sits next to the per-profile
`BaichuanRtspServer` instances and lets Frigate (or any go2rtc / ffmpeg
client) push operator-mic audio to the camera over a single RTSP URL.

Why a separate server? The Baichuan `TalkSession` is a per-camera concept
(one talk slot per channel, no matter how many video profiles the camera
advertises), so the talk URL should not carry a `main`/`sub`/`ext` path
segment. The dedicated server's path is camera-level — e.g. `/talk`,
`/talk/camera_studio` — and shared across all video profiles of the same
camera.

## Wire flow

```
Browser mic ──WebRTC sendrecv──▶ Frigate's bundled go2rtc ──RTSP RECORD──▶ BaichuanRtspBackchannelServer
                                                              │
                                                              ▼
                                          RTP PCMU 8 kHz / TCP-interleaved
                                                              │
        μ-law decode → upsample 8→16 kHz → IMA ADPCM → TalkSession.sendAudio() → Camera
```

1. Frigate's UI opens a WebRTC sendrecv to its embedded go2rtc carrying
   the operator microphone.
2. go2rtc opens an RTSP session to the camera-level talk URL
   (`OPTIONS` → `DESCRIBE` → `SETUP audiobackchannel` → `RECORD`).
3. The dedicated server opens a Baichuan `TalkSession` via
   `createDedicatedTalkSession(channel)` and starts pumping decoded audio.
4. On `TEARDOWN` or socket close the talk session is closed and the
   camera socket is torn down.

## SDP returned

```sdp
v=0
o=- … IN IP4 …
s=Baichuan Backchannel
c=IN IP4 …
t=0 0
a=control:*
m=audio 0 RTP/AVP 0
a=rtpmap:0 PCMU/8000
a=sendonly
a=control:audiobackchannel
```

No video media block — this server is talk-only. `a=sendonly` is the
client-side convention (the client sends, we receive) that go2rtc
recognises to switch the audio track from `PLAY` to `RECORD`.

## Library example

The library supports two construction modes. **Single-camera** (legacy)
binds one `(api, channel)` to one listener — useful for embedded uses.
**Multi-tenant** mode shares one TCP listener across N cameras, routing
incoming RTSP requests by URL path. The Manager Docker container uses
multi-tenant mode (see the next section).

```ts
import {
  ReolinkBaichuanApi,
  BaichuanRtspServer,            // per-profile, video only
  BaichuanRtspBackchannelServer, // shared talk listener
} from "@apocaliss92/nodelink-js";

const apiA = new ReolinkBaichuanApi({ /* … */ });
const apiB = new ReolinkBaichuanApi({ /* … */ });

// One video server per profile (unchanged):
const videoMain = new BaichuanRtspServer({
  api: apiA, channel: 0, profile: "main",
  listenPort: 8554, path: "/cam/main",
});
await videoMain.start();

// Single shared backchannel listener, one route per camera. Either pass
// `routes` up front or call `addRoute(path, route)` at runtime:
const talk = new BaichuanRtspBackchannelServer({
  listenPort: 8555,
  routes: {
    "/cameraA": { api: apiA, channel: 0 },
    "/cameraB": { api: apiB, channel: 0 },
  },
});
await talk.start();
talk.addRoute("/cameraC", { api: apiC, channel: 7 });

// Legacy single-camera form still works — path defaults to "/talk":
const talkOne = new BaichuanRtspBackchannelServer({
  api: apiA, channel: 0,
  listenPort: 8555, path: "/cam",
});
```

The talk server has no hard dependency on the video servers and can be
shared across all profiles of the same camera.

## Manager setup (Docker)

Enable in **Settings → Restreamer → RTSP Backchannel** (off by default).
Once on, every configured camera is auto-registered under
`/<sanitized-camera-name>` as its underlying API connects, and removed on
disconnect. The manager picks one of two transport modes automatically
based on the restreamer setting:

- **`restreamer = "local"`** (recommended for Frigate-only setups):
  backchannel piggy-backs on the same `LocalRtspMux` TCP port that
  serves video. Video paths take `/<cameraName>/<profile>`, backchannel
  takes `/<cameraName>` (no profile suffix), so they coexist on a single
  port. The `talk.port` / `talk.bindHost` settings are ignored in this
  mode — the mux owns the port (default `8554`).

- **`restreamer = "go2rtc"`**: go2rtc owns the video output port, so the
  manager spins up a dedicated TCP listener for backchannel on
  `talk.port` (default `18556` — continues the manager's go2rtc-side
  numbering `18554`/`18555`/`18556` to avoid clashing with the bundled
  go2rtc binary, which holds `8555` inside the container).

Status (mode, active route list, last bind error) is exposed via tRPC
at `talk.status`.

## Frigate configuration

Point Frigate's bundled go2rtc at the video URL and the talk URL
separately. With the Manager-managed listener every camera is reachable
under the same port — only the path changes.

### Local restreamer (same port for video + talk)

Recommended setup. Video and backchannel share the LocalRtspMux port
(`8554` by default):

```yaml
go2rtc:
  streams:
    cameretta_daniel:
      - rtsp://manager.local:8554/cameretta_daniel/main
      - rtsp://manager.local:8554/cameretta_daniel?backchannel=1

cameras:
  cameretta_daniel:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/cameretta_daniel
          roles: [record, detect]
    live:
      stream_name: cameretta_daniel
    audio:
      enabled: true
```

### go2rtc restreamer (separate port for talk)

When the manager runs go2rtc internally, talk uses a dedicated listener
on `talk.port` (default `18556`):

```yaml
go2rtc:
  streams:
    cameretta_daniel:
      - rtsp://manager.local:18554/cameretta_daniel/main
      - rtsp://manager.local:18556/cameretta_daniel?backchannel=1
```

The `?backchannel=1` query is a hint to go2rtc — it tells it to use
RECORD on the audio track instead of PLAY. The server validates the
request URL against its registered routes and responds 404 to DESCRIBE
on unknown paths (so a typo fails fast).

## Caveats

- **TCP-interleaved transport only**. UDP RTP backchannel returns `461
  Unsupported Transport`.
- **Battery cameras**. A sleeping doorbell or battery cam will take 3–5 s
  on the first `RECORD` to wake up via BCUDP. Subsequent presses while
  the socket is still warm are near-instant.
- **No AEC**. Volume is whatever the browser sends; the camera's own AEC
  handles reverb. Loudspeaker volume on the camera side is set
  separately via the manager UI (Baichuan `AudioConfig.speakerVolume`).
- **Single talker**. Only one RTSP session can hold the backchannel at a
  time per camera; concurrent `RECORD` attempts succeed but the later
  one wins because they share the same `TalkSession` slot on the device.
