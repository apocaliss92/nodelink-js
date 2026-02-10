import { getXmlText } from "../../../protocol/xml";
import type { Logger } from "../../../debug/DebugConfig";
import type {
  ChannelStreamMetadata,
  StreamMetadata,
  VideoCodec,
} from "../types";

const videoCodecMap: Record<number, VideoCodec> = {
  0: "H.264",
  1: "H.265",
  2: "MJPEG",
  3: "MPEG4",
};

const isEnabledFromText = (enableText: string | undefined): boolean => {
  return (
    enableText === undefined || enableText === "1" || enableText === "true"
  );
};

const isPlausibleStream = (s: {
  width: number;
  height: number;
  frameRate: number;
  bitRate: number;
}): boolean => {
  return s.width > 0 && s.height > 0 && (s.frameRate > 0 || s.bitRate > 0);
};

const logDebugStreamBlock = (params: {
  logger: Logger;
  traceNativeStream: boolean;
  channel: number;
  tag: string;
  blockXml: string | undefined;
}): void => {
  const { logger, traceNativeStream, channel, tag, blockXml } = params;
  if (!traceNativeStream) return;

  if (!blockXml) {
    (logger.warn ?? logger.log).call(
      logger,
      `[ReolinkBaichuanApi] getStreamMetadata(traceNativeStream): channel=${channel} tag=<${tag}> missing`,
    );
    return;
  }

  const raw = blockXml;
  const widthText = getXmlText(raw, "width") ?? getXmlText(raw, "Width");
  const heightText = getXmlText(raw, "height") ?? getXmlText(raw, "Height");
  const frameText = getXmlText(raw, "frame") ?? getXmlText(raw, "Frame");
  const bitRateText = getXmlText(raw, "bitRate") ?? getXmlText(raw, "BitRate");
  const videoEncTypeText =
    getXmlText(raw, "videoEncType") ?? getXmlText(raw, "VideoEncType");
  const audioText = getXmlText(raw, "audio") ?? getXmlText(raw, "Audio");
  const enableCheckRaw = raw.replace(/<smartH265[\s\S]*?<\/smartH265>/g, "");
  const enableText = getXmlText(enableCheckRaw, "enable") ?? getXmlText(enableCheckRaw, "Enable");

  const width = Number(widthText ?? "0");
  const height = Number(heightText ?? "0");
  const frameRate = Number(frameText ?? "0");
  const bitRate = Number(bitRateText ?? "0");
  const audio = Number(audioText ?? "0");
  const isEnabled = isEnabledFromText(enableText);
  const plausible =
    isEnabled && isPlausibleStream({ width, height, frameRate, bitRate });

  const previewMax = 1400;
  const xmlPreview =
    raw.length <= previewMax
      ? raw
      : raw.slice(0, previewMax) +
        `\n...truncated (+${raw.length - previewMax} chars)`;

  (logger.warn ?? logger.log).call(
    logger,
    `[ReolinkBaichuanApi] getStreamMetadata(traceNativeStream): channel=${channel} tag=<${tag}> ` +
      `enabled=${isEnabled} plausible=${plausible} ` +
      `width=${width} height=${height} frame=${frameRate} bitRate=${bitRate} audio=${audio} videoEncType=${videoEncTypeText ?? "?"} ` +
      `rawFields=${JSON.stringify({ widthText, heightText, frameText, bitRateText, videoEncTypeText, audioText, enableText })} ` +
      `blockXml=${JSON.stringify(xmlPreview)}`,
  );
};

