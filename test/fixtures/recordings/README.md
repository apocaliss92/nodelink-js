# Recordings fixtures (FileInfoList, CoverPreview, cmd 5 download)

Decrypted Baichuan traffic captured on **2026-09-20** by a read-only probe
(`nativeOnly: true`, session guard / resubscribe / reboot guards off) against
two topologies:

| dir | device | firmware | channel | notes |
| --- | --- | --- | --- | --- |
| `standalone/` | Reolink E1 Outdoor PoE (`IPC_560SD88MP`) | v3.1.0.5223 | 0 | SD card mounted; 546 clips on the captured day |
| `hub/` | Reolink Home Hub, child = Argus PT Ultra | hub v3.3.0.456 | 1 | the hub answers from its own storage; the child was asleep before, during and after |

Host and camera clocks were both `Europe/Berlin` (CEST, UTC+2). Wall-clock
values in the XML are the camera's local time — the tests read them with
`timeZone: "Europe/Rome"` (same offset) and pin the UTC instants.

## What each file is

| file | cmd | content |
| --- | --- | --- |
| `getuid-114-response.xml` | 114 | `<Uid><uid>…</uid></Uid>` — the standalone's own UID (standalone only) |
| `hddinfo-102-response.xml` | 102 | storage present/mounted |
| `channelinfo-145-push.xml` | 145 | the unsolicited channel push (hub only). It arrived **12 s after `subscribeEvents()`**, not on login |
| `fileinfolist-14-open-request.xml` / `-response.xml` | 14 | search open; the response carries `<handle>` |
| `fileinfolist-15-page-request.xml` / `-page1-response.xml` / `-page2-response.xml` | 15 | page requests and the first page(s): 40 entries per full page, **no `<bFinished>`** on either firmware |
| `fileinfolist-16-close-request.xml` | 16 | close |
| `fileinfolist-sequence.json` | 14/15/16 | the call sequence with timings and the `channel` argument handed to `sendXml` (always `undefined`: the header stays hostChannelId 250) |
| `coverpreview-298-request.xml` | 298 | the CoverPreview request; the hub one carries `<uid>` |
| `coverpreview-298-payload.bin` | 298 | the binary reply, **sanitised**: stream header (`1002` standalone / `1001` hub), frame wrapper and the first 48 bytes of the SPS/PPS NAL kept, the rest of the picture zeroed |
| `coverpreview-298-meta.json` | 298 | request header fields, the parsed result (`encoding`, `frameLength`, `streamInfo`) and the sanitisation range; standalone also records that a **zero-length window (`end == start`) is refused with 400** |
| `download-5-frames.json` | 5 | every frame of one clip download: `dtMs` from the request, `responseCode` (200 on the 32-byte stream header, 0 on every chunk, never 201), sizes. `returnedAfterMs` vs `lastDataAtMs` is the 15 s idle tail 0.7.8 removes |
| `download-5-first-extension.xml` / `-chunk-extension.xml` | 5 | decrypted `<Extension>` of the header frame (`<binaryData>1</binaryData>`) and of a chunk (adds `<encryptLen>`) — standalone only |
| `download-5-bcmedia-audio.bin` / `-meta.json` | 5 | the first 40 BcMedia packets of one real download per topology — the Info header, the I/P packets and the **AAC frames**. The whole-download counters and the ADTS parameters live in the meta. **Sanitised**: every BcMedia header is the wire byte for byte; each AAC frame keeps its 7-byte ADTS header and its 512 compressed bytes are zeroed; each I/P packet keeps its header and `additionalHeader` and its payload is replaced by a 64-byte synthetic Annex-B NAL of the DETECTED codec, so no picture bytes ship |

## Sanitisation

- UIDs are replaced by fixed fakes of the same length: `9527000STANDALON`,
  `9527000HUBCHILD0`, `9527000HUBCHILD1`, `9527000HUBCHILD3`. The hub's
  per-child folder in `<Id>` (`/mnt/sda/U10<uid>-<name>/…`) is rewritten with
  the fake UID and a generic camera name.
