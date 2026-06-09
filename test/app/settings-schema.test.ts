import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-create the settings schemas inline to test validation without importing
// the full app (which has side-effects like loading settings files).

const FrigateSchema = z.object({
  host: z.string().default(""),
  username: z.string().default(""),
  password: z.string().default(""),
  streamMode: z.enum(["nodelink", "frigate"]).default("nodelink"),
});

const LocalRtspSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8554),
  bindHost: z.string().default("0.0.0.0"),
  requireAuth: z.boolean().optional(),
});

describe("Settings schema validation", () => {
  describe("localRtsp", () => {
    it("has correct defaults", () => {
      const result = LocalRtspSchema.parse({});
      expect(result.port).toBe(8554);
      expect(result.bindHost).toBe("0.0.0.0");
    });

    it("validates port ranges", () => {
      expect(() => LocalRtspSchema.parse({ port: 0 })).toThrow();
      expect(() => LocalRtspSchema.parse({ port: 70000 })).toThrow();
      expect(() => LocalRtspSchema.parse({ port: 8554 })).not.toThrow();
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
