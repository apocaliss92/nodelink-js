import { getXmlText } from "../../../protocol/xml";
import type { Events } from "../types";

const parseAiTypeToken = (aiTypeRaw: string | undefined): string | undefined => {
  const raw = (aiTypeRaw ?? "").trim();
  if (!raw) return undefined;

  const token = raw
    .split(",")
    .map((t) => t.trim())
    .find((t) => t.length > 0 && t.toLowerCase() !== "none");

  return token;
};

export const parseEventsFromGetEventsXml = (params: { xml: string; channel: number; nowMs: number }): Events => {
  const { xml, channel: ch, nowMs } = params;

  const out: Events = { channel: ch };

  const applyEvent = (eventXml: string, eventChannel: number): void => {
    if (eventChannel !== ch) return;

    const statusUpper = ((getXmlText(eventXml, "status") ?? "").trim()).toUpperCase();
    const aiTypeRaw = (
      getXmlText(eventXml, "AItype") ??
      getXmlText(eventXml, "aiType") ??
      getXmlText(eventXml, "aitype") ??
      ""
    ).trim();

    if (statusUpper.includes("MD")) {
      out.motion = { state: 1, timestamp: nowMs, source: "md" };
    }
    if (statusUpper.includes("PIR")) {
      out.motion = { state: 1, timestamp: nowMs, source: "pir" };
    }

    const aiTypeToken = parseAiTypeToken(aiTypeRaw);
    if (aiTypeToken || statusUpper.includes("AI")) {
      out.ai = {
        channel: ch,
        alarm_state: 1,
        ...(aiTypeToken ? { type: aiTypeToken } : {}),
      };
    }

    if (statusUpper.includes("VIS")) {
      out.visitor = { detected: true, timestamp: nowMs };
    }
  };

  // Format: AlarmEventList
  if (xml.includes("<AlarmEventList")) {
    const alarmEventMatches = xml.matchAll(/<AlarmEvent\b[^>]*>([\s\S]*?)<\/AlarmEvent>/g);
    for (const match of alarmEventMatches) {
      const alarmXml = match[1] ?? "";
      const channelText = getXmlText(alarmXml, "channelId");
      const eventChannel = channelText !== undefined ? Number(channelText) : ch;
      applyEvent(alarmXml, eventChannel);
    }
    return out;
  }

  // Fallback: Event
  applyEvent(xml, ch);
  return out;
};
