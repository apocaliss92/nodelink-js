/**
 * Manager-app adapter on top of the library's email-push SMTP intake.
 *
 * The real engine lives in `@apocaliss92/nodelink-js`'s `emailPush`
 * module — bus, server factory, classification, AUTH normalisation and
 * the TLS loader. This file is a thin glue layer that:
 *
 *   - holds the singleton server instance for this process,
 *   - reads/writes the manager's `settings.json` for the SMTP config,
 *   - re-exports the bus helpers (so the rest of app/ keeps importing
 *     them from a single local path).
 *
 * The cameraResolver wiring stays in `server.ts` startup — same as
 * before, just routed through the lib bus now.
 */

import path from "node:path";
import {
  createEmailPushServer,
  emitEmailPushEvent,
  getCameraEmailAddress as getLibCameraEmailAddress,
  getLastEmailPushEvent,
  getRecentEmailPushEvents,
  onEmailPushEvent,
  setEmailPushCameraResolver,
  getEmailPushCameraResolver,
  type EmailPushEvent,
  type EmailPushInferredType,
  type EmailPushServerConfig,
  type EmailPushServerInstance,
  type EmailPushServerStatus,
} from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import { getSettings } from "./settings-store.js";

export {
  getLastEmailPushEvent,
  getRecentEmailPushEvents,
  onEmailPushEvent,
  setEmailPushCameraResolver,
  type EmailPushEvent,
  type EmailPushInferredType,
  type EmailPushServerStatus,
};

const logger = createSourceLogger("email-push");

const DATA_DIR = process.env.DATA_PATH || ".";
const TLS_DIR = path.join(DATA_DIR, "email-push-tls");

let instance: EmailPushServerInstance | undefined;

function buildConfig(): EmailPushServerConfig {
  const s = getSettings().emailPush;
  return {
    port: s.port,
    bindHost: s.bindHost,
    domain: s.domain,
    requireAuth: s.requireAuth,
    authUsername: s.authUsername,
    authPassword: s.authPassword,
    tls: s.tls,
    tlsDir: TLS_DIR,
    maxMessageBytes: s.maxMessageBytes,
  };
}

function ensureInstance(): EmailPushServerInstance {
  if (instance) {
    instance.updateConfig(buildConfig());
    return instance;
  }
  instance = createEmailPushServer({
    config: buildConfig(),
    // Resolver is installed globally on the bus by server.ts startup —
    // we forward through `getEmailPushCameraResolver()` so the lib still
    // gets the manager-app's mapping (id-or-name → cameraId).
    cameraResolver: (local) => getEmailPushCameraResolver()(local),
    logger: {
      debug: (m) => logger.debug(m),
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
      error: (m) => logger.error(m),
    },
  });
  return instance;
}

export async function startEmailPushServer(): Promise<void> {
  const settings = getSettings();
  if (!settings.emailPush.enabled) {
    logger.debug("Email push is disabled in settings; not starting");
    return;
  }
  await ensureInstance().start();
}

export async function stopEmailPushServer(): Promise<void> {
  if (!instance) return;
  await instance.stop();
}

export async function restartEmailPushServer(): Promise<void> {
  await ensureInstance().restart();
}

export function getEmailPushServerStatus(): EmailPushServerStatus {
  const settings = getSettings();
  if (instance) return instance.getStatus();
  return {
    enabled: settings.emailPush.enabled,
    running: false,
    port: settings.emailPush.port,
    bindHost: settings.emailPush.bindHost,
    domain: settings.emailPush.domain,
    requireAuth: settings.emailPush.requireAuth,
    tls: settings.emailPush.tls,
    messagesAccepted: 0,
    messagesRejected: 0,
    startedAtMs: undefined,
    lastErrorMessage: undefined,
  };
}

/** Build the recipient address assigned to a given camera. */
export function getCameraEmailAddress(cameraId: string): string {
  return getLibCameraEmailAddress(cameraId, getSettings().emailPush.domain);
}

/** Test hook: dispatch a synthetic event into the bus without an SMTP round-trip. */
export function emitSyntheticEmailPushEventForTest(
  event: EmailPushEvent,
): void {
  emitEmailPushEvent(event);
}
