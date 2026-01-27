import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import {
  getConfig,
  addCamera,
  updateCamera,
  deleteCamera,
} from "../settings-store.js";
import {
  getOrCreateApiConnection,
  closeApiConnection,
  getCameraInfo,
  getAllCamerasInfo,
  testCameraConnection,
  getCameraRtspServers,
  startAllCameraStreams,
  stopAllCameraStreams,
  sanitizeCameraName,
} from "../rtsp-manager.js";
import { RtspStreamConfigSchema } from "../types.js";

export const camerasRouter = router({
  // List all cameras with their RTSP server status
  list: publicProcedure
    .meta({ description: "List all configured cameras with RTSP status" })
    .query(() => {
      const config = getConfig();
      const cameras = getAllCamerasInfo();
      // Enrich with RTSP server info and config data
      return cameras.map((cam) => {
        const camConfig = config.cameras.find((c) => c.id === cam.id);
        return {
          ...cam,
          rtspServers: getCameraRtspServers(cam.id),
          sanitizedName: sanitizeCameraName(cam.name),
          rtspChannel: camConfig?.rtspChannel ?? 0,
          debugLogs: camConfig?.debugLogs ?? false,
          rtspStreams: camConfig?.rtspStreams ?? [], // Include stream configs with autoStart
        };
      });
    }),

  // Get single camera with RTSP servers
  get: publicProcedure
    .meta({ description: "Get a single camera by ID with RTSP servers" })
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const config = getConfig();
      const cam = getCameraInfo(input.id);
      if (!cam) return null;
      const camConfig = config.cameras.find((c) => c.id === input.id);
      return {
        ...cam,
        rtspServers: getCameraRtspServers(input.id),
        sanitizedName: sanitizeCameraName(cam.name),
        rtspChannel: camConfig?.rtspChannel ?? 0,
        debugLogs: camConfig?.debugLogs ?? false,
        rtspStreams: camConfig?.rtspStreams ?? [], // Include stream configs with autoStart
      };
    }),

  // Add new camera
  add: publicProcedure
    .meta({ description: "Add a new camera" })
    .input(
      z.object({
        name: z.string().optional(), // Optional: will be auto-detected if not provided
        host: z.string(),
        port: z.number().default(9000),
        username: z.string(),
        password: z.string(),
        channels: z.number().default(1),
        debugLogs: z.boolean().default(false),
        rtspStreams: z.array(RtspStreamConfigSchema).default([]),
        // Legacy support
        rtspEnabled: z.boolean().default(false),
        rtspPort: z.number().optional(),
        rtspProfile: z.enum(["main", "sub", "ext"]).default("main"),
        rtspChannel: z.number().default(0),
      }),
    )
    .mutation(async ({ input }) => {
      let cameraName = input.name;

      // Auto-detect name if not provided
      if (!cameraName) {
        try {
          const result = await testCameraConnection(
            input.host,
            input.port,
            input.username,
            input.password,
            input.rtspChannel, // Pass channel for Hub/NVR to get correct camera info
          );
          if (result.success && result.info?.name) {
            cameraName = result.info.name;
          } else if (result.success && result.info?.type) {
            // Fallback to device type if name not available
            cameraName = result.info.type;
          } else {
            // Ultimate fallback to host
            cameraName = input.host;
          }
        } catch {
          // If connection test fails, use host as fallback
          cameraName = input.host;
        }
      }

      const camera = addCamera({ ...input, name: cameraName ?? input.host });
      return camera;
    }),

  // Update camera
  update: publicProcedure
    .meta({ description: "Update camera configuration" })
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        host: z.string().optional(),
        port: z.number().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        channels: z.number().optional(),
        debugLogs: z.boolean().optional(),
        rtspStreams: z.array(RtspStreamConfigSchema).optional(),
        // Legacy support
        rtspEnabled: z.boolean().optional(),
        rtspPort: z.number().optional(),
        rtspProfile: z.enum(["main", "sub", "ext"]).optional(),
        rtspChannel: z.number().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      return updateCamera(id, updates);
    }),

  // Update RTSP streams configuration for a camera
  updateRtspStreams: publicProcedure
    .meta({ description: "Update RTSP streams configuration for a camera" })
    .input(
      z.object({
        id: z.string(),
        rtspStreams: z.array(RtspStreamConfigSchema),
      }),
    )
    .mutation(({ input }) => {
      return updateCamera(input.id, { rtspStreams: input.rtspStreams });
    }),

  // Delete camera
  delete: publicProcedure
    .meta({ description: "Delete a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await stopAllCameraStreams(input.id);
      await closeApiConnection(input.id);
      deleteCamera(input.id);
      return { success: true };
    }),

  // Test connection
  testConnection: publicProcedure
    .meta({ description: "Test connection to a camera" })
    .input(
      z.object({
        host: z.string(),
        port: z.number().default(9000),
        username: z.string(),
        password: z.string(),
        channel: z.number().optional(), // For Hub/NVR: specify channel to get correct camera info
      }),
    )
    .mutation(async ({ input }) => {
      return testCameraConnection(
        input.host,
        input.port,
        input.username,
        input.password,
        input.channel,
      );
    }),

  // Connect to camera
  connect: publicProcedure
    .meta({ description: "Connect to a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await getOrCreateApiConnection(input.id);
      return { success: true };
    }),

  // Disconnect from camera
  disconnect: publicProcedure
    .meta({ description: "Disconnect from a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Stop all streams first when disconnecting
      await stopAllCameraStreams(input.id);
      await closeApiConnection(input.id);
      return { success: true };
    }),

  // Get device info for a connected camera
  getDeviceInfo: publicProcedure
    .meta({ description: "Get device information from a camera" })
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const api = await getOrCreateApiConnection(input.id);
      const info = await api.getInfo();
      const channels = await api.getChannelCount();
      return { ...info, channelCount: channels };
    }),

  // Get available native streams for a camera
  getAvailableStreams: publicProcedure
    .meta({
      description:
        "Get available native streams for a camera using buildVideoStreamOptions",
    })
    .input(
      z.object({
        id: z.string(),
        channel: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getOrCreateApiConnection(input.id);
      const streamOptions = await api.buildVideoStreamOptions({
        channel: input.channel,
      });
      // Return nativeStreams which contains the available profiles
      return {
        nativeStreams: streamOptions.nativeStreams.map((s) => ({
          id: s.id,
          profile: s.profile,
          channel: s.channel,
          resolution: s.metadata
            ? `${s.metadata.width}x${s.metadata.height}`
            : undefined,
          codec: s.metadata?.videoEncType,
        })),
        rtspStreams: streamOptions.rtspStreams.map((s) => ({
          id: s.id,
          profile: s.profile,
          url: s.url,
        })),
      };
    }),

  // Start all RTSP streams for a camera
  startAllStreams: publicProcedure
    .meta({ description: "Start all configured RTSP streams for a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return startAllCameraStreams(input.id);
    }),

  // Stop all RTSP streams for a camera
  stopAllStreams: publicProcedure
    .meta({ description: "Stop all RTSP streams for a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await stopAllCameraStreams(input.id);
      return { success: true };
    }),

  // Get sanitized name for a camera
  getSanitizedName: publicProcedure
    .meta({ description: "Get sanitized camera name for RTSP paths" })
    .input(z.object({ name: z.string() }))
    .query(({ input }) => {
      return { sanitized: sanitizeCameraName(input.name) };
    }),
});
