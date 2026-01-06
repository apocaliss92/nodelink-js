import { ReolinkHttpClient, type ReolinkHttpClientOptions } from "../http/ReolinkHttpClient";
import type { ReolinkCmdRequest, ReolinkCmdResponse } from "../http/types";
import type { ReolinkDeviceInfo, ReolinkDeviceInfoTag } from "../types";
import type { Logger } from "../../debug/DebugConfig";
import { collectNvrDiagnostics, printNvrDiagnostics } from "../../debug/DiagnosticsTools";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type ReolinkCmdResponseExt<TValue = JsonValue> = ReolinkCmdResponse<TValue> & {
  /** Some CGI commands (notably GetEnc) return additional metadata fields. */
  initial?: JsonValue;
  range?: JsonValue;
};

export type CgiChannelStatusEntry = {
  channel: number;
  name?: string;
  online?: number;
  sleep?: number;
  uid?: string;
  typeInfo?: string;
};

export type CgiGetChannelstatusValue = {
  status?: CgiChannelStatusEntry[];
};

export type CgiChnTypeInfoValue = {
  boardInfo?: string;
  firmVer?: string;
  pakSuffix?: string;
  typeInfo?: string;
};

export type CgiDetectionState = {
  alarm_state: number;
  support: number;
};

export type CgiAiKey = "dog_cat" | "face" | "other" | "package" | "people" | "vehicle";

export type CgiAiStateValue = Partial<Record<CgiAiKey, CgiDetectionState>> & {
  channel: number;
};

export type CgiEncStream = {
  bitRate: number;
  frameRate: number;
  gop: number;
  height: number;
  profile: string;
  size: string;
  vType: string;
  width: number;
};

export type CgiEnc = {
  audio: number;
  channel: number;
  mainStream: CgiEncStream;
  subStream: CgiEncStream;
};

export type CgiEncValue = {
  Enc: CgiEnc;
};

export type CgiGetChannelstatusResponse = ReolinkCmdResponseExt<CgiGetChannelstatusValue> & {
  cmd: "GetChannelstatus";
};

export type CgiGetChnTypeInfoResponse = ReolinkCmdResponseExt<CgiChnTypeInfoValue> & {
  cmd: "GetChnTypeInfo";
};

export type CgiGetAiStateResponse = ReolinkCmdResponseExt<CgiAiStateValue> & {
  cmd: "GetAiState";
};

export type CgiGetEncResponse = ReolinkCmdResponseExt<CgiEncValue> & {
  cmd: "GetEnc";
  initial?: CgiEncValue;
  range?: JsonValue;
};

export type CgiAbilityLeaf = {
  permit: number;
  ver: number;
};

