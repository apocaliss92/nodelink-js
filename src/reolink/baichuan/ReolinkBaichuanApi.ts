import { BaichuanRtspServer, type BaichuanRtspServerOptions } from "../../baichuan/stream/BaichuanRtspServer";
import { BaichuanClient, type BaichuanClientOptions } from "../../client/BaichuanClient";
import { type Logger } from "../../debug/DebugConfig";
import {
  BC_CLASS_MODERN_24,
  BC_CLASS_FILE_DOWNLOAD,
  BC_CMD_ID_ABILITY_INFO,
  BC_CMD_ID_AUDIO_ALARM_PLAY,
  BC_CMD_ID_GET_AUDIO_ALARM,
  BC_CMD_ID_GET_BATTERY_INFO,
  BC_CMD_ID_GET_BATTERY_INFO_LIST,
  BC_CMD_ID_GET_PIR_INFO,
  BC_CMD_ID_GET_PTZ_POSITION,
  BC_CMD_ID_GET_PTZ_PRESET,
  BC_CMD_ID_GET_WHITE_LED,
  BC_CMD_ID_GET_ZOOM_FOCUS,
  BC_CMD_ID_FLOODLIGHT_STATUS_LIST,
  BC_CMD_ID_PTZ_CONTROL,
  BC_CMD_ID_PTZ_CONTROL_PRESET,
  BC_CMD_ID_SET_AI_ALARM,
  BC_CMD_ID_SET_MOTION_ALARM,
  BC_CMD_ID_SET_PIR_INFO,
  BC_CMD_ID_SET_WHITE_LED_STATE,
  BC_CMD_ID_SET_WHITE_LED_TASK,
  BC_CMD_ID_SET_ZOOM_FOCUS,
  BC_CMD_ID_SUPPORT,
  BC_CMD_ID_TALK,
  BC_CMD_ID_TALK_ABILITY,
  BC_CMD_ID_TALK_CONFIG,
  BC_CMD_ID_TALK_RESET,
  BC_CMD_ID_UDP_KEEP_ALIVE,
  BC_CMD_ID_VIDEO,
  BC_CMD_ID_VIDEO_STOP,
  BC_CMD_ID_FILE_INFO_LIST_OPEN,
  BC_CMD_ID_FILE_INFO_LIST_GET,
  BC_CMD_ID_FILE_INFO_LIST_CLOSE,
  BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
  BC_CMD_ID_FIND_REC_VIDEO_OPEN,
  BC_CMD_ID_FIND_REC_VIDEO_GET,
  BC_CMD_ID_FIND_REC_VIDEO_CLOSE,
} from "../../protocol/constants";
import { buildAbilityInfoExtensionXml, buildBinaryExtensionXml, buildChannelExtensionXml, buildFloodlightManualXml, buildPreviewStopXml, buildPreviewXml, buildPtzControlXml, buildPtzPresetXml, buildPtzPresetXmlV2, buildSirenManualXml, buildSirenTimesXml, buildStartZoomFocusXml, getXmlText, xmlEscape } from "../../protocol/xml";
import {
  type AIEvent,
  type AIState,
  type BatteryInfo,
  type ChannelStreamMetadata,
  type DeviceAbilities,
  type DeviceCapabilities,
  type DeviceCapabilitiesResult,
  type DeviceSupportFlags,
  type Events,
  type OsdConfig,
  type PirState,
  type PtzCommand,
  type PtzPreset,
  type ReolinkEvent,
  type ReolinkSimpleEvent,
  type ReolinkSimpleEventType,
  type StreamMetadata,
  type StreamProfile,
  type SleepStatus,
  type SupportInfo,
  type TwoWayAudioConfig,
  type VideoCodec,
  type WhiteLedState,
  type DownloadRecordingParams,
  type ListRecordingsParams,
  type RecordingFile,
} from "./types";

import { parseRecordingFileName } from "./recordingFileName";

import { abilitiesHasAny, computeDeviceCapabilities, flattenAbilitiesForChannel, parseSupportXml } from "./capabilities";
import { ReolinkHttpClient } from "../http/ReolinkHttpClient";

type TalkAbility = import("./types").TalkAbility;
type TalkAudioConfig = import("./types").TalkAudioConfig;
type TalkConfig = import("./types").TalkConfig;
type TalkSession = import("./types").TalkSession;
type TalkSessionInfo = import("./types").TalkSessionInfo;

export type ReolinkBaichuanPorts = Record<string, Record<string, number>>;

export type WakeUpOptions = {
  /** Timeout per singolo tentativo (default: 20000). */
  timeoutMs?: number;
  /** Numero di tentativi (default: 3). */
  attempts?: number;
  /** Delay dopo un tentativo che “sblocca” la camera (default: 1500). */
  waitAfterWakeMs?: number;
  /** Delay tra tentativi falliti (default: 1500). */
  backoffMs?: number;
  /**
   * Se true, chiude la connessione e forza un reconnect prima del retry.
   * Default: true per UDP (battery), false per TCP.
   */
  reconnect?: boolean;
};

function getXmlTexts(xml: string, tags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    const v = getXmlText(xml, t);
    if (v !== undefined) out[t] = v;
  }
  return out;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getXmlBlocks(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(xml))) {
    out.push(m[1] ?? "");
  }
  return out;
}

function parseXmlDateTimeBlock(block: string): Date | undefined {
  const year = Number.parseInt(getXmlText(block, "year") ?? "", 10);
  const month = Number.parseInt(getXmlText(block, "month") ?? "", 10);
  const day = Number.parseInt(getXmlText(block, "day") ?? "", 10);
  const hour = Number.parseInt(getXmlText(block, "hour") ?? "", 10);
  const minute = Number.parseInt(getXmlText(block, "minute") ?? "", 10);
  const second = Number.parseInt(getXmlText(block, "second") ?? "", 10);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return undefined;
  // Treat as local time; camera typically returns local timestamps.
  return new Date(year, month - 1, day, hour, minute, second);
}

function xmlDateTimePayload(tag: "startTime" | "endTime", d: Date): string {
  return `<${tag}><year>${d.getFullYear()}</year><month>${d.getMonth() + 1}</month><day>${d.getDate()}</day><hour>${d.getHours()}</hour><minute>${d.getMinutes()}</minute><second>${d.getSeconds()}</second></${tag}>`;
}

function parseRecordingFilesFromXml(xml: string): RecordingFile[] {
  const out: RecordingFile[] = [];

  // FileInfoList commonly returns <FileInfo> blocks with <name> and/or <Id>.
  // Prefer <Id> (full path) as the identifier for download, but keep <name> when present.
  const fileInfoBlocks = getXmlBlocks(xml, "FileInfo");
  for (const b of fileInfoBlocks) {
    const id = getXmlText(b, "Id") ?? getXmlText(b, "ID") ?? getXmlText(b, "id");
    const name = getXmlText(b, "name") ?? getXmlText(b, "fileName");
    const chosen = (id ?? name)?.trim();
    if (!chosen) continue;
    const item: RecordingFile = { fileName: chosen };
    if (name != null && name.trim()) item.name = name.trim();
    if (id != null && id.trim()) item.id = id.trim();
    const recordType = getXmlText(b, "type") ?? getXmlText(b, "recordType") ?? getXmlText(b, "alarmType");
    if (recordType != null) item.recordType = recordType;
    const sizeText = getXmlText(b, "size") ?? getXmlText(b, "fileSize");
    const sizeBytes = sizeText ? Number.parseInt(sizeText, 10) : undefined;
    if (sizeBytes != null && Number.isFinite(sizeBytes)) item.sizeBytes = sizeBytes;
    const start = getXmlBlocks(b, "startTime")[0];
    const end = getXmlBlocks(b, "endTime")[0];
    const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
    const endDt = end ? parseXmlDateTimeBlock(end) : undefined;
    if (startDt) item.startTime = startDt;
    if (endDt) item.endTime = endDt;

    const parsed = parseRecordingFileName(item.name ?? item.fileName);
    if (parsed) {
      item.parsedFileName = parsed;
      if (!item.startTime) item.startTime = parsed.start;
      if (!item.endTime) item.endTime = parsed.end;
    }
    out.push(item);
  }

  // Preferred: parse <File> blocks (common in many Reolink list responses).
  const fileBlocks = getXmlBlocks(xml, "File");
  for (const b of fileBlocks) {
    const fileName = getXmlText(b, "fileName") ?? getXmlText(b, "name");
    if (!fileName) continue;
    const sizeText = getXmlText(b, "size") ?? getXmlText(b, "fileSize");
    const sizeBytes = sizeText ? Number.parseInt(sizeText, 10) : undefined;
    const recordType = getXmlText(b, "type") ?? getXmlText(b, "recordType") ?? getXmlText(b, "alarmType");
    const start = getXmlBlocks(b, "startTime")[0];
    const end = getXmlBlocks(b, "endTime")[0];
    const item: RecordingFile = { fileName };
    if (sizeBytes != null && Number.isFinite(sizeBytes)) item.sizeBytes = sizeBytes;
    if (recordType != null) item.recordType = recordType;
    const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
    const endDt = end ? parseXmlDateTimeBlock(end) : undefined;
    if (startDt) item.startTime = startDt;
    if (endDt) item.endTime = endDt;

    const parsed = parseRecordingFileName(item.fileName);
    if (parsed) {
      item.parsedFileName = parsed;
      if (!item.startTime) item.startTime = parsed.start;
      if (!item.endTime) item.endTime = parsed.end;
    }
    out.push(item);
  }

  // Fallback: any <fileName> tags.
  if (out.length === 0) {
    const re = /<fileName>([\s\S]*?)<\/fileName>/g;
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(xml))) {
      const fileName = (m[1] ?? "").trim();
      if (!fileName) continue;
      const item: RecordingFile = { fileName };
      const parsed = parseRecordingFileName(fileName);
      if (parsed) {
        item.parsedFileName = parsed;
        item.startTime = parsed.start;
        item.endTime = parsed.end;
      }
      out.push(item);
    }
  }

  // Alarm video list: <alarmVideo><fileName>...</fileName><alarmType>...</alarmType>...</alarmVideo>
  // Some firmwares use this API instead of FileInfoList for recordings.
  if (out.length === 0) {
    const alarmBlocks = getXmlBlocks(xml, "alarmVideo");
    for (const b of alarmBlocks) {
      const fileName = getXmlText(b, "fileName") ?? getXmlText(b, "name");
      if (!fileName) continue;
      const item: RecordingFile = { fileName };
      const alarmType = getXmlText(b, "alarmType");
      if (alarmType != null) item.recordType = alarmType;
      const start = getXmlBlocks(b, "startTime")[0];
      const end = getXmlBlocks(b, "endTime")[0];
      const startDt = start ? parseXmlDateTimeBlock(start) : undefined;
      const endDt = end ? parseXmlDateTimeBlock(end) : undefined;
      if (startDt) item.startTime = startDt;
      if (endDt) item.endTime = endDt;

      const parsed = parseRecordingFileName(item.fileName);
      if (parsed) {
        item.parsedFileName = parsed;
        if (!item.startTime) item.startTime = parsed.start;
        if (!item.endTime) item.endTime = parsed.end;
      }
      out.push(item);
    }
  }

  // De-dup by fileName.
  const seen = new Set<string>();
  return out.filter((f) => {
    if (seen.has(f.fileName)) return false;
    seen.add(f.fileName);
    return true;
  });
}

function parseTalkAudioConfig(block: string): TalkAudioConfig | null {
  const audioType = getXmlText(block, "audioType");
  const sampleRate = Number.parseInt(getXmlText(block, "sampleRate") ?? "", 10);
  const samplePrecision = Number.parseInt(getXmlText(block, "samplePrecision") ?? "", 10);
  const lengthPerEncoder = Number.parseInt(getXmlText(block, "lengthPerEncoder") ?? "", 10);
  const soundTrack = getXmlText(block, "soundTrack");
  const priorityText = getXmlText(block, "priority");

  if (!audioType || !Number.isFinite(sampleRate) || !Number.isFinite(samplePrecision) || !Number.isFinite(lengthPerEncoder) || !soundTrack) {
    return null;
  }

  const config: TalkAudioConfig = {
    audioType,
    sampleRate,
    samplePrecision,
    lengthPerEncoder,
    soundTrack,
  };
  if (priorityText !== undefined) {
    const pr = Number.parseInt(priorityText, 10);
    if (Number.isFinite(pr)) config.priority = pr;
  }
  return config;
}

function parseTalkAbilityXml(xml: string): TalkAbility {
  const talkAbilityBlock = getXmlBlocks(xml, "TalkAbility")[0];
  if (!talkAbilityBlock) {
    throw new Error("TalkAbility XML not found in response");
  }

  const duplexListBlocks = getXmlBlocks(talkAbilityBlock, "duplexList");
  const duplexList = duplexListBlocks
    .map((b) => getXmlText(b, "duplex"))
    .filter((v): v is string => !!v);

  const audioStreamModeListBlocks = getXmlBlocks(talkAbilityBlock, "audioStreamModeList");
  const audioStreamModeList = audioStreamModeListBlocks
    .map((b) => getXmlText(b, "audioStreamMode"))
    .filter((v): v is string => !!v);

  // audioConfig blocks are nested under audioConfigList -> audioConfig
  const audioConfigBlocks = getXmlBlocks(talkAbilityBlock, "audioConfig");
  const audioConfigList = audioConfigBlocks
    .map(parseTalkAudioConfig)
    .filter((v): v is TalkAudioConfig => !!v);

  return {
    duplexList,
    audioStreamModeList,
    audioConfigList,
  };
}

function mapToSimpleEvent(event: ReolinkEvent): ReolinkSimpleEvent | null {
  const timestamp = event.timestamp ?? Date.now();

  if (event.type === "motion") {
    return { type: "motion", channel: event.channel, timestamp };
  }

  if (event.type === "visitor") {
    // Common use-case: doorbells/visitor notifications.
    return { type: "doorbell", channel: event.channel, timestamp };
  }

  if (event.type === "daynight") {
    return { type: "daynight", channel: event.channel, timestamp };
  }

  if (event.type === "ai") {
    const ai = event.ai;
    const aiType = ai?.type;

    const map: Record<NonNullable<AIEvent["type"]>, ReolinkSimpleEventType> = {
      people: "people",
      vehicle: "vehicle",
      dog_cat: "animal",
      face: "face",
      package: "package",
      other: "other",
    };

    return {
      type: aiType ? map[aiType] : "other",
      channel: event.channel,
      timestamp,
    };
  }

  return null;
}

