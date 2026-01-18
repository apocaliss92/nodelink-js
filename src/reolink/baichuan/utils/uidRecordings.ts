import type { ReolinkBaichuanApi } from "../ReolinkBaichuanApi";
import { discoverDeviceUidViaBaichuanGetP2p, discoverDeviceUidViaCgi, discoverDeviceUidViaGetInfoSerial } from "./uidDiscovery";
import { formatErrorForLog } from "./logging";

export const discoverDeviceUidForRecordings = async (params: {
  channel: number;
  getInfo: () => ReturnType<ReolinkBaichuanApi["getInfo"]>;
  cgiLogin: () => Promise<void>;
  cgiGetP2p: () => Promise<any>;
  cgiGetDevInfo: () => Promise<any>;
  sendXml: (p: Parameters<ReolinkBaichuanApi["sendXml"]>[0]) => Promise<string>;
  trace: (message: string) => void;
}): Promise<string | undefined> => {
  const trace = params.trace;

  trace("Attempting auto-discovery via getInfo()");
  try {
    const uid = await discoverDeviceUidViaGetInfoSerial({ getInfo: () => params.getInfo() });
    trace(`getInfo().serialNumber: ${uid || "(missing/invalid)"}`);
    if (uid) return uid;
  } catch (e) {
    trace(`getInfo() failed: ${formatErrorForLog(e)}`);
  }

  trace("Attempting auto-discovery via HTTP CGI API");
  try {
    const uid = await discoverDeviceUidViaCgi({
      login: () => params.cgiLogin(),
      getP2p: () => params.cgiGetP2p(),
      getDevInfo: () => params.cgiGetDevInfo(),
    });
    trace(`[HTTP CGI] UID candidate: ${uid || "(none)"}`);
    if (uid) return uid;
  } catch (e) {
    trace(`[HTTP CGI] Login or requests failed: ${formatErrorForLog(e)}`);
  }

  trace("Attempting auto-discovery via cmdId=114 (GetP2p)");
  try {
    const uid = await discoverDeviceUidViaBaichuanGetP2p({ sendXml: (p) => params.sendXml(p) });
    trace(uid ? `Found UID from cmdId=114: ${uid}` : "cmdId=114 did not return UID");
    if (uid) return uid;
  } catch (e) {
    trace(`cmdId=114 failed: ${formatErrorForLog(e)}`);
  }

  return undefined;
};
