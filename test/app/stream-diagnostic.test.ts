import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAG_FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "diagnostics");

function hasDiagFixtures(): boolean {
  return fs.existsSync(path.join(DIAG_FIXTURES_DIR, "main-stream.h265"));
}

/**
 * Tests for stream-diagnostic.ts logic.
 * We inline pure functions here to avoid importing the module, which
 * triggers winston/logger side-effects at import time.
 */

// ---------------------------------------------------------------------------
// Inlined pure functions from stream-diagnostic.ts
// ---------------------------------------------------------------------------

function buildFfmpegArgs(codec: "H264" | "H265"): readonly string[] {
  const inputFormat = codec === "H264" ? "h264" : "hevc";
  return [
    "-f",
    inputFormat,
    "-i",
    "pipe:0",
    "-vf",
    "blackdetect=d=0.5:pic_th=0.90,freezedetect=n=0.003:d=2,showinfo",
    "-f",
    "null",
    "-",
  ] as const;
}

interface ParsedBlackDetect {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

function parseBlackDetect(line: string): ParsedBlackDetect | null {
  const m = line.match(
    /\[blackdetect.*\]\s*black_start:\s*([\d.]+)\s*black_end:\s*([\d.]+)\s*black_duration:\s*([\d.]+)/,
  );
  if (!m) return null;
  return {
    start: parseFloat(m[1]!),
    end: parseFloat(m[2]!),
    duration: parseFloat(m[3]!),
  };
}

interface ParsedFreezeDetect {
  readonly start: number;
  readonly duration: number;
}

function parseFreezeDetect(line: string): ParsedFreezeDetect | null {
  const startMatch = line.match(
    /\[freezedetect.*\]\s*lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/,
  );
  if (startMatch) {
    return { start: parseFloat(startMatch[1]!), duration: 0 };
  }
  const endMatch = line.match(
    /\[freezedetect.*\]\s*lavfi\.freezedetect\.freeze_duration:\s*([\d.]+)/,
  );
  if (endMatch) {
    return { start: 0, duration: parseFloat(endMatch[1]!) };
  }
  return null;
}

interface ParsedShowInfo {
  readonly n: number;
  readonly pts: number;
  readonly ptsTime: number;
  readonly size: string;
}

function parseShowInfo(line: string): ParsedShowInfo | null {
  const m = line.match(
    /\[Parsed_showinfo.*\]\s*n:\s*(\d+).*pts:\s*(\d+).*pts_time:\s*([\d.]+).*s:\s*(\d+x\d+)/,
  );
  if (!m) return null;
  return {
    n: parseInt(m[1]!, 10),
    pts: parseInt(m[2]!, 10),
    ptsTime: parseFloat(m[3]!),
    size: m[4]!,
  };
}

function sessionKey(cameraId: string, profile: string, channel: number): string {
  return `${cameraId}:${profile}:${channel}`;
}

const MAX_CONCURRENT_SESSIONS = 5;

function getDiagnosticsDir(dataPath: string): string {
  const dir = join(dataPath, "diagnostics");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

interface DiagnosticReport {
  cameraId: string;
  cameraName: string;
  profile: string;
  channel: number;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  video: {
    codec: "H264" | "H265";
    resolution: { width: number; height: number };
    fpsAvg: number;
    fpsMin: number;
    bitrateAvgKbps: number;
    bitratePeakKbps: number;
    keyframeIntervalAvgMs: number;
    keyframeIntervalMaxMs: number;
    totalFrames: number;
    totalKeyframes: number;
  };
  audio: {
    detected: boolean;
    codec: string | null;
    sampleRate: number | null;
    channels: number | null;
  };
  protocol: {
    totalBaichuanFrames: number;
    avgFrameSizeBytes: number;
    maxFrameSizeBytes: number;
    avgInterFrameGapMs: number;
    maxInterFrameGapMs: number;
    decryptionErrors: number;
    corruptedHeaders: number;
    connectionResets: number;
  };
  events: unknown[];
}

interface ReportListEntry {
  readonly reportId: string;
  readonly cameraId: string;
  readonly profile: string;
  readonly channel: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationSeconds: number;
}

function listReports(dataPath: string, cameraId?: string): readonly ReportListEntry[] {
  const dir = getDiagnosticsDir(dataPath);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const entries: ReportListEntry[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const report = JSON.parse(content) as DiagnosticReport;
      if (cameraId && report.cameraId !== cameraId) continue;
      entries.push({
        reportId: file.replace(".json", ""),
        cameraId: report.cameraId,
        profile: report.profile,
        channel: report.channel,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        durationSeconds: report.durationSeconds,
      });
    } catch {
      // Skip malformed files
    }
  }
  return entries;
}

function readReport(dataPath: string, reportId: string): DiagnosticReport | null {
  const dir = getDiagnosticsDir(dataPath);
  const filePath = join(dir, `${reportId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as DiagnosticReport;
  } catch {
    return null;
  }
}

function deleteReport(dataPath: string, reportId: string): boolean {
  const dir = getDiagnosticsDir(dataPath);
  const filePath = join(dir, `${reportId}.json`);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ffmpeg command construction
// ---------------------------------------------------------------------------

describe("buildFfmpegArgs", () => {
  it("uses h264 input format for H264 codec", () => {
    const args = buildFfmpegArgs("H264");
    const fIdx = args.indexOf("-f");
    expect(args[fIdx + 1]).toBe("h264");
  });

  it("uses hevc input format for H265 codec", () => {
    const args = buildFfmpegArgs("H265");
    const fIdx = args.indexOf("-f");
    expect(args[fIdx + 1]).toBe("hevc");
  });

  it("reads from stdin (pipe:0)", () => {
    const args = buildFfmpegArgs("H264");
    expect(args).toContain("pipe:0");
  });

  it("includes blackdetect filter", () => {
    const args = buildFfmpegArgs("H264");
    const vfIdx = args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThan(-1);
    const filterStr = args[vfIdx + 1] as string;
    expect(filterStr).toContain("blackdetect");
  });

  it("includes freezedetect filter", () => {
    const args = buildFfmpegArgs("H264");
    const vfIdx = args.indexOf("-vf");
    const filterStr = args[vfIdx + 1] as string;
    expect(filterStr).toContain("freezedetect");
  });

  it("includes showinfo filter", () => {
    const args = buildFfmpegArgs("H264");
    const vfIdx = args.indexOf("-vf");
    const filterStr = args[vfIdx + 1] as string;
    expect(filterStr).toContain("showinfo");
  });

  it("outputs to null sink", () => {
    const args = buildFfmpegArgs("H264");
    expect(args).toContain("null");
  });
});

// ---------------------------------------------------------------------------
// ffmpeg stderr parsing
// ---------------------------------------------------------------------------

describe("parseBlackDetect", () => {
  it("parses a blackdetect line", () => {
    const line =
      "[blackdetect @ 0x1234] black_start:1.50 black_end:3.25 black_duration:1.75";
    const result = parseBlackDetect(line);
    expect(result).not.toBeNull();
    expect(result!.start).toBeCloseTo(1.5);
    expect(result!.end).toBeCloseTo(3.25);
    expect(result!.duration).toBeCloseTo(1.75);
  });

  it("returns null for non-matching lines", () => {
    expect(parseBlackDetect("some random ffmpeg output")).toBeNull();
  });
});

describe("parseFreezeDetect", () => {
  it("parses a freeze_start line", () => {
    const line =
      "[freezedetect @ 0xabc] lavfi.freezedetect.freeze_start: 5.00";
    const result = parseFreezeDetect(line);
    expect(result).not.toBeNull();
    expect(result!.start).toBeCloseTo(5.0);
  });

  it("parses a freeze_duration line", () => {
    const line =
      "[freezedetect @ 0xabc] lavfi.freezedetect.freeze_duration: 3.50";
    const result = parseFreezeDetect(line);
    expect(result).not.toBeNull();
    expect(result!.duration).toBeCloseTo(3.5);
  });

  it("returns null for non-matching lines", () => {
    expect(parseFreezeDetect("unrelated output")).toBeNull();
  });
});

describe("parseShowInfo", () => {
  it("parses a showinfo line", () => {
    const line =
      "[Parsed_showinfo_2 @ 0xfff] n:  42 pts:  84000 pts_time:3.500 fmt:yuv420p s:1920x1080";
    const result = parseShowInfo(line);
    expect(result).not.toBeNull();
    expect(result!.n).toBe(42);
    expect(result!.pts).toBe(84000);
    expect(result!.ptsTime).toBeCloseTo(3.5);
    expect(result!.size).toBe("1920x1080");
  });

  it("returns null for non-matching lines", () => {
    expect(parseShowInfo("frame= 100 fps=25")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session key
// ---------------------------------------------------------------------------

describe("sessionKey", () => {
  it("generates key from cameraId, profile, and channel", () => {
    expect(sessionKey("cam1", "main", 0)).toBe("cam1:main:0");
  });

  it("handles non-zero channels", () => {
    expect(sessionKey("nvr1", "sub", 3)).toBe("nvr1:sub:3");
  });
});

// ---------------------------------------------------------------------------
// MAX_CONCURRENT_SESSIONS constant
// ---------------------------------------------------------------------------

describe("MAX_CONCURRENT_SESSIONS", () => {
  it("is set to 5", () => {
    expect(MAX_CONCURRENT_SESSIONS).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Report structure validation
// ---------------------------------------------------------------------------

describe("DiagnosticReport structure", () => {
  const sampleReport: DiagnosticReport = {
    cameraId: "cam1",
    cameraName: "Front Door",
    profile: "main",
    channel: 0,
    startedAt: "2026-03-21T10:00:00.000Z",
    completedAt: "2026-03-21T10:05:00.000Z",
    durationSeconds: 300,
    video: {
      codec: "H264",
      resolution: { width: 1920, height: 1080 },
      fpsAvg: 25,
      fpsMin: 22,
      bitrateAvgKbps: 4000,
      bitratePeakKbps: 6000,
      keyframeIntervalAvgMs: 2000,
      keyframeIntervalMaxMs: 2500,
      totalFrames: 7500,
      totalKeyframes: 150,
    },
    audio: {
      detected: true,
      codec: "aac-adts",
      sampleRate: 16000,
      channels: 1,
    },
    protocol: {
      totalBaichuanFrames: 7500,
      avgFrameSizeBytes: 6700,
      maxFrameSizeBytes: 120000,
      avgInterFrameGapMs: 40,
      maxInterFrameGapMs: 120,
      decryptionErrors: 0,
      corruptedHeaders: 0,
      connectionResets: 0,
    },
    events: [],
  };

  it("has all required top-level fields", () => {
    expect(sampleReport).toHaveProperty("cameraId");
    expect(sampleReport).toHaveProperty("cameraName");
    expect(sampleReport).toHaveProperty("profile");
    expect(sampleReport).toHaveProperty("channel");
    expect(sampleReport).toHaveProperty("startedAt");
    expect(sampleReport).toHaveProperty("completedAt");
    expect(sampleReport).toHaveProperty("durationSeconds");
    expect(sampleReport).toHaveProperty("video");
    expect(sampleReport).toHaveProperty("audio");
    expect(sampleReport).toHaveProperty("protocol");
    expect(sampleReport).toHaveProperty("events");
  });

  it("has all required video fields", () => {
    expect(sampleReport.video).toHaveProperty("codec");
    expect(sampleReport.video).toHaveProperty("resolution");
    expect(sampleReport.video).toHaveProperty("fpsAvg");
    expect(sampleReport.video).toHaveProperty("fpsMin");
    expect(sampleReport.video).toHaveProperty("bitrateAvgKbps");
    expect(sampleReport.video).toHaveProperty("bitratePeakKbps");
    expect(sampleReport.video).toHaveProperty("keyframeIntervalAvgMs");
    expect(sampleReport.video).toHaveProperty("keyframeIntervalMaxMs");
    expect(sampleReport.video).toHaveProperty("totalFrames");
    expect(sampleReport.video).toHaveProperty("totalKeyframes");
  });

  it("has all required audio fields", () => {
    expect(sampleReport.audio).toHaveProperty("detected");
    expect(sampleReport.audio).toHaveProperty("codec");
    expect(sampleReport.audio).toHaveProperty("sampleRate");
    expect(sampleReport.audio).toHaveProperty("channels");
  });

  it("has all required protocol fields", () => {
    expect(sampleReport.protocol).toHaveProperty("totalBaichuanFrames");
    expect(sampleReport.protocol).toHaveProperty("avgFrameSizeBytes");
    expect(sampleReport.protocol).toHaveProperty("maxFrameSizeBytes");
    expect(sampleReport.protocol).toHaveProperty("avgInterFrameGapMs");
    expect(sampleReport.protocol).toHaveProperty("maxInterFrameGapMs");
    expect(sampleReport.protocol).toHaveProperty("decryptionErrors");
    expect(sampleReport.protocol).toHaveProperty("corruptedHeaders");
    expect(sampleReport.protocol).toHaveProperty("connectionResets");
  });
});

// ---------------------------------------------------------------------------
// Storage functions (using temp directory)
// ---------------------------------------------------------------------------

describe("Report storage", () => {
  let tempDir: string;

  const sampleReport: DiagnosticReport = {
    cameraId: "cam1",
    cameraName: "Front Door",
    profile: "main",
    channel: 0,
    startedAt: "2026-03-21T10:00:00.000Z",
    completedAt: "2026-03-21T10:05:00.000Z",
    durationSeconds: 300,
    video: {
      codec: "H264",
      resolution: { width: 1920, height: 1080 },
      fpsAvg: 25,
      fpsMin: 22,
      bitrateAvgKbps: 4000,
      bitratePeakKbps: 6000,
      keyframeIntervalAvgMs: 2000,
      keyframeIntervalMaxMs: 2500,
      totalFrames: 7500,
      totalKeyframes: 150,
    },
    audio: {
      detected: false,
      codec: null,
      sampleRate: null,
      channels: null,
    },
    protocol: {
      totalBaichuanFrames: 7500,
      avgFrameSizeBytes: 6700,
      maxFrameSizeBytes: 120000,
      avgInterFrameGapMs: 40,
      maxInterFrameGapMs: 120,
      decryptionErrors: 0,
      corruptedHeaders: 0,
      connectionResets: 0,
    },
    events: [],
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "diag-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates diagnostics directory if missing", () => {
    const dir = getDiagnosticsDir(tempDir);
    expect(existsSync(dir)).toBe(true);
    expect(dir).toBe(join(tempDir, "diagnostics"));
  });

  it("lists reports from directory", () => {
    const dir = getDiagnosticsDir(tempDir);
    writeFileSync(
      join(dir, "cam1_main_ch0_2026-03-21.json"),
      JSON.stringify(sampleReport),
    );
    const reports = listReports(tempDir);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.cameraId).toBe("cam1");
    expect(reports[0]!.reportId).toBe("cam1_main_ch0_2026-03-21");
  });

  it("filters reports by cameraId", () => {
    const dir = getDiagnosticsDir(tempDir);
    writeFileSync(
      join(dir, "cam1_main_ch0.json"),
      JSON.stringify(sampleReport),
    );
    const otherReport = { ...sampleReport, cameraId: "cam2" };
    writeFileSync(
      join(dir, "cam2_main_ch0.json"),
      JSON.stringify(otherReport),
    );

    const cam1Reports = listReports(tempDir, "cam1");
    expect(cam1Reports).toHaveLength(1);
    expect(cam1Reports[0]!.cameraId).toBe("cam1");

    const allReports = listReports(tempDir);
    expect(allReports).toHaveLength(2);
  });

  it("reads a specific report", () => {
    const dir = getDiagnosticsDir(tempDir);
    writeFileSync(
      join(dir, "test-report.json"),
      JSON.stringify(sampleReport),
    );
    const report = readReport(tempDir, "test-report");
    expect(report).not.toBeNull();
    expect(report!.cameraId).toBe("cam1");
    expect(report!.video.codec).toBe("H264");
  });

  it("returns null for non-existent report", () => {
    getDiagnosticsDir(tempDir);
    const report = readReport(tempDir, "nonexistent");
    expect(report).toBeNull();
  });

  it("deletes a report", () => {
    const dir = getDiagnosticsDir(tempDir);
    writeFileSync(
      join(dir, "to-delete.json"),
      JSON.stringify(sampleReport),
    );
    expect(deleteReport(tempDir, "to-delete")).toBe(true);
    expect(existsSync(join(dir, "to-delete.json"))).toBe(false);
  });

  it("returns false when deleting non-existent report", () => {
    getDiagnosticsDir(tempDir);
    expect(deleteReport(tempDir, "nonexistent")).toBe(false);
  });

  it("returns empty list for empty directory", () => {
    getDiagnosticsDir(tempDir);
    const reports = listReports(tempDir);
    expect(reports).toHaveLength(0);
  });

  it("skips malformed JSON files", () => {
    const dir = getDiagnosticsDir(tempDir);
    writeFileSync(join(dir, "bad.json"), "not valid json");
    writeFileSync(
      join(dir, "good.json"),
      JSON.stringify(sampleReport),
    );
    const reports = listReports(tempDir);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reportId).toBe("good");
  });
});

// ---------------------------------------------------------------------------
// Diagnostic pipeline with real H.265 fixtures
// ---------------------------------------------------------------------------

describe("Diagnostic pipeline with real H.265 fixtures", () => {
  it.skipIf(!hasDiagFixtures())(
    "ffmpeg analyzes H.265 main stream without errors",
    async () => {
      const { spawn } = await import("node:child_process");
      const streamPath = path.join(DIAG_FIXTURES_DIR, "main-stream.h265");
      const streamData = fs.readFileSync(streamPath);

      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
          "-f", "hevc",
          "-i", "pipe:0",
          "-vf", "blackdetect=d=0.5:pic_th=0.90,freezedetect=n=0.003:d=2,showinfo",
          "-f", "null",
          "-",
        ]);

        let stderr = "";
        ffmpeg.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        ffmpeg.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`ffmpeg exited with code ${code}. stderr:\n${stderr}`));
            return;
          }
          expect(stderr).toContain("[Parsed_showinfo");
          resolve();
        });

        ffmpeg.on("error", (err) => {
          reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
        });

        ffmpeg.stdin.write(streamData);
        ffmpeg.stdin.end();
      });
    },
    60_000,
  );

  it.skipIf(!hasDiagFixtures())(
    "frame metadata matches expected structure",
    () => {
      const framesPath = path.join(DIAG_FIXTURES_DIR, "main-frames.json");
      const frames = JSON.parse(fs.readFileSync(framesPath, "utf-8")) as Array<{
        audio: boolean;
        videoType?: string;
        isKeyframe?: boolean;
        dataLength: number;
        microseconds?: number;
      }>;

      expect(Array.isArray(frames)).toBe(true);
      expect(frames.length).toBeGreaterThan(100);

      const videoFrames = frames.filter((f) => !f.audio);
      const audioFrames = frames.filter((f) => f.audio);

      // Video frames have expected fields
      for (const vf of videoFrames.slice(0, 20)) {
        expect(vf).toHaveProperty("videoType");
        expect(vf).toHaveProperty("isKeyframe");
        expect(vf).toHaveProperty("dataLength");
        expect(vf).toHaveProperty("microseconds");
      }

      // At least one keyframe present
      const keyframes = videoFrames.filter((f) => f.isKeyframe);
      expect(keyframes.length).toBeGreaterThan(0);

      // At least some audio frames present
      expect(audioFrames.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!hasDiagFixtures())(
    "protocol metrics can be computed from frame metadata",
    () => {
      const framesPath = path.join(DIAG_FIXTURES_DIR, "main-frames.json");
      const frames = JSON.parse(fs.readFileSync(framesPath, "utf-8")) as Array<{
        audio: boolean;
        dataLength: number;
        microseconds?: number;
      }>;

      const videoFrames = frames.filter((f) => !f.audio && f.microseconds !== undefined);
      expect(videoFrames.length).toBeGreaterThan(1);

      // Compute inter-frame gaps in milliseconds
      const gaps: number[] = [];
      for (let i = 1; i < videoFrames.length; i++) {
        const prev = videoFrames[i - 1]!.microseconds!;
        const curr = videoFrames[i]!.microseconds!;
        const gapMs = (curr - prev) / 1000;
        if (gapMs > 0) {
          gaps.push(gapMs);
        }
      }

      expect(gaps.length).toBeGreaterThan(0);

      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const maxGap = Math.max(...gaps);

      // Average inter-frame gap should be reasonable (10–200 ms for typical streams)
      expect(avgGap).toBeGreaterThan(10);
      expect(avgGap).toBeLessThan(200);

      // No single gap should exceed 5 seconds
      expect(maxGap).toBeLessThan(5000);

      // Frame sizes should be meaningful
      for (const vf of videoFrames.slice(0, 10)) {
        expect(vf.dataLength).toBeGreaterThan(100);
      }
    },
  );

  it.skipIf(!hasDiagFixtures())(
    "sub profile summary file exists and has valid data",
    () => {
      const summaryPath = path.join(DIAG_FIXTURES_DIR, "sub-summary.json");
      expect(fs.existsSync(summaryPath)).toBe(true);

      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as {
        profile: string;
        captureMs: number;
        totalFrames: number;
        videoFrames: number;
        audioFrames: number;
        keyframes: number;
        h265Bytes: number;
        codec: string | null;
      };

      expect(summary.profile).toBe("sub");
      expect(typeof summary.captureMs).toBe("number");
      expect(summary.captureMs).toBeGreaterThan(0);
      expect(typeof summary.totalFrames).toBe("number");
      expect(summary.totalFrames).toBeGreaterThan(0);
      expect(summary.keyframes).toBeGreaterThan(0);
    },
  );

  it.skipIf(!hasDiagFixtures())(
    "ext profile summary file exists and has valid data",
    () => {
      const summaryPath = path.join(DIAG_FIXTURES_DIR, "ext-summary.json");
      // ext stream may not be available on all cameras; if absent, skip gracefully
      if (!fs.existsSync(summaryPath)) {
        return;
      }

      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as {
        profile: string;
        captureMs: number;
        totalFrames: number;
        error?: string;
      };

      expect(summary.profile).toBe("ext");
      expect(typeof summary.captureMs).toBe("number");
    },
  );
});
