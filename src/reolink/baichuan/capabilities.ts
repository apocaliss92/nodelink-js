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
  // Some firmwares return multiple <item> entries with the same chnID:
  // - smartHome items (googleHome/amazonAlexa) with only {name, ver}
  // - a "real" capability item with many numeric fields (ptzType, ledCtrl, lightType, etc.)
  // We must pick the best candidate, otherwise we miss lightType/ledCtrl and mis-detect capabilities.

  const scoreSupportItem = (item: SupportItem): number => {
    const anyItem = item as any;
    let score = 0;

    // Prefer items without a "name" field (often smartHome entries).
    if (anyItem.name == null) score += 2;

    // Prefer items with known capability-ish fields.
    const capabilityKeys = [
      "ptzType",
      "ptzControl",
      "ptzPreset",
      "ledCtrl",
      "lightType",
      "battery",
      "audioVersion",
      "motion",
      "encCtrl",
      "newIspCfg",
      "remoteAbility",
    ];
    for (const k of capabilityKeys) {
      if (anyItem[k] !== undefined) score += 3;
    }

    // Fallback: reward having many fields at all.
    score += Math.min(10, Math.max(0, Object.keys(anyItem).length - 1));
    return score;
  };

  const pickBest = (chnId: number): SupportItem | undefined => {
    const candidates = support.items.filter((i) => i.chnID === chnId);
    if (!candidates.length) return undefined;
    return candidates
      .slice()
      .sort((a, b) => scoreSupportItem(b) - scoreSupportItem(a))[0];
  };

  return pickBest(channel) ?? pickBest(channel + 1);
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

  // Some battery cameras expose legacy/host PTZ abilities (e.g. preset_rw/ptzInfo_ro) even when
  // the actual channel PTZ is explicitly disabled. When support.ptzMode says "none", treat it
  // as authoritative and do NOT expose PTZ/presets/pan/tilt/zoom based on abilities heuristics.
  const ptzDisabledBySupport = ptzMode === "none" || ptzMode === "0";

  const hasBatteryFromSupport = supportItem ? isTruthyNumberLike((supportItem as any).battery) : false;
  // NOTE: ledCtrl is typically the indicator/status LED control, NOT the floodlight.
  // Do not map it to floodlight capability.
  const hasPresetsFromSupport = supportItem ? isTruthyNumberLike((supportItem as any).ptzPreset) : false;

  // Some firmwares expose an explicit lightType in SupportInfo items.
  // Observed values:
  // - 0: no white LED / no floodlight
  // - >0: some form of controllable light (treat as floodlight)
  const lightTypeRaw = supportItem ? (supportItem as any).lightType : undefined;
  const lightType = typeof lightTypeRaw === "number" ? lightTypeRaw : typeof lightTypeRaw === "string" ? Number(lightTypeRaw) : undefined;

  const hasPtzFromSupport = ptzMode ? ptzMode !== "none" && ptzMode !== "0" : false;
  const hasPanTiltFromSupport = ptzMode ? ptzMode.includes("pt") || ptzMode === "pt" || ptzMode === "ptz" : false;
  const hasZoomFromSupport = ptzMode ? ptzMode.includes("z") : false;

  const hasBatteryFromAbilities = abilitiesHasAny(flat, /battery/i);
  const hasFloodlightFromAbilities = abilitiesHasAny(flat, /white\s*led|whiteLed|flood\s*light|floodlight/i);
  const hasSirenFromAbilities = abilitiesHasAny(flat, /audio\s*alarm|audioAlarm|siren|pushAlarn|audioPlay/i);

  const hasPanTiltFromAbilities = abilitiesHasAny(flat, /ptz/i);
  const hasZoomFromAbilities = abilitiesHasAny(flat, /zoom|zoomFocus|StartZoomFocus/i);
  const hasPresetsFromAbilities = abilitiesHasAny(flat, /preset/i);
  const hasPirFromAbilities = abilitiesHasAny(flat, /(^|_)pir/i);

  const hasPan = hasPanTiltFromSupport || hasPanTiltFromAbilities;
  const hasTilt = hasPanTiltFromSupport || hasPanTiltFromAbilities;
  const hasZoom = hasZoomFromSupport || hasZoomFromAbilities;
  const hasPresets = hasPresetsFromSupport || hasPresetsFromAbilities;

  const finalHasPan = ptzDisabledBySupport ? false : hasPan;
  const finalHasTilt = ptzDisabledBySupport ? false : hasTilt;
  const finalHasZoom = ptzDisabledBySupport ? false : hasZoom;
  const finalHasPresets = ptzDisabledBySupport ? false : hasPresets;

  const result: DeviceCapabilities = {
    channel,
    hasPan: finalHasPan,
    hasTilt: finalHasTilt,
    hasZoom: finalHasZoom,
    hasPresets: finalHasPresets,
    hasPtz: ptzDisabledBySupport ? false : (hasPtzFromSupport || finalHasPan || finalHasTilt || finalHasZoom || finalHasPresets),
    hasBattery: hasBatteryFromSupport || hasBatteryFromAbilities,
    hasSiren: hasSirenFromAbilities,
    hasFloodlight: Number.isFinite(lightType as number) ? (lightType as number) > 0 : hasFloodlightFromAbilities,
    hasPir: hasPirFromAbilities,
  };

  if (ptzMode !== undefined) result.ptzMode = ptzMode;
  return result;
}
