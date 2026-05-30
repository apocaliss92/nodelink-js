/**
 * Email push event bus.
 *
 * Kept in a dedicated module — and intentionally free of `smtp-server` /
 * `mailparser` dependencies — so consumers (the events-manager, MQTT
 * bridge, integration tests, …) can subscribe to email-push events
 * without pulling in the SMTP server's native deps. The actual SMTP
 * intake (`email-push-server.ts`) lives next to this file and emits
 * through this bus.
 *
 * The bus is **stateless**: it does NOT persist snapshots to disk and
 * does NOT keep a per-camera ring buffer of recent events. Images for
 * motion/AI events are expected to flow on the MQTT/HomeAssistant
 * integration directly from the live camera snapshot, decoupled from
 * the email transport.
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
  emitter.emit("event", event);
}

/** Test hook: drop all subscribers and reset the resolver. */
export function _resetEmailPushBusForTests(): void {
  emitter.removeAllListeners();
  cameraResolver = () => undefined;
}
