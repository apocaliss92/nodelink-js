import { extractReolinkUidLike, isReolinkUidLike } from "./uid";

export const discoverPerChannelUidViaCgiChannelstatus = async (params: {
  channel: number;
  login: () => Promise<void>;
  getChannelstatus: () => Promise<Array<{ value?: { status?: Array<{ channel?: number; uid?: string }> } }>>;
}): Promise<string | undefined> => {
  await params.login();
  const chStatus = await params.getChannelstatus();
  const entry = chStatus
    .flatMap((r) => r.value?.status ?? [])
    .find((s) => typeof s?.channel === "number" && s.channel === params.channel);

  const uidCandidate = (entry?.uid ?? "").trim();
  return uidCandidate && isReolinkUidLike(uidCandidate) ? uidCandidate : undefined;
};

export const discoverDeviceUidViaGetInfoSerial = async (params: {
  getInfo: () => Promise<{ serialNumber?: string }>;
}): Promise<string | undefined> => {
  const info = await params.getInfo();
  const serial = (info.serialNumber ?? "").trim();
  return serial && isReolinkUidLike(serial) ? serial : undefined;
};

export const discoverDeviceUidViaCgi = async (params: {
  login: () => Promise<void>;
  getP2p: () => Promise<unknown>;
  getDevInfo: () => Promise<unknown>;
}): Promise<string | undefined> => {
  await params.login();

  try {
    const p2p = await params.getP2p();
    const fromP2p = extractReolinkUidLike(p2p);
    if (fromP2p) return fromP2p;
  } catch {
    // ignore
  }

  try {
    const devInfo = await params.getDevInfo();
    const fromDevInfo = extractReolinkUidLike(devInfo);
    if (fromDevInfo) return fromDevInfo;
  } catch {
    // ignore
  }

  return undefined;
};

export const discoverDeviceUidViaBaichuanGetP2p = async (params: {
  sendXml: (p: { cmdId: number; timeoutMs?: number }) => Promise<string>;
}): Promise<string | undefined> => {
  const p2pXml = await params.sendXml({ cmdId: 114, timeoutMs: 10_000 });
  return extractReolinkUidLike(p2pXml);
};
