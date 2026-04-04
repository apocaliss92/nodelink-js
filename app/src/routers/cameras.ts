import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { captureModelFixtures, zipDirectory, autoDetectDeviceType } from "@apocaliss92/nodelink-js";
import type { AutoDetectResult } from "@apocaliss92/nodelink-js";
import {
  getConfig,
  addCamera,
  updateCamera,
  deleteCamera,
  addNvr,
  deleteNvr,
  getNvrs,
  getNvr,
} from "../settings-store.js";
import {
  getOrCreateApiConnection,
  closeApiConnection,
  connectNvr,
  disconnectNvr,
  enableNvrCamera,
  disableNvrCamera,
  getCameraInfo,
  getAllCamerasInfo,
  testCameraConnection,
  getCameraRtspServers,
  startAllCameraStreams,
  stopAllCameraStreams,
  sanitizeCameraName,
  registerPreConnectedApi,
  createCameraConnLogger,
  clearConnLogs,
  appendConnLog,
} from "../rtsp-manager.js";
import { getCameraSleepStatus } from "../events-manager.js";
import { RtspStreamConfigSchema } from "../types.js";

// In-memory map for dump download tokens (token → zip path, expires after 10 min)
const dumpDownloads = new Map<string, { zipPath: string; expiresAt: number }>();
const DUMP_DIR = path.join(process.env.DATA_PATH || ".", "dumps");

