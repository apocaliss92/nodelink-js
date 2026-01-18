import type { ReolinkCmdResponse } from "../../http/types";
import type { ReolinkNvrChannelInfo } from "../types";

export const asBool01 = (v: unknown): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  }
  return undefined;
};

export const extractStatusArrayFromGetChannelstatus = (rsp: ReolinkCmdResponse[]): unknown[] => {
  if (rsp.length === 0) return [];
  const v = rsp[0]?.value;
  if (!v) return [];

  const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
  const tryGet = (obj: unknown, key: string): unknown => (isRecord(obj) ? obj[key] : undefined);

  const statusCandidate =
    tryGet(v, "status") ??
    tryGet(v, "Channelstatus") ??
    tryGet(v, "ChannelStatus") ??
    tryGet(v, "channelStatus") ??
    tryGet(v, "channelstatus");

  if (Array.isArray(statusCandidate)) return statusCandidate;
  if (Array.isArray(v)) return v;

  const channelsCandidate = tryGet(v, "channels") ?? tryGet(v, "Channels") ?? tryGet(v, "channel") ?? tryGet(v, "Channel");
  if (Array.isArray(channelsCandidate)) return channelsCandidate;

  if (!isRecord(v)) return [];

  const channelKeys = Object.keys(v).filter((k) => /^channel\d+$/i.test(k) || /^ch\d+$/i.test(k));
  if (channelKeys.length === 0) return [];

  return channelKeys.map((k) => {
    const entry = v[k];
    if (typeof entry === "object" && entry !== null) return entry;
    const channel = Number.parseInt(k.replace(/\D/g, ""), 10);
    return Number.isFinite(channel) ? { channel } : {};
  });
};

export const deriveGlobalUidFromChannels = (channels: ReolinkNvrChannelInfo[], fallbackUid?: string): string | undefined => {
  for (const ch of channels) {
    if (ch.uid && ch.uid.trim()) {
      return ch.uid.trim();
    }
  }
  return fallbackUid;
};