- Camera names are replaced by `Camera N`; the `OnlineUserList` (cmd 120)
  was not kept.
- The CoverPreview picture bytes are zeroed (see above); every byte the
  parser reads is intact.

## From the official app (2026-09-20, operator's captures)

Decrypted with the manager's capture tool from the Reolink app talking to
(a) the standalone E1 Outdoor PoE above (`standalone/`), and (b) the Home Hub
above — **the file the operator labelled "lavanderia" is the hub connection
with child channel 0 selected** (cmd 145 pushes, cmd 114 answering the hub's
own UID, cmd 318 probing channels), so those fixtures live under `hub/`.

| file | cmd | content |
| --- | --- | --- |
| `dayrecords-142-request.xml` / `-response.xml` (standalone), `dayrecords-142-emptymonth-*` (August, `<dayTypeList />`), `dayrecords-142-ch0-*` (hub ch 0) | 142 | the recording calendar: a calendar-month window + one `<DayRecord>{ index, channelId, uid }` per channel; reply `<dayType index>` = day − 1, absent = no footage. Header channelId is a session counter, no Extension (`../dayrecords-142-headers.json`) |
| `dayrecords-142-ch3-*`, `dayrecords-142-batch-*` (ch 0+1+3 in one request), `dayrecords-142-uid-selects-*` (ch 1 asked with ch 0's UID → ch 0's days) | 142 | the same call issued by this library live against the hub |
| `findalarmvideo-272-open-*`, `findalarmvideo-273-get-request.xml`, `findalarmvideo-273-page1-response.xml` (30 entries, `bFinished 0`), `findalarmvideo-273-lastpage-response.xml`, `findalarmvideo-274-close-request.xml` (standalone); `findalarmvideo-272-open-*`, `findalarmvideo-273-page-response.xml` (hub ch 0, 29 entries in one page, with `uid`/`logicChn`/`bHasRecFile`/`bDeleted` per entry) | 272/273/274 | `<findAlarmVideo>`: one local day, Extension `{ channelId }` + body `{ channelId, uid, logicChnBitmap, streamType, notSearchVideo, startTime, endTime, alarmType, eventAlarmType }`; open answers `{ channelId, fileHandle }`; get pages `<alarmVideo>{ fileName, bEncrypted, alarmType, fileId, startTime, endTime }`; the 273 get and the 274 close are the same bytes. Implemented by `api.searchAlarmVideos` (`test/lib/recordings-findalarmvideo.test.ts`) |
| `findeventlog-516-open-request.xml` (3-day window, newest first), `findeventlog-516-open-allhistory-request.xml` (endTime 1970), `findeventlog-516-open-response.xml` (`{ handle, maxEventCount 60 }`), `findeventlog-517-get-request.xml`, `findeventlog-517-page-response.xml` (60 rows, `bFinished 0`, three children), `findeventlog-518-close-request.xml` (all under `hub/`); `standalone/findeventlog-516-open-response.xml` is **a zero-byte file on purpose** — the standalone's whole answer | 516/517/518 | the Hub's cross-channel `<findEventLog>`: `chnbits 0` + a `<devices>` list of `{ uid, logicChnBitmap }`, DESCENDING time window; rows `<eventLog>{ uid, logicChn, bHasRecFile, bEncrypted, bDeleted, alarmType, startTime, endTime }`, no file name. Implemented by `api.searchEventLog` (`test/lib/recordings-findeventlog.test.ts`); hub only |
| `fileinfolist-14-open-app-request.xml` (standalone sub; hub ch 0 sub), `fileinfolist-14-open-app-main-request.xml` (standalone main) | 14 | the app's FileInfoList open: 16-type `recordType` CSV + 19-item `<fileRecordType>`; sub and main asked as two searches |
| `coverpreview-298-app-request.xml` | 298 | the app's CoverPreview on a hub child: same as ours plus `<desc>0</desc>` |
| `replayseek-123-request.xml` | 123 | `<ReplaySeek>{ channelId, seq, seekTime }` (reply 200, empty body) |
| `versioninfo-318-request.xml` / `-response.xml` | 318 | per-channel `<VersionInfo>` (serial number zeroed) |

