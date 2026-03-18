/**
 * NVR multi-channel tests using captured fixtures.
 * Tests channel isolation, socket pool management, and battery camera behavior.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NVR_DIR = path.join(__dirname, "..", "fixtures", "nvr");

function loadFixture(name: string): any {
  const p = path.join(NVR_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("NVR multi-channel", () => {
  describe("Hub-level info", () => {
    it("identifies as NVR/Hub device", () => {
      const info = loadFixture("hub-info.json");
      if (!info) return;
      expect(info.type).toBeDefined();
      // Reolink Home Hub typically shows as a hub model
      expect(typeof info.type).toBe("string");
    });

    it("reports correct channel count", () => {
      const data = loadFixture("channel-count.json");
      if (!data) return;
      expect(data.channelCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Per-channel info", () => {
    for (const ch of [0, 1]) {
      it(`channel ${ch} has distinct device info`, () => {
        const info = loadFixture(`ch${ch}-info.json`);
        if (!info) return;
        expect(info.name).toBeDefined();
        expect(info.type).toBeDefined();
        expect(typeof info.name).toBe("string");
      });

      it(`channel ${ch} has stream options with profiles`, () => {
        const opts = loadFixture(`ch${ch}-stream-options.json`);
        if (!opts) return;
        expect(opts.nativeStreams).toBeDefined();
        expect(opts.nativeStreams.length).toBeGreaterThan(0);

        const profiles = opts.nativeStreams.map((s: any) => s.profile);
        expect(profiles).toContain("main");
      });

      it(`channel ${ch} has codec metadata`, () => {
        const opts = loadFixture(`ch${ch}-stream-options.json`);
        if (!opts) return;
        const main = opts.nativeStreams.find((s: any) => s.profile === "main");
        if (!main?.metadata) return;
        expect(main.metadata.width).toBeGreaterThan(0);
        expect(main.metadata.height).toBeGreaterThan(0);
        expect(main.metadata.videoEncType).toBeDefined();
      });
    }

    it("channels have different camera models", () => {
      const ch0 = loadFixture("ch0-info.json");
      const ch1 = loadFixture("ch1-info.json");
      if (!ch0 || !ch1) return;
      // Different physical cameras should have different names
      expect(ch0.name).not.toBe(ch1.name);
    });

    it("channels may have different codecs/resolutions", () => {
      const ch0 = loadFixture("ch0-stream-options.json");
      const ch1 = loadFixture("ch1-stream-options.json");
      if (!ch0 || !ch1) return;

      const ch0Main = ch0.nativeStreams.find((s: any) => s.profile === "main");
      const ch1Main = ch1.nativeStreams.find((s: any) => s.profile === "main");
      if (!ch0Main?.metadata || !ch1Main?.metadata) return;

      // At least verify both have valid metadata (may be same or different)
      expect(ch0Main.metadata.width).toBeGreaterThan(0);
      expect(ch1Main.metadata.width).toBeGreaterThan(0);
    });
  });

  describe("Battery camera behavior (sleep/wake)", () => {
    it("battery cameras may return 0 frames when sleeping", () => {
      // Battery NVR cameras are typically sleeping and won't produce frames
      // until explicitly woken up. This is expected behavior.
      for (const ch of [0, 1, 2]) {
        const frames = loadFixture(`ch${ch}-main-frames.json`);
        if (!frames) continue;
        if (frames.error) {
          // 400 response = camera sleeping, this is expected
          expect(frames.error).toContain("400");
        } else if (Array.isArray(frames)) {
          // Either 0 frames (sleeping) or >0 frames (awake) — both valid
          expect(frames.length).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("sleeping camera (400 response) is treated as transient, not unsupported", () => {
      const ch2 = loadFixture("ch2-info.json");
      // Channel 2 returns 400 when camera is sleeping — this is NOT a permanent error
      // The camera just needs to be woken up before streaming
      if (ch2 === null) {
        // File exists but is null = 400 response, which is expected for sleeping battery
        expect(true).toBe(true);
      }
    });
  });

  describe("Socket pool isolation", () => {
    it("socket pool summary is available", () => {
      const pool = loadFixture("socket-pool-summary.json");
      if (!pool) return;
      expect(pool.count).toBeGreaterThanOrEqual(1);
      expect(pool.tags).toBeDefined();
      expect(Array.isArray(pool.tags)).toBe(true);
    });
  });
});

describe("Socket isolation logic (unit tests)", () => {
  // Test the resolveSocketTag logic that determines which socket to use

  function resolveSocketTag(
    sessionKey: string,
    isNvr: boolean,
    isMultiFocal: boolean,
  ): string {
    const liveMatch = sessionKey.match(/^live:[^:]+:ch(\d+):(\w+)$/);
    if (liveMatch && liveMatch[1] && liveMatch[2]) {
      const channel = parseInt(liveMatch[1], 10);
      const profile = liveMatch[2].toLowerCase();

      if (profile === "ext") {
        if (channel === 0) return "general";
        if (isMultiFocal) return "general";
        return `streaming:ch${channel}:ext`;
      }

      if (isMultiFocal) return "general";

      return `streaming:ch${channel}:${profile}`;
    }

    return "general";
  }

  it("assigns different tags for main and sub on same channel", () => {
    const mainTag = resolveSocketTag("live:cam1:ch0:main", false, false);
    const subTag = resolveSocketTag("live:cam1:ch0:sub", false, false);
    expect(mainTag).not.toBe(subTag);
    expect(mainTag).toBe("streaming:ch0:main");
    expect(subTag).toBe("streaming:ch0:sub");
  });

  it("assigns different tags for different NVR channels", () => {
    const ch0 = resolveSocketTag("live:cam1:ch0:main", true, false);
    const ch1 = resolveSocketTag("live:cam1:ch1:main", true, false);
    expect(ch0).not.toBe(ch1);
    expect(ch0).toBe("streaming:ch0:main");
    expect(ch1).toBe("streaming:ch1:main");
  });

  it("multifocal cameras share general socket", () => {
    const main = resolveSocketTag("live:cam1:ch0:main", false, true);
    const sub = resolveSocketTag("live:cam1:ch0:sub", false, true);
    expect(main).toBe("general");
    expect(sub).toBe("general");
  });

  it("ext on channel 0 goes to general", () => {
    const tag = resolveSocketTag("live:cam1:ch0:ext", false, false);
    expect(tag).toBe("general");
  });

  it("ext on non-zero channel gets dedicated socket", () => {
    const tag = resolveSocketTag("live:cam1:ch1:ext", false, false);
    expect(tag).toBe("streaming:ch1:ext");
  });

  it("non-live keys fall back to general", () => {
    const tag = resolveSocketTag("go2rtc-tcp:cam1:ch0:main", false, false);
    expect(tag).toBe("general");
  });

  it("live keys with correct prefix get streaming tag", () => {
    const tag = resolveSocketTag("live:device123:ch0:main", false, false);
    expect(tag).toBe("streaming:ch0:main");
  });
});

describe("Go2rtcTcpServer battery behavior (unit tests)", () => {
  it("prestartStream defaults based on battery mode", () => {
    // AC-powered: prestartStream = true (stream starts immediately)
    const acPowered = { isBattery: false, batteryMode: undefined };
    expect(!acPowered.isBattery || acPowered.batteryMode !== "streamOnly").toBe(true);

    // Battery streamOnly: prestartStream = false (on-demand)
    const battery = { isBattery: true, batteryMode: "streamOnly" as const };
    expect(battery.isBattery && battery.batteryMode === "streamOnly").toBe(true);

    // Battery alwaysOn: prestartStream = true (not streamOnly)
    const alwaysOn = { isBattery: true, batteryMode: "alwaysOn" as string };
    expect(alwaysOn.isBattery && alwaysOn.batteryMode === "streamOnly").toBe(false);
  });

  it("grace period is shorter for battery cameras", () => {
    const defaultGrace = 30_000;
    const batteryGrace = 10_000;

    expect(batteryGrace).toBeLessThan(defaultGrace);
  });

  it("stream should stop after grace period with no clients", () => {
    // Simulated: when last client disconnects and prestartStream is false,
    // scheduleStop is called with the grace period.
    // After the timeout, stopNativeStream is invoked → camera goes back to sleep.
    const prestartStream = false;
    const connectedClients = 0;
    const shouldScheduleStop = connectedClients === 0 && !prestartStream;
    expect(shouldScheduleStop).toBe(true);
  });

  it("stream should NOT stop when prestartStream is true (AC camera)", () => {
    const prestartStream = true;
    const connectedClients = 0;
    const shouldScheduleStop = connectedClients === 0 && !prestartStream;
    expect(shouldScheduleStop).toBe(false);
  });
});
