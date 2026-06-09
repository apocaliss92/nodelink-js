/**
 * Single-listener, multi-camera RTSP backchannel for Frigate 2-way audio.
 *
 * One TCP port serves every camera under its own URL path (`/{cameraName}`)
 * so adding a camera does not open a new port. Two operational modes:
 *
 *   - **go2rtc restreamer**: we own a dedicated TCP listener on
 *     `settings.talk.port`. go2rtc owns the video output port and we can't
 *     share with it across processes, so the talk listener stands alone.
 *
 *   - **local restreamer**: video already flows through `LocalRtspMux` on
 *     `settings.localRtsp.port`. We register one mux route per camera that
 *     points at the same `BaichuanRtspBackchannelServer` instance via
 *     `injectSocket()`. Result: video and talk share a single TCP port,
 *     differentiated by path (`/<cameraName>/main` vs `/<cameraName>`).
 *
 * In both modes the rtsp-manager connection events (`onApiConnected` /
 * `onApiDisconnected`) drive route (de)registration as each camera's
 * ReolinkBaichuanApi becomes ready / disconnects.
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
import { getLocalRtspMux } from "./local-rtsp-mux.js";
import type { CameraConfig } from "./types.js";

const logger = createSourceLogger("backchannel");

type Mode = "dedicated" | "mux" | "disabled";

let server: BaichuanRtspBackchannelServer | undefined;
let activeMode: Mode = "disabled";
let listenersWired = false;
let lastError: string | null = null;
/** Paths we registered on LocalRtspMux. Tracked so we can unregister cleanly. */
const muxRegisteredPaths = new Set<string>();

function pathForCamera(cam: CameraConfig): string {
  return `/${sanitizeCameraName(cam.name)}`;
}

function channelForCamera(cam: CameraConfig): number {
  return typeof cam.rtspChannel === "number" ? cam.rtspChannel : 0;
}

function muxRegisterCamera(path: string): void {
  if (!server) return;
  const mux = getLocalRtspMux();
  if (!mux) {
    logger.warn(
      `local restreamer selected but LocalRtspMux not initialised yet — path ${path} will be added on next reconcile`,
    );
    return;
  }
  mux.register(path, server);
  muxRegisteredPaths.add(path);
}

function muxUnregisterCamera(path: string): void {
  const mux = getLocalRtspMux();
  if (mux) mux.unregister(path);
  muxRegisteredPaths.delete(path);
}

function muxUnregisterAll(): void {
  const mux = getLocalRtspMux();
  if (!mux) {
    muxRegisteredPaths.clear();
    return;
  }
  for (const path of muxRegisteredPaths) {
    mux.unregister(path);
  }
  muxRegisteredPaths.clear();
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
    if (activeMode === "mux") muxRegisterCamera(path);
    logger.info(
      `route registered cameraId=${cam.id} name="${cam.name}" path=${path} channel=${channelForCamera(cam)} mode=${activeMode}`,
    );
  });

  onApiDisconnected((cameraId: string) => {
    if (!server) return;
    const cam = getCamera(cameraId);
    if (!cam) return;
    const path = pathForCamera(cam);
    if (activeMode === "mux") muxUnregisterCamera(path);
    if (server.removeRoute(path)) {
      logger.info(
        `route unregistered cameraId=${cam.id} name="${cam.name}" path=${path}`,
      );
    }
  });
}

export interface BackchannelStatus {
  readonly enabled: boolean;
  /** Whether the server is currently reachable (bound listener or mux-attached). */
  readonly listening: boolean;
  readonly host: string | null;
  readonly port: number | null;
  /**
   * "dedicated" = our own TCP listener on settings.talk.port.
   * "mux"       = sharing the LocalRtspMux port (no separate listener).
   * "disabled"  = settings.talk.enabled is false.
   */
  readonly mode: Mode;
  readonly routes: readonly string[];
  /** Last bind / startup error, surfaced for the UI. Null when healthy. */
  readonly lastError: string | null;
}

