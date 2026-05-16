# Email (SMTP server) & Email Push

Methods for managing the camera's outbound SMTP configuration and the email-driven motion delivery used by battery cameras.

## Table of Contents

- [Background](#background)
- [Email config (cmd_id 42 / 43 / 141)](#email-config-cmd_id-42--43--141)
  - [getEmail](#getemail)
  - [setEmail](#setemail)
  - [testEmail](#testemail)
- [Email task / schedule (cmd_id 216 / 217)](#email-task--schedule-cmd_id-216--217)
  - [getEmailTask](#getemailtask)
  - [setEmailTask](#setemailtask)
- [High-level: setupEmailPushToManager](#high-level-setupemailpushtomanager)
- [Manager-side SMTP server](#manager-side-smtp-server)
- [Trigger types](#trigger-types)

---

## Background

Reolink battery cameras (Argus, Go, …) don't keep a long-lived TCP/ONVIF push subscription alive while sleeping. The most reliable way to be notified of motion is **SMTP**: the camera wakes up, sends a mail to a configured server, then sleeps again.

This library exposes:

- The **camera-side** SMTP settings (where the camera should send mails).
- An **in-process SMTP server** in the manager app that receives those mails, parses them, and emits motion events into the same bus used by native Baichuan push.

The camera ships an `<Email>` block (SMTP host/port/user/password/recipients/SSL/attachment options) and a separate `<EmailTask>` block that describes *when* and *for which trigger types* to send mails.

## Email config (cmd_id 42 / 43 / 141)

### getEmail

```ts
const cfg = await api.getEmail();
```

Returns the full `<Email>` block, including capability hints reported only by the GET response:

| Field | Type | Description |
| --- | --- | --- |
| `smtpServer` | string | SMTP host, e.g. `smtp.gmail.com` |
| `userName` | string | SMTP username / sender address |
| `password` | string | SMTP password (sent in cleartext over Baichuan AES tunnel) |
| `address1` / `address2` / `address3` | string | Up to 3 recipients |
| `smtpPort` | number | SMTP port (commonly 465 / 587 / 25) |
| `sendNickname` | string | Friendly "From" name |
| `attachment` | `0 \| 1` | Whether to attach an artifact |
| `attachmentType` | `picture \| video \| none` | Attachment kind |
| `textType` | `withText \| noText` | Body text mode |
| `ssl` | `0 \| 1` | TLS / SSL |
| `interval` | number (seconds) | Throttle between mails. **Ignored on battery cams.** |
| `senderMaxLen` | number (GET only) | Max length of `userName` |
| `pwdMaxLen` | number (GET only) | Max length of `password` |
| `emailAttachAbility` | number (GET only) | Bitmap of supported attachment types |

### setEmail

```ts
await api.setEmail({
  smtpServer: "smtp.gmail.com",
  userName: "you@gmail.com",
  password: "app-password",
  address1: "alerts@example.com",
  smtpPort: 465,
  ssl: 1,
  attachment: 1,
  attachmentType: "picture",
});
```

Partial patch: only the supplied fields change. Under the hood the library does a **read-modify-write** because the camera rejects partial `<Email>` blocks.

### testEmail

```ts
const ok = await api.testEmail();           // test the persisted config
const ok = await api.testEmail({ ... });    // test an override without saving
```

Returns:

- `true` when the camera reports `response_code=200` (test mail accepted).
- `false` when the camera reports `response_code=482` (test failed — server unreachable, invalid credentials, etc).
- Throws on other response codes / transport errors.

Useful for "Send test email" buttons that want to surface a friendly error rather than dumping the raw response code.

## Email task / schedule (cmd_id 216 / 217)

### getEmailTask

```ts
const task = await api.getEmailTask(channel);
```

Returns the structured `<EmailTask>` block:

```ts
{
  channelId: 0,
  enable: 1,
  typeScheduleList: [
    { type: "MD",      valueTable: "111111...111" }, // 168 chars
    { type: "people",  valueTable: "111111...111" },
    { type: "vehicle", valueTable: "000000...000" },
    // ...
  ],
}
```

`valueTable` is a 168-char `0/1` bitmap: 7 days × 24 hours. `1` = email enabled in that hour, `0` = disabled.

### setEmailTask

```ts
await api.setEmailTask(channel, {
  channelId: 0,
  enable: 1,
  typeScheduleList: [
    { type: "MD",      valueTable: "1".repeat(168) },
    { type: "people",  valueTable: "1".repeat(168) },
    { type: "vehicle", valueTable: "0".repeat(168) },
    { type: "none",    valueTable: "0".repeat(168) }, // placeholder slots
    // ...keep every slot returned by getEmailTask, even those you don't care about
  ],
});
```

**Important**: the camera replaces the schedule wholesale. Slots present in the GET but omitted from the SET get **dropped**. Always start from a fresh GET, mutate, then SET.

## High-level: setupEmailPushToManager

For the common "point this camera at our manager's SMTP intake" workflow, the library exposes a one-shot helper:

```ts
const result = await api.setupEmailPushToManager(
  {
    managerHost: "192.168.1.50",
    managerPort: 2525,                       // optional, default 2525
    recipientLocalPart: "cam-abc123",        // unique per camera
    domain: "nodelink.local",                // must match manager setting
    attachmentType: "picture",
    sendNickname: "Living Room",
    triggerTypes: ["MD", "people", "vehicle"],
    runTest: true,                           // optional
  },
  channel,
);

// result:
// {
//   setEmail: { applied: true },
//   setEmailTask: { applied: true, touchedTypes: ["MD", "people", "vehicle"] },
//   testEmail: { success: true } // only when runTest=true
// }
```

The helper:

1. Reads the current `<Email>` block.
2. Merges in the manager-side address (`<recipientLocalPart>@<domain>`) as both sender username and recipient1.
3. Calls `setEmail`.
4. Reads the current `<EmailTask>`, flips the requested triggers to 24/7 ON without touching the others.
5. Calls `setEmailTask` with the full list (so the camera keeps the untouched slots).
6. Optionally fires a `testEmail`.

This is what the **Email Push** tab in the manager UI invokes when you click "Auto-configure".

## Manager-side SMTP server

The manager app embeds an `smtp-server` listener (`app/src/email-push-server.ts`). Each camera registered in the manager gets a virtual recipient `cam-<id>@<domain>`. When a mail arrives, the server:

1. Validates the recipient against the registered cameras (rejects unknowns at RCPT TO).
2. Parses subject + body to classify the trigger (people / vehicle / motion / …).
3. Saves any image attachment under `${DATA_PATH}/email-push/<cameraId>/<timestamp>/`.
4. Emits a synthetic `ReolinkSimpleEvent` into the events bus → MQTT / Home Assistant / Frigate downstream consumers see motion exactly like a native push.

The tRPC procedures live under the `emailPush.*` namespace:

| Procedure | Purpose |
| --- | --- |
| `emailPush.status` | running flag + counters + last error |
| `emailPush.getSettings` / `updateSettings` | server-side config |
| `emailPush.start` / `stop` / `restart` | runtime control |
| `emailPush.getCameraAddress` | recipient assigned to a camera |
| `emailPush.listCameraAddresses` | recipients for all configured cameras |
| `emailPush.recentEvents` | in-memory ring of recent events per camera |
| `emailPush.injectTestEvent` | synthetic event for end-to-end testing |

## Trigger types

Observed across firmwares:

| Type | Meaning |
| --- | --- |
| `MD` | Motion Detect (any motion) |
| `Normal` | Continuous recording trigger |
| `people` | AI person detection |
| `vehicle` | AI vehicle detection |
| `dog_cat` | AI pet detection |
| `face` | AI face detection |
| `package` | AI package detection |
| `cry` | Crying-baby detection |
| `visitor` | Doorbell visitor |
| `doorbell` | Doorbell button press |
| `none` | Placeholder slot (camera ignores it) |

Not every type is supported by every model; `getEmailTask` returns the slots the camera actually exposes.
