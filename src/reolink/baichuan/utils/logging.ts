import type { BaichuanClient } from "../../../client/BaichuanClient";

export const formatErrorForLog = (e: unknown): string => {
  if (e instanceof Error) {
    const codeValue = Reflect.get(e, "code");
    const code = typeof codeValue === "string" || typeof codeValue === "number" ? ` code=${String(codeValue)}` : "";
    return `${e.name}: ${e.message}${code}`;
  }
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    try {
      const keys = Object.keys(e);
      const json = JSON.stringify(e);
      return keys.length ? `object keys=[${keys.join(",")}]: ${json}` : `object: ${json}`;
    } catch {
      return "[unserializable object]";
    }
  }
  return String(e);
};

export const formatClientIoForLog = (api: { client?: BaichuanClient }): string => {
  try {
    const c = api.client;
    if (!c) return "";

    const transport = c.getTransport?.() ?? "unknown";
    const connected = c.isSocketConnected?.() ?? false;
    const loggedIn = c.loggedIn === true;
    const lastTx = c.getLastTxInfo?.();
    const lastRx = c.getLastRxInfo?.();

    const parts: string[] = [
      `transport=${transport}`,
      `connected=${connected}`,
      `loggedIn=${loggedIn}`,
      lastTx?.cmdId != null ? `lastTxCmdId=${lastTx.cmdId}` : "",
      lastTx?.responseCode != null ? `lastTxCode=${lastTx.responseCode}` : "",
      lastRx?.cmdId != null ? `lastRxCmdId=${lastRx.cmdId}` : "",
      lastRx?.responseCode != null ? `lastRxCode=${lastRx.responseCode}` : "",
    ].filter(Boolean);

    return parts.length ? ` (${parts.join(" ")})` : "";
  } catch {
    return "";
  }
};
