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

export type ShouldAcceptSleepPushOptions = {
  webhookSupported: boolean;
  /**
   * Set after the first non-empty HaCfg delivery (wake/cmd33) has been
   * processed. In `auto` mode email is kept until then so a successful
   * cmd 806 probe alone cannot silence motion before webhook events work.
   */
  webhookDeliverySeen?: boolean;
};

/**
 * Whether a sleep-push event source should be accepted given the user's
 * preference (`auto` / `webhook` / `email`) and HaCfg probe/delivery state.
 *
 * Native `baichuan` (and unknown/omitted source) always pass — only the
 * Email Push vs HaCfg webhook pair is filtered to avoid duplicates.
 */
export const shouldAcceptSleepPushSource = (
  source: ReolinkSimpleEvent["source"],
  preference: "auto" | "webhook" | "email" | string | undefined,
  options: ShouldAcceptSleepPushOptions | boolean,
): boolean => {
  if (source !== "email" && source !== "baichuanWebhook") return true;
  const opts: ShouldAcceptSleepPushOptions =
    typeof options === "boolean"
      ? {
          webhookSupported: options,
          // Legacy boolean callers treated "supported" as "prefer webhook now".
          webhookDeliverySeen: options,
        }
      : options;
  const pref =
    preference === "webhook" || preference === "email" ? preference : "auto";

  if (pref === "email") return source === "email";
  if (pref === "webhook") return source === "baichuanWebhook";

  // auto
  if (!opts.webhookSupported) return source === "email";
  if (opts.webhookDeliverySeen) return source === "baichuanWebhook";
  // Probe succeeded but no real HaCfg POST yet — accept both.
  return true;
};
