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
  // Template mirrors reolink_aio `LOGIN_XML`
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
 * Based on neolink stream.rs: uses Preview element with handle and stream_type.
 * 
 * Reference: https://github.com/QuantumEntangledAndy/neolink/blob/master/crates/core/src/bc_protocol/stream.rs#L108
 * 
 * @param handle - Handle value: 0 for main, 256 for sub, 1024 for extern
 * @param streamType - Stream type name: "mainStream", "subStream", or "externStream"
 * @param channelId - Channel ID (optional, not used in working format)
 * @returns XML string for Preview element
 */
export function buildPreviewXml(handle: number, streamType: string | undefined | null, channelId?: number): string {
  // Based on neolink stream.rs:
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
 * Build Preview XML for video stream stop request.
 * Based on neolink stream.rs: uses Preview element without stream_type.
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
 * Based on neolink ptz.rs implementation.
 * 
 * @param channelId - Channel ID (1-based)
 * @param command - PTZ command: "up", "down", "left", "right", "stop"
 * @param speed - Movement speed (0.0 to 1.0, typically converted to 1-10)
 * @returns XML string for PtzControl element
 */
export function buildPtzControlXml(channelId: number, command: string, speed: number): string {
  // Neolink uses xml_ver() which returns "1.1" (checked in crates/core/src/bc/xml.rs:1619)
  // Based on neolink PtzControl struct: channel_id (u8), speed (f32), command (String)
  // No timeout or id fields in neolink implementation
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
 * Based on neolink ptz.rs implementation.
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
  command: "setPos" | "toPos",
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
<PtzPreset version="1.0">
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
 * Based on neolink ptz.rs implementation.
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
 * Based on reolink_aio xmls.py SirenManual template.
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

/**
 * Build Siren/Audio Alarm XML for times-based control.
 * Based on reolink_aio xmls.py SirenTimes template.
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
 * Build White LED/Floodlight state XML.
 * Based on reolink_aio floodlight implementation.
 * 
 * @param channelId - Channel ID (1-based)
 * @param state - State (1 = on, 0 = off)
 * @returns XML string for WhiteLed element
 */
export function buildWhiteLedStateXml(channelId: number, state: number): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<WhiteLed version="1.1">
<channelId>${channelId}</channelId>
<state>${state}</state>
</WhiteLed>
</body>`;
}

/**
 * Build AbilityInfo extension XML for requesting device capabilities.
 * Based on neolink crates/core/src/bc_protocol/abilityinfo.rs which requests:
 * "system, streaming, PTZ, IO, security, replay, disk, network, alarm, record, video, image"
 * 
 * Note: reolink_aio only requests "image, video", but neolink requests all available tokens
 * to get complete ability information.
 * 
 * @param username - Username for the request
 * @returns XML string for Extension element with AbilityInfo request
 */
export function buildAbilityInfoExtensionXml(username: string): string {
  // Request all available ability tokens (based on neolink implementation)
  // This provides much more comprehensive ability information than just "image, video"
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<userName>${xmlEscape(username)}</userName>
<token>system, streaming, PTZ, IO, security, replay, disk, network, alarm, record, video, image</token>
</Extension>`;
}

