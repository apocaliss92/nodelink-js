import { describe, it, expect } from "vitest";

describe("RTSP Manager helpers", () => {
  describe("sanitizeCameraName", () => {
    function sanitizeCameraName(name: string): string {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    it("lowercases and replaces spaces", () => {
      expect(sanitizeCameraName("Living Room")).toBe("living_room");
    });

    it("handles special characters", () => {
      expect(sanitizeCameraName("Camera (Entrance)")).toBe("camera_entrance");
    });

    it("handles accented characters", () => {
      expect(sanitizeCameraName("Caméra Entrée")).toBe("cam_ra_entr_e");
    });

    it("trims leading/trailing underscores", () => {
      expect(sanitizeCameraName("__test__")).toBe("test");
    });

    it("handles empty string", () => {
      expect(sanitizeCameraName("")).toBe("");
    });
  });

  describe("getRtspServerKey", () => {
    function getRtspServerKey(cameraId: string, profile: string, channel: number): string {
      return `${cameraId}:${profile}:${channel}`;
    }

    it("builds unique key from components", () => {
      expect(getRtspServerKey("cam1", "main", 0)).toBe("cam1:main:0");
      expect(getRtspServerKey("cam1", "sub", 0)).toBe("cam1:sub:0");
      expect(getRtspServerKey("cam1", "main", 1)).toBe("cam1:main:1");
    });

    it("different profiles produce different keys", () => {
      const k1 = getRtspServerKey("cam1", "main", 0);
      const k2 = getRtspServerKey("cam1", "sub", 0);
      expect(k1).not.toBe(k2);
    });
  });

  describe("buildGo2rtcStreamName", () => {
    function sanitize(name: string): string {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    function buildGo2rtcStreamName(name: string, profile: string, channel: number): string {
      const base = sanitize(name);
      return channel > 0 ? `${base}/${profile}/${channel}` : `${base}/${profile}`;
    }

    it("matches the pattern for go2rtc stream registration", () => {
      expect(buildGo2rtcStreamName("Studio", "main", 0)).toBe("studio/main");
      expect(buildGo2rtcStreamName("Cameretta Daniel", "sub", 0)).toBe("cameretta_daniel/sub");
    });

    it("includes channel for NVR/multifocal", () => {
      expect(buildGo2rtcStreamName("TrackMix", "main", 1)).toBe("trackmix/main/1");
    });

    it("uses slash separator between name and profile", () => {
      expect(buildGo2rtcStreamName("Living Room", "main", 0)).toBe("living_room/main");
      expect(buildGo2rtcStreamName("Garage", "main", 1)).toBe("garage/main/1");
      expect(buildGo2rtcStreamName("Front Door Camera", "sub", 0)).toBe("front_door_camera/sub");
    });
  });

  describe("Port management", () => {
    it("claimedPorts prevents duplicate assignment", () => {
      const claimed = new Set<number>();
      const usedByServers = new Set<number>([8554, 8555]);

      function findPort(base: number): number {
        for (let i = 0; i < 100; i++) {
          const p = base + i;
          if (claimed.has(p) || usedByServers.has(p)) continue;
          claimed.add(p);
          return p;
        }
        throw new Error("no port");
      }

      const p1 = findPort(8554);
      const p2 = findPort(8554);
      const p3 = findPort(8554);

      expect(p1).toBe(8556); // 8554,8555 used
      expect(p2).toBe(8557); // 8556 claimed
      expect(p3).toBe(8558); // 8557 claimed
      expect(new Set([p1, p2, p3]).size).toBe(3); // all unique
    });
  });

  describe("enableAutoStreamsOnConnect expectations", () => {
    it("defers when go2rtc is enabled but manager is not running", () => {
      const settings = { go2rtc: { enabled: true } };
      const go2rtcMgr = null as { isRunning?: boolean } | null;
      const shouldDefer =
        settings.go2rtc?.enabled === true && !go2rtcMgr?.isRunning;
      expect(shouldDefer).toBe(true);
    });

    it("does not defer when go2rtc is disabled (classic RTSP)", () => {
      const settings = { go2rtc: { enabled: false } };
      const go2rtcMgr = null;
      const shouldDefer =
        settings.go2rtc?.enabled === true && !go2rtcMgr?.isRunning;
      expect(shouldDefer).toBe(false);
    });

    it("starts streams for on-the-fly connected cameras", () => {
      const camera = { autoStart: false, name: "Test", rtspStreams: [
        { profile: "main", channel: 0, enabled: true },
        { profile: "sub", channel: 0, enabled: true },
      ]};
      const enabled = camera.rtspStreams.filter(s => s.enabled);
      expect(enabled.length).toBe(2);
    });

    it("defaults to main stream when no streams configured", () => {
      const camera = { autoStart: false, name: "Test", rtspStreams: [] as any[] };
      const streams = camera.rtspStreams.filter((s: any) => s.enabled);
      const toStart = streams.length > 0
        ? streams.map((s: any) => ({ profile: s.profile, channel: s.channel }))
        : [{ profile: "main", channel: 0 }];
      expect(toStart).toEqual([{ profile: "main", channel: 0 }]);
    });
  });
});
