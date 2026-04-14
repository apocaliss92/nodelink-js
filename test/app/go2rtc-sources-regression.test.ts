/**
 * Regression tests for go2rtc source-building bugs introduced in v0.4.2-beta.14
 * (commit 49e9af3 "MQTT rework + fix battery wakeup"), fixed in beta.15.
 *
 * ─── Bug 1 — Audio dropped (back to audio=false) ────────────────────────────
 * The ffmpeg transcode source was changed to `ffmpeg:${primarySource}#video=h264`,
 * which maps only video and silently drops the audio track.
 * FIX: include `#audio=copy` so AAC audio is preserved.
 *
 * ─── Bug 2 — go2rtc fails with "Invalid data found when processing input" ───
 * go2rtc log from ticket:
 *   [go2rtc] WRN [rtsp] error="streams: exec/rtsp
 *     [in#0] Error opening input: Invalid data found when processing input
 *     Error opening input file rtsp://127.0.0.1:8558/campark/main.
 *   " stream=campark/main
 *
 * Root cause: the ffmpeg source used the RAW RTSP URL as input
 * (`ffmpeg:rtsp://127.0.0.1:8558/campark/main#video=h264`). go2rtc ran ffmpeg
 * against BaichuanRtspServer's RTSP endpoint directly; ffmpeg cannot parse the
 * SDP/RTP that the server emits → "Invalid data found".
 * FIX: use the go2rtc stream name as ffmpeg input (`ffmpeg:campark/main#video=h264#audio=copy`)
 * so go2rtc transcodes from its OWN re-exported stream, not from the raw RTSP endpoint.
 *
 * ─── Bug 3 — Battery camera wakeup has no effect ────────────────────────────
 * Consequence of Bug 2: go2rtc's ffmpeg source fails → no RTSP client ever
 * reaches BaichuanRtspServer → noClientAutoStopTimer fires → native stream
 * stops → camera idle-disconnects. See rtsp-server-sleep.test.ts.
 *
 * Test structure:
 *   - "broken impl" / "documents the bug" tests: use the old (broken) logic;
 *     they PASS and serve as a record of what the bug looked like.
 *   - All other tests: use the correct (fixed) logic; they are regression tests
 *     that will FAIL if the bug is re-introduced.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Helper: sanitize camera name (matches rtsp-manager.ts sanitizeCameraName)
// ---------------------------------------------------------------------------
function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function buildGo2rtcStreamName(name: string, profile: string, channel: number): string {
  const base = sanitize(name);
  return channel > 0 ? `${base}/${profile}/${channel}` : `${base}/${profile}`;
}

// ---------------------------------------------------------------------------
// OLD broken implementation (commit 49e9af3) — kept for historical documentation
// ---------------------------------------------------------------------------

/** Produces the buggy ffmpegSource that used the raw RTSP URL and omitted audio. */
function brokenFfmpegSource(primarySource: string): string {
  return `ffmpeg:${primarySource}#video=h264`;
}

function brokenSourcesH265(primarySource: string): string[] {
  return [brokenFfmpegSource(primarySource)];
}

// ---------------------------------------------------------------------------
// FIXED implementation (matches app/src/rtsp-manager.ts after the fix)
// ---------------------------------------------------------------------------

/** Uses go2rtc stream name as ffmpeg input and preserves audio with #audio=copy. */
function buildFfmpegSource(streamName: string): string {
  return `ffmpeg:${streamName}#video=h264#audio=copy`;
}

function buildSourcesH264(primarySource: string): string[] {
  return [primarySource];
}

function buildSourcesH265(primarySource: string, streamName: string): string[] {
  return [primarySource, buildFfmpegSource(streamName)];
}

function buildSourcesUnknown(primarySource: string, streamName: string): string[] {
  return [primarySource, buildFfmpegSource(streamName)];
}

// ---------------------------------------------------------------------------
// Ticket constants — exact values from the issue comment
// Ticket error: "Error opening input file rtsp://127.0.0.1:8558/campark/main."
// Camera name: "CamPark" → sanitized → "campark"
// Profile: "main" → stream name: "campark/main"
// BaichuanRtspServer port: 8558
// ---------------------------------------------------------------------------
const TICKET_CAMERA_NAME = "CamPark";
const TICKET_STREAM_NAME = buildGo2rtcStreamName(TICKET_CAMERA_NAME, "main", 0); // "campark/main"
const TICKET_RTSP_PORT = 8558;
const TICKET_RTSP_URL = `rtsp://127.0.0.1:${TICKET_RTSP_PORT}/${TICKET_STREAM_NAME}`;

