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
});
