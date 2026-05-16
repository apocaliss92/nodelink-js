import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  startEmailPushServer,
  stopEmailPushServer,
  restartEmailPushServer,
  getEmailPushServerStatus,
  getCameraEmailAddress,
  getRecentEmailPushEvents,
  emitSyntheticEmailPushEventForTest,
  type EmailPushEvent,
} from "../email-push-server.js";
import { getCameras, getSettings, saveSettings } from "../settings-store.js";

const DATA_DIR = process.env.DATA_PATH || ".";

const SettingsInputSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  bindHost: z.string().optional(),
  domain: z.string().optional(),
  requireAuth: z.boolean().optional(),
  authUsername: z.string().optional(),
  authPassword: z.string().optional(),
  tls: z.boolean().optional(),
  maxMessageBytes: z.number().int().min(1024).optional(),
  snapshotRetentionDays: z.number().int().min(0).optional(),
  recentEventsPerCamera: z.number().int().min(0).optional(),
  motionResetMs: z.number().int().min(500).optional(),
});

function serializeEvent(event: EmailPushEvent): {
  cameraId: string;
  recipient: string;
  inferredType: EmailPushEvent["inferredType"];
  receivedAtMs: number;
  subject: string;
  from: string;
  snapshotPath: string | undefined;
  snapshotBase64: string | undefined;
  bodyExcerpt: string;
} {
  let snapshotBase64: string | undefined;
  if (event.snapshotPath) {
    try {
      const absolute = path.isAbsolute(event.snapshotPath)
        ? event.snapshotPath
        : path.join(DATA_DIR, event.snapshotPath);
      const buf = fs.readFileSync(absolute);
      snapshotBase64 = buf.toString("base64");
    } catch {
      // ignore — file may have been pruned already
    }
  }
  return {
    cameraId: event.cameraId,
    recipient: event.recipient,
    inferredType: event.inferredType,
    receivedAtMs: event.receivedAtMs,
    subject: event.subject,
    from: event.from,
    snapshotPath: event.snapshotPath,
    snapshotBase64,
    bodyExcerpt: event.bodyExcerpt,
  };
}

