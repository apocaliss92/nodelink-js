# Detection Settings

Methods for configuring motion detection, AI detection, and alarm settings.

## Table of Contents

- [Motion Detection](#motion-detection)
  - [getMotionState](#getmotionstate)
  - [getMotionAlarm](#getmotionalarm)
  - [setMotionAlarm](#setmotionalarm)
  - [setMotionDetection](#setmotiondetection)
- [AI Detection](#ai-detection)
  - [getAiState](#getaistate)
  - [getAiAlarm](#getaialarm)
  - [setAiDetection](#setaidetection)
  - [getAiDetectTypes](#getaidetecttypes)
  - [getAiCfg](#getaicfg)
- [PIR Sensor](#pir-sensor)
  - [getPirInfo](#getpirinfo)
  - [setPirInfo](#setpirinfo)
- [Autotracking](#autotracking)
  - [getAutotracking](#getautotracking)
  - [setAutotracking](#setautotracking)
  - [setAutotrackingSettings](#setautotrackingsettings)
  - [probeAutotrackingSupport](#probeautotrackingsupport)

---

## Motion Detection

### getMotionState

Gets the current motion detection state (whether motion is currently detected).

```typescript
const isMotion = await api.getMotionState(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<boolean>` - `true` if motion is currently detected

### Example

```typescript
const motionActive = await api.getMotionState();
console.log(`Motion active: ${motionActive}`);
```

---

### getMotionAlarm

Gets motion alarm configuration.

```typescript
const config = await api.getMotionAlarm(channel?: number);
```

### Returns

`Promise<MotionAlarmConfig>`

---

### setMotionAlarm

Sets motion alarm configuration.

```typescript
await api.setMotionAlarm(config: MotionAlarmConfig, channel?: number);
// or
await api.setMotionAlarm(channel: number, config: MotionAlarmConfig);
```

### Parameters

| Parameter | Type                | Required | Description                |
| --------- | ------------------- | -------- | -------------------------- |
| `channel` | `number`            | ❌       | Channel number             |
| `config`  | `MotionAlarmConfig` | ✅       | Motion alarm configuration |

### Returns

`Promise<void>`

---

### setMotionDetection

Enables or disables motion detection.

```typescript
await api.setMotionDetection(enabled: boolean, channel?: number);
// or
await api.setMotionDetection(channel: number, enabled: boolean);
```

### Parameters

| Parameter | Type      | Required | Default | Description                     |
| --------- | --------- | -------- | ------- | ------------------------------- |
| `enabled` | `boolean` | ✅       | -       | Enable/disable motion detection |
| `channel` | `number`  | ❌       | `0`     | Channel number                  |

### Returns

`Promise<void>`

### Example

```typescript
// Enable motion detection
await api.setMotionDetection(true);

// Disable motion detection on channel 2
await api.setMotionDetection(2, false);
```

---

## AI Detection

### getAiState

Gets the current AI detection state.

```typescript
const aiState = await api.getAiState(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<AIState>`

```typescript
interface AIState {
  channel: number;
  alarm_state?: number;
  support?: number;
  dog_cat?: { alarm_state: number; support: number };
  face?: { alarm_state: number; support: number };
  people?: { alarm_state: number; support: number };
  vehicle?: { alarm_state: number; support: number };
  package?: { alarm_state: number; support: number };
}
```

### Example

```typescript
const aiState = await api.getAiState();
console.log(
  "Person detection:",
  aiState.people?.alarm_state ? "Active" : "Inactive",
);
console.log(
  "Vehicle detection:",
  aiState.vehicle?.alarm_state ? "Active" : "Inactive",
);
```

---

### getAiAlarm

Gets AI alarm configuration.

```typescript
const aiAlarm = await api.getAiAlarm(channel?: number);
```

### Returns

`Promise<AIState>`

---

### setAiDetection

Enables or disables specific AI detection types.

```typescript
await api.setAiDetection(type: AiDetectionType, enabled: boolean, channel?: number);
// or
await api.setAiDetection(channel: number, type: AiDetectionType, enabled: boolean);
```

### Parameters

| Parameter | Type              | Required | Default | Description       |
| --------- | ----------------- | -------- | ------- | ----------------- |
| `type`    | `AiDetectionType` | ✅       | -       | AI detection type |
| `enabled` | `boolean`         | ✅       | -       | Enable/disable    |
| `channel` | `number`          | ❌       | `0`     | Channel number    |

### AI Detection Types

| Type        | Description       |
| ----------- | ----------------- |
| `"people"`  | Person detection  |
| `"vehicle"` | Vehicle detection |
| `"dog_cat"` | Pet detection     |
| `"face"`    | Face detection    |
| `"package"` | Package detection |

### Returns

`Promise<void>`

### Example

```typescript
// Enable person detection
await api.setAiDetection("people", true);

// Disable pet detection
await api.setAiDetection("dog_cat", false);

// Enable vehicle detection on channel 1
await api.setAiDetection(1, "vehicle", true);
```

---

### getAiDetectTypes

Gets supported AI detection types for the camera.

```typescript
const types = await api.getAiDetectTypes(channel?: number);
```

### Returns

`Promise<AiDetectionType[]>` - Array of supported detection types

### Example

```typescript
const supportedTypes = await api.getAiDetectTypes();
console.log("Supported AI types:", supportedTypes);
// ["people", "vehicle", "dog_cat"]
```

---

### getAiCfg

Gets AI configuration details.

```typescript
const aiCfg = await api.getAiCfg(channel?: number);
```

### Returns

`Promise<AiConfig>`

---

## PIR Sensor

### getPirInfo

Gets PIR (Passive Infrared) sensor configuration.

```typescript
const pirInfo = await api.getPirInfo(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<PirState>`

```typescript
interface PirState {
  enabled: boolean;
  state?: {
    enable?: number;
    channel?: number;
    sensitivity?: number;
  };
}
```

### Example

```typescript
const pir = await api.getPirInfo();
console.log(`PIR enabled: ${pir.enabled}`);
```

---

### setPirInfo

Sets PIR sensor configuration.

```typescript
await api.setPirInfo(enabled: boolean, channel?: number);
// or
await api.setPirInfo(channel: number, enabled: boolean);
// or with full config
await api.setPirInfo(config: PirConfig, channel?: number);
```

### Parameters

| Parameter | Type        | Required | Default | Description            |
| --------- | ----------- | -------- | ------- | ---------------------- |
| `enabled` | `boolean`   | ✅       | -       | Enable/disable PIR     |
| `channel` | `number`    | ❌       | `0`     | Channel number         |
| `config`  | `PirConfig` | ❌       | -       | Full PIR configuration |

### Returns

`Promise<void>`

### Example

```typescript
// Enable PIR sensor
await api.setPirInfo(true);

// Disable PIR on channel 1
await api.setPirInfo(1, false);
```

---

## Autotracking

### getAutotracking

Gets autotracking configuration (PTZ cameras only).

```typescript
const autotrack = await api.getAutotracking(channel?: number);
```

### Returns

`Promise<AutotrackingConfig>`

```typescript
interface AutotrackingConfig {
  enabled: boolean;
  // Additional settings vary by camera model
}
```

---

### setAutotracking

Enables or disables autotracking.

```typescript
await api.setAutotracking(enabled: boolean, channel?: number);
```

### Parameters

| Parameter | Type      | Required | Default | Description                 |
| --------- | --------- | -------- | ------- | --------------------------- |
| `enabled` | `boolean` | ✅       | -       | Enable/disable autotracking |
| `channel` | `number`  | ❌       | `0`     | Channel number              |

### Returns

`Promise<void>`

### Example

```typescript
// Enable autotracking
await api.setAutotracking(true);

// Disable autotracking
await api.setAutotracking(false);
```

---

### setAutotrackingSettings

Sets detailed autotracking settings.

```typescript
await api.setAutotrackingSettings(settings: AutotrackingSettings, channel?: number);
```

### Parameters

| Parameter  | Type                   | Required | Description           |
| ---------- | ---------------------- | -------- | --------------------- |
| `settings` | `AutotrackingSettings` | ✅       | Autotracking settings |
| `channel`  | `number`               | ❌       | Channel number        |

### Returns

`Promise<void>`

---

### probeAutotrackingSupport

Checks if the camera supports autotracking.

```typescript
const supported = await api.probeAutotrackingSupport(channel?: number);
```

### Returns

`Promise<boolean>`

### Example

```typescript
const hasAutotrack = await api.probeAutotrackingSupport();
if (hasAutotrack) {
  await api.setAutotracking(true);
  console.log("Autotracking enabled");
} else {
  console.log("Camera does not support autotracking");
}
```

---

## Complete Detection Setup Example

```typescript
async function setupDetection() {
  // Check AI capabilities
  const aiTypes = await api.getAiDetectTypes();
  console.log("Supported AI:", aiTypes);

  // Enable motion detection
  await api.setMotionDetection(true);

  // Enable available AI detections
  if (aiTypes.includes("people")) {
    await api.setAiDetection("people", true);
  }
  if (aiTypes.includes("vehicle")) {
    await api.setAiDetection("vehicle", true);
  }

  // Enable PIR if battery camera
  const pirInfo = await api.getPirInfo().catch(() => null);
  if (pirInfo) {
    await api.setPirInfo(true);
  }

  // Enable autotracking if supported
  if (await api.probeAutotrackingSupport()) {
    await api.setAutotracking(true);
  }

  console.log("Detection setup complete");
}

await setupDetection();
```

---

[← Back to Baichuan API](./README.md)
