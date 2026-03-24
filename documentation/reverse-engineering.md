# Reverse Engineering Notes

Internal documentation for firmware analysis, Baichuan protocol internals, and stream troubleshooting.

---

## Firmware Analysis Runbook

Goal: turn a firmware `.pak` into readable filesystems, then map the **network surface** (RTSP/RTMP/HTTP/HTTPS/ONVIF/CGI + proprietary services).

### Tooling

- `xxd`, `strings`, `grep`, `find` (macOS/Linux)
- `unsquashfs` for SquashFS (`brew install squashfs`)
- `ubi_reader` for UBI/UBIFS: `pip install ubi-reader`

### Step 1: Identify containers

```bash
file path/to/fw.pak
xxd -l 256 path/to/fw.pak
python3 tools/firmware/scan_magics.py path/to/fw.pak
```

Look for: `UBI#` (UBI image), `UBIFS` (superblock), `hsqs` (SquashFS), `uImage`/`FDT` (kernel).

### Step 2: Extract filesystems

```bash
# UBI/UBIFS
python -m ubireader.scripts.ubireader_extract_files -s <UBI_OFFSET_DEC> -o out/ubifs_files path/to/fw.pak

# SquashFS (if present)
unsquashfs -d out/squashfs_root path/to/image.squashfs
```

### Step 3: Boot chain triage

Find init scripts: `/etc/init.d/*`, `/etc/inittab`, `/init`. Search for `/mnt/app` and `/mnt/para` mounts.

```bash
grep -RIn "/mnt/app" rootfs/etc/init.d rootfs/etc | head
grep -RIn "telnetd\|dropbear\|nginx\|rtsp\|onvif" rootfs/etc/init.d | head
```

### Step 4: Map ports and services

```bash
grep -RIn "listen\s\+" out/ubifs_files/*/app | head
grep -RIn "fastcgi_pass" out/ubifs_files/*/app | head
strings -a out/ubifs_files/*/app/rtsp | grep -i rtsp | head
strings -a out/ubifs_files/*/app/onvif | grep -i onvif | head
strings -a out/ubifs_files/*/app/netserver | grep -Ei "(port|listen|bind)" | head
```

### Surface map template

| Protocol | Port | Process | Config | Notes |
|----------|-----:|---------|--------|-------|
| TCP | 80 | nginx | dvr.xml `http_port` | HTTP API + web UI |
| TCP | 443 | nginx TLS | dvr.xml `https_port` | HTTPS |
| TCP | (configurable) | `rtsp` | /mnt/para | RTSP server |
| TCP | 1935 | nginx-rtmp | dvr.xml `rtmp_default_port` | RTMP |
| UDP | 3702 | `onvif` | standard | ONVIF WS-Discovery |
| TCP | (configurable) | `netserver` | /mnt/para `surv_port` | Baichuan proprietary |

---

## Baichuan Socket Streaming Protocol

How the Baichuan client requests native video streams over TCP/BCUDP.

### Wire format

20-byte or 24-byte header (little-endian):
- `cmdId` (u32), `bodyLen` (u32), `channelId` (u8), `streamType` (u8), `msgNum` (u16), `responseCode` (u16), `messageClass` (u16)
- Optional `payloadOffset` (u32) with 24-byte header (`BC_CLASS_MODERN_24 = 0x6414`)

### Streaming cmdIds

- `BC_CMD_ID_VIDEO = 3` — start request + push frames
- `BC_CMD_ID_VIDEO_STOP = 4` — stop

### XML payloads

**Preview v1.0** (classic cameras):
```xml
<body><Preview version="1.0">
  <channelId>0</channelId>
  <handle>0</handle>
  <streamType>mainStream</streamType>
</Preview></body>
```

**Preview v1.1** (Hub/NVR telephoto):
```xml
<body><Preview version="1.1">
  <channelId>0</channelId>
  <handle>512</handle>
  <streamType>mobileStream</streamType>
</Preview></body>
```

### Stream type matrix

| Profile | Handle | Header streamType | Payload streamType |
|---------|-------:|------------------:|-------------------|
| Main | 0 | 0 | `mainStream` |
| Sub | 256 | 1 | `subStream` |
| Ext | 1024 | 0 | `externStream` |
| Main autotrack | — | 2 | `mainStream` |
| Sub autotrack | — | 3 | `subStream` |

Telephoto (Hub/NVR): uses Preview v1.1 with `mobileStream`/`externStream` and handle base 512/1024.

---

## Analyzed Firmware Reports