export const emailPushRouter = router({
  /**
   * Current server status (running flag, counters, bind info).
   */
  status: publicProcedure
    .meta({ description: "Get email-push SMTP server status" })
    .query(() => getEmailPushServerStatus()),

  /**
   * Read the persisted emailPush settings block (sans secrets — auth password
   * is exposed as a boolean so the UI can show whether it's configured).
   * `featureEnabled` is the master flag the UI checks before rendering its
   * email-push tabs and is intentionally never settable through this router.
   */
  getSettings: publicProcedure
    .meta({ description: "Get email-push configuration (password redacted)" })
    .query(() => {
      const { emailPush } = getSettings();
      const { authPassword, ...rest } = emailPush;
      return {
        ...rest,
        authPasswordConfigured: Boolean(authPassword),
      };
    }),

  /**
   * Patch the emailPush settings. Returns the redacted settings block.
   * Re-starts the server only if it was already running (callers can also
   * call `restart` explicitly after a multi-field update).
   */
  updateSettings: publicProcedure
    .meta({
      description:
        "Update email-push configuration. The server is restarted automatically when it is already running.",
    })
    .input(SettingsInputSchema)
    .mutation(async ({ input }) => {
      const settings = getSettings();
      const wasRunning = getEmailPushServerStatus().running;
      const merged = { ...settings.emailPush, ...input };
      saveSettings({ ...settings, emailPush: merged });
      if (wasRunning) {
        await restartEmailPushServer();
      } else if (merged.enabled) {
        // Settings flipped to enabled — start it.
        await startEmailPushServer();
      }
      const { authPassword, ...rest } = merged;
      return {
        ...rest,
        authPasswordConfigured: Boolean(authPassword),
      };
    }),

  /** Start the SMTP server (requires `enabled: true` in settings). */
  start: publicProcedure
    .meta({ description: "Start the email-push SMTP server" })
    .mutation(async () => {
      await startEmailPushServer();
      return getEmailPushServerStatus();
    }),

  /** Stop the SMTP server. */
  stop: publicProcedure
    .meta({ description: "Stop the email-push SMTP server" })
    .mutation(async () => {
      await stopEmailPushServer();
      return getEmailPushServerStatus();
    }),

  /** Stop+start to apply pending settings changes. */
  restart: publicProcedure
    .meta({ description: "Restart the email-push SMTP server" })
    .mutation(async () => {
      await restartEmailPushServer();
      return getEmailPushServerStatus();
    }),

  /**
   * Return the per-camera virtual recipient address. The cameraId must match
   * one of the cameras registered in settings.
   */
  getCameraAddress: publicProcedure
    .meta({
      description:
        "Get the SMTP recipient address assigned to a camera (`cam-<id>@<domain>`).",
    })
    .input(z.object({ cameraId: z.string().min(1) }))
    .query(({ input }) => {
      const cameras = getCameras();
      const camera = cameras.find(
        (c) => c.id === input.cameraId || c.name === input.cameraId,
      );
      if (!camera) {
        throw new Error(`Unknown camera ${input.cameraId}`);
      }
      return {
        cameraId: camera.id,
        cameraName: camera.name,
        address: getCameraEmailAddress(camera.id),
      };
    }),

  /**
   * List all configured cameras with their assigned recipient address. Useful
   * for a "bulk auto-configure" workflow in the UI.
   */
  listCameraAddresses: publicProcedure
    .meta({
      description:
        "List configured cameras with the SMTP recipient assigned to each one.",
    })
    .query(() =>
      getCameras().map((c) => ({
        cameraId: c.id,
        cameraName: c.name,
        address: getCameraEmailAddress(c.id),
        isBattery: c.isBattery ?? false,
      })),
    ),

  /** Recent in-memory events for a specific camera (most recent first). */
  recentEvents: publicProcedure
    .meta({
      description:
        "Return the last N email-push events buffered in memory for a camera.",
    })
    .input(
      z.object({
        cameraId: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        includeSnapshot: z.boolean().optional().default(false),
      }),
    )
    .query(({ input }) => {
      const events = getRecentEmailPushEvents(input.cameraId, input.limit);
      return events.map((e) =>
        input.includeSnapshot
          ? serializeEvent(e)
          : { ...serializeEvent(e), snapshotBase64: undefined },
      );
    }),

  /**
   * Wait for at least one new email-push event for the given camera. Polls
   * the in-memory ring every 500ms up to `timeoutMs`. Useful as an
   * end-to-end verification: trigger something (motion, manual SMTP from a
   * camera, …) and check whether the manager actually received it.
   *
   * Resolves to `{ delivered: true, event }` when a new event lands, or
   * `{ delivered: false }` after the timeout.
   */
  verifyDelivery: publicProcedure
    .meta({
      description:
        "Wait up to `timeoutMs` for a new email-push event to land for this camera. Returns `{delivered:true, event}` or `{delivered:false}`.",
    })
    .input(
      z.object({
        cameraId: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(300_000).default(45_000),
        sinceMs: z
          .number()
          .int()
          .optional()
          .describe(
            "If set, treat any event with receivedAtMs > sinceMs as new. Defaults to call-time.",
          ),
      }),
    )
    .mutation(async ({ input }) => {
      const sinceMs = input.sinceMs ?? Date.now();
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        const events = getRecentEmailPushEvents(input.cameraId, 5);
        const fresh = events.find((e) => e.receivedAtMs > sinceMs);
        if (fresh) {
          return { delivered: true, event: serializeEvent(fresh) };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { delivered: false };
    }),

  /**
   * Return the LAN IPv4 addresses of the manager. The "auto-configure" UI
   * uses the first non-loopback address as the `smtpServer` value for the
   * camera — `window.location.hostname` resolves to `localhost` when the
   * UI is opened locally, which is unusable from the camera's perspective.
   */
  getRecommendedHost: publicProcedure
    .meta({
      description:
        "Return candidate LAN host addresses (IPv4) for the camera-facing SMTP server. The first item is the recommended choice.",
    })
    .query(() => {
      const ifaces = os.networkInterfaces();
      const candidates: Array<{ iface: string; address: string }> = [];
      for (const [name, addrs] of Object.entries(ifaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
          if (addr.family !== "IPv4") continue;
          if (addr.internal) continue;
          // Filter out link-local 169.254/16 — those don't help cameras.
          if (addr.address.startsWith("169.254.")) continue;
          candidates.push({ iface: name, address: addr.address });
        }
      }
      // Prefer addresses in the most common private ranges first
      // (192.168/16, 10/8, 172.16-31/12), then anything else.
      const score = (a: string): number => {
        if (a.startsWith("192.168.")) return 0;
        if (a.startsWith("10.")) return 1;
        if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(a)) return 2;
        return 3;
      };
      candidates.sort((a, b) => score(a.address) - score(b.address));
      return {
        recommended: candidates[0]?.address ?? null,
        candidates,
      };
    }),

  /**
   * Inject a synthetic event into the pipeline. Useful for UI integration
   * tests and for verifying the downstream events-manager / MQTT wiring
   * without forcing a real camera to fire.
   */
  injectTestEvent: publicProcedure
    .meta({
      description:
        "Inject a synthetic email-push event into the pipeline (test hook).",
    })
    .input(
      z.object({
        cameraId: z.string().min(1),
        inferredType: z
          .enum([
            "motion",
            "people",
            "vehicle",
            "animal",
            "face",
            "package",
            "doorbell",
            "other",
          ])
          .default("motion"),
        subject: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const cameras = getCameras();
      const camera = cameras.find((c) => c.id === input.cameraId);
      if (!camera) throw new Error(`Unknown camera ${input.cameraId}`);
      const event: EmailPushEvent = {
        cameraId: camera.id,
        recipient: getCameraEmailAddress(camera.id),
        inferredType: input.inferredType,
        receivedAtMs: Date.now(),
        subject: input.subject ?? `Synthetic ${input.inferredType} event`,
        from: "test@nodelink.local",
        bodyExcerpt: "(injected via emailPush.injectTestEvent)",
      };
      emitSyntheticEmailPushEventForTest(event);
      return { success: true, event: serializeEvent(event) };
    }),
});
