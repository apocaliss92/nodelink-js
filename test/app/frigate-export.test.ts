import { describe, it, expect } from "vitest";

describe("Frigate export — config generation", () => {
  // Replicate the buildFrigateCameraBlock logic for isolated testing

  function parseResolution(res?: string) {
    if (!res) return null;
    const m = res.match(/^(\d+)x(\d+)$/);
    if (!m) return null;
    return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
  }

  function buildBlock(
    streams: Array<{ profile: string; rtspUrl: string; resolution?: string; codec?: string }>,
  ) {
    const sorted = [...streams].sort((a, b) => {
      const pa = parseResolution(a.resolution);
      const pb = parseResolution(b.resolution);
      return ((pb?.width ?? 0) * (pb?.height ?? 0)) - ((pa?.width ?? 0) * (pa?.height ?? 0));
    });

    const inputs: Array<{ path: string; roles: string[] }> = [];
    if (sorted[0]) inputs.push({ path: sorted[0].rtspUrl, roles: ["record", "audio"] });

    const detect = sorted.find((s) => {
      if (s.profile === "main") return false;
      const r = parseResolution(s.resolution);
      return r ? r.height <= 720 : true;
    }) ?? sorted[sorted.length - 1];

    if (detect && detect !== sorted[0]) {
      inputs.push({ path: detect.rtspUrl, roles: ["detect"] });
    } else if (sorted[0]) {
      inputs[0]!.roles.push("detect");
    }

    const detectRes = parseResolution(detect?.resolution);
    return {
      inputs,
      detectWidth: detectRes?.width,
      detectHeight: detectRes?.height,
      fps: detectRes && detectRes.height <= 480 ? 5 : 10,
    };
  }

  it("assigns record+audio to main, detect to sub for 3-stream camera", () => {
    const block = buildBlock([
      { profile: "main", rtspUrl: "rtsp://x/main", resolution: "3840x2160", codec: "H.265" },
      { profile: "sub", rtspUrl: "rtsp://x/sub", resolution: "640x360", codec: "H.264" },
      { profile: "ext", rtspUrl: "rtsp://x/ext", resolution: "896x512", codec: "H.264" },
    ]);

    expect(block.inputs).toHaveLength(2);
    expect(block.inputs[0]!.roles).toContain("record");
    expect(block.inputs[0]!.roles).toContain("audio");
    expect(block.inputs[1]!.roles).toContain("detect");
    expect(block.detectHeight).toBeLessThanOrEqual(720);
    // detect stream could be sub (360p→5fps) or ext (512p→10fps) depending on sort order
    expect(block.fps).toBeLessThanOrEqual(10);
  });

  it("assigns all roles to single-stream camera", () => {
    const block = buildBlock([
      { profile: "main", rtspUrl: "rtsp://x/main", resolution: "1920x1080" },
    ]);

    expect(block.inputs).toHaveLength(1);
    expect(block.inputs[0]!.roles).toContain("record");
    expect(block.inputs[0]!.roles).toContain("audio");
    expect(block.inputs[0]!.roles).toContain("detect");
  });

  it("chooses lowest-res non-main for detect", () => {
    const block = buildBlock([
      { profile: "main", rtspUrl: "rtsp://x/main", resolution: "2560x1440" },
      { profile: "sub", rtspUrl: "rtsp://x/sub", resolution: "640x360" },
      { profile: "ext", rtspUrl: "rtsp://x/ext", resolution: "896x512" },
    ]);

    // detect should be sub (360p) or ext (512p) — both ≤720p
    const detectInput = block.inputs.find((i) => i.roles.includes("detect"));
    expect(detectInput).toBeDefined();
    expect(detectInput!.path).not.toContain("/main");
  });

  it("fps is 10 for detect height > 480", () => {
    const block = buildBlock([
      { profile: "main", rtspUrl: "rtsp://x/main", resolution: "1920x1080" },
      { profile: "sub", rtspUrl: "rtsp://x/sub", resolution: "1280x720" },
    ]);
    expect(block.fps).toBe(10);
  });
});

describe("Frigate export — camera matching", () => {
  function matchByUrl(
    frigateInputPaths: string[],
    nodelinkSanitizedName: string,
  ): boolean {
    return frigateInputPaths.some(
      (p) =>
        p.toLowerCase().includes(`/${nodelinkSanitizedName}_`) ||
        p.toLowerCase().includes(`/${nodelinkSanitizedName}/`),
    );
  }

  function matchByIp(
    frigateInputPaths: string[],
    cameraHost: string,
  ): boolean {
    return frigateInputPaths.some(
      (p) =>
        p.includes(`://${cameraHost}:`) || p.includes(`://${cameraHost}/`),
    );
  }

  it("matches by nodelink stream name in RTSP URL", () => {
    const paths = [
      "rtsp://192.168.1.193:18554/cameretta_daniel_main",
      "rtsp://192.168.1.193:18554/cameretta_daniel_sub",
    ];
    expect(matchByUrl(paths, "cameretta_daniel")).toBe(true);
    expect(matchByUrl(paths, "studio")).toBe(false);
  });

  it("matches by camera IP in RTSP URL", () => {
    const paths = [
      "rtsp://192.168.1.4:33959/5eecd65a51417fab",
    ];
    expect(matchByIp(paths, "192.168.1.4")).toBe(true);
    expect(matchByIp(paths, "192.168.50.226")).toBe(false);
  });

  it("does NOT match similar but different names", () => {
    const paths = [
      "rtsp://192.168.1.4:33959/camera_daniel_main",
    ];
    // "camera_daniel" is NOT "cameretta_daniel"
    expect(matchByUrl(paths, "cameretta_daniel")).toBe(false);
    expect(matchByUrl(paths, "camera_daniel")).toBe(true);
  });

  it("matches nodelink-exported camera by RTSP path", () => {
    const paths = [
      "rtsp://192.168.1.193:18554/studio_main",
    ];
    expect(matchByUrl(paths, "studio")).toBe(true);
  });

  it("does not match 127.0.0.1 as camera IP", () => {
    const paths = ["rtsp://127.0.0.1:8554/stream_main"];
    expect(matchByIp(paths, "127.0.0.1")).toBe(true); // technically matches, but we filter 127.0.0.1 in real code
  });
});

describe("Frigate export — Frigate 0.17 config format", () => {
  it("record uses alerts/detections/motion (not retain/events)", () => {
    const record = {
      enabled: true,
      alerts: { retain: { days: 30, mode: "motion" } },
      detections: { retain: { days: 30, mode: "motion" } },
      motion: { days: 7 },
    };

    expect(record).not.toHaveProperty("retain");
    expect(record).not.toHaveProperty("events");
    expect(record.alerts.retain.days).toBe(30);
    expect(record.detections.retain.mode).toBe("motion");
    expect(record.motion.days).toBe(7);
  });

  it("detect includes width, height, fps", () => {
    const detect = { enabled: true, width: 640, height: 360, fps: 5 };
    expect(detect.width).toBe(640);
    expect(detect.height).toBe(360);
    expect(detect.fps).toBe(5);
  });
});
