import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";
import { getRtspProxy, startRtspProxy, stopRtspProxy } from "../rtsp-proxy.js";
import { getSettings, saveSettings } from "../settings-store.js";

// Port is controlled by environment variable
const RTSP_PORT = Number(process.env.RTSP_PORT) || 8554;

export const rtspProxyRouter = router({
  // Get proxy status
  getStatus: publicProcedure.query(() => {
    const proxy = getRtspProxy();
    const settings = getSettings();

    if (!proxy) {
      return {
        enabled: settings.rtspProxyEnabled,
        running: false,
        port: RTSP_PORT,
        host: "0.0.0.0",
        connections: 0,
        streams: [],
      };
    }

    const status = proxy.getStatus();
    const streams = proxy.listAvailableStreams();

    return {
      enabled: settings.rtspProxyEnabled,
      running: status.running,
      port: status.port,
      host: status.host,
      connections: status.connections,
      streams,
    };
  }),

  // Start proxy
  start: publicProcedure.mutation(async () => {
    const settings = getSettings();
    if (!settings.rtspProxyEnabled) {
      throw new Error("RTSP Proxy is disabled in settings");
    }

    await startRtspProxy();
    return { success: true };
  }),

  // Stop proxy
  stop: publicProcedure.mutation(async () => {
    await stopRtspProxy();
    return { success: true };
  }),

  // Update proxy settings
  updateSettings: publicProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        // port is controlled by RTSP_PORT env var, not configurable at runtime
      }),
    )
    .mutation(async ({ input }) => {
      const settings = getSettings();

      if (input.enabled !== undefined) {
        settings.rtspProxyEnabled = input.enabled;
      }

      saveSettings(settings);

      // Restart proxy if running and settings changed
      const proxy = getRtspProxy();
      if (proxy && proxy.getStatus().running) {
        await stopRtspProxy();
        if (settings.rtspProxyEnabled) {
          await startRtspProxy();
        }
      }

      return { success: true };
    }),

  // List available streams
  listStreams: publicProcedure.query(() => {
    const proxy = getRtspProxy();
    if (!proxy) {
      return [];
    }
    return proxy.listAvailableStreams();
  }),
});
