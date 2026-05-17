# Events & Notifications

Methods for subscribing to and handling camera events.

## Table of Contents

- [subscribeEvents](#subscribeevents)
- [subscribeToAllEvents](#subscribetoallevents)
- [unsubscribeEvents](#unsubscribeevents)
- [getEvents](#getevents)
- [onSimpleEvent](#onsimpleevent)
- [offSimpleEvent](#offsimpleevent)
- [onObjectDetections](#onobjectdetections)
- [offObjectDetections](#offobjectdetections)
- [getAllChannelsEvents](#getallchannelsevents)

---

## subscribeEvents

Subscribes to camera events (motion, AI detection, etc.).

```typescript
await api.subscribeEvents();
```

### Returns

`Promise<void>`

### Event Types

After subscribing, the API emits various events:

| Event          | Description                               |
| -------------- | ----------------------------------------- |
| `motionAlarm`  | Motion detection triggered                |
| `aiAlarm`      | AI detection (person, vehicle, pet, etc.) |
| `visitor`      | Doorbell pressed (for doorbell cameras)   |
| `faceAlarm`    | Face detection                            |
| `packageAlarm` | Package detection                         |
| `sleepStatus`  | Battery camera sleep state change         |

### Example

```typescript
// Subscribe to events
await api.subscribeEvents();

// Listen for motion
api.on("motionAlarm", (event) => {
  console.log(`Motion on channel ${event.channel}: ${event.state}`);
});

// Listen for AI detections
api.on("aiAlarm", (event) => {
  console.log(`AI detection: ${event.type} - ${event.state}`);
  // event.type: "person", "vehicle", "dog_cat", "face", "package"
});

// Listen for doorbell
api.on("visitor", (event) => {
  console.log("Doorbell pressed!");
});
```

---

## subscribeToAllEvents

Subscribes to events for all channels (useful for NVR/Hub).

```typescript
await api.subscribeToAllEvents(options?: {
  channels?: number[];
  timeoutMs?: number;
});
```

### Parameters

| Parameter           | Type       | Required | Default | Description                    |
| ------------------- | ---------- | -------- | ------- | ------------------------------ |
| `options.channels`  | `number[]` | ❌       | All     | Specific channels to subscribe |
| `options.timeoutMs` | `number`   | ❌       | `5000`  | Timeout per channel            |

### Returns

`Promise<void>`

### Example

```typescript
// Subscribe to all NVR channels
await api.subscribeToAllEvents();

// Or specific channels only
await api.subscribeToAllEvents({
  channels: [0, 1, 2],
});

api.on("motionAlarm", (event) => {
  console.log(`Motion on channel ${event.channel}`);
});
```

---

## unsubscribeEvents

Unsubscribes from camera events.

```typescript
await api.unsubscribeEvents();
```

### Returns

`Promise<void>`

### Example

```typescript
// Stop receiving events
await api.unsubscribeEvents();
```

---

## getEvents

Gets the current event state for a channel.

```typescript
const events = await api.getEvents(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description    |
| --------- | -------- | -------- | ------- | -------------- |
| `channel` | `number` | ❌       | `0`     | Channel number |

### Returns

`Promise<Events>`

```typescript
interface Events {
  motion?: boolean;
  person?: boolean;
  vehicle?: boolean;
  pet?: boolean;
  face?: boolean;
  package?: boolean;
  visitor?: boolean;
}
```

### Example

```typescript
const events = await api.getEvents();
if (events.motion) {
  console.log("Motion is currently active");
}
if (events.person) {
  console.log("Person detected");
}
```

---

## onSimpleEvent

Registers a handler for a specific event type.

```typescript
await api.onSimpleEvent(eventName: string, handler: (event: any) => void);
```

### Parameters

| Parameter   | Type       | Required | Description            |
| ----------- | ---------- | -------- | ---------------------- |
| `eventName` | `string`   | ✅       | Event type name        |
| `handler`   | `function` | ✅       | Event handler function |

### Supported Events

| Event Name  | Event Data                            |
| ----------- | ------------------------------------- |
| `"motion"`  | `{ channel: number, state: boolean }` |
| `"person"`  | `{ channel: number, state: boolean }` |
| `"vehicle"` | `{ channel: number, state: boolean }` |
| `"pet"`     | `{ channel: number, state: boolean }` |
| `"face"`    | `{ channel: number, state: boolean }` |
| `"package"` | `{ channel: number, state: boolean }` |
| `"visitor"` | `{ channel: number }`                 |

### Example

```typescript
await api.onSimpleEvent("motion", (event) => {
  if (event.state) {
    console.log(`Motion started on channel ${event.channel}`);
  } else {
    console.log(`Motion ended on channel ${event.channel}`);
  }
});

await api.onSimpleEvent("person", (event) => {
  console.log(
    `Person ${event.state ? "detected" : "gone"} on channel ${event.channel}`,
  );
});
```

---

## offSimpleEvent

Removes a handler for a specific event type.

```typescript
await api.offSimpleEvent(eventName: string, handler?: (event: any) => void);
```

### Parameters

| Parameter   | Type       | Required | Description                                    |
| ----------- | ---------- | -------- | ---------------------------------------------- |
| `eventName` | `string`   | ✅       | Event type name                                |
| `handler`   | `function` | ❌       | Specific handler to remove (or all if omitted) |

### Example

```typescript
const motionHandler = (event) => console.log("Motion:", event);
await api.onSimpleEvent("motion", motionHandler);

// Later, remove the handler
await api.offSimpleEvent("motion", motionHandler);
```

---

## onObjectDetections

Subscribes to AI **object detection boxes** (people / vehicle / animal / face) without having to start a video stream yourself.

Mirrors [`onSimpleEvent`](#onsimpleevent) end-to-end, but the events are sourced from the BcMedia `additionalHeader` streaming side-channel rather than from cmd_id 33 push events. Each event carries the AI class label, confidence score, and **normalized `[0, 1]` box coordinates** — render-ready without further conversion.

```typescript
await api.onObjectDetections(
  handler: (event: ReolinkDetectionEvent) => void | Promise<void>,
  options?: {
    channel?: number;                 // default: 0
    profile?: "main" | "sub" | "ext"; // default: "sub"
  },
);
```

### Lifecycle

Listeners and substreams are tracked **per `(channel, profile)` tuple**:

- On the **first** listener for a tuple, the API ensures the matching video stream is running. The socket pool is shared with regular consumers (tag `streaming:ch{N}`), so if that channel is already streaming the substream simply piggybacks on the existing flow — no extra TCP socket and no extra bandwidth from the camera. Otherwise it opens the stream on demand.
- Multiple `onObjectDetections` calls on the same `(channel, profile)` are **reference-counted** — they share the same stream.
- On the **last** [`offObjectDetections`](#offobjectdetections) call for a tuple, that substream is stopped and the pool socket released.

This means idle UIs cost zero substream bandwidth, and there is no need to call `subscribeEvents()` or start a stream manually.

> **NVR / Hub:** you **must** pass the camera's channel via `options.channel`, otherwise the substream opens on channel 0 and you never receive boxes for the other channels.

> **Profile choice:** `sub` is recommended (lighter bandwidth, typically 640×360). Pick `main` only when you specifically need detection metadata aligned with the main feed; pick `ext` for the third profile on multi-stream models.

### Parameters

| Parameter         | Type                              | Required | Default | Description                                                                                  |
| ----------------- | --------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `handler`         | `function`                        | ✅       | -       | Callback invoked for every detection event on the targeted tuple                             |
| `options.channel` | `number`                          | ❌       | `0`     | Channel to subscribe to (required for NVR/Hub children)                                      |
| `options.profile` | `"main" \| "sub" \| "ext"`        | ❌       | `"sub"` | Stream profile whose `additionalHeader` overlays will be decoded                             |

### Event Payload

```typescript
interface ReolinkDetectionEvent {
  channel: number;
  /** Microseconds timestamp from the BcMedia video frame. */
  microseconds: number;
  /** Stream profile that produced the underlying frame. */
  profile: "main" | "sub" | "ext";
  /** Boxes in [0, 1] fractional coordinates. */
  boxes: ReolinkDetectionBox[];
  /** Source frame width (from BcMedia InfoV1/V2) if known. */
  frameWidth?: number;
  /** Source frame height (from BcMedia InfoV1/V2) if known. */
  frameHeight?: number;
  /** Decoder diagnostic state. */
  decodeState:
    | "invalid-marker"
    | "no-overlay"
    | "overlay-undecoded"
    | "overlay-decoded";
  /** Raw additionalHeader bytes — kept for downstream decoder work. */
  rawHeader: Buffer;
}

interface ReolinkDetectionBox {
  /** Left edge in [0, 1] (0 = left, 1 = right). */
  x: number;
  /** Top edge in [0, 1] (0 = top, 1 = bottom). */
  y: number;
  /** Width in [0, 1]. */
  width: number;
  /** Height in [0, 1]. */
  height: number;
  /** AI class label if the camera reports one (e.g. "person", "vehicle"). */
  label?: string;
  /** Confidence in [0, 1] if exposed by the camera. */
  confidence?: number;
}
```

### Returns

`Promise<void>` — resolves once the listener is registered (and, on the first call, the substream has been started).

### Example — standalone camera

```typescript
await api.onObjectDetections((event) => {
  for (const box of event.boxes) {
    console.log(
      `[ch${event.channel}/${event.profile}] ${box.label ?? "object"}` +
        ` (${((box.confidence ?? 0) * 100).toFixed(0)}%) ` +
        `@ x=${box.x.toFixed(3)} y=${box.y.toFixed(3)} ` +
        `w=${box.width.toFixed(3)} h=${box.height.toFixed(3)}`,
    );
  }
});
```

### Example — NVR child on a specific channel

```typescript
// Channel 2 of an NVR/Hub, sub profile (default)
await api.onObjectDetections(
  (event) => console.log(event.channel, event.boxes),
  { channel: 2 },
);

// Or main profile if you need detection metadata aligned with the main feed
await api.onObjectDetections((event) => render(event), {
  channel: 2,
  profile: "main",
});
```

To overlay boxes onto a video frame, multiply the normalized coordinates by the frame size:

```typescript
await api.onObjectDetections((event) => {
  const W = event.frameWidth ?? canvas.width;
  const H = event.frameHeight ?? canvas.height;
  for (const box of event.boxes) {
    ctx.strokeRect(box.x * W, box.y * H, box.width * W, box.height * H);
  }
});
```

---

## offObjectDetections

Removes a previously registered object-detection handler. When the **last** handler for a given `(channel, profile)` is removed, the auto-managed substream for that tuple is closed and the pool socket released.

```typescript
await api.offObjectDetections(
  handler?: (event: ReolinkDetectionEvent) => void | Promise<void>,
  options?: {
    channel?: number;                 // default: 0
    profile?: "main" | "sub" | "ext"; // default: "sub"
  },
);
```

If `options` is **omitted**, the operation is broadcast across **every** active `(channel, profile)` tuple — useful when you want to disconnect from all subscriptions on an `api` instance at once (e.g. on shutdown).

### Parameters

| Parameter         | Type                       | Required | Default | Description                                                                                            |
| ----------------- | -------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `handler`         | `function`                 | ❌       | -       | Specific handler to remove (or all if omitted)                                                         |
| `options.channel` | `number`                   | ❌       | `0`     | Channel to detach from (defaults to `0` when `options` is provided)                                    |
| `options.profile` | `"main" \| "sub" \| "ext"` | ❌       | `"sub"` | Profile to detach from. Must match the value used in [`onObjectDetections`](#onobjectdetections)       |

### Returns

`Promise<void>`

### Example

```typescript
const onDetect = (event) => console.log(event.boxes);
await api.onObjectDetections(onDetect, { channel: 2 });

// Remove this specific handler from ch2/sub — substream is torn down when
// this was the last listener for that tuple.
await api.offObjectDetections(onDetect, { channel: 2 });

// Clear every handler for ch2/sub at once:
await api.offObjectDetections(undefined, { channel: 2 });

// Clear every handler on every (channel, profile) tuple at once:
await api.offObjectDetections();
```

---

## getAllChannelsEvents

Gets event states for all channels (NVR/Hub).

```typescript
const allEvents = await api.getAllChannelsEvents(options?: {
  channels?: number[];
});
```

### Parameters

| Parameter          | Type       | Required | Default | Description                |
| ------------------ | ---------- | -------- | ------- | -------------------------- |
| `options.channels` | `number[]` | ❌       | All     | Specific channels to query |

### Returns

`Promise<Map<number, Events>>`

### Example

```typescript
const allEvents = await api.getAllChannelsEvents();
for (const [channel, events] of allEvents) {
  console.log(`Channel ${channel}:`);
  if (events.motion) console.log("  - Motion active");
  if (events.person) console.log("  - Person detected");
}
```

---

## Event Handling Best Practices

### Keep-Alive Subscription

Events require an active subscription. Handle reconnection:

```typescript
async function setupEventSubscription() {
  await api.subscribeEvents();

  api.on("disconnect", async () => {
    console.log("Disconnected, reconnecting...");
    try {
      await api.login();
      await api.subscribeEvents();
    } catch (e) {
      console.error("Reconnection failed:", e);
    }
  });
}
```

### Multi-Channel Event Aggregation

```typescript
const eventCounts = new Map<number, { motion: number; person: number }>();

api.on("motionAlarm", (event) => {
  const counts = eventCounts.get(event.channel) ?? { motion: 0, person: 0 };
  counts.motion++;
  eventCounts.set(event.channel, counts);
});

api.on("aiAlarm", (event) => {
  if (event.type === "person") {
    const counts = eventCounts.get(event.channel) ?? { motion: 0, person: 0 };
    counts.person++;
    eventCounts.set(event.channel, counts);
  }
});
```

### Event Debouncing

```typescript
const lastMotion = new Map<number, number>();
const debounceMs = 5000;

api.on("motionAlarm", (event) => {
  const now = Date.now();
  const last = lastMotion.get(event.channel) ?? 0;

  if (now - last > debounceMs) {
    console.log(`New motion event on channel ${event.channel}`);
    // Process the event
  }

  lastMotion.set(event.channel, now);
});
```

---

[← Back to Baichuan API](./README.md)
