import { getXmlText } from "../../../protocol/xml";

export type ChannelInfoPushEntry = {
  channel: number;
  name: string;
  uid: string;
  state: string;
  stateLower: string;
  index?: number;
  streamSupport?: string[];
  wifiState?: string;
  networkSegment?: string;
  changed?: boolean;
  abilityChanged?: boolean;
  loginState?: string;
  inferredOnline?: boolean;
  inferredSleep?: boolean;
  isNonePlaceholder: boolean;
};

const parseOptionalInt = (value: string | undefined): number | undefined => {
  const v = (value ?? "").trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

const parseOptionalBoolish = (value: string | undefined): boolean | undefined => {
  const v = (value ?? "").trim();
  if (v === "") return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 0;
  return v !== "0";
};

export const parseChannelInfoPushBlocks = (blocks: string[]): ChannelInfoPushEntry[] => {
  const out: ChannelInfoPushEntry[] = [];

  for (const block of blocks) {
    const channelText = getXmlText(block, "channelId") ?? getXmlText(block, "channel") ?? getXmlText(block, "chnID");
    if (!channelText) continue;

    const channel = Number.parseInt(channelText, 10);
    if (!Number.isFinite(channel)) continue;

    const name = (getXmlText(block, "devName") ?? "").trim();
    const uid = (getXmlText(block, "uid") ?? "").trim();
    const state = (getXmlText(block, "state") ?? "").trim();
    const stateLower = state.trim().toLowerCase();

    const index = parseOptionalInt(getXmlText(block, "index"));
    const wifiState = (getXmlText(block, "wifiState") ?? "").trim() || undefined;
    const networkSegment = (getXmlText(block, "networkSegment") ?? "").trim() || undefined;
    const changed = parseOptionalBoolish(getXmlText(block, "changed"));
    const abilityChanged = parseOptionalBoolish(getXmlText(block, "abilityChanged"));

    const loginState = (getXmlText(block, "loginState") ?? "").trim().toLowerCase() || undefined;
    const streamSupportText = (getXmlText(block, "streamSupport") ?? "").trim().toLowerCase();
    const streamSupport = streamSupportText
      ? streamSupportText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const indexText = (getXmlText(block, "index") ?? "").trim();
    const isNonePlaceholder =
      stateLower === "none" &&
      !name &&
      !uid &&
      !loginState &&
      (streamSupportText === "none" || streamSupportText === "") &&
      (indexText === "0" || indexText === "");

    const inferredOnline: boolean | undefined =
      stateLower === "connect" ? true : stateLower === "none" || stateLower === "disconnect" ? false : undefined;

    const inferredSleep: boolean | undefined =
      loginState
        ? loginState === "standby"
        : stateLower === "connect"
          ? false
          : stateLower === "none" || stateLower === "disconnect"
            ? true
            : undefined;

    out.push({
      channel,
      name,
      uid,
      state,
      stateLower,
      ...(index !== undefined ? { index } : {}),
      ...(streamSupport?.length ? { streamSupport } : {}),
      ...(wifiState ? { wifiState } : {}),
      ...(networkSegment ? { networkSegment } : {}),
      ...(typeof changed === "boolean" ? { changed } : {}),
      ...(typeof abilityChanged === "boolean" ? { abilityChanged } : {}),
      ...(loginState ? { loginState } : {}),
      ...(inferredOnline !== undefined ? { inferredOnline } : {}),
      ...(inferredSleep !== undefined ? { inferredSleep } : {}),
      isNonePlaceholder,
    });
  }

  return out;
};
