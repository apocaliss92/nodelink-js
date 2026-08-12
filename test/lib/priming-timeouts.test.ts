import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIO_PRIMING_MS,
  DEFAULT_VIDEO_PRIMING_MS,
  MAX_PRIMING_MS,
  resolvePrimingMs,
} from "../../src/baichuan/stream/primingTimeouts";

describe("resolvePrimingMs", () => {
  it("falls back to the transport defaults when unconfigured", () => {
    expect(resolvePrimingMs(undefined, "tcp", DEFAULT_VIDEO_PRIMING_MS)).toBe(
      3000,
    );
    expect(resolvePrimingMs(undefined, "udp", DEFAULT_VIDEO_PRIMING_MS)).toBe(
      4000,
    );
    expect(resolvePrimingMs(undefined, "tcp", DEFAULT_AUDIO_PRIMING_MS)).toBe(
      2000,
    );
    expect(resolvePrimingMs(undefined, "udp", DEFAULT_AUDIO_PRIMING_MS)).toBe(
      3000,
    );
  });

  it("applies a scalar override to both transports", () => {
    expect(resolvePrimingMs(12_000, "tcp", DEFAULT_VIDEO_PRIMING_MS)).toBe(
      12_000,
    );
    expect(resolvePrimingMs(12_000, "udp", DEFAULT_VIDEO_PRIMING_MS)).toBe(
      12_000,
    );
  });

  it("applies per-transport overrides independently", () => {
    const opt = { tcp: 5000, udp: 20_000 };
    expect(resolvePrimingMs(opt, "tcp", DEFAULT_VIDEO_PRIMING_MS)).toBe(5000);
    expect(resolvePrimingMs(opt, "udp", DEFAULT_VIDEO_PRIMING_MS)).toBe(20_000);
  });

  it("falls back per-transport when only one side is overridden", () => {
    // Battery/UDP cameras are the ones that need a long window (#40); leaving
    // tcp unset must not change wired-camera behaviour.
    const opt = { udp: 20_000 };
    expect(resolvePrimingMs(opt, "tcp", DEFAULT_VIDEO_PRIMING_MS)).toBe(3000);
    expect(resolvePrimingMs(opt, "udp", DEFAULT_VIDEO_PRIMING_MS)).toBe(20_000);
  });

  it("honours an explicit 0 as 'do not wait' rather than treating it as unset", () => {
    expect(resolvePrimingMs(0, "tcp", DEFAULT_VIDEO_PRIMING_MS)).toBe(0);
    expect(resolvePrimingMs({ tcp: 0 }, "tcp", DEFAULT_VIDEO_PRIMING_MS)).toBe(
      0,
    );
  });

  it("clamps absurd values so a DESCRIBE can never hang indefinitely", () => {
    expect(
      resolvePrimingMs(999_999_999, "tcp", DEFAULT_VIDEO_PRIMING_MS),
    ).toBe(MAX_PRIMING_MS);
  });

  it("ignores invalid values and keeps the default", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(resolvePrimingMs(bad, "tcp", DEFAULT_VIDEO_PRIMING_MS)).toBe(3000);
    }
    expect(
      resolvePrimingMs({ tcp: -5 }, "tcp", DEFAULT_VIDEO_PRIMING_MS),
    ).toBe(3000);
  });
});
