# API Gap Analysis: ReolinkBaichuanApi vs Scrypted Requirements

This document analyzes the gap between:
1. **Scrypted requirements** (`reolink-api.ts` - HTTP APIs used)
2. **Currently implemented Baichuan APIs** in this library
3. **Available Baichuan APIs** in `reolink_aio` reference implementation

## Summary

| Category | HTTP API (Scrypted) | Baichuan Status | Priority |
|----------|-------------------|-----------------|----------|
| **PTZ** | ✅ `getPtzPresets()`, `ptz()` | ❌ **MISSING** | 🔴 **HIGH** |
| **Siren/Audio Alarm** | ✅ `getSiren()`, `setSiren()` | ⚠️ Partial (needs AudioAlarmPlay) | 🟡 **MEDIUM** |
| **White LED** | ✅ `getWhiteLedState()`, `setWhiteLedState()` | ❌ **MISSING** | 🟡 **MEDIUM** |
| **Battery Info** | ✅ `getBatteryInfo()` | ❌ **MISSING** | 🟡 **MEDIUM** |
| **PIR** | ✅ `getPirState()`, `setPirState()` | ❌ **MISSING** | 🟡 **MEDIUM** |
| **Network/WiFi** | ✅ `getLocalLink()`, `getNetData()` | ⚠️ Partial (getGeneralXml exists) | 🟢 **LOW** |
| **Ability/Device Capabilities** | ✅ `getAbility()` | ❌ **MISSING** | 🟢 **LOW** |
| **Motion Detection Settings** | ✅ `getMotionState()` | ⚠️ Get only (SetMdAlarm missing) | 🟢 **LOW** |
| **AI Detection Settings** | ✅ `getAiState()` | ⚠️ Get only (SetAiAlarm missing) | 🟢 **LOW** |

---

## Detailed API Comparison

### ✅ Already Implemented

| HTTP API | Baichuan Equivalent | Status | Notes |
|----------|-------------------|--------|-------|
| `reboot()` | `reboot()` (cmd_id 23) | ✅ Done | |
| `getMotionState()` | `getMotionState()` (cmd_id 46) | ✅ Done | Get only |
| `getOsd()` | `getOsd()` (cmd_id 26) | ✅ Done | |
| `setOsd()` | `setOsd()` (cmd_id 25) | ✅ Done | |
| `getAiState()` | `getAiState()` (cmd_id 342) | ✅ Done | Get only |
| `jpegSnapshot()` | `getSnapshot()` (cmd_id 109) | ✅ Done | |
| `getEncoderConfiguration()` | `getStreamMetadata()` (cmd_id 56) | ✅ Done | |
| `getDeviceInfo()` | `getInfo()` (cmd_id 80/318) | ✅ Done | |
| `getNetData()` | `getPorts()` (cmd_id 37) | ✅ Done | |
| `setNetData()` | `setPortEnabled()` (cmd_id 36) | ✅ Done | |
| `getEvents()` | `subscribeEvents()` (cmd_id 31) | ✅ Done | Push events via subscription |

---

### ❌ Missing High Priority APIs

#### 1. PTZ Control (`getPtzPresets()`, `ptz()`)

**Scrypted Requirements:**
```typescript
async getPtzPresets(): Promise<PtzPreset[]>
async ptz(command: PanTiltZoomCommand)
```

**Reference Implementation (reolink_aio):**
- `GetPtzPreset`: cmd_id 190 (from neolink MSG_ID_GET_PTZ_PRESET)
- `PtzCtrl`: cmd_id 18 (from neolink MSG_ID_PTZ_CONTROL)
- `PtzCtrl` (preset): cmd_id 19 (from neolink MSG_ID_PTZ_CONTROL_PRESET)

**Neolink Reference:**
- `MSG_ID_PTZ_CONTROL` = 18 (pan/tilt/zoom control)
- `MSG_ID_PTZ_CONTROL_PRESET` = 19 (set/move to preset)
- `MSG_ID_GET_PTZ_PRESET` = 190 (get preset list)
- `MSG_ID_GET_ZOOM_FOCUS` = 294 (get zoom info)
- `MSG_ID_SET_ZOOM_FOCUS` = 295 (set zoom)
- `get_ptz_position`: cmd_id 433 (from reolink_aio line 2098)

