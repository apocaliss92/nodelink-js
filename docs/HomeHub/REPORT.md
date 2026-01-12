# Reolink Home Hub – firmware-derived stream request table

This document is derived from extracted HomeHub firmware artifacts under `firmwares/homehub/extracted/`.

## 1) Capabilities and ports (from dvr.xml)

Key flags from `app_files/dvr.xml`:
- `type="HOMEHUB"`
- `channel_num="8"` (hub can manage up to 8 channels)
- `support_rtsp="1"`, `support_rtmp="1"`, `support_onvif="1"`, `support_bc="1"`
- `nvr_stream_from_tcp="1"` and `support_tcp_connnect="1"`
- `rtmp_default_port="1935"`
- `http_port="80"`, `https_port="443"`
- `support_mobilestream="1"`

## 2) Firmware-derived stream request table (HomeHub)

This table is built from extracted firmware strings/config only. Where the *exact* request framing (binary headers/length-prefix) is not available offline, it is marked as unknown.

| Stream | Socket-level request to start | Transport / port | Evidence in firmware |
|---|---|---|---|
| RTSP main (channel NN) | `DESCRIBE/SETUP/PLAY rtsp://<host>:<rtspPort>/rtsp/Preview_<NN>_main` (also template without `/rtsp/`) | RTSP over TCP; RTP usually UDP unless forced TCP | `app_files/onvif` contains `%s://%s:%d/rtsp/Preview_%02d_main` and `%s://%s:%d/Preview_%02d_main` |
| RTSP sub (channel NN) | `rtsp://<host>:<rtspPort>/rtsp/Preview_<NN>_sub` (also template without `/rtsp/`) | RTSP/TCP | `app_files/onvif` contains `_sub` templates |
| RTSP mobile (channel NN) | `rtsp://<host>:<rtspPort>/rtsp/Preview_<NN>_mobile` | RTSP/TCP | `app_files/onvif` contains `_mobile`; `dvr.xml support_mobilestream="1"` |
| RTSP autotrack (channel NN) | `rtsp://<host>:<rtspPort>/rtsp/Preview_<NN>_autotrack` | RTSP/TCP | `app_files/onvif` contains `_autotrack` |
| ONVIF snapshot | `GET /cgi-bin/api.cgi?cmd=onvifSnapPic&channel=<n>` | HTTP/HTTPS | `app_files/onvif` string: `http://%s:%d/cgi-bin/api.cgi?cmd=onvifSnapPic&channel=%d` |
| RTMP live/vod/bcs (pull) | Client connects to `rtmp://<host>:1935/<app>/<streamKey>`; nginx triggers start/stop hooks | RTMP over TCP 1935 | `dvr.xml rtmp_default_port="1935"`; `app_files/nginx_conf/conf/nginx.conf` hooks `api.cgi?rtmp=start|stop` |
| RTMP hook handler | `GET /api.cgi?rtmp=start` and `GET /api.cgi?rtmp=stop` with query keys parsed by CGI (`token`, `channel`, `stream`, `user`, `password`). Observed `stream` values include `mobile`, `telephoto_main`, `telephoto_sub`, `autotrack_main`, `autotrack_sub`. | HTTP (device-facing) and internal hook to 127.0.0.1 | `nginx.conf` on_play/on_play_done; `app_files/cgiserver.cgi` contains `cmd-rtmp=start|stop|auth`, `cgi_rtmp_parse get token/channel/stream/user/password`, plus stream labels and `channel%d_%s` formatter |
| Proprietary preview control plane | Command tokens exist: `START_PREVIEW` / `STOP_PREVIEW` / `COVER_PREVIEW` (and `MSG_NETC_START_PREVIEW_WITH_TYPE` / `MSG_NETC_STOP_PREVIEW_WITH_TYPE` internally) with params including `channelId` + `streamType` and stream names `mainStream/subStream/mobileStream/externStream` | Likely TCP is supported/required for some modes (`nvr_stream_from_tcp=1`), but exact on-wire framing and port are not visible offline | `app_files/netserver` strings include these tokens + `channelId` + `streamType`; `dvr.xml` contains `nvr_stream_from_tcp="1"` + `support_tcp_connnect="1"`; `app_files/cgiserver.cgi` contains `MSG_NETC_START_PREVIEW_WITH_TYPE` |

## 3) Next extraction step (to complete the socket table)

## 4) Autotrack mapping (RTSP vs RTMP) — firmware-derived

**RTSP**
- HomeHub exposes autotrack as a distinct RTSP path variant per channel: `Preview_%02d_autotrack`.
- No `autotrack_main` / `autotrack_sub` variants were found as RTSP URL templates; the RTSP templates show a single `_autotrack` suffix.

**RTMP**
- In `cgiserver.cgi`, the RTMP start/stop parsing logic enumerates `stream` labels including:
	- `autotrack_main`
	- `autotrack_sub`
	- `telephoto_main`
	- `telephoto_sub`
	- `mobile`
- The same area contains a `channel%d_%s` formatter string; this strongly suggests a mapping where the effective stream key/name is built from channel + stream label (exact RTMP app/streamKey naming still requires a capture to confirm end-to-end).

To make a *complete* “TCP/UDP request” table for the proprietary socket streaming (not RTSP/RTMP), we still need firmware evidence for:
- the listening port (often called `surv_port` on cameras) and whether it is TCP, UDP, or both
- the on-wire framing (length-prefix, header magic, etc.) used by the command tokens like `START_PREVIEW`

Those details are typically not stored as plain XML files; they often require either:
- finding the exact parser/framer strings in `netserver` (hard offline), or
- pairing firmware evidence with a capture of a real session.

## 5) HUB-native preview streaming (START_PREVIEW/STOP_PREVIEW/COVER_PREVIEW) — commands + XML fields

This section documents what can be proven *directly* from HomeHub firmware strings about the proprietary “preview” plane (not RTSP/RTMP).

**Commands (token names)**
- `START_PREVIEW`
- `STOP_PREVIEW`
- `COVER_PREVIEW`

**Framing (binary packet wrapper)**
- `netserver` logs explicitly mention a preview command parser with: `packet_type`, `remain_len`, `total_len`.
- Exact header layout/magic bytes are not visible as cleartext strings in the extracted firmware.

**Payload format: XML string (confirmed)**
- `netclient` debug strings repeatedly log *XML* for these operations:
	- `data len:%d preview start xml:%s`
	- `data len:%d preview stop xml:%s`
	- `data len:%d preview xml:%s`
	- `data len:%d cover preview xml:%s`
	- `data len:%d preview stat xml:%s`

**Confirmed XML fields / keys**
The following strings exist as standalone keys in `netclient`/`netserver` and are therefore confirmed as field names used in the preview XML:
- `channelId`
- `streamType`
- `handle`

**Confirmed streamType value names**
The following `streamType` value strings exist in the firmware:
- `mainStream`
- `subStream`
- `mobileStream`
- `externStream`

**Cover preview and preview status message types**
- `CoverPreview` (string present)
- `PreviewStat` (string present)

**What is still missing to write an “exact XML template”**
- The firmware does not include a literal, static template string like `<body><Preview ...>` for preview start/stop; it appears to be constructed programmatically (TinyXML is present).
- Without either (a) a literal template, or (b) a captured runtime XML example, we cannot state the exact element nesting (root tag name, `version="..."` attribute presence, and whether fields are attributes vs child elements) with certainty.
