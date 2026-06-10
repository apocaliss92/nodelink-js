/**
 * Gating test for `triggerImmediateReconnect`.
 *
 * The function is fired from `attachConnectionListeners`' close handler so
 * every transient camera EPIPE / network blip kicks a reconnect within a few
 * ms instead of waiting up to {@link RECONNECT_CHECK_INTERVAL_MS} (30s) for
 * the watchdog tick. That 30s window was what cascaded into Frigate ffmpeg
 * watchdog restart loops in nodelink-js#34.
 *
 * We can't easily unit-test the success path without spinning up a real
 * camera (it bottoms out in `getOrCreateApiConnection` which does a full
 * Baichuan login). What we CAN test deterministically — and what's most
 * worth pinning — is the skip / gating logic: the close handler fires the
 * helper for EVERY affected camera, so any mis-gate here would result in
 * connect storms or repeated login attempts against cameras the user has
 * explicitly disabled. That's the regression we want to lock down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isBatteryCameraSpy = vi.fn((camera: any) => camera?.transport === "udp");

// Mock the config store so we can rotate camera shapes per test.
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

// The helper transitively imports a bunch of things from
// `@apocaliss92/nodelink-js` (the published lib). For the SKIP paths we
// never actually touch the lib — the early returns trip first — so the
// real import is fine. The success-path tests would need a heavier mock,
// which we deliberately don't add here (see file header).

// Import AFTER the mocks so the module sees the mocked deps.
let triggerImmediateReconnect: (cameraId: string) => Promise<void>;
let getRtspServerKey: (id: string, p: string, ch: number) => string;
let mod: typeof import("../../app/src/rtsp-manager.js");

beforeEach(async () => {
  vi.resetModules();
  isBatteryCameraSpy.mockClear();
  mod = await import("../../app/src/rtsp-manager.js");
  triggerImmediateReconnect = mod.triggerImmediateReconnect;
  getRtspServerKey = mod.getRtspServerKey;
});

afterEach(() => {
  camerasFixture = [];
});

describe("triggerImmediateReconnect — skip / gating logic", () => {
  it("silently no-ops when the camera id is not in the config", async () => {
    camerasFixture = [];
    await expect(
      triggerImmediateReconnect("nonexistent-id"),
    ).resolves.toBeUndefined();
    // Battery check should never run because the camera lookup short-circuits.
    expect(isBatteryCameraSpy).not.toHaveBeenCalled();
  });

  it("silently no-ops when the camera has autoStart != true (manual-only stream)", async () => {
    camerasFixture = [
      {
        id: "cam-manual",
        name: "Manual Cam",
        host: "10.0.0.99",
        port: 9000,
        username: "u",
        password: "p",
        autoStart: false,
      },
    ];
    await expect(triggerImmediateReconnect("cam-manual")).resolves.toBeUndefined();
    // We bail before consulting battery state.
    expect(isBatteryCameraSpy).not.toHaveBeenCalled();
  });

  it("silently no-ops for a battery camera (its idle-disconnect lifecycle handles reconnect)", async () => {
    camerasFixture = [
      {
        id: "cam-bat",
        name: "Battery Cam",
        host: "10.0.0.50",
        port: 9000,
        username: "u",
        password: "p",
        autoStart: true,
        transport: "udp",
      },
    ];
    await expect(triggerImmediateReconnect("cam-bat")).resolves.toBeUndefined();
    expect(isBatteryCameraSpy).toHaveBeenCalledTimes(1);
    expect(isBatteryCameraSpy.mock.calls[0]?.[0]).toMatchObject({
      id: "cam-bat",
      transport: "udp",
    });
  });
});

describe("rtsp-manager — helper exports remain stable", () => {
  it("getRtspServerKey still namespaces by cameraId/profile/channel", () => {
    expect(getRtspServerKey("cam-1", "main", 0)).toBe("cam-1:main:0");
    expect(getRtspServerKey("cam-1", "sub", 3)).toBe("cam-1:sub:3");
    expect(getRtspServerKey("cam-1", "main", 0)).not.toBe(
      getRtspServerKey("cam-2", "main", 0),
    );
  });
});
