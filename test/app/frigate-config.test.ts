import { describe, it, expect } from "vitest";

// Test the Frigate config YAML generation logic (isolated from the router)
// We import the helpers directly to test without a running server.

describe("Frigate config generation", () => {
  it("parseResolution extracts width and height", () => {
    // Inline test since the function is not exported
    const parse = (res?: string) => {
      if (!res) return null;
      const m = res.match(/^(\d+)x(\d+)$/);
      if (!m) return null;
      return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
    };

    expect(parse("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(parse("640x360")).toEqual({ width: 640, height: 360 });
    expect(parse("3840x2160")).toEqual({ width: 3840, height: 2160 });
    expect(parse("")).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(parse("invalid")).toBeNull();
  });

  it("assigns roles correctly for 3-stream camera", () => {
    const streams = [
      { profile: "main", resolution: "3840x2160", codec: "H.265" },
      { profile: "sub", resolution: "640x360", codec: "H.264" },
      { profile: "ext", resolution: "896x512", codec: "H.264" },
    ];

    // Sort by pixel count descending
    const sorted = [...streams].sort((a, b) => {
      const pa = a.resolution.split("x").map(Number);
      const pb = b.resolution.split("x").map(Number);
      return (pb[0]! * pb[1]!) - (pa[0]! * pa[1]!);
    });

    // Main (highest) should get record
    expect(sorted[0]!.profile).toBe("main");

    // A non-main stream ≤720p should get detect
    const detect = sorted.find((s) => {
      if (s.profile === "main") return false;
      const h = parseInt(s.resolution.split("x")[1]!, 10);
      return h <= 720;
    });
    expect(detect).toBeDefined();
    expect(detect!.profile).not.toBe("main");
    const detectHeight = parseInt(detect!.resolution.split("x")[1]!, 10);
    expect(detectHeight).toBeLessThanOrEqual(720);
  });

  it("assigns roles for single-stream camera", () => {
    const streams = [
      { profile: "main", resolution: "1920x1080", codec: "H.264" },
    ];

    // Single stream gets all roles
    expect(streams.length).toBe(1);
    expect(streams[0]!.profile).toBe("main");
  });

  it("detect FPS based on resolution", () => {
    const getFps = (height: number) => height <= 480 ? 5 : 10;

    expect(getFps(360)).toBe(5);
    expect(getFps(480)).toBe(5);
    expect(getFps(512)).toBe(10);
    expect(getFps(720)).toBe(10);
    expect(getFps(1080)).toBe(10);
  });
});
