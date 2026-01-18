import type { BaichuanClient } from "../../../client/BaichuanClient";

export const formatErrorForLog = (e: unknown): string => {
  if (e instanceof Error) {
    const codeValue = Reflect.get(e, "code");
    const code = typeof codeValue === "string" || typeof codeValue === "number" ? ` code=${String(codeValue)}` : "";
    return `${e.name}: ${e.message}${code}`;
  }
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    // Many runtimes/plugins serialize errors (losing prototype/stack) into plain objects.
    // Extract the common fields explicitly before falling back to JSON.
    try {
      const msgValue = Reflect.get(e as object, "message");
      const nameValue = Reflect.get(e as object, "name");
      const codeValue = Reflect.get(e as object, "code");

      const msg = typeof msgValue === "string" ? msgValue : undefined;
      const name = typeof nameValue === "string" ? nameValue : undefined;
      const code = typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : undefined;

      if (msg || name || code) {
        const head = name ? `${name}: ` : "";
        const tail = code ? ` code=${code}` : "";
        return `${head}${msg ?? "(no message)"}${tail}`;
      }
    } catch {
      // ignore
    }

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
