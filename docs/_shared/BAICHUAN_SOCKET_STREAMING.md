# Baichuan socket streaming (native)

This document describes how this repository’s Baichuan client requests **native video streams over a socket** (TCP or BCUDP) and which **cmdId / header fields / XML payload variants** are used.

Scope:
- Derived from the implementation in `src/` and the test scripts in `test/tcp/`.
- This is **not** firmware evidence by itself; treat it as a practical command map to reproduce what the app does.

---

## 1) Wire format (Baichuan frame header)

Baichuan frames start with a 20-byte header, or a 24-byte header when `messageClass` indicates a payload offset is present.

Header fields (little-endian):
- `cmdId` (u32)
- `bodyLen` (u32)
- `channelId` (u8)
- `streamType` (u8)
- `msgNum` (u16)
- `responseCode` (u16)
- `messageClass` (u16)
- optional `payloadOffset` (u32) when using 24-byte header

Implementation reference:
- `encodeHeader` / `decodeHeader` in `src/protocol/framing.ts`

Message class used by default in this repo:
- `BC_CLASS_MODERN_24 = 0x6414` (24-byte header + payloadOffset)

---

## 2) Streaming cmdIds

This repo uses the classic Baichuan streaming cmdIds:
- `BC_CMD_ID_VIDEO = 3` (start + video/audio frames)
- `BC_CMD_ID_VIDEO_STOP = 4` (stop)

Reference:
- `src/protocol/constants.ts`

Important: cmdId=3 is used both for the **start request** and later **push frames**. The app filters frames by `(cmdId=3, msgNum)`.

---

## 3) XML pieces (payload + Extension)

Baichuan messages typically carry:
- **Extension XML** (encrypted like normal XML)
- **Payload XML** (encrypted like normal XML)

This repo builds these XML fragments in `src/protocol/xml.ts`:

### 3.1 Extension XML

`buildChannelExtensionXml(channelId)`:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
  <channelId>…</channelId>
</Extension>
```

Notes:
- Some firmwares accept streaming without Extension XML.
- In some Hub/NVR paths, Extension is intentionally empty.

### 3.2 Preview payload (v1.0)

`buildPreviewXml(handle, streamTypeName, channelId?)`:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<body>
  <Preview version="1.0">
    <channelId>…</channelId>
    <handle>…</handle>
    <streamType>mainStream</streamType>
  </Preview>
</body>
```

`buildPreviewStopXml(handle, channelId?)`:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<body>
  <Preview version="1.0">
    <channelId>…</channelId>
    <handle>…</handle>
  </Preview>
</body>
```

### 3.3 Preview payload (v1.1)

`buildPreviewXmlV11({ channelId, handle, streamType })`:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<body>
  <Preview version="1.1">
    <channelId>…</channelId>
    <handle>…</handle>
    <streamType>mobileStream</streamType>
  </Preview>
</body>
```

`buildPreviewStopXmlV11({ channelId, handle })`:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<body>
  <Preview version="1.1">
    <channelId>…</channelId>
    <handle>…</handle>
  </Preview>
</body>
```

---

## 4) Start stream: cmdId=3 combinations

The “native stream start” request is implemented in `ReolinkBaichuanApi.startVideoStream()`.

### 4.1 Common header fields

- `cmdId = 3`
- `messageClass = 0x6414`
- `msgNum`: the client reserves one and subscribes to `(cmdId=3,msgNum)` before sending.

### 4.2 Default (direct camera / classic)

Profile → handle + header streamType + payload streamType string:

- Main:
  - handle: `0`
  - header `streamType`: `0`
  - payload `<streamType>`: `mainStream`

- Sub:
  - handle: `256`
  - header `streamType`: `1`
  - payload `<streamType>`: `subStream`

- Ext:
  - handle: `1024`
  - header `streamType`: `0`
  - payload `<streamType>`: `externStream`

Extension:
- Typically `Extension(version=1.1, channelId=…)` is included.

Payload:
- Typically `Preview version="1.0"`.

### 4.3 Autotrack / alternate variants (Hub/NVR often)

This repo selects variants via **header** `streamType` while keeping the payload stream name canonical:

- Main + autotrack/tele variant:
  - header `streamType`: `2`
  - payload `<streamType>`: `mainStream`

- Sub + autotrack/tele variant:
  - header `streamType`: `3`
  - payload `<streamType>`: `subStream`

### 4.4 Telephoto patterns (Hub/NVR multifocal – PCAP-observed)

This repo tries a dedicated “tele” pattern first:

- Sub tele:
  - payload `Preview v1.1`
  - payload `<streamType>`: `mobileStream`
  - payload `<handle>`: `512 + channelIdTag`
  - header `streamType`: `0`
  - Extension: empty

- Main tele:
  - payload `Preview v1.1`
  - payload `<streamType>`: `externStream`
  - payload `<handle>`: `1024 + channelIdTag`
  - header `streamType`: `0`
  - Extension: empty

It tries both `channelIdTag = channelId` and `channelIdTag = channelId + 1` to cover 0-based vs 1-based firmwares.

If this fails, it falls back to the “default variant via header streamType 2/3” approach.

---

## 5) Stop stream: cmdId=4 combinations

Stopping is implemented in `ReolinkBaichuanApi.stopVideoStream()`.

Common:
- `cmdId = 4`
- `messageClass = 0x6414`
- It tries to send VIDEO_STOP using the same `msgNum` used for VIDEO.

Attempts include:
- Tele stop (Hub/NVR): Preview stop v1.1 (and also v1.0-with-channelId), header `streamType=0`, Extension empty.
- Legacy stop: Preview stop v1.0, header `streamType` matching the started variant (0/1/2/3), Extension usually present.

---

## 6) Post-start controls

If you need to force an IDR/I-frame after starting, firmware for TrackMix PoE embeds `IFRAME_REQUEST` token (from `netserver` strings). This repo does not currently expose a first-class helper for it, but the command name is worth testing in the same control-plane.

---

## 7) Minimal “matrix” summary

Start:
- cmdId: `3`
- header streamType:
  - `0` main/ext default
  - `1` sub default
  - `2` main variant (autotrack/tele)
  - `3` sub variant (autotrack/tele)
- payload:
  - `Preview v1.0` for classic
  - `Preview v1.1` for tele patterns (mobileStream/externStream with handle base 512/1024)

Stop:
- cmdId: `4`
- payload:
  - `Preview v1.0` (handle only)
  - `Preview v1.1` (channelId + handle)

---

## 8) Practical references

- Stream start/stop logic:
  - `src/reolink/baichuan/ReolinkBaichuanApi.ts` (`startVideoStream`, `stopVideoStream`)
- XML builders:
  - `src/protocol/xml.ts` (`buildPreviewXml*`, `buildPreviewStopXml*`, `buildChannelExtensionXml`)
- Header encoding/framing:
  - `src/protocol/framing.ts`
- Quick experiments:
  - `test/tcp/test-tcp-video-stream-simple.ts`
  - `test/tcp/test-tcp-video-stream.ts`
