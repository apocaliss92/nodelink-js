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
          isNvr: camConfig?.isNvr ?? false,
          debugLogs: camConfig?.debugLogs ?? false,
          autoStart: camConfig?.autoStart ?? false,
          rtspStreams: camConfig?.rtspStreams ?? [],
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
        isNvr: camConfig?.isNvr ?? false,
        debugLogs: camConfig?.debugLogs ?? false,
        autoStart: camConfig?.autoStart ?? false,
        rtspStreams: camConfig?.rtspStreams ?? [],
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
        isNvr: z.boolean().default(false),
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
          // Don't pass channel for auto-detect - use host device info (cmdId 80)
          // Channel would use cmdId 318 which returns empty on standalone cameras
          const result = await testCameraConnection(
            input.host,
            input.port,
            input.username,
            input.password,
            // Don't pass channel here
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

      // Connect to camera immediately after adding (don't await - let it happen in background)
      getOrCreateApiConnection(camera.id).catch(() => {
        // Ignore connection errors - the UI will show the disconnected state
      });

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
        isNvr: z.boolean().optional(),
        debugLogs: z.boolean().optional(),
        autoStart: z.boolean().optional(),
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

  // Toggle auto-start for a camera
  setAutoStart: publicProcedure
    .meta({ description: "Enable/disable auto-start for a camera" })
    .input(z.object({ id: z.string(), autoStart: z.boolean() }))
    .mutation(({ input }) => {
      updateCamera(input.id, { autoStart: input.autoStart });
      return { success: true };
    }),

  // Toggle debug logs for a camera and optionally reconnect to apply immediately
  setDebug: publicProcedure
    .meta({
      description: "Enable/disable per-camera debug and optionally reconnect",
    })
    .input(
      z.object({
        id: z.string(),
        enabled: z.boolean(),
        reconnect: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input }) => {
      updateCamera(input.id, { debugLogs: input.enabled });

      if (input.reconnect) {
        await stopAllCameraStreams(input.id);
        await closeApiConnection(input.id);
        await getOrCreateApiConnection(input.id);
      }

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
        "Get available native streams for a camera using buildVideoStreamOptions. For multifocal devices, discovers streams for both wide and tele channels.",
    })
    .input(
      z.object({
        id: z.string(),
        channel: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getOrCreateApiConnection(input.id);
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      const isNvr = camera?.isNvr ?? false;

      // Check if device is multifocal (dual-lens: TrackMix, Duo)
      let isMultifocal = false;
      let dualLensChannels: Array<{ channel: number; lensType?: string }> = [];
      try {
        const rtspChannel = camera?.rtspChannel ?? 0;
        const analysis = await api.getDualLensChannelInfo(rtspChannel, {
          onNvr: isNvr,
        });
        if (analysis.isDualLens && analysis.channels.length > 0) {
          isMultifocal = true;
          dualLensChannels = analysis.channels.map((ch) => ({
            channel: ch.channel,
            lensType: ch.lensType,
          }));
        }
      } catch {
        // Not multifocal or getDualLensChannelInfo failed
      }

      const allNativeStreams: Array<{
        id: string;
        profile: "main" | "sub" | "ext";
        channel: number;
        lensType?: "wide" | "telephoto" | "composite";
        resolution?: string;
        codec?: string;
      }> = [];
      const seenIds = new Set<string>();

      if (isMultifocal) {
        // For multifocal: get streams for each channel (wide, tele) and composite
        for (const { channel: ch, lensType } of dualLensChannels) {
          try {
            const opts = await api.buildVideoStreamOptions({
              channel: ch,
              onNvr: isNvr,
            });
            for (const s of opts.nativeStreams) {
              const id = `${s.id}-ch${ch}`;
              if (seenIds.has(id)) continue;
              seenIds.add(id);
              allNativeStreams.push({
                id,
                profile: s.profile,
                channel: ch,
                lensType:
                  lensType === "wide"
                    ? "wide"
                    : lensType === "telephoto"
                      ? "telephoto"
                      : undefined,
                resolution: s.metadata
                  ? `${s.metadata.width}x${s.metadata.height}`
                  : undefined,
                codec: s.metadata?.videoEncType,
              });
            }
          } catch {
            // Skip channel if buildVideoStreamOptions fails
          }
        }
      }

      // If not multifocal or no streams found, use single-channel logic
      if (allNativeStreams.length === 0) {
        const streamOptions = await api.buildVideoStreamOptions({
          channel: input.channel,
          onNvr: isNvr,
        });
        for (const s of streamOptions.nativeStreams) {
          allNativeStreams.push({
            id: s.id,
            profile: s.profile,
            channel: s.channel ?? input.channel ?? 0,
            resolution: s.metadata
              ? `${s.metadata.width}x${s.metadata.height}`
              : undefined,
            codec: s.metadata?.videoEncType,
          });
        }
      }

      return {
        nativeStreams: allNativeStreams,
        rtspStreams: [], // Kept for API compatibility
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

  // Get controls state (light, siren, PTZ capabilities and current state)
  getControlsState: publicProcedure
    .meta({
      description:
        "Get camera controls state: light, siren, PTZ capabilities and current values",
    })
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) return null;
      const channel = camera.rtspChannel ?? 0;

      const api = await getOrCreateApiConnection(input.id);
      const caps = await api.getDeviceCapabilities(channel);
      const cap = caps?.capabilities ?? {};
      const support = caps?.support;

      const hasFloodlight = cap.hasFloodlight === true;
      const hasSiren = cap.hasSiren === true;
      const hasPtz =
        cap.hasPtz === true ||
        (support?.ptzMode &&
          support.ptzMode.toLowerCase() !== "none" &&
          support.ptzMode !== "0");
      const hasPresets = cap.hasPresets === true;

      let lightOn: boolean | undefined;
      let sirenOn: boolean | undefined;
      let ptzPresets: Array<{ id: number; name: string }> | undefined;

      if (hasFloodlight) {
        try {
          const st = await api.getWhiteLedState(channel);
          lightOn = st?.enable === 1;
        } catch {
          // ignore
        }
      }
      if (hasSiren) {
        try {
          const st = await api.getSiren(channel);
          sirenOn = st?.enable === 1;
        } catch {
          // ignore
        }
      }
      if (hasPresets || hasPtz) {
        try {
          ptzPresets = await api.getPtzPresets(channel);
        } catch {
          // ignore
        }
      }

      return {
        hasFloodlight,
        hasSiren,
        hasPtz,
        hasPresets,
        lightOn,
        sirenOn,
        ptzPresets: ptzPresets ?? [],
      };
    }),

  // Get active sessions on the camera
  getSessions: publicProcedure
    .meta({ description: "Get active user sessions on the camera" })
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) return { sessions: [], total: 0 };

      const api = await getOrCreateApiConnection(input.id);
      const result = await api.getOnlineUserList({ timeoutMs: 5000 });

      const list = result?.body?.OnlineUserList;
      const sessions: Array<{
        userName: string;
        ip: string;
        sessionId: number;
        level: number;
      }> = [];

      // Parse both legacy and current formats
      if (list?.OnlineUser) {
        for (const u of list.OnlineUser) {
          sessions.push({
            userName: u.userName ?? "?",
            ip: u.ipAddress ?? "?",
            sessionId: u.sessionId ?? 0,
            level: u.userLevel ?? 0,
          });
        }
      } else if (list?.item) {
        for (const u of list.item) {
          sessions.push({
            userName: u.userName ?? "?",
            ip: u.ip ?? "?",
            sessionId: 0,
            level: u.level ?? 0,
          });
        }
      }

      return {
        sessions,
        total: list?.itemNum ?? sessions.length,
      };
    }),

  // Set light (floodlight/spotlight) on/off
  setLight: publicProcedure
    .meta({ description: "Set camera light (floodlight) on or off" })
    .input(z.object({ id: z.string(), on: z.boolean() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.setWhiteLedState(camera.rtspChannel ?? 0, input.on);
      return { success: true };
    }),

  // Set siren/alarm on/off
  setSiren: publicProcedure
    .meta({ description: "Set camera siren/alarm on or off" })
    .input(z.object({ id: z.string(), on: z.boolean() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.setSiren(camera.rtspChannel ?? 0, input.on);
      return { success: true };
    }),

  // PTZ control (pan, tilt, zoom, presets)
  ptzControl: publicProcedure
    .meta({ description: "Send PTZ command to camera" })
    .input(
      z.object({
        id: z.string(),
        command: z.enum([
          "Up",
          "Down",
          "Left",
          "Right",
          "ZoomIn",
          "ZoomOut",
          "FocusNear",
          "FocusFar",
        ]),
        action: z.enum(["start", "stop"]).default("start"),
        speed: z.number().min(1).max(64).optional().default(32),
        autoStopMs: z.number().optional().default(500),
      }),
    )
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.ptz(camera.rtspChannel ?? 0, {
        command: input.command,
        action: input.action,
        speed: input.speed,
        autoStopMs: input.autoStopMs,
      });
      return { success: true };
    }),

  // Go to PTZ preset
  ptzGotoPreset: publicProcedure
    .meta({ description: "Move camera to PTZ preset" })
    .input(
      z.object({
        id: z.string(),
        preset: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.moveToPtzPreset(camera.rtspChannel ?? 0, input.preset);
      return { success: true };
    }),
});
