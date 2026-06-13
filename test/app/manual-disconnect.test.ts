/**
 * Tests for the standalone manual-disconnect gating.
 *
 * A user "disconnect" on a standalone camera must STICK: the autoStart
 * reconnect watchdog and the immediate-reconnect close handler must not bring
 * it back, and the auto-stream-on-connect listener must not re-register routes,
 * until an explicit "connect" clears the flag. This mirrors the existing
 * `disabledNvrCameras` mechanism for NVR children (see immediate-reconnect.test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ hookTimeout: 30_000 });

const isBatteryCameraSpy = vi.fn((camera: any) => camera?.transport === "udp");

let camerasFixture: Array<any> = [];
vi.mock("../../app/src/settings-store.js", () => ({
  getConfig: () => ({ cameras: camerasFixture }),
  getCamera: (id: string) => camerasFixture.find((c) => c.id === id),
  getNvr: (_id: string) => undefined,
  getSettings: () => ({
    localRtsp: { port: 8554 },
    serviceIp: "127.0.0.1",
    rtspProxyBackendIdleTimeoutMs: 0,
  }),
}));

vi.mock("../../app/src/camera-traits.js", () => ({
  isBatteryCamera: (camera: any) => isBatteryCameraSpy(camera),
}));

let mod: typeof import("../../app/src/rtsp-manager.js");

beforeEach(async () => {
  vi.resetModules();
  isBatteryCameraSpy.mockClear();
  mod = await import("../../app/src/rtsp-manager.js");
});

afterEach(() => {
  camerasFixture = [];
});

describe("manual-disconnect flag", () => {
  it("mark / is / clear round-trips", () => {
    expect(mod.isManuallyDisconnected("cam-x")).toBe(false);
    mod.markManuallyDisconnected("cam-x");
    expect(mod.isManuallyDisconnected("cam-x")).toBe(true);
    mod.clearManuallyDisconnected("cam-x");
    expect(mod.isManuallyDisconnected("cam-x")).toBe(false);
  });

  it("triggerImmediateReconnect skips a manually-disconnected standalone camera", async () => {
    // An autoStart, non-battery, standalone camera would normally proceed to a
    // real reconnect; the manual-disconnect flag must short-circuit it.
    camerasFixture = [
      { id: "cam-sa", name: "Standalone", host: "10.0.0.9", autoStart: true },
    ];
    mod.markManuallyDisconnected("cam-sa");
    await expect(mod.triggerImmediateReconnect("cam-sa")).resolves.toBeUndefined();
  });
});
