import { EventEmitter } from "node:events";
import { spawn, type ChildProcess, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createSourceLogger } from "./logger.js";

const logger = createSourceLogger("diagnostic");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagnosticOptions {
  readonly cameraId: string;
  readonly profile: string;
  readonly channel: number;
  readonly durationMinutes: number;
}

export interface DiagnosticReport {
  readonly cameraId: string;
  readonly cameraName: string;
  readonly profile: string;
  readonly channel: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationSeconds: number;
  readonly video: {
    readonly codec: "H264" | "H265";
    readonly resolution: { readonly width: number; readonly height: number };
    readonly fpsAvg: number;
    readonly fpsMin: number;
    readonly bitrateAvgKbps: number;
    readonly bitratePeakKbps: number;
    readonly keyframeIntervalAvgMs: number;
    readonly keyframeIntervalMaxMs: number;
    readonly totalFrames: number;
    readonly totalKeyframes: number;
  };
  readonly audio: {
    readonly detected: boolean;
    readonly codec: string | null;
    readonly sampleRate: number | null;
    readonly channels: number | null;
  };
  readonly protocol: {
    readonly totalBaichuanFrames: number;
    readonly avgFrameSizeBytes: number;
    readonly maxFrameSizeBytes: number;
    readonly avgInterFrameGapMs: number;
    readonly maxInterFrameGapMs: number;
    readonly decryptionErrors: number;
    readonly corruptedHeaders: number;
    readonly connectionResets: number;
  };
  readonly events: readonly DiagnosticEvent[];
}

export interface DiagnosticEvent {
  readonly timestamp: string;
  readonly offsetMs: number;
  readonly type:
    | "black_screen"
    | "freeze"
    | "pts_gap"
    | "bitrate_drop"
    | "frame_corruption"
    | "large_gap"
    | "keyframe_missing";
  readonly severity: "warning" | "error";
  readonly details: string;
  readonly protocolContext?: {
    readonly lastFrameSize: number;
    readonly gapBeforeMs: number;
    readonly wasDecryptionError: boolean;
  };
}

export const MAX_CONCURRENT_SESSIONS = 5;

// ---------------------------------------------------------------------------
// Lightweight interface for the server dependency (avoids importing the heavy
// BaichuanRtspServer class directly).
// ---------------------------------------------------------------------------

