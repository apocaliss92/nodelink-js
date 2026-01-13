export function xmlEscape(text: string | undefined | null): string {
  if (text === undefined || text === null || typeof text !== "string") {
    const error = new Error(`xmlEscape: expected string but got ${typeof text}: ${text}`);
    throw error;
  }
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLoginXml(userNameHash: string, passwordHash: string): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<LoginUser version="1.1">
<userName>${xmlEscape(userNameHash)}</userName>
<password>${xmlEscape(passwordHash)}</password>
<userVer>1</userVer>
</LoginUser>
<LoginNet version="1.1">
<type>LAN</type>
<udpPort>0</udpPort>
</LoginNet>
</body>`;
}

export function buildChannelExtensionXml(channelId: number | string | undefined | null): string {
  if (channelId === undefined || channelId === null) {
    return `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"></Extension>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<channelId>${channelId}</channelId>
</Extension>`;
}

export function buildBinaryExtensionXml(channelId: number | string | undefined | null): string {
  if (channelId === undefined || channelId === null) {
    return `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><binaryData>1</binaryData></Extension>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<binaryData>1</binaryData>
<channelId>${channelId}</channelId>
</Extension>`;
}

/**
 * Build Preview XML for video stream request.
 * Uses Preview element with handle and stream_type.
 * 
 * @param handle - Handle value: 0 for main, 256 for sub, 1024 for extern
 * @param streamType - Stream type name: "mainStream", "subStream", or "externStream"
 * @param channelId - Channel ID (optional, not used in working format)
 * @returns XML string for Preview element
 */
export function buildPreviewXml(handle: number, streamType: string | undefined | null, channelId?: number): string {
  // Preview includes channelId + handle + streamType.
  if (!streamType || typeof streamType !== "string") {
    throw new Error(`buildPreviewXml: streamType is required (string) but got: ${typeof streamType} = ${streamType}`);
  }
  const channelIdXml = channelId !== undefined ? `<channelId>${channelId}</channelId>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
${channelIdXml}<handle>${handle}</handle>
<streamType>${xmlEscape(streamType)}</streamType>
</Preview>
</body>`;
}

/**
 * Build Preview XML for video stream request (v1.1).
 *
 * This format is observed in Reolink client traffic to NVR/Hub where the Preview element uses
 * version="1.1" and always includes channelId + handle + streamType.
 */
export function buildPreviewXmlV11(params: { channelId: number; handle: number; streamType: string }): string {
  if (!Number.isFinite(params.channelId)) {
    throw new Error(`buildPreviewXmlV11: channelId must be finite, got: ${params.channelId}`);
  }
  if (!Number.isFinite(params.handle)) {
    throw new Error(`buildPreviewXmlV11: handle must be finite, got: ${params.handle}`);
  }
  if (!params.streamType || typeof params.streamType !== "string") {
    throw new Error(`buildPreviewXmlV11: streamType is required (string) but got: ${typeof params.streamType} = ${params.streamType}`);
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.1">
<channelId>${params.channelId}</channelId>
<handle>${params.handle}</handle>
<streamType>${xmlEscape(params.streamType)}</streamType>
</Preview>
</body>`;
}

/**
 * Build Preview XML for video stream stop request.
 * Uses Preview element without stream_type.
 * 
 * @param handle - Handle value: 0 for main, 256 for sub, 1024 for extern
 * @param channelId - Channel ID (optional, not used in working format)
 * @returns XML string for Preview element (stop)
 */
export function buildPreviewStopXml(handle: number, channelId?: number): string {
  const channelIdXml = channelId !== undefined ? `<channelId>${channelId}</channelId>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
${channelIdXml}<handle>${handle}</handle>
</Preview>
</body>`;
}

/**
 * Build Preview XML for video stream stop request (v1.1).
 *
 * This format is observed/needed on some Hub/NVR firmwares where the VIDEO start
 * request uses Preview version="1.1" with explicit channelId and handle.
 */