export function getBackchannelStatus(): BackchannelStatus {
  const settings = getSettings();
  const cfg = settings.talk;
  if (!cfg.enabled) {
    return {
      enabled: false,
      listening: false,
      host: null,
      port: null,
      mode: "disabled",
      routes: [],
      lastError,
    };
  }
  if (activeMode === "mux") {
    const mux = getLocalRtspMux();
    return {
      enabled: true,
      listening: mux?.isStarted ?? false,
      host: mux ? mux.listenHost : null,
      port: mux ? mux.listenPort : null,
      mode: "mux",
      routes: server?.listRoutes() ?? [],
      lastError,
    };
  }
  return {
    enabled: true,
    listening: server?.listening ?? false,
    host: server ? cfg.bindHost : null,
    port: server ? cfg.port : null,
    mode: activeMode,
    routes: server?.listRoutes() ?? [],
    lastError,
  };
}

function makeServerInstance(host: string, port: number): BaichuanRtspBackchannelServer {
  return new BaichuanRtspBackchannelServer({
    routes: {},
    listenHost: host,
    listenPort: port,
    logger: {
      info: (m: string) => logger.info(m),
      warn: (m: string) => logger.warn(m),
      error: (m: string) => logger.error(m),
      debug: (m: string) => logger.debug(m),
      log: (m: string) => logger.info(m),
    },
  });
}

/**
 * Start the backchannel for the current settings. Picks dedicated-listener
 * or mux-attached mode based on `settings.restreamer`. Safe to call
 * repeatedly — re-entry with the same desired state is a no-op.
 */
export async function startBackchannelServer(): Promise<void> {
  const settings = getSettings();
  const cfg = settings.talk;
  if (!cfg.enabled) {
    if (server) await stopBackchannelServer();
    return;
  }

  const desiredMode: Mode = settings.restreamer === "local" ? "mux" : "dedicated";

  if (server && activeMode === desiredMode) {
    return; // already running in the right mode
  }
  if (server) {
    // mode change — stop and recreate
    await stopBackchannelServer();
  }

  ensureListenersWired();

  if (desiredMode === "mux") {
    // No listener of our own. The mux owns the port; we just keep the
    // BaichuanRtspBackchannelServer around for its route registry and
    // injectSocket() implementation, then register paths on the mux as
    // cameras connect (via the onApiConnected listener above).
    server = makeServerInstance(cfg.bindHost, cfg.port);
    activeMode = "mux";
    lastError = null;
    // Pre-flight: the mux may not be up yet at very early boot. We still
    // succeed here — the mux register call retries lazily on each
    // onApiConnected; once `ensureLocalRtspMux()` runs in server.ts the
    // routes will land on the next camera reconnect. Most setups already
    // have the mux up before this point.
    const mux = getLocalRtspMux();
    logger.info(
      `attached to LocalRtspMux mode=mux mux=${mux ? "ready" : "pending"}`,
    );
    return;
  }

  // Dedicated-listener mode.
  const newServer = makeServerInstance(cfg.bindHost, cfg.port);
  try {
    await newServer.start();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.error(
      `failed to bind ${cfg.bindHost}:${cfg.port} — ${lastError}`,
    );
    return;
  }
  server = newServer;
  activeMode = "dedicated";
  lastError = null;
  logger.info(`listening on ${cfg.bindHost}:${cfg.port} mode=dedicated`);
}

export async function stopBackchannelServer(): Promise<void> {
  // Unregister any mux paths we own first so the mux doesn't keep handing
  // sockets to a torn-down handler.
  if (activeMode === "mux") muxUnregisterAll();

  if (!server) {
    activeMode = "disabled";
    return;
  }
  const s = server;
  server = undefined;
  activeMode = "disabled";
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
 * Settings-update hook — call after `talk.*` or `restreamer` changes so
 * the server picks up new enabled / mode / port / bindHost values.
 */
export async function reconcileBackchannelServer(): Promise<void> {
  const settings = getSettings();
  const cfg = settings.talk;
  if (!cfg.enabled) {
    if (server) await stopBackchannelServer();
    return;
  }
  const desiredMode: Mode = settings.restreamer === "local" ? "mux" : "dedicated";
  if (!server || activeMode !== desiredMode) {
    await stopBackchannelServer();
    await startBackchannelServer();
    return;
  }
  // Same mode + same enabled state. For "dedicated" we still restart on a
  // potential port/bindHost change — cheap and avoids stale config.
  if (desiredMode === "dedicated") {
    await stopBackchannelServer();
    await startBackchannelServer();
  }
  // For "mux" there's nothing port-related to change here; the LocalRtspMux
  // owns the port via the restreamer settings flow.
}
