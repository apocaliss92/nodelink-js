# TrackMix PoE (IPC_529SD78MP...) – firmware analysis notes

Firmware:
- `firmwares/traxkmix_poe/IPC_529SD78MP.5428_2509171972.Reolink-TrackMix-PoE.IMX415.8MP.PT.REOLINK.pak`

General runbook: `docs/_shared/CAMERA_FIRMWARE_RUNBOOK.md`

---

## 1) Layout / extraction

Magics found:
- `UBI#` (repeated) → UBI image
- `UBIFS` / `hsqs` present inside the package

UBI offset (start of `UBI#`):
- `0x003b6c56` (dec: 3,894,358)

PEB size (from stride between consecutive `UBI#` hits):
- `0x20000` (131,072)

Extraction (using ubi_reader with start-offset):

- `python -m ubireader.scripts.ubireader_extract_files -s 3894358 -o firmwares/traxkmix_poe/extracted/ubifs_files firmwares/traxkmix_poe/IPC_529SD78MP.5428_2509171972.Reolink-TrackMix-PoE.IMX415.8MP.PT.REOLINK.pak`

Result:
- `firmwares/traxkmix_poe/extracted/ubifs_files/1002421600/rootfs`
- `firmwares/traxkmix_poe/extracted/ubifs_files/1471536920/app`

---

## 2) Boot / started processes

Useful entry points:
- `rootfs/etc/init.d/S00_PreReady` mounts `/mnt/app` from UBIFS (ubi1_0)
- `rootfs/etc/init.d/start_app` mounts `/mnt/para` (ubi2_0) and starts the main daemons

Processes started in `start_app` (all under `/mnt/app`):
- `router`, `device`, `recorder`, `alarmcenter`
- `netserver`, `netclient`
- `upgrade`, `cloud`, `push`, `factory`
- `rtsp`, `ftp`, `onvif`

CGI backend:
- `spawn-fcgi -a 127.0.0.1 -p 9527 -f /mnt/app/cgiserver.cgi`

Debug:
- `rootfs/etc/init.d/S25_Net` lancia `telnetd` (porta tipica 23)

---

## 3) Streaming / API / ports (offline)

### HTTP/HTTPS + CGI

Nginx config:
- `app/nginx_conf/conf/nginx.conf`

Details:
- `listen _HTTP_PORT_` and `listen _HTTPS_PORT_` (placeholders → runtime values)
- CGI route: `location ~ .*\.cgi$ { fastcgi_pass 127.0.0.1:9527; }`

Defaults from `app/dvr.xml`:
- `http_port="80"`
- `https_port="443"`

So (very likely):
- HTTP su 80
- HTTPS su 443
- CGI via FastCGI locale su 9527

### RTMP

Nginx includes an `rtmp { server { listen _RTMP_PORT_; ... } }` block.

Default from `app/dvr.xml`:
- `rtmp_default_port="1935"`

### RTSP

Binario:
- `app/rtsp`

Strings indicate the port is variable/configurable:
- `success to create RTSP server, port: %d`

(A plausible historical default is 554, but it is not visible in cleartext in this firmware.)

### ONVIF

Binario:
- `app/onvif`

Evidence from strings:
- SOAP endpoint: `http://%s:%d/onvif/device_service`
- also uses CGI API for snapshots: `http://%s:%d/cgi-bin/api.cgi?cmd=onvifSnapPic&channel=%d`
- WS-Discovery via UDP (`soap.udp://%s:%d`) → typically port 3702

### Proprietary service (Reolink / Baichuan)

Binari:
- `app/netserver`, `app/netclient`

Da stringhe su `netserver`:
- presenza di handler config `nets_param_http_port_cfg_*`, `nets_param_https_port_cfg_*`, `nets_param_rtsp_port_cfg_*`, `nets_param_onvif_port_cfg_*`, `nets_param_rtmp_port_cfg_*`

Interpretation:
- `netserver` manages/propagates port configuration and capabilities; the actual values may live in `/mnt/para` (persistent parameters partition) and not in the update package.