export type CgiAbilityChn = {
  aiTrack?: CgiAbilityLeaf;
  aiTrackDogCat?: CgiAbilityLeaf;
  alarmAudio?: CgiAbilityLeaf;
  alarmIoIn?: CgiAbilityLeaf;
  alarmIoOut?: CgiAbilityLeaf;
  alarmMd?: CgiAbilityLeaf;
  alarmRf?: CgiAbilityLeaf;
  batAnalysis?: CgiAbilityLeaf;
  battery?: CgiAbilityLeaf;
  cameraMode?: CgiAbilityLeaf;
  channelType?: CgiAbilityLeaf;
  customAudio?: CgiAbilityLeaf;
  disableAutoFocus?: CgiAbilityLeaf;
  enc?: CgiAbilityLeaf;
  floodLight?: CgiAbilityLeaf;
  ftp?: CgiAbilityLeaf;
  image?: CgiAbilityLeaf;
  indicatorLight?: CgiAbilityLeaf;
  isp?: CgiAbilityLeaf;
  isp3Dnr?: CgiAbilityLeaf;
  ispAntiFlick?: CgiAbilityLeaf;
  ispBackLight?: CgiAbilityLeaf;
  ispBright?: CgiAbilityLeaf;
  ispContrast?: CgiAbilityLeaf;
  ispDayNight?: CgiAbilityLeaf;
  ispExposureMode?: CgiAbilityLeaf;
  ispFlip?: CgiAbilityLeaf;
  ispHue?: CgiAbilityLeaf;
  ispMirror?: CgiAbilityLeaf;
  ispSatruation?: CgiAbilityLeaf;
  ispSharpen?: CgiAbilityLeaf;
  ispWhiteBalance?: CgiAbilityLeaf;
  ledControl?: CgiAbilityLeaf;
  lightType?: CgiAbilityLeaf;
  live?: CgiAbilityLeaf;
  mainEncType?: CgiAbilityLeaf;
  mask?: CgiAbilityLeaf;
  mdTriggerAudio?: CgiAbilityLeaf;
  mdTriggerRecord?: CgiAbilityLeaf;
  mdWithPir?: CgiAbilityLeaf;
  osd?: CgiAbilityLeaf;
  powerLed?: CgiAbilityLeaf;
  ptzCtrl?: CgiAbilityLeaf;
  ptzDirection?: CgiAbilityLeaf;
  ptzPatrol?: CgiAbilityLeaf;
  ptzPreset?: CgiAbilityLeaf;
  ptzTattern?: CgiAbilityLeaf;
  ptzType?: CgiAbilityLeaf;
  recCfg?: CgiAbilityLeaf;
  recDownload?: CgiAbilityLeaf;
  recReplay?: CgiAbilityLeaf;
  recSchedule?: CgiAbilityLeaf;
  shelterCfg?: CgiAbilityLeaf;
  snap?: CgiAbilityLeaf;
  supportAIDenoise?: CgiAbilityLeaf;
  supportAITrackLimit?: CgiAbilityLeaf;
  supportAITrackSchedule?: CgiAbilityLeaf;
  supportAfAlgorithmSwitch?: CgiAbilityLeaf;
  supportAi?: CgiAbilityLeaf;
  supportAiAnimal?: CgiAbilityLeaf;
  supportAiDetectConfig?: CgiAbilityLeaf;
  supportAiDogCat?: CgiAbilityLeaf;
  supportAiFace?: CgiAbilityLeaf;
  supportAiPackage?: CgiAbilityLeaf;
  supportAiPeople?: CgiAbilityLeaf;
  supportAiSensitivity?: CgiAbilityLeaf;
  supportAiStayTime?: CgiAbilityLeaf;
  supportAiTargetSize?: CgiAbilityLeaf;
  supportAiTrackClassify?: CgiAbilityLeaf;
  supportAiVehicle?: CgiAbilityLeaf;
  supportAllColors?: CgiAbilityLeaf;
  supportAoAdjust?: CgiAbilityLeaf;
  supportAudioAlarm?: CgiAbilityLeaf;
  supportAudioFileList?: CgiAbilityLeaf;
  supportAutoPt?: CgiAbilityLeaf;
  supportAutoReply?: CgiAbilityLeaf;
  supportAutoTrackStream?: CgiAbilityLeaf;
  supportBinoStitch?: CgiAbilityLeaf;
  supportDigitalZoom?: CgiAbilityLeaf;
  supportDingDongCtrl?: CgiAbilityLeaf;
  supportDoorbellLight?: CgiAbilityLeaf;
  supportDoorbellLightKeepOff?: CgiAbilityLeaf;
  supportEncoderSelect?: CgiAbilityLeaf;
  supportFLBrightness?: CgiAbilityLeaf;
  supportFLIntelligent?: CgiAbilityLeaf;
  supportFLKeepOn?: CgiAbilityLeaf;
  supportFLSchedule?: CgiAbilityLeaf;
  supportFLswitch?: CgiAbilityLeaf;
  supportFishEyeCfg?: CgiAbilityLeaf;
  supportFocus?: CgiAbilityLeaf;
  supportGop?: CgiAbilityLeaf;
  supportGuardPointImage?: CgiAbilityLeaf;
  supportImportExportImage?: CgiAbilityLeaf;
  supportIspBinningModeCfg?: CgiAbilityLeaf;
  supportLightAutoBrightness?: CgiAbilityLeaf;
  supportMd?: CgiAbilityLeaf;
  supportPt?: CgiAbilityLeaf;
  supportPtz3DLocation?: CgiAbilityLeaf;
  supportPtzCalibration?: CgiAbilityLeaf;
  supportPtzPresetImage?: CgiAbilityLeaf;
  supportPtzSpeed?: CgiAbilityLeaf;
  supportQuickReplyPlay?: CgiAbilityLeaf;
  supportThresholdAdjust?: CgiAbilityLeaf;
  supportVisitorLoudspeaker?: CgiAbilityLeaf;
  supportWLLightAlarm?: CgiAbilityLeaf;
  supportWebhook?: CgiAbilityLeaf;
  supportWhiteDark?: CgiAbilityLeaf;
  supportWiFi?: CgiAbilityLeaf;
  supportWiFiSdb?: CgiAbilityLeaf;
  supportZoom?: CgiAbilityLeaf;
  supportZoomAndFocusSliderCfg?: CgiAbilityLeaf;
  talk?: CgiAbilityLeaf;
  videoClip?: CgiAbilityLeaf;
  waterMark?: CgiAbilityLeaf;
  white_balance?: CgiAbilityLeaf;

  [key: string]: CgiAbilityLeaf | undefined;
};

