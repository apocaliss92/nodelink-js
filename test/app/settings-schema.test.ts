import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-create the settings schemas inline to test validation without importing
// the full app (which has side-effects like loading settings files).

const Go2rtcSchema = z.object({
  enabled: z.boolean().default(true),
  binaryPath: z.string().default("go2rtc"),
  apiPort: z.number().int().min(1).max(65535).default(11984),
  rtspPort: z.number().int().min(1).max(65535).default(18554),
  webrtcPort: z.number().int().min(1).max(65535).default(18555),
  iceServers: z.array(z.string()).default([]),
});

const FrigateSchema = z.object({
  host: z.string().default(""),
  username: z.string().default(""),
  password: z.string().default(""),
  streamMode: z.enum(["nodelink", "frigate"]).default("nodelink"),
});

describe("Settings schema validation", () => {
  describe("go2rtc", () => {
    it("has correct defaults", () => {
      const result = Go2rtcSchema.parse({});
      expect(result.enabled).toBe(true);
      expect(result.apiPort).toBe(11984);
      expect(result.rtspPort).toBe(18554);
      expect(result.webrtcPort).toBe(18555);
      expect(result.binaryPath).toBe("go2rtc");
      expect(result.iceServers).toEqual([]);
    });

    it("validates port ranges", () => {
      expect(() => Go2rtcSchema.parse({ apiPort: 0 })).toThrow();
      expect(() => Go2rtcSchema.parse({ apiPort: 70000 })).toThrow();
      expect(() => Go2rtcSchema.parse({ apiPort: 1984 })).not.toThrow();
    });

    it("accepts custom config", () => {
      const result = Go2rtcSchema.parse({
        enabled: false,
        apiPort: 1984,
        rtspPort: 8554,
        webrtcPort: 8555,
        iceServers: ["stun:stun.l.google.com:19302"],
      });
      expect(result.enabled).toBe(false);
      expect(result.iceServers).toHaveLength(1);
    });

  });

  describe("frigate", () => {
    it("has correct defaults", () => {
      const result = FrigateSchema.parse({});
      expect(result.host).toBe("");
      expect(result.username).toBe("");
      expect(result.password).toBe("");
      expect(result.streamMode).toBe("nodelink");
    });

    it("validates streamMode enum", () => {
      expect(() =>
        FrigateSchema.parse({ streamMode: "invalid" as any }),
      ).toThrow();
      expect(() =>
        FrigateSchema.parse({ streamMode: "frigate" }),
      ).not.toThrow();
    });

    it("accepts full config", () => {
      const result = FrigateSchema.parse({
        host: "http://192.168.1.128:5000",
        username: "admin",
        password: "secret",
        streamMode: "frigate",
      });
      expect(result.host).toBe("http://192.168.1.128:5000");
      expect(result.streamMode).toBe("frigate");
    });
  });

  describe("rtsp proxy backend idle", () => {
    const RtspIdleSchema = z.object({
      rtspProxyBackendIdleTimeoutMs: z.number().int().min(0).default(0),
    });

    it("defaults to 0 (keep backends mounted when no proxy clients)", () => {
      const result = RtspIdleSchema.parse({});
      expect(result.rtspProxyBackendIdleTimeoutMs).toBe(0);
    });

    it("accepts positive idle ms", () => {
      const result = RtspIdleSchema.parse({
        rtspProxyBackendIdleTimeoutMs: 30_000,
      });
      expect(result.rtspProxyBackendIdleTimeoutMs).toBe(30_000);
    });

    it("rejects negative values", () => {
      expect(() =>
        RtspIdleSchema.parse({ rtspProxyBackendIdleTimeoutMs: -1 }),
      ).toThrow();
    });
  });
});
