# Time, NTP, DST & Auto-Reboot

Methods for clock, time zone, date format, NTP synchronisation, Daylight Saving Time and the auto-reboot scheduler.

## Table of Contents

- [NTP (cmd_id 38 / 39)](#ntp-cmd_id-38--39)
- [SystemGeneral (cmd_id 104 / 105)](#systemgeneral-cmd_id-104--105)
- [DST (cmd_id 106 / 107)](#dst-cmd_id-106--107)
- [Auto-Reboot (cmd_id 101 / 100)](#auto-reboot-cmd_id-101--100)

---

## NTP (cmd_id 38 / 39)

The `<Ntp>` block carries the NTP server config used by the camera.

### getNtp

```ts
const ntp = await api.getNtp();
// {
//   enable: 1,
//   server: "pool.ntp.org",
//   synchronizeInterval: 1440, // minutes (24h)
//   port: 123,
// }
```

### setNtp

```ts
await api.setNtp({ server: "time.google.com", synchronizeInterval: 720 });
```

Partial patch — the library does a **read-modify-write** because Reolink rejects partial `<Ntp>` blocks.

| Field | Type | Notes |
| --- | --- | --- |
| `enable` | `0 \| 1` | NTP sync on/off |
| `server` | string | Hostname or IP |
| `synchronizeInterval` | number | **Minutes** between syncs |
| `port` | number | UDP port (default 123) |

---

## SystemGeneral (cmd_id 104 / 105)

The `<SystemGeneral>` block carries time zone, manual clock, OSD date format, device name, language and login-lock policy. SET (cmd_id 105) accepts **partial** payloads with a few special signals:

- `<year>0</year>` **must** be present when you don't want to set the manual clock. Without it, some firmwares interpret missing year as "set to 0" and the clock breaks.
- `<deviceName>` alone must be accompanied by `<deviceNameOnly>1</deviceNameOnly>`.
- Manual clock set sends all six date components (year/month/day/hour/minute/second) and omits the `year=0` marker.

The library's `setSystemGeneral` builder handles all three shapes automatically — you just pass the patch.

### getSystemGeneral

```ts
const sys = await api.getSystemGeneral();
// {
//   timeZone: -3600,          // seconds, POSIX (UTC+1 → -3600)
//   osdFormat: "DMY",         // "DMY" | "MDY" | "YMD"
//   year: 2026, month: 5, day: 16,
//   hour: 21, minute: 19, second: 50,
//   deviceId: 0,
//   timeFormat: 0,            // 0=24h, 1=12h
//   language: "English",
//   deviceName: "Living Room",
//   loginLock: 0,
//   lockTime: 300,
//   allowedTimes: 10,
//   isDst: 1,
// }
```

### setSystemGeneral

```ts
// Change timezone only
await api.setSystemGeneral({ timeZone: -7200 });

// Change OSD date format
await api.setSystemGeneral({ osdFormat: "YMD", timeFormat: 0 });

// Rename camera (uses deviceNameOnly=1 path)
await api.setSystemGeneral({ deviceName: "Front Porch" });

// Set the clock manually (NTP must be disabled first)
await api.setSystemGeneral({
  manualTime: { year: 2026, month: 5, day: 16, hour: 22, minute: 0, second: 0 },
  timeZone: -3600,
});
```

| Field | Type | Notes |
| --- | --- | --- |
| `timeZone` | number (seconds, POSIX) | UTC+1 → `-3600`, UTC-5 → `18000` |
| `osdFormat` | `"DMY" \| "MDY" \| "YMD"` | OSD date layout |
| `timeFormat` | `0 \| 1` | `0` = 24h, `1` = 12h |
| `language` | string | e.g. `"English"`, `"Italian"` (camera-dependent) |
| `deviceName` | string | Shown in app + cmd_id 104 |
| `loginLock` | `0 \| 1` | Whether failed logins lock the camera |
| `lockTime` | number (seconds) | Lockout duration |
| `allowedTimes` | number | Failed attempts before lockout |
| `manualTime` | `{year,month,day,hour,minute,second}` | Explicit clock set |

---

## DST (cmd_id 106 / 107)

Daylight Saving Time has its own block (`<Dst>`). The Reolink Client wires this to the timezone selector — picking a TZ with DST automatically pushes a SetDst.

### getDst

```ts
const dst = await api.getDst();
// {
//   enable: 1, offset: 1,
//   startMonth: 3, startWeekIndex: 5, startWeekday: "Sunday",
//   startHour: 2, startMinute: 0, startSecond: 0,
//   endMonth: 10, endWeekIndex: 4, endWeekday: "Sunday",
//   endHour: 3, endMinute: 0, endSecond: 0,
// }
```

### setDst

```ts
await api.setDst({ enable: 0 });                  // disable DST
await api.setDst({ enable: 1, offset: 1,
  startMonth: 3, startWeekIndex: 5, startWeekday: "Sunday",
  endMonth: 10, endWeekIndex: 4, endWeekday: "Sunday" });
```

| Field | Type | Notes |
| --- | --- | --- |
| `enable` | `0 \| 1` | Master DST switch |
| `offset` | number | DST offset in hours (usually `1`) |
| `startMonth` / `endMonth` | 1..12 | Month index |
| `startWeekIndex` / `endWeekIndex` | 1..5 | Week-of-month; `5` = last week |
| `startWeekday` / `endWeekday` | `"Sunday".."Saturday"` | |
| `startHour` / `endHour` | 0..23 | Switch hour (local time) |

Partial patch with read-modify-write.

---

## Auto-Reboot (cmd_id 101 / 100)

Scheduled reboot — useful for keeping memory clean on cameras that develop slow leaks.

### getAutoReboot

```ts
const ab = await api.getAutoReboot();
// { enable: 1, weekDay: "Sunday", hour: 10, minute: 0, second: 0 }
```

### setAutoReboot

```ts
await api.setAutoReboot({ enable: 1, weekDay: "everyday", hour: 4 });
```

| Field | Type | Notes |
| --- | --- | --- |
| `enable` | `0 \| 1` | |
| `weekDay` | `"Sunday".."Saturday" \| "everyday"` | |
| `hour` | 0..23 | |
| `minute` | 0..59 | |
| `second` | 0..59 | |
