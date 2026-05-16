/**
 * Email push event bus.
 *
 * Kept in a dedicated module — and intentionally free of `smtp-server` /
 * `mailparser` dependencies — so consumers (the events-manager, MQTT
 * bridge, integration tests, …) can subscribe to email-push events
 * without pulling in the SMTP server's native deps. The actual SMTP
 * intake (`email-push-server.ts`) lives next to this file and emits
 * through this bus.
 */

import { EventEmitter } from "node:events";

/** Trigger classification produced by parsing the camera's email body. */
export type EmailPushInferredType =
  | "motion"
  | "people"
  | "vehicle"
  | "animal"
  | "face"
  | "package"
  | "doorbell"
  | "other";

export interface EmailPushEvent {
  cameraId: string;
  /** Original recipient address that matched this camera. */
  recipient: string;
  inferredType: EmailPushInferredType;
  /** Reception timestamp on the manager (ms since epoch). */
  receivedAtMs: number;
  subject: string;
  from: string;
  /** Path of the saved snapshot attachment, if any. Relative to DATA_PATH. */
  snapshotPath?: string;
  /** Raw body text excerpt (max 500 chars). */
  bodyExcerpt: string;
}

type EventHandler = (event: EmailPushEvent) => void;
type CameraResolver = (recipient: string) => string | undefined;

const emitter = new EventEmitter();
const recentEventsByCamera = new Map<string, EmailPushEvent[]>();
let cameraResolver: CameraResolver = () => undefined;

/**
 * Set the callback that maps a recipient address (e.g.
 * `cam-abc@nodelink.local`) to a known cameraId. Returning `undefined`
 * rejects the recipient at RCPT TO.
 */
export function setEmailPushCameraResolver(resolver: CameraResolver): void {
  cameraResolver = resolver;
}

export function getEmailPushCameraResolver(): CameraResolver {
  return cameraResolver;
}

/**
 * Register a handler invoked for every accepted email-push event. Returns
 * an `off` function.
 */
export function onEmailPushEvent(handler: EventHandler): () => void {
  emitter.on("event", handler);
  return () => emitter.off("event", handler);
}

/** Internal: SMTP server uses this to dispatch an event into the bus. */
export function emitEmailPushEvent(event: EmailPushEvent): void {
  pushRecentEvent(event);
  emitter.emit("event", event);
}

/** Recover the recent events buffered in memory for a given camera. */
export function getRecentEmailPushEvents(
  cameraId: string,
  limit?: number,
): EmailPushEvent[] {
  const list = recentEventsByCamera.get(cameraId) ?? [];
  return typeof limit === "number" ? list.slice(0, limit) : [...list];
}

let maxRecentEventsPerCamera = 20;

/** Configure the ring-buffer size per camera. SMTP server calls this on start. */
export function setRecentEventsPerCamera(n: number): void {
  maxRecentEventsPerCamera = Math.max(0, n);
}

function pushRecentEvent(event: EmailPushEvent): void {
  if (maxRecentEventsPerCamera <= 0) return;
  const list = recentEventsByCamera.get(event.cameraId) ?? [];
  list.unshift(event);
  if (list.length > maxRecentEventsPerCamera) {
    list.length = maxRecentEventsPerCamera;
  }
  recentEventsByCamera.set(event.cameraId, list);
}

/** Test hook: clear the ring buffer entirely. */
export function _resetEmailPushBusForTests(): void {
  emitter.removeAllListeners();
  recentEventsByCamera.clear();
  cameraResolver = () => undefined;
}
