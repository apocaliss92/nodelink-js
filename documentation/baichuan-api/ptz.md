# PTZ Control

Methods for Pan-Tilt-Zoom control and preset management.

## Table of Contents

- [ptz](#ptz)
- [getPtzPresets](#getptzpresets)
- [moveToPtzPreset](#movetoptzpreset)
- [setPtzPreset](#setptzpreset)
- [deletePtzPreset](#deleteptzpreset)
- [getPtzPosition](#getptzposition)
- [getZoomFocus](#getzoomfocus)
- [zoomToFactor](#zoomtofactor)

---

## ptz

Executes a PTZ movement command.

```typescript
await api.ptz(command: PtzCommand);
// or with channel
await api.ptz(channel: number, command: PtzCommand);
```

### Parameters

| Parameter            | Type                  | Required | Default | Description                           |
| -------------------- | --------------------- | -------- | ------- | ------------------------------------- |
| `channel`            | `number`              | ❌       | `0`     | Channel number                        |
| `command.action`     | `"start"` \| `"stop"` | ✅       | -       | Start or stop movement                |
| `command.command`    | `PtzDirection`        | ✅       | -       | Movement direction                    |
| `command.speed`      | `number`              | ❌       | `32`    | Movement speed (1-64)                 |
| `command.autoStopMs` | `number`              | ❌       | `0`     | Auto-stop after ms (0 = no auto-stop) |

### PTZ Commands

| Command       | Description |
| ------------- | ----------- |
| `"Left"`      | Pan left    |
| `"Right"`     | Pan right   |
| `"Up"`        | Tilt up     |
| `"Down"`      | Tilt down   |
| `"ZoomIn"`    | Zoom in     |
| `"ZoomOut"`   | Zoom out    |
| `"FocusNear"` | Focus near  |
| `"FocusFar"`  | Focus far   |

### Returns

`Promise<void>`

### Example

```typescript
// Start moving right
await api.ptz({
  action: "start",
  command: "Right",
  speed: 32,
});

// Wait 2 seconds
await new Promise((r) => setTimeout(r, 2000));

// Stop movement
await api.ptz({
  action: "stop",
  command: "Right",
});

// Or use auto-stop
await api.ptz({
  action: "start",
  command: "Left",
  speed: 48,
  autoStopMs: 1000, // Automatically stops after 1 second
});
```

---

## getPtzPresets

Gets all configured PTZ presets.

```typescript
const presets = await api.getPtzPresets(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<PtzPreset[]>`

```typescript
interface PtzPreset {
  id: number;
  name: string;
}
```

### Example

```typescript
const presets = await api.getPtzPresets();
for (const preset of presets) {
  console.log(`Preset ${preset.id}: ${preset.name}`);
}
// Preset 1: Front Door
// Preset 2: Backyard
// Preset 3: Driveway
```

---

## moveToPtzPreset

Moves the camera to a saved preset position.

```typescript
await api.moveToPtzPreset(presetId: number, channel?: number);
// or with channel first
await api.moveToPtzPreset(channel: number, presetId: number);
```

### Parameters

| Parameter  | Type     | Required | Default | Description          |
| ---------- | -------- | -------- | ------- | -------------------- |
| `presetId` | `number` | ✅       | -       | Preset ID to move to |
| `channel`  | `number` | ❌       | `0`     | Channel number       |

### Returns

`Promise<void>`

### Example

```typescript
// Move to preset 1
await api.moveToPtzPreset(1);

// Move channel 2 to preset 3
await api.moveToPtzPreset(2, 3);
```

---

## setPtzPreset

Creates or updates a PTZ preset at the current position.

```typescript
await api.setPtzPreset(presetId: number, name: string, channel?: number);
// or with channel
await api.setPtzPreset(channel: number, presetId: number, name: string);
```

### Parameters

| Parameter  | Type     | Required | Default | Description      |
| ---------- | -------- | -------- | ------- | ---------------- |
| `presetId` | `number` | ✅       | -       | Preset ID (1-64) |
| `name`     | `string` | ✅       | -       | Preset name      |
| `channel`  | `number` | ❌       | `0`     | Channel number   |

### Returns

`Promise<void>`

### Example

```typescript
// Position camera first
await api.ptz({ action: "start", command: "Left", speed: 32, autoStopMs: 500 });
await new Promise((r) => setTimeout(r, 1000));

// Save current position as preset
await api.setPtzPreset(5, "Kitchen View");
console.log("Preset saved");
```

---

## deletePtzPreset

Deletes a PTZ preset.

```typescript
await api.deletePtzPreset(presetId: number, channel?: number);
// or with channel
await api.deletePtzPreset(channel: number, presetId: number);
```

### Parameters

| Parameter  | Type     | Required | Default | Description         |
| ---------- | -------- | -------- | ------- | ------------------- |
| `presetId` | `number` | ✅       | -       | Preset ID to delete |
| `channel`  | `number` | ❌       | `0`     | Channel number      |

### Returns

`Promise<void>`

### Example

```typescript
await api.deletePtzPreset(5);
console.log("Preset 5 deleted");
```

---

## getPtzPosition

Gets the current PTZ position.

```typescript
const position = await api.getPtzPosition(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<PtzPosition>`

```typescript
interface PtzPosition {
  pan?: number;
  tilt?: number;
}
```

### Example

```typescript
const pos = await api.getPtzPosition();
console.log(`Pan: ${pos.pan}, Tilt: ${pos.tilt}`);
```

---

## getZoomFocus

Gets the current zoom and focus status.

```typescript
const status = await api.getZoomFocus(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<ZoomFocusStatus>`

```typescript
interface ZoomFocusStatus {
  zoom?: {
    minPos: number;
    maxPos: number;
    curPos: number;
  };
  focus?: {
    minPos: number;
    maxPos: number;
    curPos: number;
  };
}
```

### Example

```typescript
const status = await api.getZoomFocus();
if (status.zoom) {
  console.log(
    `Zoom: ${status.zoom.curPos} (${status.zoom.minPos}-${status.zoom.maxPos})`,
  );
  const zoomPercent =
    ((status.zoom.curPos - status.zoom.minPos) /
      (status.zoom.maxPos - status.zoom.minPos)) *
    100;
  console.log(`Zoom level: ${zoomPercent.toFixed(1)}%`);
}
```

---

## zoomToFactor

Sets the zoom to a specific factor.

```typescript
await api.zoomToFactor(zoomFactor: number, channel?: number);
// or with channel
await api.zoomToFactor(channel: number, zoomFactor: number);
```

### Parameters

| Parameter    | Type     | Required | Default | Description                          |
| ------------ | -------- | -------- | ------- | ------------------------------------ |
| `zoomFactor` | `number` | ✅       | -       | Target zoom factor (device specific) |
| `channel`    | `number` | ❌       | `0`     | Channel number                       |

### Returns

`Promise<void>`

### Example

```typescript
// Get current zoom range
const status = await api.getZoomFocus();
const minZoom = status.zoom?.minPos ?? 0;
const maxZoom = status.zoom?.maxPos ?? 100;

// Zoom to 50%
const targetZoom = minZoom + (maxZoom - minZoom) * 0.5;
await api.zoomToFactor(targetZoom);

// Zoom to maximum
await api.zoomToFactor(maxZoom);
```

---

[← Back to Baichuan API](./README.md)
