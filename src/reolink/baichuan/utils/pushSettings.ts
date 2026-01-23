import { getXmlText } from "../../../protocol/xml";
import { getXmlBlocks } from "../xmlUtils";
import { parseBoolean01, parseNumber } from "./parsing";
import { parseXmlToJson } from "./xml";
import type {
  BaichuanCoordinatePointListPush,
  BaichuanDingdongListPush,
  BaichuanNetInfoPush,
  BaichuanSerialPush,
  BaichuanSleepStatusPush,
  BaichuanVideoInputPush,
} from "../types";

export const parseVideoInputPushXml = (xml: string): BaichuanVideoInputPush => {
  const channelId = parseNumber(getXmlText(xml, "channelId"));
  const bright = parseNumber(getXmlText(xml, "bright"));
  const contrast = parseNumber(getXmlText(xml, "contrast"));
  const saturation = parseNumber(getXmlText(xml, "saturation"));
  const hue = parseNumber(getXmlText(xml, "hue"));
  const sharpen = parseNumber(getXmlText(xml, "sharpen"));
  const corridorAbility = parseNumber(getXmlText(xml, "corridorAbility"));
  const corridorMode = getXmlText(xml, "corridorMode")?.trim();

  return {
    ...(channelId != null ? { channelId } : {}),
    ...(bright != null ? { bright } : {}),
    ...(contrast != null ? { contrast } : {}),
    ...(saturation != null ? { saturation } : {}),
    ...(hue != null ? { hue } : {}),
    ...(sharpen != null ? { sharpen } : {}),
    ...(corridorAbility != null ? { corridorAbility } : {}),
    ...(corridorMode ? { corridorMode } : {}),
  };
};

export const parseSerialPushXml = (xml: string): BaichuanSerialPush => {
  const channelId = parseNumber(getXmlText(xml, "channelId"));
  const baudRate = parseNumber(getXmlText(xml, "baudRate"));
  const dataBit = getXmlText(xml, "dataBit")?.trim();
  const stopBit = getXmlText(xml, "stopBit")?.trim();
  const parity = getXmlText(xml, "parity")?.trim();
  const flowControl = getXmlText(xml, "flowControl")?.trim();
  const controlProtocol = getXmlText(xml, "controlProtocol")?.trim();
  const controlAddress = parseNumber(getXmlText(xml, "controlAddress"));

  return {
    ...(channelId != null ? { channelId } : {}),
    ...(baudRate != null ? { baudRate } : {}),
    ...(dataBit ? { dataBit } : {}),
    ...(stopBit ? { stopBit } : {}),
    ...(parity ? { parity } : {}),
    ...(flowControl ? { flowControl } : {}),
    ...(controlProtocol ? { controlProtocol } : {}),
    ...(controlAddress != null ? { controlAddress } : {}),
  };
};

export const parseNetInfoPushXml = (xml: string): BaichuanNetInfoPush => {
  const netType = getXmlText(xml, "net_type")?.trim();
  const signal = parseNumber(getXmlText(xml, "signal"));
  return {
    ...(netType ? { netType } : {}),
    ...(signal != null ? { signal } : {}),
  };
};

export const parseDingdongListPushXml = (
  xml: string,
): BaichuanDingdongListPush => {
  const pairedListBlock = getXmlBlocks(xml, "pairedList")[0];

  // Best-effort count: count direct child "item" blocks when present.
  const pairedCount = pairedListBlock
    ? getXmlBlocks(pairedListBlock, "item").length
    : 0;

  const maxPairNumber = parseNumber(getXmlText(xml, "maxPairNumber"));
  const channel = parseNumber(getXmlText(xml, "channel"));
  const pairedList = pairedListBlock
    ? parseXmlToJson(pairedListBlock)
    : undefined;

  return {
    ...(maxPairNumber != null ? { maxPairNumber } : {}),
    ...(channel != null ? { channel } : {}),
    ...(Number.isFinite(pairedCount) ? { pairedCount } : {}),
    ...(pairedList != null ? { pairedList } : {}),
  };
};

export const parseSleepStatusPushXml = (
  xml: string,
): BaichuanSleepStatusPush => {
  const rawSleep = parseNumber(getXmlText(xml, "sleep"));
  const statusListBlock = getXmlBlocks(xml, "statusList")[0];

  const sleep =
    rawSleep != null ? rawSleep > 0 : parseBoolean01(getXmlText(xml, "sleep"));

  return {
    ...(rawSleep != null ? { rawSleep } : {}),
    ...(sleep != null ? { sleep } : {}),
    statusListPresent: statusListBlock != null,
  };
};

export const parseCoordinatePointListPushXml = (
  xml: string,
): BaichuanCoordinatePointListPush => {
  // No rich samples yet in our corpus; parse any <coordinatePoint> blocks if present.
  const pointBlocks = getXmlBlocks(xml, "coordinatePoint");
  const points = pointBlocks
    .map((b) => {
      const x = parseNumber(getXmlText(b, "x"));
      const y = parseNumber(getXmlText(b, "y"));
      if (x == null || y == null) return undefined;
      return { x, y };
    })
    .filter((p): p is { x: number; y: number } => p != null);

  return {
    count: points.length,
    ...(points.length ? { points } : {}),
  };
};
