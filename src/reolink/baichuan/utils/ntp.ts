import type { NtpConfig, NtpConfigPatch } from "../types";
import { ensureXmlHeader, getXmlText, xmlEscape } from "../../../protocol/xml";

const parseNumberSafe = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

const parseInt01 = (text: string | undefined): 0 | 1 | undefined => {
  if (text === undefined) return undefined;
  return text.trim() === "1" ? 1 : 0;
};

/**
 * Parse the `<Ntp>` block returned by GetNtp (cmdId=38).
 */
export function parseNtpConfigFromXml(xml: string): NtpConfig {
  return {
    enable: parseInt01(getXmlText(xml, "enable")) ?? 0,
    server: getXmlText(xml, "server") ?? "",
    synchronizeInterval:
      parseNumberSafe(getXmlText(xml, "synchronizeInterval")) ?? 1440,
    port: parseNumberSafe(getXmlText(xml, "port")) ?? 123,
  };
}

/**
 * Build the SetNtp XML body (cmdId=39). Reolink expects the full `<Ntp>`
 * block — patch is merged onto the current config by the caller.
 */
export function buildSetNtpXml(current: NtpConfig, patch: NtpConfigPatch): string {
  const merged: NtpConfig = { ...current, ...patch };
  return ensureXmlHeader(
    `<body>` +
      `<Ntp version="1.1">` +
      `<enable>${merged.enable}</enable>` +
      `<server>${xmlEscape(merged.server)}</server>` +
      `<synchronizeInterval>${merged.synchronizeInterval}</synchronizeInterval>` +
      `<port>${merged.port}</port>` +
      `</Ntp>` +
      `</body>`,
  );
}
