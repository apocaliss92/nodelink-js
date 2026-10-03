/**
 * Manager-app adapter on top of the library's Baichuan HaCfg webhook intake.
 */

import {
  createBaichuanWebhookServer,
  emitBaichuanWebhookEvent,
  getCameraWebhookPath as getLibCameraWebhookPath,
  getLastBaichuanWebhookEvent,
  getRecentBaichuanWebhookEvents,
  onBaichuanWebhookEvent,
  type BaichuanWebhookEvent,
  type BaichuanWebhookServerConfig,
  type BaichuanWebhookServerInstance,
  type BaichuanWebhookServerStatus,
} from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import { getCameras, getSettings } from "./settings-store.js";

export {
  getLastBaichuanWebhookEvent,
  getRecentBaichuanWebhookEvents,
  onBaichuanWebhookEvent,
  type BaichuanWebhookEvent,
  type BaichuanWebhookServerStatus,
};

const logger = createSourceLogger("baichuan-webhook");

let instance: BaichuanWebhookServerInstance | undefined;

function buildConfig(): BaichuanWebhookServerConfig {
  const s = getSettings().baichuanWebhook;
  return {
    port: Number(process.env.BAICHUAN_WEBHOOK_PORT) || s.port,
    bindHost: s.bindHost,
    pathPrefix: s.pathPrefix,
  };
}

function resolveCameraId(pathCameraId: string): string | undefined {
  const cameras = getCameras();
  const match = cameras.find(
    (c) => c.id === pathCameraId || c.name === pathCameraId,
  );
  return match?.id;
}

function ensureInstance(): BaichuanWebhookServerInstance {
  if (instance) {
    instance.updateConfig(buildConfig());
    return instance;
  }
  instance = createBaichuanWebhookServer({
    config: buildConfig(),
    cameraResolver: resolveCameraId,
    enabled: getSettings().baichuanWebhook.enabled,
    logger: {
      debug: (m) => logger.debug(m),
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
      error: (m) => logger.error(m),
    },
  });
  return instance;
}

export async function startBaichuanWebhookServer(): Promise<void> {
  const settings = getSettings();
  if (!settings.baichuanWebhook.enabled) {
    logger.debug("Baichuan webhook is disabled in settings; not starting");
    return;
  }
  await ensureInstance().start();
}

export async function stopBaichuanWebhookServer(): Promise<void> {
  if (!instance) return;
  await instance.stop();
}

export async function restartBaichuanWebhookServer(): Promise<void> {
  await ensureInstance().restart();
}

export function getBaichuanWebhookServerStatus(): BaichuanWebhookServerStatus {
  const settings = getSettings();
  if (instance) return instance.getStatus();
  return {
    enabled: settings.baichuanWebhook.enabled,
    running: false,
    port: settings.baichuanWebhook.port,
    bindHost: settings.baichuanWebhook.bindHost,
    pathPrefix: settings.baichuanWebhook.pathPrefix,
    messagesAccepted: 0,
    messagesRejected: 0,
    startedAtMs: undefined,
    lastErrorMessage: undefined,
  };
}

export function getCameraBaichuanWebhookPath(cameraId: string): string {
  return getLibCameraWebhookPath(
    cameraId,
    getSettings().baichuanWebhook.pathPrefix,
  );
}

/** Absolute URL a camera should POST to, given a manager host reachable from the camera. */
export function getCameraBaichuanWebhookUrl(
  cameraId: string,
  managerHost: string,
): string {
  const status = getBaichuanWebhookServerStatus();
  const path = getCameraBaichuanWebhookPath(cameraId);
  return `http://${managerHost}:${status.port}${path}`;
}

export function emitSyntheticBaichuanWebhookEventForTest(
  event: BaichuanWebhookEvent,
): void {
  emitBaichuanWebhookEvent(event);
}
