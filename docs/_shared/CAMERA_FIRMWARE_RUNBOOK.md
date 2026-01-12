# Camera firmware runbook (Reolink)

Goal: turn a firmware `.pak` into readable filesystems, then map the **network surface** (RTSP/RTMP/HTTP/HTTPS/ONVIF/CGI + proprietary services) and where those services are started/configured.

Per-camera report template: `docs/_shared/CAMERA_REPORT_TEMPLATE.md`.

> Nota: molti firmware separano `rootfs` (init/scripts) e `app` (binari e config runtime) in volumi UBI. Alcune partizioni di parametri (`/mnt/para`) possono non essere incluse nel pacchetto di update.

---

## 0) Minimal tooling

- `xxd`, `strings`, `grep`, `find` (macOS/Linux ok)
- `unsquashfs` if SquashFS exists (on macOS via Homebrew: `brew install squashfs`)
- `ubi_reader` for UBI/UBIFS (Python):
  - `python3 -m venv .venv && . .venv/bin/activate && pip install ubi-reader`
  - recommended invocation: `python -m ubireader.scripts.ubireader_extract_files ...` (avoids entrypoint/shebang issues when a venv is moved)

---

## 1) Identify containers and find offsets

1) Identify the file:

- `file path/to/fw.pak`
- `xxd -l 256 path/to/fw.pak`

2) Scan common magics:

- `python3 tools/firmware/scan_magics.py path/to/fw.pak`

What you typically look for:
- `UBI#` → start of a UBI image (EC header), typically repeated every PEB.
- `UBIFS` → UBIFS superblock (sometimes present inside a UBI volume).
- `hsqs` → SquashFS.
- `uImage` / `FDT` → kernel and device tree.

---

## 2) UBI/UBIFS extraction

If the firmware contains `UBI#` at offset `OFF`:

- `python -m ubireader.scripts.ubireader_display_info -s OFF path/to/fw.pak`
- `python -m ubireader.scripts.ubireader_extract_files -s OFF -o out/ubifs_files path/to/fw.pak`

Practical notes:
- `ubireader_extract_files` extracts volumes (e.g. `rootfs`, `app`) into subdirectories based on image_seq.
- If the output dir is not empty, delete and rerun (ubi_reader is conservative).

---

## 3) SquashFS extraction (if present)

If you find a `.squashfs` or a blob with `hsqs`:

- `unsquashfs -d out/squashfs_root path/to/image.squashfs`

---

## 4) Boot-chain triage (what actually starts)

Inside `rootfs` (or equivalent):

- Find init scripts and mounts:
  - `/etc/init.d/*`, `/etc/inittab`, `/init`, `/linuxrc`
  - search for `/mnt/app` and `/mnt/para` to understand where binaries live

Comandi utili:

- `grep -RIn "/mnt/app" rootfs/etc/init.d rootfs/etc | head`
- `grep -RIn "telnetd\|dropbear\|sshd\|nginx\|rtsp\|onvif" rootfs/etc/init.d | head`

Goal: find the script that runs things like `./rtsp &`, `./onvif &`, `./netserver &`, or starts `nginx`.

---

## 5) Service / port / API mapping (offline)

### 5.1 HTTP/HTTPS + CGI

- Look for `nginx.conf`, `lighttpd.conf`, `boa.conf`, `httpd.conf`.
- If nginx + FastCGI is used, you typically see:
  - `listen <http_port>`
  - `fastcgi_pass 127.0.0.1:<port>` (local backend like `spawn-fcgi -p <port> -f cgiserver.cgi`)
- Reolink “CGI API” often lives behind endpoints like:
  - `/cgi-bin/api.cgi` or `/api.cgi`

### 5.2 RTSP

- Look for an `rtsp` binary and “RTSP server” strings:
  - `strings -a app/rtsp | grep -i rtsp | head`
- The port may be configurable; if not visible in the update, it often comes from a persistent parameters partition (`/mnt/para`).

### 5.3 RTMP

- If nginx has an `rtmp { server { listen ... } }` section:
  - common default port: `1935` (but it can be configurable)

### 5.4 ONVIF

- ONVIF typically exposes:
  - HTTP SOAP service: `/onvif/device_service` (over HTTP/HTTPS)
  - WS-Discovery UDP multicast (port 3702)

Offline: search the `onvif` binary for strings like `device_service`, `wsdd`, `soap.udp://`.

### 5.5 Proprietary services (Reolink / Baichuan)

- There are usually `netserver`/`netclient` processes and a configurable TCP “surveillance” service.
- Often (not always) this corresponds to port 9000.

Offline: use `strings -a app/netserver | grep -i "surv\|port\|listen\|bind" | head` and then trace where the value is read from (config or persistent parameters).

---

## 6) Final check: “surface map”

In the end you want a table like:

- `tcp/<http>` → nginx → FastCGI → `cgiserver.cgi` (CGI API)
- `tcp/<https>` → nginx TLS
- `tcp/<rtsp>` → `rtsp` server
- `tcp/<rtmp>` → nginx-rtmp
- `udp/3702` → ONVIF WS-Discovery
- `tcp/<surv>` → `netserver` (proprietary)
- optional debug: `telnetd`/`dropbear`/`sshd`

With references to:
- init scripts that start the processes
- config files that define the ports (or where they are read from)

If you want a uniform “per-camera” document, copy and fill the template in `docs/_shared/CAMERA_REPORT_TEMPLATE.md`.

---

## Appendix: command “starter pack”

- `python3 tools/firmware/scan_magics.py path/to/fw.pak`
- `python -m ubireader.scripts.ubireader_extract_files -s <ubi_offset> -o out/ubifs_files path/to/fw.pak`
- `find out/ubifs_files -maxdepth 4 -type f \( -name '*nginx*' -o -name '*init*' -o -name '*.conf' -o -name '*.xml' \) | head`
- `grep -RIn "listen\s\+" out/ubifs_files | head`
- `strings -a out/ubifs_files/**/app/rtsp | grep -i rtsp | head`
- `strings -a out/ubifs_files/**/app/onvif | grep -i onvif | head`