**Implementation Notes:**
- PTZ control uses class 0x6414 (BC_CLASS_MODERN_24)
- Commands: "up", "down", "left", "right", "stop", "toPos", "setPos"
- Preset commands: "toPos" (move to), "setPos" (save current position)

**Action Required:**
1. Identify cmd_id for PTZ preset retrieval
2. Identify cmd_id for PTZ control (pan/tilt/zoom)
3. Implement XML parsing for preset list
4. Implement PTZ command sending with proper XML structure

---

#### 2. Siren/Audio Alarm (`getSiren()`, `setSiren()`)

**Scrypted Requirements:**
```typescript
async getSiren(): Promise<{enabled: boolean}>
async setSiren(on: boolean, duration?: number): Promise<SirenResponse>
```

**Reference Implementation (reolink_aio):**
- `GetAudioAlarmV20`: cmd_id 547 (from `_parse_xml` line 864)
- `AudioAlarmPlay`: cmd_id 486 (estimated, needs verification)
- `AudioAlarmPlay` with `alarm_mode: "times" | "manul"`

**Action Required:**
1. Implement `getAudioAlarm(channel)` using cmd_id 547
2. Implement `setAudioAlarm(channel, params)` with alarm_mode support
3. Parse XML response for enabled state

**Implementation Notes:**
```python
# From reolink_aio baichuan.py line 2491
async def AudioAlarmPlay(self, channel: int | None = None, alarm_mode: str = "times", **kwargs) -> None:
    # alarm_mode: "times" or "manul"
    # For "times": times parameter specifies duration
    # For "manul": manual_switch parameter (1/0)
```

---

#### 3. White LED Control (`getWhiteLedState()`, `setWhiteLedState()`)

**Scrypted Requirements:**
```typescript
async getWhiteLedState(): Promise<{enabled: boolean}>
async setWhiteLedState(on?: boolean, brightness?: number): Promise<void>
```

**Reference Implementation (reolink_aio):**
- `GetWhiteLed`: cmd_id needs identification (likely 289/291 based on floodlight)
- `SetWhiteLed`: cmd_id needs identification

**Action Required:**
1. Identify cmd_id for GetWhiteLed
2. Identify cmd_id for SetWhiteLed
3. Parse XML for state and brightness
4. Build XML for setting state/brightness

**Note:** May be related to floodlight APIs (cmd_id 289, 291, 438 in reolink_aio).

---

#### 4. Battery Info (`getBatteryInfo()`)

**Scrypted Requirements:**
```typescript
async getBatteryInfo(): Promise<{
  batteryPercent?: number;
  sleeping?: boolean;
}>
```

**Reference Implementation (reolink_aio):**
- `GetBatteryInfo`: cmd_id 252 (from `_parse_xml` line 799)
- `GetChannelstatus`: cmd_id 145 (sleep status, line 764)

**Action Required:**
1. Implement `getBatteryInfo(channel)` using cmd_id 252
2. Parse XML for batteryPercent and chargeStatus
3. Optionally integrate with GetChannelstatus for sleep status

**Implementation Notes:**
```python
# From reolink_aio baichuan.py line 799
elif cmd_id == 252:  # BatteryInfo
    # Parse batteryPercent and chargeStatus
    # chargeStatus: 0=charging, 1=discharging, 2=full
```

---

#### 5. PIR State (`getPirState()`, `setPirState()`)

**Scrypted Requirements:**
```typescript
async getPirState(): Promise<{enabled: boolean, state?: any}>
async setPirState(on: boolean): Promise<void>
```

**Reference Implementation (reolink_aio):**
- `GetPirInfo`: cmd_id 212 (MSG_ID_GET_PIR_ALARM from neolink)
- `SetPirInfo`: cmd_id 213 (MSG_ID_START_PIR_ALARM from neolink)

**Action Required:**
1. Implement `getPirInfo(channel)` using cmd_id 209
2. Implement `setPirInfo(channel, params)` 
3. Parse XML for enable state and interval settings

---

### ⚠️ Partially Implemented APIs

#### Network/WiFi Info

