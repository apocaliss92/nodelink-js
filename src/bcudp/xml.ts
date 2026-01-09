import { xmlEscape } from "../protocol/xml";

export function buildP2pXml(inner: string): string {
  return `<P2P>${inner}</P2P>`;
}

/**
 * Build C2D_S message for general UDP broadcast discovery (without UID).
 * This is sent to discover any cameras on the network.
 */
export function buildC2dS(params: { clientPort: number }): string {
  return buildP2pXml(`<C2D_S><to><port>${params.clientPort}</port></to></C2D_S>`);
}

export type IpPort = { ip: string; port: number };

/**
 * Build C2M_Q message (client -> Reolink middle-man server) for UID lookup.
 * Sent to p2p*.reolink.com:9999.
 */
export function buildC2mQ(params: { uid: string; os?: string }): string {
  const os = params.os ?? "MAC";
  return buildP2pXml(
    `<C2M_Q>` +
      `<uid>${xmlEscape(params.uid)}</uid>` +
      `<p>${xmlEscape(os)}</p>` +
    `</C2M_Q>`,
  );
}

export type M2cQrParsed = {
  reg?: IpPort;
  relay?: IpPort;
  log?: IpPort;
  t?: IpPort;
};

function parseIpPortBlock(tag: "reg" | "relay" | "log" | "t", body: string): IpPort | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(body);
  if (!m) return undefined;
  const block = m[1] ?? "";
  const ip = /<ip>([^<]+)<\/ip>/i.exec(block)?.[1];
  const port = /<port>(-?\d+)<\/port>/i.exec(block)?.[1];
  if (!ip || port == null) return undefined;
  const portNum = Number(port);
  if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) return undefined;
  return { ip: ip.trim(), port: portNum };
}

export function parseM2cQr(xml: string): M2cQrParsed | undefined {
  const m = /<M2C_Q_R>([\s\S]*?)<\/M2C_Q_R>/i.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const reg = parseIpPortBlock("reg", body);
  const relay = parseIpPortBlock("relay", body);
  const log = parseIpPortBlock("log", body);
  const t = parseIpPortBlock("t", body);
  if (!reg && !relay && !log && !t) return undefined;
  return { ...(reg ? { reg } : {}), ...(relay ? { relay } : {}), ...(log ? { log } : {}), ...(t ? { t } : {}) };
}

/**
 * Build C2R_C message (client -> register server) to register local address.
 */
export function buildC2rC(params: {
  uid: string;
  cli: IpPort;
  relay: IpPort;
  cid: number;
  family: 4 | 6;
  os?: string;
  revision?: number;
  debug?: boolean;
}): string {
  const os = params.os ?? "MAC";
  const debug = params.debug ?? false;
  const rev = params.revision != null ? `<r>${params.revision}</r>` : "";
  return buildP2pXml(
    `<C2R_C>` +
      `<uid>${xmlEscape(params.uid)}</uid>` +
      `<cli><ip>${xmlEscape(params.cli.ip)}</ip><port>${params.cli.port}</port></cli>` +
      `<relay><ip>${xmlEscape(params.relay.ip)}</ip><port>${params.relay.port}</port></relay>` +
      `<cid>${params.cid}</cid>` +
      `<debug>${debug ? "true" : "false"}</debug>` +
      `<family>${params.family}</family>` +
      `<p>${xmlEscape(os)}</p>` +
      rev +
    `</C2R_C>`,
  );
}

export type R2cCrParsed = {
  rsp: number;
  sid?: number;
  dev?: IpPort;
  dmap?: IpPort;
  relay?: IpPort;
  relayt?: IpPort;
};