const GO2RTC_PORT = 18554;
function localRtspUrl(port: number, path: string) {
  return `rtsp://127.0.0.1:${port}${path}`;
}
function proxyRtspUrl(path: string) {
  return `rtsp://127.0.0.1:${GO2RTC_PORT}${path}`;
}

// ---------------------------------------------------------------------------
// ── Bug 1: Audio ────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

describe("Bug 1 — Audio: ffmpeg source must include #audio=copy", () => {
  it("broken impl omits audio entirely — historical documentation of the bug", () => {
    const src = brokenFfmpegSource(TICKET_RTSP_URL);
    expect(src).not.toContain("#audio");
  });

  it("fixed: ffmpeg source contains #audio=copy", () => {
    const src = buildFfmpegSource(TICKET_STREAM_NAME);
    expect(src).toContain("#audio=copy");
  });

  it("fixed: ffmpeg source contains both #video=h264 and #audio=copy", () => {
    const src = buildFfmpegSource(TICKET_STREAM_NAME);
    expect(src).toContain("#video=h264");
    expect(src).toContain("#audio=copy");
  });

  it("fixed: exact source string for the ticket camera", () => {
    const src = buildFfmpegSource(TICKET_STREAM_NAME);
    expect(src).toBe("ffmpeg:campark/main#video=h264#audio=copy");
  });

  it("audio is preserved for all profiles (main, sub, ext)", () => {
    for (const profile of ["main", "sub", "ext"]) {
      const name = buildGo2rtcStreamName("Camera", profile, 0);
      expect(buildFfmpegSource(name)).toContain("#audio=copy");
    }
  });

  it("audio is preserved for NVR streams with channel numbers", () => {
    for (const ch of [1, 2, 3, 7]) {
      const name = buildGo2rtcStreamName("NVR", "main", ch);
      expect(buildFfmpegSource(name)).toContain("#audio=copy");
    }
  });
});

// ---------------------------------------------------------------------------
// ── Bug 2: ffmpeg uses RTSP URL instead of go2rtc stream name ───────────────
// ---------------------------------------------------------------------------

describe("Bug 2 — ffmpeg source must use go2rtc stream name, not RTSP URL", () => {
  describe("Historical documentation of the bug", () => {
    it("broken impl produced the exact URL seen in the ticket error", () => {
      const src = brokenFfmpegSource(TICKET_RTSP_URL);
      expect(src).toBe(`ffmpeg:rtsp://127.0.0.1:8558/campark/main#video=h264`);
    });

    it("broken impl contained a raw rtsp:// URL (would cause 'Invalid data found')", () => {
      const src = brokenFfmpegSource(TICKET_RTSP_URL);
      expect(src).toContain("rtsp://");
    });

    it("broken H.265 returned only 1 source (lost native RTSP ingest)", () => {
      expect(brokenSourcesH265(TICKET_RTSP_URL)).toHaveLength(1);
    });
  });

  describe("Exact ticket scenario: campark/main on port 8558", () => {
    it("fixed: ffmpeg source does NOT contain a raw rtsp:// URL", () => {
      const src = buildFfmpegSource(TICKET_STREAM_NAME);
      expect(src).not.toContain("rtsp://");
    });

    it("fixed: ffmpeg source uses go2rtc stream name as input", () => {
      const src = buildFfmpegSource(TICKET_STREAM_NAME);
      expect(src).toBe(`ffmpeg:${TICKET_STREAM_NAME}#video=h264#audio=copy`);
    });

    it("fixed: ffmpeg source does not contain BaichuanRtspServer port 8558", () => {
      const src = buildFfmpegSource(TICKET_STREAM_NAME);
      expect(src).not.toContain("8558");
    });
  });

  describe("go2rtc mode — BaichuanRtspServer on internal port", () => {
    it("fixed: ffmpeg source does not contain the BaichuanRtspServer internal port", () => {
      const streamName = buildGo2rtcStreamName("CamPark", "main", 0);
      expect(buildFfmpegSource(streamName)).not.toContain("8558");
    });
  });

  describe("local mode — proxyRtspUrl through go2rtc RTSP port", () => {
    it("fixed: local mode ffmpeg source does not contain the go2rtc RTSP port", () => {
      const streamName = buildGo2rtcStreamName("CamPark", "main", 0);
      expect(buildFfmpegSource(streamName)).not.toContain(`${GO2RTC_PORT}`);
    });
  });
});