**Scrypted Requirements:**
```typescript
async getLocalLink(): Promise<{
  activeLink?: string;
  wifiSignal?: number;
  isWifi: boolean;
}>
```

**Current Implementation:**
- `getGeneralXml(channel?)` exists (cmd_id 104) but needs parsing

**Reference Implementation (reolink_aio):**
- `GetLocalLink`: cmd_id 464 (from `_parse_xml` line 852)
- `GetWifiSignal`: cmd_id 115 (estimated)

**Action Required:**
1. Parse `getGeneralXml()` response for LocalLink data
2. Or implement dedicated `getLocalLink()` using cmd_id 464
3. Implement `getWifiSignal(channel)` using cmd_id 115

---

#### Motion Detection Settings

**Current Implementation:**
- `getMotionState(channel)` - Get only ✅

**Missing:**
- `setMotionDetection(channel, enabled, sensitivity?)` - Set motion detection

**Reference Implementation (reolink_aio):**
- `SetMdAlarm`: cmd_id 47 (verified line 2145)

**Action Required:**
1. Implement `setMotionDetection()` using SetMdAlarm cmd_id
2. Build XML with enable and sensitivity parameters

---

#### AI Detection Settings

**Current Implementation:**
- `getAiState(channel)` - Get only ✅

**Missing:**
- `setAiDetection(channel, aiType, enabled, sensitivity?)` - Set AI detection

**Reference Implementation (reolink_aio):**
- `SetAiAlarm`: cmd_id 343 (verified line 2177)

**Action Required:**
1. Implement `setAiDetection()` using SetAiAlarm cmd_id
2. Build XML with ai_type, enable, and sensitivity parameters

---

### 🟢 Low Priority / Nice to Have

#### Ability/Device Capabilities

**Scrypted Requirements:**
```typescript
async getAbility(): Promise<any>
```

**Reference Implementation (reolink_aio):**
- `_get_ability_info()`: cmd_id 151 (line 1588)
- Returns comprehensive device capability information

**Action Required:**
1. Implement `getAbilityInfo()` using cmd_id 151
2. Parse complex XML structure with nested capability data

---

#### Additional APIs Available in reolink_aio

These APIs exist in `reolink_aio` but are not currently required by Scrypted:

- `GetMask` / `SetMask` (cmd_id 27/28) - Privacy masks
- `GetAudioCfg` / `SetAudioCfg` (cmd_id 212/213) - Audio configuration
- `GetAudioNoise` / `SetAudioNoise` (cmd_id 439/440) - Audio noise reduction
- `GetDingDongList` / `GetDingDongCfg` / `SetDingDongCfg` (cmd_id 487/488/489) - Doorbell chimes
- `QuickReplyPlay` (cmd_id 486) - Quick reply audio
- `GetRec` / `SetRecV20` (cmd_id 80/81) - Recording configuration
- `GetEmail` / `SetEmail` (cmd_id 35/36) - Email settings
- `GetPush` / `SetPush` (cmd_id 38/39) - Push notification settings
- `GetAutoFocus` / `SetAutoFocus` (cmd_id 79/80) - Autofocus control

---

## Implementation Priority Recommendation

### Phase 1: Critical for Scrypted Integration (HIGH)
1. ✅ **PTZ Control** - `getPtzPresets()`, `ptz()`
2. ✅ **Siren/Audio Alarm** - `getSiren()`, `setSiren()`
3. ✅ **White LED** - `getWhiteLedState()`, `setWhiteLedState()`

### Phase 2: Important Features (MEDIUM)
4. ✅ **Battery Info** - `getBatteryInfo()`
5. ✅ **PIR State** - `getPirState()`, `setPirState()`

### Phase 3: Enhancement (LOW)
6. ⚠️ **Network/WiFi** - Complete `getLocalLink()` parsing
7. ⚠️ **Motion Detection Settings** - Add `setMotionDetection()`
8. ⚠️ **AI Detection Settings** - Add `setAiDetection()`
9. ⚠️ **Ability Info** - Implement `getAbilityInfo()`

---

## Command ID Reference Table