Additional fakes: `9527000HUBITSELF` (the hub's own UID), `Camera S` (the standalone's name).

## Verified live, 2026-09-20

The two search families were exercised read-only against the same two devices
after they were implemented. What that settled, beyond the captures:

| Question | Answer |
| --- | --- |
| Does a `findAlarmVideo` window wider than one local day work? | **No.** 18→19 September answered 462 windows, all dated 18 September — standalone and hub child alike. The firmware answers the START day and drops the rest, silently. |
| What does `findAlarmVideo`'s numeric `streamType` select? | **The file set.** `0` → all 539 main-stream names of that day, `1` → all 539 sub-stream ones (539/539 against the matching cmd 14 listing). The app sends 0. |
| Do the windows really live inside their file? | Yes — 1 271 of 1 271 on 19 September, none outside, 1 to 13 windows per file over 539 files. `fileName` is exactly the cmd 14 `<name>`. |
| Does a standalone implement `findEventLog`? | No: cmd 516 answers an empty body in 17 ms. |
| Does the `findEventLog` window have to be descending? | **Yes.** The same window written forwards answered ZERO rows in 191 ms. `desc` was 0 in both directions, so `desc` is not what orders the rows. |
| What does `chnbits` do? | **Nothing observable.** `chnbits: 3` answered exactly what `chnbits: 0` did (59 events, same rows), while cutting `<devices>` to one child cut 59 events to 10. The selector is `<devices>`. Its real purpose remains unknown. |
| Does paging work with the handle the open returned? | Yes — 1 886 events over 20 days came back from repeated gets carrying handle 0, in ~32 pages of 60. The reply's own handle (1) is recorded and unused. 5 rows repeated across boundaries, so the api dedupes. |
| Is an event a promise of a clip? | No: 515 of those 1 886 rows had `bHasRecFile 0`. |

## Verified live, 2026-09-20 — audio on the download path

| Question | Answer |
| --- | --- |
| Does the cmd 5 download carry audio, or is it video-only? | **It carries it.** A 2 s standalone clip (1 967 336 B in 2 662 ms) held 51 H.264 access units and **32 AAC frames**; a 43 s hub-child clip (11 680 272 B in 9 074 ms) held 661 H.265 access units and **688 AAC frames** (357 072 B). `downloadRecordingDemuxed` registered no `onAudioFrame`, so it was decoded and thrown away. |
| Which audio codec, per camera? | **AAC-LC, 16 kHz, mono** on both, one ADTS frame per BcMedia packet, 519 bytes each, identical first header (`fff1604040fffc`). No ADPCM seen on either topology. |
| Is the audio complete, or does it thin out? | Complete. 688 frames x 1024 samples / 16 000 = 44.032 s against a 43 s clip; the muxed tracks land 21 ms apart over 44 s (0.4 ms over 27 s on the standalone). |
| Does the info header's `fps` describe the delivered stream? | **No.** The hub child declares `fps 30` and delivers 15.019 (661 AUs over 43.943 s of timestamps). The standalone declares 25 and delivers 24.704. Only the access-unit timestamps are the authority. |
| Does the BcMedia frame header name the codec correctly? | **Not on the hub child**: every I/P packet declares `H264` while the payload is H.265. `detectVideoCodecFromNal` is what gets it right. |
| Does listed `sizeL` match the bytes received? | No, as before: 2 208 022 listed vs 1 967 336 received; 11 922 199 vs 11 680 272; 21 992 724 vs 21 779 592. Size is not a completion signal. |
