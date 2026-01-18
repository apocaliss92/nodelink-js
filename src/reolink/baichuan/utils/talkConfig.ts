import type { BaichuanClient } from "../../../client/BaichuanClient";
import {
  BC_CLASS_MODERN_24,
  BC_CMD_ID_TALK_CONFIG,
  BC_CMD_ID_TALK_RESET,
} from "../../../protocol/constants";
import type { TalkAbility, TalkConfig, TalkSessionInfo } from "../types";
import { buildTalkConfigPayloadXml } from "./talk";

export const buildTalkSessionInfoFromAbility = (params: {
  channel: number;
  ability: TalkAbility;
}): { payloadXml: string; info: TalkSessionInfo } => {
  const audioConfig =
    params.ability.audioConfigList.find((c) => c.audioType.toLowerCase() === "adpcm") ??
    params.ability.audioConfigList[0];

  if (!audioConfig) {
    throw new Error(`Talk not supported on channel ${params.channel} (no audioConfig in TalkAbility)`);
  }

  const talkConfig: TalkConfig = {
    channel: params.channel,
    duplex: params.ability.duplexList[0] ?? "FDX",
    audioStreamMode: params.ability.audioStreamModeList[0] ?? "followVideoStream",
    audioConfig,
  };

  const blockSize = Math.floor(audioConfig.lengthPerEncoder / 2);
  const fullBlockSize = blockSize + 4;
  if (blockSize <= 0 || fullBlockSize <= 4) {
    throw new Error(`Invalid talk audio config: lengthPerEncoder=${audioConfig.lengthPerEncoder}`);
  }

  return {
    payloadXml: buildTalkConfigPayloadXml(talkConfig),
    info: {
      channel: params.channel,
      audioConfig,
      blockSize,
      fullBlockSize,
    },
  };
};

export const sendTalkConfigWithReset = async (params: {
  client: Pick<BaichuanClient, "sendFrame">;
  channel: number;
  payloadXml: string;
  channelIdOverride?: number;
}): Promise<void> => {
  const trySend = async (): Promise<number> => {
    const frame = await params.client.sendFrame({
      cmdId: BC_CMD_ID_TALK_CONFIG,
      channel: params.channel,
      ...(params.channelIdOverride != null ? { channelIdOverride: params.channelIdOverride } : {}),
      payloadXml: params.payloadXml,
      messageClass: BC_CLASS_MODERN_24,
    });
    return frame.header.responseCode;
  };

  const code = await trySend();
  if (code === 422) {
    await params.client.sendFrame({
      cmdId: BC_CMD_ID_TALK_RESET,
      channel: params.channel,
      ...(params.channelIdOverride != null ? { channelIdOverride: params.channelIdOverride } : {}),
      payloadXml: "",
      messageClass: BC_CLASS_MODERN_24,
    });

    const retryCode = await trySend();
    if (retryCode !== 200) {
      throw new Error(`TalkConfig rejected after reset (responseCode ${retryCode})`);
    }
    return;
  }

  if (code !== 200) {
    throw new Error(`TalkConfig rejected (responseCode ${code})`);
  }
};
