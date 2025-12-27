export function xmlEscape(text: string): string {
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

export function buildChannelExtensionXml(channelId: number): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<channelId>${channelId}</channelId>
</Extension>`;
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

