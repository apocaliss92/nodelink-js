import { XMLParser } from "fast-xml-parser";

export type XmlJsonPrimitive = string | number | boolean | null;
export type XmlJsonValue = XmlJsonPrimitive | XmlJsonObject | XmlJsonValue[];
export type XmlJsonObject = { [key: string]: XmlJsonValue };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: true,
  parseAttributeValue: true,
  allowBooleanAttributes: true,
});

export function parseXmlToJson<T extends XmlJsonValue = XmlJsonValue>(
  xml: string,
): T {
  // fast-xml-parser returns `any`; we expose a JSON-friendly type.
  return parser.parse(xml) as T;
}

function stripXmlDeclaration(xml: string): string {
  return String(xml ?? "")
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, "")
    .trim();
}

/**
 * Baichuan often returns XML fragments (multiple top-level tags).
 * This wraps the payload into a synthetic root so it can be parsed reliably.
 */
export function parseXmlFragmentToJson<T = XmlJsonValue>(xml: string): T {
  const payload = stripXmlDeclaration(xml);
  if (!payload) return {} as T;

  const wrapped = `<root>${payload}</root>`;
  const parsed = parser.parse(wrapped) as { root: T };
  return parsed.root;
}

export function safeParseXmlToJson<T extends XmlJsonValue = XmlJsonValue>(
  xml: string,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseXmlToJson<T>(xml) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
