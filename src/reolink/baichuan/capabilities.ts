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

  // NOTE: callers always pass channel as 0-based.
  // Do not attempt 1-based fallbacks here: it is ambiguous and can mix in data from the wrong channel.
  const anyAbilities = abilities as any;
  const channelAbilities = anyAbilities[channel] as AbilityInfo | undefined;
  const host = anyAbilities.Host as AbilityInfo | undefined;

  const merged: AbilityInfo = {
    ...(host && typeof host === "object" ? host : {}),
    ...(channelAbilities && typeof channelAbilities === "object"
      ? channelAbilities
      : {}),
  };

  return Object.keys(merged).length ? merged : undefined;
}

export function abilitiesHasAny(
  abilities: AbilityInfo | undefined,
  re: RegExp,
): boolean {
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
  for (const itemMatch of supportXml.matchAll(
    /<item[^>]*>([\s\S]*?)<\/item>/gi,
  )) {
    const itemXml = itemMatch[1] ?? "";
    const item: SupportItem = {
      chnID:
        toNumberOrUndefined(itemXml.match(/<chnID>([^<]*)<\/chnID>/i)?.[1]) ??
        0,
    };

    for (const tagMatch of itemXml.matchAll(
      /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g,
    )) {
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

function getSupportItemForChannel(
  support: SupportInfo | undefined,
  channel: number,
): SupportItem | undefined {
  if (!support?.items?.length) return undefined;

  // NOTE: callers always pass channel as 0-based and we only match that exact chnID.
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

  return pickBest(channel);
}

export function computeDeviceCapabilities(params: {
  channel: number;
  /** Device model name/type (best-effort). Used for heuristic capability detection. */
  model?: string;
  abilities?: DeviceAbilities;
  support?: SupportInfo;
}): DeviceCapabilities {
  const { channel } = params;
  const flat = flattenAbilitiesForChannel(params.abilities, channel);
  const supportItem = getSupportItemForChannel(params.support, channel);

  const ptzModeRaw = params.support?.ptzMode;
  const ptzMode =
    typeof ptzModeRaw === "string" ? ptzModeRaw.toLowerCase() : undefined;

  // Per-channel PTZ signals from SupportInfo item.
  // On some hub/NVR firmwares, top-level <ptzMode> reflects the host and may be "none"
  // even when specific channels are PTZ.
  const ptzTypeRaw = supportItem ? (supportItem as any).ptzType : undefined;
  const ptzControlRaw = supportItem
    ? (supportItem as any).ptzControl
    : undefined;
  const supportExplicitlyDefinesPtz =
    ptzTypeRaw !== undefined || ptzControlRaw !== undefined;
  const ptzExplicitlyDisabledBySupportItem =
    supportExplicitlyDefinesPtz &&
    !isTruthyNumberLike(ptzTypeRaw) &&
    !isTruthyNumberLike(ptzControlRaw);
  const hasPtzFromSupportItem =
    isTruthyNumberLike(ptzTypeRaw) ||
    isTruthyNumberLike(ptzControlRaw) ||
    isTruthyNumberLike((supportItem as any)?.ptzPreset);

  // Some battery cameras expose legacy/host PTZ abilities (e.g. preset_rw/ptzInfo_ro) even when
  // the actual channel PTZ is explicitly disabled. When support.ptzMode says "none", treat it
  // as authoritative ONLY if the channel support item does not indicate PTZ.
  const ptzDisabledBySupport =
    (ptzMode === "none" || ptzMode === "0") && !hasPtzFromSupportItem;

  const hasBatteryFromSupport = supportItem
    ? isTruthyNumberLike((supportItem as any).battery)
    : false;
  // NOTE: ledCtrl is typically the indicator/status LED control, NOT the floodlight.
  // Do not map it to floodlight capability.
  const ptzPresetRaw = supportItem ? (supportItem as any).ptzPreset : undefined;
  // If SupportInfo explicitly provides ptzPreset, treat it as authoritative.
  // This avoids false positives from AbilityInfo (some firmwares leak host/legacy preset keys).
  const supportExplicitlyDefinesPresets = ptzPresetRaw !== undefined;
  const hasPresetsFromSupport = supportExplicitlyDefinesPresets
    ? isTruthyNumberLike(ptzPresetRaw)
    : false;
  const presetsExplicitlyDisabledBySupport =
    supportExplicitlyDefinesPresets && !isTruthyNumberLike(ptzPresetRaw);
  const doorbellVersionRaw = supportItem
    ? (supportItem as any).doorbellVersion
    : undefined;
  const isDoorbellFromSupport = Number.isFinite(Number(doorbellVersionRaw))
    ? Number(doorbellVersionRaw) > 0
    : isTruthyNumberLike(doorbellVersionRaw);
  const isDoorbellFromModel =
    typeof params.model === "string" && /doorbell/i.test(params.model);

  // Some firmwares expose an explicit lightType in SupportInfo items.
  // Observed values:
  // - 0: no white LED / no floodlight
  // - 1: IR LED only (not controllable as floodlight)
  // - 2+: white LED / spotlight / floodlight (controllable)
  // Only treat lightType >= 2 as having a controllable floodlight.
  const lightTypeRaw = supportItem ? (supportItem as any).lightType : undefined;
  const lightType =
    typeof lightTypeRaw === "number"
      ? lightTypeRaw
      : typeof lightTypeRaw === "string"
        ? Number(lightTypeRaw)
        : undefined;

  const hasPtzFromSupport =
    hasPtzFromSupportItem ||
    (ptzMode ? ptzMode !== "none" && ptzMode !== "0" : false);
  const hasPanTiltFromSupport = ptzMode
    ? ptzMode.includes("pt") || ptzMode === "pt" || ptzMode === "ptz"
    : false;
  const hasZoomFromSupport = ptzMode ? ptzMode.includes("z") : false;

  const hasBatteryFromAbilities = abilitiesHasAny(flat, /battery/i);
  const hasFloodlightFromAbilities = abilitiesHasAny(
    flat,
    /white\s*led|whiteLed|flood\s*light|floodlight/i,
  );
  const hasSirenFromAbilities = abilitiesHasAny(
    flat,
    /audio\s*alarm|audioAlarm|siren|pushAlarn|audioPlay/i,
  );

  // Two-way audio (intercom/talk) capability.
  // Observed signals:
  // - `support.audioTalk` (some firmwares)
  // - per-channel SupportInfo item `ipcAudioTalk` (common on NVR doorbells)
  const hasIntercomFromSupport =
    isTruthyNumberLike((params.support as any)?.audioTalk) ||
    (supportItem
      ? isTruthyNumberLike((supportItem as any).ipcAudioTalk)
      : false);

  // AbilityInfo can contain host/legacy PTZ keys even for non-PTZ channels.
  // If SupportInfo explicitly defines ptzType/ptzControl and both are falsey, treat that as authoritative.
  const hasPanTiltFromAbilities = ptzExplicitlyDisabledBySupportItem
    ? false
    : abilitiesHasAny(flat, /ptz/i);
  const hasZoomFromAbilities = ptzExplicitlyDisabledBySupportItem
    ? false
    : abilitiesHasAny(flat, /zoom|zoomFocus|StartZoomFocus/i);
  const hasPresetsFromAbilities = abilitiesHasAny(flat, /preset/i);
  // PIR detection is inconsistently advertised across firmwares.
  // Observed signals:
  // - explicit pir_* abilities
  // - rfAlarm_* host ability (common on battery cams; "rf" ~ PIR/radio sensor config)
  // - mdWithPir version flag (seen in other SDKs)
  const hasPirFromAbilities =
    abilitiesHasAny(flat, /(^|_)pir/i) ||
    abilitiesHasAny(flat, /rfAlarm/i) ||
    abilitiesHasAny(flat, /mdWithPir/i);

  // Some firmwares expose rfCfg in SupportInfo items; treat it as a hint for PIR support.
  // Observed variants:
  // - rfCfg (older)
  // - newRfCfg (common)
  // - rfVersion (present even when *Cfg is 0)
  // Additionally, many battery cams are PIR-based; treat battery>0 as a weak hint.
  const hasPirFromSupport = supportItem
    ? isTruthyNumberLike((supportItem as any).rfCfg) ||
      isTruthyNumberLike((supportItem as any).newRfCfg) ||
      isTruthyNumberLike((supportItem as any).rfVersion) ||
      isTruthyNumberLike((supportItem as any).battery)
    : false;

  // Autotracking (smartTrack) support.
  // Observed signals:
  // - autoPt in SupportInfo item (indicates the device supports auto pan-tilt tracking)
  // - smartAI in SupportInfo item (indicates AI-based tracking capability)
  // NOTE: The heuristic (ptzControl > 0 && aitype > 0) was too aggressive and caused
  // false positives on cameras that have PTZ and AI detection but NOT autotracking.
  // NOTE: aiCfg in abilities is NOT a reliable indicator of autotracking - many cameras
  // have AI configuration (for detection) without autotracking capability.
  // NOTE: The actual smartTrack enable state is in AiCfg (cmdId=299), but the capability
  // can be detected from the SupportInfo item fields.
  const hasAutotrackingFromSupport = supportItem
    ? isTruthyNumberLike((supportItem as any).autoPt) ||
      isTruthyNumberLike((supportItem as any).smartAI)
    : false;

  // Fallback: check abilities for explicit smartTrack only (NOT aiCfg - too broad)
  const hasAutotrackingFromAbilities = abilitiesHasAny(flat, /smartTrack/i);

  const hasPan = hasPanTiltFromSupport || hasPanTiltFromAbilities;
  const hasTilt = hasPanTiltFromSupport || hasPanTiltFromAbilities;
  const hasZoom = hasZoomFromSupport || hasZoomFromAbilities;
  const hasPresets = presetsExplicitlyDisabledBySupport
    ? false
    : hasPresetsFromSupport || hasPresetsFromAbilities;

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
    hasPtz: ptzDisabledBySupport
      ? false
      : hasPtzFromSupport ||
        finalHasPan ||
        finalHasTilt ||
        finalHasZoom ||
        finalHasPresets,
    hasBattery: hasBatteryFromSupport || hasBatteryFromAbilities,
    hasIntercom: hasIntercomFromSupport,
    hasSiren: hasSirenFromAbilities,
    // lightType >= 2 indicates controllable white LED / floodlight (1 = IR only)
    hasFloodlight: Number.isFinite(lightType as number)
      ? (lightType as number) >= 2
      : hasFloodlightFromAbilities,
    hasPir: hasPirFromAbilities || hasPirFromSupport,
    isDoorbell: isDoorbellFromSupport || isDoorbellFromModel,
    hasAutotracking: hasAutotrackingFromSupport || hasAutotrackingFromAbilities,
  };

  if (ptzMode !== undefined) result.ptzMode = ptzMode;
  return result;
}