export type CgiAbility = {
  Ability: ({ abilityChn?: CgiAbilityChn[] } & Record<string, JsonValue>);
};

export type CgiGetAbilityValue = CgiAbility;

export type CgiGetAbilityResponse = ReolinkCmdResponseExt<CgiGetAbilityValue> & {
  cmd: "GetAbility";
};

export type CgiDevInfo = {
  B485?: number;
  IOInputNum?: number;
  IOOutputNum?: number;
  audioNum?: number;
  buildDay?: string;
  cfgVer?: string;
  channelNum?: number;
  detail?: string;
  diskNum?: number;
  exactType?: string;
  firmVer?: string;
  frameworkVer?: number;
  hardVer?: string;
  model?: string;
  name?: string;
  pakSuffix?: string;
  serial?: string;
  type?: string;
  wifi?: number;
};

export type CgiGetDevInfoValue = {
  DevInfo: CgiDevInfo;
};

export type CgiGetDevInfoResponse = ReolinkCmdResponseExt<CgiGetDevInfoValue> & {
  cmd: "GetDevInfo";
};

export type CgiOsd = {
  channel: number;
  osdChannel?: number;
  osdTime?: number;
} & Record<string, JsonValue>;

export type CgiGetOsdValue = {
  Osd?: CgiOsd;
} & Record<string, JsonValue>;

export type CgiSetOsdParam = {
  Osd: {
    channel: number;
    osdChannel?: number;
    osdTime?: number;
  };
};

export type CgiWhiteLed = {
  channel: number;
  state?: number;
  bright?: number;
} & Record<string, JsonValue>;

export type CgiSetWhiteLedParam = {
  WhiteLed: CgiWhiteLed;
};

export type CgiPirInfo = {
  channel: number;
  enable: number;
} & Record<string, JsonValue>;

export type CgiSetPirInfoParam = {
  pirInfo: CgiPirInfo;
};

export type CgiPtzPreset = {
  enable?: number;
} & Record<string, JsonValue>;

export type CgiAudioAlarmPlayParam =
  | ({ channel: number } & { alarm_mode: "times"; times: number })
  | ({ channel: number } & { alarm_mode: "manul"; manual_switch: number });

export type CgiNetPort = Record<string, JsonValue>;

export type CgiBattery = {
  batteryPercent?: number;
} & Record<string, JsonValue>;

export type CgiDeviceInfoEntries = [
  CgiGetChnTypeInfoResponse | undefined,
  CgiGetAiStateResponse | undefined,
  CgiGetEncResponse | undefined,
];

export type DeviceInputData = {
  hasBattery: boolean;
  hasPirEvents: boolean;
  hasFloodlight: boolean;
  hasPtz: boolean;
  sleeping: boolean;
};

export type EventsResponse = {
  motion: boolean;
  objects: string[];
  entries: Array<ReolinkCmdResponseExt<JsonValue> | undefined>;
};

export type DeviceInfoResponse = {
  channelStatus?: CgiChannelStatusEntry;
  abilities?: CgiAbilityChn;
  ai?: CgiAiStateValue;
  channelInfo?: CgiChnTypeInfoValue;
  enc?: CgiEncValue;
  entries: CgiDeviceInfoEntries;
};

export type BatteryInfoResponse = {
  batteryLevel: number;
  sleeping: boolean;
  entries: [CgiBattery | undefined, CgiChannelStatusEntry | undefined];
};

