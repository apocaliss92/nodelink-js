import { xmlEscape } from "../protocol/xml.js";

export function buildP2pXml(inner: string): string {
  return `<P2P>${inner}</P2P>`;
}

export function buildC2dC(params: { uid: string; clientPort: number; cid: number; mtu: number; os?: string }): string {
  const os = params.os ?? "WIN";
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

