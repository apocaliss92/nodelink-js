export function xmlEscape(text: string | undefined | null): string {
  if (text === undefined || text === null || typeof text !== "string") {
    const error = new Error(
      `xmlEscape: expected string but got ${typeof text}: ${text}`,
    );
    throw error;
  }
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLoginXml(
  userNameHash: string,
  passwordHash: string,
): string {
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

/**
 * Build Logout XML for session termination.
 * PCAP-observed: cmdId=2 with encrypted XML body containing Logout element.
 */
export function buildLogoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Logout version="1.1">
</Logout>
</body>`;
}

export function buildChannelExtensionXml(
  channelId: number | string | undefined | null,
): string {
  if (channelId === undefined || channelId === null) {
    return `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"></Extension>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<channelId>${channelId}</channelId>
</Extension>`;
}

export function buildBinaryExtensionXml(
  channelId: number | string | undefined | null,
): string {
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
export function buildPreviewXml(
  handle: number,
  streamType: string | undefined | null,
  channelId?: number,
): string {
  // Preview includes channelId + handle + streamType.
  if (!streamType || typeof streamType !== "string") {
    throw new Error(
      `buildPreviewXml: streamType is required (string) but got: ${typeof streamType} = ${streamType}`,
    );
  }
  const channelIdXml =
    channelId !== undefined ? `<channelId>${channelId}</channelId>\n` : "";
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
export function buildPreviewXmlV11(params: {
  channelId: number;
  handle: number;
  streamType: string;
}): string {
  if (!Number.isFinite(params.channelId)) {
    throw new Error(
      `buildPreviewXmlV11: channelId must be finite, got: ${params.channelId}`,
    );
  }
  if (!Number.isFinite(params.handle)) {
    throw new Error(
      `buildPreviewXmlV11: handle must be finite, got: ${params.handle}`,
    );
  }
  if (!params.streamType || typeof params.streamType !== "string") {
    throw new Error(
      `buildPreviewXmlV11: streamType is required (string) but got: ${typeof params.streamType} = ${params.streamType}`,
    );
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
export function buildPreviewStopXml(
  handle: number,
  channelId?: number,
): string {
  const channelIdXml =
    channelId !== undefined ? `<channelId>${channelId}</channelId>\n` : "";
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
export function buildPreviewStopXmlV11(params: {
  channelId: number;
  handle: number;
}): string {
  if (!Number.isFinite(params.channelId)) {
    throw new Error(
      `buildPreviewStopXmlV11: channelId must be finite, got: ${params.channelId}`,
    );
  }
  if (!Number.isFinite(params.handle)) {
    throw new Error(
      `buildPreviewStopXmlV11: handle must be finite, got: ${params.handle}`,
    );
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
export function buildPtzControlXml(
  channelId: number,
  command: string,
  speed: number,
): string {
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
export function buildPtzPresetXml(
  channelId: number,
  presetId: number,
  command: "setPos" | "toPos",
  name?: string,
): string {
  return buildPtzPresetXmlV2(
    channelId,
    presetId,
    command,
    name === undefined ? undefined : { name },
  );
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
  },
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
export function buildStartZoomFocusXml(
  channelId: number,
  movePos: number,
): string {
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
export function buildSirenManualXml(
  channelId: number | undefined,
  enable: number,
): string {
  const channelXml =
    channelId !== undefined ? `<channelId>${channelId}</channelId>` : "";
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
 *
 * @param channelId - Channel ID (1-based, optional for hub-level)
 * @param times - Number of times to play
 * @returns XML string for audioPlayInfo element
 */
export function buildSirenTimesXml(
  channelId: number | undefined,
  times: number,
): string {
  const channelXml =
    channelId !== undefined ? `<channelId>${channelId}</channelId>` : "";
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
export function buildFloodlightManualXml(
  channelId: number,
  status: number,
  durationSeconds = 180,
): string {
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
export function buildWhiteLedStateXml(
  channelId: number,
  state: number,
): string {
  return buildFloodlightManualXml(channelId, state ? 1 : 0);
}

// ====================================================================
// Read-modify-write helpers for Baichuan binary settings setters.
//
// Reolink firmwares are XML-strict — they reject payloads that drop
// unmodified attributes or reorder elements. The setX methods on
// `ReolinkBaichuanApi` follow reolink_aio's pattern: read the current
// XML, mutate only the targeted tag(s) via regex, and write the same
// document back. These helpers encapsulate the regex churn so each
// setter stays a one-liner.
// ====================================================================

const XML_HEADER = `<?xml version="1.0" encoding="UTF-8" ?>`;

/**
 * Prepend the XML declaration if the body doesn't already start with
 * one. Reolink rejects payloads without it on most setX commands.
 */
export function ensureXmlHeader(xml: string): string {
  const trimmed = xml.trimStart();
  if (trimmed.startsWith("<?xml")) return xml;
  return `${XML_HEADER}\n${xml}`;
}

/**
 * Replace the text content of `<tag>...</tag>` (first match) with the
 * stringified value. No-op when `value` is undefined — lets callers
 * pass partial patches without branching at every field.
 */
export function applyXmlTagPatch(
  xml: string,
  tag: string,
  value: string | number | boolean | undefined,
): string {
  if (value === undefined) return xml;
  const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
  const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
  return xml.replace(re, `<${tag}>${v}</${tag}>`);
}

/**
 * Patch a child tag inside a named parent block. Used for nested
 * structures like `<DayNight><mode>...</mode></DayNight>` where the
 * same `<mode>` tag appears under multiple parents.
 */
export function patchNestedTag(
  xml: string,
  parent: string,
  child: string,
  value: string | number | boolean | undefined,
): string {
  if (value === undefined) return xml;
  const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
  // Match <parent>…<child>...</child>…</parent>, keep everything else.
  const re = new RegExp(
    `(<${parent}[^>]*>[\\s\\S]*?<${child}>)[^<]*(</${child}>[\\s\\S]*?</${parent}>)`,
  );
  return xml.replace(re, `$1${v}$2`);
}

/**
 * Patch one or more fields inside an `<Enc>` stream block
 * (`<mainStream>` or `<subStream>`). Used by `setEnc` —
 * Reolink emits both blocks in the same document so a per-block scope
 * is needed to avoid clobbering the wrong stream.
 */
export function applyStreamPatch(
  xml: string,
  streamTag: "mainStream" | "subStream",
  patch:
    | {
        bitRate?: number;
        frameRate?: number;
        videoEncType?: "h264" | "h265";
      }
    | undefined,
): string {
  if (!patch) return xml;
  const re = new RegExp(
    `(<${streamTag}[^>]*>)([\\s\\S]*?)(</${streamTag}>)`,
  );
  return xml.replace(re, (_match, open: string, body: string, close: string) => {
    let next = body;
    if (patch.bitRate !== undefined) {
      next = applyXmlTagPatch(next, "bitRate", patch.bitRate);
    }
    if (patch.frameRate !== undefined) {
      // The Enc block uses `<frameRate>` for the value but reolink_aio
      // also patches `<frame>` (older firmwares). Cover both — no-op
      // if only one is present.
      next = applyXmlTagPatch(next, "frameRate", patch.frameRate);
      next = applyXmlTagPatch(next, "frame", patch.frameRate);
    }
    if (patch.videoEncType !== undefined) {
      const intVal = patch.videoEncType === "h265" ? 1 : 0;
      next = applyXmlTagPatch(next, "videoEncType", intVal);
    }
    return `${open}${next}${close}`;
  });
}

/**
 * Normalize human-friendly day/night labels to the camera's expected
 * lowercase form. Mirrors reolink_aio's `SetIsp` post-processing
 * (`& → And`, capitalize first letter).
 */
export function normalizeDayNightMode(input: string): string {
  const stripped = String(input).replace(/&/g, "And");
  if (!stripped) return stripped;
  const first = stripped[0];
  if (first === undefined) return stripped;
  return first.toLowerCase() + stripped.slice(1);
}

/**
 * Normalize "On"/"Off" / "open"/"close" / boolean-ish inputs to the
 * `open`/`close` enum the camera expects on LED-control commands.
 */
export function normalizeOpenClose(input: string): string {
  const v = String(input).toLowerCase();
  if (v === "on" || v === "open" || v === "1" || v === "true") return "open";
  return "close";
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
