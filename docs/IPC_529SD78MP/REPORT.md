# TrackMix PoE – camera report

This report is filled using the template `docs/_shared/CAMERA_REPORT_TEMPLATE.md`.

---

## 1) Camera identity

- Commercial model name: Reolink TrackMix PoE
- HW/SOC (if known): Novatek (from `SDK_VER` in `firmware.info`, NVT platform)
- Sensor(s) (if known): IMX415 (from filename and available modules)
- Variant: PoE, dual stream/channel (from `channel_num="2"`)

---

## 2) Reference firmware

- Firmware file: `firmwares/traxkmix_poe/IPC_529SD78MP.5428_2509171972.Reolink-TrackMix-PoE.IMX415.8MP.PT.REOLINK.pak`
- SHA256: `53923e8cbb4723f9278bcfa9bcd6485baa7a3b680b3642fa671eef3db69c992f`
- Version (from `dvr.xml`): `firmware_version_prefix="v3.0.0"`, `config_version="v3.0.0.0"`
- Build (from `dvr.xml`): `build_date="250917"`, `build_index="1972"`
- Note: `rootfs/etc/firmware.info` contains `SDK_VER="NVT_NT96660_Linux_V0.4.8"` and `BUILDDATE="Tue Mar 1 18:25:28 CST 2016"` (likely SDK/board metadata, not necessarily the product build).

---

## 3) Container / image layout

### 3.1 Magics & offsets

- Offset UBI start (`UBI#`): `0x003b6c56` (dec: 3,894,358)
- PEB size stimata (stride): `0x20000` (131,072)
- SquashFS offset (`hsqs`) (present but not used in the main flow here): `0x58860c` and `0x5bb5d2`
- uImage (legacy): presente (multipli offset)
- FDT (device tree): presente (multipli offset)

### 3.2 Extracted volumes and filesystems

- UBI volumes (from `ubireader_display_info` on the carved image):
  - `rootfs`
  - `app`
- Extraction paths:
  - rootfs: `firmwares/traxkmix_poe/extracted/ubifs_files/1002421600/rootfs`
  - app: `firmwares/traxkmix_poe/extracted/ubifs_files/1471536920/app`

Notes:
- The init scripts also mount `/mnt/para` (UBI/UBIFS from a *different* mtd); the update package does not appear to include the full image corresponding to persistent parameters.

---

## 4) Boot chain (what actually starts)

### 4.1 Init scripts and mounts

- Script that mounts `/mnt/app`:
  - `rootfs/etc/init.d/S00_PreReady` → `ubiattach -m 7 -d 1` poi `mount -t ubifs -o ro /dev/ubi1_0 /mnt/app`
- Script that mounts `/mnt/para`:
  - `rootfs/etc/init.d/start_app` → `ubiattach -m 8 -d 2` poi `mount -t ubifs /dev/ubi2_0 /mnt/para`

### 4.2 Started processes

In `rootfs/etc/init.d/start_app` the following processes are started (all under `/mnt/app`):

- `./router &`
- `./device &`
- `./recorder &`
- `./alarmcenter &`
- `./netserver &`
- `./netclient &`
- `./upgrade &`
- `./cloud &`
- `./push &`
- `./factory &`
- `./rtsp &`
- `./ftp &`
- `./onvif &`

CGI backend:
- `spawn-fcgi -a 127.0.0.1 -p 9527 -f /mnt/app/cgiserver.cgi`

Debug:
- `rootfs/etc/init.d/S25_Net` lancia `telnetd`.

---

## 5) Network surface (ports / protocols / endpoints)

### 5.1 Port table (from config + strings + init)

