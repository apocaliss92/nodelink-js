import { getXmlText, xmlEscape } from "../../../protocol/xml";
import type { AIState } from "../types";
import { formatErrorForLog } from "./logging";

export type SendXmlLike = (params: {
  cmdId: number;
  channel?: number;
  payloadXml?: string;
  channelIdOverride?: number;
}, retry?: number) => Promise<string>;

const looksLikeConnectionDrop = (e: unknown): boolean => {
  const msg = formatErrorForLog(e);
  return (
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("socket hang up") ||
    msg.includes("Baichuan socket closed") ||
    msg.includes("timeout")
  );
};

export const getAiStateViaGetAiAlarm = async (params: {
  sendXml: SendXmlLike;
  channel: number;
  candidateTypes?: string[];
}): Promise<AIState> => {
  const cmdId = 342;
  const ch = params.channel;

  const defaultCandidateTypes = ["people", "vehicle", "dog_cat", "face", "package"] as const;
  const candidateTypes = (params.candidateTypes && params.candidateTypes.length > 0)
    ? params.candidateTypes
    : [...defaultCandidateTypes];
  let lastErr: unknown;

  const tryOnce = async (type: string, channelIdOverride?: number): Promise<string> => {
    const payloadXml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<AiDetectCfg version="1.1">` +
      `<chn>${ch}</chn>` +
      `<type>${xmlEscape(type)}</type>` +
      `</AiDetectCfg>` +
      `</body>`;

    return await params.sendXml(
      {
        cmdId,
        channel: ch,
        payloadXml,
        ...(channelIdOverride != null ? { channelIdOverride } : {}),
      },
      0,
    );
  };

  for (const type of candidateTypes) {
    try {
      const xml = await tryOnce(type, ch);
      if (xml) {
        return {
          channel: ch,
          alarm_state: Number(getXmlText(xml, "alarm_state") ?? "0"),
          support: Number(getXmlText(xml, "support") ?? "0"),
        };
      }
    } catch (e) {
      if (looksLikeConnectionDrop(e)) throw e;
      lastErr = e;
    }
  }

  for (const type of candidateTypes) {
    try {
      const xml = await tryOnce(type, undefined);
      if (xml) {
        return {
          channel: ch,
          alarm_state: Number(getXmlText(xml, "alarm_state") ?? "0"),
          support: Number(getXmlText(xml, "support") ?? "0"),
        };
      }
    } catch (e) {
      if (looksLikeConnectionDrop(e)) throw e;
      lastErr = e;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "getAiState failed"));
};
