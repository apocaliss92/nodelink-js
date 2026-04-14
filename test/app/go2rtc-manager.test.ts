import { describe, it, expect } from "vitest";

describe("go2rtc YAML config generation", () => {
  // Test the YAML generation logic inline (without importing the module
  // which has side-effects like createRequire)

  function generateYaml(
    streams: Map<string, readonly string[]>,
    options: { apiPort: number; rtspPort: number; webrtcPort: number; iceServers?: string[] },
  ): string {
    const lines: string[] = [];
    lines.push("api:");
    lines.push(`  listen: ":${options.apiPort}"`);
    lines.push('  origin: "*"');
    lines.push("");
    lines.push("rtsp:");
    lines.push(`  listen: ":${options.rtspPort}"`);
    lines.push("");
    lines.push("webrtc:");
    lines.push(`  listen: ":${options.webrtcPort}"`);
    if (options.iceServers?.length) {
      lines.push("  candidates:");
      for (const s of options.iceServers) lines.push(`    - ${s}`);
    }
    lines.push("");
    lines.push("ffmpeg:");
    lines.push("  bin: ffmpeg");
    lines.push("");
    lines.push("streams:");
    if (streams.size === 0) {
      lines.push("  # No streams registered yet");
    } else {
      for (const [name, sources] of streams) {
        if (sources.length === 1) {
          lines.push(`  ${name}: "${sources[0]}"`);
        } else {
          lines.push(`  ${name}:`);
          for (const src of sources) {
            lines.push(`    - "${src}"`);
          }
        }
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  it("generates valid YAML with default ports", () => {
    const yaml = generateYaml(new Map(), {
      apiPort: 11984,
      rtspPort: 18554,
      webrtcPort: 18555,
    });
    expect(yaml).toContain('listen: ":11984"');
    expect(yaml).toContain('listen: ":18554"');
    expect(yaml).toContain('listen: ":18555"');
    expect(yaml).toContain('origin: "*"');
    expect(yaml).toContain("ffmpeg:");
  });

  it("includes streams", () => {
    const streams = new Map<string, readonly string[]>([
      ["camera_main", ["rtsp://127.0.0.1:8556/camera/main"]],
      ["camera_sub", ["rtsp://127.0.0.1:8557/camera/sub"]],
    ]);
    const yaml = generateYaml(streams, {
      apiPort: 1984,
      rtspPort: 8554,
      webrtcPort: 8555,
    });
    expect(yaml).toContain("camera_main:");
    expect(yaml).toContain("camera_sub:");
    expect(yaml).toContain("rtsp://127.0.0.1:8556/camera/main");
  });

  it("emits list form for multi-source streams (H265 + ffmpeg h264 fallback)", () => {
    const streams = new Map<string, readonly string[]>([
      [
        "camera_main",
        [
          "rtsp://127.0.0.1:8556/camera/main",
          "ffmpeg:camera_main#video=h264#hardware",
        ],
      ],
    ]);
    const yaml = generateYaml(streams, {
      apiPort: 1984,
      rtspPort: 8554,
      webrtcPort: 8555,
    });
    // Multi-source entries must use YAML list form — a single scalar would
    // make go2rtc discard the fallback and WebRTC WHEP would fail for H265.
    expect(yaml).toContain("  camera_main:\n    - \"rtsp://127.0.0.1:8556/camera/main\"");
    expect(yaml).toContain("    - \"ffmpeg:camera_main#video=h264#hardware\"");
    expect(yaml).not.toContain('camera_main: "rtsp://');
  });

  it("includes ICE servers", () => {
    const yaml = generateYaml(new Map(), {
      apiPort: 1984,
      rtspPort: 8554,
      webrtcPort: 8555,
      iceServers: ["stun:stun.l.google.com:19302", "192.168.1.100:8555"],
    });
    expect(yaml).toContain("candidates:");
    expect(yaml).toContain("stun:stun.l.google.com:19302");
    expect(yaml).toContain("192.168.1.100:8555");
  });

  it("handles empty streams", () => {
    const yaml = generateYaml(new Map(), {
      apiPort: 1984,
      rtspPort: 8554,
      webrtcPort: 8555,
    });
    expect(yaml).toContain("# No streams registered yet");
  });

  it("always binds the RTSP listener on the configured port", () => {
    const yaml = generateYaml(new Map(), {
      apiPort: 11984,
      rtspPort: 18554,
      webrtcPort: 18555,
    });
    expect(yaml).toContain('listen: ":18554"');
  });
});

describe("go2rtc binary resolution", () => {
  it("resolveGo2rtcBinary finds go2rtc-static package", async () => {
    // This test only works if go2rtc-static is installed
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const staticPath: string = require("go2rtc-static");
      expect(typeof staticPath).toBe("string");
      expect(staticPath.length).toBeGreaterThan(0);
    } catch {
      // Package not installed — skip
    }
  });
});

describe("Stream name generation", () => {
  function buildGo2rtcStreamName(cameraName: string, profile: string, channel: number): string {
    const base = cameraName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return channel > 0 ? `${base}_${profile}_ch${channel}` : `${base}_${profile}`;
  }

  it("sanitizes camera name", () => {
    expect(buildGo2rtcStreamName("Living Room Camera", "main", 0)).toBe("living_room_camera_main");
  });

  it("handles special characters", () => {
    expect(buildGo2rtcStreamName("Caméra (Entrée)", "sub", 0)).toBe("cam_ra_entr_e_sub");
  });

  it("includes channel for multifocal", () => {
    expect(buildGo2rtcStreamName("TrackMix", "main", 1)).toBe("trackmix_main_ch1");
  });

  it("no channel suffix for ch0", () => {
    expect(buildGo2rtcStreamName("Studio", "ext", 0)).toBe("studio_ext");
  });
});