| Protocol | Port | Process | File/config that sets it | Notes |
|---|---:|---|---|---|
| TCP | 80 | `nginx` (started by `router` / app stack) | `app/dvr.xml` (`http_port="80"`), `app/nginx_conf/conf/nginx.conf` (`listen _HTTP_PORT_`) | API + web UI |
| TCP | 443 | `nginx` (TLS) | `app/dvr.xml` (`https_port="443"`), `app/nginx_conf/conf/nginx.conf` (`listen _HTTPS_PORT_`) | HTTPS; self-signed certs in `app/nginx_conf/` |
| TCP | 9527 | `spawn-fcgi` + `cgiserver.cgi` | `rootfs/etc/init.d/start_app` | Local FastCGI backend for `*.cgi` |
| TCP | 1935 | nginx-rtmp | `app/dvr.xml` (`rtmp_default_port="1935"`), `app/nginx_conf/conf/nginx.conf` (`listen _RTMP_PORT_`) | `rtmp {}` enabled with hooks to `api.cgi?rtmp=start/stop` |
| TCP | (configurable) | `rtsp` | (likely from `/mnt/para`), strings show `port: %d` | port not visible in cleartext in the update `.pak` |
| UDP | 3702 (typical) | `onvif` | (standard ONVIF WS-Discovery behavior) | binary contains `soap.udp://%s:%d` |
| TCP | (unknown) | `netserver` | (likely from `/mnt/para`) | proprietary; binary contains `*_port_cfg_*` handlers |
| TCP | 23 (typical) | `telnetd` | `rootfs/etc/init.d/S25_Net` | debug/maintenance |

### 5.2 HTTP/HTTPS (Web UI + API)

- Web server: nginx (config in `app/nginx_conf/conf/nginx.conf`)
- Document root: `root /mnt/app/www/;`

**CGI / API**
- CGI routing:
  - `location ~ .*\.cgi$ { fastcgi_pass 127.0.0.1:9527; }`
- Backend:
  - `spawn-fcgi -a 127.0.0.1 -p 9527 -f /mnt/app/cgiserver.cgi`
- Endpoints observed in strings/config:
  - `/api.cgi?rtmp=start|stop` (nginx-rtmp hook)
  - `.../cgi-bin/api.cgi?cmd=onvifSnapPic...` (from ONVIF strings)

### 5.3 RTSP

- Binary/server: `app/rtsp`
- Port: configurable (strings: `success to create RTSP server, port: %d`)

**RTSP URL path templates (from firmware strings)**

From `app/onvif` strings (it builds RTSP URLs internally):

- With `/rtsp/` prefix:
  - `rtsp://<host>:<port>/rtsp/Preview_<NN>_main`
  - `rtsp://<host>:<port>/rtsp/Preview_<NN>_sub`
  - `rtsp://<host>:<port>/rtsp/Preview_<NN>_mobile`
  - `rtsp://<host>:<port>/rtsp/Preview_<NN>_autotrack`

From `app/onvif` strings (also present without `/rtsp/` prefix):

- Without `/rtsp/` prefix:
  - `rtsp://<host>:<port>/Preview_<NN>_main`
  - `rtsp://<host>:<port>/Preview_<NN>_sub`
  - `rtsp://<host>:<port>/Preview_<NN>_mobile`
  - `rtsp://<host>:<port>/Preview_<NN>_autotrack`

From `app/rtsp` strings (RTSP server side):

- `Preview_%02d_main`
- `Preview_%02d_sub`

Where:
- `<NN>` is a 2-digit channel index (`%02d`). Given `channel_num="2"` in `dvr.xml`, expected candidates are at least `01` and `02`.
- Dual-lens mapping is not explicitly named in cleartext, but the 2 channels are consistent with *wide* vs *tele* being separate channels.

Notes:
- `dvr.xml` reports `support_mobilestream="0"`, yet `app/onvif` contains `Preview_%02d_mobile`. This suggests the path may exist in code but be feature-gated by config/runtime.
- Default RTSP port is not visible in cleartext inside this `.pak`; it likely comes from persistent parameters (`/mnt/para`) or runtime config.

**Firmware-derived stream request table (TrackMix PoE)**

The table below is built from extracted firmware strings/config only (no SDK assumptions). Where the *exact* request framing (binary headers/length-prefix) is not available offline, it is marked as unknown.

