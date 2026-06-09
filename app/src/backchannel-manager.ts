/**
 * Multi-camera RTSP backchannel for Frigate 2-way audio. Always-on.
 *
 * Piggy-backs on the same LocalRtspMux that serves video. Video paths take
 * `/<cameraName>/<profile>`, backchannel takes `/<cameraName>` (no profile
 * suffix), so they coexist on a single TCP port. The rtsp-manager
 * `onApiConnected` / `onApiDisconnected` hooks drive route (de)registration
 * as each camera's underlying ReolinkBaichuanApi becomes ready / disconnects.
 */

import type { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";
import { BaichuanRtspBackchannelServer } from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";
import { getCamera } from "./settings-store.js";
import {
  onApiConnected,
  onApiDisconnected,
  sanitizeCameraName,
} from "./rtsp-manager.js";
import { getLocalRtspMux } from "./local-rtsp-mux.js";
import type { CameraConfig } from "./types.js";

const logger = createSourceLogger("backchannel");

let server: BaichuanRtspBackchannelServer | undefined;
let listenersWired = false;
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
      `LocalRtspMux not initialised yet — path ${path} will land on next reconcile`,
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
  if (mux) {
    for (const path of muxRegisteredPaths) mux.unregister(path);
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
    muxRegisterCamera(path);
    logger.info(
      `route registered cameraId=${cam.id} name="${cam.name}" path=${path} channel=${channelForCamera(cam)}`,
    );
  });

  onApiDisconnected((cameraId: string) => {
    if (!server) return;
    const cam = getCamera(cameraId);
    if (!cam) return;
    const path = pathForCamera(cam);
    muxUnregisterCamera(path);
    if (server.removeRoute(path)) {
      logger.info(
        `route unregistered cameraId=${cam.id} name="${cam.name}" path=${path}`,
      );
    }
  });
}

export interface BackchannelStatus {
  /** Always true now — kept for API stability with older clients. */
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly routes: readonly string[];
}

export function getBackchannelStatus(): BackchannelStatus {
  const mux = getLocalRtspMux();
  return {
    enabled: true,
    listening: mux?.isStarted ?? false,
    host: mux?.listenHost ?? null,
    port: mux?.listenPort ?? null,
    routes: server?.listRoutes() ?? [],
  };
}

/**
 * Attach the backchannel to the shared LocalRtspMux. Called once at boot —
 * always-on now, no settings flag to consult.
 */
export async function startBackchannelServer(): Promise<void> {
  if (server) return;

  // Create the server FIRST. `onApiConnected` (called by
  // `ensureListenersWired`) flushes the listener for every camera that
  // already connected during boot; that flush invokes the listener
  // synchronously, and the listener checks `if (!server) return;` before
  // touching the route table. If we wired listeners before assigning
  // `server`, the flush would bail for every already-connected camera and
  // their backchannel routes would never land on the mux — the symptom
  // being a 404 on /<cameraName> for go2rtc's talk URL and the mic button
  // disappearing in Frigate's UI. The server instance itself is never
  // start()ed: it lives purely as a registry + injectSocket() target
  // driven by LocalRtspMux dispatch.
  server = new BaichuanRtspBackchannelServer({
    routes: {},
    listenHost: "127.0.0.1",
    listenPort: 0,
    logger: {
      info: (m: string) => logger.info(m),
      warn: (m: string) => logger.warn(m),
      error: (m: string) => logger.error(m),
      debug: (m: string) => logger.debug(m),
      log: (m: string) => logger.info(m),
    },
  });

  ensureListenersWired();

  const mux = getLocalRtspMux();
  logger.info(`attached to LocalRtspMux mux=${mux ? "ready" : "pending"}`);
}

export async function stopBackchannelServer(): Promise<void> {
  muxUnregisterAll();
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
