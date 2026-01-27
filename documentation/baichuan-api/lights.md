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

[← Back to Baichuan API](./README.md)