| Stream | Socket-level request to start | Transport / port | Evidence in firmware |
|---|---|---|---|
| RTSP main (lens channel 1) | `DESCRIBE/SETUP/PLAY rtsp://<host>:<rtspPort>/rtsp/Preview_01_main` (also template without `/rtsp/`) | RTSP over TCP; RTP usually UDP unless forced TCP | `app/onvif` templates `%s://%s:%d/rtsp/Preview_%02d_main` and `%s://%s:%d/Preview_%02d_main`; `dvr.xml channel_num="2"` |
| RTSP sub (lens channel 1) | `rtsp://<host>:<rtspPort>/rtsp/Preview_01_sub` | RTSP/TCP | `app/onvif` templates `_sub`; `app/rtsp` contains `Preview_%02d_sub` |
| RTSP main (lens channel 2) | `rtsp://<host>:<rtspPort>/rtsp/Preview_02_main` | RTSP/TCP | `dvr.xml channel_num="2"`; `app/onvif` templates |
| RTSP sub (lens channel 2) | `rtsp://<host>:<rtspPort>/rtsp/Preview_02_sub` | RTSP/TCP | `dvr.xml channel_num="2"`; `app/onvif` templates |
| RTSP mobile (if enabled) | `rtsp://<host>:<rtspPort>/rtsp/Preview_<NN>_mobile` | RTSP/TCP | `app/onvif` contains `_mobile` template, but `dvr.xml support_mobilestream="0"` |
| RTSP autotrack (if enabled) | `rtsp://<host>:<rtspPort>/rtsp/Preview_<NN>_autotrack` | RTSP/TCP | `app/onvif` contains `_autotrack` template |
| RTMP live/vod/bcs (pull) | Client connects to `rtmp://<host>:1935/<app>/<streamKey>`; nginx triggers local start/stop hooks | RTMP over TCP 1935 (default) | `dvr.xml rtmp_default_port="1935"`; `app/nginx_conf/conf/nginx.conf` on_play `api.cgi?rtmp=start`, on_play_done `api.cgi?rtmp=stop` |
| RTMP start hook handler | `GET /api.cgi?rtmp=start&token=...&channel=...&stream=...&user=...&password=...` (query keys parsed) | HTTP 80/HTTPS 443 (device-facing), internal hook to 127.0.0.1 | `app/cgiserver.cgi` strings: `cgi_rtmp_parse get token/channel/stream/user/password` and `cmd-rtmp=start|stop|auth` |
| Proprietary preview control plane | Command tokens exist: `START_PREVIEW` / `STOP_PREVIEW` / `COVER_PREVIEW` / `IFRAME_REQUEST` with params including `channelId` + `streamType` (string names) | Unknown framing + unknown listening port (runtime-configurable `surv_port`) | `app/netserver` strings include these tokens + `channelId` + `streamType` + stream names `mainStream/subStream/mobileStream/externStream`; also has `nets_param_surv_port_cfg_x2s` |
| CGI helper: get RTSP URL | `GET /cgi-bin/api.cgi?cmd=GetRtspUrl&channel=<n>&token=<token>` (exact params may vary) → returns `rtspUrl` | HTTP/HTTPS | `app/cgiserver.cgi` contains `GetRtspUrl`, `rtspUrl`, and RTSP templates `rtsp://%s:%d/Preview_%02d_main|sub` |

**Firmware CGI helper to obtain RTSP URL**

`app/cgiserver.cgi` contains a CGI command named `GetRtspUrl` which returns an `rtspUrl` field.

- Command name: `GetRtspUrl`
- Evidence strings (internal): `cgi_cmd_get_rtspUrl`, `rtspUrl`, and templates:
  - `rtsp://%s:%d/Preview_%02d_main`
  - `rtsp://%s:%d/Preview_%02d_sub`

This strongly suggests a request pattern like:

- `GET /cgi-bin/api.cgi?cmd=GetRtspUrl&channel=<n>&token=<token>`

Exact parameter names beyond `cmd`/`token`/`channel` may vary, but `channel` is referenced by the handler (`pcgicmd->channel`).

### 5.4 RTMP / FLV

- Server: nginx con blocco `rtmp {}`
- Port: default `1935` (from `dvr.xml`), but config uses `_RTMP_PORT_` placeholder
- Hook HTTP:
  - `on_play http://127.0.0.1:_HTTP_PORT_/api.cgi?rtmp=start;`
  - `on_play_done http://127.0.0.1:_HTTP_PORT_/api.cgi?rtmp=stop;`

**RTMP control parameters (from firmware strings)**

From `app/cgiserver.cgi` strings:

