import { getXmlText } from "../../../protocol/xml";

export type AbilityInfoResult = Partial<Record<number | "Host", Record<string, number | string | undefined>>>;

export const parseAbilityInfoXml = (xml: string): AbilityInfoResult => {
  const abilities: AbilityInfoResult = {};

  const tokenSections = [
    "system",
    "streaming",
    "PTZ",
    "IO",
    "security",
    "replay",
    "disk",
    "network",
    "alarm",
    "record",
    "video",
    "image",
  ];

  for (const tokenSection of tokenSections) {
    const sectionRegex = new RegExp(`<${tokenSection}[^>]*>([\\s\\S]*?)<\\/${tokenSection}>`, "i");
    const sectionMatch = xml.match(sectionRegex);

    if (!sectionMatch) continue;

    const sectionXml = sectionMatch[1] ?? "";
    const subModuleMatches = sectionXml.matchAll(/<subModule[^>]*>([\s\S]*?)<\/subModule>/g);

    for (const match of subModuleMatches) {
      const subModuleXml = match[1] ?? "";
      const channelIdText = getXmlText(subModuleXml, "channelId") || getXmlText(subModuleXml, "chnID");
      const abilityValue = getXmlText(subModuleXml, "abilityValue");

      if (!abilityValue) continue;

      const channelKey: number | "Host" = channelIdText ? Number(channelIdText) : "Host";
      if (!abilities[channelKey]) abilities[channelKey] = {};

      const capabilities = abilityValue
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

      for (const capability of capabilities) {
        abilities[channelKey]![capability] = 1;
      }
    }
  }

  const abilityInfoMatch = xml.match(/<AbilityInfo[^>]*>([\s\S]*?)<\/AbilityInfo>/);
  if (abilityInfoMatch) {
    const abilityInfoXml = abilityInfoMatch[1] ?? "";
    const directChildren = abilityInfoXml.matchAll(/<([A-Za-z]+)[^>]*>([^<]*)<\/\1>/g);

    if (!abilities.Host) abilities.Host = {};

    for (const childMatch of directChildren) {
      const tagName = childMatch[1];
      const textValue = childMatch[2];

      if (!tagName || textValue === undefined) continue;
      if (["image", "video", "subModule"].includes(tagName)) continue;
      if (tagName === "channelId" || tagName === "abilityValue") continue;

      const numValue = Number(textValue);
      abilities.Host![tagName] = Number.isNaN(numValue) ? textValue : numValue;
    }
  }

  if (abilities.Host && Object.keys(abilities.Host).length === 0) {
    delete abilities.Host;
  }

  return abilities;
};
