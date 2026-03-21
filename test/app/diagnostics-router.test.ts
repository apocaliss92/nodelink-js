import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * Tests for the diagnostics tRPC router input validation schemas.
 * We inline the schemas here (same pattern as other router tests in this repo)
 * to avoid importing the router which has heavy side-effect dependencies.
 */

describe("diagnostics router input schemas", () => {
  describe("start input", () => {
    const startSchema = z.object({
      cameraId: z.string(),
      profile: z.enum(["main", "sub", "ext"]),
      channel: z.number().int().min(0).default(0),
      durationMinutes: z.number().int().min(1).max(60).default(5),
    });

    it("accepts valid input with all fields", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "main",
        channel: 2,
        durationMinutes: 10,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cameraId).toBe("cam1");
        expect(result.data.profile).toBe("main");
        expect(result.data.channel).toBe(2);
        expect(result.data.durationMinutes).toBe(10);
      }
    });

    it("applies default channel=0 and durationMinutes=5", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "sub",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.channel).toBe(0);
        expect(result.data.durationMinutes).toBe(5);
      }
    });

    it("rejects invalid profile", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "ultra",
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative channel", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "main",
        channel: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects durationMinutes below 1", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "main",
        durationMinutes: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects durationMinutes above 60", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "main",
        durationMinutes: 61,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer channel", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "main",
        channel: 1.5,
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing cameraId", () => {
      const result = startSchema.safeParse({
        profile: "main",
      });
      expect(result.success).toBe(false);
    });

    it("accepts ext profile", () => {
      const result = startSchema.safeParse({
        cameraId: "cam1",
        profile: "ext",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("stop input", () => {
    const stopSchema = z.object({ sessionId: z.string() });

    it("accepts valid sessionId", () => {
      const result = stopSchema.safeParse({ sessionId: "cam1:main:0" });
      expect(result.success).toBe(true);
    });

    it("rejects missing sessionId", () => {
      const result = stopSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("status input", () => {
    const statusSchema = z.object({ sessionId: z.string() });

    it("accepts valid sessionId", () => {
      const result = statusSchema.safeParse({ sessionId: "cam1:sub:0" });
      expect(result.success).toBe(true);
    });
  });

  describe("list input", () => {
    const listSchema = z.object({ cameraId: z.string().optional() });

    it("accepts empty object (no filter)", () => {
      const result = listSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cameraId).toBeUndefined();
      }
    });

    it("accepts cameraId filter", () => {
      const result = listSchema.safeParse({ cameraId: "cam1" });
      expect(result.success).toBe(true);
    });
  });

  describe("download input", () => {
    const downloadSchema = z.object({ reportId: z.string() });

    it("accepts valid reportId", () => {
      const result = downloadSchema.safeParse({
        reportId: "cam1_main_ch0_2026-03-21",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing reportId", () => {
      const result = downloadSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("delete input", () => {
    const deleteSchema = z.object({ reportId: z.string() });

    it("accepts valid reportId", () => {
      const result = deleteSchema.safeParse({ reportId: "some-report" });
      expect(result.success).toBe(true);
    });

    it("rejects missing reportId", () => {
      const result = deleteSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