export type DeviceStatusResponse = {
  floodlightEnabled?: boolean;
  pirEnabled?: boolean;
  ptzPresets?: CgiPtzPreset[];
  osd?: ReolinkCmdResponseExt<CgiGetOsdValue>;
  entries: Array<ReolinkCmdResponseExt<JsonValue>>;
};

export class ReolinkCgiApi {
  readonly client: ReolinkHttpClient;

  constructor(opts: ReolinkHttpClientOptions) {
    this.client = new ReolinkHttpClient(opts);
  }

  async login(): Promise<void> {
    await this.client.login();
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  async call<TValue = JsonValue, TParam = JsonValue>(cmd: string, param?: TParam, action = 0): Promise<ReolinkCmdResponse<TValue>[]> {
    // Avoid `param: undefined` with exactOptionalPropertyTypes
    if (param === undefined) return await this.client.call<TValue, TParam>(cmd, { action });
    return await this.client.call<TValue, TParam>(cmd, { action, param });
  }

  async callMany<TValue = JsonValue>(cmds: ReolinkCmdRequest[]): Promise<ReolinkCmdResponse<TValue>[]> {
    return await this.client.callMany<TValue>(cmds);
  }

  // Common wrappers
  async GetDevInfo(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiGetDevInfoValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetDevInfo", param);
  }

  /**
   * CGI equivalent of Baichuan `getInfo()`.
   *
   * Uses `GetDevInfo` and returns a minimal normalized map compatible with the Baichuan helper:
   * - type
   * - hardwareVersion
   * - firmwareVersion
   * - itemNo
   * - serialNumber
   * - name
   */
  async getInfo(
    channel?: number,
    options?: {
      /** List of normalized fields to return. Defaults to the canonical minimal set used by Baichuan getInfo(). */
      tags?: ReolinkDeviceInfoTag[];
    },
  ): Promise<Partial<ReolinkDeviceInfo>> {
    const rsp = await this.GetDevInfo(channel);
    const devInfo = (rsp as any)?.[0]?.value?.DevInfo as CgiDevInfo | undefined;

    const normalized: Partial<ReolinkDeviceInfo> = {};
    const type = (devInfo?.type ?? devInfo?.model ?? devInfo?.exactType) as string | undefined;
    const itemNo = (devInfo?.exactType ?? devInfo?.model ?? devInfo?.detail) as string | undefined;
    if (typeof type === "string") normalized.type = type;
    if (typeof devInfo?.hardVer === "string") normalized.hardwareVersion = devInfo.hardVer;
    if (typeof devInfo?.firmVer === "string") normalized.firmwareVersion = devInfo.firmVer;
    if (typeof itemNo === "string") normalized.itemNo = itemNo;
    if (typeof devInfo?.serial === "string") normalized.serialNumber = devInfo.serial;
    if (typeof devInfo?.name === "string") normalized.name = devInfo.name;

    const tags: ReolinkDeviceInfoTag[] = options?.tags?.length
      ? options.tags
      : (["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"] satisfies ReolinkDeviceInfoTag[]);

    const out: Partial<ReolinkDeviceInfo> = {};
    for (const t of tags) {
      const v = normalized[t];
      if (typeof v === "string") out[t] = v;
    }
    return out;
  }

  async GetChnTypeInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetChnTypeInfo", param);
  }

  async GetChannelstatus(): Promise<Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>> {
    return await this.call("GetChannelstatus", undefined, 0);
  }

  async GetLocalLink(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetLocalLink", param);
  }

  async GetWifiSignal(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetWifiSignal", param);
  }

  async GetOsd(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiGetOsdValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetOsd", param, 1);
  }

  async SetOsd(osd: CgiSetOsdParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetOsd", osd, 0);
  }

  async GetEnc(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiEncValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetEnc", param, 1);
  }

