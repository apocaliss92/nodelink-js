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

```ts
import {
  ReolinkBaichuanApi,
  BaichuanRtspServer,            // per-profile, video only
  BaichuanRtspBackchannelServer, // per-camera, talk only
} from "@apocaliss92/nodelink-js";

const api = new ReolinkBaichuanApi({ /* … */ });

// One video server per profile (unchanged):
const videoMain = new BaichuanRtspServer({
  api, channel: 0, profile: "main",
  listenPort: 8554, path: "/cam/main",
});
await videoMain.start();

// One backchannel server per camera (no profile in the path):
const talk = new BaichuanRtspBackchannelServer({
  api, channel: 0,
  listenPort: 8555, path: "/cam",
});
await talk.start();
```

The talk server has no hard dependency on the video servers and can be
shared across all profiles of the same camera.

## Frigate configuration

Point go2rtc at the video URL and the talk URL separately:

```yaml
go2rtc:
  streams:
    camera_studio:
      # Outbound video served by BaichuanRtspServer
      - rtsp://manager.local:8554/cam/main
      # Inbound backchannel served by BaichuanRtspBackchannelServer
      - rtsp://manager.local:8555/cam?backchannel=1

cameras:
  camera_studio:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/camera_studio
          roles: [record, detect]
    live:
      stream_name: camera_studio
    audio:
      enabled: true
```

The `?backchannel=1` query is a hint to go2rtc — it tells go2rtc to use
RECORD on the audio track instead of PLAY. The dedicated server accepts
any URL under its bound path; the query is for go2rtc, not for us.

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
