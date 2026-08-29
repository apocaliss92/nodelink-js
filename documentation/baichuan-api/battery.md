# Battery & Sleep Management

Methods for managing battery cameras and sleep mode.

## Table of Contents

- [Battery Status](#battery-status)
  - [getBatteryStatus](#getbatterystatus)
  - [getBatteryInfo](#getbatteryinfo)
  - [getAllChannelsBatteryInfo](#getallchannelsbatteryinfo)
- [Power Source (Wired vs Battery)](#power-source-wired-vs-battery)
  - [getPowerSource](#getpowersource)
  - [switchPowerSource](#switchpowersource)
  - [probePowerSourceSwitchSupport](#probepowersourceswitchsupport)
  - [Detecting support](#detecting-support)
- [Sleep Management](#sleep-management)
  - [isSleeping](#issleeping)
  - [getSleepState](#getsleepstate)
  - [wakeUp](#wakeup)
  - [probeSleepStatus](#probesleepstatus)

---

## Battery Status

### getBatteryStatus

Gets battery status information.

```typescript
const battery = await api.getBatteryStatus(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<BatteryInfo>`

```typescript
interface BatteryInfo {
  /** Battery percentage (0-100) */
  batteryPercent?: number;
  /** Charge status: "charging", "chargeComplete", "none" */
  chargeStatus?: string;
  /** Adapter status: "solarPanel", etc. */
  adapterStatus?: string;
  /** Low power flag (0/1) */
  lowPower?: number;
  /** Battery voltage (mV) */
  voltage?: number;
  /** Battery current (mA, negative when charging) */
  current?: number;
  /** Battery temperature (°C) */
  temperature?: number;
  /** Battery version */
  batteryVersion?: number;
  /** Whether camera is sleeping */
  sleeping?: boolean;
  /** Channel number */
  channel?: number;
}
```

### Example

```typescript
const battery = await api.getBatteryStatus();
console.log(`Battery: ${battery.batteryPercent}%`);
console.log(`Status: ${battery.chargeStatus}`);

if (battery.lowPower) {
  console.log("⚠️ Low battery warning!");
}

if (battery.chargeStatus === "charging") {
  console.log("🔌 Camera is charging");
  if (battery.adapterStatus === "solarPanel") {
    console.log("☀️ Charging via solar panel");
  }
}
```

---

### getBatteryInfo

Gets detailed battery information.

```typescript
const batteryInfo = await api.getBatteryInfo(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<BatteryInfo>`

---

### getAllChannelsBatteryInfo

Gets battery information for all channels (NVR with battery cameras).

```typescript
const allBatteries = await api.getAllChannelsBatteryInfo(options?: {
  channels?: number[];
});
```

### Parameters

| Parameter          | Type       | Required | Default | Description                |
| ------------------ | ---------- | -------- | ------- | -------------------------- |
| `options.channels` | `number[]` | ❌       | All     | Specific channels to query |

### Returns

`Promise<Map<number, BatteryInfo>>`

### Example

```typescript
const batteries = await api.getAllChannelsBatteryInfo();
for (const [channel, info] of batteries) {
  console.log(
    `Channel ${channel}: ${info.batteryPercent}% (${info.chargeStatus})`,
  );
}

// Find cameras with low battery
const lowBattery = Array.from(batteries).filter(
  ([_, info]) => (info.batteryPercent ?? 100) < 20,
);

for (const [channel, info] of lowBattery) {
  console.log(`⚠️ Channel ${channel} has low battery: ${info.batteryPercent}%`);
}
```

---

## Power Source (Wired vs Battery)

Battery cameras and battery doorbells can be told to run permanently on a
transformer/adapter instead of the battery — what the Reolink app calls
**Wired Power** vs **Battery Power**.

This is **not** the "wired working mode" (Continuous) setting. It is a separate
Baichuan command:

| cmd_id | Message                    | Payload                                               |
| ------ | -------------------------- | ----------------------------------------------------- |
| 805    | `SwitchBatteryAdapterMode` | `<mode>battery\|adapter</mode><dryRun>0\|1</dryRun>` |

The Reolink app reads the power/battery settings *before* offering the switch,
so on firmwares where that read fails while the device is wired, the toggle is
unreachable from the UI. Sending cmd 805 directly bypasses that check.

On an NVR/Hub, address the hub and pass the camera's channel.

---

### getPowerSource

Reads which source the device is currently running on, derived from
`BatteryInfo.adapterStatus`.

```typescript
const source = await api.getPowerSource(channel?: number);
```

### Returns

`Promise<"adapter" | "battery" | undefined>` — `"adapter"` when mains powered,
`"battery"` otherwise (including `solarPanel`, which charges but is not wired
mode), `undefined` when the firmware does not report `adapterStatus`.

---

### switchPowerSource

Switches the device between battery and wired (adapter) power.

```typescript
const result = await api.switchPowerSource(
  mode: "battery" | "adapter",
  options?: { channel?: number; dryRun?: boolean; timeoutMs?: number },
);
```

### Parameters

| Parameter           | Type      | Required | Default | Description                                        |
| ------------------- | --------- | -------- | ------- | -------------------------------------------------- |
| `mode`              | `string`  | YES      | —       | `"adapter"` for wired power, `"battery"` to revert |
| `options.channel`   | `number`  | NO       | `0`     | Channel number (camera channel on an NVR/Hub)      |
| `options.dryRun`    | `boolean` | NO       | `false` | Validate the switch without applying it            |
| `options.timeoutMs` | `number`  | NO       | —       | Request timeout                                    |

### Returns

`Promise<SwitchPowerSourceResult>`

```typescript
interface SwitchPowerSourceResult {
  /** Mode echoed by the device when available, otherwise the requested one. */
  mode: "battery" | "adapter";
  dryRun: boolean;
  /** False when the firmware answered with a non-zero rspCode. */
  accepted: boolean;
  /** Present only when the firmware returned a body with <rspCode>. */
  rspCode?: number;
}
```

> Firmwares observed so far answer **200 with an empty body** on success, so
> `{ accepted: true }` with no `rspCode` is the normal result — it is not a
> sign that nothing happened. Confirm with `getPowerSource()`.

### Example

```typescript
// Doorbell on channel 1 of an NVR: dry-run first, then apply.
const probe = await api.switchPowerSource("adapter", {
  channel: 1,
  dryRun: true,
});

if (probe.accepted) {
  await api.switchPowerSource("adapter", { channel: 1 });
  console.log(await api.getPowerSource(1)); // "adapter"
}

// Back to battery
await api.switchPowerSource("battery", { channel: 1 });
```

> WARNING: only switch to `adapter` when the transformer actually meets the
> device's spec. In wired mode the device stops treating the battery as its
> primary source.

---

### probePowerSourceSwitchSupport

Authoritative support check — sends cmd 805 with `<dryRun>1</dryRun>` and
reports whether the device accepted it. Nothing is applied.

```typescript
const supported = await api.probePowerSourceSwitchSupport(
  mode?: "battery" | "adapter",   // default "adapter"
  options?: { channel?: number; timeoutMs?: number },
);
```

### Returns

`Promise<boolean>` — `false` when the device rejects the command (unsupported
firmwares answer responseCode 400, usually with an empty body).

---

### Detecting support

Two levels, cheap-to-authoritative:

1. **Capability hint** — `getDeviceCapabilities()` exposes
   `hasPowerSourceSwitch`, derived from the `Support` XML (cmd 199):
   `support.items[].battery > 0` **and** `batteryMode & 32`.

   ```typescript
   const { capabilities } = await api.getDeviceCapabilities(channel);
   if (capabilities.hasPowerSourceSwitch) {
     // device advertises the battery/adapter switch
   }
   ```

   The bit was captured on a Reolink Home Hub channel hosting a battery camera
   (`battery=1, batteryMode=32`); every non-switchable battery camera in the
   fixture set reports `batteryMode=0`. Firmwares that never emit `batteryMode`
   fall through as `false` even though they may still accept cmd 805 — the flag
   is deliberately conservative.

2. **Runtime probe** — `probePowerSourceSwitchSupport()`. Use this when the hint
   is `false` but the device is a battery cam/doorbell, or before exposing the
   switch in a UI.

Observed values in the captured fixture set (`test/fixtures/models/`):

| Device                             | `battery` | `batteryMode` | Hint    |
| ---------------------------------- | --------- | ------------- | ------- |
| Reolink Video Doorbell (battery)    | 2         | *not emitted* | `false` → probe |
| Home Hub channel with battery cam   | 1         | 32            | `true`  |
| Argus 3E / Argus PT Ultra           | 2         | 0 / not emitted | `false` |
| Video Doorbell WiFi / PoE (wired)   | 0         | *not emitted* | `false` |

Note the first row: firmware `v3.0.0.5298` on the battery Video Doorbell never
emits `batteryMode`, so the hint is `false` on exactly the device class this
command targets. Always fall back to the dry-run probe for battery doorbells.

Helper for raw `Support` items:

```typescript
import {
  getSupportItemForChannel,
  supportsPowerSourceSwitch,
} from "@apocaliss92/nodelink-js";

const support = await api.getSupportInfo();
supportsPowerSourceSwitch(getSupportItemForChannel(support, 1)); // boolean
```

---

## Sleep Management

Battery cameras enter sleep mode to conserve power. These methods help manage sleep state.

### isSleeping

Checks if the camera is currently sleeping.

```typescript
const sleeping = await api.isSleeping(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<boolean>`

### Example

```typescript
if (await api.isSleeping()) {
  console.log("Camera is sleeping, waking up...");
  await api.wakeUp();
}
```

---

### getSleepState

Gets the sleep state from the camera.

```typescript
const sleepState = await api.getSleepState(channel?: number);
```

### Returns

Sleep state information from the camera.

---

### wakeUp

Wakes up a sleeping battery camera.

```typescript
await api.wakeUp(options?: WakeUpOptions);
```

### Parameters

| Parameter                 | Type      | Required | Default      | Description                   |
| ------------------------- | --------- | -------- | ------------ | ----------------------------- |
| `options.timeoutMs`       | `number`  | ❌       | `20000`      | Timeout per attempt           |
| `options.attempts`        | `number`  | ❌       | `3`          | Number of wake attempts       |
| `options.waitAfterWakeMs` | `number`  | ❌       | `1500`       | Delay after successful wake   |
| `options.backoffMs`       | `number`  | ❌       | `1500`       | Delay between failed attempts |
| `options.reconnect`       | `boolean` | ❌       | `true` (UDP) | Force reconnect on retry      |

### Returns

`Promise<void>`

### Example

```typescript
try {
  await api.wakeUp();
  console.log("Camera is now awake");

  // Perform operations while awake
  const snapshot = await api.getSnapshot();
  const battery = await api.getBatteryStatus();

  console.log(`Snapshot taken, battery at ${battery.batteryPercent}%`);
} catch (error) {
  console.error("Failed to wake camera:", error);
}
```

### Robust Wake-Up

```typescript
async function ensureAwake() {
  const maxAttempts = 5;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await api.wakeUp({
        timeoutMs: 15000,
        attempts: 2,
      });
      return true;
    } catch (error) {
      console.log(`Wake attempt ${i + 1} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return false;
}

if (await ensureAwake()) {
  // Camera is awake
  const snapshot = await api.getSnapshot();
}
```

---

### probeSleepStatus

Probes the sleep status without sending wake commands.

```typescript
const status = await api.probeSleepStatus(options?: {
  channel?: number;
});
```

### Parameters

| Parameter         | Type     | Required | Default | Description    |
| ----------------- | -------- | -------- | ------- | -------------- |
| `options.channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<SleepStatus>`

```typescript
interface SleepStatus {
  state: "awake" | "sleeping" | "unknown";
  reason: string;
  lastRxAtMs?: number;
  idleMs?: number;
}
```

### Example

```typescript
const status = await api.probeSleepStatus();
console.log(`Sleep state: ${status.state}`);
console.log(`Reason: ${status.reason}`);
if (status.idleMs) {
  console.log(`Idle for: ${Math.round(status.idleMs / 1000)}s`);
}
```

---

## Battery Camera Best Practices

### Minimize Operations

```typescript
async function efficientBatteryOperation() {
  // Wake camera once
  await api.wakeUp();

  // Do all operations in a batch
  const [snapshot, battery, events] = await Promise.all([
    api.getSnapshot(),
    api.getBatteryStatus(),
    api.getEvents(),
  ]);

  // Let camera sleep naturally (don't keep polling)
  return { snapshot, battery, events };
}
```

### Monitor Battery Levels

```typescript
async function checkBatteryHealth() {
  const batteries = await api.getAllChannelsBatteryInfo();
  const warnings: string[] = [];

  for (const [channel, info] of batteries) {
    if ((info.batteryPercent ?? 100) < 10) {
      warnings.push(`Channel ${channel}: CRITICAL (${info.batteryPercent}%)`);
    } else if ((info.batteryPercent ?? 100) < 20) {
      warnings.push(`Channel ${channel}: LOW (${info.batteryPercent}%)`);
    }

    if (info.temperature && (info.temperature > 45 || info.temperature < 0)) {
      warnings.push(
        `Channel ${channel}: Temperature warning (${info.temperature}°C)`,
      );
    }
  }

  return warnings;
}
```

### Handle Sleep Events

```typescript
api.on("sleepStatus", (event) => {
  if (event.sleeping) {
    console.log(`Channel ${event.channel} went to sleep`);
  } else {
    console.log(`Channel ${event.channel} woke up`);
  }
});
```

---

[← Back to Baichuan API](./README.md)
