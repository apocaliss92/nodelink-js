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
    .meta({
      description:
        "Get basic device information. Omit `channel` for host-level info (cmd_id=80); pass a channel index for channel-specific DevInfo (cmd_id=318). `tags` restricts which fields are extracted.",
    })
    .input(
      OptionalConnectionInput.extend({
        channel: z.number().int().min(0).optional(),
        tags: z
          .array(
            z.enum([
              "type",
              "hardwareVersion",
              "firmwareVersion",
              "itemNo",
              "serialNumber",
              "name",
            ]),
          )
          .optional(),
        timeoutMs: z.number().int().min(100).optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      const options: Parameters<typeof api.getInfo>[1] = {};
      if (input.tags) options.tags = input.tags;
      if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs;
      return await api.getInfo(input.channel, options);
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
    .meta({
      description:
        "Search for recorded video clips. `recordType` accepts a comma-separated list (default: all types). `uid` overrides UID auto-discovery. `timeoutMs` defaults to 15000.",
    })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          startTime: z.string().transform((s) => new Date(s)),
          endTime: z.string().transform((s) => new Date(s)),
          streamType: z.enum(["mainStream", "subStream"]).optional(),
          recordType: z.string().optional(),
          uid: z.string().optional(),
          timeoutMs: z.number().int().min(1000).optional(),
          maxIterations: z.number().int().min(1).max(500).optional(),
        }),
      ),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      const params: Parameters<typeof api.getVideoclips>[0] = {
        channel: input.channel,
        start: input.startTime,
        end: input.endTime,
      };
      if (input.streamType) params.streamType = input.streamType;
      if (input.recordType) params.recordType = input.recordType;
      if (input.uid) params.uid = input.uid;
      if (input.timeoutMs !== undefined) params.timeoutMs = input.timeoutMs;
      if (input.maxIterations !== undefined)
        params.maxIterations = input.maxIterations;
      return await api.getVideoclips(params);
    }),

  // ============ SNAPSHOTS ============

  getSnapshot: publicProcedure
    .meta({
      description:
        "Capture a snapshot from the camera. `variant` selects the lens on dual-lens models (default=wide, telephoto/autotrack=tele lens). `onNvr` must be true when the camera is behind an NVR/Hub so the tele lens is selected via logic-channel.",
    })
    .input(
      ConnectionWithChannel.extend({
        variant: z.enum(["default", "autotrack", "telephoto"]).optional(),
        onNvr: z.boolean().optional(),
        streamType: z.enum(["main", "sub"]).optional(),
        timeoutMs: z.number().int().min(1000).optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      const options: Parameters<typeof api.getSnapshot>[1] = {};
      if (input.variant) options.variant = input.variant;
      if (input.onNvr !== undefined) options.onNvr = input.onNvr;
      if (input.streamType) options.streamType = input.streamType;
      if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs;
      const buffer = await api.getSnapshot(input.channel, options);
      return {
        base64: buffer.toString("base64"),
        mimeType: "image/jpeg",
        size: buffer.length,
      };
    }),

  // ============ PTZ CONTROL ============

  ptzControl: publicProcedure
    .meta({
      description:
        "Send PTZ command. `speed` (1-64) and `autoStopMs` are optional — the library applies its own defaults (speed≈32, autoStopMs=500) when omitted. Pass `autoStopMs: 0` to disable the automatic stop.",
    })
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
          speed: z.number().int().min(1).max(64).optional(),
          action: z.enum(["start", "stop"]).default("start"),
          autoStopMs: z.number().int().min(0).optional(),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const cmd: import("@apocaliss92/nodelink-js").PtzCommand = {
        action: input.action,
        command: input.command,
      };
      if (input.speed !== undefined) cmd.speed = input.speed;
      if (input.autoStopMs !== undefined) cmd.autoStopMs = input.autoStopMs;
      await api.ptz(input.channel, cmd);
      return { success: true };
    }),

  setPtzPreset: publicProcedure
    .meta({
      description:
        "Save the camera's CURRENT pan/tilt/zoom position into the given preset slot, with the given name.",
    })
    .input(
      ConnectionWithChannel.extend({
        presetId: z.number().int().min(0),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setPtzPreset(input.channel, input.presetId, input.name);
      return { success: true };
    }),

  deletePtzPreset: publicProcedure
    .meta({
      description:
        "Best-effort delete a PTZ preset (sets enable=0 on the slot). Some firmwares still keep the position; reuse `setPtzPreset` to overwrite.",
    })
    .input(
      ConnectionWithChannel.extend({
        presetId: z.number().int().min(0),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.deletePtzPreset(input.channel, input.presetId);
      return { success: true };
    }),

  gotoPtzPreset: publicProcedure
    .meta({ description: "Recall (move to) a saved PTZ preset by id." })
    .input(
      ConnectionWithChannel.extend({
        presetId: z.number().int().min(0),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.gotoPtzPreset(input.channel, input.presetId);
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

  setMotionAlarm: publicProcedure
    .meta({
      description:
        "Toggle motion detection and optionally set sensitivity (0-50).",
    })
    .input(
      ConnectionWithChannel.extend({
        enabled: z.boolean(),
        sensitivity: z.number().int().min(0).max(50).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setMotionAlarm(input.channel, input.enabled, input.sensitivity);
      return { success: true };
    }),

  setMotionAlarmZone: publicProcedure
    .meta({
      description:
        "Update the motion-detection grid (valueTable base64 bitmap). Also optionally toggles enable/sensitivity in the same call.",
    })
    .input(
      ConnectionWithChannel.extend({
        valueTable: z.string().min(1),
        enabled: z.boolean().optional(),
        sensitivity: z.number().int().min(0).max(50).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setMotionAlarmFull({
        channel: input.channel,
        valueTable: input.valueTable,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.sensitivity !== undefined
          ? { sensitivity: input.sensitivity }
          : {}),
      });
      return { success: true };
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

  getAiAlarmRaw: publicProcedure
    .meta({
      description:
        "Get raw AiDetectCfg for one AI class. aiType is 'people' / 'vehicle' / 'dog_cat' / 'face' / 'package'. Includes sensitivity, stayTime, min/maxTargetWidth/Height and the per-class area bitmap.",
    })
    .input(
      ConnectionWithChannel.extend({
        aiType: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAiAlarmRaw(input.channel, input.aiType);
    }),

  getAiCfg: publicProcedure
    .meta({
      description:
        "Get AI configuration (cmd_299). Returns the comma-separated `detectType` list — useful to know which AI classes the camera actually supports.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAiCfg(input.channel);
    }),

  setAiDetection: publicProcedure
    .meta({
      description:
        "Update sensitivity (and optionally stayTime) for one AI class on this channel. aiType is 'people' / 'vehicle' / 'dog_cat' / 'face' / 'package'.",
    })
    .input(
      ConnectionWithChannel.extend({
        aiType: z.string().min(1),
        sensitivity: z.number().int().min(0).max(100).optional(),
        stayTime: z.number().int().min(0).max(600).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setAiDetection(
        input.channel,
        input.aiType,
        input.sensitivity,
        input.stayTime,
      );
      return { success: true };
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

  getOsdDatetime: publicProcedure
    .meta({
      description:
        "Get OSD datetime + channel-name overlay (cmd_44). Returns the parsed `OsdDatetime` block (enable, topLeftX/Y, language) plus `OsdChannelName` (name, enable, topLeftX/Y, enWatermark, enBgcolor) — the schema modern Reolink firmwares actually use.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getOsdDatetime(input.channel);
    }),

  setOsdDatetime: publicProcedure
    .meta({
      description:
        "Update OSD datetime + channel-name overlay via cmd_45 (SetOsdDatetime). Pixel-coord positions, boolean enables.",
    })
    .input(
      ConnectionWithChannel.extend({
        datetime: z
          .object({
            enable: z.boolean().optional(),
            topLeftX: z.number().int().optional(),
            topLeftY: z.number().int().optional(),
            language: z.string().optional(),
          })
          .optional(),
        channelName: z
          .object({
            name: z.string().optional(),
            enable: z.boolean().optional(),
            topLeftX: z.number().int().optional(),
            topLeftY: z.number().int().optional(),
            enWatermark: z.boolean().optional(),
            enBgcolor: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setOsdDatetime(input.channel, {
        ...(input.datetime ? { datetime: input.datetime } : {}),
        ...(input.channelName ? { channelName: input.channelName } : {}),
      });
      return { success: true };
    }),

  setOsd: publicProcedure
    .meta({
      description:
        "Set OSD overlay (channel name + position, datetime visibility, watermark).",
    })
    .input(
      ConnectionWithChannel.extend({
        osd: z.object({
          channel: z.number().int().min(0),
          osdChannel: z.object({
            enable: z.union([z.literal(0), z.literal(1)]),
            name: z.string(),
            pos: z.string(),
          }),
          osdTime: z.object({
            enable: z.union([z.literal(0), z.literal(1)]),
            pos: z.string(),
          }),
          watermark: z.union([z.literal(0), z.literal(1)]),
          bgcolor: z.union([z.literal(0), z.literal(1)]).optional(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setOsd(input.channel, input.osd);
      return { success: true };
    }),

  getImage: publicProcedure
    .meta({ description: "Get image settings (brightness, contrast, etc.)" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getImage(input.channel);
    }),

  setImage: publicProcedure
    .meta({
      description:
        "Update image quality fields: bright, contrast, saturation, hue, sharpen (0-255 typical).",
    })
    .input(
      ConnectionWithChannel.extend({
        bright: z.number().int().min(0).max(255).optional(),
        contrast: z.number().int().min(0).max(255).optional(),
        saturation: z.number().int().min(0).max(255).optional(),
        hue: z.number().int().min(0).max(255).optional(),
        sharpen: z.number().int().min(0).max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _, channel: _ch, ...patch } = input;
      void _;
      void _ch;
      await api.setImage(input.channel, patch);
      return { success: true };
    }),

  // ============ ENCODING ============

  getEncXml: publicProcedure
    .meta({ description: "Get video encoding settings (XML)" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getEncXml(input.channel);
    }),

  getVersionInfo: publicProcedure
    .meta({
      description:
        "Get the camera's VersionInfo block (model, firmware, serial number, build day, AI bundle version). Maps to Baichuan cmd_id=80.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getVersionInfo();
    }),

  getStreamMetadata: publicProcedure
    .meta({ description: "Get stream metadata" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getStreamMetadata(input.channel);
    }),

  getEncOptions: publicProcedure
    .meta({
      description:
        "Allowed values for setEnc on each stream profile (codecs, resolutions, bitrates, framerates).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getEncOptions(input.channel);
    }),

  setEnc: publicProcedure
    .meta({
      description:
        "Update one or more stream profiles' encoding parameters. Only the supplied fields are changed.",
    })
    .input(
      ConnectionWithChannel.extend({
        audio: z.union([z.literal(0), z.literal(1)]).optional(),
        mainStream: z
          .object({
            audio: z.union([z.literal(0), z.literal(1)]).optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            bitRate: z.number().int().positive().optional(),
            frameRate: z.number().int().positive().optional(),
            videoEncType: z.enum(["h264", "h265"]).optional(),
            encoderType: z.enum(["vbr", "cbr"]).optional(),
            encoderProfile: z.enum(["high", "main", "baseline"]).optional(),
            gop: z.number().int().positive().optional(),
          })
          .optional(),
        subStream: z
          .object({
            audio: z.union([z.literal(0), z.literal(1)]).optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            bitRate: z.number().int().positive().optional(),
            frameRate: z.number().int().positive().optional(),
            videoEncType: z.enum(["h264", "h265"]).optional(),
            encoderType: z.enum(["vbr", "cbr"]).optional(),
            encoderProfile: z.enum(["high", "main", "baseline"]).optional(),
            gop: z.number().int().positive().optional(),
          })
          .optional(),
        thirdStream: z
          .object({
            audio: z.union([z.literal(0), z.literal(1)]).optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            bitRate: z.number().int().positive().optional(),
            frameRate: z.number().int().positive().optional(),
            videoEncType: z.enum(["h264", "h265"]).optional(),
            encoderType: z.enum(["vbr", "cbr"]).optional(),
            encoderProfile: z.enum(["high", "main", "baseline"]).optional(),
            gop: z.number().int().positive().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { channel, cameraId: _ignored, ...patch } = input;
      void _ignored;
      await api.setEnc(channel, patch);
      return { success: true };
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

  setNetPort: publicProcedure
    .meta({
      description:
        "Update one or more of the camera's six service ports (Server, HTTP, HTTPS, RTSP, RTMP, ONVIF). Each entry takes optional `port` + `enable`; fields not passed are left alone.",
    })
    .input(
      OptionalConnectionInput.extend({
        server: z
          .object({
            port: z.number().int().min(1).max(65535).optional(),
            enable: z.boolean().optional(),
          })
          .optional(),
        http: z
          .object({
            port: z.number().int().min(1).max(65535).optional(),
            enable: z.boolean().optional(),
          })
          .optional(),
        https: z
          .object({
            port: z.number().int().min(1).max(65535).optional(),
            enable: z.boolean().optional(),
          })
          .optional(),
        rtsp: z
          .object({
            port: z.number().int().min(1).max(65535).optional(),
            enable: z.boolean().optional(),
          })
          .optional(),
        rtmp: z
          .object({
            port: z.number().int().min(1).max(65535).optional(),
            enable: z.boolean().optional(),
          })
          .optional(),
        onvif: z
          .object({
            port: z.number().int().min(1).max(65535).optional(),
            enable: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setPortConfig({
        ...(input.server ? { server: input.server } : {}),
        ...(input.http ? { http: input.http } : {}),
        ...(input.https ? { https: input.https } : {}),
        ...(input.rtsp ? { rtsp: input.rtsp } : {}),
        ...(input.rtmp ? { rtmp: input.rtmp } : {}),
        ...(input.onvif ? { onvif: input.onvif } : {}),
      });
      return { success: true };
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

  getAudioCfg: publicProcedure
    .meta({ description: "Get audio config (volumes, visitor settings)." })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAudioCfg(input.channel);
    }),

  setAudioCfg: publicProcedure
    .meta({
      description:
        "Update audio config — speaker volume, talk-and-reply volume, visitor volume, visitor loudspeaker enable.",
    })
    .input(
      ConnectionWithChannel.extend({
        volume: z.number().int().min(0).max(100).optional(),
        talkAndReplyVolume: z.number().int().min(0).max(100).optional(),
        visitorVolume: z.number().int().min(0).max(100).optional(),
        visitorLoudspeaker: z.union([z.literal(0), z.literal(1)]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, channel: _ch, ...patch } = input;
      void _c;
      void _ch;
      await api.setAudioCfg(input.channel, patch);
      return { success: true };
    }),

  getAudioNoise: publicProcedure
    .meta({
      description: "Get AI noise-reduction config (enable + level 0-100).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAudioNoise(input.channel);
    }),

  setAudioNoise: publicProcedure
    .meta({
      description:
        "Set AI noise-reduction level (0 turns it off; 1-100 enables and sets the level).",
    })
    .input(
      ConnectionWithChannel.extend({
        level: z.number().int().min(0).max(100),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setAudioNoise(input.channel, input.level);
      return { success: true };
    }),

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

  // ============ CHIME / DINGDONG ============

  getDingDongList: publicProcedure
    .meta({ description: "Get list of paired wireless chimes (DingDong devices)" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDingDongList(input.channel);
    }),

  getDingDongParams: publicProcedure
    .meta({ description: "Get parameters of a specific paired wireless chime" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          chimeId: z.number().describe("Chime device ID"),
        }),
      ),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDingDongParams(input.chimeId, input.channel);
    }),

  setDingDongParams: publicProcedure
    .meta({ description: "Set parameters (name, volume, LED) of a paired wireless chime" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          chimeId: z.number().describe("Chime device ID"),
          name: z.string().optional(),
          volLevel: z.number().optional(),
          ledState: z.number().optional(),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setDingDongParams(
        input.chimeId,
        { name: input.name, volLevel: input.volLevel, ledState: input.ledState },
        input.channel,
      );
      return { success: true };
    }),

  ringDingDong: publicProcedure
    .meta({ description: "Ring a paired wireless chime with a specific ringtone" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          chimeId: z.number().describe("Chime device ID"),
          musicId: z.number().describe("Ringtone/music ID"),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.ringDingDong(input.chimeId, input.musicId, input.channel);
      return { success: true };
    }),

  getDingDongCfg: publicProcedure
    .meta({ description: "Get alarm-event ringtone configuration for paired wireless chimes" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDingDongCfg(input.channel);
    }),

  setDingDongCfg: publicProcedure
    .meta({ description: "Set alarm-event ringtone configuration for a paired wireless chime" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          chimeId: z.number().describe("Chime device ID"),
          eventType: z.string().describe("Event type (e.g. 'people', 'vehicle', 'visitor')"),
          state: z.union([z.literal(0), z.literal(1)]).describe("Enable state (1 = enabled, 0 = disabled)"),
          musicId: z.number().describe("Ringtone ID to play for this event"),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setDingDongCfg(
        input.chimeId,
        input.eventType,
        input.state,
        input.musicId,
        input.channel,
      );
      return { success: true };
    }),

  getHardwiredChime: publicProcedure
    .meta({ description: "Get hardwired chime state (doorbell built-in chime enable/disable)" })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getHardwiredChime(input.channel);
    }),

  setHardwiredChime: publicProcedure
    .meta({ description: "Enable or disable the hardwired chime on the doorbell" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          enabled: z.boolean().describe("Enable or disable the chime"),
          type: z.string().optional().describe("Chime type (e.g. 'dingdong', 'single', 'dual')"),
          time: z.number().optional().describe("Chime duration/timing value"),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const state = await api.setHardwiredChime(
        { enabled: input.enabled, type: input.type, time: input.time },
        input.channel,
      );
      return state;
    }),

  quickReplyPlay: publicProcedure
    .meta({ description: "Play a quick reply audio file on the doorbell" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          fileId: z.number().describe("Quick reply file ID to play"),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.quickReplyPlay(input.fileId, input.channel);
      return { success: true };
    }),

  getDingDongSilent: publicProcedure
    .meta({ description: "Get silent mode state of a paired wireless chime (time=0 means active/not silenced)" })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          chimeId: z.number().describe("Wireless chime device ID (from getDingDongList)"),
        }),
      ),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDingDongSilent(input.chimeId, input.channel);
    }),

  setDingDongSilent: publicProcedure
    .meta({ description: "Set silent mode of a paired wireless chime. time=0 activates chime, time>0 silences it for that many seconds." })
    .input(
      ConnectionWithChannel.merge(
        z.object({
          chimeId: z.number().describe("Wireless chime device ID (from getDingDongList)"),
          time: z.number().describe("Silence duration in seconds. 0 = active (not silenced), >0 = silenced for N seconds."),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      return await api.setDingDongSilent(input.chimeId, input.time, input.channel);
    }),

  // ============ PTZ ADVANCED / AUTOTRACKING / ZOOM ============

  zoomToFactor: publicProcedure
    .meta({
      description:
        "Zoom to an absolute zoom factor (e.g. 1.0 = wide, 2.0 = 2x). The library clamps to the camera's reported min/max zoom.",
    })
    .input(
      ConnectionWithChannel.extend({
        zoomFactor: z.number().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.zoomToFactor(input.zoomFactor, input.channel);
      return { success: true };
    }),

  getAutoFocus: publicProcedure
    .meta({
      description:
        "Get autofocus configuration (cmd_id=224). Returns `<AutoFocus>` block with `disable` (0 = AF on, 1 = AF off).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAutoFocus(input.channel);
    }),

  setAutoFocus: publicProcedure
    .meta({
      description:
        "Enable or disable autofocus (cmd_id=225). `disable=true` turns AF off, `disable=false` turns it on.",
    })
    .input(
      ConnectionWithChannel.extend({
        disable: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setAutoFocus(input.channel, input.disable);
      return { success: true };
    }),

  probeAutotrackingSupport: publicProcedure
    .meta({
      description:
        "Probe whether autotracking is supported on this channel via AiCfg (cmd_id=299). Uses smartTrackMode>0 as the indicator (more reliable than SupportInfo.autoPt).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.probeAutotrackingSupport(input.channel);
    }),

  getAutotracking: publicProcedure
    .meta({
      description:
        "Get autotracking (smart-track) state and config via AiCfg (cmd_id=299).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAutotracking(input.channel);
    }),

  setAutotracking: publicProcedure
    .meta({
      description:
        "Enable or disable autotracking (smart-track) via AiCfg (cmd_id=300).",
    })
    .input(
      ConnectionWithChannel.extend({
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setAutotracking(input.enabled, input.channel);
      return { success: true };
    }),

  setAutotrackingSettings: publicProcedure
    .meta({
      description:
        "Update autotracking detail settings (smartTrackType, stop/disappear delays) via AiCfg (cmd_id=300). Does not change enable state.",
    })
    .input(
      ConnectionWithChannel.extend({
        smartTrackType: z
          .string()
          .optional()
          .describe("Comma-separated detect types, e.g. 'people,vehicle'"),
        smartTrackObjectStopDelay: z.number().int().min(0).optional(),
        smartTrackObjectDisappearDelay: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, channel: _ch, ...settings } = input;
      void _c;
      void _ch;
      await api.setAutotrackingSettings(input.channel, settings);
      return { success: true };
    }),

  // ============ FLOODLIGHT / SIREN / IR ============

  getFloodlightOnMotion: publicProcedure
    .meta({
      description:
        "Get floodlight-on-motion state via FloodlightTask (cmd_id=289). Returns floodlightOnMotion flag plus enable/brightness/duration/detectType.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getFloodlightOnMotion(input.channel);
    }),

  setFloodlightOnMotion: publicProcedure
    .meta({
      description:
        "Enable or disable floodlight turning on automatically when motion is detected (cmd_id=290).",
    })
    .input(
      ConnectionWithChannel.extend({
        on: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setFloodlightOnMotion(input.on, input.channel);
      return { success: true };
    }),

  setFloodlightSettings: publicProcedure
    .meta({
      description:
        "Update floodlight parameters (duration, detectType, brightness) without touching the enable state (cmd_id=290).",
    })
    .input(
      ConnectionWithChannel.extend({
        duration: z.number().int().min(0).optional(),
        detectType: z.string().optional(),
        brightness: z.number().int().min(0).max(100).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, channel: _ch, ...settings } = input;
      void _c;
      void _ch;
      await api.setFloodlightSettings(input.channel, settings);
      return { success: true };
    }),

  setWhiteLedState: publicProcedure
    .meta({
      description:
        "Manually turn the white LED / spotlight on/off and/or set brightness (cmd_id=288 / 290).",
    })
    .input(
      ConnectionWithChannel.extend({
        on: z.boolean().optional(),
        brightness: z.number().int().min(0).max(100).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setWhiteLedState(input.channel, input.on, input.brightness);
      return { success: true };
    }),

  setSiren: publicProcedure
    .meta({
      description:
        "Trigger or stop the siren. Pass `on:true` to start, `on:false` to stop. Optional `duration` (times count) switches to times mode.",
    })
    .input(
      ConnectionWithChannel.extend({
        on: z.boolean().optional(),
        duration: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Number of times to play the siren (times mode)"),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setSiren(input.channel, input.on, input.duration);
      return { success: true };
    }),

  getSirenOnMotion: publicProcedure
    .meta({
      description:
        "Get siren-on-motion state via AudioTask (cmd_id=232). Returns enable flag + per-type schedule list.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getSirenOnMotion(input.channel);
    }),

  setSirenOnMotion: publicProcedure
    .meta({
      description:
        "Enable or disable siren-on-motion via AudioTask (cmd_id=231). When omitted, a default 24/7 schedule for MD/people/dog_cat is used.",
    })
    .input(
      ConnectionWithChannel.extend({
        enable: z.union([z.literal(0), z.literal(1)]),
        typeScheduleList: z
          .array(
            z.object({
              type: z.string(),
              valueTable: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setSirenOnMotion(
        {
          enable: input.enable,
          ...(input.typeScheduleList
            ? { typeScheduleList: input.typeScheduleList }
            : {}),
        },
        input.channel,
      );
      return { success: true };
    }),

  getSirenStatus: publicProcedure
    .meta({
      description:
        "Get current siren status (host-level). Reports whether the siren alarm is currently active.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getSirenStatus();
    }),

  getIrLights: publicProcedure
    .meta({
      description:
        "Get IR / status LED state (cmd_id=208). Returns IRLedBrightness, IR state, status LED state, doorbell light state.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getIrLights(input.channel);
    }),

  setIrLights: publicProcedure
    .meta({
      description:
        "Set IR / status LED state (cmd_id=209). Patches IR state (On/Off/Auto), status LED, doorbell LED, IR brightness (0-255).",
    })
    .input(
      ConnectionWithChannel.extend({
        irState: z.enum(["On", "Off", "Auto"]).optional(),
        lightState: z.enum(["On", "Off"]).optional(),
        doorbellLightState: z.enum(["On", "Off"]).optional(),
        irBrightness: z.number().int().min(0).max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, channel: _ch, ...patch } = input;
      void _c;
      void _ch;
      await api.setIrLights(input.channel, patch);
      return { success: true };
    }),

  // ============ MOTION / PIR (SET) ============

  getMotionState: publicProcedure
    .meta({
      description:
        "Get the current motion-detection state for a channel (true = motion currently detected).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getMotionState(input.channel);
    }),

  setPirInfo: publicProcedure
    .meta({
      description:
        "Set PIR (Passive Infrared) settings (cmd_id=213). `sensitive` is 0-100 (higher = more sensitive — the library maps to the raw inverted scale).",
    })
    .input(
      ConnectionWithChannel.extend({
        enable: z.union([z.literal(0), z.literal(1)]),
        sensitive: z.number().int().min(0).max(100).optional(),
        reduceAlarm: z.union([z.literal(0), z.literal(1)]).optional(),
        interval: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, channel: _ch, ...params } = input;
      void _c;
      void _ch;
      await api.setPirInfo(input.channel, params);
      return { success: true };
    }),

  setMotionDetection: publicProcedure
    .meta({
      description:
        "Toggle motion detection on/off and optionally update sensitivity (0-50). Convenience wrapper over setMotionAlarmFull.",
    })
    .input(
      ConnectionWithChannel.extend({
        enabled: z.boolean(),
        sensitivity: z.number().int().min(0).max(50).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setMotionDetection(
        input.channel,
        input.enabled,
        input.sensitivity,
      );
      return { success: true };
    }),

  // ============ AI ADVANCED ============

  getAiDetectTypes: publicProcedure
    .meta({
      description:
        "Return the AI object-detection types supported by this channel (cmd_id=299 → detectType list, e.g. ['people','vehicle','dog_cat']).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAiDetectTypes(input.channel);
    }),

  getAiDenoise: publicProcedure
    .meta({
      description: "Get AI noise-reduction config (enable + level 0-100).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAiDenoise(input.channel);
    }),

  // ============ PRIVACY MASK ============

  getMask: publicProcedure
    .meta({
      description:
        "Get privacy mask configuration (cmd_id=52). Returns `<Shelter>` block — enable flag + shelter list.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getMask(input.channel);
    }),

  setMask: publicProcedure
    .meta({
      description:
        "Toggle privacy mask enable flag (cmd_id=53). Shelter zone editing is not supported via this call.",
    })
    .input(
      ConnectionWithChannel.extend({
        enable: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setMask(input.channel, { enable: input.enable });
      return { success: true };
    }),

  // ============ ISP / VIDEO INPUT ============

  getIsp: publicProcedure
    .meta({
      description:
        "Get ISP / VideoInput configuration (cmd_id=26). Returns merged VideoInput + InputAdvanceCfg blob (day/night mode, exposure, HDR, binning, etc.).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getIsp(input.channel);
    }),

  setIsp: publicProcedure
    .meta({
      description:
        "Patch ISP fields (day/night, exposure, HDR, binning mode, day/night threshold). Each field is optional; omitted fields are left untouched.",
    })
    .input(
      ConnectionWithChannel.extend({
        dayNight: z.string().optional(),
        exposure: z.string().optional(),
        binningMode: z.number().int().min(0).optional(),
        hdr: z.union([z.literal(0), z.literal(1)]).optional(),
        dayNightThreshold: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, channel: _ch, ...patch } = input;
      void _c;
      void _ch;
      await api.setIsp(input.channel, patch);
      return { success: true };
    }),

  // ============ SLEEP / WAKE / BATTERY ============

  isSleeping: publicProcedure
    .meta({
      description:
        "Check if a battery camera appears to be sleeping. Best-effort: returns true if GetBatteryInfo times out within ~5s.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.isSleeping(input.channel);
    }),

  probeSleepStatus: publicProcedure
    .meta({
      description:
        "Active sleep probe with a short timeout (UDP/battery only). Caches result for `minIntervalMs` to avoid keeping the camera awake.",
    })
    .input(
      ConnectionWithChannel.extend({
        timeoutMs: z.number().int().min(50).optional(),
        attempts: z.number().int().min(1).optional(),
        minIntervalMs: z.number().int().min(0).optional(),
        cmdId: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, ...probeOpts } = input;
      void _c;
      return await api.probeSleepStatus(probeOpts);
    }),

  wakeUp: publicProcedure
    .meta({
      description:
        "Wake up a sleeping battery camera by sending a waking command (GetEnc cmd_id=56). Retries up to `attempts` times with backoff.",
    })
    .input(
      ConnectionWithChannel.extend({
        timeoutMs: z.number().int().min(100).optional(),
        attempts: z.number().int().min(1).max(10).optional(),
        waitAfterWakeMs: z.number().int().min(0).optional(),
        backoffMs: z.number().int().min(0).optional(),
        reconnect: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, channel: _ch, ...wakeOpts } = input;
      void _c;
      void _ch;
      await api.wakeUp(input.channel, wakeOpts);
      return { success: true };
    }),

  getAllChannelsBatteryInfo: publicProcedure
    .meta({
      description:
        "Fetch battery info for all NVR/Hub channels via CGI (merged with channel-status sleep flag). Standalone cameras return their single channel.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAllChannelsBatteryInfo();
    }),

  getBatteryStatus: publicProcedure
    .meta({
      description:
        "Comprehensive battery status with sleep state. Returns battery info AND a `sleeping` flag (true if the camera didn't respond).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getBatteryStatus(input.channel);
    }),

  // ============ CAPABILITIES / SUPPORT ============

  getDeviceCapabilities: publicProcedure
    .meta({
      description:
        "Get full device capability set for a channel (SupportInfo + AbilityInfo + AI detect types + floodlight probe + chime discovery). Cached 5 min per channel.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDeviceCapabilities(input.channel);
    }),

  getAbilityVersion: publicProcedure
    .meta({
      description:
        "Return the version number for a specific capability (0 = not supported). Channel-scoped; pass `channel:null` for host-level.",
    })
    .input(
      OptionalConnectionInput.extend({
        capability: z.string().min(1),
        channel: z.number().int().nullable().optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAbilityVersion(
        input.capability,
        input.channel ?? undefined,
      );
    }),

  getAbilitySupport: publicProcedure
    .meta({
      description:
        "Get the raw AbilitySupport XML blob (cmd_id derived from pcap settings). Complementary to getSupportInfo.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAbilitySupport(input.channel);
    }),

  getSupportInfo: publicProcedure
    .meta({
      description:
        "Get the device SupportInfo block (cmd_id=199). Host-level ptzMode and per-channel flags (battery, ledCtrl, lightType, autoPt, etc.).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getSupportInfo();
    }),

  getDualLensChannelInfo: publicProcedure
    .meta({
      description:
        "Analyze whether the channel belongs to a dual-lens camera (TrackMix, Duo) and report which logical lens it represents.",
    })
    .input(
      ConnectionWithChannel.extend({
        onNvr: z
          .boolean()
          .optional()
          .describe(
            "True when the camera is behind an NVR/Hub (tele lens is usually exposed as an autotrack/logic channel)",
          ),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDualLensChannelInfo(input.channel, {
        ...(input.onNvr !== undefined ? { onNvr: input.onNvr } : {}),
      });
    }),

  // ============ DEVICE / NVR HELPERS ============

  isNvrDevice: publicProcedure
    .meta({
      description:
        "Return true if the connected device is an NVR/Hub (i.e. exposes multiple camera channels).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.isNvrDevice();
    }),

  getNvrChannelsSummary: publicProcedure
    .meta({
      description:
        "Per-channel summary for an NVR/Hub (name, UID, online/sleeping, model, battery/doorbell flags). Defaults to the CGI path; pass source='baichuan' to derive channels from the push cache.",
    })
    .input(
      OptionalConnectionInput.extend({
        channels: z.array(z.number().int().min(0)).optional(),
        source: z.enum(["cgi", "baichuan"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getNvrChannelsSummary({
        ...(input.channels ? { channels: input.channels } : {}),
        ...(input.source ? { source: input.source } : {}),
      });
    }),

  getNvrDeviceGroups: publicProcedure
    .meta({
      description:
        "Group NVR/Hub channels by physical device — collapses dual-lens / multifocal cameras (TrackMix, Duo) into a single group with multiple channels.",
    })
    .input(
      OptionalConnectionInput.extend({
        channels: z.array(z.number().int().min(0)).optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getNvrDeviceGroups({
        ...(input.channels ? { channels: input.channels } : {}),
      });
    }),

  getAllChannelsEvents: publicProcedure
    .meta({
      description:
        "CGI passthrough — fetch the latest motion/AI event states across all channels in a single round-trip.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAllChannelsEvents();
    }),

  // ============ NETWORK / PORTS (EXTENDED) ============

  getNetPort: publicProcedure
    .meta({
      description:
        "Get raw per-protocol port config (cmd_id=37): rtsp/rtmp/onvif/http/https/server. Same data as getPorts.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getNetPort();
    }),

  setPortEnabled: publicProcedure
    .meta({
      description:
        "Enable or disable a single service port (cmd_id=36). `service` selects which protocol to toggle. For multi-port updates with custom port numbers, use setNetPort.",
    })
    .input(
      OptionalConnectionInput.extend({
        service: z.enum(["rtsp", "rtmp", "onvif", "http", "https"]),
        enable: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setPortEnabled({ port: input.service, enable: input.enable });
      return { success: true };
    }),

  // ============ TWO-WAY TALK (RAW) ============

  getTalkAbility: publicProcedure
    .meta({
      description:
        "Get talk (two-way audio) ability — supported audio formats, sample rates, bitrates.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getTalkAbility(input.channel);
    }),

  talkReset: publicProcedure
    .meta({
      description:
        "Reset the talk session (cmd_id=11). Useful when TalkConfig returned responseCode=422.",
    })
    .input(ConnectionWithChannel)
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.talkReset(input.channel);
      return { success: true };
    }),

  talkConfig: publicProcedure
    .meta({
      description:
        "Send a raw TalkConfig XML payload (cmd_id=201). Auto-retries with TalkReset on 422.",
    })
    .input(
      ConnectionWithChannel.extend({
        payloadXml: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.talkConfig(input.payloadXml, input.channel);
      return { success: true };
    }),

  // ============ RECORDING / PLAYBACK HELPERS ============

  getRecordingPlaybackUrls: publicProcedure
    .meta({
      description:
        "Build playback URLs (currently RTMP VOD) for a previously discovered recording filename.",
    })
    .input(
      ConnectionWithChannel.extend({
        fileName: z.string().min(1),
        streamType: z.enum(["mainStream", "subStream"]).optional(),
        ensureEnabled: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getRecordingPlaybackUrls({
        channel: input.channel,
        fileName: input.fileName,
        ...(input.streamType ? { streamType: input.streamType } : {}),
        ...(input.ensureEnabled !== undefined
          ? { ensureEnabled: input.ensureEnabled }
          : {}),
      });
    }),

  getRecordingThumbnail: publicProcedure
    .meta({
      description:
        "Extract a thumbnail (first keyframe → JPEG) from a recording by replaying it natively and decoding via ffmpeg. Returns base64 JPEG.",
    })
    .input(
      ConnectionWithChannel.extend({
        fileName: z.string().min(1),
        timeoutMs: z.number().int().min(1000).optional(),
        ffmpegPath: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const buffer = await api.getRecordingThumbnail({
        channel: input.channel,
        fileName: input.fileName,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.ffmpegPath ? { ffmpegPath: input.ffmpegPath } : {}),
      });
      return {
        base64: buffer.toString("base64"),
        mimeType: "image/jpeg",
        size: buffer.length,
      };
    }),

  getVideoclipThumbnail: publicProcedure
    .meta({
      description:
        "Snapshot from a recorded videoclip via the camera's native snapshot endpoint (sub stream by default). Returns the result struct as-is.",
    })
    .input(
      ConnectionWithChannel.extend({
        time: z.string().transform((s) => new Date(s)),
        endTime: z
          .string()
          .optional()
          .transform((s) => (s ? new Date(s) : undefined)),
        snapType: z.enum(["main", "sub"]).optional(),
        uid: z.string().optional(),
        timeoutMs: z.number().int().min(1000).optional(),
        isNvr: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const params: Parameters<typeof api.getVideoclipThumbnail>[0] = {
        channel: input.channel,
        time: input.time,
      };
      if (input.endTime) params.endTime = input.endTime;
      if (input.snapType) params.snapType = input.snapType;
      if (input.uid) params.uid = input.uid;
      if (input.timeoutMs !== undefined) params.timeoutMs = input.timeoutMs;
      if (input.isNvr !== undefined) params.isNvr = input.isNvr;
      return await api.getVideoclipThumbnail(params);
    }),

  snapshotFromRecording: publicProcedure
    .meta({
      description:
        "Snapshot a single frame from a recording at a given seek offset (via ffmpeg). Returns base64 JPEG.",
    })
    .input(
      ConnectionWithChannel.extend({
        fileName: z.string().min(1),
        seekSeconds: z.number().min(0).optional(),
        streamType: z.enum(["mainStream", "subStream"]).optional(),
        ffmpegPath: z.string().optional(),
        timeoutMs: z.number().int().min(1000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const params: Parameters<typeof api.snapshotFromRecording>[0] = {
        channel: input.channel,
        fileName: input.fileName,
      };
      if (input.seekSeconds !== undefined)
        params.seekSeconds = input.seekSeconds;
      if (input.streamType) params.streamType = input.streamType;
      if (input.ffmpegPath) params.ffmpegPath = input.ffmpegPath;
      if (input.timeoutMs !== undefined) params.timeoutMs = input.timeoutMs;
      const buffer = await api.snapshotFromRecording(params);
      return {
        base64: buffer.toString("base64"),
        mimeType: "image/jpeg",
        size: buffer.length,
      };
    }),

  // ============ ADDITIONAL GETTERS ============

  getVideoInput: publicProcedure
    .meta({
      description:
        "Get VideoInput + InputAdvanceCfg block (brightness, contrast, exposure, etc.). Same data as getIsp / getImage.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getVideoInput(input.channel);
    }),

  getDayRecords: publicProcedure
    .meta({
      description:
        "Get the recording-days bitmap for the current month — which days have recordings available.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDayRecords(input.channel);
    }),

  getDayNightThreshold: publicProcedure
    .meta({
      description:
        "Get the day/night IR-cut switching threshold (cur + range). Used together with setIsp({ dayNightThreshold }).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDayNightThreshold(input.channel);
    }),

  getEmailTask: publicProcedure
    .meta({
      description:
        "Get the channel's email-notification schedule and trigger list.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getEmailTask(input.channel);
    }),

  getFtpTask: publicProcedure
    .meta({
      description: "Get the channel's FTP upload schedule and trigger list.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getFtpTask(input.channel);
    }),

  getTimelapseCfg: publicProcedure
    .meta({
      description:
        "Get timelapse configuration (interval, output, schedule) for the channel.",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getTimelapseCfg(input.channel);
    }),

  getKitApCfg: publicProcedure
    .meta({
      description:
        "Get the kit access-point configuration (used by battery kits in pairing/AP mode).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getKitApCfg();
    }),

  getRecEncCfg: publicProcedure
    .meta({
      description:
        "Get recording encoding config (resolution/bitrate/codec per recorded stream).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getRecEncCfg(input.channel);
    }),

  getAccessUserList: publicProcedure
    .meta({
      description:
        "Get the list of users with access to the device (cmd_id for access user list).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAccessUserList();
    }),

  getOnlineUserList: publicProcedure
    .meta({
      description:
        "Get the list of currently online user sessions (cmd_id=120).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getOnlineUserList();
    }),

  getOnlineUserSessionsForUi: publicProcedure
    .meta({
      description:
        "UI-friendly multi-line summary of currently online sessions (built on top of getOnlineUserList).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getOnlineUserSessionsForUi();
    }),

  getSupport: publicProcedure
    .meta({
      description:
        "Raw Support block (ptzMode, channelNum, wifi flags, rtsp, rtmp, etc.) — alternative parsing of cmd_id GetSupport.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getSupport();
    }),

  getCmd123: publicProcedure
    .meta({
      description:
        "Inspection helper — raw XML→JSON dump for cmd_id 123 (no documented schema yet).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getCmd123(input.channel);
    }),

  getCmd209: publicProcedure
    .meta({
      description:
        "Inspection helper — raw XML→JSON dump for cmd_id 209 (no documented schema yet).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getCmd209(input.channel);
    }),

  getCmd265: publicProcedure
    .meta({
      description:
        "Inspection helper — raw XML→JSON dump for cmd_id 265 (no documented schema yet).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getCmd265(input.channel);
    }),

  getCmd440: publicProcedure
    .meta({
      description:
        "Inspection helper — raw XML→JSON dump for cmd_id 440 (no documented schema yet).",
    })
    .input(ConnectionWithChannel)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getCmd440(input.channel);
    }),

  // ============ EMAIL (SMTP server config) ============

  getEmail: publicProcedure
    .meta({
      description:
        "Get the SMTP email configuration (cmd_id=42) — server/port/user/recipients/SSL/attachment.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getEmail();
    }),

  setEmail: publicProcedure
    .meta({
      description:
        "Update SMTP email configuration (cmd_id=43). Read-modify-write — only the supplied fields are changed.",
    })
    .input(
      OptionalConnectionInput.extend({
        smtpServer: z.string().optional(),
        userName: z.string().optional(),
        password: z.string().optional(),
        address1: z.string().optional(),
        address2: z.string().optional(),
        address3: z.string().optional(),
        smtpPort: z.number().int().min(1).max(65535).optional(),
        sendNickname: z.string().optional(),
        attachment: z.union([z.literal(0), z.literal(1)]).optional(),
        attachmentType: z.enum(["picture", "video", "none"]).optional(),
        textType: z.enum(["withText", "noText"]).optional(),
        ssl: z.union([z.literal(0), z.literal(1)]).optional(),
        interval: z.number().int().min(0).max(3600).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, host: _h, port: _p, username: _u, password: _pw, ...patch } =
        input;
      void _c;
      void _h;
      void _p;
      void _u;
      void _pw;
      await api.setEmail(patch);
      return { success: true };
    }),

  testEmail: publicProcedure
    .meta({
      description:
        "Send a test email from the camera (cmd_id=141). The camera performs a real SMTP send — set `timeoutMs` generously (default 60s) because slow MTA negotiation is normal. Returns `{ success: true }` on cam response 200, `{ success: false }` on 482 (server unreachable / bad credentials).",
    })
    .input(
      OptionalConnectionInput.extend({
        // Same patch as setEmail — letting the caller override fields without
        // persisting them (handy for "send test before saving").
        smtpServer: z.string().optional(),
        userName: z.string().optional(),
        password: z.string().optional(),
        address1: z.string().optional(),
        address2: z.string().optional(),
        address3: z.string().optional(),
        smtpPort: z.number().int().min(1).max(65535).optional(),
        sendNickname: z.string().optional(),
        attachment: z.union([z.literal(0), z.literal(1)]).optional(),
        attachmentType: z.enum(["picture", "video", "none"]).optional(),
        textType: z.enum(["withText", "noText"]).optional(),
        ssl: z.union([z.literal(0), z.literal(1)]).optional(),
        interval: z.number().int().min(0).max(3600).optional(),
        timeoutMs: z.number().int().min(1000).max(180_000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const {
        cameraId: _c,
        host: _h,
        port: _p,
        username: _u,
        password: _pw,
        timeoutMs,
        ...patch
      } = input;
      void _c;
      void _h;
      void _p;
      void _u;
      void _pw;
      const ok = await api.testEmail(
        patch,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
      );
      return { success: ok };
    }),

  setEmailTask: publicProcedure
    .meta({
      description:
        "Update the email-alarm schedule (cmd_id=216). The `typeScheduleList` MUST be the full list from a prior `getEmailTask` (with the slots you want to flip patched in-place) — Reolink drops any entries omitted from the SET.",
    })
    .input(
      ConnectionWithChannel.extend({
        enable: z.union([z.literal(0), z.literal(1)]),
        typeScheduleList: z.array(
          z.object({
            type: z.string().min(1),
            valueTable: z
              .string()
              .length(168, "valueTable must be 168 chars (7 days × 24 hours)"),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      await api.setEmailTask(input.channel, {
        channelId: input.channel,
        enable: input.enable,
        typeScheduleList: input.typeScheduleList,
      });
      return { success: true };
    }),

  // ============ NTP ============

  getNtp: publicProcedure
    .meta({
      description:
        "Get NTP server configuration (cmd_id=38) — enable, server, port, sync interval (minutes).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getNtp();
    }),

  setNtp: publicProcedure
    .meta({
      description:
        "Update NTP configuration (cmd_id=39). Read-modify-write.",
    })
    .input(
      OptionalConnectionInput.extend({
        enable: z.union([z.literal(0), z.literal(1)]).optional(),
        server: z.string().optional(),
        synchronizeInterval: z.number().int().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, host: _h, port: _p, username: _u, password: _pw, ...patch } =
        input;
      void _c;
      void _h;
      void _p;
      void _u;
      void _pw;
      await api.setNtp(patch);
      return { success: true };
    }),

  // ============ SYSTEM GENERAL SET (timezone / manual time / device name / locale) ============

  setSystemGeneral: publicProcedure
    .meta({
      description:
        "Patch SystemGeneral (cmd_id=105). Supports partial payloads. Pass `manualTime` to set the camera clock explicitly; omit it to keep NTP-driven time. Setting only `deviceName` uses the dedicated `deviceNameOnly=1` shape.",
    })
    .input(
      OptionalConnectionInput.extend({
        timeZone: z
          .number()
          .int()
          .optional()
          .describe(
            "Offset in seconds, POSIX convention (UTC+1 → -3600, UTC-5 → 18000)",
          ),
        osdFormat: z.enum(["DMY", "MDY", "YMD"]).optional(),
        timeFormat: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe("0=24h, 1=12h"),
        language: z.string().optional(),
        deviceName: z.string().optional(),
        loginLock: z.union([z.literal(0), z.literal(1)]).optional(),
        lockTime: z.number().int().min(0).optional(),
        allowedTimes: z.number().int().min(0).optional(),
        manualTime: z
          .object({
            year: z.number().int().min(1970),
            month: z.number().int().min(1).max(12),
            day: z.number().int().min(1).max(31),
            hour: z.number().int().min(0).max(23),
            minute: z.number().int().min(0).max(59),
            second: z.number().int().min(0).max(59),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, host: _h, port: _p, username: _u, password: _pw, ...patch } =
        input;
      void _c;
      void _h;
      void _p;
      void _u;
      void _pw;
      await api.setSystemGeneral(patch);
      return { success: true };
    }),

  // ============ DST (Daylight Saving Time) ============

  getDst: publicProcedure
    .meta({
      description: "Get DST configuration (cmd_id=106).",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getDst();
    }),

  setDst: publicProcedure
    .meta({
      description: "Patch DST configuration (cmd_id=107). Read-modify-write.",
    })
    .input(
      OptionalConnectionInput.extend({
        enable: z.union([z.literal(0), z.literal(1)]).optional(),
        offset: z.number().int().min(0).max(2).optional(),
        startMonth: z.number().int().min(1).max(12).optional(),
        startWeekIndex: z.number().int().min(1).max(5).optional(),
        startWeekday: z
          .enum([
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ])
          .optional(),
        startHour: z.number().int().min(0).max(23).optional(),
        startMinute: z.number().int().min(0).max(59).optional(),
        startSecond: z.number().int().min(0).max(59).optional(),
        endMonth: z.number().int().min(1).max(12).optional(),
        endWeekIndex: z.number().int().min(1).max(5).optional(),
        endWeekday: z
          .enum([
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ])
          .optional(),
        endHour: z.number().int().min(0).max(23).optional(),
        endMinute: z.number().int().min(0).max(59).optional(),
        endSecond: z.number().int().min(0).max(59).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, host: _h, port: _p, username: _u, password: _pw, ...patch } =
        input;
      void _c;
      void _h;
      void _p;
      void _u;
      void _pw;
      await api.setDst(patch);
      return { success: true };
    }),

  // ============ AUTO REBOOT ============

  getAutoReboot: publicProcedure
    .meta({
      description:
        "Get the auto-reboot schedule (cmd_id=101) — enable, day, time.",
    })
    .input(OptionalConnectionInput)
    .query(async ({ input }) => {
      const api = await getApi(input);
      return await api.getAutoReboot();
    }),

  patchEmailSchedule: publicProcedure
    .meta({
      description:
        "High-level schedule editor: pick one or more trigger types and set them all to `always` / `never` / explicit windows. Other trigger slots on the camera are left untouched.",
    })
    .input(
      ConnectionWithChannel.extend({
        types: z.array(z.string().min(1)).min(1),
        enable: z.union([z.literal(0), z.literal(1)]).optional(),
        schedule: z.union([
          z.object({ kind: z.literal("always") }),
          z.object({ kind: z.literal("never") }),
          z.object({
            kind: z.literal("windows"),
            windows: z
              .array(
                z.object({
                  days: z.array(z.number().int().min(0).max(6)).min(1),
                  startHour: z.number().int().min(0).max(24),
                  endHour: z.number().int().min(0).max(24),
                }),
              )
              .min(1),
          }),
        ]),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      return await api.patchEmailSchedule(input.channel, {
        types: input.types,
        schedule: input.schedule,
        ...(input.enable !== undefined ? { enable: input.enable } : {}),
      });
    }),

  setupEmailPushToManager: publicProcedure
    .meta({
      description:
        "Auto-configure the camera to deliver motion emails to the local manager SMTP server. Orchestrates `setEmail` + `setEmailTask` (and optionally `testEmail`).",
    })
    .input(
      ConnectionWithChannel.extend({
        managerHost: z.string().min(1),
        managerPort: z.number().int().min(1).max(65535).optional(),
        recipientLocalPart: z.string().min(1),
        domain: z.string().optional(),
        attachmentType: z.enum(["picture", "video", "none"]).optional(),
        sendNickname: z.string().optional(),
        interval: z.number().int().min(0).max(3600).optional(),
        authUsername: z.string().optional(),
        authPassword: z.string().optional(),
        triggerTypes: z.array(z.string().min(1)).optional(),
        runTest: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const {
        cameraId: _c,
        host: _h,
        port: _p,
        username: _u,
        password: _pw,
        channel: _ch,
        ...rest
      } = input;
      void _c;
      void _h;
      void _p;
      void _u;
      void _pw;
      void _ch;
      return await api.setupEmailPushToManager(rest, input.channel);
    }),

  setAutoReboot: publicProcedure
    .meta({
      description:
        "Patch the auto-reboot schedule (cmd_id=100). Read-modify-write. `weekDay` accepts `Sunday`..`Saturday` or `everyday`.",
    })
    .input(
      OptionalConnectionInput.extend({
        enable: z.union([z.literal(0), z.literal(1)]).optional(),
        weekDay: z
          .enum([
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "everyday",
          ])
          .optional(),
        hour: z.number().int().min(0).max(23).optional(),
        minute: z.number().int().min(0).max(59).optional(),
        second: z.number().int().min(0).max(59).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const api = await getApi(input);
      const { cameraId: _c, host: _h, port: _p, username: _u, password: _pw, ...patch } =
        input;
      void _c;
      void _h;
      void _p;
      void _u;
      void _pw;
      await api.setAutoReboot(patch);
      return { success: true };
    }),
});
