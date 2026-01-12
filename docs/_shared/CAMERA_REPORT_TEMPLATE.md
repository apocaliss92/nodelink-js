# Camera report template (fill per model)

This file is a **template** to copy into a per-camera folder (e.g. `firmwares/<camera>/REPORT.md`) and fill in.

It also includes a standard procedure to **generate the report starting from a firmware** `.pak`.

---

## 1) Camera identity

- Commercial model name:
- HW/SOC (if known):
- Sensor(s) (if known):
- Variant (PoE/Wi‑Fi/Battery, dual lens, PTZ, etc.):

---

## 2) Reference firmware

- Firmware file:
- SHA256 (optional):
- Version (from filename or internal files like `firmware.info` / `dvr.xml`):
- Build date (if present):

---

## 3) Container / image layout

### 3.1 Magics & offsets

Fill from offline scans:

- UBI start offset (`UBI#`):
- Estimated PEB size (stride):
- UBIFS superblock offset (if useful):
- SquashFS offset (`hsqs`) (if present):
- Kernel (`uImage`) / FDT (if present):

### 3.2 Extracted volumes and filesystems

- UBI volumes found (from `ubireader_display_info`):
  - `rootfs` (read-only?);
  - `app`;
  - other;
- Extraction paths:
  - rootfs:
  - app:
  - (optional) para:

Notes:
- If you see references to `/mnt/para` but there is no `para` volume in the update package, it is often a separate persistent-parameters partition not included in the `.pak`.

---

## 4) Boot chain (what actually starts)

### 4.1 Init scripts and mounts

- Init entry-point (`/init`, `linuxrc`, `inittab`, `rcS`, etc.):
- Script that mounts `/mnt/app`:
- Script that mounts `/mnt/para`:

### 4.2 Started processes

List the started processes (with paths and arguments if present):

- 
- 

---

## 5) Network surface (ports / protocols / endpoints)

> Goal: a table “port → process → config → purpose”. If a port is configurable and not visible in the `.pak`, record the source (e.g. `/mnt/para`).

### 5.1 Port table (from configs + strings + init)

| Protocol | Port | Process | File/config that sets it | Notes |
|---|---:|---|---|---|
| TCP | 80 | | | HTTP web/API |
| TCP | 443 | | | HTTPS web/API |
| TCP | 554 | | | RTSP (if default) |
| TCP | 1935 | | | RTMP (if present) |
| UDP | 3702 | | | ONVIF WS-Discovery |
| TCP | 9000 | | | Proprietary (if present) |

### 5.2 HTTP/HTTPS (Web UI + API)

- Web server: (nginx / lighttpd / boa / other)
- Config file:
- Document root:
- Auth (basic/form/cookie):

**CGI / API**
- Main endpoints (examples):
  - `/cgi-bin/api.cgi`
  - `/api.cgi`
- Backend (FastCGI/uwsgi):
  - `fastcgi_pass 127.0.0.1:<port>`
  - possibly `spawn-fcgi ... cgiserver.cgi`

### 5.3 RTSP

- Binary/server:
- Port:
- Authentication:
- URL pattern (if deducible):
  - `rtsp://<ip>:<port>/<path>`

### 5.4 RTMP / FLV / HLS (if present)

- Server:
- Port:
- Paths/applications (`live`, `vod`, etc.):
- HTTP hooks (e.g. `on_play http://127.0.0.1:<http_port>/api.cgi?...`):

### 5.5 ONVIF

- Process/binary:
- SOAP endpoint (typically on HTTP/HTTPS):
  - `http(s)://<ip>:<port>/onvif/device_service`
- WS-Discovery multicast (UDP 3702):
- Event support (PullPoint / notifications) (if deducible):

### 5.6 Proprietary (Reolink / Baichuan / “surveillance”)

- Binaries (e.g. `netserver`, `netclient`, `p2p`):
- Port(s):
- Authentication/handshake (if deducible from strings):

---

## 6) Useful reverse artifacts (offline)

- Key config files (XML/INI/JSON):
- TLS certificates (self-signed paths, if present):
- Interesting libraries (p2p/crypto):
- Protocol indicators (keywords):

---

## 7) How to generate this report from a firmware `.pak`

### 7.1 Scan magics and offsets

1) Identify magics and offsets:

- `python3 tools/firmware/scan_magics.py path/to/fw.pak > scan_magics.txt`

2) Copy into the report:
- UBI start offset (first `UBI#` hit)
- stride/PEB size (most frequent delta)
- any `hsqs`/`UBIFS` offsets

### 7.2 Filesystem extraction (UBI/UBIFS)

1) (Recommended) create a venv with ubi_reader:

- `python3 -m venv .venv`
- `. .venv/bin/activate`
- `pip install ubi-reader`

2) Extract using `--start-offset`:

- `python -m ubireader.scripts.ubireader_extract_files -s <UBI_OFFSET_DEC> -o out/ubifs_files path/to/fw.pak`

3) Find `rootfs` and `app` under `out/ubifs_files/*/`.

### 7.3 Find what starts (boot chain)

1) Search for mounts of `/mnt/app` and `/mnt/para`:

- `grep -RIn "/mnt/app" out/ubifs_files/*/rootfs/etc/init.d out/ubifs_files/*/rootfs/etc | head -n 200`
- `grep -RIn "/mnt/para" out/ubifs_files/*/rootfs/etc/init.d out/ubifs_files/*/rootfs/etc | head -n 200`

2) Identify the “main” script (often `start_app`) and list the started daemons.

### 7.4 Map ports / services

1) Web (nginx):

- Search for `listen` and CGI backend:
  - `grep -RIn "listen\s\+" out/ubifs_files/*/app | head -n 200`
  - `grep -RIn "fastcgi_pass" out/ubifs_files/*/app | head -n 200`
  - `grep -RIn "api\.cgi\|/cgi-bin" out/ubifs_files/*/app | head -n 200`

2) Default ports from config (typically `dvr.xml`):

- `grep -nE "http_port=|https_port=|rtmp_default_port=" out/ubifs_files/*/app/dvr.xml`

3) Server binaries:

- `strings -a out/ubifs_files/*/app/rtsp | grep -i rtsp | head -n 50`
- `strings -a out/ubifs_files/*/app/onvif | grep -i onvif | head -n 80`
- `strings -a out/ubifs_files/*/app/netserver | grep -Ei "(port|listen|bind|rtsp|onvif|http|https)" | head -n 120`

4) Fill the report port table with:
- port (if visible)
- started process (from init)
- config file (nginx/dvr.xml)
- notes for “configurable port” if read from `/mnt/para`.

---

## 8) Attachments (raw outputs)

- `scan_magics.txt`:
- `ubireader_display_info` output:
- relevant init script snippets:
- relevant web config snippets (nginx):
