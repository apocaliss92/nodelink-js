import type { AIEvent, ReolinkEvent, ReolinkSimpleEvent, ReolinkSimpleEventType } from "../types";

export const mapToSimpleEvent = (event: ReolinkEvent): ReolinkSimpleEvent | null => {
  const timestamp = event.timestamp ?? Date.now();

  if (event.type === "motion") {
    return { type: "motion", channel: event.channel, timestamp, source: "baichuan" };
  }

  if (event.type === "visitor") {
    return { type: "doorbell", channel: event.channel, timestamp, source: "baichuan" };
  }

  if (event.type === "daynight") {
    return { type: "daynight", channel: event.channel, timestamp, source: "baichuan" };
  }

  if (event.type === "ai") {
    const aiType = event.ai?.type;

    const map: Record<NonNullable<AIEvent["type"]>, ReolinkSimpleEventType> = {
      people: "people",
      vehicle: "vehicle",
      dog_cat: "animal",
      face: "face",
      package: "package",
      other: "other",
    };

    return {
      type: aiType ? map[aiType] : "other",
      channel: event.channel,
      timestamp,
      source: "baichuan",
    };
  }

  return null;
};

/**
 * Whether a sleep-push event source should be accepted given the user's
 * preference (`auto` / `webhook` / `email`) and HaCfg probe result.
 *
 * Native `baichuan` (and unknown/omitted source) always pass — only the
 * Email Push vs HaCfg webhook pair is filtered to avoid duplicates.
 */
export const shouldAcceptSleepPushSource = (
  source: ReolinkSimpleEvent["source"],
  preference: "auto" | "webhook" | "email" | string | undefined,
  webhookSupported: boolean,
): boolean => {
  if (source !== "email" && source !== "baichuanWebhook") return true;
  const pref =
    preference === "webhook" || preference === "email" ? preference : "auto";
  const preferWebhook =
    pref === "webhook" || (pref === "auto" && webhookSupported);
  return preferWebhook ? source === "baichuanWebhook" : source === "email";
};
