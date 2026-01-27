# Connection & Session Management

Methods for establishing and managing connections to Reolink cameras via the Baichuan protocol.

## Table of Contents

- [Constructor](#constructor)
- [login](#login)
- [close](#close)
- [cleanup](#cleanup)
- [ping](#ping)
- [reboot](#reboot)
- [createDedicatedSession](#creatededicatedsession)

---

## Constructor

Creates a new `ReolinkBaichuanApi` instance.

```typescript
import { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js";

const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  port: 9000,
  username: "admin",
  password: "your-password",
  // Optional parameters
  channel: 0, // Default channel for operations
  logger: console, // Custom logger
  timeoutMs: 30000, // Connection timeout
});
```

### Parameters

| Parameter   | Type     | Required | Default | Description                    |
| ----------- | -------- | -------- | ------- | ------------------------------ |
| `host`      | `string` | ✅       | -       | Camera IP address or hostname  |
| `port`      | `number` | ❌       | `9000`  | Baichuan protocol port         |
| `username`  | `string` | ✅       | -       | Login username                 |
| `password`  | `string` | ✅       | -       | Login password                 |
| `channel`   | `number` | ❌       | `0`     | Default channel for operations |
| `logger`    | `Logger` | ❌       | -       | Custom logger instance         |
| `timeoutMs` | `number` | ❌       | `30000` | Default timeout for operations |

---

## login

Establishes connection and authenticates with the camera.

```typescript
await api.login();
```

### Parameters

| Parameter           | Type     | Required | Default | Description                   |
| ------------------- | -------- | -------- | ------- | ----------------------------- |
| `options.timeoutMs` | `number` | ❌       | `30000` | Login timeout in milliseconds |

### Returns

`Promise<void>`

### Example

```typescript
const api = new ReolinkBaichuanApi({
  host: "192.168.1.100",
  username: "admin",
  password: "your-password",
});

try {
  await api.login();
  console.log("Connected successfully");
} catch (error) {
  console.error("Login failed:", error);
}
```

---

## close

Closes the connection to the camera.

```typescript
await api.close(options?: { reason?: string });
```

### Parameters

| Parameter        | Type     | Required | Default | Description                      |
| ---------------- | -------- | -------- | ------- | -------------------------------- |
| `options.reason` | `string` | ❌       | -       | Reason for closing (for logging) |

### Returns

`Promise<void>`

### Example

```typescript
await api.close({ reason: "User requested disconnect" });
```

---

## cleanup

Performs full cleanup of the API instance, including closing connections and releasing resources.

```typescript
await api.cleanup();
```

### Returns

`Promise<void>`

---

## ping

Sends a ping command to verify the connection is alive.

```typescript
await api.ping();
```

### Returns

`Promise<void>`

### Example

```typescript
try {
  await api.ping();
  console.log("Camera is responsive");
} catch (error) {
  console.error("Camera not responding");
}
```

---

## reboot

Reboots the camera or a specific channel (for NVR).

```typescript
await api.reboot(channel?: number);
```

### Parameters

| Parameter | Type     | Required | Default | Description                  |
| --------- | -------- | -------- | ------- | ---------------------------- |
| `channel` | `number` | ❌       | -       | Channel to reboot (NVR only) |

### Returns

`Promise<void>`

### Example

```typescript
// Reboot the camera
await api.reboot();

// Reboot a specific NVR channel
await api.reboot(2);
```

---

## createDedicatedSession

Creates a new independent API session to the same camera. Useful for parallel operations that require separate connections.

```typescript
const dedicatedApi = await api.createDedicatedSession(options);
```

### Parameters

| Parameter           | Type      | Required | Default | Description                 |
| ------------------- | --------- | -------- | ------- | --------------------------- |
| `options.channel`   | `number`  | ❌       | -       | Channel for the new session |
| `options.autoLogin` | `boolean` | ❌       | `true`  | Auto-login on creation      |

### Returns

`Promise<ReolinkBaichuanApi>` - A new independent API instance

### Example

```typescript
// Create a dedicated session for parallel recording download
const downloadSession = await api.createDedicatedSession({
  autoLogin: true,
});

// Use both sessions in parallel
await Promise.all([
  api.getSnapshot(),
  downloadSession.downloadRecording(params),
]);

// Don't forget to close when done
await downloadSession.close();
```

---

[← Back to Baichuan API](./README.md)