function buildTalkConfigPayloadXml(config: TalkConfig): string {
  const audio = config.audioConfig;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<TalkConfig version="1.1">
<channelId>${config.channel}</channelId>
<duplex>${xmlEscape(config.duplex)}</duplex>
<audioStreamMode>${xmlEscape(config.audioStreamMode)}</audioStreamMode>
<audioConfig>
<audioType>${xmlEscape(audio.audioType)}</audioType>
<sampleRate>${audio.sampleRate}</sampleRate>
<samplePrecision>${audio.samplePrecision}</samplePrecision>
<lengthPerEncoder>${audio.lengthPerEncoder}</lengthPerEncoder>
<soundTrack>${xmlEscape(audio.soundTrack)}</soundTrack>
</audioConfig>
</TalkConfig>
</body>`;
}

function encodeBcMediaAdpcmBlock(block: Buffer, halfBlockSize: number): Buffer {
  // Matches parseAdpcm in src/baichuan/stream/BcMediaParser.ts
  // magic(4) + payload_size(u16) + payload_size_b(u16) + magic_data(u16=0x0100) + half_block_size(u16) + data + padding
  const magic = 0x62773130; // "bw10"
  const subHeaderSize = 4;
  const payloadSize = subHeaderSize + block.length;
  const headerLen = 12;
  const padSize = payloadSize % 8 === 0 ? 0 : 8 - (payloadSize % 8);
  const totalLen = headerLen + block.length + padSize;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32LE(magic, 0);
  buf.writeUInt16LE(payloadSize, 4);
  buf.writeUInt16LE(payloadSize, 6);
  buf.writeUInt16LE(0x0100, 8);
  buf.writeUInt16LE(halfBlockSize, 10);
  block.copy(buf, 12);

  return buf;
}

export class ReolinkBaichuanApi {
  readonly client: BaichuanClient;
  readonly logger: Logger;
  private readonly httpClient: ReolinkHttpClient;
  private readonly simpleEventListeners = new Set<(event: ReolinkSimpleEvent) => void>();
  private simpleEventSubscribed = false;
  private simpleEventSubscribeInFlight: Promise<void> | undefined;
  private simpleEventUnsubscribeInFlight: Promise<void> | undefined;
  private statePollingInterval: NodeJS.Timeout | undefined;
  private lastMotionState: boolean | undefined;
  private lastAiState: AIState | undefined;
  private rtspServers = new Set<BaichuanRtspServer>(); // Track all RTSP servers for cleanup
  private readonly activeVideoMsgNums = new Map<string, number>();

  private lastSleepProbe:
    | {
        atMs: number;
        status: SleepStatus;
      }
    | undefined;

  constructor(opts: BaichuanClientOptions) {
    this.logger = opts.logger ?? console;
    this.client = new BaichuanClient(opts);
    this.httpClient = new ReolinkHttpClient({
      host: opts.host,
      username: opts.username,
      password: opts.password,
      timeoutMs: 600_000,
    });

    // Dispatch parsed events in a minimal, stable shape.
    this.client.on("event", (event) => {
      const mapped = mapToSimpleEvent(event);
      if (!mapped) return;

      for (const cb of this.simpleEventListeners) {
        try {
          cb(mapped);
        }
        catch (e) {
          // Never allow user handlers to break the Baichuan client's event loop.
          (this.logger.warn ?? this.logger.error).call(this.logger, "[ReolinkBaichuanApi] onSimpleEvent handler error", e);
        }
      }
    });
  }

  /**
   * Subscribe to minimal high-level events.
   * The API manages Baichuan subscribe/unsubscribe automatically.
   */
  async onSimpleEvent(callback: (event: ReolinkSimpleEvent) => void): Promise<void> {
    this.simpleEventListeners.add(callback);
    await this.ensureSimpleEventSubscribed();
  }

  /**
   * Remove one callback, or all callbacks if omitted.
   * When the last listener is removed, the API unsubscribes from Baichuan events.
   */
  async offSimpleEvent(callback?: (event: ReolinkSimpleEvent) => void): Promise<void> {
    if (callback) {
      this.simpleEventListeners.delete(callback);
    }
    else {
      this.simpleEventListeners.clear();
    }

    if (this.simpleEventListeners.size === 0) {
      await this.ensureSimpleEventUnsubscribed();
    } else {
      // If there are still listeners, keep polling running (TCP only)
      const isUdp = this.client.getTransport?.() === "udp";
      if (!isUdp) {
        this.startStatePolling();
      }
    }
  }

  private async ensureSimpleEventSubscribed(): Promise<void> {
    if (this.simpleEventListeners.size === 0) return;
    if (this.simpleEventSubscribed) return;
    if (this.simpleEventSubscribeInFlight) return await this.simpleEventSubscribeInFlight;

    this.simpleEventSubscribeInFlight = (async () => {
      await this.subscribeEvents();
      this.simpleEventSubscribed = true;
      
      // Only check current state and start polling for TCP connections (not UDP/battery cameras)
      // UDP/battery cameras should rely on event pushes only, not polling
      const isUdp = this.client.getTransport?.() === "udp";
      if (!isUdp) {
        // Check current state and dispatch events immediately (TCP only)
        await this.checkAndDispatchCurrentState();
        
        // Start periodic polling if not already running (TCP only)
        this.startStatePolling();
      }
    })().finally(() => {
      this.simpleEventSubscribeInFlight = undefined;
    });

    return await this.simpleEventSubscribeInFlight;
  }

  private async ensureSimpleEventUnsubscribed(): Promise<void> {
    if (!this.simpleEventSubscribed && !this.client.subscribed) return;
    if (this.simpleEventUnsubscribeInFlight) return await this.simpleEventUnsubscribeInFlight;

    if (this.simpleEventSubscribeInFlight) {
      try {
        await this.simpleEventSubscribeInFlight;
      }
      catch {
        // ignore
      }
    }

    this.simpleEventUnsubscribeInFlight = (async () => {
      await this.unsubscribeEvents();
      this.simpleEventSubscribed = false;

      // Stop polling when no more listeners
      this.stopStatePolling();
    })().finally(() => {
      this.simpleEventUnsubscribeInFlight = undefined;
    });

    return await this.simpleEventUnsubscribeInFlight;
  }

  private normalizeChannel(channel?: number | null): number {
    return channel == null ? 0 : channel;
  }

  async login(maxEncryption?: import("../../client/BaichuanClient.js").MaxEncryption): Promise<void> {
    await this.client.login(maxEncryption);
  }

  async close(): Promise<void> {
    // Stop state polling before closing
    this.stopStatePolling();
    // Stop all RTSP servers before closing the client
    await this.cleanup();
    await this.client.close();
  }

  /**
   * Cleanup all RTSP servers and release resources.
   * This should be called when the API instance is being destroyed to prevent memory leaks.
   */
  async cleanup(): Promise<void> {
    const servers = Array.from(this.rtspServers);
    this.rtspServers.clear();

    // Stop all servers in parallel
    await Promise.allSettled(
      servers.map(async (server) => {
        try {
          await server.stop();
        } catch (error) {
          this.logger.error(`[ReolinkBaichuanApi] Error stopping RTSP server during cleanup:`, error);
        }
      })
    );

    if (servers.length > 0) {
      this.logger.info(`[ReolinkBaichuanApi] Cleaned up ${servers.length} RTSP server(s)`);
    }
  }

  /** Generic Baichuan cmd_id call, returns XML (if any). */
  async sendXml(params: Parameters<BaichuanClient["sendXml"]>[0], retry = 3): Promise<string> {
    // Only call login() if not already logged in (avoid recursion if called from login itself)
    if (!this.client.loggedIn) {
      await this.client.login();
    }
    try {
      // Use sendFrame to check responseCode and handle 400 errors with retry
      const frame = await this.client.sendFrame(params);

      // Retry logic for 400 errors.
      // NOTE: several firmwares return responseCode=400 with empty body when the camera is sleeping,
      // waking up, or when the session has expired (not only for bad credentials).
      if (frame.header.responseCode === 400) {
        if (retry > 0) {
          // If the body is empty, try forcing a re-login once before backing off.
          // This helps for expired sessions while staying safe for sleeping cameras.
          if (frame.body.length === 0) {
            try {
              this.client.loggedIn = false;
              await this.client.login();
            } catch {
              // ignore; we will still back off and retry
            }
          }

          const delayMs = 1500;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return await this.sendXml(params, retry - 1);
        }

        // Out of retries.
        if (frame.body.length === 0) {
          throw new Error(
            'Baichuan request failed (responseCode 400, empty body). Possible causes: camera sleeping/waking (battery), expired session, or invalid username/password.',
          );
        }
      }

      // Decrypt and return XML
      if (frame.body.length === 0) return "";
      const xml = (this.client as any).tryDecryptXml(frame.body, frame.header.channelId, this.client.enc);
      return xml;
    } catch (error) {
      // If it's already an Error from sendFrame (timeout, etc.), just throw it
      throw error;
    }
  }

  /**
   * Fetch TalkAbility (cmd_id=10) which describes supported two-way audio formats.
   * Based on neolink MSG_ID_TALKABILITY.
   */
  async getTalkAbility(channel?: number): Promise<TalkAbility> {
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_TALK_ABILITY, ...(channel !== undefined ? { channel } : {}) });
    return parseTalkAbilityXml(xml);
  }

  /**
   * Create a talk (two-way audio) session.
   *
   * Input audio format expected by the camera is ADPCM (DVI4/IMA style) in blocks described
   * by TalkAbility.audioConfigList (typically 16kHz mono, lengthPerEncoder=1024).
   */
  async createTalkSession(channel = 0, options?: { blocksPerPayload?: number }): Promise<TalkSession> {
    if (!this.client.loggedIn) await this.client.login();

    const ability = await this.getTalkAbility(channel);
    const audioConfig = ability.audioConfigList.find((c) => c.audioType.toLowerCase() === "adpcm") ?? ability.audioConfigList[0];
    if (!audioConfig) {
      throw new Error(`Talk not supported on channel ${channel} (no audioConfig in TalkAbility)`);
    }

    const duplex = ability.duplexList[0] ?? "FDX";
    const audioStreamMode = ability.audioStreamModeList[0] ?? "followVideoStream";

    const talkConfig: TalkConfig = {
      channel,
      duplex,
      audioStreamMode,
      audioConfig,
    };

    const blockSize = Math.floor(audioConfig.lengthPerEncoder / 2);
    const fullBlockSize = blockSize + 4;
    if (blockSize <= 0 || fullBlockSize <= 4) {
      throw new Error(`Invalid talk audio config: lengthPerEncoder=${audioConfig.lengthPerEncoder}`);
    }

    // Send TalkConfig (201) and handle 422 by issuing TalkReset (11) then retry.
    const payloadXml = buildTalkConfigPayloadXml(talkConfig);
    const sendTalkConfig = async (): Promise<void> => {
      const frame = await this.client.sendFrame({
        cmdId: BC_CMD_ID_TALK_CONFIG,
        channel,
        payloadXml,
        messageClass: BC_CLASS_MODERN_24,
      });

      if (frame.header.responseCode === 422) {
        await this.client.sendFrame({
          cmdId: BC_CMD_ID_TALK_RESET,
          channel,
          // TalkReset has no payload; extension is enough.
          payloadXml: "",
          messageClass: BC_CLASS_MODERN_24,
        });
        const retryFrame = await this.client.sendFrame({
          cmdId: BC_CMD_ID_TALK_CONFIG,
          channel,
          payloadXml,
          messageClass: BC_CLASS_MODERN_24,
        });
        if (retryFrame.header.responseCode !== 200) {
          throw new Error(`TalkConfig rejected after reset (responseCode ${retryFrame.header.responseCode})`);
        }
        return;
      }

      if (frame.header.responseCode !== 200) {
        throw new Error(`TalkConfig rejected (responseCode ${frame.header.responseCode})`);
      }
    };

    await sendTalkConfig();

    const info: TalkSessionInfo = {
      channel,
      audioConfig,
      blockSize,
      fullBlockSize,
    };

    // Session implementation
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let closed = false;
    let pumping = false;
    let expectedStreamEndMs = Date.now();

    // Neolink uses 4 blocks per payload. Lower values reduce end-to-end latency
    // (smaller bursts, earlier first audio) at the cost of more packets.
    const BLOCKS_PER_PAYLOAD = Math.max(1, Math.min(8, Math.floor(options?.blocksPerPayload ?? 1)));

    const sendBlocks = async (blocks: Array<Buffer<ArrayBufferLike>>): Promise<void> => {
      if (blocks.length === 0) return;
      if (blocks.length > BLOCKS_PER_PAYLOAD) {
        throw new Error(`Internal error: too many blocks in payload (${blocks.length})`);
      }

      const parts: Buffer[] = [];
      let samplesSent = 0;
      for (const block of blocks) {
        parts.push(encodeBcMediaAdpcmBlock(block, blockSize));
        // 2 samples per encoded byte + 1 predictor sample in 4-byte header
        samplesSent += Math.max(0, (block.length - 4) * 2 + 1);
      }

      await this.client.sendBinaryPayloadNoReply({
        cmdId: BC_CMD_ID_TALK,
        channel,
        extensionXml: buildBinaryExtensionXml(channel),
        payload: Buffer.concat(parts),
        messageClass: BC_CLASS_MODERN_24,
      });

      const playLengthMs = (samplesSent / audioConfig.sampleRate) * 1000;

      const now = Date.now();
      if (now > expectedStreamEndMs) expectedStreamEndMs = now + playLengthMs;
      else expectedStreamEndMs += playLengthMs;

      const sleepFor = expectedStreamEndMs - Date.now();
      if (sleepFor > 0) await sleepMs(sleepFor);
    };

    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        while (true) {
          if (buffer.length >= fullBlockSize) {
            const blocks: Array<Buffer<ArrayBufferLike>> = [];
            while (blocks.length < BLOCKS_PER_PAYLOAD && buffer.length >= fullBlockSize) {
              blocks.push(buffer.subarray(0, fullBlockSize) as Buffer<ArrayBufferLike>);
              buffer = buffer.subarray(fullBlockSize) as Buffer<ArrayBufferLike>;
            }
            await sendBlocks(blocks);
            continue;
          }

          if (closed) {
            // pad last partial block to avoid dropping tail
            if (buffer.length > 0) {
              const padded = Buffer.alloc(fullBlockSize, 0xff) as Buffer<ArrayBufferLike>;
              buffer.copy(padded, 0);
              buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
              await sendBlocks([padded]);
            }
            break;
          }

          // Not enough data for a full block yet; exit and wait for more.
          break;
        }
      } finally {
        pumping = false;
      }
    };

    const stop = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await pump();

      // Wait a tiny bit after the expected end, like neolink does, to avoid cutting off playback.
      const remaining = expectedStreamEndMs - Date.now();
      if (remaining > 0) await sleepMs(remaining + 100);
      else await sleepMs(100);

      const frame = await this.client.sendFrame({
        cmdId: BC_CMD_ID_TALK_RESET,
        channel,
        payloadXml: "",
        messageClass: BC_CLASS_MODERN_24,
      });
      if (frame.header.responseCode !== 200) {
        throw new Error(`TalkReset rejected (responseCode ${frame.header.responseCode})`);
      }
    };

    const session: TalkSession = {
      info,
      sendAudio: async (adpcm: Buffer<ArrayBufferLike>) => {
        if (closed) throw new Error("Talk session is closed");
        if (adpcm.length === 0) return;
        buffer = buffer.length === 0 ? adpcm : (Buffer.concat([buffer, adpcm]) as Buffer<ArrayBufferLike>);
        await pump();
      },
      stop,
    };

    return session;
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
  async getNetPort(): Promise<ReolinkBaichuanPorts> {
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

  /** Back-compat alias for older API name used by tests/consumers. */
  async getPorts(): Promise<ReolinkBaichuanPorts> {
    return this.getNetPort();
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
  async getEncXml(channel?: number, options?: { timeoutMs?: number }): Promise<string> {
    const ch = this.normalizeChannel(channel);
    return await this.sendXml({ cmdId: 56, channel: ch, ...(options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}) });
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
  async getStreamMetadata(channel?: number): Promise<ChannelStreamMetadata> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.getEncXml(ch);
    const streams: StreamMetadata[] = [];
    let audioEnabled = true;

    // Some firmwares include placeholder stream sections (not actually supported)
    // with 0x0 resolution and/or 0 FPS/bitrate. Treat those as unavailable.
    const isPlausibleStream = (s: { width: number; height: number; frameRate: number; bitRate: number }): boolean => {
      return s.width > 0 && s.height > 0 && (s.frameRate > 0 || s.bitRate > 0);
    };

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

      if (isEnabled && isPlausibleStream({ width, height, frameRate, bitRate })) {
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

      if (isEnabled && isPlausibleStream({ width, height, frameRate, bitRate })) {
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

    // Parse ext-like stream (if available).
    // Some firmwares use <thirdStream> (or other variants) instead of <extStream>.
    // We treat these as an alias for the public "ext" profile.
    const extLikeTags = ["extStream", "thirdStream", "externStream", "extraStream"];
    for (const tag of extLikeTags) {
      const extMatch = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      if (!extMatch) continue;

      const extXml = extMatch[1] ?? "";
      const width = Number(getXmlText(extXml, "width") ?? "0");
      const height = Number(getXmlText(extXml, "height") ?? "0");
      const videoEncTypeInt = Number(getXmlText(extXml, "videoEncType") ?? "0");
      const frameRate = Number(getXmlText(extXml, "frame") ?? "0");
      const bitRate = Number(getXmlText(extXml, "bitRate") ?? "0");
      const audio = Number(getXmlText(extXml, "audio") ?? "0");
      const enabled = getXmlText(extXml, "enable");
      const isEnabled = enabled === undefined || enabled === "1" || enabled === "true";

      if (isEnabled && isPlausibleStream({ width, height, frameRate, bitRate })) {
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

      // Only one ext-like stream is expected; stop after the first match.
      break;
    }

    return {
      channel: ch,
      streams,
      audioEnabled,
    };
  }

  /** SetEnc via Baichuan: cmd_id 57 (sends raw XML). */
  async setEncXml(encXml: string): Promise<void>;
  async setEncXml(channel: number, encXml: string): Promise<void>;
  async setEncXml(channelOrEncXml: number | string, encXmlMaybe?: string): Promise<void> {
    const ch = typeof channelOrEncXml === "number" ? this.normalizeChannel(channelOrEncXml) : 0;
    const encXml = typeof channelOrEncXml === "number" ? encXmlMaybe! : channelOrEncXml;
    await this.sendXml({ cmdId: 57, channel: ch, payloadXml: encXml });
  }

  /**
   * Update the encoder codec for a given stream profile (main/sub/ext).
   *
   * NOTE: This changes the camera configuration.
   * Many models may require a short delay (or stream restart) before the new codec is used.
   */
  async setStreamVideoCodec(profile: StreamProfile, codec: "H.264" | "H.265", channel?: number): Promise<void>;
  async setStreamVideoCodec(channel: number, profile: StreamProfile, codec: "H.264" | "H.265"): Promise<void>;
  async setStreamVideoCodec(
    channelOrProfile: number | StreamProfile,
    profileOrCodec: StreamProfile | ("H.264" | "H.265"),
    codecOrChannel?: ("H.264" | "H.265") | number
  ): Promise<void> {
    const ch = typeof channelOrProfile === "number" ? this.normalizeChannel(channelOrProfile) : this.normalizeChannel(codecOrChannel as number | undefined);
    const profile = typeof channelOrProfile === "number" ? (profileOrCodec as StreamProfile) : channelOrProfile;
    const codec = typeof channelOrProfile === "number" ? (codecOrChannel as "H.264" | "H.265") : (profileOrCodec as "H.264" | "H.265");
    const desired = codec === "H.265" ? 1 : 0;

    const candidateTags =
      profile === "main"
        ? ["mainStream"]
        : profile === "sub"
          ? ["subStream"]
          : ["extStream", "thirdStream", "externStream", "extraStream"];

    const current = await this.getEncXml(ch);

    let updated: string | null = null;
    for (const tag of candidateTags) {
      const sectionRe = new RegExp(`(<${tag}[^>]*>[\\s\\S]*?<videoEncType>)(\\d+)(</videoEncType>)`);
      if (!sectionRe.test(current)) continue;
      const next = current.replace(sectionRe, `$1${desired}$3`);
      if (next !== current) {
        updated = next;
        break;
      }
    }

    if (!updated) {
      throw new Error(
        `Could not find <videoEncType> for profile=${profile} (tags=${candidateTags.join(",")}) in GetEnc XML (channel=${ch}).`,
      );
    }

    await this.setEncXml(ch, updated);
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
  async setGeneralXml(xml: string): Promise<void>;
  async setGeneralXml(channel: number | undefined, xml: string): Promise<void>;
  async setGeneralXml(channelOrXml: number | string | undefined, xmlMaybe?: string): Promise<void> {
    const channel = typeof channelOrXml === "number" || channelOrXml === undefined ? channelOrXml : undefined;
    const xml = typeof channelOrXml === "string" ? channelOrXml : xmlMaybe!;
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
  async getOsd(channel?: number): Promise<OsdConfig> {
    const ch = this.normalizeChannel(channel);
    const cmdId = 26; // From reolink-aio GetImage (includes OSD)
    const xml = await this.sendXml({ cmdId, channel: ch });
    // Parse OSD XML structure from VideoInput/OsdChannel and OsdTime
    // This is a placeholder - actual parsing depends on XML structure
    return {
      channel: ch,
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
  async setOsd(osd: OsdConfig, channel?: number): Promise<void>;
  async setOsd(channel: number, osd: OsdConfig): Promise<void>;
  async setOsd(channelOrOsd: number | OsdConfig, osdMaybe?: OsdConfig | number): Promise<void> {
    const ch = typeof channelOrOsd === "number" ? this.normalizeChannel(channelOrOsd) : this.normalizeChannel(osdMaybe as number | undefined);
    const osd = typeof channelOrOsd === "number" ? (osdMaybe as OsdConfig) : channelOrOsd;
    const cmdId = 25; // From reolink-aio SetImage (includes OSD)
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<Osd version="1.1">` +
      `<channel>${ch}</channel>` +
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
    await this.sendXml({ cmdId, channel: ch, payloadXml: xml });
  }

  /**
   * GetAiState via Baichuan.
   * cmd_id: 342 (from reolink-aio GetAiAlarm)
   * Note: GetAiAlarm requires ai_type parameter, this is a simplified wrapper
   */
  async getAiState(channel?: number): Promise<AIState> {
    const cmdId = 342; // From reolink-aio GetAiAlarm
    // NOTE: Many firmwares require an explicit aiType for cmd 342.
    // The correct payload (per reolink_aio + neolink dissector) is <AiDetectCfg><chn/><type/>.
    // This legacy helper keeps behavior best-effort and may return empty state on firmwares
    // that reject cmd 342 without a type.
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
  async getSnapshot(channel: number = 0): Promise<Buffer> {
    const cmdId = 109;

    // 1. Send Snap request (XML)
    // Neolink: <Snap version="1.1"><channelId>...</channelId><logicChannel>...</logicChannel><time>0</time><fullFrame>0</fullFrame><streamType>main</streamType></Snap>
    // Must be wrapped in <body>
    const xml = `<body><Snap version="1.1"><channelId>${channel}</channelId><logicChannel>${channel}</logicChannel><time>0</time><fullFrame>0</fullFrame><streamType>main</streamType></Snap></body>`;

    await this.client.login();

    // IMPORTANT (neolink-compatible): the Snap request Extension must NOT include <binaryData>1</binaryData>.
    // The binary chunks in response will have <binaryData>1</binaryData> in their Extension.
    // Delegate to the client binary handler. cmdId=109 (snapshot) is special and is delivered via push frames
    // on many firmwares; BaichuanClient.sendBinary handles that.
    return await this.client.sendBinary({
      cmdId,
      channel,
      payloadXml: xml,
      extensionXml: buildChannelExtensionXml(channel),
      timeoutMs: 15_000,
    });
  }

  /**
   * List camera recordings via Baichuan FileInfoList (neolink-style).
   *
   * Flow (based on reolink_aio XML templates + neolink dissector msg IDs):
   * - cmdId=14: open search -> returns <handle>
   * - cmdId=15: get page(s) -> returns file list and optional <bFinished>
   * - cmdId=16: close handle
   */
  async listRecordings(params: ListRecordingsParams): Promise<RecordingFile[]> {
    await this.client.login();

    const channel = this.normalizeChannel(params.channel);
    const uid = params.uid;
    const streamType = params.streamType ?? "mainStream";
    const recordType =
      params.recordType ?? "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package";
    const maxIterations = params.maxIterations ?? 50;
    const fallbackToAlarmVideo = params.fallbackToAlarmVideo ?? true;

    const openXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<uid>${xmlEscape(uid)}</uid>
<searchAITrack>1</searchAITrack>
<channelId>${channel}</channelId>
<logicChnBitmap>255</logicChnBitmap>
<streamType>${xmlEscape(streamType)}</streamType>
<recordType>${xmlEscape(recordType)}</recordType>
${xmlDateTimePayload("startTime", params.start)}
${xmlDateTimePayload("endTime", params.end)}
</FileInfo>
</FileInfoList>
</body>`;

    const openResp = await this.sendXml({ cmdId: BC_CMD_ID_FILE_INFO_LIST_OPEN, channel, payloadXml: openXml });
    const handleText = getXmlText(openResp, "handle");
    if (!handleText) {
      throw new Error("FileInfoList open did not return <handle>");
    }

    const handle = Number.parseInt(handleText, 10);
    if (!Number.isFinite(handle)) {
      throw new Error(`FileInfoList open returned invalid handle: ${handleText}`);
    }

    const pageXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${channel}</channelId>
<uid>${xmlEscape(uid)}</uid>
<searchAITrack>1</searchAITrack>
<handle>${handle}</handle>
</FileInfo>
</FileInfoList>
</body>`;

    const files: RecordingFile[] = [];
    try {
      let finished = false;
      for (let i = 0; i < maxIterations && !finished; i++) {
        const resp = await this.sendXml({ cmdId: BC_CMD_ID_FILE_INFO_LIST_GET, channel, payloadXml: pageXml });
        files.push(...parseRecordingFilesFromXml(resp));
        const bFinishedText = getXmlText(resp, "bFinished") ?? getXmlText(resp, "finished");
        if (bFinishedText != null) {
          finished = bFinishedText.trim() === "1";
        } else {
          // If firmware doesn't provide a finished flag, assume one-page response.
          finished = true;
        }
      }
    } finally {
      // Best-effort close.
      try {
        await this.sendXml({ cmdId: BC_CMD_ID_FILE_INFO_LIST_CLOSE, channel, payloadXml: pageXml });
      } catch {
        // ignore
      }
    }

    // De-dup (pagination can repeat).
    const seen = new Set<string>();
    const unique = files.filter((f) => {
      if (seen.has(f.fileName)) return false;
      seen.add(f.fileName);
      return true;
    });

    if (unique.length > 0 || !fallbackToAlarmVideo) return unique;

    // Fallback path: <findAlarmVideo> (reolink_aio: cmdId 272/273/274).
    // This often returns "alarm videos" when FileInfoList is unsupported/empty.
    const uidBase = uid.split("_")[0] ?? uid;
    const streamTypeInt = streamType === "subStream" ? 1 : 0;
    const alarmType = "md, pir, io, people, face, vehicle, dog_cat, visitor, other, package, cry, crossline, intrusion, loitering, legacy, loss";

    const findOpenXml = (start: Date, end: Date) => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
<channelId>${channel}</channelId>
<uid>${xmlEscape(uidBase)}</uid>
<logicChnBitmap>255</logicChnBitmap>
<streamType>${streamTypeInt}</streamType>
<notSearchVideo>0</notSearchVideo>
${xmlDateTimePayload("startTime", start)}
${xmlDateTimePayload("endTime", end)}
<alarmType>${alarmType}</alarmType>
</findAlarmVideo>
</body>`;

    const findGetXml = (fileHandle: string) => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findAlarmVideo version="1.1">
<channelId>${channel}</channelId>
<fileHandle>${xmlEscape(fileHandle)}</fileHandle>
</findAlarmVideo>
</body>`;

    const alarmFiles: RecordingFile[] = [];
    let currentStart = params.start;
    for (let i = 0; i < maxIterations; i++) {
      const openResp = await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_OPEN, channel, payloadXml: findOpenXml(currentStart, params.end) });
      const fileHandle = getXmlText(openResp, "fileHandle")?.trim();
      if (!fileHandle) break;

      const getXml = findGetXml(fileHandle);
      try {
        const getResp = await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_GET, channel, payloadXml: getXml });
        const pageFiles = parseRecordingFilesFromXml(getResp);
        alarmFiles.push(...pageFiles);

        const bFinishedText = getXmlText(getResp, "bFinished")?.trim();
        const finished = bFinishedText === "1";
        if (finished) break;

        // If not finished, advance start to the last returned event startTime if possible.
        const lastWithStart = [...pageFiles].reverse().find((f) => f.startTime != null);
        if (!lastWithStart?.startTime) break;
        currentStart = lastWithStart.startTime;
      } finally {
        // Best-effort close.
        try {
          await this.sendXml({ cmdId: BC_CMD_ID_FIND_REC_VIDEO_CLOSE, channel, payloadXml: getXml });
        } catch {
          // ignore
        }
      }
    }

    const seenAlarm = new Set<string>();
    return alarmFiles.filter((f) => {
      if (seenAlarm.has(f.fileName)) return false;
      seenAlarm.add(f.fileName);
      return true;
    });
  }

  /**
    * Convenience wrapper around listRecordings() that returns only the recording identifiers.
   *
   * Most firmwares return a usable download identifier as a path-like string, e.g.
   * `/mnt/sda/Mp4Record/YYYY-MM-DD/Rec....mp4`.
   */
  async listRecordingFileNames(params: ListRecordingsParams): Promise<string[]> {
    const recs = await this.listRecordings(params);
    return recs.map((r) => r.fileName);
  }

  /**
   * Download a recording via Baichuan FileInfoList download (cmdId=13, class=0x6482).
   * Returns raw bytes (often an mp4/flv/ps payload depending on firmware/camera).
   */
  async downloadRecording(params: DownloadRecordingParams): Promise<Buffer> {
    await this.client.login();

    const channel = this.normalizeChannel(params.channel);
    const uid = params.uid;
    const fileName = params.fileName;

    const name = fileName.includes("/") ? fileName.split("/").filter(Boolean).at(-1) ?? fileName : fileName;

    const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${channel}</channelId>
<uid>${xmlEscape(uid)}</uid>
<fileName>${xmlEscape(fileName)}</fileName>
<name>${xmlEscape(name)}</name>
<Id>${xmlEscape(fileName)}</Id>
</FileInfo>
</FileInfoList>
</body>`;

    const fallbackToHttp = params.fallbackToHttp ?? false;

    try {
      return await this.client.sendBinary({
        cmdId: BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD,
        channel,
        messageClass: BC_CLASS_FILE_DOWNLOAD,
        extensionXml: buildBinaryExtensionXml(channel),
        payloadXml,
        timeoutMs: params.timeoutMs ?? 120_000,
      });
    } catch (e) {
      if (!fallbackToHttp) throw e;

      // Fallback: HTTP CGI Download (reolink_aio approach).
      // Many firmwares expose recordings for download via /cgi-bin/api.cgi?cmd=Download&source=...
      const wantedFilename = fileName.replaceAll("/", "_").replaceAll("\\", "_");
      try {
        // reolink_aio: if filename matches Rec* pattern, include `start=YYYYMMDDHHMMSS`
        // to help the firmware locate the clip.
        const m = /Rec(\w{3})(?:_|_DST)(\d{8})_(\d{6})_.*/.exec(fileName);
        const startParam = m ? `${m[2]}${m[3]}` : undefined;

        const candidates: string[] = [];
        const pushUnique = (s: string | undefined) => {
          const v = s?.trim();
          if (!v) return;
          if (!candidates.includes(v)) candidates.push(v);
        };

        pushUnique(fileName);
        // Common FileInfoList Ids look like /mnt/sda/Mp4Record/YYYY-MM-DD/Rec....mp4
        pushUnique(fileName.replace(/^\/mnt\/[a-zA-Z0-9]+\//, ""));
        pushUnique(fileName.replace(/^\//, ""));

        let lastErr: unknown;
        for (const source of candidates) {
          try {
            return await this.httpClient.downloadVod(source, wantedFilename, startParam);
          } catch (ee) {
            lastErr = ee;
            const msg = ee instanceof Error ? ee.message : String(ee);
            // Try next path variant on 404.
            if (msg.startsWith("HTTP 404")) continue;
            throw ee;
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      } catch (e2) {
        const err1 = e instanceof Error ? e.message : String(e);
        const err2 = e2 instanceof Error ? e2.message : String(e2);
        throw new Error(`downloadRecording failed (baichuan then http). baichuanErr=${err1}; httpErr=${err2}`);
      }
    }
  }

  /**
   * Subscribe to events (motion/AI/visitor) via Baichuan.
   * cmd_id: 31 (from reolink-aio subscribe_events)
   * After subscribing, events will be emitted via client.on("event", ...)
   */
  async subscribeEvents(): Promise<void> {
    await this.client.login();
    // NOTE: Some battery firmwares reject the old "channelId=251 Extension" approach with responseCode=421.
    // Neolink sends MSG_ID 31 with *empty* body and channel_id set to the camera channel.
    const channel = this.client.getConfiguredChannel?.() ?? 0;
    // IMPORTANT: In neolink, BcCameraOpt.channel_id is 0 for standalone cameras (no +1 offset).
    // Our library defaults to reolink_aio-style (channel+1) for most requests, so we try
    // the exact neolink mapping first and keep +1 as a compatibility fallback.
    const neolinkChannelId = channel;
    const reolinkAioChannelId = channel + 1;

    const attempts: Array<{ label: string; params: Parameters<BaichuanClient["sendFrame"]>[0] }> = [
      {
        label: `neolink-style channelId=${neolinkChannelId} bodyLen=0`,
        params: { cmdId: 31, channelIdOverride: neolinkChannelId, messageClass: BC_CLASS_MODERN_24 },
      },
      {
        label: `reolink_aio-style channelId=${reolinkAioChannelId} bodyLen=0`,
        params: { cmdId: 31, channelIdOverride: reolinkAioChannelId, messageClass: BC_CLASS_MODERN_24 },
      },
      {
        label: "host channelId=250 bodyLen=0",
        params: { cmdId: 31, channelIdOverride: 250, messageClass: BC_CLASS_MODERN_24 },
      },
      {
        label: "legacy Extension channelId=251",
        params: {
          cmdId: 31,
          channelIdOverride: 250,
          messageClass: BC_CLASS_MODERN_24,
          extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>251</channelId></Extension>`,
        },
      },
    ];

    let lastCode: number | undefined;
    for (const a of attempts) {
      const frame = await this.client.sendFrame({ ...a.params, timeoutMs: 10_000 });
      lastCode = frame.header.responseCode;
      if (frame.header.responseCode === 200) {
        this.client.subscribed = true;
        this.client.refreshKeepAlive?.();
        return;
      }
      // Keep trying other variants.
      (this.logger.debug ?? this.logger.log).call(this.logger, `[ReolinkBaichuanApi] subscribeEvents rejected (${a.label}) responseCode=${frame.header.responseCode}`);
    }

    this.client.subscribed = false;
    this.client.refreshKeepAlive?.();
    throw new Error(`subscribeEvents failed: camera rejected cmdId=31 (last responseCode=${lastCode ?? "unknown"})`);
  }

  /**
   * Unsubscribe from events.
   */
  async unsubscribeEvents(): Promise<void> {
    // Note: reolink-aio doesn't have explicit unsubscribe, but closing connection unsubscribes
    // For now, we just mark as unsubscribed
    this.client.subscribed = false;
    // For BCUDP/battery cameras: allow the camera to sleep when idle.
    this.client.refreshKeepAlive?.();
  }

  /**
   * Check current motion and AI state and dispatch events if state changed.
   * This is called immediately after subscription and periodically during polling.
   */
  private async checkAndDispatchCurrentState(channel: number = 0): Promise<void> {
    try {
      // Check motion state
      const motionState = await this.getMotionState(channel);
      if (motionState !== this.lastMotionState) {
        this.lastMotionState = motionState;
        if (motionState) {
          // Dispatch motion event
          const event: ReolinkSimpleEvent = {
            type: "motion",
            channel,
            timestamp: Date.now(),
          };
          this.dispatchSimpleEvent(event);
        }
      }

      // Check AI state (if supported)
      try {
        const aiState = await this.getAiState(channel);
        if (aiState && aiState.alarm_state !== undefined) {
          // Check if AI state changed
          const aiStateChanged = !this.lastAiState ||
            this.lastAiState.alarm_state !== aiState.alarm_state ||
            this.lastAiState.support !== aiState.support;

          if (aiStateChanged) {
            this.lastAiState = aiState;

            // If alarm_state indicates detection, dispatch appropriate AI event
            // alarm_state: 0 = no detection, 1 = detection active
            if (aiState.alarm_state === 1) {
              // Try to determine AI type from state
              // For now, dispatch "other" if we can't determine the specific type
              // The actual AI type should come from the event stream, but we dispatch a generic event here
              const event: ReolinkSimpleEvent = {
                type: "other", // Generic AI detection
                channel,
                timestamp: Date.now(),
              };
              this.dispatchSimpleEvent(event);
            }
          }
        }
      } catch (e) {
        // AI state check may fail on cameras without AI support - ignore
        // Only log if it's not a common "not supported" error
        if (e && typeof e === 'object' && 'message' in e) {
          const msg = String(e.message);
          if (!msg.includes('not supported') && !msg.includes('unsupported')) {
            (this.logger.debug ?? this.logger.log)?.call(this.logger, "[ReolinkBaichuanApi] getAiState failed (may not be supported)", e);
          }
        }
      }
    } catch (e) {
      // Log but don't throw - state checking should be best-effort
      (this.logger.warn ?? this.logger.error)?.call(this.logger, "[ReolinkBaichuanApi] Error checking current state", e);
    }
  }

  /**
   * Dispatch a simple event to all listeners.
   */
  private dispatchSimpleEvent(event: ReolinkSimpleEvent): void {
    for (const cb of this.simpleEventListeners) {
      try {
        cb(event);
      }
      catch (e) {
        // Never allow user handlers to break the event loop
        (this.logger.warn ?? this.logger.error)?.call(this.logger, "[ReolinkBaichuanApi] onSimpleEvent handler error", e);
      }
    }
  }

  /**
   * Start periodic polling of motion and AI state (every 5 seconds).
   * Only starts if there are listeners and polling is not already running.
   * Polling is disabled for UDP/battery cameras to avoid waking them unnecessarily.
   */
  private startStatePolling(): void {
    // Only poll if there are listeners
    if (this.simpleEventListeners.size === 0) {
      return;
    }

    // Don't poll for UDP/battery cameras - they should rely on event pushes only
    const isUdp = this.client.getTransport?.() === "udp";
    if (isUdp) {
      return;
    }

    // Don't start if already running
    if (this.statePollingInterval) {
      return;
    }

    // Poll every 5 seconds (TCP only)
    this.statePollingInterval = setInterval(async () => {
      // Only poll if there are still listeners
      if (this.simpleEventListeners.size === 0) {
        this.stopStatePolling();
        return;
      }

      // Check state for channel 0 (default)
      // TODO: Support multiple channels if needed
      await this.checkAndDispatchCurrentState(0);
    }, 5000);
  }

  /**
   * Stop periodic polling of motion and AI state.
   */
  private stopStatePolling(): void {
    if (this.statePollingInterval) {
      clearInterval(this.statePollingInterval);
      this.statePollingInterval = undefined;
    }
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
    const ch = this.normalizeChannel(channel);
    const now = Date.now();

    const out: Events = { channel: ch };

    // Neolink format: AlarmEventList
    if (xml.includes("<AlarmEventList")) {
      const alarmEventMatches = xml.matchAll(/<AlarmEvent\b[^>]*>([\s\S]*?)<\/AlarmEvent>/g);
      for (const match of alarmEventMatches) {
        const alarmXml = match[1] ?? "";
        const channelText = getXmlText(alarmXml, "channelId");
        const eventChannel = channelText !== undefined ? Number(channelText) : ch;
        if (eventChannel !== ch) continue;

        const statusUpper = ((getXmlText(alarmXml, "status") ?? "").trim()).toUpperCase();
        const aiTypeRaw = (getXmlText(alarmXml, "AItype") ?? getXmlText(alarmXml, "aiType") ?? getXmlText(alarmXml, "aitype") ?? "").trim();

        if (statusUpper.includes("MD")) {
          out.motion = { state: 1, timestamp: now, source: "md" };
        }
        if (statusUpper.includes("PIR")) {
          out.motion = { state: 1, timestamp: now, source: "pir" };
        }

        const aiTypeToken = aiTypeRaw
          ? aiTypeRaw
            .split(",")
            .map((t) => t.trim())
            .find((t) => t.length > 0 && t.toLowerCase() !== "none")
          : undefined;
        if (aiTypeToken || statusUpper.includes("AI")) {
          out.ai = {
            channel: ch,
            alarm_state: 1,
            type: aiTypeToken,
          };
        }

        if (statusUpper.includes("VIS")) {
          (out as any).visitor = { detected: true, timestamp: now };
        }
      }
      return out;
    }

    // Fallback: Event
    const statusUpper = ((getXmlText(xml, "status") ?? "").trim()).toUpperCase();
    const aiTypeRaw = (getXmlText(xml, "AItype") ?? getXmlText(xml, "aiType") ?? getXmlText(xml, "aitype") ?? "").trim();

    if (statusUpper.includes("MD")) out.motion = { state: 1, timestamp: now, source: "md" };
    if (statusUpper.includes("PIR")) out.motion = { state: 1, timestamp: now, source: "pir" };
    if (aiTypeRaw || statusUpper.includes("AI")) out.ai = { channel: ch, alarm_state: 1, type: aiTypeRaw || undefined };
    if (statusUpper.includes("VIS")) (out as any).visitor = { detected: true, timestamp: now };

    return out;
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
  async startVideoStream(channel?: number, profile: StreamProfile = "sub"): Promise<void> {
    const ch = this.normalizeChannel(channel);
    // Neolink uses the same 0-based channel_id everywhere (header, Extension, payload).
    const channelId = ch;

    // Map profile to handle and stream_type values (from neolink stream.rs)
    // handle: 0 for main, 256 for sub, 1024 for extern
    // stream_type in header: 0 for main, 1 for sub, 0 for extern
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number; streamName: string }> = {
      main: { handle: 0, streamType: 0, streamName: "mainStream" },
      sub: { handle: 256, streamType: 1, streamName: "subStream" },
      ext: { handle: 1024, streamType: 0, streamName: "externStream" },
    };

    const config = profileConfig[profile];
    if (!config) {
      throw new Error(`Invalid stream profile: ${profile}`);
    }
    if (!config.streamName) {
      throw new Error(`Stream name not found for profile: ${profile}, config: ${JSON.stringify(config)}`);
    }

    // Build Preview XML payload (from neolink stream.rs line 171-189)
    // BcXml serializes as <body>...</body> with Preview inside
    // IMPORTANT: channelId is NOT in Preview XML - it's handled via channelId in header
    // The working format (response_code 200) is Preview WITHOUT channelId
    const streamName = config.streamName;
    // Debug: verify streamName is defined
    if (typeof streamName !== "string") {
      throw new Error(`streamName is not a string: ${typeof streamName}, value: ${streamName}, config: ${JSON.stringify(config)}`);
    }
    const payloadXml = buildPreviewXml(config.handle, streamName, channelId);

    // Neolink subscribes (MSG_ID_VIDEO, msg_num) BEFORE sending the command.
    // On some BCUDP/battery models, the start-stream request can sporadically timeout;
    // retry a few times and ensure we unsubscribe on failures.
    const isUdp = this.client.getTransport?.() === "udp";
    const maxAttempts = isUdp ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const msgNum = this.client.peekNextMsgNum();
      this.client.subscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);

      try {
        const frameParams: Parameters<typeof this.client.sendFrame>[0] = {
          cmdId: BC_CMD_ID_VIDEO,
          channel: ch,
          channelIdOverride: channelId,
          extensionXml: buildChannelExtensionXml(channelId),
          payloadXml,
          messageClass: BC_CLASS_MODERN_24,
          streamType: config.streamType,
        };
        const frame = await this.client.sendFrame(frameParams);

        if (frame.header.responseCode !== 200) {
          throw new Error(
            `Video stream request rejected (response_code ${frame.header.responseCode}). Neolink expects response_code 200, camera returned ${frame.header.responseCode}`
          );
        }

        // Remember msgNum so we can stop the stream with the same msgNum (neolink behavior).
        this.activeVideoMsgNums.set(`${ch}:${profile}`, frame.header.msgNum);

        // Success.
        return;
      } catch (error) {
        lastError = error;
        try {
          this.client.unsubscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);
        } catch {
          // ignore
        }
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));

    // Success - stream should start and frames will arrive as push events with cmd_id 3

    // Check for response code 200 (success)
    // neolink expects response_code: 200 in the reply
    // If response_code is not 200, the stream request was rejected
    // Note: sendXml doesn't expose response_code directly, but it throws on 400 errors
    // For video streaming, we might need to check the actual frame response_code
  }

  /**
   * Returns the msgNum associated with an active video stream subscription, if any.
   * This can be used by stream consumers to filter incoming cmd_id=3 frames and
   * avoid mixing multiple concurrent streams on the same Baichuan client.
   */
  getActiveVideoMsgNum(channel?: number, profile: StreamProfile = "sub"): number | undefined {
    const ch = this.normalizeChannel(channel);
    return this.activeVideoMsgNums.get(`${ch}:${profile}`);
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
  async stopVideoStream(channel?: number, profile: StreamProfile = "sub"): Promise<void> {
    const ch = this.normalizeChannel(channel);
    // Neolink uses the same 0-based channel_id everywhere (header, Extension, payload).
    const channelId = ch;

    // Map profile to handle value (from neolink stream.rs)
    const profileConfig: Record<StreamProfile, { handle: number; streamType: number }> = {
      main: { handle: 0, streamType: 0 },
      sub: { handle: 256, streamType: 1 },
      ext: { handle: 1024, streamType: 0 },
    };

    const config = profileConfig[profile];

    // Build Preview XML payload for stop (without stream_type)
    // channelId is NOT in Preview XML - it's handled via channelId in header
    const payloadXml = buildPreviewStopXml(config.handle, channelId);

    const key = `${ch}:${profile}`;
    const msgNum = this.activeVideoMsgNums.get(key);
    this.activeVideoMsgNums.delete(key);

    // Neolink sends VIDEO_STOP with the same msg_num as VIDEO.
    // Some cameras don't reliably reply; treat this as best-effort with a short timeout.
    try {
      await this.client.sendFrame({
        cmdId: BC_CMD_ID_VIDEO_STOP,
        channel: ch,
        channelIdOverride: channelId,
        extensionXml: buildChannelExtensionXml(channelId),
        payloadXml,
        messageClass: BC_CLASS_MODERN_24,
        streamType: config.streamType,
        ...(msgNum !== undefined ? { msgNumOverride: msgNum } : {}),
        timeoutMs: 2000,
      });
    } catch {
      // ignore
    }
  }

  // --------------------
  // PTZ Control APIs
  // --------------------

  /**
   * Get PTZ preset list via Baichuan.
   * cmd_id: 190 (MSG_ID_GET_PTZ_PRESET from neolink)
   * 
   * @param channel - Channel number (0-based)
   * @returns Array of PTZ presets
   */
  async getPtzPresets(channel?: number): Promise<PtzPreset[]> {
    const ch = this.normalizeChannel(channel);
    // Neolink uses the same channel_id everywhere (header, Extension, payload).
    // In neolink this is 0-based.
    const channelId = ch;
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PTZ_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml: buildChannelExtensionXml(channelId),
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    const parsed = this.parsePtzPresetList(xml);
    const presets: PtzPreset[] = parsed
      // Expose only enabled presets (enable="1" or not present). Disabled presets should not show up in UI.
      .filter((p) => p.enable === undefined || p.enable === "1")
      // Treat empty name as deleted/disabled.
      .filter((p) => p.name === undefined || String(p.name).trim() !== "")
      .map((p) => ({
        id: p.id,
        name: p.name ?? `Preset ${p.id}`,
      }));

    return presets;
  }

  private parsePtzPresetList(xml: string): Array<{ id: number; name?: string; enable?: string }> {
    const parsed: Array<{ id: number; name?: string; enable?: string }> = [];
    const presetMatches = xml.matchAll(/<preset\b[^>]*>([\s\S]*?)<\/preset>/gi);
    for (const match of presetMatches) {
      const presetXml = match[1] ?? "";
      const idText = /<id>([^<]*)<\/id>/i.exec(presetXml)?.[1];
      if (!idText) continue;
      const id = Number(idText);
      if (!Number.isFinite(id)) continue;
      const nameMatch = /<name>([^<]*)<\/name>/i.exec(presetXml);
      const enableMatch = /<enable>([^<]*)<\/enable>/i.exec(presetXml);

      const entry: { id: number; name?: string; enable?: string } = { id };
      const name = nameMatch?.[1];
      const enable = enableMatch?.[1];
      if (name !== undefined) entry.name = name;
      if (enable !== undefined) entry.enable = enable;
      parsed.push(entry);
    }
    return parsed;
  }

  private async getPtzPresetsRaw(channel: number): Promise<Array<{ id: number; name?: string; enable?: string }>> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_PTZ_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml: buildChannelExtensionXml(channelId),
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });
    return this.parsePtzPresetList(xml);
  }

  /**
   * Send PTZ control command (pan/tilt/zoom).
   * cmd_id: 18 (MSG_ID_PTZ_CONTROL from neolink)
   * 
   * @param channel - Channel number (0-based)
   * @param command - PTZ command
   * @returns Promise that resolves when command is sent
   */
  async ptz(command: PtzCommand): Promise<void>;
  async ptz(channel: number, command: PtzCommand): Promise<void>;
  async ptz(channelOrCommand: number | PtzCommand, command?: PtzCommand): Promise<void> {
    const ch = typeof channelOrCommand === "number" ? this.normalizeChannel(channelOrCommand) : 0;
    const resolvedCommand = typeof channelOrCommand === "number" ? command! : channelOrCommand;
    // Neolink uses the same channel_id in meta header, Extension and payload XML.
    // In neolink this is 0-based.
    const channelId = ch;

    // Neolink supports only: "up", "down", "left", "right", "stop" via MSG_ID_PTZ_CONTROL.
    // Zoom/focus are separate messages (e.g. 294/295).
    let direction: "up" | "down" | "left" | "right" | "stop";
    if (resolvedCommand.action === "stop") {
      direction = "stop";
    } else {
      const cmdMap: Record<string, "up" | "down" | "left" | "right"> = {
        Left: "left",
        Right: "right",
        Up: "up",
        Down: "down",
      };
      const mapped = cmdMap[resolvedCommand.command];
      if (!mapped) {
        throw new Error(`Unsupported PTZ command for MSG_ID_PTZ_CONTROL: ${resolvedCommand.command}`);
      }
      direction = mapped;
    }

    // Neolink uses speed as f32; typical values are ~32 (CLI defaults to 32).
    // Some integrations provide a normalized 0..1 speed; map that to 0..64.
    let speed: number;
    if (direction === "stop") {
      speed = 0;
    } else {
      const raw = resolvedCommand.speed;
      if (raw === undefined) {
        speed = 32;
      } else if (raw > 0 && raw <= 1) {
        speed = Math.max(1, raw * 64);
      } else {
        speed = raw;
      }
    }

    const payloadXml = buildPtzControlXml(channelId, direction, speed);

    // Neolink includes Extension with channel_id for PTZ commands.
    const extensionXml = buildChannelExtensionXml(channelId);

    // Neolink does subscribe before sending PTZ commands
    // However, sendFrame already handles the response via pending map using cmdId:messageKey
    // The subscribe in neolink is for routing responses, which sendFrame already does
    // So we don't need explicit subscribeVideoStream here

    // Use sendFrame to check response_code (neolink expects 200)
    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_PTZ_CONTROL,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      // Try to get error details from body if available
      let errorDetails = "";
      if (frame.body.length > 0) {
        try {
          // Access private method via type assertion (needed for error details)
          const tryDecryptXml = (this.client as any).tryDecryptXml;
          if (tryDecryptXml) {
            const errorXml = tryDecryptXml.call(this.client, frame.body, frame.header.channelId, this.client.enc);
            if (errorXml) {
              errorDetails = ` - Error details: ${errorXml.substring(0, 200)}`;
            }
          }
        } catch {
          // Ignore decryption errors.
        }
      }
      throw new Error(`PTZ control rejected (response_code ${frame.header.responseCode})${errorDetails}`);
    }

    // If action is "start", send a stop after a short delay.
    // Some integrations need to tune the movement amount per command.
    if (resolvedCommand.action === "start" && direction !== "stop") {
      const autoStopMs = resolvedCommand.autoStopMs ?? 500;
      if (autoStopMs > 0) {
        setTimeout(() => {
          this.ptz(ch, { action: "stop", command: resolvedCommand.command }).catch(() => {
            // Ignore stop errors
          });
        }, autoStopMs);
      }
    }
  }

  /**
   * Move to PTZ preset position.
   * cmd_id: 19 (MSG_ID_PTZ_CONTROL_PRESET from neolink)
   * 
   * @param channel - Channel number (0-based)
   * @param presetId - Preset ID
   */
  async moveToPtzPreset(presetId: number, channel?: number): Promise<void>;
  async moveToPtzPreset(channel: number, presetId: number): Promise<void>;
  async moveToPtzPreset(arg1: number, arg2?: number): Promise<void> {
    // If 2 args are provided, interpret as (channel, presetId).
    const ch = arg2 === undefined ? this.normalizeChannel(undefined) : this.normalizeChannel(arg1);
    const presetId = arg2 === undefined ? arg1 : arg2;
    const channelId = ch;
    const payloadXml = buildPtzPresetXml(channelId, presetId, "toPos");

    // Neolink includes extension with channel_id for PTZ preset commands
    const extensionXml = buildChannelExtensionXml(channelId);

    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_PTZ_CONTROL_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      throw new Error(`PTZ preset move rejected (response_code ${frame.header.responseCode})`);
    }
  }

  /**
   * Save current position as PTZ preset.
   * cmd_id: 19 (MSG_ID_PTZ_CONTROL_PRESET from neolink)
   * 
   * @param channel - Channel number (0-based)
   * @param presetId - Preset ID
   * @param name - Preset name
   */
  async setPtzPreset(presetId: number, name: string, channel?: number): Promise<void>;
  async setPtzPreset(channel: number, presetId: number, name: string): Promise<void>;
  async setPtzPreset(arg1: number, arg2: number | string, arg3?: string | number): Promise<void> {
    const ch = typeof arg2 === "string" ? this.normalizeChannel(arg3 as number | undefined) : this.normalizeChannel(arg1);
    const presetId = typeof arg2 === "string" ? arg1 : (arg2 as number);
    const name = typeof arg2 === "string" ? arg2 : (arg3 as string);
    const channelId = ch;
    // Important: some firmwares will keep a deleted preset "disabled" (enable=0) and will omit it from cmd190.
    // Sending enable=1 ensures the slot becomes visible again.
    const payloadXml = buildPtzPresetXmlV2(channelId, presetId, "setPos", { name, enable: 1 });

    // Neolink includes extension with channel_id for PTZ preset commands
    const extensionXml = buildChannelExtensionXml(channelId);


    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_PTZ_CONTROL_PRESET,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      throw new Error(`PTZ preset save rejected (response_code ${frame.header.responseCode})`);
    }
  }

  /**
   * Best-effort delete/disable a PTZ preset.
   * 
   * Note: firmware behavior varies. Many cameras include an <enable> flag in the preset list.
   * This method attempts to set enable=0 for the preset.
   */
  async deletePtzPreset(presetId: number, channel?: number): Promise<void>;
  async deletePtzPreset(channel: number, presetId: number): Promise<void>;
  async deletePtzPreset(arg1: number, arg2?: number): Promise<void> {
    // If 2 args are provided, interpret as (channel, presetId).
    const ch = arg2 === undefined ? this.normalizeChannel(undefined) : this.normalizeChannel(arg1);
    const presetId = arg2 === undefined ? arg1 : arg2;
    const channelId = ch;

    const extensionXml = buildChannelExtensionXml(channelId);

    // Grab current name (if any). Some firmwares will only accept disable when the name is preserved.
    let currentName: string | undefined;
    try {
      const before = await this.getPtzPresetsRaw(ch);
      currentName = before.find((p) => p.id === presetId)?.name;
    } catch {
      // ignore
    }

    const attempts: Array<{ payloadXml: string; label: string }> = [
      {
        // Some firmwares support an explicit delete command.
        label: "command=delPos",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "delPos"),
      },
      {
        // Try disable without renaming.
        label: "enable=0 (no name)",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { enable: 0 }),
      },
      {
        // Some firmwares don't support <enable>, but will accept setting an empty name.
        label: "name='' (no enable)",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: "" }),
      },
      {
        label: "enable=0 name=''",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: "", enable: 0 }),
      },
      ...(currentName
        ? [
          {
            label: "enable=0 name=current",
            payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: currentName, enable: 0 }),
          },
        ]
        : []),
      {
        label: "enable=0 name='Preset N'",
        payloadXml: buildPtzPresetXmlV2(channelId, presetId, "setPos", { name: `Preset ${presetId}`, enable: 0 }),
      },
    ];

    let lastError: unknown;
    let any200 = false;
    for (const a of attempts) {
      try {
        const frame = await this.client.sendFrame({
          cmdId: BC_CMD_ID_PTZ_CONTROL_PRESET,
          channel: ch,
          channelIdOverride: channelId,
          extensionXml,
          payloadXml: a.payloadXml,
          messageClass: BC_CLASS_MODERN_24,
          streamType: 0,
        });

        if (frame.header.responseCode !== 200) {
          throw new Error(`PTZ preset delete rejected (response_code ${frame.header.responseCode})`);
        }

        any200 = true;

        // Verify removal/disable. Some firmwares return 200 but do not apply the change.
        // Important: consider enable=0 or empty name as "deleted" even if the slot still exists.
        try {
          const after = await this.getPtzPresetsRaw(ch);
          const entry = after.find((p) => p.id === presetId);
          if (!entry) return;
          const nameEmpty = entry.name !== undefined && String(entry.name).trim() === "";
          const disabled = entry.enable !== undefined && String(entry.enable).trim() === "0";
          if (nameEmpty || disabled) return;
        } catch (e) {
          // If verification fails, treat it as a soft failure and continue attempts.
          lastError = e;
        }
      } catch (e) {
        lastError = e;
      }
    }

    // Many firmwares accept the request (200) but ignore it; don't block the caller.
    // The plugin can still hide the preset by removing it from the enabled list.
    if (any200) {
      this.logger.warn("PTZ presets (baichuan): deletePtzPreset did not take effect (firmware ignored request)", {
        channel: ch,
        channelId,
        presetId,
      });
      return;
    }

    throw lastError instanceof Error ? lastError : new Error("PTZ preset delete failed");
  }

  /**
   * Get current PTZ position.
   * cmd_id: 433 (from reolink_aio)
   * 
   * @param channel - Channel number (0-based)
   * @returns PTZ position (pan and tilt)
   */
  async getPtzPosition(channel?: number): Promise<{ pan?: number; tilt?: number }> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_GET_PTZ_POSITION, channel: ch });

    const panText = getXmlText(xml, "pPos");
    const tiltText = getXmlText(xml, "tPos");

    const result: { pan?: number; tilt?: number } = {};
    if (panText !== undefined) {
      result.pan = Number(panText);
    }
    if (tiltText !== undefined) {
      result.tilt = Number(tiltText);
    }

    return result;
  }

  /**
   * Read zoom/focus min/max/current positions.
   * cmd_id: 294 (MSG_ID_GET_ZOOM_FOCUS)
   */
  async getZoomFocus(channel?: number): Promise<{
    zoom?: { minPos: number; maxPos: number; curPos: number };
    focus?: { minPos: number; maxPos: number; curPos: number };
  }> {
    const ch = this.normalizeChannel(channel);
    const channelId = ch;
    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_GET_ZOOM_FOCUS,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml: buildChannelExtensionXml(channelId),
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    const parseTriplet = (sectionTag: string): { minPos: number; maxPos: number; curPos: number } | undefined => {
      const sectionMatch = new RegExp(`<${sectionTag}>([\\s\\S]*?)</${sectionTag}>`).exec(xml);
      const sectionXml = sectionMatch?.[1];
      if (!sectionXml) return undefined;
      const maxPos = getXmlText(sectionXml, "maxPos");
      const minPos = getXmlText(sectionXml, "minPos");
      const curPos = getXmlText(sectionXml, "curPos");
      if (maxPos === undefined || minPos === undefined || curPos === undefined) return undefined;
      return { maxPos: Number(maxPos), minPos: Number(minPos), curPos: Number(curPos) };
    };

    const out: {
      zoom?: { minPos: number; maxPos: number; curPos: number };
      focus?: { minPos: number; maxPos: number; curPos: number };
    } = {};
    const zoom = parseTriplet("zoom");
    const focus = parseTriplet("focus");
    if (zoom) out.zoom = zoom;
    if (focus) out.focus = focus;
    return out;
  }

  /**
   * Zoom to a given zoom factor, where 1.0 is normal.
   * Uses movePos where 1000 == 1.0x (neolink behavior).
   * cmd_id: 295 (MSG_ID_SET_ZOOM_FOCUS)
   */
  async zoomToFactor(zoomFactor: number, channel?: number): Promise<void>;
  async zoomToFactor(channel: number, zoomFactor: number): Promise<void>;
  async zoomToFactor(arg1: number, arg2?: number): Promise<void> {
    const ch = arg2 === undefined ? 0 : this.normalizeChannel(arg1);
    const zoomFactor = arg2 === undefined ? arg1 : arg2;
    const channelId = ch;
    const current = await this.getZoomFocus(ch);
    const zoom = current.zoom;
    if (!zoom) {
      throw new Error("Camera did not return <zoom> info (zoom may be unsupported)");
    }

    const requestedPos = Math.round(zoomFactor * 1000);
    const movePos = Math.min(zoom.maxPos, Math.max(zoom.minPos, requestedPos));

    const payloadXml = buildStartZoomFocusXml(channelId, movePos);
    const extensionXml = buildChannelExtensionXml(channelId);

    const frame = await this.client.sendFrame({
      cmdId: BC_CMD_ID_SET_ZOOM_FOCUS,
      channel: ch,
      channelIdOverride: channelId,
      extensionXml,
      payloadXml,
      messageClass: BC_CLASS_MODERN_24,
      streamType: 0,
    });

    if (frame.header.responseCode !== 200) {
      throw new Error(`Zoom rejected (response_code ${frame.header.responseCode})`);
    }
  }

  // --------------------
  // Battery Info API
  // --------------------

  private parseBatteryInfoXml(xml: string, channel: number): Partial<BatteryInfo> {
    const parseNum = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // Prefer parsing the matching <BatteryInfo> block when a list is returned.
    const batteryInfoBlocks = getXmlBlocks(xml, "BatteryInfo");
    const preferredBlock =
      batteryInfoBlocks.find((b) => getXmlText(b, "channelId") === String(channel)) ??
      batteryInfoBlocks[0] ??
      xml;

    const out: Partial<BatteryInfo> = {};

    const batteryPercent = parseNum(getXmlText(preferredBlock, "batteryPercent"));
    if (batteryPercent !== undefined) out.batteryPercent = batteryPercent;

    const chargeStatus = getXmlText(preferredBlock, "chargeStatus");
    if (chargeStatus !== undefined) out.chargeStatus = chargeStatus;

    const adapterStatus = getXmlText(preferredBlock, "adapterStatus");
    if (adapterStatus !== undefined) out.adapterStatus = adapterStatus;

    const voltage = parseNum(getXmlText(preferredBlock, "voltage"));
    if (voltage !== undefined) out.voltage = voltage;

    const current = parseNum(getXmlText(preferredBlock, "current"));
    if (current !== undefined) out.current = current;

    const temperature = parseNum(getXmlText(preferredBlock, "temperature"));
    if (temperature !== undefined) out.temperature = temperature;

    const lowPower = parseNum(getXmlText(preferredBlock, "lowPower"));
    if (lowPower !== undefined) out.lowPower = lowPower;

    const batteryVersion = parseNum(getXmlText(preferredBlock, "batteryVersion"));
    if (batteryVersion !== undefined) out.batteryVersion = batteryVersion;

    return out;
  }

  /**
   * Best-effort sleeping inference for battery/BCUDP cameras.
   *
   * This method does NOT send any request to the camera.
   * Rule (per neolink): consider the camera sleeping if, in the last 10 seconds,
   * we only received/sent Baichuan commands that are known to be non-waking.
   */
  getSleepStatus(opts?: {
    /** Window to inspect (ms). Default: 10_000. */
    windowMs?: number;
    /** Back-compat alias for `windowMs`. */
    idleMs?: number;
    channel?: number;
    /** List of cmdIds that do NOT wake the camera. If omitted, uses neolink-derived defaults. */
    nonWakingCmdIds?: number[];
    /** Back-compat alias for `nonWakingCmdIds`. */
    ignoreCmdIds?: number[];
  }): SleepStatus {
    const windowMs = opts?.windowMs ?? opts?.idleMs ?? 10_000;
    const nonWakingCmdIds = new Set<number>(
      opts?.nonWakingCmdIds ??
        opts?.ignoreCmdIds ??
        [BC_CMD_ID_UDP_KEEP_ALIVE, BC_CMD_ID_GET_BATTERY_INFO_LIST, BC_CMD_ID_GET_BATTERY_INFO, BC_CMD_ID_FLOODLIGHT_STATUS_LIST]
    );
    const transport = this.client.getTransport?.();
    if (transport !== "udp") {
      return { state: "unknown", reason: "sleep inference supported only for UDP/battery" };
    }

    // If we are actively streaming, treat the device as awake.
    // This check lives in the client and includes cross-client streaming activity within the same process.
    if (this.activeVideoMsgNums.size > 0 || this.rtspServers.size > 0 || this.client.isDeviceStreamingActive?.()) {
      return { state: "awake", reason: "active streaming" };
    }

    const socketConnected = this.client.isSocketConnected?.() ?? false;

    const now = Date.now();
    const cutoff = now - windowMs;

    const rx = (this.client.getRxHistory?.() ?? []).filter((h) => h.atMs >= cutoff);
    const tx = (this.client.getTxHistory?.() ?? []).filter((h) => h.atMs >= cutoff);

    // If we've had absolutely no activity in the window, treat as sleeping (best-effort).
    // This matches the intent: no waking commands observed recently.
    if (rx.length === 0 && tx.length === 0) {
      return {
        state: "sleeping",
        reason: `no rx/tx activity in last ${windowMs}ms${socketConnected ? "" : " (socket disconnected)"}`,
        idleMs: windowMs,
      };
    }

    const firstWakingRx = rx.find((h) => !nonWakingCmdIds.has(h.cmdId));
    if (firstWakingRx) {
      return {
        state: "awake",
        reason: `waking rx cmdId=${firstWakingRx.cmdId} responseCode=${firstWakingRx.responseCode} seen ${now - firstWakingRx.atMs}ms ago`,
        lastRxAtMs: firstWakingRx.atMs,
        idleMs: now - firstWakingRx.atMs,
      };
    }

    const firstWakingTx = tx.find((h) => !nonWakingCmdIds.has(h.cmdId));
    if (firstWakingTx) {
      return {
        state: "awake",
        reason: `waking tx cmdId=${firstWakingTx.cmdId} seen ${now - firstWakingTx.atMs}ms ago`,
        idleMs: now - firstWakingTx.atMs,
      };
    }

    return {
      state: "sleeping",
      reason: `only non-waking cmdIds observed in last ${windowMs}ms (non-waking: ${Array.from(nonWakingCmdIds).join(",")})`,
      idleMs: windowMs,
    };
  }

  /**
   * Active sleep probe using a non-waking command with a short timeout.
   *
   * Why this exists:
   * - Passive inference can be noisy (keepalives, other clients, separate stream paths).
   * - A short-timeout probe answers: "is the camera responding right now?".
   *
   * Important caveats:
   * - If *another* client keeps the camera awake, the probe will return awake (correct: it's awake).
   * - Do NOT call this in a tight loop; it will generate traffic and can prevent sleep.
   */
  async probeSleepStatus(opts?: {
    channel?: number;
    /** Default: 700ms */
    timeoutMs?: number;
    /** Default: 1 */
    attempts?: number;
    /** Default: 5000ms (returns cached status if called more frequently) */
    minIntervalMs?: number;
    /** Override command used for probing. Default: battery info (253). */
    cmdId?: number;
  }): Promise<SleepStatus> {
    const transport = this.client.getTransport?.();
    if (transport !== "udp") {
      return { state: "unknown", reason: "sleep probe supported only for UDP/battery" };
    }

    // If we are actively streaming, treat the device as awake.
    // This check lives in the client and includes cross-client streaming activity within the same process.
    if (this.activeVideoMsgNums.size > 0 || this.rtspServers.size > 0 || this.client.isDeviceStreamingActive?.()) {
      return { state: "awake", reason: "active streaming" };
    }

    const now = Date.now();
    const minIntervalMs = opts?.minIntervalMs ?? 5_000;
    if (this.lastSleepProbe && now - this.lastSleepProbe.atMs < minIntervalMs) {
      return { ...this.lastSleepProbe.status, reason: `${this.lastSleepProbe.status.reason} (cached)` };
    }

    // Avoid implicitly forcing a login/reconnect as part of a "sleep check".
    if (!this.client.isSocketConnected()) {
      const status: SleepStatus = { state: "unknown", reason: "udp socket not connected" };
      this.lastSleepProbe = { atMs: now, status };
      return status;
    }
    if (!this.client.loggedIn) {
      const status: SleepStatus = { state: "unknown", reason: "not logged in" };
      this.lastSleepProbe = { atMs: now, status };
      return status;
    }

    const ch = this.normalizeChannel(opts?.channel);
    const timeoutMs = opts?.timeoutMs ?? 700;
    const attempts = Math.max(1, opts?.attempts ?? 1);
    const cmdId = opts?.cmdId ?? BC_CMD_ID_GET_BATTERY_INFO; // 253

    for (let i = 0; i < attempts; i++) {
      try {
        const frame = await this.client.sendFrame({ cmdId, channel: ch, timeoutMs });
        const status: SleepStatus = {
          state: frame.header.responseCode === 200 ? "awake" : "unknown",
          reason: `probe cmdId=${cmdId} responseCode=${frame.header.responseCode}`,
        };
        this.lastSleepProbe = { atMs: Date.now(), status };
        return status;
      } catch (e) {
        // On timeout, interpret as sleeping (best-effort). Other errors remain unknown.
        const msg = e instanceof Error ? e.message : String(e);
        const isTimeout = msg.includes("Baichuan timeout") || msg.toLowerCase().includes("timeout");
        if (isTimeout) {
          const status: SleepStatus = { state: "sleeping", reason: `probe timeout cmdId=${cmdId} timeoutMs=${timeoutMs}` };
          this.lastSleepProbe = { atMs: Date.now(), status };
          return status;
        }
        // Retry on transient errors if attempts > 1.
        if (i === attempts - 1) {
          const status: SleepStatus = { state: "unknown", reason: `probe error cmdId=${cmdId}: ${msg}` };
          this.lastSleepProbe = { atMs: Date.now(), status };
          return status;
        }
      }
    }

    const fallback: SleepStatus = { state: "unknown", reason: "probe exhausted" };
    this.lastSleepProbe = { atMs: Date.now(), status: fallback };
    return fallback;
  }

  /**
   * Get battery status for battery-powered cameras, including sleep state.
   * This is a comprehensive API that returns battery info AND checks if the camera is sleeping.
    * cmd_id: 253 (MSG_ID_BATTERY_INFO from neolink)
   * 
   * @param channel - Channel number (0-based)
   * @returns Battery information including sleep status
   */
  async getBatteryStatus(channel?: number): Promise<BatteryInfo> {
    const ch = this.normalizeChannel(channel);

    // First: no-wake inference. If we're likely sleeping, don't send any request.
    // This avoids the common pitfall where the "sleep check" itself prevents sleep.
    const sleepStatus = this.getSleepStatus({ channel: ch });
    if (sleepStatus.state === "sleeping") {
      return { channel: ch, sleeping: true };
    }

    try {
      // First, try to get battery info
      // If the camera is sleeping, this may timeout or fail
      const xml = await Promise.race([
        this.sendXml({ cmdId: BC_CMD_ID_GET_BATTERY_INFO, channel: ch }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000)
        )
      ]);

      const result: BatteryInfo = {
        channel: ch,
        sleeping: false, // Camera responded, so it's awake
      };

      Object.assign(result, this.parseBatteryInfoXml(xml, ch));

      return result;
    } catch (error) {
      // If the command times out or fails, the camera may be sleeping OR the path is broken.
      const result: BatteryInfo = {
        channel: ch,
      };

      const inferred = this.getSleepStatus({ channel: ch });
      if (inferred.state === "sleeping") result.sleeping = true;

      // If we got an error that's not a timeout, we still don't know the battery status
      // But we can infer it's sleeping if it failed to respond
      if (error instanceof Error && error.message === "Timeout") {
        // Camera didn't respond within 5 seconds, possibly sleeping
        if (result.sleeping == null) result.sleeping = true;
      } else {
        // Other error, but still mark as potentially sleeping
      }

      return result;
    }
  }

  /**
   * Get battery information via Baichuan.
   * cmd_id: 253 (MSG_ID_BATTERY_INFO from neolink)
   * 
   * Note: Battery info can be pushed via events (cmd_id 252 BatteryInfoList), but on-demand request
   * is cmd_id 253.
  * For checking sleep state without polling/waking, use getSleepStatus() instead.
   * 
   * @param channel - Channel number (0-based)
   * @returns Battery information
   */
  async getBatteryInfo(channel?: number): Promise<BatteryInfo> {
    const ch = this.normalizeChannel(channel);

    // IMPORTANT (battery/BCUDP): avoid forcing a reconnect/login just to fetch battery info.
    // Many battery cameras will deliberately drop the BCUDP session when sleeping (D2C_DISC).
    // If we auto-login here, the periodic poller will keep waking the camera.
    const transport = this.client.getTransport?.();
    if (transport === "udp") {
      if (!this.client.isSocketConnected?.() || !this.client.loggedIn) {
        return { channel: ch, sleeping: true };
      }
    }

    // Use the raw client call to avoid `ReolinkBaichuanApi.sendXml` auto-login + 400-empty-body relogin loop.
    const xml = await this.client.sendXml({ cmdId: BC_CMD_ID_GET_BATTERY_INFO, channel: ch });

    const result: BatteryInfo = {
      channel: ch,
    };

    Object.assign(result, this.parseBatteryInfoXml(xml, ch));

    return result;
  }

  /**
   * Wake up a sleeping battery camera by sending a "waking command".
   * Based on reolink_aio: WAKING_COMMANDS like GetEnc (cmd_id 56) can wake up sleeping cameras.
   * 
   * Reference: reolink_aio/const.py - WAKING_COMMANDS includes "GetEnc"
   * 
   * @param channel - Channel number (0-based)
   * @param waitAfterWake - Optional delay in milliseconds after sending wake command (default: 1500ms, as in reolink_aio)
   */
  async wakeUp(channel?: number, options?: number | WakeUpOptions): Promise<void> {
    const ch = this.normalizeChannel(channel);
    const opts: WakeUpOptions = typeof options === "number" ? { waitAfterWakeMs: options } : (options ?? {});

    const timeoutMs = opts.timeoutMs ?? 20_000;
    const attempts = opts.attempts ?? 3;
    const waitAfterWakeMs = opts.waitAfterWakeMs ?? 1500;
    const backoffMs = opts.backoffMs ?? 1500;

    const isUdp = this.client.getTransport?.() === "udp";
    const reconnect = opts.reconnect ?? isUdp;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Use GetEnc (cmd_id 56) which is a WAKING_COMMAND per reolink_aio.
        // If the session is stale (common on battery/BCUDP), this may timeout.
        await this.getEncXml(ch, { timeoutMs });

        if (waitAfterWakeMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitAfterWakeMs));
        }
        return;
      } catch (e) {
        lastError = e;

        // Common cases when the camera is sleeping or the session/socket is stale:
        // - timeout waiting for reply
        // - socket closed
        const msg = e instanceof Error ? e.message : String(e);
        const looksLikeTimeout = msg.includes("Baichuan timeout");
        const looksLikeClosed = msg.toLowerCase().includes("socket closed") || msg.toLowerCase().includes("stream closed");

        if (attempt < attempts) {
          if (reconnect && (looksLikeTimeout || looksLikeClosed)) {
            try {
              // Force a fresh connect+login on next attempt.
              this.client.loggedIn = false;
              await this.client.close();
            } catch {
              // ignore
            }
          }

          if (backoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Check if a camera is sleeping.
   * 
   * This is difficult to determine directly. The method attempts to:
   * 1. Check if we can successfully get battery info (non-waking command)
   * 2. If that fails with timeout or connection error, the camera might be sleeping
   * 
   * Note: GetBatteryInfo is a NONE_WAKING_COMMAND, so it won't wake up the camera.
   * However, if the camera is sleeping, it may timeout or fail to respond.
   * 
   * @param channel - Channel number (0-based)
   * @returns true if camera appears to be sleeping, false otherwise
   */
  async isSleeping(channel?: number): Promise<boolean> {
    const ch = this.normalizeChannel(channel);
    try {
      // Try to get battery info (non-waking command)
      // If camera is sleeping, this should timeout or fail
      await Promise.race([
        this.getBatteryInfo(ch),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000)
        )
      ]);
      // If we got a response, camera is not sleeping
      return false;
    } catch (error) {
      // If we get a timeout or connection error, camera might be sleeping
      // However, it could also be a network issue or camera offline
      // We can't be 100% sure, but a timeout suggests sleeping
      return true;
    }
  }

  // --------------------
  // PIR State APIs
  // --------------------

  /**
   * Get PIR (Passive Infrared) detection settings via Baichuan.
   * cmd_id: 212 (MSG_ID_GET_PIR_ALARM from neolink)
   * 
   * @param channel - Channel number (0-based)
   * @returns PIR state information
   */
  async getPirInfo(channel?: number): Promise<PirState> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_GET_PIR_INFO, channel: ch });

    const parseBoolishNumber = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const t = v.trim().toLowerCase();
      if (t === "true") return 1;
      if (t === "false") return 0;
      const n = Number(t);
      return Number.isFinite(n) ? n : undefined;
    };

    const parseEnabled = (v: string | undefined): boolean => {
      if (v === undefined) return false;
      const t = v.trim().toLowerCase();
      return t === "1" || t === "true";
    };

    // Reolink PIR sensitivity is commonly inverted vs the mobile app UI.
    // Observed mapping (also used by other SDKs): app = 101 - sensiValue.
    const mapPirSensitivityToApp = (raw: number): number => {
      const mapped = 101 - raw;
      return Math.trunc(mapped);
    };

    const enable = getXmlText(xml, "enable");
    const sensitive = getXmlText(xml, "sensiValue");
    const reduceAlarm = getXmlText(xml, "reduceFalseAlarm");
    const interval = getXmlText(xml, "interval");
    const intervalMax = getXmlText(xml, "intervalSecMax");

    const state: PirState["state"] = {
      channel: ch,
    };
    if (enable !== undefined) {
      const n = parseBoolishNumber(enable);
      if (n !== undefined) state.enable = n;
    }
    if (sensitive !== undefined) {
      state.sensitive = Number(sensitive);
    }
    if (reduceAlarm !== undefined) {
      const n = parseBoolishNumber(reduceAlarm);
      if (n !== undefined) state.reduceAlarm = n;
    }
    if (interval !== undefined) {
      const n = parseBoolishNumber(interval);
      if (n !== undefined) state.interval = n;
    }
    if (intervalMax !== undefined) {
      const n = parseBoolishNumber(intervalMax);
      if (n !== undefined) state.intervalMax = n;
    }

    return {
      enabled: parseEnabled(enable),
      state,
    };
  }

  /**
   * Set PIR (Passive Infrared) detection settings via Baichuan.
   * cmd_id: 213 (MSG_ID_START_PIR_ALARM from neolink)
   * 
   * @param channel - Channel number (0-based)
   * @param params - PIR settings (enable is required)
   */
  async setPirInfo(params: { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }, channel?: number): Promise<void>;
  async setPirInfo(channel: number, params: { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }): Promise<void>;
  async setPirInfo(
    arg1: number | { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number },
    arg2?: number | { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }
  ): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : (arg2 as number | undefined);
    const params = typeof arg1 === "number" ? (arg2 as { enable: number; sensitive?: number; reduceAlarm?: number; interval?: number }) : arg1;
    const ch = this.normalizeChannel(channel);

    const toPirSensitivityRaw = (appValue: number): number => {
      // Inverse mapping of getPirInfo(): raw = 101 - app.
      return Math.trunc(101 - appValue);
    };

    const toBoolishNumber = (v: unknown): number | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === "boolean") return v ? 1 : 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // First get current settings to modify
    const currentXml = await this.sendXml({ cmdId: BC_CMD_ID_GET_PIR_INFO, channel: ch });

    // Parse and modify XML
    let modifiedXml = currentXml;

    if (params.enable !== undefined) {
      modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/, `<enable>${params.enable}</enable>`);
    }
    if (params.sensitive !== undefined) {
      const raw = toPirSensitivityRaw(params.sensitive);
      modifiedXml = modifiedXml.replace(/<sensiValue>[^<]*<\/sensiValue>/, `<sensiValue>${raw}</sensiValue>`);
    }
    if (params.reduceAlarm !== undefined) {
      const n = toBoolishNumber(params.reduceAlarm);
      if (n !== undefined) {
        modifiedXml = modifiedXml.replace(/<reduceFalseAlarm>[^<]*<\/reduceFalseAlarm>/, `<reduceFalseAlarm>${n}</reduceFalseAlarm>`);
      }
    }
    if (params.interval !== undefined) {
      modifiedXml = modifiedXml.replace(/<interval>[^<]*<\/interval>/, `<interval>${params.interval}</interval>`);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_PIR_INFO,
      channel: ch,
      payloadXml: modifiedXml,
    });
  }

  // --------------------
  // Motion Detection Set API
  // --------------------

  /**
   * Set motion detection settings via Baichuan.
   * cmd_id: 47 (SetMdAlarm from reolink_aio)
   * 
   * @param channel - Channel number (0-based)
   * @param enabled - Enable/disable motion detection
   * @param sensitivity - Sensitivity level (optional)
   */
  async setMotionDetection(enabled: boolean, sensitivity?: number, channel?: number): Promise<void>;
  async setMotionDetection(channel: number, enabled: boolean, sensitivity?: number): Promise<void>;
  async setMotionDetection(arg1: number | boolean, arg2?: boolean | number, arg3?: number): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : arg3;
    const enabled = typeof arg1 === "number" ? (arg2 as boolean) : arg1;
    const sensitivity = typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const ch = this.normalizeChannel(channel);
    // First get current settings
    const currentXml = await this.sendXml({ cmdId: 46, channel: ch }); // GetMdAlarm

    // Parse and modify XML
    // Expected format: <sensInfoNew><enable>...</enable><sensitivityDefault>...</sensitivityDefault></sensInfoNew>
    let modifiedXml = currentXml;

    if (enabled !== undefined) {
      modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/, `<enable>${enabled ? "1" : "0"}</enable>`);
    }
    if (sensitivity !== undefined) {
      modifiedXml = modifiedXml.replace(/<sensitivityDefault>[^<]*<\/sensitivityDefault>/, `<sensitivityDefault>${sensitivity}</sensitivityDefault>`);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_MOTION_ALARM,
      channel: ch,
      payloadXml: modifiedXml,
    });
  }

  // --------------------
  // AI Detection Set API
  // --------------------

  /**
   * Set AI detection settings via Baichuan.
   * cmd_id: 343 (SetAiAlarm from reolink_aio)
   * 
   * @param channel - Channel number (0-based)
   * @param aiType - AI type (e.g., "people", "vehicle", "dog_cat", "face", "package")
   * @param sensitivity - Sensitivity level (optional)
   * @param stayTime - Stay time/delay (optional)
   */
  async setAiDetection(aiType: string, sensitivity?: number, stayTime?: number, channel?: number): Promise<void>;
  async setAiDetection(channel: number, aiType: string, sensitivity?: number, stayTime?: number): Promise<void>;
  async setAiDetection(arg1: number | string, arg2?: string | number, arg3?: number, arg4?: number): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : arg4;
    const aiType = typeof arg1 === "number" ? (arg2 as string) : arg1;
    const sensitivity = typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const stayTime = typeof arg1 === "number" ? arg4 : arg3;
    const ch = this.normalizeChannel(channel);
    // First get current settings for this AI type.
    // Correct cmd 342 payload (reolink_aio): <AiDetectCfg><chn>0-based</chn><type>people</type></AiDetectCfg>
    const getXml = `<?xml version="1.0" encoding="UTF-8" ?>
  <body>
  <AiDetectCfg version="1.1">
  <chn>${ch}</chn>
  <type>${xmlEscape(aiType)}</type>
  </AiDetectCfg>
  </body>`;

    const currentXml = await this.sendXml({
      cmdId: 342, // GetAiAlarm
      channel: ch,
      payloadXml: getXml,
    });

    // Parse and modify XML
    let modifiedXml = currentXml;

    if (sensitivity !== undefined) {
      modifiedXml = modifiedXml.replace(/<sensitivity>[^<]*<\/sensitivity>/, `<sensitivity>${sensitivity}</sensitivity>`);
    }
    if (stayTime !== undefined) {
      modifiedXml = modifiedXml.replace(/<stayTime>[^<]*<\/stayTime>/, `<stayTime>${stayTime}</stayTime>`);
    }

    await this.sendXml({
      cmdId: BC_CMD_ID_SET_AI_ALARM,
      channel: ch,
      payloadXml: modifiedXml,
    });
  }

  // --------------------
  // Siren/Audio Alarm APIs
  // --------------------

  /**
   * Get siren/audio alarm status via Baichuan.
   * cmd_id: 547 (GetAudioAlarm - push event, not a request)
   * 
   * Note: Siren status is typically pushed via events (cmd_id 547), not requested directly.
   * This method attempts to get the status, but it may not work on all cameras.
   * 
   * @param channel - Channel number (0-based)
   * @returns Siren status
   */
  async getSiren(channel?: number): Promise<{ enabled: boolean }> {
    // Note: cmd_id 547 is typically a push event, not a request
    // We try to get it, but it may not work on all cameras
    try {
      const xml = await this.sendXml({
        cmdId: BC_CMD_ID_GET_AUDIO_ALARM,
        ...(channel !== undefined ? { channel } : {}),
      });

      // Parse siren status from XML
      // Expected format: <SirenStatus><status>...</status></SirenStatus>
      const status = getXmlText(xml, "status");
      return {
        enabled: status === "1",
      };
    } catch {
      // If request fails, return default (siren status is typically pushed, not requested)
      return { enabled: false };
    }
  }

  /**
   * Play siren/audio alarm via Baichuan.
   * cmd_id: 263 (MSG_ID_PLAY_AUDIO from neolink)
   * 
   * @param channel - Channel number (0-based, optional for hub-level)
   * @param on - Enable/disable siren (for manual mode)
   * @param duration - Number of times to play (for times mode)
   */
  async setSiren(on?: boolean, duration?: number, channel?: number): Promise<void>;
  async setSiren(channel: number | undefined, on?: boolean, duration?: number): Promise<void>;
  async setSiren(arg1?: number | boolean, arg2?: boolean | number, arg3?: number): Promise<void> {
    const channel = typeof arg1 === "boolean" ? (arg3 ?? 0) : (arg1 as number | undefined);
    const on = typeof arg1 === "boolean" ? arg1 : (arg2 as boolean | undefined);
    const duration = typeof arg1 === "boolean" ? (arg2 as number | undefined) : arg3;

    const channelId = channel !== undefined ? channel + 1 : undefined;
    let payloadXml: string;

    if (duration !== undefined) {
      // Times mode: play siren a specific number of times
      payloadXml = buildSirenTimesXml(channelId, duration);
    } else {
      // Manual mode: turn siren on/off
      const enable = on ? 1 : 0;
      payloadXml = buildSirenManualXml(channelId, enable);
    }

    try {
      await this.sendXml({
        cmdId: BC_CMD_ID_AUDIO_ALARM_PLAY,
        ...(channel !== undefined ? { channel } : {}),
        payloadXml,
      });
    } catch (error) {
      // If manual mode fails, try times mode with 2 times (reolink_aio fallback)
      if (on === true && duration === undefined) {
        payloadXml = buildSirenTimesXml(channelId, 2);
        await this.sendXml({
          cmdId: BC_CMD_ID_AUDIO_ALARM_PLAY,
          ...(channel !== undefined ? { channel } : {}),
          payloadXml,
        });
      } else {
        throw error;
      }
    }
  }

  // --------------------
  // White LED/Floodlight APIs
  // --------------------

  /**
   * Get white LED/floodlight state via Baichuan.
   * cmd_id: 289 (GetWhiteLed/Floodlight from reolink_aio)
   * 
   * @param channel - Channel number (0-based)
   * @returns White LED state
   */
  async getWhiteLedState(channel?: number): Promise<WhiteLedState> {
    const ch = this.normalizeChannel(channel);
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_GET_WHITE_LED, channel: ch });

    // Parse state from various known payloads:
    // - FloodlightTask: <enable>1</enable> and/or sometimes <state>
    // - FloodlightManual: <status>1</status>
    const enable = getXmlText(xml, "enable");
    const state = getXmlText(xml, "state");
    const status = getXmlText(xml, "status");
    const brightnessText = getXmlText(xml, "brightness_cur");

    const result: WhiteLedState = {
      enabled: enable === "1" || state === "1" || status === "1",
    };
    if (brightnessText !== undefined) {
      result.brightness = Number(brightnessText);
    }

    return result;
  }

  /**
   * Set white LED/floodlight state via Baichuan.
   * cmd_id: 288 (SetWhiteLed state) or 290 (SetWhiteLed task)
   * 
   * @param channel - Channel number (0-based)
   * @param on - Enable/disable white LED
   * @param brightness - Brightness level (optional)
   */
  async setWhiteLedState(on?: boolean, brightness?: number, channel?: number): Promise<void>;
  async setWhiteLedState(channel: number, on?: boolean, brightness?: number): Promise<void>;
  async setWhiteLedState(arg1?: number | boolean, arg2?: boolean | number, arg3?: number): Promise<void> {
    const channel = typeof arg1 === "number" ? arg1 : (arg3 ?? 0);
    const on = typeof arg1 === "number" ? (arg2 as boolean | undefined) : (arg1 as boolean | undefined);
    const brightness = typeof arg1 === "number" ? arg3 : (arg2 as number | undefined);
    const ch = this.normalizeChannel(channel);

    // Neolink (and many firmwares) use:
    // - cmd 288: FloodlightManual (write) for manual on/off
    // - cmd 290: FloodlightTask (write) for task config / brightness
    // Historically we sent a <WhiteLed> payload which can yield 400 on many cameras.
    if (on !== undefined) {
      try {
        const payloadXml = buildFloodlightManualXml(ch, on ? 1 : 0, on ? 180 : 0);
        await this.sendXml({
          cmdId: BC_CMD_ID_SET_WHITE_LED_STATE,
          channel: ch,
          payloadXml,
        });
      } catch (e) {
        // Fallback: use task XML returned by cmd 289, update <enable>/<state>/<status> and send with cmd 290.
        const currentXml = await this.sendXml({ cmdId: BC_CMD_ID_GET_WHITE_LED, channel: ch });
        let modifiedXml = currentXml;

        // Some payloads use <enable>, others use <state> or <status>.
        if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
          modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/i, `<enable>${on ? 1 : 0}</enable>`);
        }
        if (/<state>[^<]*<\/state>/i.test(modifiedXml)) {
          modifiedXml = modifiedXml.replace(/<state>[^<]*<\/state>/i, `<state>${on ? 1 : 0}</state>`);
        }
        if (/<status>[^<]*<\/status>/i.test(modifiedXml)) {
          modifiedXml = modifiedXml.replace(/<status>[^<]*<\/status>/i, `<status>${on ? 1 : 0}</status>`);
        }

        await this.sendXml({
          cmdId: BC_CMD_ID_SET_WHITE_LED_TASK,
          channel: ch,
          payloadXml: modifiedXml,
        });
      }
    }

    if (brightness !== undefined) {
      const currentXml = await this.sendXml({ cmdId: BC_CMD_ID_GET_WHITE_LED, channel: ch });
      let modifiedXml = currentXml;
      if (/<brightness_cur>[^<]*<\/brightness_cur>/i.test(modifiedXml)) {
        modifiedXml = modifiedXml.replace(
          /<brightness_cur>[^<]*<\/brightness_cur>/i,
          `<brightness_cur>${brightness}</brightness_cur>`,
        );
      }

      // If a brightness was set, ensure task is enabled.
      if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
        modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/i, `<enable>1</enable>`);
      }

      await this.sendXml({
        cmdId: BC_CMD_ID_SET_WHITE_LED_TASK,
        channel: ch,
        payloadXml: modifiedXml,
      });
    }
  }

  // --------------------
  // Ability Info API
  // --------------------

  /**
   * Get device abilities/capabilities via Baichuan.
   * cmd_id: 151 (MSG_ID_ABILITY_INFO from neolink)
   * 
   * Returns a dictionary of device capabilities and their version numbers.
   * This is used to determine what features are supported by the device.
   * 
   * The token used requests all available sections: system, streaming, PTZ, IO, security, 
   * replay, disk, network, alarm, record, video, image (based on neolink implementation).
   * 
   * @param username - Username for the request (required)
   * @returns Dictionary of capability names to version numbers or values, keyed by channel number or "Host"
   */
  async getAbilityInfo(): Promise<Partial<Record<number | "Host", Record<string, number | string | undefined>>>> {
    // Return type matches DeviceAbilities from types.ts
    const user = this.client.username;
    const extensionXml = buildAbilityInfoExtensionXml(user);

    const xml = await this.sendXml({
      cmdId: BC_CMD_ID_ABILITY_INFO,
      extensionXml,
    });

    // Parse AbilityInfo XML
    // Expected format based on neolink: multiple token sections (system, network, alarm, image, video, security, replay, PTZ, IO, streaming, disk, record)
    // Each section can contain subModule elements with channelId and abilityValue
    // <AbilityInfo>
    //   <system><subModule>...</subModule></system>
    //   <network><subModule>...</subModule></network>
    //   <alarm><subModule>...</subModule></alarm>
    //   <image><subModule><channelId>0</channelId><abilityValue>ispBasic_rw, ledState_rw</abilityValue></subModule></image>
    //   <video><subModule><channelId>0</channelId><abilityValue>osdName_rw, osdTime_rw</abilityValue></subModule></video>
    //   <PTZ><subModule>...</subModule></PTZ>
    //   ... etc
    // </AbilityInfo>
    const abilities: Partial<Record<number | "Host", Record<string, number | string | undefined>>> = {};

    // List of all possible token sections (based on neolink implementation)
    const tokenSections = [
      "system", "streaming", "PTZ", "IO", "security", "replay",
      "disk", "network", "alarm", "record", "video", "image"
    ];

    // Parse each token section
    for (const tokenSection of tokenSections) {
      // Use case-insensitive matching and handle both lowercase and mixed case
      const sectionRegex = new RegExp(`<${tokenSection}[^>]*>([\\s\\S]*?)<\\/${tokenSection}>`, "i");
      const sectionMatch = xml.match(sectionRegex);

      if (sectionMatch) {
        const sectionXml = sectionMatch[1] ?? "";
        const subModuleMatches = sectionXml.matchAll(/<subModule[^>]*>([\s\S]*?)<\/subModule>/g);

        for (const match of subModuleMatches) {
          const subModuleXml = match[1] ?? "";
          const channelIdText = getXmlText(subModuleXml, "channelId") || getXmlText(subModuleXml, "chnID");
          const abilityValue = getXmlText(subModuleXml, "abilityValue");

          if (abilityValue) {
            const channelKey: number | "Host" = channelIdText ? Number(channelIdText) : "Host";

            if (!abilities[channelKey]) {
              abilities[channelKey] = {};
            }

            // Parse abilityValue string - contains comma-separated capability names
            // Capabilities already include their full name (e.g., "preview_rw", "general_rw")
            const capabilities = abilityValue.split(",").map(c => c.trim()).filter(Boolean);
            for (const capability of capabilities) {
              // Mark as available (value 1 means supported)
              // Capabilities typically end with _rw (read-write) or _ro (read-only)
              abilities[channelKey]![capability] = 1;
            }
          }
        }
      }
    }

    // Note: The token section parsing above already handles image and video,
    // so we don't need separate parsing for them

    // Also check for top-level AbilityInfo items (host-level metadata like userName)
    const abilityInfoMatch = xml.match(/<AbilityInfo[^>]*>([\s\S]*?)<\/AbilityInfo>/);
    if (abilityInfoMatch) {
      const abilityInfoXml = abilityInfoMatch[1] ?? "";

      // Find direct child elements that aren't image/video/subModule
      const directChildren = abilityInfoXml.matchAll(/<([A-Za-z]+)[^>]*>([^<]*)<\/\1>/g);

      if (!abilities["Host"]) {
        abilities["Host"] = {};
      }

      for (const childMatch of directChildren) {
        const tagName = childMatch[1];
        const textValue = childMatch[2];

        // Only store metadata, not parsed ability values (those are already in channel entries)
        if (tagName && textValue !== undefined && !["image", "video", "subModule"].includes(tagName)) {
          // Skip internal parsing artifacts
          if (tagName !== "channelId" && tagName !== "abilityValue") {
            // Store as string or number
            const numValue = Number(textValue);
            abilities["Host"]![tagName] = Number.isNaN(numValue) ? textValue : numValue;
          }
        }
      }
    }

    // Clean up: remove empty Host entry if it only has metadata
    if (abilities["Host"] && Object.keys(abilities["Host"]).length === 0) {
      delete abilities["Host"];
    }

    return abilities;
  }

  /**
   * Get ability/capability version for a specific capability and channel.
   * This is a convenience method that wraps getAbilityInfo.
   * 
   * @param username - Username for the request
   * @param capability - Capability name (e.g., "reboot", "rtsp", "netPort")
   * @param channel - Channel number (optional, None/null for host-level)
   * @returns Version number (0 = not supported, >0 = supported with that version)
   */
  async getAbilityVersion(capability: string, channel?: number | null): Promise<number> {
    const abilities = await this.getAbilityInfo();
    const channelKey: number | "Host" = channel !== undefined && channel !== null ? channel : "Host";
    const channelAbilities = abilities[channelKey];

    if (!channelAbilities) {
      return 0;
    }

    const value = channelAbilities[capability];
    if (typeof value === "number") {
      return value;
    }

    // If value is a string, try to extract version number
    if (typeof value === "string") {
      const numValue = Number(value);
      return Number.isNaN(numValue) ? 0 : numValue;
    }

    return 0;
  }

  /**
   * Get device support info via Baichuan.
   * cmd_id: 199 (MSG_ID_SUPPORT from neolink)
   *
   * Returns host-level support info including ptzMode and per-channel flags (battery, ledCtrl, etc).
   */
  async getSupportInfo(): Promise<SupportInfo | undefined> {
    const xml = await this.sendXml({ cmdId: BC_CMD_ID_SUPPORT });
    return parseSupportXml(xml);
  }

  /**
   * Compute explicit device capabilities (hasZoom/hasPan/hasTilt/hasBattery/...) for a specific channel.
   *
   * This method centralizes capability parsing in the library.
   */
  async getDeviceCapabilities(
    channel?: number,
    options?: {
      /**
       * Enable best-effort probing that may generate additional requests.
       * Defaults to true.
       */
      probe?: boolean;
      /** Enable/disable siren probing (cmd 152/153). Defaults to true. */
      probeSiren?: boolean;
      /** Enable/disable floodlight probing (cmd 289). Defaults to true. */
      probeFloodlight?: boolean;
    },
  ): Promise<DeviceCapabilitiesResult> {
    const ch = this.normalizeChannel(channel);
    const probeCfg = {
      probe: options?.probe ?? true,
      probeSiren: options?.probeSiren ?? true,
      probeFloodlight: options?.probeFloodlight ?? true,
    };

    const [abilitiesResult, supportResult] = await Promise.allSettled([
      this.getAbilityInfo() as Promise<DeviceAbilities>,
      this.getSupportInfo(),
    ]);

    const abilities = abilitiesResult.status === "fulfilled" ? abilitiesResult.value : undefined;
    const support = supportResult.status === "fulfilled" ? supportResult.value : undefined;

    const computeArgs: { channel: number; abilities?: DeviceAbilities; support?: SupportInfo } = { channel: ch };
    if (abilities) computeArgs.abilities = abilities;
    if (support) computeArgs.support = support;
    const capabilities = computeDeviceCapabilities(computeArgs);

    const flat = flattenAbilitiesForChannel(abilities, ch);

    const truthy = (v: unknown): boolean => {
      if (typeof v === "number") return v > 0;
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n > 0;
        return v.length > 0 && v !== "0";
      }
      return Boolean(v);
    };

    const features: DeviceSupportFlags | undefined = support
      ? {
        rtsp: truthy((support as any).rtsp),
        onvif: truthy((support as any).onvif),
        wifi: truthy((support as any).wifi),
        record: truthy((support as any).record),
        ftp: truthy((support as any).ftp),
        email: truthy((support as any).email),
        pushAlarm: truthy((support as any).pushAlarm),
        audioTalk: truthy((support as any).audioTalk),
      }
      : undefined;

    // Best-effort siren probe.
    // Some devices support audio alarm but do not advertise it via AbilityInfo/Support.
    // We try a harmless request first, then fall back to sending "off".
    if (probeCfg.probe && probeCfg.probeSiren && !capabilities.hasSiren) {
      const tryGet = async (): Promise<boolean> => {
        try {
          await this.sendXml({
            cmdId: BC_CMD_ID_GET_AUDIO_ALARM,
            channel: ch,
            timeoutMs: 1000,
          });
          return true;
        } catch {
          return false;
        }
      };

      const tryOff = async (): Promise<boolean> => {
        try {
          const channelId = ch + 1;
          const payloadXml = buildSirenManualXml(channelId, 0);
          await this.sendXml({
            cmdId: BC_CMD_ID_AUDIO_ALARM_PLAY,
            channel: ch,
            payloadXml,
            timeoutMs: 1000,
          });
          return true;
        } catch {
          return false;
        }
      };

      const ok = (await tryGet()) || (await tryOff());
      if (ok) {
        capabilities.hasSiren = true;
      }
    }

    // Best-effort floodlight probe.
    // Many firmwares expose only `ledState_rw` (status LED) in AbilityInfo, even when a real floodlight
    // exists and is controllable via Baichuan. The most reliable signal is whether cmd 289 works.
    if (probeCfg.probe && probeCfg.probeFloodlight && !capabilities.hasFloodlight) {
      const channelSupportItems = (support?.items ?? []).filter((i) => i.chnID === ch || i.chnID === ch + 1);

      const parseLightType = (item: any): number | undefined => {
        const v = item?.lightType;
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
      };

      const lightTypes = channelSupportItems
        .map((i) => parseLightType(i as any))
        .filter((v): v is number => Number.isFinite(v));

      // If firmware explicitly says there is no white LED/floodlight, do not probe.
      // This avoids false positives where cmd289 returns a FloodlightTask-like XML but the device
      // only has IR illumination / status LEDs.
      if (lightTypes.some((v) => v === 0)) {
        // leave as false
      } else if (lightTypes.some((v) => v > 0)) {
        capabilities.hasFloodlight = true;
      } else {
        // No explicit lightType. Probe cmd 289.
        try {
          const xml = await this.sendXml({
            cmdId: BC_CMD_ID_GET_WHITE_LED,
            channel: ch,
            timeoutMs: 1000,
          });

          // Only treat this as floodlight support if the payload clearly looks like floodlight.
          if (/(<FloodlightTask\b|<FloodlightManual\b|<FloodlightStatusList\b|<WhiteLed\b)/i.test(xml)) {
            capabilities.hasFloodlight = true;
          }
        } catch {
          // noop
        }
      }
    }

    // Object-detection capabilities.
    // Always read cmd 299 (AiCfg) and use <detectType> as the single source of truth.
    // This avoids inference/probing variability across firmwares.
    let objects: string[] | undefined;
    try {
      const xml = await this.sendXml({ cmdId: 299, channel: ch, timeoutMs: 1500 });
      const detectTypeRaw = (getXmlText(xml, "detectType") ?? "").trim();
      if (detectTypeRaw) {
        const list = detectTypeRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length > 0) objects = list;
      }
    } catch {
      // noop
    }

    let presets: PtzPreset[] | undefined;
    if (capabilities.hasPresets) {
      const presetsResult = await Promise.allSettled([this.getPtzPresets(ch)]);
      const r0 = presetsResult[0];
      if (r0?.status === "fulfilled") {
        presets = r0.value;
        capabilities.hasPresets = presets.length > 0;
      }
    }

    const debug: import("./types").DeviceCapabilitiesDebugInfo = {
      channel: ch,
      channelId1Based: ch + 1,
      transport: this.client.getTransport(),
      encryptionKind: this.client.enc.kind,
      loggedIn: this.client.loggedIn,
      subscribed: this.client.subscribed,
      abilitiesAvailable: Boolean(abilities),
      supportAvailable: Boolean(support),
    };

    if (flat) debug.abilityMergedKeyCount = Object.keys(flat).length;
    if (support?.items) debug.supportItemCount = support.items.length;

    const result: DeviceCapabilitiesResult = { capabilities, debug };
    if (abilities) result.abilities = abilities;
    if (support) result.support = support;
    if (presets) result.presets = presets;
    if (objects) result.objects = objects;
    if (features) result.features = features;
    return result;
  }

  /**
   * Create an RTSP server for a video stream.
   * Automatically detects video codec (H.264 or H.265) and configures ffmpeg accordingly.
   * 
   * @param channel - Channel number (0-based)
   * @param profile - Stream profile ("main", "sub", or "ext")
   * @param options - RTSP server options (port, path, etc.)
   * @returns RTSP server instance
   * 
   * @example
   * ```typescript
   * const rtspServer = await api.createRtspStream(0, "main", { listenPort: 8554 });
   * const rtspUrl = rtspServer.getRtspUrl();
   * console.log(`RTSP stream available at: ${rtspUrl}`);
   * // Use ffmpeg or VLC to connect: ffmpeg -i ${rtspUrl} output.mp4
   * ```
   */
  async createRtspStream(
    profile: StreamProfile,
    options?: {
      listenHost?: string; // Host to listen on (default: "127.0.0.1")
      listenPort?: number; // Port to listen on (default: 8554)
      path?: string; // RTSP path (e.g. "/main" or "/sub")
    }
  ): Promise<BaichuanRtspServer>;
  async createRtspStream(
    channel: number,
    profile: StreamProfile,
    options?: {
      listenHost?: string; // Host to listen on (default: "127.0.0.1")
      listenPort?: number; // Port to listen on (default: 8554)
      path?: string; // RTSP path (e.g. "/main" or "/sub")
    }
  ): Promise<BaichuanRtspServer>;
  async createRtspStream(
    channelOrProfile: number | StreamProfile,
    profileOrOptions?:
      | StreamProfile
      | {
        listenHost?: string;
        listenPort?: number;
        path?: string;
      },
    optionsMaybe?: {
      listenHost?: string;
      listenPort?: number;
      path?: string;
    }
  ): Promise<BaichuanRtspServer> {
    const ch = typeof channelOrProfile === "number" ? this.normalizeChannel(channelOrProfile) : 0;
    const profile = typeof channelOrProfile === "number" ? (profileOrOptions as StreamProfile) : channelOrProfile;
    const options = typeof channelOrProfile === "number" ? optionsMaybe : (profileOrOptions as typeof optionsMaybe);
    // Get stream metadata to determine codec
    let videoCodec: string | undefined;
    try {
      const metadata = await this.getStreamMetadata(ch);
      if (Array.isArray(metadata)) {
        const stream = metadata.find((s) => s.profile === profile);
        if (stream?.videoEncType) {
          videoCodec = stream.videoEncType;
        }
      } else if (metadata && typeof metadata === "object" && "streams" in metadata) {
        const streams = (metadata as any).streams;
        if (Array.isArray(streams)) {
          const stream = streams.find((s: any) => s?.profile === profile);
          if (stream?.videoEncType) {
            videoCodec = stream.videoEncType;
          }
        }
      }
    } catch (error) {
      // If metadata fetch fails, codec will be auto-detected from stream
      this.logger.warn(`[ReolinkBaichuanApi] Could not fetch stream metadata, will auto-detect codec: ${error instanceof Error ? error.message : error}`);
    }

    const rtspOptions: BaichuanRtspServerOptions = {
      api: this,
      channel: ch,
      profile,
      ...(options?.listenHost !== undefined ? { listenHost: options.listenHost } : {}),
      ...(options?.listenPort !== undefined ? { listenPort: options.listenPort } : {}),
      ...(options?.path !== undefined ? { path: options.path } : {}),
      logger: this.logger,
    };

    const server = new BaichuanRtspServer(rtspOptions);
    await server.start();

    // Track the server for cleanup
    this.rtspServers.add(server);

    // Remove from tracking when server is stopped
    server.once("close", () => {
      this.rtspServers.delete(server);
    });

    return server;
  }
}

