/**
 * Email push event bus.
 *
 * Stateless in-memory dispatcher. Lives in the library so any consumer
 * (the manager app, the Scrypted plugin, integration tests) can subscribe
 * and emit through the same surface without dragging in the
 * `smtp-server` / `mailparser` native deps.
 *
 * The bus is intentionally:
 * - **Process-local** — every consumer has its own bus instance (the
 *   module-level state below). No cross-process or cross-import sharing.
 * - **Bounded** — keeps the last `MAX_GLOBAL_EVENTS` (default 300) for
 *   the "recent emails" panel, and a single-event reference per camera
 *   for the verifyDelivery race short-circuit. Footprint is O(cameras)
 *   plus O(MAX_GLOBAL_EVENTS).
 * - **Attachment-free** — only metadata (subject, from, body excerpt,
 *   classified type) is retained; the actual JPEG/MP4 payloads from the
 *   camera are never persisted by the bus.
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
  /** Raw body text excerpt (max 500 chars). */
  bodyExcerpt: string;
}

type EventHandler = (event: EmailPushEvent) => void;
type CameraResolver = (recipient: string) => string | undefined;

const emitter = new EventEmitter();
let cameraResolver: CameraResolver = () => undefined;

// Single most-recent event per camera. NOT a buffer / not for UI display —
// only used by verifyDelivery as a race-safe short-circuit when an event
// landed in the gap between the caller capturing `sinceMs` and the
// listener actually attaching.
const lastEventByCamera = new Map<string, EmailPushEvent>();

const MAX_GLOBAL_EVENTS = 300;
const globalRecentEvents: EmailPushEvent[] = [];

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
  lastEventByCamera.set(event.cameraId, event);
  globalRecentEvents.unshift(event);
  if (globalRecentEvents.length > MAX_GLOBAL_EVENTS) {
    globalRecentEvents.length = MAX_GLOBAL_EVENTS;
  }
  emitter.emit("event", event);
}

/**
 * Read the most recent event observed for a camera. Returns `undefined`
 * when no email-push event has been received since the consumer started.
 */
export function getLastEmailPushEvent(
  cameraId: string,
): EmailPushEvent | undefined {
  return lastEventByCamera.get(cameraId);
}

/**
 * Return a snapshot of the most recent email-push events across all
 * cameras (most recent first). Capped at `MAX_GLOBAL_EVENTS` (300).
 *
 * `limit` is clamped to the buffer cap so callers can ask for a smaller
 * page without juggling the storage limit.
 */
export function getRecentEmailPushEvents(
  limit: number = MAX_GLOBAL_EVENTS,
): EmailPushEvent[] {
  const clamped = Math.max(0, Math.min(limit, MAX_GLOBAL_EVENTS));
  return globalRecentEvents.slice(0, clamped);
}

/**
 * Map the email-push classifier output onto the lib's broader
 * ReolinkSimpleEvent type union. Shared by `ReolinkBaichuanApi
 * .subscribeEmailPushEvents` (the per-camera bridge) and any consumer
 * that wants the same mapping at the global bus level (e.g. the
 * manager-app's events-manager) so both code paths stay in sync.
 */
export function mapEmailPushInferredType(
  inferred: EmailPushInferredType,
):
  | "motion"
  | "doorbell"
  | "people"
  | "vehicle"
  | "animal"
  | "face"
  | "package" {
  switch (inferred) {
    case "motion":
    case "doorbell":
    case "people":
    case "vehicle":
    case "animal":
    case "face":
    case "package":
      return inferred;
    case "other":
    default:
      return "motion";
  }
}

/** Test hook: drop all subscribers, recent events, and reset the resolver. */
export function _resetEmailPushBusForTests(): void {
  emitter.removeAllListeners();
  cameraResolver = () => undefined;
  lastEventByCamera.clear();
  globalRecentEvents.length = 0;
}