| API | cmd_id | Reference | Status |
|-----|--------|-----------|--------|
| Login | 1 | reolink_aio | ✅ Done |
| Logout | 2 | reolink_aio | ✅ Done |
| Video Stream | 3 | neolink | ✅ Done |
| Reboot | 23 | reolink_aio | ✅ Done |
| GetImage (OSD) | 26 | reolink_aio | ✅ Done |
| SetImage (OSD) | 25 | reolink_aio | ✅ Done |
| GetNetPort | 37 | reolink_aio | ✅ Done |
| SetNetPort | 36 | reolink_aio | ✅ Done |
| GetMdAlarm (Motion) | 46 | reolink_aio | ✅ Done (get only) |
| SetMdAlarm | 47 | reolink_aio | ❌ Missing |
| Subscribe Events | 31 | reolink_aio | ✅ Done |
| Event Push | 33 | reolink_aio | ✅ Done |
| GetEnc | 56 | reolink_aio | ✅ Done |
| SetEnc | 57 | reolink_aio | ✅ Done |
| Ping/Keepalive | 93 | reolink_aio | ✅ Done |
| GetDevInfo | 80 (host), 318 (channel) | reolink_aio | ✅ Done |
| GetGeneral (LocalLink) | 104 | reolink_aio | ✅ Done (needs parsing) |
| SetGeneral | 105 | reolink_aio | ✅ Done |
| Snapshot | 109 | reolink_aio | ✅ Done |
| GetWifiSignal | 115 | reolink_aio | ❌ Missing |
| GetAbility | 151 | reolink_aio | ❌ Missing |
| GetPtzPreset | 190 | neolink | ❌ Missing |
| PtzCtrl | 18 | neolink | ❌ Missing |
| PtzCtrl Preset | 19 | neolink | ❌ Missing |
| GetPtzPosition | 433 | reolink_aio | ❌ Missing |
| GetAiAlarm | 342 | reolink_aio | ✅ Done (get only) |
| SetAiAlarm | 343 | reolink_aio | ❌ Missing |
| GetLocalLink | 464 | reolink_aio | ❌ Missing |
| GetAudioAlarm | 547 | reolink_aio | ❌ Missing |
| AudioAlarmPlay | 486? | reolink_aio | ❌ Missing |
| GetBatteryInfo | 252 | reolink_aio | ❌ Missing |
| GetPirInfo | 212 | neolink (MSG_ID_GET_PIR_ALARM) | ❌ Missing |
| SetPirInfo | 213 | neolink (MSG_ID_START_PIR_ALARM) | ❌ Missing |
| GetWhiteLed | 289/291? | reolink_aio | ❌ Missing |
| SetWhiteLed | ? | reolink_aio | ❌ Missing |

---

## Next Steps

1. ✅ **PTZ cmd_ids identified** - Verified from neolink model.rs:
   - cmd_id 18: PTZ control (pan/tilt/zoom)
   - cmd_id 19: PTZ preset control (set/move to)
   - cmd_id 190: Get PTZ preset list
   - cmd_id 433: Get PTZ position (from reolink_aio)
2. ✅ **SetMdAlarm cmd_id verified** - cmd_id 47 (from reolink_aio line 2145)
3. ✅ **SetAiAlarm cmd_id verified** - cmd_id 343 (from reolink_aio line 2177)
4. ✅ **PIR cmd_ids verified** - cmd_id 212 (Get), 213 (Set) from neolink
5. **Verify AudioAlarm cmd_ids** - Still need to confirm cmd_id 547 (GetAudioAlarm) and cmd_id for AudioAlarmPlay
6. **Verify WhiteLED cmd_ids** - May be related to floodlight (cmd_id 289/291/438)
7. **Create test implementations** for each missing API
8. **Update types** in `src/reolink/baichuan/types.ts` as needed
9. **Add unit tests** for each new API method

---

## References

- **reolink_aio**: `_refs/reolink_aio/reolink_aio/baichuan/baichuan.py`
- **neolink**: `_refs/neolink/crates/core/src/bc_protocol/`
- **Scrypted API**: `/Users/gianlucaruocco/Documents/Git/scrypted/plugins/reolink/src/reolink-api.ts`
- **Current Implementation**: `src/reolink/baichuan/ReolinkBaichuanApi.ts`

