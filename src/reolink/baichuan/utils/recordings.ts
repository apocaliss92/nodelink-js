import { wallClockParts } from "./wallClock";

export const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `<startTime>`/`<endTime>` block for a recordings request. The camera reads
 * the values as ITS wall clock; `timeZone` (IANA) says whose wall clock we
 * write, host local when omitted (see `utils/wallClock.ts`).
 */
export const xmlDateTimePayload = (
  tag: "startTime" | "endTime",
  d: Date,
  timeZone?: string,
): string => {
  const p = wallClockParts(d, timeZone);
  return `<${tag}><year>${p.year}</year><month>${p.month}</month><day>${p.day}</day><hour>${p.hour}</hour><minute>${p.minute}</minute><second>${p.second}</second></${tag}>`;
};
