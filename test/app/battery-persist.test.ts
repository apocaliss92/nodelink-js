/**
 * A battery push event is definitive proof a camera is a battery camera.
 * For standalone cams that never resolved to transport=udp, the handler must
 * persist transport=udp so `isBatteryCamera` (and everything keyed off it) is
 * correct. NVR children must NOT be touched (they keep their NVR transport).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ hookTimeout: 30_000 });

let camerasFixture: Array<any> = [];
const updateCameraSpy = vi.fn();

vi.mock("../../app/src/settings-store.js", () => ({
  getConfig: () => ({ cameras: camerasFixture }),
  getSettings: () => ({ homeAssistant: { enabled: false }, mqtt: { enabled: false } }),
  updateCamera: (id: string, patch: any) => updateCameraSpy(id, patch),
}));

vi.mock("../../app/src/rtsp-manager.js", () => ({
  onApiConnected: () => {},
  onApiDisconnected: () => {},
  getCameraInfo: (id: string) => ({ id, name: id }),
  sanitizeCameraName: (n: string) => n,
}));

vi.mock("../../app/src/camera-traits.js", () => ({
  isBatteryCamera: (camera: any) => camera?.transport === "udp",
}));

let handleCameraEvent: (cameraId: string, event: any) => void;

beforeEach(async () => {
  vi.resetModules();
  updateCameraSpy.mockClear();
  const mod = await import("../../app/src/events-manager.js");
  handleCameraEvent = mod.handleCameraEvent;
});

afterEach(() => {
  camerasFixture = [];
});

const batteryEvent = {
  type: "battery",
  channel: 0,
  timestamp: 1,
  battery: { batteryPercent: 55, chargeStatus: "none", adapterStatus: "none" },
};

describe("battery push → persist transport=udp", () => {
  it("persists transport=udp for a standalone camera on transport auto", () => {
    camerasFixture = [{ id: "cam-a", name: "Argus", host: "10.0.0.5", transport: "auto" }];
    handleCameraEvent("cam-a", batteryEvent);
    expect(updateCameraSpy).toHaveBeenCalledWith("cam-a", { transport: "udp" });
  });

  it("does nothing when the camera is already transport=udp", () => {
    camerasFixture = [{ id: "cam-a", name: "Argus", host: "10.0.0.5", transport: "udp" }];
    handleCameraEvent("cam-a", batteryEvent);
    expect(updateCameraSpy).not.toHaveBeenCalled();
  });

  it("does not touch an NVR child camera", () => {
    camerasFixture = [{ id: "cam-c", name: "NvrCam", nvrId: "nvr-1", transport: "auto" }];
    handleCameraEvent("cam-c", batteryEvent);
    expect(updateCameraSpy).not.toHaveBeenCalled();
  });
});
