import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import {
  getConnection,
  setActiveCredentials,
  getActiveCredentials,
  clearActiveCredentials,
  resolveCredentials,
} from "../connection-manager.js";
import { getCameras } from "../settings-store.js";

// Full connection input for setActiveCredentials and explicit connections
const ConnectionInput = z.object({
  host: z.string(),
  port: z.number().optional().default(9000),
  username: z.string(),
  password: z.string(),
});

// Optional connection input - cameraId from configured cameras, or "manual" for host/port/username/password
const OptionalConnectionInput = z.object({
  cameraId: z
    .string()
    .optional()
    .describe(
      "Camera ID or name (from cameras.list / baichuan.listCameras), or 'manual' for host/port/username/password below",
    ),
  host: z.string().optional().describe("Host (when cameraId is 'manual' or empty)"),
  port: z.number().optional().describe("Port (default 9000)"),
  username: z.string().optional().describe("Username (when cameraId is 'manual' or empty)"),
  password: z.string().optional().describe("Password (when cameraId is 'manual' or empty)"),
});

const ChannelInput = z.object({
  channel: z.number().optional().default(0),
});

// Connection with channel - for endpoints that need both
const ConnectionWithChannel = OptionalConnectionInput.merge(ChannelInput);

// Helper to get API from optional params
async function getApi(
  params?: z.infer<typeof OptionalConnectionInput>,
): Promise<import("@apocaliss92/nodelink-js").ReolinkBaichuanApi> {
  const creds = resolveCredentials(params);
  return getConnection(creds.host, creds.port, creds.username, creds.password);
}