const buildStream = (params: {
  profile: StreamMetadata["profile"];
  streamXml: string;
}): StreamMetadata | undefined => {
  const { profile, streamXml } = params;

  const width = Number(getXmlText(streamXml, "width") ?? "0");
  const height = Number(getXmlText(streamXml, "height") ?? "0");
  const videoEncTypeInt = Number(getXmlText(streamXml, "videoEncType") ?? "0");
  const frameRate = Number(getXmlText(streamXml, "frame") ?? "0");
  const bitRate = Number(getXmlText(streamXml, "bitRate") ?? "0");
  const audio = Number(getXmlText(streamXml, "audio") ?? "0");

  // Strip nested blocks that contain their own <enable> child tags
  // (e.g. <smartH265><enable>0</enable>...</smartH265>) to prevent them
  // from being mistakenly matched as the stream-level enable flag.
  const enableXml = streamXml.replace(/<smartH265[\s\S]*?<\/smartH265>/g, "");
  const enabled = getXmlText(enableXml, "enable");
  const isEnabled = isEnabledFromText(enabled);

  if (!isEnabled || !isPlausibleStream({ width, height, frameRate, bitRate }))
    return undefined;

  return {
    profile,
    audio,
    width,
    height,
    videoEncType:
      videoCodecMap[videoEncTypeInt] ?? `Unknown(${videoEncTypeInt})`,
    videoEncTypeInt,
    frameRate,
    bitRate,
    audioCodec: "aac",
  };
};

export const parseChannelStreamMetadataFromGetEncXml = (params: {
  channel: number;
  xml: string;
  logger: Logger;
  traceNativeStream?: boolean;
}): ChannelStreamMetadata => {
  const { channel, xml, logger } = params;
  const traceNativeStream = params.traceNativeStream === true;

  const streams: StreamMetadata[] = [];
  let audioEnabled = true;

  if (traceNativeStream) {
    const headMax = 1600;
    const xmlHead =
      xml.length <= headMax
        ? xml
        : xml.slice(0, headMax) +
          `\n...truncated (+${xml.length - headMax} chars)`;
    const tagsPresent = {
      mainStream: /<mainStream\b/.test(xml),
      subStream: /<subStream\b/.test(xml),
      extStream: /<extStream\b/.test(xml),
      thirdStream: /<thirdStream\b/.test(xml),
      externStream: /<externStream\b/.test(xml),
      extraStream: /<extraStream\b/.test(xml),
    };
    (logger.warn ?? logger.log).call(
      logger,
      `[ReolinkBaichuanApi] getStreamMetadata(traceNativeStream): channel=${channel} xmlLen=${xml.length} tagsPresent=${JSON.stringify(tagsPresent)} xmlHead=${JSON.stringify(xmlHead)}`,
    );
  }

  const mainMatch = xml.match(/<mainStream[^>]*>([\s\S]*?)<\/mainStream>/);
  if (mainMatch) {
    const mainXml = mainMatch[1] ?? "";
    logDebugStreamBlock({
      logger,
      traceNativeStream,
      channel,
      tag: "mainStream",
      blockXml: mainXml,
    });
    const s = buildStream({ profile: "main", streamXml: mainXml });
    if (s) {
      streams.push(s);
      audioEnabled = audioEnabled && s.audio === 1;
    }
  }

  const subMatch = xml.match(/<subStream[^>]*>([\s\S]*?)<\/subStream>/);
  if (subMatch) {
    const subXml = subMatch[1] ?? "";
    logDebugStreamBlock({
      logger,
      traceNativeStream,
      channel,
      tag: "subStream",
      blockXml: subXml,
    });
    const s = buildStream({ profile: "sub", streamXml: subXml });
    if (s) {
      streams.push(s);
      audioEnabled = audioEnabled && s.audio === 1;
    }
  }

  const extLikeTags = [
    "extStream",
    "thirdStream",
    "externStream",
    "extraStream",
  ];
  let extTagFound: string | undefined;
  for (const tag of extLikeTags) {
    const extMatch = xml.match(
      new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`),
    );
    if (!extMatch) continue;

    extTagFound = tag;
    const extXml = extMatch[1] ?? "";
    logDebugStreamBlock({
      logger,
      traceNativeStream,
      channel,
      tag,
      blockXml: extXml,
    });
    const s = buildStream({ profile: "ext", streamXml: extXml });
    if (s) {
      streams.push(s);
      audioEnabled = audioEnabled && s.audio === 1;
    }

    break;
  }

  return {
    channel,
    streams,
    audioEnabled,
    rawXml: xml,
  };
};
