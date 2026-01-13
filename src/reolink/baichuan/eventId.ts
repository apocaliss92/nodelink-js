export type NvrAlarmEventIdV1 = {
  kind: "nvrAlarm";
  /** Channel number (0-based). */
  channel: number;
  /**
  * Optional legacy field.
  *
  * IMPORTANT: Do not assume this is a stable CoverPreview (cmd_id=298) header channelId.
  * On NVR/HomeHub firmwares observed via PCAP, the CoverPreview header channelId is session-scoped
  * and changes per request; persisting it in an event id can cause request rejections.
   */
  channelId?: number;
  /** Recording identifier as returned by the device (often a path/filename). */
  fileName: string;
  /** Event start time in milliseconds since epoch (derived from filename or response). */
  startTimeMs: number;
  /** Event end time in milliseconds since epoch (derived from filename or response). */
  endTimeMs: number;
  /** Optional device uid when known (mainly for debugging/multi-device uniqueness). */
  uid?: string;
};

export type ReolinkEventIdV1 = NvrAlarmEventIdV1;

const PREFIX = "rbj:event:v1:";

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(s: string): Buffer {
  const normalized = s.replaceAll("-", "+").replaceAll("_", "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

export function encodeReolinkEventIdV1(obj: ReolinkEventIdV1): string {
  if (!obj || typeof obj !== "object") throw new Error("encodeReolinkEventIdV1: obj is required");
  if (obj.kind !== "nvrAlarm") throw new Error(`encodeReolinkEventIdV1: unsupported kind ${(obj as any)?.kind}`);
  if (!Number.isFinite(obj.channel)) throw new Error("encodeReolinkEventIdV1: channel must be a number");
  if (obj.channelId != null && !Number.isFinite(obj.channelId)) throw new Error("encodeReolinkEventIdV1: channelId must be a number");
  if (!obj.fileName || typeof obj.fileName !== "string") throw new Error("encodeReolinkEventIdV1: fileName must be a string");
  if (!Number.isFinite(obj.startTimeMs)) throw new Error("encodeReolinkEventIdV1: startTimeMs must be a number");
  if (!Number.isFinite(obj.endTimeMs)) throw new Error("encodeReolinkEventIdV1: endTimeMs must be a number");

  // Compact payload: keep keys short.
  const payload: any = {
    k: obj.kind,
    ch: obj.channel,
    fn: obj.fileName,
    st: obj.startTimeMs,
    et: obj.endTimeMs,
  };
  if (obj.channelId != null) payload.cid = obj.channelId;
  if (obj.uid) payload.uid = obj.uid;

  const json = JSON.stringify(payload);
  return PREFIX + base64UrlEncode(Buffer.from(json, "utf8"));
}

export function decodeReolinkEventIdV1(eventId: string): ReolinkEventIdV1 {
  const raw = (eventId ?? "").trim();
  if (!raw.startsWith(PREFIX)) throw new Error("decodeReolinkEventIdV1: invalid prefix");
  const b64 = raw.slice(PREFIX.length);
  const json = base64UrlDecode(b64).toString("utf8");

  let payload: any;
  try {
    payload = JSON.parse(json);
  } catch (e) {
    throw new Error(`decodeReolinkEventIdV1: invalid JSON payload (${e instanceof Error ? e.message : String(e)})`);
  }

  if (payload?.k !== "nvrAlarm") throw new Error(`decodeReolinkEventIdV1: unsupported kind ${payload?.k}`);
  const channel = Number(payload?.ch);
  const channelIdRaw = payload?.cid;
  const channelId = channelIdRaw == null ? undefined : Number(channelIdRaw);
  const fileName = typeof payload?.fn === "string" ? payload.fn : "";
  const startTimeMs = Number(payload?.st);
  const endTimeMs = Number(payload?.et);
  const uid = typeof payload?.uid === "string" ? payload.uid : undefined;

  if (!Number.isFinite(channel)) throw new Error("decodeReolinkEventIdV1: invalid channel");
  if (channelId !== undefined && !Number.isFinite(channelId)) throw new Error("decodeReolinkEventIdV1: invalid channelId");
  if (!fileName) throw new Error("decodeReolinkEventIdV1: invalid fileName");
  if (!Number.isFinite(startTimeMs)) throw new Error("decodeReolinkEventIdV1: invalid startTimeMs");
  if (!Number.isFinite(endTimeMs)) throw new Error("decodeReolinkEventIdV1: invalid endTimeMs");

  return {
    kind: "nvrAlarm",
    channel,
    ...(channelId !== undefined ? { channelId } : {}),
    fileName,
    startTimeMs,
    endTimeMs,
    ...(uid ? { uid } : {}),
  };
}

export function isReolinkEventIdV1(s: string): boolean {
  return typeof s === "string" && s.trim().startsWith(PREFIX);
}
