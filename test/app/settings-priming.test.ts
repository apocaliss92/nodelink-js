import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../../app/src/settings-store";

/**
 * These assert the *real* exported schema (not an inline copy), so a default
 * drifting in `settings-store.ts` fails here rather than silently shipping.
 */
describe("localRtsp.priming settings (issue #40)", () => {
  it("fills the DESCRIBE priming defaults for an existing config that predates the setting", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.localRtsp.priming).toEqual({
      videoTcpMs: 3000,
      videoUdpMs: 4000,
      audioTcpMs: 2000,
      audioUdpMs: 3000,
    });
  });

  it("keeps unrelated localRtsp values when only priming is supplied", () => {
    const parsed = SettingsSchema.parse({
      localRtsp: { port: 9554, priming: { videoUdpMs: 20_000 } },
    });
    expect(parsed.localRtsp.port).toBe(9554);
    expect(parsed.localRtsp.priming.videoUdpMs).toBe(20_000);
    // Untouched keys still fall back to their defaults.
    expect(parsed.localRtsp.priming.videoTcpMs).toBe(3000);
  });

  it("accepts 0 (answer the DESCRIBE immediately)", () => {
    const parsed = SettingsSchema.parse({
      localRtsp: { priming: { videoTcpMs: 0 } },
    });
    expect(parsed.localRtsp.priming.videoTcpMs).toBe(0);
  });

  it("rejects negative, fractional and out-of-range windows", () => {
    for (const videoTcpMs of [-1, 1.5, 60_001]) {
      expect(() =>
        SettingsSchema.parse({ localRtsp: { priming: { videoTcpMs } } }),
      ).toThrow();
    }
  });
});