- `cgi_rtmp_parse get token:%s` (optional)
- `cgi_rtmp_parse get channel:%d`
- `cgi_rtmp_parse get stream:%s`
- `cgi_rtmp_parse get user:%s`
- `cgi_rtmp_parse get password:%s`
- `cgi_rtmp_parse switch cmd-rtmp=start|stop|auth`

This strongly suggests the RTMP URL (or the RTMP on_play hook) passes query params similar to:

- `channel=<n>`
- `stream=<...>` (likely main/sub selector)
- `user=<username>` / `password=<password>` or `token=<...>`

Note: I did not find the exact RTMP stream key/path format (e.g. `/bcs/channel0_main.bcs`) in cleartext in this firmware dump; only the nginx `application` names (`live`, `vod`, `bcs`) and the CGI parser keys are visible.

### 5.7 Audio (evidence relevant to streams)

Evidence in firmware:

- `dvr.xml`: `default_audio_num="1"` (single audio input pipeline)
- `app/cgiserver.cgi` strings show per-profile audio toggles:
  - `local_mainStream.baudio:%d ...`
  - `local_subStream.baudio:%d ...`
  - `local_extStream.baudio:%d ...`

Interpretation (offline): audio is likely a single mic shared at device level, then attached/enabled per stream profile based on config (`baudio`). Which lens “owns” the audio cannot be proven offline from these strings alone.

### 5.5 ONVIF

- Process/binary: `app/onvif`
- SOAP endpoint (from strings):
  - `http://%s:%d/onvif/device_service`
- CGI dependency (from strings):
  - `http://%s:%d/cgi-bin/api.cgi?cmd=onvifSnapPic&channel=%d`
- WS-Discovery:
  - strings show UDP listener (`onvif server udp listen started`) and `soap.udp://%s:%d`

### 5.6 Proprietary (Reolink / Baichuan / “surveillance”)

- Binari: `app/netserver`, `app/netclient`, librerie `app/libp2p*.so`
- Ports: not determined offline from the `.pak` alone (likely stored in `/mnt/para`)
- Evidence: `netserver` contains config handlers for `http/https/rtsp/onvif/rtmp` (`nets_param_*_port_cfg_*`).

### 5.7 Commands that start/stop streaming (offline evidence)

This section lists *command-level* artifacts found in the extracted firmware that are directly related to starting/stopping live streaming.

For the exact socket-level `cmdId`/header fields and the XML payload variants used by *this repository’s client*, see: `docs/_shared/BAICHUAN_SOCKET_STREAMING.md`.

**A) RTSP (client pull)**

- Client starts streaming by opening RTSP and requesting one of the `Preview_<NN>_*` paths (see RTSP templates above).
- Firmware-side evidence (in `app/rtsp`): `Session streamed by "preview"` and `Preview_%02d_main` / `Preview_%02d_sub`.

**B) RTMP (client pull triggers CGI hook)**

- nginx-rtmp triggers CGI calls on play:
  - `GET /api.cgi?rtmp=start`
  - `GET /api.cgi?rtmp=stop`
  - (optional) `GET /api.cgi?rtmp=auth`
- `app/cgiserver.cgi` parses RTMP-related query params:
  - `token`, `channel`, `stream`, `user`, `password`

**C) Internal “Preview” stream start/stop (netserver/netclient)**

The firmware has an internal “preview stream” control plane that appears to start/stop stream buffers by channel + streamType:

- `app/netserver` strings:
  - `start preview stream type:%d channel:%d`
  - `start preview ok` / `stop preview ok`
  - `user %s preview channel:%d streamtype:%d`
  - stream type names: `mainStream`, `subStream`, `mobileStream`, `externStream`
- `app/netclient` strings:
  - `data len:%d preview xml:%s`
  - `stream start, handle:%d stream type:%d`
  - `stream stop, handle:%d`

This suggests an XML payload named `Preview` is used internally (or over a proprietary socket) to request a stream subscription by `channelId` and `streamType`.

Additionally, `app/cgiserver.cgi` contains preview-related code paths (`cgi_preview_*`) and error strings:

- `cgi_preview_j2s get Preview error!`

