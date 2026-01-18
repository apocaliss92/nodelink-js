import type { AIEvent, ReolinkEvent, ReolinkSimpleEvent, ReolinkSimpleEventType } from "../types";

export const mapToSimpleEvent = (event: ReolinkEvent): ReolinkSimpleEvent | null => {
  const timestamp = event.timestamp ?? Date.now();

  if (event.type === "motion") {
    return { type: "motion", channel: event.channel, timestamp };
  }

  if (event.type === "visitor") {
    return { type: "doorbell", channel: event.channel, timestamp };
  }

  if (event.type === "daynight") {
    return { type: "daynight", channel: event.channel, timestamp };
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
    };
  }

  return null;
};
