import type {
  AbilityInfo,
  DeviceAbilities,
  DeviceCapabilities,
  SupportInfo,
  SupportItem,
} from "./types";

function toNumberOrUndefined(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isTruthyNumberLike(value: unknown): boolean {
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n > 0;
    return value.length > 0 && value !== "0";
  }
  return Boolean(value);
}

export function flattenAbilitiesForChannel(
  abilities: DeviceAbilities | undefined,
  channel: number,
): AbilityInfo | undefined {
  if (!abilities || typeof abilities !== "object") return undefined;

  // AbilityInfo channel ids are sometimes 0-based, but some firmwares use 1-based.
  const ch0 = (abilities as any)[channel] as AbilityInfo | undefined;
  const ch1 = (abilities as any)[channel + 1] as AbilityInfo | undefined;
  const host = (abilities as any).Host as AbilityInfo | undefined;

  const merged: AbilityInfo = {
    ...(host && typeof host === "object" ? host : {}),
    ...(ch0 && typeof ch0 === "object" ? ch0 : {}),
    ...(ch1 && typeof ch1 === "object" ? ch1 : {}),
  };

  return Object.keys(merged).length ? merged : undefined;
}

export function abilitiesHasAny(abilities: AbilityInfo | undefined, re: RegExp): boolean {
  if (!abilities) return false;
  for (const [key, value] of Object.entries(abilities)) {
    if (!re.test(key)) continue;
    if (isTruthyNumberLike(value)) return true;
  }
  return false;
}

export function parseSupportXml(xml: string): SupportInfo | undefined {
  if (!xml) return undefined;

  const match = xml.match(/<Support[^>]*>([\s\S]*?)<\/Support>/i);
  if (!match) return undefined;
  const supportXml = match[1] ?? "";

  const ptzMode = supportXml.match(/<ptzMode>([^<]*)<\/ptzMode>/i)?.[1];

  const topLevelInt = (tag: string): number | undefined => {
    const m = supportXml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, "i"));
    return toNumberOrUndefined(m?.[1]);
  };

  const topLevelString = (tag: string): string | undefined => {
    const m = supportXml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, "i"));
    return m?.[1];
  };

  const items: SupportItem[] = [];
  for (const itemMatch of supportXml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const itemXml = itemMatch[1] ?? "";
    const item: SupportItem = {
      chnID: toNumberOrUndefined(itemXml.match(/<chnID>([^<]*)<\/chnID>/i)?.[1]) ?? 0,
    };

    for (const tagMatch of itemXml.matchAll(/<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g)) {
      const tag = tagMatch[1];
      const value = tagMatch[2];
      if (!tag) continue;
      if (tag === "chnID") continue;
      const n = toNumberOrUndefined(value);
      (item as any)[tag] = n ?? value;
    }

    items.push(item);
  }

  const support: SupportInfo = { items };
  if (ptzMode !== undefined) support.ptzMode = ptzMode;

  const assignInt = (key: keyof SupportInfo, tag: string) => {
    const v = topLevelInt(tag);
    if (v !== undefined) (support as any)[key] = v;
  };
  assignInt("IOInputPortNum", "IOInputPortNum");
  assignInt("IOOutputPortNum", "IOOutputPortNum");
  assignInt("diskNum", "diskNum");
  assignInt("channelNum", "channelNum");
  assignInt("audioNum", "audioNum");
  assignInt("ptzCfg", "ptzCfg");
  assignInt("B485", "B485");
  assignInt("autoUpdate", "autoUpdate");
  assignInt("pushAlarm", "pushAlarm");
  assignInt("ftp", "ftp");
  assignInt("ftpTest", "ftpTest");
  assignInt("email", "email");
  assignInt("wifi", "wifi");
  assignInt("record", "record");
  assignInt("wifiTest", "wifiTest");
  assignInt("rtsp", "rtsp");
  assignInt("onvif", "onvif");
  assignInt("audioTalk", "audioTalk");

  const subVersion = topLevelString("subVersion");
  if (subVersion !== undefined) (support as any).subVersion = subVersion;

  return support;
}

function getSupportItemForChannel(support: SupportInfo | undefined, channel: number): SupportItem | undefined {
  if (!support?.items?.length) return undefined;
  // Most observed firmwares use 0-based chnID.
  return support.items.find((i) => i.chnID === channel) ?? support.items.find((i) => i.chnID === channel + 1);
}

export function computeDeviceCapabilities(params: {
  channel: number;
  abilities?: DeviceAbilities;
  support?: SupportInfo;
}): DeviceCapabilities {
  const { channel } = params;
  const flat = flattenAbilitiesForChannel(params.abilities, channel);
  const supportItem = getSupportItemForChannel(params.support, channel);

  const ptzModeRaw = params.support?.ptzMode;
  const ptzMode = typeof ptzModeRaw === "string" ? ptzModeRaw.toLowerCase() : undefined;

  const hasBatteryFromSupport = supportItem ? isTruthyNumberLike((supportItem as any).battery) : false;
  const hasLedFromSupport = supportItem ? isTruthyNumberLike((supportItem as any).ledCtrl) : false;
  const hasPresetsFromSupport = supportItem ? isTruthyNumberLike((supportItem as any).ptzPreset) : false;

  const hasPtzFromSupport = ptzMode ? ptzMode !== "none" && ptzMode !== "0" : false;
  const hasPanTiltFromSupport = ptzMode ? ptzMode.includes("pt") || ptzMode === "pt" || ptzMode === "ptz" : false;
  const hasZoomFromSupport = ptzMode ? ptzMode.includes("z") : false;

  const hasBatteryFromAbilities = abilitiesHasAny(flat, /battery/i);
  const hasFloodlightFromAbilities = abilitiesHasAny(flat, /white\s*led|whiteLed|flood\s*light|floodlight|ledState/i);
  const hasSirenFromAbilities = abilitiesHasAny(flat, /audio\s*alarm|audioAlarm|siren|pushAlarn|audioPlay/i);

  const hasPanTiltFromAbilities = abilitiesHasAny(flat, /ptz/i);
  const hasZoomFromAbilities = abilitiesHasAny(flat, /zoom|zoomFocus|StartZoomFocus/i);
  const hasPresetsFromAbilities = abilitiesHasAny(flat, /preset/i);
  const hasPirFromAbilities = abilitiesHasAny(flat, /(^|_)pir/i);

  const hasPan = hasPanTiltFromSupport || hasPanTiltFromAbilities;
  const hasTilt = hasPanTiltFromSupport || hasPanTiltFromAbilities;
  const hasZoom = hasZoomFromSupport || hasZoomFromAbilities;
  const hasPresets = hasPresetsFromSupport || hasPresetsFromAbilities;

  const result: DeviceCapabilities = {
    channel,
    hasPan,
    hasTilt,
    hasZoom,
    hasPresets,
    hasPtz: hasPtzFromSupport || hasPan || hasTilt || hasZoom || hasPresets,
    hasBattery: hasBatteryFromSupport || hasBatteryFromAbilities,
    hasSiren: hasSirenFromAbilities,
    hasFloodlight: hasLedFromSupport || hasFloodlightFromAbilities,
    hasPir: hasPirFromAbilities,
  };

  if (ptzMode !== undefined) result.ptzMode = ptzMode;
  return result;
}