export function parseR2cCr(xml: string): R2cCrParsed | undefined {
  const m = /<R2C_C_R>([\s\S]*?)<\/R2C_C_R>/i.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const rspStr = /<rsp>(-?\d+)<\/rsp>/i.exec(body)?.[1];
  if (rspStr == null) return undefined;
  const rsp = Number(rspStr);
  if (!Number.isFinite(rsp)) return undefined;
  const sidStr = /<sid>(-?\d+)<\/sid>/i.exec(body)?.[1];
  const sid = sidStr != null ? Number(sidStr) : undefined;

  const parseCustom = (tag: "dev" | "dmap" | "relay" | "relayt") => {
    const mm = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(body);
    if (!mm) return undefined;
    const block = mm[1] ?? "";
    const ip = /<ip>([^<]+)<\/ip>/i.exec(block)?.[1];
    const port = /<port>(-?\d+)<\/port>/i.exec(block)?.[1];
    if (!ip || port == null) return undefined;
    const portNum = Number(port);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) return undefined;
    return { ip: ip.trim(), port: portNum } satisfies IpPort;
  };

  const devIpPort = parseCustom("dev");
  const dmapIpPort = parseCustom("dmap");
  const relayIpPort = parseCustom("relay");
  const relaytIpPort = parseCustom("relayt");

  return {
    rsp,
    ...(sid != null && Number.isFinite(sid) ? { sid } : {}),
    ...(devIpPort ? { dev: devIpPort } : {}),
    ...(dmapIpPort ? { dmap: dmapIpPort } : {}),
    ...(relayIpPort ? { relay: relayIpPort } : {}),
    ...(relaytIpPort ? { relayt: relaytIpPort } : {}),
  };
}

/**
 * Build C2R_CFM (client -> register server) confirm message.
 */
export function buildC2rCfm(params: { sid: number; conn: string; rsp?: number; cid: number; did: number }): string {
  const rsp = params.rsp ?? 0;
  return buildP2pXml(
    `<C2R_CFM>` +
      `<sid>${params.sid}</sid>` +
      `<conn>${xmlEscape(params.conn)}</conn>` +
      `<rsp>${rsp}</rsp>` +
      `<cid>${params.cid}</cid>` +
      `<did>${params.did}</did>` +
    `</C2R_CFM>`,
  );
}

export function buildC2dC(params: { uid: string; clientPort: number; cid: number; mtu: number; os?: string }): string {
  // Default OS is "MAC" for discovery
  const os = params.os ?? "MAC";
  return buildP2pXml(
    `<C2D_C>` +
      `<uid>${xmlEscape(params.uid)}</uid>` +
      `<cli><port>${params.clientPort}</port></cli>` +
      `<cid>${params.cid}</cid>` +
      `<mtu>${params.mtu}</mtu>` +
      `<debug>false</debug>` +
      `<p>${xmlEscape(os)}</p>` +
      `</C2D_C>`,
  );
}

export function buildC2dHb(params: { cid: number; did: number }): string {
  return buildP2pXml(`<C2D_HB><cid>${params.cid}</cid><did>${params.did}</did></C2D_HB>`);
}

export function buildC2dA(params: { sid: number; conn?: string; cid: number; did: number; mtu: number }): string {
  const conn = params.conn ?? "local";
  return buildP2pXml(
    `<C2D_A>` +
      `<sid>${params.sid}</sid>` +
      `<conn>${xmlEscape(conn)}</conn>` +
      `<cid>${params.cid}</cid>` +
      `<did>${params.did}</did>` +
      `<mtu>${params.mtu}</mtu>` +
    `</C2D_A>`
  );
}

export function buildC2dT(params: { sid?: number; conn?: string; cid: number; mtu: number }): string {
  const conn = params.conn ?? "local";
  const sid = params.sid != null ? `<sid>${params.sid}</sid>` : "";
  return buildP2pXml(
    `<C2D_T>` +
      sid +
      `<conn>${xmlEscape(conn)}</conn>` +
      `<cid>${params.cid}</cid>` +
      `<mtu>${params.mtu}</mtu>` +
    `</C2D_T>`
  );
}

export type D2cCrParsed = {
  rsp: number;
  cid: number;
  did: number;
  sid?: number;
  timer?: { def?: number; hb?: number; hbt?: number };
};

