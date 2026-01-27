# Battery & Sleep Management

Methods for managing battery cameras and sleep mode.

## Table of Contents

- [Battery Status](#battery-status)
  - [getBatteryStatus](#getbatterystatus)
  - [getBatteryInfo](#getbatteryinfo)
  - [getAllChannelsBatteryInfo](#getallchannelsbatteryinfo)
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