export const baichuanRouter = router({
  // ============ ACTIVE CREDENTIALS ============

  setActiveCredentials: publicProcedure
    .meta({
      description:
        "Set default credentials to use for all subsequent API calls",
    })
    .input(ConnectionInput)
    .mutation(({ input }) => {
      setActiveCredentials(input);
      return {
        success: true,
        message: `Active credentials set for ${input.host}:${input.port}`,
        activeCredentials: {
          host: input.host,
          port: input.port,
          username: input.username,
        },
      };
    }),

  getActiveCredentials: publicProcedure
    .meta({ description: "Get current active credentials (password hidden)" })
    .query(() => {
      const creds = getActiveCredentials();
      if (!creds) return null;
      return {
        host: creds.host,
        port: creds.port,
        username: creds.username,
        hasPassword: true,
      };
    }),

  clearActiveCredentials: publicProcedure
    .meta({ description: "Clear active credentials" })
    .mutation(() => {
      clearActiveCredentials();
      return { success: true };
    }),

  listCameras: publicProcedure
    .meta({
      description:
        "List configured cameras - use cameraId in other procedures to connect",
    })
    .query(() => {
      return getCameras().map((c) => ({
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
      }));
    }),

  // ============ CONNECTION ============

  connect: publicProcedure
    .meta({
      description: "Connect and login to camera",
    })
    .input(ConnectionInput)
    .mutation(async ({ input }) => {
      await getConnection(
        input.host,
        input.port,
        input.username,
        input.password,
      );
      return { success: true, message: "Connected and logged in" };
    }),

  ping: publicProcedure
    .meta({ description: "Send ping to camera" })
    .input(OptionalConnectionInput)
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.ping();
      return { success: true };
    }),

  reboot: publicProcedure
    .meta({ description: "Reboot the camera" })
    .input(OptionalConnectionInput)
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.reboot();
      return { success: true, message: "Reboot command sent" };
    }),

  // ============ DEVICE INFO ============

  getInfo: publicProcedure
    .meta({ description: "Get basic device information" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getInfo();
    }),

  getAbilityInfo: publicProcedure
    .meta({ description: "Get device ability information" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAbilityInfo();
    }),

  getChannelCount: publicProcedure
    .meta({ description: "Get number of channels" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getChannelCount();
    }),

  getChannelInfo: publicProcedure
    .meta({ description: "Get channel information" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getChannelInfo(input.channel);
    }),

  getAllChannelsInfo: publicProcedure
    .meta({ description: "Get all channels information" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAllChannelsInfo();
    }),

  getStreamInfoList: publicProcedure
    .meta({ description: "Get available stream information" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getStreamInfoList(input.channel);
    }),

  getHddInfoList: publicProcedure
    .meta({ description: "Get storage/HDD information" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getHddInfoList();
    }),

  // ============ VIDEO CLIPS / RECORDINGS ============

  getVideoclips: publicProcedure
    .meta({ description: "Search for recorded video clips" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          startTime: z.string().transform((s) => new Date(s)),
          endTime: z.string().transform((s) => new Date(s)),
          streamType: z.enum(["mainStream", "subStream"]).optional(),
        }),
      ),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getVideoclips({
        channel: input.channel,
        start: input.startTime,
        end: input.endTime,
        streamType: input.streamType,
      });
    }),

  // ============ SNAPSHOTS ============

  getSnapshot: publicProcedure
    .meta({ description: "Capture a snapshot from the camera" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      const buffer = await api.getSnapshot(input.channel);
      return {
        base64: buffer.toString("base64"),
        mimeType: "image/jpeg",
        size: buffer.length,
      };
    }),

  // ============ PTZ CONTROL ============

  ptzControl: publicProcedure
    .meta({ description: "Send PTZ command" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          command: z.enum([
            "Left",
            "Right",
            "Up",
            "Down",
            "ZoomIn",
            "ZoomOut",
            "FocusNear",
            "FocusFar",
          ]),
          speed: z.number().min(1).max(64).default(32),
          action: z.enum(["start", "stop"]).default("start"),
          autoStopMs: z.number().optional().default(500),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.ptz(input.channel, {
        action: input.action,
        command: input.command,
        speed: input.speed,
        autoStopMs: input.autoStopMs,
      });
      return { success: true };
    }),

  getPtzPresets: publicProcedure
    .meta({ description: "Get PTZ presets" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getPtzPresets(input.channel);
    }),

  getPtzPosition: publicProcedure
    .meta({ description: "Get current PTZ position" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getPtzPosition(input.channel);
    }),

  // ============ ZOOM / FOCUS ============

  getZoomFocus: publicProcedure
    .meta({ description: "Get zoom and focus settings" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getZoomFocus(input.channel);
    }),

  // ============ DETECTION SETTINGS ============

  getMotionAlarm: publicProcedure
    .meta({ description: "Get motion alarm settings" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getMotionAlarm(input.channel);
    }),

  getAiState: publicProcedure
    .meta({ description: "Get AI detection state" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAiState(input.channel);
    }),

  getAiAlarm: publicProcedure
    .meta({ description: "Get AI alarm settings" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAiAlarm(input.channel);
    }),

  // ============ LIGHTS & SIREN ============

  getWhiteLedState: publicProcedure
    .meta({ description: "Get white LED (spotlight) state" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getWhiteLedState(input.channel);
    }),

  getSiren: publicProcedure
    .meta({ description: "Get siren state" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getSiren(input.channel);
    }),

  // ============ BATTERY ============

  getBatteryInfo: publicProcedure
    .meta({ description: "Get battery status (for battery cameras)" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getBatteryInfo(input.channel);
    }),

  // ============ OSD ============

  getOsd: publicProcedure
    .meta({ description: "Get OSD (On-Screen Display) settings" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getOsd(input.channel);
    }),

  // ============ ENCODING ============

  getEncXml: publicProcedure
    .meta({ description: "Get video encoding settings (XML)" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getEncXml(input.channel);
    }),

  getStreamMetadata: publicProcedure
    .meta({ description: "Get stream metadata" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getStreamMetadata(input.channel);
    }),

  // ============ NETWORK ============

  getNetworkInfo: publicProcedure
    .meta({ description: "Get network information" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getNetworkInfo();
    }),

  getWifiSignal: publicProcedure
    .meta({ description: "Get WiFi signal strength" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getWifiSignal(input.channel);
    }),

  getWifi: publicProcedure
    .meta({ description: "Get WiFi configuration" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getWifi(input.channel);
    }),

  getPorts: publicProcedure
    .meta({ description: "Get network ports configuration" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getPorts();
    }),

  // ============ SYSTEM ============

  getSystemGeneral: publicProcedure
    .meta({ description: "Get system general settings" })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getSystemGeneral();
    }),

  // ============ AUDIO ============

  getTwoWayAudioConfig: publicProcedure
    .meta({ description: "Get two-way audio configuration" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getTwoWayAudioConfig(input.channel);
    }),

  // ============ PIR ============

  getPirInfo: publicProcedure
    .meta({ description: "Get PIR sensor info" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getPirInfo(input.channel);
    }),

  // ============ EVENTS ============

  getEvents: publicProcedure
    .meta({ description: "Get events configuration" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getEvents(input.channel);
    }),

  // ============ LED STATE ============

  getLedState: publicProcedure
    .meta({ description: "Get LED state (power LED)" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getLedState(input.channel);
    }),

  // ============ SLEEP STATE ============

  getSleepState: publicProcedure
    .meta({ description: "Get sleep state" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getSleepState(input.channel);
    }),

  // ============ RECORD CONFIG ============

  getRecordCfg: publicProcedure
    .meta({ description: "Get recording configuration" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getRecordCfg(input.channel);
    }),

  getRecordSchedule: publicProcedure
    .meta({ description: "Get recording schedule" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getRecordSchedule(input.channel);
    }),

  // ============ OSD DATETIME ============

  getOsdDatetime: publicProcedure
    .meta({ description: "Get OSD datetime settings" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getOsdDatetime(input.channel);
    }),
});
