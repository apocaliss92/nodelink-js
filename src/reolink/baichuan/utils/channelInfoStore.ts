import type { ReolinkSimpleEvent } from "../types";
import type { ChannelInfoPushEntry } from "./channelInfoPush";

export type ChannelPushData = {
  name: string;
  uid: string;
  state: string;
  index?: number;
  streamSupport?: string[];
  wifiState?: string;
  networkSegment?: string;
  changed?: boolean;
  abilityChanged?: boolean;
  stateLower?: string;
  online?: boolean;
  sleeping?: boolean;
  loginState?: string;
  updatedAtMs: number;
};

const pickBoolean = (next: boolean | undefined, prev: boolean | undefined): boolean | undefined => {
  if (typeof next === "boolean") return next;
  if (typeof prev === "boolean") return prev;
  return undefined;
};

const pickOptionalString = (next: string | undefined, prev: string | undefined): string | undefined => {
  const n = (next ?? "").trim();
  if (n) return next;
  const p = (prev ?? "").trim();
  if (p) return prev;
  return undefined;
};

const pickOptionalArray = <T>(next: T[] | undefined, prev: T[] | undefined): T[] | undefined => {
  if (Array.isArray(next) && next.length > 0) return next;
  if (Array.isArray(prev) && prev.length > 0) return prev;
  return undefined;
};

export const computeChannelPushUpdateFromEntry = (params: {
  entry: ChannelInfoPushEntry;
  existing: ChannelPushData | undefined;
  nowMs: number;
}): { shouldSkip: boolean; next?: ChannelPushData; events: ReolinkSimpleEvent[] } => {
  const { entry, existing, nowMs } = params;
  const events: ReolinkSimpleEvent[] = [];

  if (entry.isNonePlaceholder) {
    const existingStateLower = (existing?.stateLower ?? existing?.state ?? "").toLowerCase();
    if (existingStateLower === "connect") return { shouldSkip: true, events };
    if (!existing) return { shouldSkip: true, events };
  }

  const nextOnline = pickBoolean(entry.inferredOnline, existing?.online);
  if (typeof entry.inferredOnline === "boolean" && existing?.online !== entry.inferredOnline) {
    events.push({
      type: entry.inferredOnline ? "online" : "offline",
      channel: entry.channel,
      timestamp: nowMs,
    });
  }

  const nextSleeping = pickBoolean(entry.inferredSleep, existing?.sleeping);
  if (typeof entry.inferredSleep === "boolean" && existing?.sleeping !== entry.inferredSleep) {
    events.push({
      type: entry.inferredSleep ? "sleeping" : "awake",
      channel: entry.channel,
      timestamp: nowMs,
    });
  }

  const name = entry.name || existing?.name || "";
  const uid = entry.uid || existing?.uid || "";
  const state = entry.state || existing?.state || "";

  const streamSupport = pickOptionalArray(entry.streamSupport, existing?.streamSupport);
  const wifiState = pickOptionalString(entry.wifiState, existing?.wifiState);
  const networkSegment = pickOptionalString(entry.networkSegment, existing?.networkSegment);
  const stateLower = pickOptionalString(entry.stateLower, existing?.stateLower);
  const loginState = pickOptionalString(entry.loginState, existing?.loginState);

  const next: ChannelPushData = {
    name,
    uid,
    state,
    updatedAtMs: nowMs,
    ...(typeof entry.index === "number"
      ? { index: entry.index }
      : existing?.index !== undefined
        ? { index: existing.index }
        : {}),
    ...(streamSupport != null ? { streamSupport } : {}),
    ...(wifiState != null ? { wifiState } : {}),
    ...(networkSegment != null ? { networkSegment } : {}),
    ...(typeof entry.changed === "boolean"
      ? { changed: entry.changed }
      : existing?.changed !== undefined
        ? { changed: existing.changed }
        : {}),
    ...(typeof entry.abilityChanged === "boolean"
      ? { abilityChanged: entry.abilityChanged }
      : existing?.abilityChanged !== undefined
        ? { abilityChanged: existing.abilityChanged }
        : {}),
    ...(stateLower != null ? { stateLower } : {}),
    ...(nextOnline !== undefined ? { online: nextOnline } : {}),
    ...(nextSleeping !== undefined ? { sleeping: nextSleeping } : {}),
    ...(loginState != null ? { loginState } : {}),
  };

  return { shouldSkip: false, next, events };
};

export const buildChannelPushDataLogSnapshot = (channelPushData: Map<number, ChannelPushData>): {
  result: Record<number, { name: string; uid: string; state: string }>;
  storedChannels: string[];
} => {
  const resultObj: Record<number, { name: string; uid: string; state: string }> = {};
  for (const [channel, info] of channelPushData.entries()) {
    if ((info.stateLower ?? info.state).toLowerCase() === "none") continue;
    resultObj[channel] = { name: info.name, uid: info.uid, state: info.state };
  }
  return { result: resultObj, storedChannels: Object.keys(resultObj) };
};
