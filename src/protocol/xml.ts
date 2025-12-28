export function xmlEscape(text: string | undefined | null): string {
  if (text === undefined || text === null || typeof text !== "string") {
    const error = new Error(`xmlEscape: expected string but got ${typeof text}: ${text}`);
    console.error("[xmlEscape] Error:", error.message);
    console.error("[xmlEscape] Stack:", error.stack);
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
  // Based on neolink stream.rs line 171-189:
  // BcXml has #[serde(rename = "body")], so it serializes as <body>...</body>
  // Preview is inside BcXml, with version as an attribute (@version)
  // IMPORTANT: channelId is NOT in Preview XML - it's handled via channelId in header/extension
  // The working format (response_code 200) is Preview WITHOUT channelId
  // Note: channelId parameter is kept for backward compatibility but not used in XML
  if (!streamType || typeof streamType !== "string") {
    throw new Error(`buildPreviewXml: streamType is required (string) but got: ${typeof streamType} = ${streamType}`);
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<handle>${handle}</handle>
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
  // channelId is NOT in Preview XML - it's handled via channelId in header
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

