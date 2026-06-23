import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Regression coverage for issue #35: an NVR-attached battery doorbell whose
// recipient (`cam-<id>@<domain>`) matched its camera id EXACTLY was still
// rejected with `550 Unknown recipient`. Root cause: the email-push camera
// resolver closed over a settings snapshot captured at server boot, but
// `saveSettings()` reassigns the store's settings object on every change — so
// any camera added/edited after boot was invisible to the resolver.
//
// settings-store reads process.env.DATA_PATH at module-load time and runs
// loadSettings() as a side effect, so each test gets a fresh module instance
// pointed at its own temp directory (same pattern as settings-store-atomic).

let tmpDir: string;
let prevDataPath: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-push-resolver-"));
  prevDataPath = process.env.DATA_PATH;
  process.env.DATA_PATH = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevDataPath === undefined) {
    delete process.env.DATA_PATH;
  } else {
    process.env.DATA_PATH = prevDataPath;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function load() {
  // Import the store first, then the resolver. Both resolve to the same module
  // instance in the registry (post-resetModules), so cameras added via `store`
  // are the same singleton the resolver reads through `getCameras()`.
  const store = await import("../../app/src/settings-store.js");
  const resolver = await import("../../app/src/email-push-resolver.js");
  return { store, resolver };
}

const baseCamera = {
  name: "Front Door",
  host: "192.168.1.2",
  username: "admin",
  password: "secret",
};

describe("resolveEmailPushCameraId (issue #35)", () => {
  it("returns undefined when no camera matches", async () => {
    const { resolver } = await load();
    expect(resolver.resolveEmailPushCameraId("nonexistent")).toBeUndefined();
  });

  it("resolves a camera added AFTER the resolver module loaded (no stale snapshot)", async () => {
    const { store, resolver } = await load();
    // The resolver module has already imported settings-store; the camera list
    // was empty at that point. Adding now must still be visible — proving the
    // resolver reads live state rather than a boot-time snapshot.
    const cam = store.addCamera({ ...baseCamera });
    expect(resolver.resolveEmailPushCameraId(cam.id)).toBe(cam.id);
  });

  it("resolves an NVR-attached camera by exact id (the issue #35 scenario)", async () => {
    const { store, resolver } = await load();
    const cam = store.addCamera({
      ...baseCamera,
      name: "Doorbell",
      nvrId: "nvr-1",
      isNvr: true,
    });
    expect(resolver.resolveEmailPushCameraId(cam.id)).toBe(cam.id);
  });

  it("matches the id case-insensitively", async () => {
    const { store, resolver } = await load();
    const cam = store.addCamera({ ...baseCamera });
    expect(resolver.resolveEmailPushCameraId(cam.id.toUpperCase())).toBe(cam.id);
  });

  it("matches by sanitized camera name", async () => {
    const { store, resolver } = await load();
    const { sanitizeCameraName } = await import(
      "../../app/src/camera-name.js"
    );
    const cam = store.addCamera({ ...baseCamera, name: "Back Yard" });
    expect(
      resolver.resolveEmailPushCameraId(sanitizeCameraName("Back Yard")),
    ).toBe(cam.id);
  });
});
