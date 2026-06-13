import { describe, it, expect } from "vitest";
import { CameraConfigSchema } from "../../app/src/types.js";

const base = {
  id: "cam1",
  name: "Front Door",
  host: "192.168.1.50",
  username: "admin",
  password: "secret",
};

describe("CameraConfigSchema permanentStream", () => {
  it("parses without permanentStream (optional)", () => {
    const parsed = CameraConfigSchema.parse(base);
    expect(parsed.permanentStream).toBeUndefined();
  });

  it("accepts a full permanentStream config and round-trips values", () => {
    const parsed = CameraConfigSchema.parse({
      ...base,
      permanentStream: {
        enabled: true,
        windowSeconds: 30,
        idleFps: 2,
        placeholderText: "Asleep",
        placeholderOpacity: 0.3,
        placeholderEnabled: true,
      },
    });
    expect(parsed.permanentStream).toEqual({
      enabled: true,
      windowSeconds: 30,
      idleFps: 2,
      placeholderText: "Asleep",
      placeholderOpacity: 0.3,
      placeholderEnabled: true,
    });
  });

  it("defaults enabled to false when only an empty object is given", () => {
    const parsed = CameraConfigSchema.parse({
      ...base,
      permanentStream: {},
    });
    expect(parsed.permanentStream?.enabled).toBe(false);
  });

  it("rejects windowSeconds out of range", () => {
    expect(() =>
      CameraConfigSchema.parse({
        ...base,
        permanentStream: { enabled: true, windowSeconds: 9999 },
      }),
    ).toThrow();
  });

  it("rejects placeholderOpacity above 1", () => {
    expect(() =>
      CameraConfigSchema.parse({
        ...base,
        permanentStream: { enabled: true, placeholderOpacity: 2 },
      }),
    ).toThrow();
  });

  it("does not interfere with the unrelated batteryMode field", () => {
    const parsed = CameraConfigSchema.parse({
      ...base,
      batteryMode: "alwaysOn",
      permanentStream: { enabled: true },
    });
    expect(parsed.batteryMode).toBe("alwaysOn");
    expect(parsed.permanentStream?.enabled).toBe(true);
  });
});
