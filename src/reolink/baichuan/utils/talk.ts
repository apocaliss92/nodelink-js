import { xmlEscape } from "../../../protocol/xml";
import type { TalkConfig } from "../types";

export const buildTalkConfigPayloadXml = (config: TalkConfig): string => {
  const audio = config.audioConfig;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<TalkConfig version="1.1">
<channelId>${config.channel}</channelId>
<duplex>${xmlEscape(config.duplex)}</duplex>
<audioStreamMode>${xmlEscape(config.audioStreamMode)}</audioStreamMode>
<audioConfig>
<audioType>${xmlEscape(audio.audioType)}</audioType>
<sampleRate>${audio.sampleRate}</sampleRate>
<samplePrecision>${audio.samplePrecision}</samplePrecision>
<lengthPerEncoder>${audio.lengthPerEncoder}</lengthPerEncoder>
<soundTrack>${xmlEscape(audio.soundTrack)}</soundTrack>
</audioConfig>
</TalkConfig>
</body>`;
};

export const encodeBcMediaAdpcmBlock = (block: Buffer, halfBlockSize: number): Buffer => {
  // Matches parseAdpcm in src/baichuan/stream/BcMediaParser.ts
  // magic(4) + payload_size(u16) + payload_size_b(u16) + magic_data(u16=0x0100) + half_block_size(u16) + data + padding
  const magic = 0x62773130; // "bw10"
  const subHeaderSize = 4;
  const payloadSize = subHeaderSize + block.length;
  const headerLen = 12;
  const padSize = payloadSize % 8 === 0 ? 0 : 8 - (payloadSize % 8);
  const totalLen = headerLen + block.length + padSize;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32LE(magic, 0);
  buf.writeUInt16LE(payloadSize, 4);
  buf.writeUInt16LE(payloadSize, 6);
  buf.writeUInt16LE(0x0100, 8);
  buf.writeUInt16LE(halfBlockSize, 10);
  block.copy(buf, 12);

  return buf;
};
