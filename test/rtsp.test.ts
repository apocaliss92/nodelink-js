import { describe, expect, it } from "vitest";
import { buildRtspPath, buildRtspUrl } from "../src/rtsp/urls.js";

describe("rtsp urls", () => {
  it("buildRtspPath uses 1-based 2-digit channel", () => {
    expect(buildRtspPath(0, "main")).toBe("/h264Preview_01_main");
    expect(buildRtspPath(3, "sub")).toBe("/h264Preview_04_sub");
  });

  it("buildRtspUrl encodes credentials", () => {
    const url = buildRtspUrl({
      host: "192.168.1.10",
      port: 554,
      username: "admin",
      password: "p@ss word",
      channel: 0,
      stream: "sub",
    });
    expect(url).toContain("rtsp://admin:p%40ss%20word@192.168.1.10:554/h264Preview_01_sub");
  });
});

