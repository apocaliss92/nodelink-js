import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// settings-store reads process.env.DATA_PATH at module-load time and runs
// loadSettings() as a side effect. Each test needs a fresh module instance
// pointed at its own temp directory, so we reset the module cache before
// every dynamic import.
let tmpDir: string;
let prevDataPath: string | undefined;

async function freshStore() {
  vi.resetModules();
  return await import("../../app/src/settings-store.js");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-"));
  prevDataPath = process.env.DATA_PATH;
  process.env.DATA_PATH = tmpDir;
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

describe("settings-store atomic save (issue #17)", () => {
  it("writes settings.json without leaving a temp file behind", async () => {
    const store = await freshStore();
    store.saveSettings({});

    const files = fs.readdirSync(tmpDir);
    expect(files).toContain("settings.json");
    const stray = files.filter((f) => f.startsWith(".settings.json.tmp"));
    expect(stray).toEqual([]);
  });

  it("creates a settings.json.bak after the second save", async () => {
    const store = await freshStore();
    store.saveSettings({});
    store.saveSettings({});

    expect(fs.existsSync(path.join(tmpDir, "settings.json.bak"))).toBe(true);
    expect(fs.statSync(path.join(tmpDir, "settings.json.bak")).size).toBeGreaterThan(0);
  });

  it("recovers from a 0-byte settings.json by falling back to .bak", async () => {
    const settingsPath = path.join(tmpDir, "settings.json");
    const bakPath = `${settingsPath}.bak`;

    // Simulate the post-crash state described in issue #17: settings.json was
    // truncated to 0 bytes by docker stop landing between O_TRUNC and write,
    // but the previous save's .bak still has good content on disk.
    const goodConfig = {
      cameras: [
        {
          id: "cam-1",
          name: "Front Door",
          host: "192.168.1.10",
          username: "admin",
          password: "secret",
        },
      ],
    };
    fs.writeFileSync(bakPath, JSON.stringify(goodConfig, null, 2));
    fs.writeFileSync(settingsPath, "");

    const store = await freshStore();
    const loaded = store.loadSettings();

    expect(loaded.cameras).toHaveLength(1);
    expect(loaded.cameras[0]?.id).toBe("cam-1");
    expect(loaded.cameras[0]?.name).toBe("Front Door");
  });

  it("falls back to defaults when both settings.json and .bak are unusable", async () => {
    fs.writeFileSync(path.join(tmpDir, "settings.json"), "");
    fs.writeFileSync(path.join(tmpDir, "settings.json.bak"), "");

    const store = await freshStore();
    const loaded = store.loadSettings();

    expect(loaded.cameras).toEqual([]);
  });

  it("never produces a 0-byte settings.json after saveSettings completes", async () => {
    const store = await freshStore();
    for (let i = 0; i < 5; i++) {
      store.saveSettings({});
      const size = fs.statSync(path.join(tmpDir, "settings.json")).size;
      expect(size).toBeGreaterThan(0);
    }
  });
});

describe("settings-store email-push auth bootstrap migration", () => {
  it("forces requireAuth=true and generates random credentials on legacy installs", async () => {
    // Simulate a legacy settings.json with the old defaults: auth disabled
    // and empty credentials, no migration marker recorded.
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({
        emailPush: {
          requireAuth: false,
          authUsername: "",
          authPassword: "",
        },
      }),
    );

    const store = await freshStore();
    const loaded = store.loadSettings();

    expect(loaded.emailPush.requireAuth).toBe(true);
    expect(loaded.emailPush.authUsername).toMatch(/^nodelink-[0-9a-f]{8}$/);
    expect(loaded.emailPush.authPassword.length).toBeGreaterThanOrEqual(20);
    expect(loaded._migrationsApplied).toContain("email-push-auth-defaults-v1");
  });

  it("does not re-run when the marker is already present", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({
        emailPush: {
          requireAuth: true,
          authUsername: "preserved-user",
          authPassword: "preserved-pass",
        },
        _migrationsApplied: ["email-push-auth-defaults-v1"],
      }),
    );

    const store = await freshStore();
    const loaded = store.loadSettings();

    expect(loaded.emailPush.authUsername).toBe("preserved-user");
    expect(loaded.emailPush.authPassword).toBe("preserved-pass");
  });

  it("respects user-set credentials even on first migration run", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({
        emailPush: {
          requireAuth: false,
          authUsername: "myuser",
          authPassword: "mypass",
        },
      }),
    );

    const store = await freshStore();
    const loaded = store.loadSettings();

    expect(loaded.emailPush.requireAuth).toBe(true);
    expect(loaded.emailPush.authUsername).toBe("myuser");
    expect(loaded.emailPush.authPassword).toBe("mypass");
    expect(loaded._migrationsApplied).toContain("email-push-auth-defaults-v1");
  });

  it("flips emailPush.enabled to true on installs that previously had it off", async () => {
    // Simulate an install where v1 already ran but enabled was explicitly off.
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({
        emailPush: {
          enabled: false,
          requireAuth: true,
          authUsername: "preserved-user",
          authPassword: "preserved-pass",
        },
        _migrationsApplied: ["email-push-auth-defaults-v1"],
      }),
    );

    const store = await freshStore();
    const loaded = store.loadSettings();

    expect(loaded.emailPush.enabled).toBe(true);
    expect(loaded.emailPush.authUsername).toBe("preserved-user");
    expect(loaded._migrationsApplied).toContain(
      "email-push-enabled-default-v1",
    );
    expect(loaded._migrationsApplied).toContain("email-push-auth-defaults-v1");
  });

  it("does not re-enable emailPush after the user manually disabled it post-migration", async () => {
    // Both migrations already recorded; user has since flipped enabled back
    // off. The migration runner must respect that decision.
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({
        emailPush: {
          enabled: false,
          requireAuth: true,
          authUsername: "u",
          authPassword: "p",
        },
        _migrationsApplied: [
          "email-push-auth-defaults-v1",
          "email-push-enabled-default-v1",
        ],
      }),
    );

    const store = await freshStore();
    const loaded = store.loadSettings();

    expect(loaded.emailPush.enabled).toBe(false);
  });
});