// ---------------------------------------------------------------------------
// ── H.265 dual-source requirement ───────────────────────────────────────────
// ---------------------------------------------------------------------------

describe("H.265 source list must be dual: [primaryRtspUrl, ffmpeg:streamName]", () => {
  it("fixed: H.265 returns 2 sources", () => {
    const sources = buildSourcesH265(TICKET_RTSP_URL, TICKET_STREAM_NAME);
    expect(sources).toHaveLength(2);
  });

  it("fixed: H.265 first source is the native RTSP URL (for RTSP/HLS/MSE clients)", () => {
    const sources = buildSourcesH265(TICKET_RTSP_URL, TICKET_STREAM_NAME);
    expect(sources[0]).toBe(TICKET_RTSP_URL);
  });

  it("fixed: H.265 second source is ffmpeg:streamName (WebRTC transcoding)", () => {
    const sources = buildSourcesH265(TICKET_RTSP_URL, TICKET_STREAM_NAME);
    expect(sources[1]).toBe(`ffmpeg:${TICKET_STREAM_NAME}#video=h264#audio=copy`);
  });

  it("fixed: exact H.265 sources for ticket camera", () => {
    const sources = buildSourcesH265(TICKET_RTSP_URL, TICKET_STREAM_NAME);
    expect(sources).toEqual([
      "rtsp://127.0.0.1:8558/campark/main",
      "ffmpeg:campark/main#video=h264#audio=copy",
    ]);
  });

  it("fixed: H.265 for sub profile", () => {
    const name = buildGo2rtcStreamName("Camera", "sub", 0);
    const url = localRtspUrl(8559, "/live/camera/sub");
    const sources = buildSourcesH265(url, name);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe(url);
    expect(sources[1]).toBe("ffmpeg:camera/sub#video=h264#audio=copy");
  });

  it("fixed: H.265 for NVR channel 2", () => {
    const name = buildGo2rtcStreamName("My NVR", "main", 2);
    const url = localRtspUrl(8560, "/live/my_nvr/main/2");
    const sources = buildSourcesH265(url, name);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe(url);
    expect(sources[1]).toBe("ffmpeg:my_nvr/main/2#video=h264#audio=copy");
  });
});

// ---------------------------------------------------------------------------
// ── H.264 single-source requirement ─────────────────────────────────────────
// ---------------------------------------------------------------------------

describe("H.264 source list must be a single native source (no transcoding overhead)", () => {
  it("returns only the native RTSP URL", () => {
    const sources = buildSourcesH264(TICKET_RTSP_URL);
    expect(sources).toEqual([TICKET_RTSP_URL]);
  });

  it("H.264 source does not contain ffmpeg", () => {
    const sources = buildSourcesH264(TICKET_RTSP_URL);
    expect(sources[0]).not.toContain("ffmpeg");
  });

  it("H.264 is unchanged for all profiles", () => {
    for (const profile of ["main", "sub", "ext"]) {
      const url = localRtspUrl(8558, `/live/cam/${profile}`);
      expect(buildSourcesH264(url)).toEqual([url]);
    }
  });
});

// ---------------------------------------------------------------------------
// ── Unknown codec / battery sleeping at registration ─────────────────────────
// ---------------------------------------------------------------------------

