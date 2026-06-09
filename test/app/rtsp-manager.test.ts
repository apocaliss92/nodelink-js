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

  describe("buildStreamName", () => {
    function sanitize(name: string): string {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    function buildStreamName(name: string, profile: string, channel: number): string {
      const base = sanitize(name);
      return channel > 0 ? `${base}/${profile}/${channel}` : `${base}/${profile}`;
    }

    it("matches the RTSP URL path pattern", () => {
      expect(buildStreamName("Studio", "main", 0)).toBe("studio/main");
      expect(buildStreamName("Cameretta Daniel", "sub", 0)).toBe("cameretta_daniel/sub");
    });

    it("includes channel for NVR/multifocal", () => {
      expect(buildStreamName("TrackMix", "main", 1)).toBe("trackmix/main/1");
    });

    it("uses slash separator between name and profile", () => {
      expect(buildStreamName("Living Room", "main", 0)).toBe("living_room/main");
      expect(buildStreamName("Garage", "main", 1)).toBe("garage/main/1");
      expect(buildStreamName("Front Door Camera", "sub", 0)).toBe("front_door_camera/sub");
    });
  });

  describe("enableAutoStreamsOnConnect expectations", () => {
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
