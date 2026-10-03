import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import os from "node:os";
import {
  startBaichuanWebhookServer,
  stopBaichuanWebhookServer,
  restartBaichuanWebhookServer,
  getBaichuanWebhookServerStatus,
  getCameraBaichuanWebhookPath,
  getCameraBaichuanWebhookUrl,
  getRecentBaichuanWebhookEvents,
  emitSyntheticBaichuanWebhookEventForTest,
  type BaichuanWebhookEvent,
} from "../baichuan-webhook-server.js";
import { getCameras, getSettings, saveSettings } from "../settings-store.js";
import { getOrCreateApiConnection } from "../rtsp-manager.js";

const SettingsInputSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  bindHost: z.string().optional(),
  pathPrefix: z.string().optional(),
});

function serializeEvent(event: BaichuanWebhookEvent) {
  return {
    cameraId: event.cameraId,
    event: event.event,
    reason: event.reason,
    receivedAtMs: event.receivedAtMs,
  };
}

function pickRecommendedHost(): string {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

export const baichuanWebhookRouter = router({
  status: publicProcedure
    .meta({ description: "Get Baichuan HaCfg webhook HTTP server status" })
    .query(() => getBaichuanWebhookServerStatus()),

  getSettings: publicProcedure
    .meta({ description: "Get Baichuan webhook configuration" })
    .query(() => getSettings().baichuanWebhook),

  updateSettings: publicProcedure
    .meta({
      description:
        "Update Baichuan webhook configuration. Restarts the server when already running.",
    })
    .input(SettingsInputSchema)
    .mutation(async ({ input }) => {
      const settings = getSettings();
      const wasRunning = getBaichuanWebhookServerStatus().running;
      const merged = { ...settings.baichuanWebhook, ...input };
      saveSettings({ ...settings, baichuanWebhook: merged });
      if (wasRunning) {
        await restartBaichuanWebhookServer();
      } else if (merged.enabled) {
        await startBaichuanWebhookServer();
      }
      return merged;
    }),

  start: publicProcedure
    .meta({ description: "Start the Baichuan webhook HTTP server" })
    .mutation(async () => {
      await startBaichuanWebhookServer();
      return getBaichuanWebhookServerStatus();
    }),

  stop: publicProcedure
    .meta({ description: "Stop the Baichuan webhook HTTP server" })
    .mutation(async () => {
      await stopBaichuanWebhookServer();
      return getBaichuanWebhookServerStatus();
    }),

  restart: publicProcedure
    .meta({ description: "Restart the Baichuan webhook HTTP server" })
    .mutation(async () => {
      await restartBaichuanWebhookServer();
      return getBaichuanWebhookServerStatus();
    }),

  getRecommendedHost: publicProcedure
    .meta({
      description:
        "Suggest a LAN IPv4 the cameras can reach for HaCfg webhook URLs.",
    })
    .query(() => ({ host: pickRecommendedHost() })),

  getCameraUrl: publicProcedure
    .meta({
      description:
        "Build the HaCfg webhook URL for a camera given a manager host.",
    })
    .input(
      z.object({
        cameraId: z.string().min(1),
        managerHost: z.string().min(1).optional(),
      }),
    )
    .query(({ input }) => {
      const cameras = getCameras();
      const camera = cameras.find(
        (c) => c.id === input.cameraId || c.name === input.cameraId,
      );
      if (!camera) throw new Error(`Unknown camera ${input.cameraId}`);
      const host = input.managerHost ?? pickRecommendedHost();
      return {
        cameraId: camera.id,
        cameraName: camera.name,
        path: getCameraBaichuanWebhookPath(camera.id),
        url: getCameraBaichuanWebhookUrl(camera.id, host),
        managerHost: host,
      };
    }),

  setupCamera: publicProcedure
    .meta({
      description:
        "Arm HaCfg on the camera (cmd 807) so it POSTs wake/sleep events to the local manager webhook intake. Probes support first.",
    })
    .input(
      z.object({
        cameraId: z.string().min(1),
        managerHost: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const cameras = getCameras();
      const camera = cameras.find(
        (c) => c.id === input.cameraId || c.name === input.cameraId,
      );
      if (!camera) throw new Error(`Unknown camera ${input.cameraId}`);

      const status = getBaichuanWebhookServerStatus();
      if (!status.running) {
        await startBaichuanWebhookServer();
      }

      const host = input.managerHost ?? pickRecommendedHost();
      const url = getCameraBaichuanWebhookUrl(camera.id, host);
      const api = await getOrCreateApiConnection(camera.id);
      const supported = await api.probeBaichuanWebhookSupport();
      if (!supported) {
        throw new Error(
          `Camera ${camera.name} does not support Baichuan HaCfg webhook (cmd 806)`,
        );
      }
      const result = await api.setupBaichuanWebhookToManager({ url });
      // Mirror reolink_aio: also send cmd 31 while connected.
      try {
        await api.subscribeEvents();
      } catch {
        /* best-effort */
      }
      return { ...result, url, managerHost: host, cameraId: camera.id };
    }),

  recentEvents: publicProcedure
    .meta({
      description:
        "Return the last N Baichuan webhook events (most recent first, cap 300).",
    })
    .input(
      z
        .object({ limit: z.number().int().min(1).max(300).default(50) })
        .default({ limit: 50 }),
    )
    .query(({ input }) =>
      getRecentBaichuanWebhookEvents(input.limit).map(serializeEvent),
    ),

  injectTestEvent: publicProcedure
    .meta({ description: "Inject a synthetic Baichuan webhook event (test)." })
    .input(
      z.object({
        cameraId: z.string().min(1),
        event: z.string().default("wake"),
        reason: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const event: BaichuanWebhookEvent = {
        cameraId: input.cameraId,
        event: input.event,
        ...(input.reason ? { reason: input.reason } : {}),
        receivedAtMs: Date.now(),
        raw: {
          kind: "event",
          event: input.event,
          ...(input.reason ? { reason: input.reason } : {}),
          data: {
            event: input.event,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        },
      };
      emitSyntheticBaichuanWebhookEventForTest(event);
      return serializeEvent(event);
    }),
});