export function buildPreviewStopXmlV11(params: { channelId: number; handle: number }): string {
  if (!Number.isFinite(params.channelId)) {
    throw new Error(`buildPreviewStopXmlV11: channelId must be finite, got: ${params.channelId}`);
  }
  if (!Number.isFinite(params.handle)) {
    throw new Error(`buildPreviewStopXmlV11: handle must be finite, got: ${params.handle}`);
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.1">
<channelId>${params.channelId}</channelId>
<handle>${params.handle}</handle>
</Preview>
</body>`;
}

/**
 * Very small helper for extracting simple `<tag>value</tag>` text from Baichuan XML.
 * This is intentionally dependency-free; it's enough for nonce/login flows.
 */
export function getXmlText(xml: string, tagName: string): string | undefined {
  const re = new RegExp(`<${tagName}>([^<]*)</${tagName}>`);
  const m = re.exec(xml);
  return m?.[1];
}

/**
 * Build PTZ Control XML for pan/tilt/zoom commands.
 * 
 * @param channelId - Channel ID (1-based)
 * @param command - PTZ command: "up", "down", "left", "right", "stop"
 * @param speed - Movement speed (0.0 to 1.0, typically converted to 1-10)
 * @returns XML string for PtzControl element
 */
export function buildPtzControlXml(channelId: number, command: string, speed: number): string {
  // PtzControl structure: channel_id, speed, command
  // Version is "1.1"
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<PtzControl version="1.1">
<channelId>${channelId}</channelId>
<command>${xmlEscape(command)}</command>
<speed>${speed}</speed>
</PtzControl>
</body>`;
}

/**
 * Build PTZ Preset XML for setting or moving to preset.
 * 
 * @param channelId - Channel ID (1-based)
 * @param presetId - Preset ID (1-255)
 * @param command - "setPos" to save current position, "toPos" to move to preset
 * @param name - Preset name (optional, required for setPos)
 * @returns XML string for PtzPreset element
 */
export function buildPtzPresetXml(channelId: number, presetId: number, command: "setPos" | "toPos", name?: string): string {
  return buildPtzPresetXmlV2(channelId, presetId, command, name === undefined ? undefined : { name });
}

export function buildPtzPresetXmlV2(
  channelId: number,
  presetId: number,
  command: "setPos" | "toPos" | "delPos",
  options?: {
    /** Preset name. For setPos many firmwares require it; empty string will emit an empty <name></name>. */
    name?: string;
    /** Best-effort enable/disable support. Some firmwares include this in the preset list response. */
    enable?: 0 | 1;
  }
): string {
  let nameXml = "";
  const name = options?.name;
  if (command === "setPos" && name !== undefined) {
    nameXml = `<name>${xmlEscape(name)}</name>`;
  }

  let enableXml = "";
  if (options?.enable !== undefined) {
    enableXml = `<enable>${options.enable}</enable>`;
  }

  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<PtzPreset version="1.1">
<channelId>${channelId}</channelId>
<presetList>
<preset>
<id>${presetId}</id>
<command>${command}</command>
${nameXml}
${enableXml}
</preset>
</presetList>
</PtzPreset>
</body>`;
}

/**
 * Build StartZoomFocus XML for zooming to an absolute position.
 *
 * cmd_id: 295 (MSG_ID_SET_ZOOM_FOCUS)
 *
 * @param channelId - Channel ID (0/1-based depending on camera; should match header/extension)
 * @param movePos - Absolute zoom position (typically 1000 == 1.0x)
 */
export function buildStartZoomFocusXml(channelId: number, movePos: number): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<StartZoomFocus version="1.1">
<channelId>${channelId}</channelId>
<command>zoomPos</command>
<movePos>${Math.trunc(movePos)}</movePos>
</StartZoomFocus>
</body>`;
}

/**
 * Build Siren/Audio Alarm XML for manual control.
 * 
 * @param channelId - Channel ID (1-based, optional for hub-level)
 * @param enable - Enable/disable siren (1 or 0)
 * @returns XML string for audioPlayInfo element
 */
export function buildSirenManualXml(channelId: number | undefined, enable: number): string {
  const channelXml = channelId !== undefined ? `<channelId>${channelId}</channelId>` : "";
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<audioPlayInfo version="1.1">
${channelXml}
<playMode>2</playMode>
<playDuration>10</playDuration>
<playTimes>1</playTimes>
<onOff>${enable}</onOff>
</audioPlayInfo>
</body>`;
}

function buildTimeBlockXml(t: Date): string {
  return `
<year>${t.getFullYear()}</year>
<month>${t.getMonth() + 1}</month>
<day>${t.getDate()}</day>
<hour>${t.getHours()}</hour>
<minute>${t.getMinutes()}</minute>
<second>${t.getSeconds()}</second>`;
}

/**
 * Build findEventLog (open) XML.
 *
 * Note: HomeHub PCAP shows this command accepts a device list (uids) and an optional
 * eventAlarmType filter. For "no filters", pass all known UIDs and omit eventAlarmType.
 */
export function buildFindEventLogOpenXml(params: {
  startTime: Date;
  /** Optional list of device UIDs to search. If omitted, the hub may return nothing. */
  deviceUids?: string[];
  /** Optional alarm types. Some firmwares return empty results if omitted. */
  alarmTypes?: string[];
  /** Optional per-device logic channel bitmap (defaults to 255 in PCAP). */
  logicChnBitmap?: number;
  /** Sort descending (PCAP uses 1). */
  desc?: 0 | 1;
  /** LogType bitset (PCAP uses 1). */
  logTypeBits?: number;
  /** NotSearchVideo (PCAP uses 1). */
  notSearchVideo?: 0 | 1;
  /** Channel bitmap (PCAP uses 0). */
  chnbits?: number;
}): string {
  const desc = params.desc ?? 1;
  const logTypeBits = params.logTypeBits ?? 1;
  const notSearchVideo = params.notSearchVideo ?? 1;
  const chnbits = params.chnbits ?? 0;
  const logicChnBitmap = params.logicChnBitmap ?? 255;

  const deviceUids = (params.deviceUids ?? []).map((u) => u.trim()).filter(Boolean);
  const alarmTypes = (params.alarmTypes ?? []).map((t) => t.trim()).filter(Boolean);
  const alarmTypeXml = alarmTypes.length ? `\n<alarmType>${xmlEscape(alarmTypes.join(","))}</alarmType>` : "";
  const eventAlarmTypeXml = alarmTypes.length
    ? `\n<eventAlarmType>\n${alarmTypes.map((t) => `<i>${xmlEscape(t)}</i>`).join("\n")}\n</eventAlarmType>`
    : "";
  const devicesXml = deviceUids.length
    ? `\n<devices>\n${deviceUids
        .map(
          (uid) =>
            `<deviceInfo>\n<uid>${xmlEscape(uid)}</uid>\n<logicChnBitmap>${logicChnBitmap}</logicChnBitmap>\n</deviceInfo>`
        )
        .join("\n")}\n</devices>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findEventLog version="1.1">
<logTypeBits>${logTypeBits}</logTypeBits>
<notSearchVideo>${notSearchVideo}</notSearchVideo>
<desc>${desc}</desc>
<chnbits>${chnbits}</chnbits>${alarmTypeXml}${eventAlarmTypeXml}
<startTime>${buildTimeBlockXml(params.startTime)}
</startTime>${devicesXml}
</findEventLog>
</body>`;
}

/** Build findEventLog (get page) XML. */
export function buildFindEventLogGetXml(params: { handle: number; maxEventCount: number }): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<findEventLog version="1.1">
<handle>${Math.trunc(params.handle)}</handle>
<maxEventCount>${Math.trunc(params.maxEventCount)}</maxEventCount>
</findEventLog>
</body>`;
}

function secondsSinceMidnight(t: Date): number {
  return t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds();
}

export type ReplayByTimeV2StreamType = "subStream" | "mobileStream";

/**
 * Build ReplayByTimeV2 (cmd_id=381) for a single duration (one event).
 *
 * HomeHub PCAP shows:
 * - seq: unix-like integer
 * - startTime: event start
 * - endTime: day end (23:59:59)
 * - durationList: includes year/month/day and a duration with times in seconds since midnight
 */
export function buildReplayByTimeV2Xml(params: {
  seq: number;
  startTime: Date;
  /** Top-level endTime; if omitted, defaults to 23:59:59 of startTime day. */
  endTime?: Date;
  playSpeed?: number;
  streamType: ReplayByTimeV2StreamType;
  duration: {
    channelId: number;
    uid: string;
    logicChnBitmap: number;
    streamType: ReplayByTimeV2StreamType;
    startTime: Date;
    endTime: Date;
  };
}): string {
  const playSpeed = params.playSpeed ?? 1;
  const dayEnd = params.endTime
    ? params.endTime
    : new Date(
        params.startTime.getFullYear(),
        params.startTime.getMonth(),
        params.startTime.getDate(),
        23,
        59,
        59,
        0
      );

  const d = params.duration;
  const s = secondsSinceMidnight(d.startTime);
  const e = secondsSinceMidnight(d.endTime);

  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<ReplayByTimeV2 version="1.1">
<seq>${Math.trunc(params.seq)}</seq>
<startTime>${buildTimeBlockXml(params.startTime)}
</startTime>
<endTime>${buildTimeBlockXml(dayEnd)}
</endTime>
<playSpeed>${playSpeed}</playSpeed>
<streamType>${xmlEscape(params.streamType)}</streamType>
<durationList>
<year>${d.startTime.getFullYear()}</year>
<month>${d.startTime.getMonth() + 1}</month>
<day>${d.startTime.getDate()}</day>
<duration>
<channelId>${Math.trunc(d.channelId)}</channelId>
<uid>${xmlEscape(d.uid)}</uid>
<logicChnBitmap>${Math.trunc(d.logicChnBitmap)}</logicChnBitmap>
<streamType>${xmlEscape(d.streamType)}</streamType>
<times>
<i>
<s>${Math.trunc(s)}</s>
<e>${Math.trunc(e)}</e>
</i>
</times>
</duration>
</durationList>
</ReplayByTimeV2>
</body>`;
}

/**
 * Build Siren/Audio Alarm XML for times-based control.
 * 
 * @param channelId - Channel ID (1-based, optional for hub-level)
 * @param times - Number of times to play
 * @returns XML string for audioPlayInfo element
 */
export function buildSirenTimesXml(channelId: number | undefined, times: number): string {
  const channelXml = channelId !== undefined ? `<channelId>${channelId}</channelId>` : "";
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<audioPlayInfo version="1.1">
${channelXml}
<playMode>0</playMode>
<playDuration>10</playDuration>
<playTimes>${times}</playTimes>
<onOff>1</onOff>
</audioPlayInfo>
</body>`;
}

/**
 * Build FloodlightManual XML.
 * Used for cmd_id 288.
 *
 * Notes:
 * - channelId is 0-based (same as Baichuan channel id)
 * - status: 1 = on, 0 = off
 * - duration is in seconds
 */
export function buildFloodlightManualXml(channelId: number, status: number, durationSeconds = 180): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FloodlightManual version="1.1">
<channelId>${channelId}</channelId>
<status>${status}</status>
<duration>${durationSeconds}</duration>
</FloodlightManual>
</body>`;
}

/**
 * Back-compat alias: historically this project called floodlight control "WhiteLed".
 * In practice, many cameras expect FloodlightManual payload for cmd 288.
 */
export function buildWhiteLedStateXml(channelId: number, state: number): string {
  return buildFloodlightManualXml(channelId, state ? 1 : 0);
}

/**
 * Build AbilityInfo extension XML for requesting device capabilities.
 * Requests all available tokens: "system, streaming, PTZ, IO, security, replay, disk, network, alarm, record, video, image"
 * 
 * @param username - Username for the request
 * @returns XML string for Extension element with AbilityInfo request
 */
export function buildAbilityInfoExtensionXml(username: string): string {
  // Request all available ability tokens to get comprehensive ability information
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<userName>${xmlEscape(username)}</userName>
<token>system, streaming, PTZ, IO, security, replay, disk, network, alarm, record, video, image</token>
</Extension>`;
}

