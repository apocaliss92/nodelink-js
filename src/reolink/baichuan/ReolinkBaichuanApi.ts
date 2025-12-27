import { BaichuanClient, type BaichuanClientOptions } from "../../client/BaichuanClient.js";
import { xmlEscape, getXmlText, buildPreviewXml, buildPreviewStopXml, buildChannelExtensionXml } from "../../protocol/xml.js";
import { BC_CMD_ID_VIDEO, BC_CMD_ID_VIDEO_STOP, BC_CLASS_MODERN_24 } from "../../protocol/constants.js";
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
  ReolinkEvent,
  MotionEvent,
  AIEvent,
  TwoWayAudioConfig,
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
   * Subscribe to events (motion/AI/visitor) via Baichuan.
   * cmd_id: 31 (from reolink-aio subscribe_events)
   * After subscribing, events will be emitted via client.on("event", ...)
   */
  async subscribeEvents(): Promise<void> {
    await this.client.login();
    // cmd_id 31 with ch_id 251 subscribes to all events
    // Use extension XML with channelId 251 for host-level subscription
    const extensionXml = `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>251</channelId></Extension>`;
    await this.client.sendXml({ cmdId: 31, extensionXml });
    this.client.subscribed = true;
  }

  /**
   * Unsubscribe from events.
   */
  async unsubscribeEvents(): Promise<void> {
    // Note: reolink-aio doesn't have explicit unsubscribe, but closing connection unsubscribes
    // For now, we just mark as unsubscribed
    this.client.subscribed = false;
  }

  /**
   * GetEvents via Baichuan (legacy - use subscribeEvents for real-time events).
   * cmd_id: 33 (Motion/AI/Visitor event from reolink-aio _parse_xml)
   * Note: Events are typically pushed via cmd_id 33, not requested directly
   * Use subscribeEvents() to receive event pushes
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

  /**
   * Get two-way audio capability via Baichuan.
   * cmd_id: 10 (from reolink-aio - checks if two-way audio is supported)
   * Returns true if two-way audio is available.
   * 
   * Note: Both "mixAudioStream" and "followVideoStream" modes support two-way audio.
   * The difference is how audio is mixed with the video stream.
   */
  async getTwoWayAudioConfig(channel?: number): Promise<TwoWayAudioConfig> {
    const cmdId = 10; // From reolink-aio two-way audio check
    const xml = await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
    // Check for audioStreamMode - both mixAudioStream and followVideoStream support two-way audio
    const audioStreamMode = getXmlText(xml, "audioStreamMode");
    // Both modes support two-way audio, just different mixing strategies
    const enabled = audioStreamMode === "mixAudioStream" || audioStreamMode === "followVideoStream";

    const config: TwoWayAudioConfig = {
      channel: channel ?? 0,
      enabled,
    };
    if (audioStreamMode) {
      config.mode = audioStreamMode;
    }
    return config;
  }

  /**
   * Start two-way audio session via Baichuan.
   * cmd_id: 10 (from reolink-aio - two-way audio)
   * Based on neolink implementation: uses cmd_id 10 with audioStreamMode = "mixAudioStream"
   * 
   * Note: After starting, audio frames are received via push events with streamType indicating audio.
   * Audio is typically G.711 (alaw/ulaw) at 8kHz sample rate.
   */
  async startTwoWayAudio(channel?: number): Promise<void> {
    const cmdId = 10; // From reolink-aio two-way audio
    // Start two-way audio with mixAudioStream mode
    // Based on neolink: cmd_id 10 enables two-way audio
    await this.sendXml({ cmdId, ...(channel !== undefined ? { channel } : {}) });
  }

  /**
   * Send audio data via Baichuan protocol.
   * Based on neolink implementation: audio is sent via cmd_id 10 with binary audio data.
   * 
   * Audio Format Requirements:
   * - Format: G.711 A-law (pcm_alaw)
   * - Sample Rate: 8000 Hz
   * - Channels: 1 (mono)
   * - Bitrate: 64k (typical)
   * 
   * Note: Audio data should already be in G.711 A-law format (from Scrypted/ffmpeg).
   *       No encoding is performed - data is sent directly to the camera.
   * 
   * @param audioData - G.711 A-law encoded audio data (from Scrypted/ffmpeg)
   * @param channel - Channel number (optional)
   */
  async sendAudioData(audioData: Buffer, channel?: number): Promise<void> {
    const cmdId = 10; // Two-way audio command
    // Based on neolink: audio data is sent as binary payload with cmd_id 10
    // streamType in header may indicate audio stream (typically 1 for audio)
    // Note: Actual implementation may need to use sendBinary or a specialized method
    // For now, this is a placeholder - needs testing with real device
    // 
    // Note: sendBinary expects XML payload, but audio is binary
    // This may need a specialized method or modification to sendBinary
    // For now, we'll use sendBinary with empty XML and note that audio data
    // should be sent via a different mechanism (possibly raw socket write)
    const params: Parameters<typeof this.client.sendBinary>[0] = {
      cmdId,
      payloadXml: "", // Audio data is binary, not XML
    };
    if (channel !== undefined) {
      params.channel = channel;
    }
    // Note: This is a placeholder - actual audio sending may require
    // direct socket writes or a specialized audio streaming method
    await this.client.sendBinary(params);
  }

  /**
   * Stop two-way audio session.
   * Based on neolink: stopping typically involves closing the audio stream or sending stop command.
   */
  async stopTwoWayAudio(channel?: number): Promise<void> {
    // Note: May need specific cmd_id or parameters to stop
    // Based on neolink, stopping may involve:
    // - Closing the audio stream connection
    // - Sending a stop command (if supported)
    // For now, this is a placeholder - needs testing with real device
  }

  /**
   * Start video stream via Baichuan protocol.
   * Based on neolink stream.rs implementation.
   * 
   * Reference: https://github.com/QuantumEntangledAndy/neolink/blob/master/crates/core/src/bc_protocol/stream.rs#L108
   * 
   * Uses MSG_ID_VIDEO command with Preview XML payload containing:
   * - channelId: Channel ID (1-based)
   * - handle: Stream handle (0 for main, 256 for sub, 1024 for extern)
   * - streamType: Stream name ("mainStream", "subStream", "externStream")
   * 
   * @param channel - Channel number (0-based)
   * @param profile - Stream profile ("main" | "sub" | "ext")
   * @returns Promise that resolves when stream request is sent
   */
  async startVideoStream(channel: number, profile: StreamProfile = "sub"): Promise<void> {
    const channelId = channel + 1; // Convert to 1-based for Baichuan protocol
    
    // Map profile to handle and stream_type values (from neolink stream.rs)
    // handle: 0 for main, 256 for sub, 1024 for extern
    // stream_type in header: 0 for main, 1 for sub, 0 for extern
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number; streamName: string }> = {
      main: { handle: 0, streamType: 0, streamName: "mainStream" },
      sub: { handle: 256, streamType: 1, streamName: "subStream" },
      ext: { handle: 1024, streamType: 0, streamName: "externStream" },
    };
    
    const config = profileConfig[profile];
    
    // Build Preview XML payload (from neolink stream.rs line 171-189)
    // BcXml serializes as <body>...</body> with Preview inside
    // IMPORTANT: channelId is NOT in Preview XML - it's handled via channelId in header
    // The working format (response_code 200) is Preview WITHOUT channelId
    const payloadXml = buildPreviewXml(config.handle, config.streamName);
    
    // Neolink uses connection.subscribe(MSG_ID_VIDEO, msg_num) BEFORE sending the command
    // This creates a dedicated channel for video frames. In our implementation,
    // we subscribe to the msgNum that will be used for the command.
    const msgNum = this.client.peekNextMsgNum();
    
    // Subscribe to video stream frames with this msgNum (similar to neolink)
    // This ensures we capture video frames that match this specific request
    this.client.subscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
    
    // Send video stream start command
    // Based on neolink stream.rs:
    // - Uses BC_CLASS_MODERN_24 (0x6414) as in neolink
    // - streamType in header must match the stream type (0 for main/ext, 1 for sub)
    // - NO Extension XML - neolink doesn't use it in stream.rs (only BcXml with Preview)
    // - Neolink expects response_code 200, otherwise it returns an error
    const frameParams: Parameters<typeof this.client.sendFrame>[0] = {
      cmdId: BC_CMD_ID_VIDEO,
      channel,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: config.streamType, // 0 for main/ext, 1 for sub
    };
    // Omit extensionXml - neolink doesn't use it for Preview command
    const frame = await this.client.sendFrame(frameParams);
    
    // Check response_code (neolink expects 200 and rejects anything else)
    // From neolink stream.rs line 194-202: if response_code is not 200, it returns an error
    if (frame.header.responseCode !== 200) {
      // Unsubscribe on error
      this.client.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
      throw new Error(`Video stream request rejected (response_code ${frame.header.responseCode}). Neolink expects response_code 200, camera returned ${frame.header.responseCode}`);
    }
    
    // Success - stream should start and frames will arrive as push events with cmd_id 3
    
    // Check for response code 200 (success)
    // neolink expects response_code: 200 in the reply
    // If response_code is not 200, the stream request was rejected
    // Note: sendXml doesn't expose response_code directly, but it throws on 400 errors
    // For video streaming, we might need to check the actual frame response_code
  }

  /**
   * Stop video stream via Baichuan protocol.
   * Based on neolink stream.rs implementation.
   * 
   * Reference: https://github.com/QuantumEntangledAndy/neolink/blob/master/crates/core/src/bc_protocol/stream.rs
   * 
   * Uses MSG_ID_VIDEO_STOP command with Preview XML payload (without stream_type).
   * 
   * @param channel - Channel number (0-based)
   * @param profile - Stream profile ("main" | "sub" | "ext")
   */
  async stopVideoStream(channel: number, profile: StreamProfile = "sub"): Promise<void> {
    const channelId = channel + 1; // Convert to 1-based for Baichuan protocol
    
    // Map profile to handle value (from neolink stream.rs)
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number }> = {
      main: { handle: 0, streamType: 0 },
      sub: { handle: 256, streamType: 1 },
      ext: { handle: 1024, streamType: 0 },
    };
    
    const config = profileConfig[profile];
    
    // Build Preview XML payload for stop (without stream_type)
    // channelId is NOT in Preview XML - it's handled via channelId in header
    const payloadXml = buildPreviewStopXml(config.handle);
    
    // Send video stream stop command
    // Uses BC_CLASS_MODERN_24 (0x6414) as in neolink
    // streamType in header must match the stream type (0 for main/ext, 1 for sub)
    await this.sendXml({
      cmdId: BC_CMD_ID_VIDEO_STOP,
      channel,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: config.streamType, // 0 for main/ext, 1 for sub
    });
  }
}

