import { BC_CMD_ID_GET_AI_ALARM } from "../../../protocol/constants";
import { getXmlText, xmlEscape } from "../../../protocol/xml";
import type { AIState } from "../types";
import { formatErrorForLog } from "./logging";

export type SendXmlLike = (
  params: {
    cmdId: number;
    channel?: number;
    payloadXml?: string;
    channelIdOverride?: number;
  },
  retry?: number,
) => Promise<string>;

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

/**
 * Probe cmd_id=342 (GetAiAlarm) per AI type to derive a coarse support flag.
 *
 * The cmd_id=342 response is `<AiDetectCfg>` with sensitivity, stayTime,
 * min/maxTarget* and a base64 area mask — it does NOT carry an
 * `<alarm_state>` or `<support>` tag. The live alarm state is delivered
 * via push events on `<AlarmEventList>` (cmd_id=33), and per-AI-type
 * capability is exposed via `<AbilitySuppport>` (cmd_id=58).
 *
 * For backwards-compat we keep returning `AIState` here, with:
 *   - `support = 1` when the camera returned a valid `<AiDetectCfg>`
 *     for at least one of the probed types (= the camera supports AI
 *     detection on this channel),
 *   - `alarm_state = 0` always (use `onSimpleEvent` for the real alarm
 *     transitions instead).
 */
export const getAiStateViaGetAiAlarm = async (params: {
  sendXml: SendXmlLike;
  channel: number;
  candidateTypes?: string[];
}): Promise<AIState> => {
  const cmdId = BC_CMD_ID_GET_AI_ALARM;
  const ch = params.channel;

  const defaultCandidateTypes = [
    "people",
    "vehicle",
    "dog_cat",
    "face",
    "package",
  ] as const;
  const candidateTypes =
    params.candidateTypes && params.candidateTypes.length > 0
      ? params.candidateTypes
      : [...defaultCandidateTypes];
  let lastErr: unknown;

  const tryOnce = async (
    type: string,
    channelIdOverride?: number,
  ): Promise<string> => {
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

  const isSupportedResponse = (xml: string): boolean => {
    // A configured camera ships <AiDetectCfg> with at least <type> filled.
    return /<AiDetectCfg[\s>]/i.test(xml) && getXmlText(xml, "type") != null;
  };

  for (const type of candidateTypes) {
    try {
      const xml = await tryOnce(type, ch);
      if (xml && isSupportedResponse(xml)) {
        return { channel: ch, alarm_state: 0, support: 1 };
      }
    } catch (e) {
      if (looksLikeConnectionDrop(e)) throw e;
      lastErr = e;
    }
  }

  for (const type of candidateTypes) {
    try {
      const xml = await tryOnce(type, undefined);
      if (xml && isSupportedResponse(xml)) {
        return { channel: ch, alarm_state: 0, support: 1 };
      }
    } catch (e) {
      if (looksLikeConnectionDrop(e)) throw e;
      lastErr = e;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "getAiState failed"));
};
