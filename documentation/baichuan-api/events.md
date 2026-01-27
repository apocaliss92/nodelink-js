# Events & Notifications

Methods for subscribing to and handling camera events.

## Table of Contents

- [subscribeEvents](#subscribeevents)
- [subscribeToAllEvents](#subscribetoallevents)
- [unsubscribeEvents](#unsubscribeevents)
- [getEvents](#getevents)
- [onSimpleEvent](#onsimpleevent)
- [offSimpleEvent](#offsimpleevent)
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