  async GetAiState(channel?: number): Promise<Array<ReolinkCmdResponseExt<CgiAiStateValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetAiState", param, 0);
  }

  async GetMdState(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetMdState", param, 0);
  }

  async GetEvents(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetEvents", param, 0);
  }

  async GetBatteryInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetBatteryInfo", param, 0);
  }

  async GetWhiteLed(channel?: number): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetWhiteLed", param, 0);
  }

  async SetWhiteLed(whiteLed: CgiSetWhiteLedParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetWhiteLed", whiteLed, 0);
  }

  async GetPirInfo(channel?: number): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetPirInfo", param, 0);
  }

  async SetPirInfo(pirInfo: CgiSetPirInfoParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetPirInfo", pirInfo, 0);
  }

  async GetPtzPreset(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetPtzPreset", param, 1);
  }

  async GetAudioAlarmV20(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetAudioAlarmV20", param, 0);
  }

  async AudioAlarmPlay(params: CgiAudioAlarmPlayParam): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("AudioAlarmPlay", params, 0);
  }

  async GetNetPort(): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("GetNetPort", {});
  }

  async SetNetPort(netPort: CgiNetPort): Promise<Array<ReolinkCmdResponseExt<JsonValue>>> {
    return await this.call("SetNetPort", { NetPort: netPort });
  }

  async Reboot(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("Reboot", param);
  }

  async GetAbility(): Promise<Array<ReolinkCmdResponseExt<CgiAbility>>> {
    const username = this.client.getUsername();
    return await this.call("GetAbility", {
      User: {
        userName: username,
      },
    });
  }

  // --------------------
  // High-level helpers (batch-oriented)
  // --------------------

  /** Returns the list of channels that have a non-empty UID (typically the connected cameras on NVR/Home Hub). */
  async getChannels(options?: { useChannelNumFallback?: boolean }): Promise<{ channels: number[]; channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>> }> {
    const channelsResponse = await this.GetChannelstatus();
    const status = channelsResponse?.[0]?.value?.status;
    let channels = (status ?? [])
      .filter((s) => !!s?.uid)
      .map((s) => Number(s?.channel))
      .filter((n) => Number.isFinite(n));
    
    // Fallback for multi-focal cameras: if no channels found and fallback is enabled, use channelNum from GetDevInfo
    if (channels.length === 0 && options?.useChannelNumFallback) {
      try {
        const devInfoRsp = await this.GetDevInfo();
        const devInfo = (devInfoRsp as any)?.[0]?.value?.DevInfo as CgiDevInfo | undefined;
        const channelNum = devInfo?.channelNum;
        if (channelNum != null && channelNum > 0) {
          channels = Array.from({ length: channelNum }, (_, i) => i);
        }
      } catch (error) {
        // Ignore errors when trying to get channelNum fallback
      }
    }
    
    return { channels, channelsResponse };
  }

  async getNvrInfo(): Promise<{ abilities: CgiAbility | undefined; nvrData: CgiGetDevInfoValue | undefined; devInfo: CgiDevInfo | undefined; response: Array<ReolinkCmdResponseExt<JsonValue>> }> {
    const username = this.client.getUsername();
    const body: ReolinkCmdRequest[] = [
      { cmd: "GetAbility", action: 0, param: { User: { userName: username } } },
      { cmd: "GetDevInfo", action: 0, param: {} },
    ];

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;
    const abilities = response.find((item: any) => item?.cmd === "GetAbility")?.value as CgiAbility | undefined;
    const nvrData = response.find((item: any) => item?.cmd === "GetDevInfo")?.value as CgiGetDevInfoValue | undefined;
    const devInfo = nvrData?.DevInfo;

    return { abilities, nvrData, devInfo, response };
  }

  async getDevicesInfo(options?: { useChannelNumFallback?: boolean }): Promise<{
    devicesData: Record<number, DeviceInfoResponse>;
    response: Array<ReolinkCmdResponseExt<JsonValue>>;
    channels: number[];
    channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>;
    requestBody: ReolinkCmdRequest[];
  }> {
    const { channels, channelsResponse } = await this.getChannels(options);

    const username = this.client.getUsername();

    const body: ReolinkCmdRequest[] = [];

    body.push({ cmd: "GetAbility", action: 0, param: { User: { userName: username } } });

    for (const channel of channels) {
      body.push(
        { cmd: "GetChnTypeInfo", action: 0, param: { channel } },
        { cmd: "GetAiState", action: 0, param: { channel } },
        { cmd: "GetEnc", action: 1, param: { channel } },
      );
    }

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;

    const abilities = (response[0] as CgiGetAbilityResponse | undefined)?.value;
    const abilitiesChn = abilities?.Ability?.abilityChn;

    const ret: Record<number, DeviceInfoResponse> = {};
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i]!;
      const base = 1 + i * 3;
      const chnInfoItem = response[base] as CgiGetChnTypeInfoResponse | undefined;
      const aiItem = response[base + 1] as CgiGetAiStateResponse | undefined;
      const encItem = response[base + 2] as CgiGetEncResponse | undefined;

      const channelStatus = channelsResponse?.[0]?.value?.status?.find((item) => item?.channel === channel);

      const device: DeviceInfoResponse = {
        entries: [chnInfoItem, aiItem, encItem],
      };
      if (channelStatus) device.channelStatus = channelStatus;
      const perChannelAbilities = abilitiesChn?.[channel];
      if (perChannelAbilities) device.abilities = perChannelAbilities;

      if (!(chnInfoItem as any)?.error) device.channelInfo = (chnInfoItem as any)?.value as CgiChnTypeInfoValue;
      if (!(aiItem as any)?.error) device.ai = (aiItem as any)?.value as CgiAiStateValue;
      if (!(encItem as any)?.error) device.enc = (encItem as any)?.value as CgiEncValue;

      ret[channel] = device;
    }

    return { devicesData: ret, response, channels, channelsResponse, requestBody: body };
  }

  async getAllChannelsEvents(options?: { useChannelNumFallback?: boolean }): Promise<{
    parsed: Record<number, EventsResponse>;
    response: ReolinkCmdResponse[];
    channels: number[];
    channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>;
    requestBody: ReolinkCmdRequest[];
  }> {
    const { channels, channelsResponse } = await this.getChannels(options);

    // Always call all relevant endpoints per channel and merge.
    const body: ReolinkCmdRequest[] = [];
    const index: Record<number, { events?: number; motion?: number; ai?: number }> = {};

    for (const channel of channels) {
      index[channel] = {};
      body.push({ cmd: "GetEvents", action: 0, param: { channel } });
      index[channel].events = body.length - 1;
      body.push({ cmd: "GetMdState", action: 0, param: { channel } });
      index[channel].motion = body.length - 1;
      body.push({ cmd: "GetAiState", action: 0, param: { channel } });
      index[channel].ai = body.length - 1;
    }

    const response = await this.callMany(body);

    const processDetections = (aiResponse: any): string[] => {
      const classes: string[] = [];
      for (const key of Object.keys(aiResponse ?? {})) {
        if (key === "channel") continue;
        const alarmState = aiResponse?.[key]?.alarm_state;
        if (alarmState) classes.push(key);
      }
      return classes;
    };

    const parsed: Record<number, EventsResponse> = {};
    for (const channel of channels) {
      const { events, motion, ai } = index[channel] ?? {};
      const eventsEntry = events != null ? response[events] : undefined;
      const motionEntry = motion != null ? response[motion] : undefined;
      const aiEntry = ai != null ? response[ai] : undefined;

      const classes = new Set<string>();
      for (const c of processDetections((aiEntry as any)?.value)) classes.add(c);
      for (const c of processDetections((eventsEntry as any)?.value?.ai ?? (eventsEntry as any)?.value)) classes.add(c);

      const list = Array.from(classes);
      const objects = list.filter((cl) => cl !== "other");
      const hasMotion = !!(motionEntry as any)?.value?.state || list.length > 0;

      parsed[channel] = {
        motion: hasMotion,
        objects,
        entries: [eventsEntry as any, motionEntry as any, aiEntry as any],
      };
    }

    return { parsed, response, channels, channelsResponse, requestBody: body };
  }

  async getAllChannelsBatteryInfo(options?: { useChannelNumFallback?: boolean }): Promise<{
    batteryInfoData: Record<number, BatteryInfoResponse>;
    response: Array<ReolinkCmdResponseExt<JsonValue>>;
    channels: number[];
    channelsResponse: Array<ReolinkCmdResponseExt<CgiGetChannelstatusValue>>;
    requestBody: ReolinkCmdRequest[];
  }> {
    const { channels, channelsResponse } = await this.getChannels(options);

    // Always call battery info for every channel and merge with Channelstatus.
    const body: ReolinkCmdRequest[] = [{ cmd: "GetChannelstatus" }];
    const index: Record<number, number> = {};
    for (const channel of channels) {
      body.push({ cmd: "GetBatteryInfo", action: 0, param: { channel } });
      index[channel] = body.length - 1;
    }

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;
    const channelStatusData = response[0];

    const batteryInfoData: Record<number, BatteryInfoResponse> = {};
    for (const channel of channels) {
      const batteryInfoEntry = ((response[index[channel]!] as any)?.value?.Battery ?? undefined) as CgiBattery | undefined;
      const channelStatusEntry = (channelStatusData as any)?.value?.status?.find((elem: any) => elem?.channel === channel) as CgiChannelStatusEntry | undefined;
      batteryInfoData[channel] = {
        entries: [batteryInfoEntry, channelStatusEntry],
        batteryLevel: Number(batteryInfoEntry?.batteryPercent ?? 0),
        sleeping: channelStatusEntry?.sleep === 1,
      };
    }

    return { batteryInfoData, response, channels, channelsResponse, requestBody: body };
  }

  async getStatusInfo(channelsMap: Map<number, DeviceInputData>): Promise<{
    deviceStatusData: Record<number, DeviceStatusResponse>;
    response: Array<ReolinkCmdResponseExt<JsonValue>>;
  }> {
    const body: ReolinkCmdRequest[] = [];
    const index: Record<number, { osd?: number; floodlight?: number; pir?: number; presets?: number }> = {};

    for (const [channel, info] of channelsMap.entries()) {
      index[channel] = {};
      if (info.sleeping) continue;

      body.push({ cmd: "GetOsd", action: 1, param: { channel } });
      index[channel].osd = body.length - 1;

      if (info.hasFloodlight) {
        body.push({ cmd: "GetWhiteLed", action: 0, param: { channel } });
        index[channel].floodlight = body.length - 1;
      }

      if (info.hasPirEvents) {
        body.push({ cmd: "GetPirInfo", action: 0, param: { channel } });
        index[channel].pir = body.length - 1;
      }

      if (info.hasPtz) {
        body.push({ cmd: "GetPtzPreset", action: 1, param: { channel } });
        index[channel].presets = body.length - 1;
      }
    }

    const response = (await this.callMany(body)) as Array<ReolinkCmdResponseExt<JsonValue>>;

    const deviceStatusData: Record<number, DeviceStatusResponse> = {};
    for (const [channel, info] of channelsMap.entries()) {
      const { osd, floodlight, pir, presets } = index[channel] ?? {};
      deviceStatusData[channel] = { entries: [] };

      if (osd != null) {
        const osdEntry = response[osd]!;
        deviceStatusData[channel].osd = osdEntry as ReolinkCmdResponseExt<CgiGetOsdValue>;
        deviceStatusData[channel].entries.push(osdEntry);
      }

      if (info.hasFloodlight && floodlight != null) {
        const floodlightEntry = response[floodlight]!;
        deviceStatusData[channel].floodlightEnabled = (floodlightEntry as any)?.value?.WhiteLed?.state === 1;
        deviceStatusData[channel].entries.push(floodlightEntry);
      }

      if (info.hasPirEvents && pir != null) {
        const pirEntry = response[pir]!;
        deviceStatusData[channel].pirEnabled = (pirEntry as any)?.value?.pirInfo?.enable === 1;
        deviceStatusData[channel].entries.push(pirEntry);
      }

      if (info.hasPtz && presets != null) {
        const ptzPresetsEntry = response[presets]!;
        const list = (ptzPresetsEntry as any)?.value?.PtzPreset;
        deviceStatusData[channel].ptzPresets = Array.isArray(list) ? (list.filter((p: any) => p?.enable === 1) as CgiPtzPreset[]) : [];
        deviceStatusData[channel].entries.push(ptzPresetsEntry);
      }
    }

    return { deviceStatusData, response };
  }

  /** Convenience wrapper returning raw OSD response for a channel. */
  async getOsd(channel: number): Promise<ReolinkCmdResponseExt<CgiGetOsdValue> | undefined> {
    const rsp = await this.GetOsd(channel);
    return rsp?.[0];
  }

  /** Set channel OSD. Accepts either a full `Osd` object or a minimal `{ Osd: ... }` payload. */
  async setOsd(channel: number, osd: any): Promise<void> {
    const valueOsd = osd?.value?.Osd ?? osd?.Osd;
    const osdChannel = valueOsd?.osdChannel ?? osd?.osdChannel;
    const osdTime = valueOsd?.osdTime ?? osd?.osdTime;

    const payload = {
      Osd: {
        channel,
        osdChannel,
        osdTime,
      },
    };

    await this.call("SetOsd", payload, 0);
  }

  async getEncoderConfiguration(channel: number): Promise<CgiEnc | undefined> {
    const rsp = await this.GetEnc(channel);
    return (rsp as any)?.[0]?.value?.Enc as CgiEnc | undefined;
  }

  /** CGI snapshot via `cmd=Snap` (binary JPEG). */
  async jpegSnapshot(channel: number, timeoutMs = 10_000): Promise<Buffer> {
    return await this.client.snap(channel, { timeoutMs });
  }

  async getSiren(channel: number): Promise<{ enabled: boolean }> {
    const rsp = await this.GetAudioAlarmV20(channel);
    return { enabled: (rsp as any)?.[0]?.value?.Audio?.enable === 1 };
  }

  async setSiren(channel: number, on: boolean, duration?: number): Promise<{ value: JsonValue | undefined; data: Array<ReolinkCmdResponseExt<JsonValue>> }> {
    const params: CgiAudioAlarmPlayParam = duration
      ? { channel, alarm_mode: "times", times: duration }
      : { channel, alarm_mode: "manul", manual_switch: on ? 1 : 0 };

    const rsp = await this.AudioAlarmPlay(params);
    return { value: (rsp as any)?.[0]?.value ?? (rsp as any)?.value, data: rsp };
  }

  async setWhiteLedState(channel: number, on?: boolean, brightness?: number): Promise<void> {
    const settings: any = { channel };
    if (on !== undefined) settings.state = on ? 1 : 0;
    if (brightness !== undefined) settings.bright = brightness;
    await this.SetWhiteLed({ WhiteLed: settings });
  }

  async getPirState(channel: number): Promise<{ enabled: boolean; state: CgiPirInfo | undefined }> {
    const rsp = await this.GetPirInfo(channel);
    const state = (rsp as any)?.[0]?.value?.pirInfo as CgiPirInfo | undefined;
    return { enabled: state?.enable === 1, state };
  }

  async setPirState(channel: number, on: boolean): Promise<void> {
    const current = await this.getPirState(channel);
    const newState = on ? 1 : 0;
    const currentEnable = (current?.state as any)?.enable;
    if (currentEnable === newState) return;

    const pirInfo = {
      ...(current?.state && typeof current.state === "object" ? current.state : {}),
      channel,
      enable: newState,
    };
    await this.SetPirInfo({ pirInfo });
  }

  async getLocalLink(channel: number): Promise<{ activeLink: string | undefined; wifiSignal: number | undefined; isWifi: boolean }> {
    const body: ReolinkCmdRequest[] = [
      { cmd: "GetLocalLink", action: 0, param: {} },
      { cmd: "GetWifiSignal", action: 0, param: { channel } },
    ];
    const rsp = await this.callMany(body);
    const activeLink = (rsp as any).find((e: any) => e?.cmd === "GetLocalLink")?.value?.LocalLink?.activeLink as string | undefined;
    const wifiSignal = (rsp as any).find((e: any) => e?.cmd === "GetWifiSignal")?.value?.wifiSignal as number | undefined;

    let isWifi = false;
    if (wifiSignal !== undefined) {
      isWifi = wifiSignal >= 0 && wifiSignal <= 4;
    }
    if (!isWifi && activeLink) {
      isWifi = activeLink !== "LAN";
    }

    return { activeLink, wifiSignal, isWifi };
  }

  /**
   * Comprehensive NVR/HUB diagnostics.
   * Collects and returns all available information about the NVR/HUB device and all its channels.
   * 
   * @param options - Configuration object with logger property for progress messages
   * @returns Complete diagnostics data including NVR info, channels, and per-channel details
   */
  async collectNvrDiagnostics(options: {
    logger: Logger;
  }): Promise<Record<string, unknown>> {
    return await collectNvrDiagnostics({
      cgi: this,
      logger: options.logger,
    });
  }

  /**
   * Print NVR/HUB diagnostics in a human-readable format.
   * 
   * @param diagnostics - Diagnostics data returned by collectNvrDiagnostics()
   * @param logger - Optional logger for output
   */
  printNvrDiagnostics(diagnostics: Record<string, unknown>, logger?: Logger): void {
    printNvrDiagnostics(diagnostics, logger);
  }
}