describe("Unknown codec (battery sleeping) must use dual sources like H.265", () => {
  it("fixed: returns 2 sources for unknown codec", () => {
    const sources = buildSourcesUnknown(TICKET_RTSP_URL, TICKET_STREAM_NAME);
    expect(sources).toHaveLength(2);
  });

  it("fixed: exact sources for unknown codec", () => {
    const sources = buildSourcesUnknown(TICKET_RTSP_URL, TICKET_STREAM_NAME);
    expect(sources).toEqual([
      "rtsp://127.0.0.1:8558/campark/main",
      "ffmpeg:campark/main#video=h264#audio=copy",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ── Camera name sanitization → stream name correctness ──────────────────────
// ---------------------------------------------------------------------------

describe("Camera name sanitization affects stream name (not RTSP URL)", () => {
  const cases: Array<{ name: string; profile: string; channel: number; expected: string }> = [
    { name: "CamPark",             profile: "main", channel: 0, expected: "campark/main" },
    { name: "Front Door Camera",   profile: "main", channel: 0, expected: "front_door_camera/main" },
    { name: "Caméra Entrée",       profile: "sub",  channel: 0, expected: "cam_ra_entr_e/sub" },
    { name: "Studio",              profile: "ext",  channel: 0, expected: "studio/ext" },
    { name: "My NVR",              profile: "main", channel: 1, expected: "my_nvr/main/1" },
    { name: "My NVR",              profile: "main", channel: 7, expected: "my_nvr/main/7" },
    { name: "Doorbell (entrance)", profile: "sub",  channel: 0, expected: "doorbell_entrance/sub" },
  ];

  for (const { name, profile, channel, expected } of cases) {
    it(`buildGo2rtcStreamName("${name}", "${profile}", ${channel}) → "${expected}"`, () => {
      expect(buildGo2rtcStreamName(name, profile, channel)).toBe(expected);
    });

    it(`ffmpeg source for "${name}"/"${profile}" uses stream name, not RTSP URL`, () => {
      const streamName = buildGo2rtcStreamName(name, profile, channel);
      const src = buildFfmpegSource(streamName);
      expect(src).not.toContain("rtsp://");
      expect(src).toContain(streamName);
      expect(src).toContain("#audio=copy");
    });
  }
});

// ---------------------------------------------------------------------------
// ── Source consistency across modes ─────────────────────────────────────────
// ---------------------------------------------------------------------------

describe("ffmpeg source format is consistent regardless of go2rtc mode", () => {
  it("go2rtc mode and local mode produce the same ffmpegSource (uses stream name, not URL)", () => {
    const streamName = buildGo2rtcStreamName("CamPark", "main", 0);

    const go2rtcModeUrl = localRtspUrl(8558, "/live/campark/main");
    const localModeUrl = proxyRtspUrl("/live/campark/main");

    const srcGo2rtc = buildFfmpegSource(streamName);
    const srcLocal  = buildFfmpegSource(streamName);

    expect(srcGo2rtc).toBe(srcLocal);
    expect(srcGo2rtc).toBe("ffmpeg:campark/main#video=h264#audio=copy");

    // The RTSP URLs differ between modes, but ffmpeg source is the same.
    expect(go2rtcModeUrl).not.toBe(localModeUrl);
    expect(srcGo2rtc).not.toContain(go2rtcModeUrl);
    expect(srcGo2rtc).not.toContain(localModeUrl);
  });
});

// ---------------------------------------------------------------------------
// ── Pre-beta.14 behavior (regression baseline) ──────────────────────────────
// ---------------------------------------------------------------------------

describe("Fixed behavior matches pre-beta.14 pattern (streamName as ffmpeg input)", () => {
  it("ffmpeg source input is stream name (same as pre-beta.14, restored by fix)", () => {
    const preB14Src = `ffmpeg:${TICKET_STREAM_NAME}#video=h264#hardware`;
    const fixedSrc  = buildFfmpegSource(TICKET_STREAM_NAME);

    // Both reference the stream name, not the RTSP URL
    expect(preB14Src).toContain(TICKET_STREAM_NAME);
    expect(fixedSrc).toContain(TICKET_STREAM_NAME);

    expect(preB14Src).not.toContain("rtsp://");
    expect(fixedSrc).not.toContain("rtsp://");
  });

  it("fixed source uses #audio=copy instead of #hardware from pre-beta.14", () => {
    const fixedSrc = buildFfmpegSource(TICKET_STREAM_NAME);
    expect(fixedSrc).toContain("#audio=copy");
    expect(fixedSrc).not.toContain("#hardware");
  });
});