export function parseD2cCr(xml: string): D2cCrParsed | undefined {
  // Minimal parser: extract <rsp>, <cid>, <did> within <D2C_C_R>...</D2C_C_R>
  const m = /<D2C_C_R>([\s\S]*?)<\/D2C_C_R>/.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const rsp = /<rsp>(-?\d+)<\/rsp>/.exec(body)?.[1];
  const cid = /<cid>(-?\d+)<\/cid>/.exec(body)?.[1];
  const did = /<did>(-?\d+)<\/did>/.exec(body)?.[1];
  if (rsp == null || cid == null || did == null) return undefined;

  const sid = /<sid>(-?\d+)<\/sid>/.exec(body)?.[1];

  const timerBlock = /<timer>([\s\S]*?)<\/timer>/.exec(body)?.[1];
  const def = timerBlock ? /<def>(-?\d+)<\/def>/.exec(timerBlock)?.[1] : undefined;
  const hb = timerBlock ? /<hb>(-?\d+)<\/hb>/.exec(timerBlock)?.[1] : undefined;
  const hbt = timerBlock ? /<hbt>(-?\d+)<\/hbt>/.exec(timerBlock)?.[1] : undefined;
  const timer = def != null || hb != null || hbt != null ? {
    ...(def != null ? { def: Number(def) } : {}),
    ...(hb != null ? { hb: Number(hb) } : {}),
    ...(hbt != null ? { hbt: Number(hbt) } : {}),
  } : undefined;

  return {
    rsp: Number(rsp),
    cid: Number(cid),
    did: Number(did),
    ...(sid != null ? { sid: Number(sid) } : {}),
    ...(timer ? { timer } : {}),
  };
}

export type D2cCfmParsed = { sid: number; conn?: string; rsp?: number; cid?: number; did?: number };

export function parseD2cCfm(xml: string): D2cCfmParsed | undefined {
  const m = /<D2C_CFM>([\s\S]*?)<\/D2C_CFM>/.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const sid = /<sid>(-?\d+)<\/sid>/.exec(body)?.[1];
  if (sid == null) return undefined;
  const conn = /<conn>([^<]+)<\/conn>/.exec(body)?.[1];
  const rsp = /<rsp>(-?\d+)<\/rsp>/.exec(body)?.[1];
  const cid = /<cid>(-?\d+)<\/cid>/.exec(body)?.[1];
  const did = /<did>(-?\d+)<\/did>/.exec(body)?.[1];
  return {
    sid: Number(sid),
    ...(conn != null ? { conn } : {}),
    ...(rsp != null ? { rsp: Number(rsp) } : {}),
    ...(cid != null ? { cid: Number(cid) } : {}),
    ...(did != null ? { did: Number(did) } : {}),
  };
}

export type D2cTParsed = { sid: number; conn?: string; cid: number; did: number };

export function parseD2cT(xml: string): D2cTParsed | undefined {
  const m = /<D2C_T>([\s\S]*?)<\/D2C_T>/.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const sid = /<sid>(-?\d+)<\/sid>/.exec(body)?.[1];
  const cid = /<cid>(-?\d+)<\/cid>/.exec(body)?.[1];
  const did = /<did>(-?\d+)<\/did>/.exec(body)?.[1];
  if (sid == null || cid == null || did == null) return undefined;
  const conn = /<conn>([^<]+)<\/conn>/.exec(body)?.[1];
  return {
    sid: Number(sid),
    cid: Number(cid),
    did: Number(did),
    ...(conn != null ? { conn } : {}),
  };
}

export type D2cDiscParsed = { cid: number; did: number };

export function parseD2cDisc(xml: string): D2cDiscParsed | undefined {
  const m = /<D2C_DISC>([\s\S]*?)<\/D2C_DISC>/.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const cid = /<cid>(-?\d+)<\/cid>/.exec(body)?.[1];
  const did = /<did>(-?\d+)<\/did>/.exec(body)?.[1];
  if (cid == null || did == null) return undefined;
  return { cid: Number(cid), did: Number(did) };
}

export type D2cHbParsed = { cid: number; did: number };

export function parseD2cHb(xml: string): D2cHbParsed | undefined {
  const m = /<D2C_HB>([\s\S]*?)<\/D2C_HB>/.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const cid = /<cid>(-?\d+)<\/cid>/.exec(body)?.[1];
  const did = /<did>(-?\d+)<\/did>/.exec(body)?.[1];
  if (cid == null || did == null) return undefined;
  return { cid: Number(cid), did: Number(did) };
}

