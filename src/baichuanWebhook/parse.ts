/**
 * Parse Baichuan HaCfg webhook POST bodies.
 *
 * Home Assistant's reolink_aio observes two shapes:
 *
 * 1. Wake/sleep event envelope:
 *    `{ "data": { "event": "wake"|"sleep"|"test", "reason"?: "doorbell"|"pir"|… } }`
 *
 * 2. Opaque Baichuan command push:
 *    `{ "uid": "…", "cmd": 33, "xml": "<…>", "ext_xml"?: "<…>" }`
 */

export type BaichuanWebhookWakeReason =
  | "doorbell"
  | "pir"
  | "network"
  | "other"
  | string;

export type BaichuanWebhookEventName = "wake" | "sleep" | "test" | string;

export interface BaichuanWebhookParsedWake {
  kind: "event";
  event: BaichuanWebhookEventName;
  reason?: BaichuanWebhookWakeReason;
  data: Record<string, string>;
}

export interface BaichuanWebhookParsedCmd {
  kind: "cmd";
  uid?: string;
  cmdId: number;
  xml: string;
  extXml?: string;
}

export type BaichuanWebhookParsed =
  | BaichuanWebhookParsedWake
  | BaichuanWebhookParsedCmd;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringifyData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Parse a raw HTTP body from a HaCfg webhook POST.
 * Returns `undefined` when the body is not a recognised JSON payload.
 */
export function parseBaichuanWebhookBody(
  body: Buffer | string | unknown,
): BaichuanWebhookParsed | undefined {
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else if (Buffer.isBuffer(body)) {
    text = body.toString("utf8");
  } else if (body && typeof body === "object") {
    // Already-parsed JSON (e.g. Scrypted request body helpers).
    return parseBaichuanWebhookObject(body);
  } else {
    return undefined;
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;

  let mess: unknown;
  try {
    mess = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return parseBaichuanWebhookObject(mess);
}

function parseBaichuanWebhookObject(
  mess: unknown,
): BaichuanWebhookParsed | undefined {
  const root = asRecord(mess);
  if (!root) return undefined;

  const cmdRaw = root.cmd;
  const xml = root.xml;
  if (cmdRaw != null && typeof xml === "string") {
    const cmdId = typeof cmdRaw === "number" ? cmdRaw : Number(cmdRaw);
    if (!Number.isFinite(cmdId)) return undefined;
    const parsed: BaichuanWebhookParsedCmd = {
      kind: "cmd",
      cmdId,
      xml,
    };
    if (typeof root.uid === "string") parsed.uid = root.uid;
    if (typeof root.ext_xml === "string") parsed.extXml = root.ext_xml;
    return parsed;
  }

  const dataRaw = asRecord(root.data) ?? root;
  const event = dataRaw.event;
  if (typeof event !== "string" || !event) return undefined;

  const data = stringifyData(dataRaw);
  const parsed: BaichuanWebhookParsedWake = {
    kind: "event",
    event,
    data,
  };
  if (typeof dataRaw.reason === "string") {
    parsed.reason = dataRaw.reason;
  }
  return parsed;
}
