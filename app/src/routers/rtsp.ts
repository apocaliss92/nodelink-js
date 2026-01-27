import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import {
  startRtspServer,
  stopRtspServer,
  restartRtspServer,
  getRtspServerInfo,
  getAllRtspServersInfo,
  getCameraRtspServers,
  startAllCameraStreams,
  stopAllCameraStreams,
  autoStartRtspServers,
  stopAllRtspServers,
  sanitizeCameraName,
  getRtspServerKey,
  getSuggestedPort,
  isPortAvailable,
} from "../rtsp-manager.js";
import { setStreamAutoStart } from "../settings-store.js";

export const rtspRouter = router({
  // List all RTSP servers
  list: publicProcedure
    .meta({ description: "List all RTSP servers and their status" })
    .query(() => {
      return getAllRtspServersInfo();
    }),

  // Get RTSP servers for a specific camera
  listByCamera: publicProcedure
    .meta({ description: "List all RTSP servers for a specific camera" })
    .input(z.object({ cameraId: z.string() }))
    .query(({ input }) => {
      return getCameraRtspServers(input.cameraId);
    }),

  // Get single RTSP server info
  get: publicProcedure
    .meta({ description: "Get RTSP server info for a camera stream" })
    .input(
      z.object({
        cameraId: z.string(),
        profile: z.enum(["main", "sub", "ext"]).optional(),
        channel: z.number().optional(),
      }),
    )
    .query(({ input }) => {
      return getRtspServerInfo(input.cameraId, {
        profile: input.profile,
        channel: input.channel,
      });
    }),

  // Start RTSP server
  start: publicProcedure
    .meta({
      description:
        "Start RTSP server for a camera stream. Authentication uses global credentials from settings.",
    })
    .input(
      z.object({
        cameraId: z.string(),
        port: z.number().optional(),
        profile: z.enum(["main", "sub", "ext"]).optional(),
        channel: z.number().optional(),
        requireAuth: z
          .boolean()
          .optional()
          .describe("Override global rtspRequireAuth setting"),
      }),
    )
    .mutation(async ({ input }) => {
      const { cameraId, ...options } = input;
      return startRtspServer(cameraId, options);
    }),

  // Stop RTSP server
  stop: publicProcedure
    .meta({ description: "Stop RTSP server for a camera stream" })
    .input(
      z.object({
        cameraId: z.string(),
        profile: z.enum(["main", "sub", "ext"]).optional(),
        channel: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await stopRtspServer(input.cameraId, {
        profile: input.profile,
        channel: input.channel,
      });
      return { success: true };
    }),

  // Restart RTSP server
  restart: publicProcedure
    .meta({ description: "Restart RTSP server for a camera stream" })
    .input(
      z.object({
        cameraId: z.string(),
        profile: z.enum(["main", "sub", "ext"]).optional(),
        channel: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return restartRtspServer(input.cameraId, {
        profile: input.profile,
        channel: input.channel,
      });
    }),

  // Start all streams for a camera
  startCameraStreams: publicProcedure
    .meta({ description: "Start all configured RTSP streams for a camera" })
    .input(z.object({ cameraId: z.string() }))
    .mutation(async ({ input }) => {
      return startAllCameraStreams(input.cameraId);
    }),

  // Stop all streams for a camera
  stopCameraStreams: publicProcedure
    .meta({ description: "Stop all RTSP streams for a camera" })
    .input(z.object({ cameraId: z.string() }))
    .mutation(async ({ input }) => {
      await stopAllCameraStreams(input.cameraId);
      return { success: true };
    }),

  // Start all enabled RTSP servers
  startAll: publicProcedure
    .meta({ description: "Start all enabled RTSP servers" })
    .mutation(async () => {
      await autoStartRtspServers();
      return { success: true };
    }),

  // Stop all RTSP servers
  stopAll: publicProcedure
    .meta({ description: "Stop all RTSP servers" })
    .mutation(async () => {
      await stopAllRtspServers();
      return { success: true };
    }),

  // Utility: get sanitized camera name
  getSanitizedName: publicProcedure
    .meta({ description: "Get sanitized camera name for RTSP URL path" })
    .input(z.object({ name: z.string() }))
    .query(({ input }) => {
      return { sanitized: sanitizeCameraName(input.name) };
    }),

  // Utility: get stream key
  getStreamKey: publicProcedure
    .meta({ description: "Get the unique stream key for a camera stream" })
    .input(
      z.object({
        cameraId: z.string(),
        profile: z.enum(["main", "sub", "ext"]),
        channel: z.number(),
      }),
    )
    .query(({ input }) => {
      return {
        streamKey: getRtspServerKey(
          input.cameraId,
          input.profile,
          input.channel,
        ),
      };
    }),

  // Utility: get suggested port for a new stream
  getSuggestedPort: publicProcedure
    .meta({
      description: "Get the next available port for starting an RTSP server",
    })
    .query(async () => {
      const port = await getSuggestedPort();
      return { port };
    }),

  // Utility: check if a port is available
  checkPort: publicProcedure
    .meta({ description: "Check if a specific port is available" })
    .input(z.object({ port: z.number() }))
    .query(async ({ input }) => {
      const available = await isPortAvailable(input.port);
      return { port: input.port, available };
    }),

  // Set autoStart flag for a stream
  setAutoStart: publicProcedure
    .meta({ description: "Set the autoStart flag for a specific stream" })
    .input(
      z.object({
        cameraId: z.string(),
        profile: z.enum(["main", "sub", "ext"]),
        channel: z.number(),
        autoStart: z.boolean(),
      }),
    )
    .mutation(({ input }) => {
      const success = setStreamAutoStart(
        input.cameraId,
        input.profile,
        input.channel,
        input.autoStart,
      );
      return { success };
    }),
});
