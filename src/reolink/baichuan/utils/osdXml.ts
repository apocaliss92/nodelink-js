/**
 * Wire codec for the Reolink OSD overlay pair — `GetOsdDatetime` (cmd_id 44)
 * and `SetOsdDatetime` (cmd_id 45).
 *
 * The camera's reply carries two sibling blocks under `<body>`:
 *
 * ```xml
 *   <OsdDatetime>    channelId enable topLeftX topLeftY width height language
 *   <OsdChannelName> channelId name enable topLeftX topLeftY enWatermark enBgcolor
 * ```
 *
 * Note where the watermark lives: **inside `<OsdChannelName>` as
 * `enWatermark`**, not at the top level and not in its own block.
 *
 * Positions are 16.16 normalised coordinates — see `./osdPosition`.
 *
 * `SetOsdDatetime` is a read-modify-write: the camera's own GET reply is
 * patched in place so every field the firmware sent (including extension
 * tags this library does not model) survives the round-trip untouched.
 *
 * These functions are pure so the codec can be tested against raw captured
 * replies without a camera.
 */

import type {
  BaichuanGetOsdDatetimeResult,
  BaichuanOsdChannelName,
  BaichuanOsdDatetime,
  OsdDatetimePatch,
} from "../types";
import { getXmlText } from "../../../protocol/xml";
import { getXmlBlocks } from "../xmlUtils";
import { parseBoolean01, parseNumber } from "./parsing";

/** Parse a raw cmd_id 44 reply body into the modelled overlay pair. */
export function parseOsdDatetimeXml(
  rawXml: string,
): BaichuanGetOsdDatetimeResult {
  const osdBlock = getXmlBlocks(rawXml, "OsdDatetime")[0];
  const nameBlock = getXmlBlocks(rawXml, "OsdChannelName")[0];

  const osdDatetime: BaichuanOsdDatetime | undefined = osdBlock
    ? (() => {
        const channelId = parseNumber(getXmlText(osdBlock, "channelId"));
        const enable = parseBoolean01(getXmlText(osdBlock, "enable"));
        const topLeftX = parseNumber(getXmlText(osdBlock, "topLeftX"));
        const topLeftY = parseNumber(getXmlText(osdBlock, "topLeftY"));
        const width = parseNumber(getXmlText(osdBlock, "width"));
        const height = parseNumber(getXmlText(osdBlock, "height"));
        const language = getXmlText(osdBlock, "language")?.trim();

        return {
          ...(channelId != null ? { channelId } : {}),
          ...(enable != null ? { enable } : {}),
          ...(topLeftX != null ? { topLeftX } : {}),
          ...(topLeftY != null ? { topLeftY } : {}),
          ...(width != null ? { width } : {}),
          ...(height != null ? { height } : {}),
          ...(language ? { language } : {}),
        };
      })()
    : undefined;

  const osdChannelName: BaichuanOsdChannelName | undefined = nameBlock
    ? (() => {
        const channelId = parseNumber(getXmlText(nameBlock, "channelId"));
        const name = getXmlText(nameBlock, "name")?.trim();
        const enable = parseBoolean01(getXmlText(nameBlock, "enable"));
        const topLeftX = parseNumber(getXmlText(nameBlock, "topLeftX"));
        const topLeftY = parseNumber(getXmlText(nameBlock, "topLeftY"));
        const enWatermark = parseBoolean01(getXmlText(nameBlock, "enWatermark"));
        const enBgcolor = parseBoolean01(getXmlText(nameBlock, "enBgcolor"));

        return {
          ...(channelId != null ? { channelId } : {}),
          ...(name ? { name } : {}),
          ...(enable != null ? { enable } : {}),
          ...(topLeftX != null ? { topLeftX } : {}),
          ...(topLeftY != null ? { topLeftY } : {}),
          ...(enWatermark != null ? { enWatermark } : {}),
          ...(enBgcolor != null ? { enBgcolor } : {}),
        };
      })()
    : undefined;

  return {
    ...(osdDatetime ? { osdDatetime } : {}),
    ...(osdChannelName ? { osdChannelName } : {}),
  };
}

function escapeXmlText(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function patchBlock(
  xml: string,
  block: "OsdDatetime" | "OsdChannelName",
  fields: Record<string, unknown>,
): string {
  const start = xml.indexOf(`<${block}`);
  if (start < 0) return xml;
  const end = xml.indexOf(`</${block}>`, start);
  if (end < 0) return xml;
  let body = xml.slice(start, end);
  for (const [tag, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const raw =
      typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    const escaped = escapeXmlText(raw);
    if (body.includes(`<${tag}>`)) {
      body = body.replace(
        new RegExp(`<${tag}>[^<]*<\\/${tag}>`),
        `<${tag}>${escaped}</${tag}>`,
      );
    } else {
      // Tag wasn't in the GET response — append it just before </block>.
      body += `<${tag}>${escaped}</${tag}>`;
    }
  }
  return xml.slice(0, start) + body + xml.slice(end);
}

/**
 * Apply an OSD patch onto the camera's own cmd_id 44 reply, producing the
 * body for cmd_id 45. Untouched fields are copied verbatim — that is the
 * whole point: the firmware rejects (or silently zeroes) a block that omits
 * fields it sent.
 */
export function applyOsdDatetimePatch(
  rawXml: string,
  patch: OsdDatetimePatch,
): string {
  let xml = rawXml;
  if (patch.datetime) {
    xml = patchBlock(xml, "OsdDatetime", {
      enable: patch.datetime.enable,
      topLeftX: patch.datetime.topLeftX,
      topLeftY: patch.datetime.topLeftY,
      language: patch.datetime.language,
    });
  }
  if (patch.channelName) {
    xml = patchBlock(xml, "OsdChannelName", {
      name: patch.channelName.name,
      enable: patch.channelName.enable,
      topLeftX: patch.channelName.topLeftX,
      topLeftY: patch.channelName.topLeftY,
      enWatermark: patch.channelName.enWatermark,
      enBgcolor: patch.channelName.enBgcolor,
    });
  }
  return xml;
}
