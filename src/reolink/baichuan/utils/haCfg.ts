import { getXmlText } from "../../../protocol/xml";

/**
 * Baichuan HaCfg webhook configuration (cmd 806 get / 807 set).
 *
 * The camera POSTs wake/sleep events to `url` when armed. This is independent
 * of the CGI developer webhook (`Support.webhook` / GetWebHook).
 */
export interface HaCfgConfig {
  enable: boolean;
  url: string;
  /** When true the camera verifies TLS certs on HTTPS URLs. Default false. */
  verifyCert: boolean;
}

/** Build the XML payload for Set HaCfg (cmd_id 807). */
export const buildHaCfgXml = (cfg: {
  enable: boolean;
  url: string;
  verifyCert?: boolean;
}): string => {
  const verify = cfg.verifyCert === true ? 1 : 0;
  const enable = cfg.enable ? 1 : 0;
  const url = cfg.enable ? cfg.url : "";
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<HaCfg version="1.1">
<enable>${enable}</enable>
<url>${url}</url>
<verify_cert>${verify}</verify_cert>
</HaCfg>
</body>`;
};

/**
 * Parse a Get HaCfg (cmd 806) response.
 *
 * Returns `undefined` when the body is empty or does not contain `<HaCfg>`
 * (firmwares that do not support Baichuan webhooks often answer 200 + empty).
 */
export const parseHaCfgXml = (xml: string | undefined | null): HaCfgConfig | undefined => {
  const body = (xml ?? "").trim();
  if (!body) return undefined;
  if (!/<HaCfg[\s>]/i.test(body)) return undefined;

  const enableRaw = getXmlText(body, "enable");
  const url = getXmlText(body, "url") ?? "";
  const verifyRaw = getXmlText(body, "verify_cert");

  return {
    enable: enableRaw === "1" || enableRaw?.toLowerCase() === "true",
    url,
    verifyCert: verifyRaw === "1" || verifyRaw?.toLowerCase() === "true",
  };
};

/** True when a cmd 806 response proves HaCfg webhook support. */
export const isHaCfgSupportedResponse = (
  xml: string | undefined | null,
): boolean => parseHaCfgXml(xml) !== undefined;
