import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import * as configStore from "../settings-store.js";
import * as connectionManager from "../connection-manager.js";
import { CameraConfigSchema, RtspServerConfigSchema } from "../types";

export const configRouter = router({
  // ============ CAMERAS ============

  listCameras: publicProcedure.query(() => {
    return configStore.getCameras();
  }),

  getCamera: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const camera = configStore.getCamera(input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      return camera;
    }),

  addCamera: publicProcedure
    .input(
      CameraConfigSchema.omit({ id: true }).extend({
        id: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const id = input.id || `cam_${Date.now()}`;
      return configStore.addCamera({ ...input, id });
    }),

  updateCamera: publicProcedure
    .input(
      z.object({
        id: z.string(),
        updates: CameraConfigSchema.partial(),
      }),
    )
    .mutation(({ input }) => {
      const result = configStore.updateCamera(input.id, input.updates);
      if (!result) throw new Error(`Camera not found: ${input.id}`);
      return result;
    }),

  deleteCamera: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      const deleted = configStore.deleteCamera(input.id);
      if (!deleted) throw new Error(`Camera not found: ${input.id}`);
      return { success: true };
    }),

  testCamera: publicProcedure
    .input(
      z.object({
        host: z.string(),
        port: z.number().default(9000),
        username: z.string(),
        password: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await connectionManager.getConnection(
        input.host,
        input.port,
        input.username,
        input.password,
      );
      const info = await api.getInfo();
      return {
        success: true,
        deviceInfo: info,
      };
    }),

  // ============ RTSP SERVERS ============

  listRtspServers: publicProcedure.query(() => {
    const servers = configStore.getRtspServers();
    return servers.map((s) => ({
      ...s,
      running: connectionManager.isRtspServerRunning(s.id),
      camera: configStore.getCamera(s.cameraId),
    }));
  }),

  getActiveRtspServers: publicProcedure.query(() => {
    return connectionManager.getActiveRtspServers();
  }),

  addRtspServer: publicProcedure
    .input(
      RtspServerConfigSchema.omit({ id: true }).extend({
        id: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      // Verify camera exists
      const camera = configStore.getCamera(input.cameraId);
      if (!camera) throw new Error(`Camera not found: ${input.cameraId}`);

      const id = input.id || `rtsp_${Date.now()}`;
      return configStore.addRtspServer({ ...input, id });
    }),

  updateRtspServer: publicProcedure
    .input(
      z.object({
        id: z.string(),
        updates: RtspServerConfigSchema.partial(),
      }),
    )
    .mutation(({ input }) => {
      const result = configStore.updateRtspServer(input.id, input.updates);
      if (!result) throw new Error(`RTSP server not found: ${input.id}`);
      return result;
    }),

  deleteRtspServer: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Stop if running
      await connectionManager.stopRtspServer(input.id);
      const deleted = configStore.deleteRtspServer(input.id);
      if (!deleted) throw new Error(`RTSP server not found: ${input.id}`);
      return { success: true };
    }),

  startRtspServer: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const url = await connectionManager.startRtspServer(input.id);
      return { success: true, url };
    }),

  stopRtspServer: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await connectionManager.stopRtspServer(input.id);
      return { success: true };
    }),

  startAllRtspServers: publicProcedure.mutation(async () => {
    const servers = configStore.getRtspServers();
    const results: Array<{
      id: string;
      success: boolean;
      url?: string;
      error?: string;
    }> = [];

    for (const server of servers) {
      try {
        const url = await connectionManager.startRtspServer(server.id);
        results.push({ id: server.id, success: true, url });
      } catch (error) {
        results.push({
          id: server.id,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return results;
  }),

  stopAllRtspServers: publicProcedure.mutation(async () => {
    await connectionManager.stopAllRtspServers();
    return { success: true };
  }),
});
