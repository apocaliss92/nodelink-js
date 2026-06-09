/**
 * Single-listener, multi-camera RTSP backchannel for Frigate 2-way audio.
 *
 * One TCP port serves every camera under its own URL path (`/{cameraName}`)
 * so adding a camera does not open a new port. The manager owns one
 * `BaichuanRtspBackchannelServer` instance and uses the rtsp-manager
 * connection events (`onApiConnected` / `onApiDisconnected`) to register
 * and remove routes as each camera's underlying ReolinkBaichuanApi becomes
 * ready / disconnects.
 */

import type { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";
import { BaichuanRtspBackchannelServer } from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import { getSettings, getCamera } from "./settings-store.js";
import {
  onApiConnected,
  onApiDisconnected,
  sanitizeCameraName,
} from "./rtsp-manager.js";
import type { CameraConfig } from "./types.js";

const logger = createSourceLogger("backchannel");

let server: BaichuanRtspBackchannelServer | undefined;
let listenersWired = false;
let lastError: string | null = null;

function pathForCamera(cam: CameraConfig): string {
  return `/${sanitizeCameraName(cam.name)}`;
}

function channelForCamera(cam: CameraConfig): number {
  return typeof cam.rtspChannel === "number" ? cam.rtspChannel : 0;
}

function ensureListenersWired(): void {
  if (listenersWired) return;
  listenersWired = true;

  onApiConnected((cameraId: string, api: ReolinkBaichuanApi) => {
    if (!server) return;
    const cam = getCamera(cameraId);
    if (!cam) {
      logger.warn(
        `connected api for unknown camera ${cameraId} — skipping backchannel route`,
      );
      return;
    }
    const path = pathForCamera(cam);
    server.addRoute(path, {
      api,
      channel: channelForCamera(cam),
      deviceId: `talk-${cam.id}`,
    });
    logger.info(
      `route registered cameraId=${cam.id} name="${cam.name}" path=${path} channel=${channelForCamera(cam)}`,
    );
  });

  onApiDisconnected((cameraId: string) => {
    if (!server) return;
    const cam = getCamera(cameraId);
    // If the camera was deleted from settings before disconnect we cannot
    // recompute the path — best-effort: nothing to do; orphan routes are
    // pruned on next reconcile/restart.
    if (!cam) return;
    const path = pathForCamera(cam);
    if (server.removeRoute(path)) {
      logger.info(
        `route unregistered cameraId=${cam.id} name="${cam.name}" path=${path}`,
      );
    }
  });
}

export interface BackchannelStatus {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly routes: readonly string[];
  /** Last bind / startup error, surfaced for the UI. Null when healthy. */
  readonly lastError: string | null;
}

export function getBackchannelStatus(): BackchannelStatus {
  const cfg = getSettings().talk;
  return {
    enabled: cfg.enabled === true,
    listening: server?.listening ?? false,
    host: server ? cfg.bindHost : null,
    port: server ? cfg.port : null,
    routes: server?.listRoutes() ?? [],
    lastError,
  };
}

/**
 * Start the shared backchannel server using the current settings. Safe to
 * call repeatedly — already-running server is left alone. When the server
 * is disabled in settings the call is a no-op (and a running server is
 * stopped, so the toggle has immediate effect).
 */
export async function startBackchannelServer(): Promise<void> {
  const cfg = getSettings().talk;
  if (!cfg.enabled) {
    if (server) {
      logger.info("disabled in settings — stopping running server");
      await stopBackchannelServer();
    }
    return;
  }

  if (server) return;

  // Wire the connect/disconnect listeners before binding the port. The
  // onApiConnected callback is invoked synchronously for cameras whose API
  // is already ready, so any camera that connected earlier in the startup
  // sequence gets its route registered as soon as the server exists.
  ensureListenersWired();

  const newServer = new BaichuanRtspBackchannelServer({
    routes: {},
    listenHost: cfg.bindHost,
    listenPort: cfg.port,
    logger: {
      info: (m: string) => logger.info(m),
      warn: (m: string) => logger.warn(m),
      error: (m: string) => logger.error(m),
      debug: (m: string) => logger.debug(m),
      log: (m: string) => logger.info(m),
    },
  });

  try {
    await newServer.start();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.error(
      `failed to bind ${cfg.bindHost}:${cfg.port} — ${lastError}`,
    );
    // Don't propagate: backchannel is an optional feature, a bind failure
    // shouldn't escalate into a startup error / unhandled rejection. The
    // user sees lastError via talk.status and can pick a free port.
    return;
  }
  server = newServer;
  lastError = null;
  logger.info(`listening on ${cfg.bindHost}:${cfg.port}`);
}

export async function stopBackchannelServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = undefined;
  try {
    await s.stop();
    logger.info("stopped");
  } catch (err) {
    logger.warn(
      `error while stopping: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Settings-update hook — call after `talk.*` changes so the server picks
 * up new enabled / port / bindHost values. Restart-on-change is the
 * simplest correct path because the server doesn't expose its own
 * bind config for diffing.
 */
export async function reconcileBackchannelServer(): Promise<void> {
  const cfg = getSettings().talk;
  if (!cfg.enabled) {
    if (server) await stopBackchannelServer();
    return;
  }
  if (!server) {
    await startBackchannelServer();
    return;
  }
  await stopBackchannelServer();
  await startBackchannelServer();
}
