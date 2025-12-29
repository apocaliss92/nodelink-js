import { xmlEscape } from "../protocol/xml";

export function buildP2pXml(inner: string): string {
  return `<P2P>${inner}</P2P>`;
}

export function buildC2dC(params: { uid: string; clientPort: number; cid: number; mtu: number; os?: string }): string {
  // Neolink uses "MAC" as OS for discovery (see discovery.rs:361)
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

export function buildC2dT(params: { sid: number; conn?: string; cid: number; mtu: number }): string {
  const conn = params.conn ?? "local";
  return buildP2pXml(
    `<C2D_T>` +
      `<sid>${params.sid}</sid>` +
      `<conn>${xmlEscape(conn)}</conn>` +
      `<cid>${params.cid}</cid>` +
      `<mtu>${params.mtu}</mtu>` +
    `</C2D_T>`
  );
}

export type D2cCrParsed = { rsp: number; cid: number; did: number };

export function parseD2cCr(xml: string): D2cCrParsed | undefined {
  // Minimal parser: extract <rsp>, <cid>, <did> within <D2C_C_R>...</D2C_C_R>
  const m = /<D2C_C_R>([\s\S]*?)<\/D2C_C_R>/.exec(xml);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const rsp = /<rsp>(-?\d+)<\/rsp>/.exec(body)?.[1];
  const cid = /<cid>(-?\d+)<\/cid>/.exec(body)?.[1];
  const did = /<did>(-?\d+)<\/did>/.exec(body)?.[1];
  if (rsp == null || cid == null || did == null) return undefined;
  return { rsp: Number(rsp), cid: Number(cid), did: Number(did) };
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