This indicates the HTTP CGI layer also understands a JSON object/key named `Preview` (at least for parsing), and RTMP start/stop code paths reuse it:

- `cgi_rtmp_start_j2s get Preview error!`
- `cgi_rtmp_stop_j2s get Preview error!`

**Socket-level command tokens (from `app/netserver`)**

`app/netserver` embeds command identifiers that look like the *actual* protocol command names used in its XML control plane:

- `START_PREVIEW`
- `STOP_PREVIEW`
- `COVER_PREVIEW`
- `IFRAME_REQUEST` (useful after starting preview to force an IDR/I-frame)

These appear adjacent in the binary to other “GET_* / SET_*” command tokens (e.g. `GET_SUPPORT`, `GET_ABILITY`, `SET_TIME_V20`), which is consistent with a generic “command + params” XML RPC.

**Practical minimal payload (best-effort, firmware-derived fields)**

The firmware clearly expects at least:

- `channelId`
- `streamType` with one of: `mainStream`, `subStream`, `mobileStream`, `externStream`

So, a reasonable minimal XML shape to try at socket-level is:

```xml
<START_PREVIEW>
  <channelId>1</channelId>
  <streamType>mainStream</streamType>
</START_PREVIEW>
```

and to stop:

```xml
<STOP_PREVIEW>
  <channelId>1</channelId>
  <streamType>mainStream</streamType>
</STOP_PREVIEW>
```

Note: this is the *payload* structure only; the outer framing (length-prefix / packet header) and the listening port (`surv_port`) are runtime-configurable and not visible as cleartext defaults in this `.pak` (the firmware has a `surv_port` config handler: `nets_param_surv_port_cfg_x2s`).

**On-device helper (if you have shell access)**

`app/rpctool` shows a CLI form `-d <cmd=[cmd_str]:[param]=[val]:...>` which may allow issuing these same commands locally (depending on how it is wired in this model/firmware).

**D) Enabling ports/services (prerequisite for RTSP/RTMP)**

`app/cgiserver.cgi` contains `cgi_cmd_get_netport` / `cgi_cmd_set_netport` and exposes keys:

- `rtspEnable`, `rtspPort`
- `rtmpEnable`, `rtmpPort`

Meaning: starting streaming may require first enabling RTSP/RTMP in the device configuration.

For proprietary socket control (BC / “surveillance”), `app/netserver` contains a `surv_port` configuration handler (`nets_param_surv_port_cfg_x2s`), but `app/cgiserver.cgi` does not expose an obvious `survPort`/`surv_port` key in cleartext.

In `dvr.xml`, the following ports/capabilities are explicitly declared:

- `http_port="80"`
- `https_port="443"`
- `rtmp_default_port="1935"`
- `push_server_port="9501"`

---

## 6) Useful reverse artifacts (offline)

- Config principale:
  - `app/dvr.xml`
- Web UI:
  - `app/www/`
- Nginx config/cert:
  - `app/nginx_conf/conf/nginx.conf`
  - `app/nginx_conf/self.crt`, `app/nginx_conf/self.key`
- CGI backend:
  - `app/cgiserver.cgi`
- Binari streaming:
  - `app/rtsp`, `app/onvif`, `app/nginx`

---

## 7) Come generare questo report da un firmware `.pak`

Procedura standard (riassunto):

1) Scan magics/offset:
- `python3 tools/firmware/scan_magics.py path/to/fw.pak > scan_magics.txt`

2) Estrazione UBIFS (da offset `UBI#`):
- `python -m ubireader.scripts.ubireader_extract_files -s <offset_dec> -o out/ubifs_files path/to/fw.pak`

3) Boot chain:
- cerca in `rootfs/etc/init.d` mount di `/mnt/app` e `start_app`.

4) Porte/servizi:
- web: `nginx.conf` (`listen`, `fastcgi_pass`)
- default: `dvr.xml` (`http_port`, `https_port`, `rtmp_default_port`)
- conferme: `strings` su `rtsp`, `onvif`, `netserver`.

---

## 8) Allegati (output grezzi)

- Scanner magics: vedi output di `tools/firmware/scan_magics.py`.
- Extracted filesystems: `firmwares/traxkmix_poe/extracted/ubifs_files/...`