### TrackMix PoE (IPC_529SD78MP)

- **Model:** Reolink TrackMix PoE (Novatek NVT, IMX415 sensor)
- **Firmware:** v3.0.0, build 250917/1972
- **Dual-lens:** 2 channels (wide + tele)
- **UBI offset:** `0x003b6c56` (3,894,358)
- **Volumes:** rootfs + app (UBI/UBIFS)

**Boot chain:** `S00_PreReady` → mount `/mnt/app`, `start_app` → mount `/mnt/para`, start daemons:
`router`, `device`, `recorder`, `alarmcenter`, `netserver`, `netclient`, `upgrade`, `cloud`, `push`, `factory`, `rtsp`, `ftp`, `onvif`, `spawn-fcgi` (cgiserver.cgi on port 9527), `telnetd`.

**Port table:**

| Protocol | Port | Process | Notes |
|----------|-----:|---------|-------|
| TCP | 80 | nginx → FastCGI | HTTP API + web UI |
| TCP | 443 | nginx TLS | HTTPS |
| TCP | 9527 | spawn-fcgi + cgiserver.cgi | Local FastCGI backend |
| TCP | 1935 | nginx-rtmp | RTMP with on_play hooks |
| TCP | (configurable) | `rtsp` | RTSP server |
| UDP | 3702 | `onvif` | WS-Discovery |
| TCP | (configurable) | `netserver` | Baichuan proprietary |
| TCP | 23 | `telnetd` | Debug |

**RTSP URL patterns:** `rtsp://HOST:PORT/Preview_NN_main|sub|mobile|autotrack` (with and without `/rtsp/` prefix). `NN` = 2-digit channel index.

**RTMP:** nginx hooks `api.cgi?rtmp=start|stop` with params: `token`, `channel`, `stream`, `user`, `password`.

### Reolink Home Hub

- **Type:** HOMEHUB, 8 channels
- **Capabilities:** RTSP, RTMP, ONVIF, Baichuan (`support_bc="1"`)
- **Stream routing:** `nvr_stream_from_tcp="1"`, `support_mobilestream="1"`

**RTSP (verified working):** `/Preview_NN_main`, `/Preview_NN_sub`, `/Preview_NN_autotrack`, `/h264Preview_NN_*`, `/h265Preview_NN_*`

**RTMP (verified working):** `/bcs/channelN_sub.bcs`, `/bcs/channelN_mobile.bcs`, `/bcs/channelN_autotrack_sub.bcs`, `/bcs/channelN_telephoto_sub.bcs`

**Proprietary preview commands:** `START_PREVIEW`, `STOP_PREVIEW`, `COVER_PREVIEW` with XML payload containing `channelId`, `streamType`, `handle`. Stream types: `mainStream`, `subStream`, `mobileStream`, `externStream`.

---

## Troubleshooting Video Streams

### Common symptoms

| Symptom | Probable Cause |
| --- | --- |
| Corrupted video (decode errors) | Encryption/decryption issue |
| Wrong speed | Incorrect FPS or missing timestamps |
| Truncated video | Timeout or interrupted stream |
| No video | msgNum/channelId/streamType filter mismatch |

### Debug process

**1. Compare download vs replay** — Download uses a single blob and is a good reference:

```bash
ffprobe -v error -show_streams file.mp4
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,duration file.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,avg_frame_rate,duration file.mp4
```

**2. Check encryption** — Verify `enc.kind` in `BaichuanVideoStream.chooseDecryptedOrRawCandidate()`:
- `full_aes`: Partial encryption (I-frame: first 1024 bytes, P-frame: header only)
- `aes`: Standard AES
- `bc`: Legacy Baichuan

Key fix: ensure `encryptLen` is extracted from extension XML (`<encryptLen>N</encryptLen>`).

**3. Verify timestamps** — BcMedia frames contain microsecond timestamps. Use `useMpegTsMuxer: true` for correct PTS/DTS in replay.

**4. Validate output:**
```bash
ffprobe -v error -show_entries format=duration output.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate output.mp4
```

### Key components

| Component | Role |
| --- | --- |
| `BaichuanVideoStream` | Receives Baichuan frames, manages decryption |
| `BcMediaCodec` | Assembles fragmented BcMedia packets |
| `BcMediaAnnexBDecoder` | Converts BcMedia to Annex-B with timestamps |
| `MpegTsMuxer` | Muxes Annex-B into MPEG-TS with correct PTS/DTS |

---

[← Back to Main Documentation](./README.md)
