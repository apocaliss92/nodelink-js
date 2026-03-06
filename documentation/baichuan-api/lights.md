# Lights & Accessories

Methods for controlling lights, siren, and other camera accessories.

## Table of Contents

- [White LED / Spotlight](#white-led--spotlight)
  - [getWhiteLedState](#getwhiteledstate)
  - [setWhiteLedState](#setwhiteledstate)
- [Floodlight](#floodlight)
  - [getFloodlightOnMotion](#getfloodlightonmotion)
  - [setFloodlightOnMotion](#setfloodlightonmotion)
  - [setFloodlightSettings](#setfloodlightsettings)
  - [probeFloodlightSupportByCmd289](#probefloodlightsupportbycmd289)
- [Siren](#siren)
  - [getSiren](#getsiren)
  - [setSiren](#setsiren)
  - [getSirenOnMotion](#getsirenonmotion)
  - [setSirenOnMotion](#setsirenonmotion)
  - [getSirenStatus](#getsirenstatus)
- [IR LED](#ir-led)
  - [getLedState](#getledstate)
- [Chime / DingDong](#chime--dingdong)
  - [getDingDongList](#getdingdonglist)
  - [getDingDongParams](#getdingdongparams)
  - [setDingDongParams](#setdingdongparams)
  - [ringDingDong](#ringdingdong)
  - [getDingDongCfg](#getdingdongcfg)
  - [setDingDongCfg](#setdingdongcfg)
  - [getHardwiredChime](#gethardwiredchime)
  - [setHardwiredChime](#sethardwiredchime)
  - [quickReplyPlay](#quickreplyplay)

---

## White LED / Spotlight

### getWhiteLedState

Gets the white LED (spotlight) state and configuration.

```typescript
const ledState = await api.getWhiteLedState(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<WhiteLedState>`

```typescript
interface WhiteLedState {
  enabled: boolean;
  brightness?: number; // 0-100
}
```

### Example

```typescript
const ledState = await api.getWhiteLedState();
console.log(`Spotlight: ${ledState.enabled ? "ON" : "OFF"}`);
if (ledState.brightness !== undefined) {
  console.log(`Brightness: ${ledState.brightness}%`);
}
```

---

### setWhiteLedState

Sets the white LED (spotlight) state.

```typescript
await api.setWhiteLedState(enabled: boolean, channel?: number);
// or
await api.setWhiteLedState(channel: number, enabled: boolean);
// or with brightness
await api.setWhiteLedState(config: WhiteLedConfig, channel?: number);
```

### Parameters

| Parameter           | Type      | Required | Default | Description      |
| ------------------- | --------- | -------- | ------- | ---------------- |
| `enabled`           | `boolean` | ✅       | -       | Turn LED on/off  |
| `channel`           | `number`  | ❌       | `0`     | Channel number   |
| `config.enabled`    | `boolean` | ✅       | -       | Turn LED on/off  |
| `config.brightness` | `number`  | ❌       | -       | Brightness 0-100 |

### Returns

`Promise<void>`

### Example

```typescript
// Turn spotlight on
await api.setWhiteLedState(true);

// Turn spotlight off
await api.setWhiteLedState(false);

// Set brightness to 50%
await api.setWhiteLedState({ enabled: true, brightness: 50 });

// Turn off on channel 2
await api.setWhiteLedState(2, false);
```

---

## Floodlight

### getFloodlightOnMotion

Gets the floodlight-on-motion configuration.

```typescript
const config = await api.getFloodlightOnMotion(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<FloodlightTaskState>`

```typescript
interface FloodlightTaskState {
  enabled: boolean;
  // Additional settings vary by model
}
```

---

### setFloodlightOnMotion

Enables/disables floodlight activation on motion.

```typescript
await api.setFloodlightOnMotion(on: boolean, channel?: number);
```

### Parameters

| Parameter | Type      | Required | Default | Description    |
| --------- | --------- | -------- | ------- | -------------- |
| `on`      | `boolean` | ✅       | -       | Enable/disable |
| `channel` | `number`  | ❌       | `0`     | Channel number |

### Returns

`Promise<void>`

### Example

```typescript
// Enable floodlight on motion
await api.setFloodlightOnMotion(true);

// Disable floodlight on motion
await api.setFloodlightOnMotion(false);
```

---

### setFloodlightSettings

Sets detailed floodlight configuration.

```typescript
await api.setFloodlightSettings(settings: FloodlightSettings, channel?: number);
```

### Parameters

| Parameter  | Type                 | Required | Description              |
| ---------- | -------------------- | -------- | ------------------------ |
| `settings` | `FloodlightSettings` | ✅       | Floodlight configuration |
| `channel`  | `number`             | ❌       | Channel number           |

### Returns

`Promise<void>`

---

### probeFloodlightSupportByCmd289

Probes whether the camera supports floodlight control.

```typescript
const supported = await api.probeFloodlightSupportByCmd289(channel?: number);
```

### Returns

`Promise<boolean>`

### Example

```typescript
const hasFloodlight = await api.probeFloodlightSupportByCmd289();
if (hasFloodlight) {
  await api.setFloodlightOnMotion(true);
  console.log("Floodlight enabled on motion");
}
```

---

## Siren

### getSiren

Gets the siren state.

```typescript
const sirenState = await api.getSiren(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<SirenState>`

```typescript
interface SirenState {
  enabled: boolean;
}
```

### Example

```typescript
const siren = await api.getSiren();
console.log(`Siren: ${siren.enabled ? "ACTIVE" : "Off"}`);
```

---

### setSiren

Activates or deactivates the siren.

```typescript
await api.setSiren(enabled: boolean, channel?: number);
// or
await api.setSiren(channel: number, enabled: boolean);
```

### Parameters

| Parameter | Type      | Required | Default | Description               |
| --------- | --------- | -------- | ------- | ------------------------- |
| `enabled` | `boolean` | ✅       | -       | Activate/deactivate siren |
| `channel` | `number`  | ❌       | `0`     | Channel number            |

### Returns

`Promise<void>`

### Example

```typescript
// Activate siren
await api.setSiren(true);

// Wait 5 seconds
await new Promise((r) => setTimeout(r, 5000));

// Deactivate siren
await api.setSiren(false);
```

### Siren with Timeout

```typescript
async function activateSirenWithTimeout(durationMs: number) {
  await api.setSiren(true);
  await new Promise((r) => setTimeout(r, durationMs));
  await api.setSiren(false);
}

// Sound siren for 3 seconds
await activateSirenWithTimeout(3000);
```

---

### getSirenOnMotion

Gets the siren-on-motion configuration.

```typescript
const config = await api.getSirenOnMotion(channel?: number);
```

### Returns

Configuration for automatic siren activation on motion.

---

### setSirenOnMotion

Sets siren-on-motion configuration.

```typescript
await api.setSirenOnMotion(config: SirenOnMotionConfig, channel?: number);
```

### Parameters

| Parameter | Type                  | Required | Description                   |
| --------- | --------------------- | -------- | ----------------------------- |
| `config`  | `SirenOnMotionConfig` | ✅       | Siren-on-motion configuration |
| `channel` | `number`              | ❌       | Channel number                |

### Returns

`Promise<void>`

---

### getSirenStatus

Gets detailed siren status information.

```typescript
const status = await api.getSirenStatus(options?: {
  channel?: number;
  timeoutMs?: number;
});
```

### Returns

Detailed siren status including current state and configuration.

---

## IR LED

### getLedState

Gets the IR LED state and configuration.

```typescript
const ledState = await api.getLedState(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

IR LED configuration including mode (auto/on/off).

---

## Complete Lighting Example

```typescript
async function setupNightLighting() {
  // Check floodlight support
  const hasFloodlight = await api.probeFloodlightSupportByCmd289();

  if (hasFloodlight) {
    // Enable floodlight on motion
    await api.setFloodlightOnMotion(true);
    console.log("Floodlight will activate on motion");
  }

  // Set spotlight brightness
  await api.setWhiteLedState({
    enabled: false, // Off by default
    brightness: 75, // 75% when activated
  });

  console.log("Night lighting configured");
}

async function alertMode() {
  console.log("Entering alert mode...");

  // Turn on spotlight
  await api.setWhiteLedState(true);

  // Sound siren for 3 seconds
  await api.setSiren(true);
  await new Promise((r) => setTimeout(r, 3000));
  await api.setSiren(false);

  // Keep spotlight on for 30 seconds
  await new Promise((r) => setTimeout(r, 30000));
  await api.setWhiteLedState(false);

  console.log("Alert mode ended");
}

// Event-triggered alert
api.on("aiAlarm", async (event) => {
  if (event.type === "person" && event.state) {
    await alertMode();
  }
});
```

---

## Chime / DingDong

Methods for controlling doorbells' paired wireless chimes (DingDong) and the hardwired built-in chime.

### getDingDongList

Gets the list of wireless chime devices paired to the doorbell.

```typescript
const chimes = await api.getDingDongList(channel?: number);
```

#### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

#### Returns

`Promise<ChimeDevice[]>`

```typescript
interface ChimeDevice {
  id: number;
  name: string;
  netState: number; // 0 = offline, 1 = online
}
```

#### Example

```typescript
const chimes = await api.getDingDongList();
for (const chime of chimes) {
  console.log(`Chime ${chime.id}: ${chime.name} (${chime.netState === 1 ? "online" : "offline"})`);
}
```

---

### getDingDongParams

Gets the parameters of a specific paired wireless chime.

```typescript
const params = await api.getDingDongParams(chimeId: number, channel?: number);
```

#### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `chimeId` | `number` | ✅       | -       | Chime device ID |
| `channel` | `number` | ❌       | `0`     | Channel number |

#### Returns

`Promise<ChimeParams>`

```typescript
interface ChimeParams {
  name?: string;
  volLevel?: number;
  ledState?: number;
}
```

---

### setDingDongParams

Sets parameters (name, volume level, LED state) of a paired wireless chime.

```typescript
await api.setDingDongParams(chimeId: number, params: ChimeParams, channel?: number);
```

#### Parameters

| Parameter          | Type     | Required | Description              |
| ------------------ | -------- | -------- | ------------------------ |
| `chimeId`          | `number` | ✅       | Chime device ID          |
| `params.name`      | `string` | ❌       | Chime display name       |
| `params.volLevel`  | `number` | ❌       | Volume level             |
| `params.ledState`  | `number` | ❌       | LED state                |
| `channel`          | `number` | ❌       | Channel number (default 0) |

#### Returns

`Promise<void>`

#### Example

```typescript
await api.setDingDongParams(1, { volLevel: 3, ledState: 1 });
```

---

### ringDingDong

Rings a paired wireless chime with the specified ringtone.

```typescript
await api.ringDingDong(chimeId: number, musicId: number, channel?: number);
```

#### Parameters

| Parameter | Type     | Required | Default | Description       |
| --------- | -------- | -------- | ------- | ----------------- |
| `chimeId` | `number` | ✅       | -       | Chime device ID   |
| `musicId` | `number` | ✅       | -       | Ringtone ID       |
| `channel` | `number` | ❌       | `0`     | Channel number    |

#### Returns

`Promise<void>`

#### Example

```typescript
// Ring chime #1 with ringtone #0
await api.ringDingDong(1, 0);
```

---

### getDingDongCfg

Gets the alarm-event ringtone configuration for paired wireless chimes.

```typescript
const cfg = await api.getDingDongCfg(channel?: number);
```

#### Returns

`Promise<ChimeCfg[]>`

```typescript
interface ChimeAlarmCfg {
  valid: number;
  musicId: number;
}
interface ChimeCfg {
  id: number;
  type: Record<string, ChimeAlarmCfg>; // keyed by event type (e.g. "people", "visitor")
}
```

---

### setDingDongCfg

Sets the ringtone to play for a specific alarm event on a paired wireless chime.

```typescript
await api.setDingDongCfg(chimeId: number, eventType: string, state: number, musicId: number, channel?: number);
```

#### Parameters

| Parameter   | Type     | Required | Description                                       |
| ----------- | -------- | -------- | ------------------------------------------------- |
| `chimeId`   | `number` | ✅       | Chime device ID                                   |
| `eventType` | `string` | ✅       | Event type (e.g. `"people"`, `"vehicle"`, `"visitor"`) |
| `state`     | `number` | ✅       | Enable state (`1` = enabled, `0` = disabled)      |
| `musicId`   | `number` | ✅       | Ringtone ID to play for this event                |
| `channel`   | `number` | ❌       | Channel number (default 0)                        |

#### Returns

`Promise<void>`

#### Example

```typescript
// Play ringtone #2 when a person is detected
await api.setDingDongCfg(1, "people", 1, 2);
```

---

### getHardwiredChime

Gets the state of the hardwired (built-in) chime on the doorbell.

```typescript
const state = await api.getHardwiredChime(channel?: number);
```

#### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

#### Returns

`Promise<HardwiredChimeState>`

```typescript
interface HardwiredChimeState {
  type: string;    // e.g. "dingdong", "single", "dual"
  enabled: boolean;
  time: number;    // Duration/timing value
}
```

#### Example

```typescript
const chime = await api.getHardwiredChime();
console.log(`Hardwired chime: ${chime.enabled ? "enabled" : "disabled"} (type: ${chime.type})`);
```

---

### setHardwiredChime

Enables or disables the hardwired (built-in) chime on the doorbell. Optionally sets the chime type and timing.

```typescript
const state = await api.setHardwiredChime(params: { enabled: boolean; type?: string; time?: number }, channel?: number);
```

#### Parameters

| Parameter        | Type      | Required | Description                                     |
| ---------------- | --------- | -------- | ----------------------------------------------- |
| `params.enabled` | `boolean` | ✅       | Enable or disable the chime                     |
| `params.type`    | `string`  | ❌       | Chime type (e.g. `"dingdong"`, `"single"`, `"dual"`) |
| `params.time`    | `number`  | ❌       | Chime duration/timing value                     |
| `channel`        | `number`  | ❌       | Channel number (default 0)                      |

#### Returns

`Promise<HardwiredChimeState>` — the updated state as reported by the device.

#### Example

```typescript
// Mute the hardwired chime
await api.setHardwiredChime({ enabled: false });

// Re-enable with specific type
await api.setHardwiredChime({ enabled: true, type: "dingdong" });
```

---

### quickReplyPlay

Plays a quick reply audio file on the doorbell speaker.

```typescript
await api.quickReplyPlay(fileId: number, channel?: number);
```

#### Parameters

| Parameter | Type     | Required | Default | Description           |
| --------- | -------- | -------- | ------- | --------------------- |
| `fileId`  | `number` | ✅       | -       | Quick reply file ID   |
| `channel` | `number` | ❌       | `0`     | Channel number        |

#### Returns

`Promise<void>`

#### Example

```typescript
// Play quick reply message #0
await api.quickReplyPlay(0);
```

---

[← Back to Baichuan API](./README.md)
