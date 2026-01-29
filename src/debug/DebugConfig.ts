import * as fs from "node:fs";
import * as path from "node:path";

export type Logger = import("../logging/logger").Logger;

export type DebugOptions = {
  /** Enables generic debug logs. */
  general?: boolean;
  /** Enables extra RTSP proxy/server debug logs (quiet by default). */
  debugRtsp?: boolean;
  /**
   * Enables native stream tracing and related low-level logs.
   *
   * Includes:
   * - stream command tracing (tx/rx cmd_id 3/4 + rx stream frames)
   * - H.264/H.265 debug logs/samples
   * - SPS/PPS/VPS parameter sets debug logs
   */
  traceNativeStream?: boolean;
  /**
   * Enables detailed tracing for recording-related commands (FileInfoList, findAlarmVideo, download).
   * Useful to understand what is happening on the wire for recordings only.
   */
  traceRecordings?: boolean;
  /** Enables talkback tracing (tx/rx cmd_id 10/11/201/202). */
  traceTalk?: boolean;
  /** Enables per-event tracing for cmd_id 33 (AlarmEventList push). */
  traceEvents?: boolean;
  dump?: {
    enabled?: boolean;
    dir?: string;
    bcmedia?: boolean;
    nals?: boolean;
  };
};

export type DebugConfig = {
  general: boolean;
  debugRtsp: boolean;
  traceNativeStream: boolean;
  traceRecordings: boolean;
  traceTalk: boolean;
  traceEvents: boolean;
  dumpEnabled: boolean;
  dumpDir: string;
  dumpBcMedia: boolean;
  dumpNals: boolean;
};

export function normalizeDebugOptions(opts?: DebugOptions): DebugConfig {
  const general = opts?.general === true;
  const debugRtsp = opts?.debugRtsp === true;
  const traceNativeStream = opts?.traceNativeStream === true;
  const traceRecordings = opts?.traceRecordings === true;
  const traceTalk = opts?.traceTalk === true;
  const traceEvents = opts?.traceEvents === true;

  const dumpEnabled = opts?.dump?.enabled === true;
  const dumpDir =
    (opts?.dump?.dir && opts.dump.dir.trim()) ||
    path.join(process.cwd(), "test", "frames-debug");
  const dumpBcMedia = opts?.dump?.bcmedia ?? dumpEnabled;
  const dumpNals = opts?.dump?.nals ?? dumpEnabled;

  return {
    general,
    debugRtsp,
    traceNativeStream,
    traceRecordings,
    traceTalk,
    traceEvents,
    dumpEnabled,
    dumpDir,
    dumpBcMedia,
    dumpNals,
  };
}

export function recordingsTraceLog(
  cfg: DebugConfig | undefined,
  logger: Logger | undefined,
  tag: string,
  message: string,
): void {
  if (!cfg?.traceRecordings || !logger) return;
  logger.log(`[${tag}] ${message}`);
}

export function ensureDumpDir(cfg: DebugConfig): void {
  if (!cfg.dumpEnabled) return;
  fs.mkdirSync(cfg.dumpDir, { recursive: true });
}

export function debugLog(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.general) return;
  logger.debug(`[${tag}] ${message}`);
}

export function debugWarn(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.general) return;
  logger.warn(`[${tag}] ${message}`);
}

export function traceLog(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.traceNativeStream) return;
  logger.debug(`[${tag}] ${message}`);
}

export function talkTraceLog(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.traceTalk) return;
  logger.debug(`[${tag}] ${message}`);
}

export function talkTraceWarn(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.traceTalk) return;
  logger.warn(`[${tag}] ${message}`);
}

export function eventTraceLog(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.traceEvents) return;
  logger.debug(`[${tag}] ${message}`);
}

export function rtspLog(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.debugRtsp) return;
  logger.info(`[${tag}] ${message}`);
}

export function rtspWarn(
  cfg: DebugConfig,
  logger: Logger,
  tag: string,
  message: string,
): void {
  if (!cfg.debugRtsp) return;
  logger.warn(`[${tag}] ${message}`);
}
