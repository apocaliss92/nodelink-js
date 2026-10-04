/**
 * Baichuan HaCfg webhook event bus.
 *
 * Process-local dispatcher mirrored after `emailPush/bus.ts`. The HTTP
 * intake (manager) or an external handler (Scrypted `onRequest`) parses
 * the camera POST and emits here; `ReolinkBaichuanApi` auto-bridges
 * matching events into `onSimpleEvent`.
 */

import { EventEmitter } from "node:events";
import type { ReolinkSimpleEventType } from "../reolink/baichuan/types.js";
import { mapBaichuanWebhookAlarmXmlToSimpleEvents } from "./alarmXml.js";
import type {
  BaichuanWebhookEventName,
  BaichuanWebhookParsed,
  BaichuanWebhookWakeReason,
} from "./parse.js";

export type BaichuanWebhookSimpleType =
  | "motion"
  | "doorbell"
  | "awake"
  | "sleeping"
  | "people"
  | "vehicle"
  | "animal"
  | "face"
  | "package"
  | "other";

export interface BaichuanWebhookEvent {
  cameraId: string;
  /** High-level event name from the camera (`wake` / `sleep` / `test` / …). */
  event: BaichuanWebhookEventName;
  /** Wake reason when `event === "wake"` (`doorbell` / `pir` / …). */
  reason?: BaichuanWebhookWakeReason;
  receivedAtMs: number;
  /** Original parsed payload for diagnostics. */
  raw: BaichuanWebhookParsed;
}

type EventHandler = (event: BaichuanWebhookEvent) => void;

const emitter = new EventEmitter();
const lastEventByCamera = new Map<string, BaichuanWebhookEvent>();
const MAX_GLOBAL_EVENTS = 300;
const globalRecentEvents: BaichuanWebhookEvent[] = [];

export function onBaichuanWebhookEvent(handler: EventHandler): () => void {
  emitter.on("event", handler);
  return () => emitter.off("event", handler);
}

export function emitBaichuanWebhookEvent(event: BaichuanWebhookEvent): void {
  lastEventByCamera.set(event.cameraId, event);
  globalRecentEvents.unshift(event);
  if (globalRecentEvents.length > MAX_GLOBAL_EVENTS) {
    globalRecentEvents.length = MAX_GLOBAL_EVENTS;
  }
  emitter.emit("event", event);
}

export function getLastBaichuanWebhookEvent(
  cameraId: string,
): BaichuanWebhookEvent | undefined {
  return lastEventByCamera.get(cameraId);
}

export function getRecentBaichuanWebhookEvents(
  limit: number = MAX_GLOBAL_EVENTS,
): BaichuanWebhookEvent[] {
  const clamped = Math.max(0, Math.min(limit, MAX_GLOBAL_EVENTS));
  return globalRecentEvents.slice(0, clamped);
}

/**
 * Map a HaCfg wake/sleep event onto one or more `ReolinkSimpleEvent` types.
 *
 * - `wake` + `doorbell` → doorbell (+ awake)
 * - `wake` + `pir` → motion (+ awake)
 * - `wake` (other/network) → awake only
 * - `sleep` → sleeping
 * - `test` → empty (subscription probe)
 */
export function mapBaichuanWebhookToSimpleEvents(
  event: Pick<BaichuanWebhookEvent, "event" | "reason">,
): BaichuanWebhookSimpleType[] {
  const name = (event.event ?? "").toLowerCase();
  if (name === "sleep") return ["sleeping"];
  if (name === "test") return [];
  if (name !== "wake") {
    // Unknown event names: treat as motion so consumers still see activity.
    return ["motion"];
  }

  const reason = (event.reason ?? "").toLowerCase();
  if (reason === "doorbell") return ["doorbell", "awake"];
  if (reason === "pir") return ["motion", "awake"];
  return ["awake"];
}

/**
 * Map any parsed HaCfg POST (wake/sleep envelope OR cmd 33 AlarmEvent XML)
 * onto `ReolinkSimpleEvent` types.
 */
export function mapBaichuanWebhookParsedToSimpleEvents(
  parsed: BaichuanWebhookParsed,
): ReolinkSimpleEventType[] {
  if (parsed.kind === "event") {
    return mapBaichuanWebhookToSimpleEvents(parsed);
  }
  if (parsed.cmdId === 33) {
    return mapBaichuanWebhookAlarmXmlToSimpleEvents(parsed.xml);
  }
  return [];
}

export function _resetBaichuanWebhookBusForTests(): void {
  emitter.removeAllListeners();
  lastEventByCamera.clear();
  globalRecentEvents.length = 0;
}
