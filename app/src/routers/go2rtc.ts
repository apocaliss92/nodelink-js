import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import {
  getGo2rtcManager,
  resolveGo2rtcBinary,
} from "../go2rtc-manager.js";
import { getSettings, saveSettings } from "../settings-store.js";

export const go2rtcRouter = router({
  /** Get go2rtc status. */
  status: publicProcedure
    .meta({ description: "Get go2rtc process status and registered streams" })
    .query(async () => {
      const settings = getSettings();
      const mgr = getGo2rtcManager();
      const streams = mgr?.isRunning ? await mgr.getStreams() : {};
      return {
        running: mgr?.isRunning ?? false,
        apiUrl: mgr?.apiUrl ?? null,
        rtspPort: Number(process.env.GO2RTC_RTSP_PORT) || (settings.go2rtc?.rtspPort ?? 18554),
        streams,
      };
    }),

  /** Get go2rtc settings. */
  getSettings: publicProcedure
    .meta({ description: "Get go2rtc configuration" })
    .query(() => {
      const settings = getSettings();
      return settings.go2rtc;
    }),

  /** Update go2rtc settings. */
  updateSettings: publicProcedure
    .meta({ description: "Update go2rtc configuration" })
    .input(
      z.object({
        binaryPath: z.string().optional(),
        apiPort: z.number().int().min(1).max(65535).optional(),
        rtspPort: z.number().int().min(1).max(65535).optional(),
        webrtcPort: z.number().int().min(1).max(65535).optional(),
        iceServers: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const settings = getSettings();
      const updated = { ...settings.go2rtc, ...input };
      saveSettings({ ...settings, go2rtc: updated });
      return updated;
    }),

  /** Restart go2rtc process. */
  restart: publicProcedure
    .meta({ description: "Restart go2rtc process" })
    .mutation(async () => {
      const mgr = getGo2rtcManager();
      if (mgr) {
        await mgr.restart();
        return { success: true };
      }
      return { success: false, error: "go2rtc is not initialized" };
    }),

  /** List streams registered in go2rtc. */
  listStreams: publicProcedure
    .meta({ description: "List all streams registered in go2rtc" })
    .query(async () => {
      const mgr = getGo2rtcManager();
      if (!mgr?.isRunning) return {};
      return mgr.getStreams();
    }),

  /** Add a custom stream to go2rtc (manual source URL). */
  addStream: publicProcedure
    .meta({ description: "Add a custom stream source to go2rtc" })
    .input(
      z.object({
        name: z.string().min(1),
        sourceUrl: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const mgr = getGo2rtcManager();
      if (!mgr?.isRunning) {
        throw new Error("go2rtc is not running");
      }
      await mgr.addStream(input.name, input.sourceUrl);
      return { success: true };
    }),

  /** Remove a stream from go2rtc. */
  removeStream: publicProcedure
    .meta({ description: "Remove a stream from go2rtc" })
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const mgr = getGo2rtcManager();
      if (!mgr?.isRunning) {
        throw new Error("go2rtc is not running");
      }
      await mgr.removeStream(input.name);
      return { success: true };
    }),

  /** Ensure go2rtc binary is available (downloads if missing). */
  ensureBinary: publicProcedure
    .meta({ description: "Download go2rtc binary if not present" })
    .mutation(async () => {
      const settings = getSettings();
      const binaryPath = settings.go2rtc?.binaryPath ?? "go2rtc";
      const resolved = resolveGo2rtcBinary(binaryPath);
      return { success: true, path: resolved };
    }),
});
