import { BaichuanClient, type BaichuanClientOptions } from "../../client/BaichuanClient.js";
import { xmlEscape, getXmlText } from "../../protocol/xml.js";
import type {
  OsdConfig,
  AIState,
  PtzPreset,
  PtzCommand,
  BatteryInfo,
  PirState,
  WhiteLedState,
  AudioAlarmParams,
  Events,
  StreamMetadata,
  ChannelStreamMetadata,
  StreamProfile,
  VideoCodec,
} from "./types.js";

export type ReolinkBaichuanPorts = Record<string, Record<string, number>>;

function getXmlTexts(xml: string, tags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    const v = getXmlText(xml, t);
    if (v !== undefined) out[t] = v;
  }
  return out;
}

export class ReolinkBaichuanApi {
  readonly client: BaichuanClient;

  constructor(opts: BaichuanClientOptions) {
    this.client = new BaichuanClient(opts);
  }

  async login(): Promise<void> {
    await this.client.login();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Generic Baichuan cmd_id call, returns XML (if any). */
  async sendXml(params: Parameters<BaichuanClient["sendXml"]>[0]): Promise<string> {
    await this.client.login();
    return await this.client.sendXml(params);
  }

  /** Generic Baichuan cmd_id call, returns binary data (for commands like Snap). */
  async sendBinary(params: Parameters<BaichuanClient["sendBinary"]>[0]): Promise<Buffer> {
    await this.client.login();
    return await this.client.sendBinary(params);
  }

  // --------------------
  // Main operations (from reolink_aio/baichuan.py)
  // --------------------

  /** GetNetPort via Baichuan: cmd_id 37 */
  async getPorts(): Promise<ReolinkBaichuanPorts> {
    const xml = await this.sendXml({ cmdId: 37 });
    // Parser minimale: estrae <RtspPort><enable>...</enable><port>...</port>...
    const ports: ReolinkBaichuanPorts = {};
    const protoBlocks = xml.matchAll(/<([A-Za-z]+)Port[^>]*>([\s\S]*?)<\/\1Port>/g);
    for (const m of protoBlocks) {
      const proto = (m[1] ?? "").toLowerCase();
      const inner = m[2] ?? "";
      const kv: Record<string, number> = {};
      for (const kvp of inner.matchAll(/<([A-Za-z]+)>(-?\d+)<\/\1>/g)) {
        const k = (kvp[1] ?? "").toLowerCase();
        const v = Number(kvp[2]);
        if (Number.isFinite(v)) kv[k] = v;
      }
      if (Object.keys(kv).length) ports[proto] = kv;
    }
    return ports;
  }

  /** SetNetPort via Baichuan: cmd_id 36 (enable/disable rtsp/rtmp/onvif/http/https) */
  async setPortEnabled(params: { port: "rtsp" | "rtmp" | "onvif" | "http" | "https"; enable: boolean }): Promise<void> {
    const tag = `${params.port[0]!.toUpperCase()}${params.port.slice(1)}Port`;
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<${tag} version="1.1">` +
      `<enable>${params.enable ? 1 : 0}</enable>` +
      `</${tag}>` +
      `</body>`;
    await this.sendXml({ cmdId: 36, payloadXml: xml });
  }

  /** GetDevInfo via Baichuan: host cmd_id 80, channel cmd_id 318 */
  async getInfo(channel?: number): Promise<Record<string, string>> {
    const req: { cmdId: number; channel?: number } = { cmdId: channel == null ? 80 : 318 };
    if (channel !== undefined) req.channel = channel;
    const xml = await this.sendXml(req);
    // Keys used by reolink_aio: type, hardwareVersion, firmwareVersion, itemNo, serialNumber, name
    return getXmlTexts(xml, ["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"]);
  }

  /** GetEnc via Baichuan: cmd_id 56 (returns raw XML). */
  async getEncXml(channel: number): Promise<string> {
    return await this.sendXml({ cmdId: 56, channel });
  }

  /**
   * GetStreamMetadata via Baichuan: cmd_id 56 (GetEnc).
   * Returns metadata for all available streams (main, sub, ext) including:
   * - Video codec (H.264, H.265, etc.)
   * - Resolution (width x height)
   * - Frame rate (FPS)
   * - Bitrate
   * - Audio enabled
   * 
   * Note on extStream:
   * - extStream is only present in the XML response if it's enabled/supported by the camera
   * - If extStream is not present in the XML, it means it's not available for that channel
   * - extStream availability is determined by the camera firmware/model capabilities
   * - There's no explicit "enable" field for extStream in the GetEnc response
   * - extStream is typically available on newer Reolink models that support multiple stream profiles
   */
  async getStreamMetadata(channel: number): Promise<ChannelStreamMetadata> {
    const xml = await this.getEncXml(channel);
    const streams: StreamMetadata[] = [];
    let audioEnabled = true;

    // Video encoding type mapping (from reolink-aio EncodingEnum)
    const videoCodecMap: Record<number, VideoCodec> = {
      0: "H.264",
      1: "H.265",
      2: "MJPEG",
      3: "MPEG4",
    };

    // Parse mainStream
    const mainMatch = xml.match(/<mainStream[^>]*>([\s\S]*?)<\/mainStream>/);
    if (mainMatch) {
      const mainXml = mainMatch[1] ?? "";
      const width = Number(getXmlText(mainXml, "width") ?? "0");
      const height = Number(getXmlText(mainXml, "height") ?? "0");
      const videoEncTypeInt = Number(getXmlText(mainXml, "videoEncType") ?? "0");
      const frameRate = Number(getXmlText(mainXml, "frame") ?? "0");
      const bitRate = Number(getXmlText(mainXml, "bitRate") ?? "0");
      const audio = Number(getXmlText(mainXml, "audio") ?? "0");
      // Check if mainStream has an enable field (some cameras may have this)
      const enabled = getXmlText(mainXml, "enable");
      const isEnabled = enabled === undefined || enabled === "1" || enabled === "true";

      if (isEnabled) {
        streams.push({
          profile: "main",
          audio,
          width,
          height,
          videoEncType: videoCodecMap[videoEncTypeInt] ?? `Unknown(${videoEncTypeInt})`,
          videoEncTypeInt,
          frameRate,
          bitRate,
        });
        audioEnabled = audioEnabled && audio === 1;
      }
    }

    // Parse subStream
    const subMatch = xml.match(/<subStream[^>]*>([\s\S]*?)<\/subStream>/);
    if (subMatch) {
      const subXml = subMatch[1] ?? "";
      const width = Number(getXmlText(subXml, "width") ?? "0");
      const height = Number(getXmlText(subXml, "height") ?? "0");
      const videoEncTypeInt = Number(getXmlText(subXml, "videoEncType") ?? "0");
      const frameRate = Number(getXmlText(subXml, "frame") ?? "0");
      const bitRate = Number(getXmlText(subXml, "bitRate") ?? "0");
      const audio = Number(getXmlText(subXml, "audio") ?? "0");
      // Check if subStream has an enable field
      const enabled = getXmlText(subXml, "enable");
      const isEnabled = enabled === undefined || enabled === "1" || enabled === "true";

      if (isEnabled) {
        streams.push({
          profile: "sub",
          audio,
          width,
          height,
          videoEncType: videoCodecMap[videoEncTypeInt] ?? `Unknown(${videoEncTypeInt})`,
          videoEncTypeInt,
          frameRate,
          bitRate,
        });
        audioEnabled = audioEnabled && audio === 1;
      }
    }

    // Parse extStream (if available)
    // Note: extStream is only present in XML if enabled/supported by the camera
    // If extStream is not in the XML, it's not available for this channel
    const extMatch = xml.match(/<extStream[^>]*>([\s\S]*?)<\/extStream>/);
    if (extMatch) {
      const extXml = extMatch[1] ?? "";
      const width = Number(getXmlText(extXml, "width") ?? "0");
      const height = Number(getXmlText(extXml, "height") ?? "0");
      const videoEncTypeInt = Number(getXmlText(extXml, "videoEncType") ?? "0");
      const frameRate = Number(getXmlText(extXml, "frame") ?? "0");
      const bitRate = Number(getXmlText(extXml, "bitRate") ?? "0");
      const audio = Number(getXmlText(extXml, "audio") ?? "0");
      // Check if extStream has an enable field (though typically if it's present, it's enabled)
      const enabled = getXmlText(extXml, "enable");
      const isEnabled = enabled === undefined || enabled === "1" || enabled === "true";

      if (isEnabled) {
        streams.push({
          profile: "ext",
          audio,
          width,
          height,
          videoEncType: videoCodecMap[videoEncTypeInt] ?? `Unknown(${videoEncTypeInt})`,
          videoEncTypeInt,
          frameRate,
          bitRate,
        });
        audioEnabled = audioEnabled && audio === 1;
      }
    }

    return {
      channel,
      streams,
      audioEnabled,
    };
  }

  /** SetEnc via Baichuan: cmd_id 57 (sends raw XML). */
  async setEncXml(channel: number, encXml: string): Promise<void> {
    await this.sendXml({ cmdId: 57, channel, payloadXml: encXml });
  }

  /** Bulk SetNetPort helper (reolink_aio-style): accepts NetPort with onvifEnable/rtmpEnable/rtspEnable. */
  async setNetPort(netPort: { onvifEnable?: number; rtmpEnable?: number; rtspEnable?: number }): Promise<void> {
    if (netPort.onvifEnable != null) await this.setPortEnabled({ port: "onvif", enable: netPort.onvifEnable === 1 });
    if (netPort.rtmpEnable != null) await this.setPortEnabled({ port: "rtmp", enable: netPort.rtmpEnable === 1 });
    if (netPort.rtspEnable != null) await this.setPortEnabled({ port: "rtsp", enable: netPort.rtspEnable === 1 });
  }

  /** Reboot via Baichuan: cmd_id 23 */
  async reboot(channel?: number): Promise<void> {
    const req: { cmdId: number; channel?: number } = { cmdId: 23 };
    if (channel !== undefined) req.channel = channel;
    await this.sendXml(req);
  }

  /** Ping via Baichuan: cmd_id 93 (header-only / no payload) */
  async ping(): Promise<void> {
    await this.sendXml({ cmdId: 93 });
  }

  /** GetLocalLink via Baichuan: cmd_id 104 (general info) - on many models includes MAC/network info. */
  async getGeneralXml(channel?: number): Promise<string> {
    const req: { cmdId: number; channel?: number } = { cmdId: 104 };
    if (channel !== undefined) req.channel = channel;
    return await this.sendXml(req);
  }

  /** SetGeneralXml via Baichuan: cmd_id 105 */
  async setGeneralXml(channel: number | undefined, xml: string): Promise<void> {
    await this.sendXml({ cmdId: 105, ...(channel === undefined ? {} : { channel }), payloadXml: xml });
  }

  /** Helper to build a channel Extension XML (for payloads that require it). */
  static buildChannelExtensionXml(channel: number): string {
    return `<?xml version="1.0" encoding="UTF-8" ?>` + `<Extension version="1.1"><channelId>${xmlEscape(String(channel))}</channelId></Extension>`;
  }

  // --------------------
  // New API implementations (cmd_id to be identified/tested)
  // --------------------

  /**
   * GetMotionState via Baichuan.
   * cmd_id: 46 (from reolink-aio GetMdAlarm)
   * Returns true if motion detection is enabled.
   */
  async getMotionState(channel?: number): Promise<boolean> {
    const cmdId = 46; // From reolink-aio GetMdAlarm
    const xml = await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
    // Parse XML to extract motion state from sensInfoNew
    // Expected format: <sensInfoNew><enable>1</enable>...</sensInfoNew>
    const enable = getXmlText(xml, "enable");
    return enable === "1" || enable === "true";
  }

  /**
   * GetOsd via Baichuan.
   * cmd_id: 26 (GetImage - includes OSD settings from reolink-aio)
   */
  async getOsd(channel: number): Promise<OsdConfig> {
    const cmdId = 26; // From reolink-aio GetImage (includes OSD)
    const xml = await this.sendXml({ cmdId, channel });
    // Parse OSD XML structure from VideoInput/OsdChannel and OsdTime
    // This is a placeholder - actual parsing depends on XML structure
    return {
      channel,
      osdChannel: {
        enable: Number(getXmlText(xml, "enable") ?? "0"),
        name: getXmlText(xml, "name") ?? "",
        pos: getXmlText(xml, "pos") ?? "",
      },
      osdTime: {
        enable: Number(getXmlText(xml, "timeEnable") ?? "0"),
        pos: getXmlText(xml, "timePos") ?? "",
      },
      watermark: Number(getXmlText(xml, "watermark") ?? "0"),
    };
  }

  /**
   * SetOsd via Baichuan.
   * cmd_id: 25 (SetImage - includes OSD settings from reolink-aio)
   */
  async setOsd(channel: number, osd: OsdConfig): Promise<void> {
    const cmdId = 25; // From reolink-aio SetImage (includes OSD)
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<Osd version="1.1">` +
      `<channel>${channel}</channel>` +
      `<osdChannel>` +
      `<enable>${osd.osdChannel.enable}</enable>` +
      `<name>${xmlEscape(osd.osdChannel.name)}</name>` +
      `<pos>${xmlEscape(osd.osdChannel.pos)}</pos>` +
      `</osdChannel>` +
      `<osdTime>` +
      `<enable>${osd.osdTime.enable}</enable>` +
      `<pos>${xmlEscape(osd.osdTime.pos)}</pos>` +
      `</osdTime>` +
      `<watermark>${osd.watermark}</watermark>` +
      `</Osd>` +
      `</body>`;
    await this.sendXml({ cmdId, channel, payloadXml: xml });
  }

  /**
   * GetAiState via Baichuan.
   * cmd_id: 342 (from reolink-aio GetAiAlarm)
   * Note: GetAiAlarm requires ai_type parameter, this is a simplified wrapper
   */
  async getAiState(channel?: number): Promise<AIState> {
    const cmdId = 342; // From reolink-aio GetAiAlarm
    // Note: GetAiAlarm requires ai_type, but we'll try without for now
    // This may need to be adjusted based on actual API requirements
    const xml = await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
    // Parse AI state XML
    const state: AIState = {
      channel: channel ?? 0,
      alarm_state: Number(getXmlText(xml, "alarm_state") ?? "0"),
      support: Number(getXmlText(xml, "support") ?? "0"),
    };
    return state;
  }

  /**
   * GetSnapshot via Baichuan (binary response).
   * cmd_id: 109 (from reolink-aio snapshot)
   * Returns JPEG image as Buffer.
   * Note: Snapshot uses a special message ID system for binary responses
   */
  async getSnapshot(channel?: number): Promise<Buffer> {
    const cmdId = 109; // From reolink-aio snapshot
    // Note: reolink-aio uses a special mess_id system for snapshots
    // This may need adjustment based on actual implementation
    return await this.sendBinary({ cmdId, ...(channel !== undefined ? { channel } : {}) });
  }

  /**
   * GetEvents via Baichuan.
   * cmd_id: 33 (Motion/AI/Visitor event from reolink-aio _parse_xml)
   * Note: Events are typically pushed via cmd_id 33, not requested directly
   * Use subscribe_events (cmd_id 31) to receive event pushes
   */
  async getEvents(channel?: number): Promise<Events> {
    // Note: Events are typically pushed, not requested
    // cmd_id 33 is used for event pushes, cmd_id 31 is for subscribing
    // This is a placeholder - actual implementation may need event subscription
    const cmdId = 33; // From reolink-aio _parse_xml (event push)
    const xml = await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
    // Parse events XML
    // This is a placeholder - actual structure depends on device
    return {
      channel: channel ?? 0,
      ai: {
        channel: channel ?? 0,
        alarm_state: Number(getXmlText(xml, "alarm_state") ?? "0"),
      },
    };
  }
}