export interface DiagnosticStreamServer {
  subscribeDiagnostic(
    id: string,
  ): Promise<
    AsyncGenerator<
      {
        audio: boolean;
        data: Buffer;
        codec: string | null;
        sampleRate: number | null;
        microseconds: number | null;
        videoType?: "H264" | "H265";
      },
      void,
      unknown
    >
  >;
  unsubscribeDiagnostic(id: string): void;
  getAudioInfo(): {
    codec: "aac-adts";
    sampleRate: number;
    channels: number;
    configHex: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check that ffmpeg is available on PATH. */
export function checkFfmpeg(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Build the ffmpeg argument list for diagnostic analysis. */
export function buildFfmpegArgs(codec: "H264" | "H265"): readonly string[] {
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

// H.264 NAL unit types for keyframe detection
const H264_NAL_IDR = 5;
const H265_NAL_IDR_W_RADL = 19;
const H265_NAL_IDR_N_LP = 20;

function isKeyframe(data: Buffer, codec: "H264" | "H265"): boolean {
  // Scan for start codes and check NAL type
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      let nalOffset: number;
      if (data[i + 2] === 1) {
        nalOffset = i + 3;
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        nalOffset = i + 4;
      } else {
        continue;
      }
      if (nalOffset >= data.length) continue;

      if (codec === "H264") {
        const nalType = data[nalOffset]! & 0x1f;
        if (nalType === H264_NAL_IDR) return true;
      } else {
        const nalType = (data[nalOffset]! >> 1) & 0x3f;
        if (
          nalType === H265_NAL_IDR_W_RADL ||
          nalType === H265_NAL_IDR_N_LP
        )
          return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// ffmpeg stderr parsers
// ---------------------------------------------------------------------------

export interface ParsedBlackDetect {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

export function parseBlackDetect(line: string): ParsedBlackDetect | null {
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

export interface ParsedFreezeDetect {
  readonly start: number;
  readonly duration: number;
}

export function parseFreezeDetect(line: string): ParsedFreezeDetect | null {
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

export interface ParsedShowInfo {
  readonly n: number;
  readonly pts: number;
  readonly ptsTime: number;
  readonly size: string;
}

export function parseShowInfo(line: string): ParsedShowInfo | null {
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

// ---------------------------------------------------------------------------
// StreamDiagnostic class
// ---------------------------------------------------------------------------

type DiagnosticStatus = "idle" | "running" | "stopping" | "completed" | "error";

interface DiagnosticEvents {
  progress: [number];
  complete: [DiagnosticReport];
  error: [Error];
}

export class StreamDiagnostic extends EventEmitter<DiagnosticEvents> {
  private readonly options: DiagnosticOptions;
  private readonly server: DiagnosticStreamServer;
  private readonly cameraName: string;
  private status: DiagnosticStatus = "idle";
  private progress = 0;
  private ffmpeg: ChildProcess | null = null;
  private generator: AsyncGenerator<
    {
      audio: boolean;
      data: Buffer;
      codec: string | null;
      sampleRate: number | null;
      microseconds: number | null;
      videoType?: "H264" | "H265";
    },
    void,
    unknown
  > | null = null;
  private aborted = false;
  private diagId: string;

  // Protocol metrics
  private frameSizes: number[] = [];
  private frameTimes: number[] = [];
  private keyframeTimes: number[] = [];
  private detectedCodec: "H264" | "H265" = "H264";
  private detectedResolution = { width: 0, height: 0 };
  private diagEvents: DiagnosticEvent[] = [];
  private startTime = 0;
  private decryptionErrors = 0;
  private corruptedHeaders = 0;
  private connectionResets = 0;
  private totalKeyframes = 0;

  constructor(
    server: DiagnosticStreamServer,
    cameraName: string,
    options: DiagnosticOptions,
  ) {
    super();
    this.server = server;
    this.cameraName = cameraName;
    this.options = options;
    this.diagId = `diag-${options.cameraId}-${options.profile}-${options.channel}-${Date.now()}`;
  }

  getStatus(): DiagnosticStatus {
    return this.status;
  }

  getProgress(): number {
    return this.progress;
  }

  async start(): Promise<void> {
    if (this.status === "running") {
      throw new Error("Diagnostic session already running");
    }

    if (!checkFfmpeg()) {
      throw new Error("ffmpeg not found on PATH");
    }

    this.status = "running";
    this.startTime = Date.now();
    this.aborted = false;
    const durationMs = this.options.durationMinutes * 60 * 1000;

    const key = sessionKey(
      this.options.cameraId,
      this.options.profile,
      this.options.channel,
    );
    activeSessions.set(key, this);

    try {
      this.generator = await this.server.subscribeDiagnostic(this.diagId);

      // Read a first frame to detect codec
      const firstResult = await this.generator.next();
      if (firstResult.done) {
        throw new Error("Stream ended before first frame");
      }
      const firstFrame = firstResult.value;
      if (!firstFrame.audio && firstFrame.videoType) {
        this.detectedCodec = firstFrame.videoType;
      }

      // Spawn ffmpeg
      const args = buildFfmpegArgs(this.detectedCodec);
      this.ffmpeg = spawn("ffmpeg", [...args], {
        stdio: ["pipe", "ignore", "pipe"],
      });

      // Parse ffmpeg stderr
      let stderrBuffer = "";
      this.ffmpeg.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          this.parseFfmpegLine(line);
        }
      });

      this.ffmpeg.on("error", (err) => {
        logger.error(`ffmpeg process error: ${err.message}`);
      });

      // Write first frame
      if (!firstFrame.audio) {
        this.recordVideoFrame(firstFrame.data, firstFrame.microseconds);
        this.ffmpeg.stdin?.write(firstFrame.data);
      }

      // Feed frames until duration or abort
      const feedLoop = async () => {
        try {
          for await (const frame of this.generator!) {
            if (this.aborted) break;
            if (Date.now() - this.startTime >= durationMs) break;

            // Update progress
            const elapsed = Date.now() - this.startTime;
            this.progress = Math.min(
              99,
              Math.round((elapsed / durationMs) * 100),
            );
            this.emit("progress", this.progress);

            if (!frame.audio) {
              this.recordVideoFrame(frame.data, frame.microseconds);
              try {
                this.ffmpeg?.stdin?.write(frame.data);
              } catch {
                // ffmpeg stdin may close early
              }
            }
          }
        } catch (err) {
          if (!this.aborted) {
            logger.error(`Frame feed error: ${err}`);
          }
        }
      };

      await feedLoop();

      // Close ffmpeg stdin to signal EOF
      this.ffmpeg.stdin?.end();

      // Wait for ffmpeg to finish
      await new Promise<void>((resolve) => {
        if (!this.ffmpeg) return resolve();
        this.ffmpeg.on("close", () => resolve());
        // Safety timeout: 10s after stdin close
        setTimeout(() => {
          this.ffmpeg?.kill("SIGKILL");
          resolve();
        }, 10_000);
      });

      // Build report
      const report = this.buildReport();
      this.status = "completed";
      this.progress = 100;
      this.emit("progress", 100);
      this.emit("complete", report);

      // Write to disk
      const dataPath = process.env.DATA_PATH || ".";
      this.saveReport(dataPath, report);

      return;
    } catch (err) {
      this.status = "error";
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      throw error;
    } finally {
      // Cleanup
      this.server.unsubscribeDiagnostic(this.diagId);
      const key = sessionKey(
        this.options.cameraId,
        this.options.profile,
        this.options.channel,
      );
      activeSessions.delete(key);
      this.generator = null;
    }
  }

  async stop(): Promise<void> {
    this.aborted = true;
    this.status = "stopping";
    if (this.ffmpeg && !this.ffmpeg.killed) {
      this.ffmpeg.stdin?.end();
      this.ffmpeg.kill("SIGTERM");
    }
    // The start() loop will exit due to this.aborted being true
  }

  private recordVideoFrame(data: Buffer, microseconds: number | null): void {
    const now = Date.now();
    this.frameSizes.push(data.length);
    this.frameTimes.push(now);

    // Check for large gaps
    if (this.frameTimes.length >= 2) {
      const gap =
        this.frameTimes[this.frameTimes.length - 1]! -
        this.frameTimes[this.frameTimes.length - 2]!;
      if (gap > 2000) {
        this.diagEvents.push({
          timestamp: new Date().toISOString(),
          offsetMs: now - this.startTime,
          type: "large_gap",
          severity: "warning",
          details: `Inter-frame gap of ${gap}ms detected`,
          protocolContext: {
            lastFrameSize: data.length,
            gapBeforeMs: gap,
            wasDecryptionError: false,
          },
        });
      }
    }

    // Keyframe detection
    if (isKeyframe(data, this.detectedCodec)) {
      this.totalKeyframes++;
      this.keyframeTimes.push(now);
    }
  }

  private parseFfmpegLine(line: string): void {
    const offsetMs = Date.now() - this.startTime;

    const black = parseBlackDetect(line);
    if (black) {
      this.diagEvents.push({
        timestamp: new Date().toISOString(),
        offsetMs,
        type: "black_screen",
        severity: "warning",
        details: `Black screen detected: ${black.duration.toFixed(2)}s (${black.start.toFixed(2)}s - ${black.end.toFixed(2)}s)`,
      });
      return;
    }

    const freeze = parseFreezeDetect(line);
    if (freeze && freeze.duration > 0) {
      this.diagEvents.push({
        timestamp: new Date().toISOString(),
        offsetMs,
        type: "freeze",
        severity: "warning",
        details: `Freeze detected: ${freeze.duration.toFixed(2)}s`,
      });
      return;
    }

    const info = parseShowInfo(line);
    if (info) {
      // Extract resolution from first showinfo line
      if (this.detectedResolution.width === 0 && info.size) {
        const [w, h] = info.size.split("x").map(Number);
        if (w && h) {
          this.detectedResolution = { width: w, height: h };
        }
      }
    }
  }

  private buildReport(): DiagnosticReport {
    const completedAt = new Date().toISOString();
    const durationSeconds = (Date.now() - this.startTime) / 1000;

    // Compute inter-frame gaps
    const gaps: number[] = [];
    for (let i = 1; i < this.frameTimes.length; i++) {
      gaps.push(this.frameTimes[i]! - this.frameTimes[i - 1]!);
    }

    const avgGap =
      gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;

    // Compute keyframe intervals
    const kfIntervals: number[] = [];
    for (let i = 1; i < this.keyframeTimes.length; i++) {
      kfIntervals.push(this.keyframeTimes[i]! - this.keyframeTimes[i - 1]!);
    }
    const avgKfInterval =
      kfIntervals.length > 0
        ? kfIntervals.reduce((a, b) => a + b, 0) / kfIntervals.length
        : 0;
    const maxKfInterval =
      kfIntervals.length > 0 ? Math.max(...kfIntervals) : 0;

    // Compute bitrate
    const totalBytes = this.frameSizes.reduce((a, b) => a + b, 0);
    const bitrateAvgKbps =
      durationSeconds > 0 ? (totalBytes * 8) / 1000 / durationSeconds : 0;

    // Compute peak bitrate (over 1-second windows)
    let bitratePeakKbps = 0;
    if (this.frameTimes.length > 0) {
      let windowStart = 0;
      let windowBytes = 0;
      for (let i = 0; i < this.frameTimes.length; i++) {
        windowBytes += this.frameSizes[i]!;
        while (
          windowStart < i &&
          this.frameTimes[i]! - this.frameTimes[windowStart]! > 1000
        ) {
          windowBytes -= this.frameSizes[windowStart]!;
          windowStart++;
        }
        const windowDuration =
          (this.frameTimes[i]! - this.frameTimes[windowStart]!) / 1000;
        if (windowDuration > 0) {
          const kbps = (windowBytes * 8) / 1000 / windowDuration;
          if (kbps > bitratePeakKbps) bitratePeakKbps = kbps;
        }
      }
    }

    // FPS computation
    const fpsAvg =
      durationSeconds > 0 ? this.frameSizes.length / durationSeconds : 0;

    // Compute per-second FPS for min
    let fpsMin = fpsAvg;
    if (this.frameTimes.length > 1) {
      const perSecondCounts: number[] = [];
      let secStart = 0;
      for (let i = 0; i < this.frameTimes.length; i++) {
        if (this.frameTimes[i]! - this.frameTimes[secStart]! >= 1000) {
          perSecondCounts.push(i - secStart);
          secStart = i;
        }
      }
      if (perSecondCounts.length > 0) {
        fpsMin = Math.min(...perSecondCounts);
      }
    }

    // Audio info
    const audioInfo = this.server.getAudioInfo();

    const avgFrameSize =
      this.frameSizes.length > 0
        ? this.frameSizes.reduce((a, b) => a + b, 0) / this.frameSizes.length
        : 0;
    const maxFrameSize =
      this.frameSizes.length > 0 ? Math.max(...this.frameSizes) : 0;

    return {
      cameraId: this.options.cameraId,
      cameraName: this.cameraName,
      profile: this.options.profile,
      channel: this.options.channel,
      startedAt: new Date(this.startTime).toISOString(),
      completedAt,
      durationSeconds: Math.round(durationSeconds * 100) / 100,
      video: {
        codec: this.detectedCodec,
        resolution: this.detectedResolution,
        fpsAvg: Math.round(fpsAvg * 100) / 100,
        fpsMin: Math.round(fpsMin * 100) / 100,
        bitrateAvgKbps: Math.round(bitrateAvgKbps),
        bitratePeakKbps: Math.round(bitratePeakKbps),
        keyframeIntervalAvgMs: Math.round(avgKfInterval),
        keyframeIntervalMaxMs: Math.round(maxKfInterval),
        totalFrames: this.frameSizes.length,
        totalKeyframes: this.totalKeyframes,
      },
      audio: {
        detected: audioInfo !== null,
        codec: audioInfo ? audioInfo.codec : null,
        sampleRate: audioInfo ? audioInfo.sampleRate : null,
        channels: audioInfo ? audioInfo.channels : null,
      },
      protocol: {
        totalBaichuanFrames: this.frameSizes.length,
        avgFrameSizeBytes: Math.round(avgFrameSize),
        maxFrameSizeBytes: maxFrameSize,
        avgInterFrameGapMs: Math.round(avgGap * 100) / 100,
        maxInterFrameGapMs: Math.round(maxGap),
        decryptionErrors: this.decryptionErrors,
        corruptedHeaders: this.corruptedHeaders,
        connectionResets: this.connectionResets,
      },
      events: this.diagEvents,
    };
  }

  private saveReport(dataPath: string, report: DiagnosticReport): void {
    const dir = getDiagnosticsDir(dataPath);
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const filename = `${report.cameraId}_${report.profile}_ch${report.channel}_${timestamp}.json`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
    logger.info(`Diagnostic report saved: ${filePath}`);
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, StreamDiagnostic>();

export function getActiveSession(key: string): StreamDiagnostic | undefined {
  return activeSessions.get(key);
}

export function getActiveSessions(): Map<string, StreamDiagnostic> {
  return activeSessions;
}

export function sessionKey(
  cameraId: string,
  profile: string,
  channel: number,
): string {
  return `${cameraId}:${profile}:${channel}`;
}

// ---------------------------------------------------------------------------
// Storage functions
// ---------------------------------------------------------------------------

export function getDiagnosticsDir(dataPath: string): string {
  const dir = join(dataPath, "diagnostics");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export interface ReportListEntry {
  readonly reportId: string;
  readonly cameraId: string;
  readonly profile: string;
  readonly channel: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationSeconds: number;
}

export function listReports(
  dataPath: string,
  cameraId?: string,
): readonly ReportListEntry[] {
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

export function readReport(
  dataPath: string,
  reportId: string,
): DiagnosticReport | null {
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

export function deleteReport(dataPath: string, reportId: string): boolean {
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
