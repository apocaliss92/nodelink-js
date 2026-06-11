/**
 * Regression test for the boot-time startup race in
 * `app/src/backchannel-manager.ts`.
 *
 * The bug: `startBackchannelServer()` used to call `ensureListenersWired()`
 * BEFORE assigning the module-level `server` singleton. The first thing
 * `onApiConnected(cb)` does inside `ensureListenersWired` is flush the
 * callback for every camera already in `apiConnections` (synchronously);
 * inside that callback the first line is `if (!server) return;`. Net effect:
 * for every camera that connected during `autoStartRtspServers()` (which
 * runs BEFORE `startBackchannelServer()`), the listener bailed and the
 * backchannel route never landed on the mux. go2rtc's DESCRIBE on
 * `rtsp://host:8554/<cameraName>` got a 404 from LocalRtspMux, Frigate UI
 * decided the camera had no two-way audio and dropped the mic button.
 *
 * The fix is `server = new BaichuanRtspBackchannelServer(...)` BEFORE
 * `ensureListenersWired()`. This test pins that ordering by simulating a
 * camera that's already in the connection map at the time
 * `startBackchannelServer` is called and asserting the route makes it both
 * onto the backchannel server's route table AND onto the LocalRtspMux.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.resetModules()` in beforeEach pays for the full re-import of the
// rtsp-manager dependency graph (which now transitively pulls the
// server-binding HTTP client and other cloud helpers). The default 10s
// hook timeout occasionally fires under CI cold-start load.
vi.setConfig({ hookTimeout: 30_000 });

// Captured by the BaichuanRtspBackchannelServer mock so the test can
// inspect every addRoute() call regardless of which instance was used.
const addRouteSpy = vi.fn();
const removeRouteSpy = vi.fn();
const listRoutesSpy = vi.fn(() => [] as string[]);
const stopSpy = vi.fn(async () => {});

vi.mock("@apocaliss92/nodelink-js", () => {
  class FakeBackchannelServer {
    addRoute = addRouteSpy;
    removeRoute = removeRouteSpy;
    listRoutes = listRoutesSpy;
    stop = stopSpy;
  }
  return { BaichuanRtspBackchannelServer: FakeBackchannelServer };
});

// `onApiConnected(cb)` should:
//   - push `cb` to the listener list for future connections, and
//   - flush `cb` synchronously for every camera already considered ready.
// We simulate the latter — one pre-connected camera — to reproduce the
// boot scenario described in the file header.
const fakeReadyApi = { isReady: true, __tag: "fake-api" } as const;
const preconnectedCameraId = "cam-living-room";

const onApiConnectedSpy = vi.fn(
  (cb: (cameraId: string, api: unknown) => void) => {
    cb(preconnectedCameraId, fakeReadyApi);
  },
);
const onApiDisconnectedSpy = vi.fn();
const sanitizeCameraNameSpy = vi.fn((name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
);

vi.mock("../../app/src/rtsp-manager.js", () => ({
  onApiConnected: onApiConnectedSpy,
  onApiDisconnected: onApiDisconnectedSpy,
  sanitizeCameraName: sanitizeCameraNameSpy,
}));

const getCameraSpy = vi.fn((id: string) =>
  id === preconnectedCameraId
    ? { id, name: "Living Room", rtspChannel: 0 }
    : undefined,
);

vi.mock("../../app/src/settings-store.js", () => ({
  getCamera: getCameraSpy,
}));

const muxRegisterSpy = vi.fn();
const muxUnregisterSpy = vi.fn();
const fakeMux = {
  register: muxRegisterSpy,
  unregister: muxUnregisterSpy,
  isStarted: true,
  listenHost: "127.0.0.1",
  listenPort: 8554,
};

vi.mock("../../app/src/local-rtsp-mux.js", () => ({
  getLocalRtspMux: () => fakeMux,
}));

// Logger mock: avoid noise from the manager's `createSourceLogger` import.
vi.mock("../../app/src/logger.js", () => ({
  createSourceLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

describe("backchannel-manager — boot-time route registration", () => {
  beforeEach(() => {
    addRouteSpy.mockClear();
    removeRouteSpy.mockClear();
    listRoutesSpy.mockClear();
    stopSpy.mockClear();
    onApiConnectedSpy.mockClear();
    onApiDisconnectedSpy.mockClear();
    getCameraSpy.mockClear();
    muxRegisterSpy.mockClear();
    muxUnregisterSpy.mockClear();
    // Reset module state so each test starts with no `server` singleton.
    vi.resetModules();
  });

  it("registers the backchannel route for a camera that was ALREADY connected when startBackchannelServer was called (the boot-race fix)", async () => {
    // Importing AFTER vi.resetModules() so the module's `server` /
    // `listenersWired` singletons start fresh for this case.
    const mod = await import("../../app/src/backchannel-manager.js");

    await mod.startBackchannelServer();

    // The pre-connected camera's route must end up on BOTH the backchannel
    // server's route table AND the LocalRtspMux. Either one missing means
    // Frigate's go2rtc would hit a 404 (mux side) or open the session but
    // fail to find a TalkSession (backchannel side).
    expect(addRouteSpy).toHaveBeenCalledTimes(1);
    expect(addRouteSpy).toHaveBeenCalledWith(
      "/living_room",
      expect.objectContaining({
        api: fakeReadyApi,
        channel: 0,
        deviceId: `talk-${preconnectedCameraId}`,
      }),
    );
    expect(muxRegisterSpy).toHaveBeenCalledTimes(1);
    expect(muxRegisterSpy).toHaveBeenCalledWith(
      "/living_room",
      expect.anything(),
    );
  });

  it("startBackchannelServer is idempotent — calling it twice does not double-register", async () => {
    const mod = await import("../../app/src/backchannel-manager.js");
    await mod.startBackchannelServer();
    await mod.startBackchannelServer();
    expect(addRouteSpy).toHaveBeenCalledTimes(1);
    expect(muxRegisterSpy).toHaveBeenCalledTimes(1);
  });
});