export function getDumpZipPath(token: string): string | null {
  const entry = dumpDownloads.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    dumpDownloads.delete(token);
    return null;
  }
  return entry.zipPath;
}

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
          nvrId: camConfig?.nvrId,
          isBattery: camConfig?.isBattery ?? false,
          batteryMode: camConfig?.batteryMode ?? "streamOnly",
          sleepStatus: getCameraSleepStatus(cam.id),
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
        nvrId: camConfig?.nvrId,
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
        uid: z.string().optional(),
        transport: z.enum(["tcp", "udp", "auto"]).optional().default("auto"),
        udpDiscoveryMethod: z
          .enum(["local-broadcast", "local-direct", "remote", "map", "relay"])
          .optional(),
        // Legacy support
        rtspEnabled: z.boolean().default(false),
        rtspPort: z.number().optional(),
        rtspProfile: z.enum(["main", "sub", "ext"]).default("main"),
        rtspChannel: z.number().default(0),
      }),
    )
    .mutation(async ({ input }) => {
      // Generate camera ID early so we can stream logs during detection via SSE.
      // The camera is NOT saved to config yet — only on successful detection.
      const cameraId = crypto.randomUUID();
      const logger = createCameraConnLogger(cameraId, input.host);

      // Run autodetect in background so the mutation returns the temp ID
      // immediately and the UI can stream logs in real time.
      const detectAndRegister = async () => {
        const mode = input.transport === "tcp"
          ? "tcp" as const
          : input.transport === "udp"
            ? "udp" as const
            : "auto" as const;

        let detection: AutoDetectResult;
        try {
          detection = await autoDetectDeviceType({
            host: input.host,
            username: input.username,
            password: input.password,
            uid: input.uid,
            logger,
            mode,
            maxRetries: mode === "auto" ? 2 : 10,
            ...(input.udpDiscoveryMethod ? { udpDiscoveryMethod: input.udpDiscoveryMethod } : {}),
          });
        } catch (e) {
          const msg = (e as any)?.message || String(e);
          logger.error(`Auto-detect failed: ${msg}`);
          // Sentinel so the UI knows detection is done and failed
          appendConnLog(cameraId, "error", "__detection_failed__");
          return;
        }

        // Derive camera properties from detection result
        const deviceInfo = detection.deviceInfo ?? {};
        const cameraName = input.name || deviceInfo.name || deviceInfo.type || input.host;
        const isNvr = detection.type === "nvr" || input.isNvr;
        const isBattery = detection.hasBattery === true || detection.type === "battery-cam";
        const channelCount = detection.channelNum ?? 1;

        // Configure NVR/multifocal flags on the API before registering
        detection.api.setIsNvr(isNvr);
        if (detection.type === "multifocal") {
          detection.api.setIsMultiFocal(true);
        }

        logger.info(
          `Detected: type=${detection.type}, transport=${detection.transport}, ` +
          `channels=${channelCount}, battery=${isBattery}, model=${deviceInfo.type ?? "unknown"}`,
        );

        // NOW save the camera to config (only on success)
        addCamera({
          ...input,
          id: cameraId,
          name: cameraName,
          channels: channelCount,
          isNvr,
          isBattery,
          batteryMode: "streamOnly" as const,
          transport: detection.transport,
          uid: detection.uid || input.uid,
          udpDiscoveryMethod: detection.udpDiscoveryMethod ?? input.udpDiscoveryMethod,
          autoStart: false,
        });

        // Register the already-connected API (no redundant login)
        try {
          await registerPreConnectedApi(cameraId, detection.api);
        } catch (e) {
          logger.error(`Failed to register pre-connected API: ${(e as any)?.message || e}`);
        }

        // Sentinel so the UI knows detection succeeded
        appendConnLog(cameraId, "info", "__detection_success__");
      };

      // Fire and forget — errors are logged to the SSE stream
      detectAndRegister().catch((e) => {
        logger.error(`Unexpected error during detect: ${(e as any)?.message || e}`);
        appendConnLog(cameraId, "error", "__detection_failed__");
      });

      // Return the temp ID (camera NOT yet in config — will be added on success)
      return { id: cameraId };
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

  // Retry auto-detection for an existing camera (clears old connection, re-runs autoDetectDeviceType)
  retryDetect: publicProcedure
    .meta({ description: "Retry auto-detection for a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);

      // Close existing connection if any
      await closeApiConnection(input.id);
      clearConnLogs(input.id);

      const logger = createCameraConnLogger(input.id, camera.host);

      const mode = camera.transport === "tcp"
        ? "tcp" as const
        : camera.transport === "udp"
          ? "udp" as const
          : "auto" as const;

      // Fire and forget — logs stream via SSE
      const detectAndRegister = async () => {
        let detection: AutoDetectResult;
        try {
          detection = await autoDetectDeviceType({
            host: camera.host,
            username: camera.username,
            password: camera.password,
            uid: camera.uid,
            logger,
            mode,
            maxRetries: mode === "auto" ? 2 : 10,
            ...(camera.udpDiscoveryMethod ? { udpDiscoveryMethod: camera.udpDiscoveryMethod } : {}),
          });
        } catch (e) {
          const msg = (e as any)?.message || String(e);
          logger.error(`Auto-detect failed: ${msg}`);
          return;
        }

        const deviceInfo = detection.deviceInfo ?? {};
        const isNvr = detection.type === "nvr" || camera.isNvr;
        const isBattery = detection.hasBattery === true || detection.type === "battery-cam";
        const channelCount = detection.channelNum ?? 1;

        detection.api.setIsNvr(isNvr);
        if (detection.type === "multifocal") {
          detection.api.setIsMultiFocal(true);
        }

        logger.info(
          `Detected: type=${detection.type}, transport=${detection.transport}, ` +
          `channels=${channelCount}, battery=${isBattery}, model=${deviceInfo.type ?? "unknown"}`,
        );

        updateCamera(input.id, {
          name: camera.name === camera.host ? (deviceInfo.name || deviceInfo.type || camera.host) : camera.name,
          channels: channelCount,
          isNvr,
          isBattery,
          batteryMode: "streamOnly" as const,
          transport: detection.transport,
          uid: detection.uid || camera.uid,
          udpDiscoveryMethod: detection.udpDiscoveryMethod ?? camera.udpDiscoveryMethod,
        });

        try {
          await registerPreConnectedApi(input.id, detection.api);
        } catch (e) {
          logger.error(`Failed to register pre-connected API: ${(e as any)?.message || e}`);
        }
      };

      detectAndRegister().catch((e) => {
        logger.error(`Unexpected error during detect: ${(e as any)?.message || e}`);
      });

      return { success: true };
    }),

  // Connect to camera
  // For NVR children: enables camera for restreaming (NVR socket stays shared)
  // For standalone cameras: opens the TCP connection
  connect: publicProcedure
    .meta({ description: "Connect to a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (camera?.nvrId) {
        await enableNvrCamera(input.id);
      } else {
        await getOrCreateApiConnection(input.id);
      }
      return { success: true };
    }),

  // Disconnect from camera
  // For NVR children: disables camera from restreaming (NVR socket stays alive)
  // For standalone cameras: closes the TCP connection
  disconnect: publicProcedure
    .meta({ description: "Disconnect from a camera" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (camera?.nvrId) {
        await disableNvrCamera(input.id);
      } else {
        await stopAllCameraStreams(input.id);
        await closeApiConnection(input.id);
      }
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
      const hasAutotracking = cap.hasAutotracking === true;
      const hasPir = cap.hasPir === true;

      let lightOn: boolean | undefined;
      let sirenOn: boolean | undefined;
      let floodlightOnMotion: boolean | undefined;
      let sirenOnMotion: boolean | undefined;
      let autotrackingOn: boolean | undefined;
      let pirOn: boolean | undefined;
      let ptzPresets: Array<{ id: number; name: string }> | undefined;

      if (hasFloodlight) {
        try {
          const st = await api.getWhiteLedState(channel);
          lightOn = st?.enabled === true;
        } catch {
          // ignore
        }
        try {
          const fm = await api.getFloodlightOnMotion(channel);
          floodlightOnMotion = fm?.floodlightOnMotion === true;
        } catch {
          // ignore
        }
      }
      if (hasSiren) {
        try {
          const st = await api.getSiren(channel);
          sirenOn = st?.enabled === true;
        } catch {
          // ignore
        }
        try {
          const sm = await api.getSirenOnMotion(channel);
          sirenOnMotion = (sm as any)?.enable === 1;
        } catch {
          // ignore
        }
      }
      if (hasAutotracking) {
        try {
          const at = await api.getAutotracking(channel);
          autotrackingOn = at?.enabled === true;
        } catch {
          // ignore
        }
      }
      if (hasPir) {
        try {
          const pir = await api.getPirInfo(channel);
          pirOn = (pir as any)?.enable === 1;
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
        hasAutotracking,
        hasPir,
        lightOn,
        sirenOn,
        floodlightOnMotion,
        sirenOnMotion,
        autotrackingOn,
        pirOn,
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

  // Set floodlight on motion
  setFloodlightOnMotion: publicProcedure
    .meta({ description: "Enable/disable floodlight on motion detection" })
    .input(z.object({ id: z.string(), on: z.boolean() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.setFloodlightOnMotion(input.on, camera.rtspChannel ?? 0);
      return { success: true };
    }),

  // Set siren on motion
  setSirenOnMotion: publicProcedure
    .meta({ description: "Enable/disable siren on motion detection" })
    .input(z.object({ id: z.string(), on: z.boolean() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.setSirenOnMotion({ enable: input.on ? 1 : 0 }, camera.rtspChannel ?? 0);
      return { success: true };
    }),

  // Set autotracking
  setAutotracking: publicProcedure
    .meta({ description: "Enable/disable PTZ auto-tracking" })
    .input(z.object({ id: z.string(), on: z.boolean() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.setAutotracking(input.on, camera.rtspChannel ?? 0);
      return { success: true };
    }),

  // Set PIR sensor
  setPir: publicProcedure
    .meta({ description: "Enable/disable PIR sensor" })
    .input(z.object({ id: z.string(), on: z.boolean() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.id);
      if (!camera) throw new Error(`Camera not found: ${input.id}`);
      const api = await getOrCreateApiConnection(input.id);
      await api.setPirInfo(camera.rtspChannel ?? 0, { enable: input.on ? 1 : 0 });
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

  // Set battery mode for a camera
  setBatteryMode: publicProcedure
    .meta({ description: "Set battery behavior mode for a camera" })
    .input(z.object({ id: z.string(), mode: z.enum(["alwaysOn", "streamOnly"]) }))
    .mutation(({ input }) => {
      updateCamera(input.id, { batteryMode: input.mode });
      return { success: true };
    }),

  // ==================== NVR Management ====================

  // Connect all cameras of an NVR (shared connection)
  connectNvrDevice: publicProcedure
    .meta({ description: "Connect to an NVR (shared connection for all child cameras)" })
    .input(z.object({ nvrId: z.string() }))
    .mutation(async ({ input }) => {
      await connectNvr(input.nvrId);
      return { success: true };
    }),

  // Disconnect an NVR and all its child cameras
  disconnectNvrDevice: publicProcedure
    .meta({ description: "Disconnect an NVR and all its child cameras" })
    .input(z.object({ nvrId: z.string() }))
    .mutation(async ({ input }) => {
      await disconnectNvr(input.nvrId);
      return { success: true };
    }),

  // List all NVRs
  listNvrs: publicProcedure
    .meta({ description: "List all configured NVRs" })
    .query(() => {
      return getNvrs();
    }),

  // Add NVR
  addNvr: publicProcedure
    .meta({ description: "Add a new NVR" })
    .input(
      z.object({
        name: z.string(),
        host: z.string(),
        port: z.number().default(9000),
        username: z.string(),
        password: z.string(),
      }),
    )
    .mutation(({ input }) => {
      return addNvr(input);
    }),

  // Delete NVR and all its child cameras
  deleteNvr: publicProcedure
    .meta({ description: "Delete an NVR and all its child cameras" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Disconnect and stop streams for all child cameras
      const config = getConfig();
      const childCameras = config.cameras.filter((c) => c.nvrId === input.id);
      for (const cam of childCameras) {
        try {
          await stopAllCameraStreams(cam.id);
          await closeApiConnection(cam.id);
        } catch {
          // ignore cleanup errors
        }
      }
      deleteNvr(input.id);
      return { success: true };
    }),

  // Discover NVR channels
  discoverNvrChannels: publicProcedure
    .meta({ description: "Discover all channels on an NVR/Hub device" })
    .input(
      z.union([
        z.object({
          host: z.string(),
          port: z.number().default(9000),
          username: z.string(),
          password: z.string(),
        }),
        z.object({
          nvrId: z.string(),
        }),
      ]),
    )
    .mutation(async ({ input }) => {
      let host: string, port: number, username: string, password: string;
      if ("nvrId" in input) {
        const nvr = getNvr(input.nvrId);
        if (!nvr) return { success: false, error: "NVR not found", nvrName: "", channelCount: 0, channels: [] };
        ({ host, port, username, password } = nvr);
      } else {
        ({ host, port, username, password } = input);
      }

      const { ReolinkBaichuanApi } = await import("@apocaliss92/nodelink-js");
      const api = new ReolinkBaichuanApi({ host, port, username, password });

      try {
        await api.login();

        // Get NVR info first
        const info = await api.getInfo();
        const nvrName = info?.name ?? info?.type ?? host;

        // Discover channels
        const summary = await api.getNvrChannelsSummary({ source: "cgi" });

        const channels = summary.devices.map((d) => ({
          channel: d.channel,
          name: d.name ?? `Channel ${d.channel}`,
          model: d.model ?? "",
          uid: d.uid ?? "",
          state: d.state ?? "",
          online: d.online ?? d.state === "connect",
          isMultifocal: d.isMultifocal ?? false,
          isBattery: d.isBattery ?? false,
          isDoorbell: d.isDoorbell ?? false,
          ip: d.ip ?? "",
        }));

        return {
          success: true,
          nvrName,
          channelCount: summary.channels.length,
          channels,
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
          nvrName: "",
          channelCount: 0,
          channels: [],
        };
      } finally {
        await api.close();
      }
    }),

  // Add a camera from NVR channel discovery
  addNvrCamera: publicProcedure
    .meta({ description: "Add a camera from NVR channel discovery" })
    .input(
      z.object({
        nvrId: z.string(),
        channelName: z.string(),
        channelNumber: z.number(),
        isBattery: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const config = getConfig();
      const nvr = config.nvrs.find((n) => n.id === input.nvrId);
      if (!nvr) throw new Error("NVR not found");

      // Check if already added
      const existing = config.cameras.find(
        (c) => c.nvrId === input.nvrId && c.rtspChannel === input.channelNumber,
      );
      if (existing) throw new Error("Channel already added");

      const camera = addCamera({
        name: input.channelName,
        host: nvr.host,
        port: nvr.port,
        username: nvr.username,
        password: nvr.password,
        isNvr: true,
        nvrId: input.nvrId,
        rtspChannel: input.channelNumber,
        isBattery: input.isBattery ?? false,
        autoStart: false,
        channels: 1,
        batteryMode: "streamOnly" as const,
        transport: "auto" as const,
        debugLogs: false,
        rtspStreams: [],
        rtspEnabled: false,
        rtspProfile: "main" as const,
      });

      // Connect in background
      getOrCreateApiConnection(camera.id).catch(() => {});

      return camera;
    }),

  /**
   * Run model fixture dump for a camera.
   * Returns a download token for the resulting zip file.
   */
  dump: publicProcedure
    .meta({ description: "Dump all API responses for a camera as a zip" })
    .input(z.object({ cameraId: z.string() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.cameraId);
      if (!camera) throw new Error("Camera not found");

      const api = await getOrCreateApiConnection(input.cameraId);
      const channel = camera.rtspChannel ?? 0;
      const camName = sanitizeCameraName(camera.name);

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const outDir = path.join(DUMP_DIR, `${camName}-${ts}`);
      fs.mkdirSync(outDir, { recursive: true });

      const result = await captureModelFixtures({
        api,
        channel,
        outDir,
      });

      // Zip the output directory
      const zipPath = `${outDir}.zip`;
      await zipDirectory({ sourceDir: outDir, zipPath });

      // Clean up the unzipped directory
      fs.rmSync(outDir, { recursive: true, force: true });

      // Create a download token (valid 10 min)
      const token = crypto.randomBytes(16).toString("hex");
      dumpDownloads.set(token, { zipPath, expiresAt: Date.now() + 10 * 60 * 1000 });

      return {
        token,
        filename: `${camName}-dump-${ts}.zip`,
        summary: result.summary,
      };
    }),

  /** List all model fixture dumps (zip files in DATA_PATH/dumps/). */
  listDumps: publicProcedure.query(() => {
    if (!fs.existsSync(DUMP_DIR)) return [];
    return fs
      .readdirSync(DUMP_DIR)
      .filter((f) => f.endsWith(".zip"))
      .map((f) => {
        const stat = fs.statSync(path.join(DUMP_DIR, f));
        return {
          filename: f,
          sizeBytes: stat.size,
          createdAt: stat.birthtime.toISOString(),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }),

  /** Download a dump zip by filename (creates a temporary token). */
  downloadDump: publicProcedure
    .input(z.object({ filename: z.string() }))
    .mutation(({ input }) => {
      const zipPath = path.join(DUMP_DIR, input.filename);
      if (!fs.existsSync(zipPath)) throw new Error("Dump not found");
      const token = crypto.randomBytes(16).toString("hex");
      dumpDownloads.set(token, { zipPath, expiresAt: Date.now() + 10 * 60 * 1000 });
      return { token, filename: input.filename };
    }),

  /** Delete a dump zip by filename. */
  deleteDump: publicProcedure
    .input(z.object({ filename: z.string() }))
    .mutation(({ input }) => {
      const zipPath = path.join(DUMP_DIR, input.filename);
      if (!fs.existsSync(zipPath)) throw new Error("Dump not found");
      fs.unlinkSync(zipPath);
      return { deleted: true };
    }),
});
