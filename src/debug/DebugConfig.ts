import * as fs from "node:fs";
import * as path from "node:path";

export type DebugOptions = {
  /** Enables generic debug logs. */
  enabled?: boolean;
  /** Enables extra RTSP proxy/server debug logs (quiet by default). */
  debugRtsp?: boolean;
  /** Enables stream command tracing (tx/rx cmd_id 3/4 + rx stream frames). */
  traceStream?: boolean;
  /** Enables talkback tracing (tx/rx cmd_id 10/11/201/202). */
  traceTalk?: boolean;
  /** Enables H.264-centric debug logs/samples. */
  debugH264?: boolean;
  /** Enables SPS/PPS cache/prepend debug logs. */
  debugParamSets?: boolean;
  dump?: {
    enabled?: boolean;
    dir?: string;
    bcmedia?: boolean;
    nals?: boolean;
  };
};

export type DebugConfig = {
  enabled: boolean;
  debugRtsp: boolean;
  traceStream: boolean;
  traceTalk: boolean;
  debugH264: boolean;
  debugParamSets: boolean;
  dumpEnabled: boolean;
  dumpDir: string;
  dumpBcMedia: boolean;
  dumpNals: boolean;
};

export function normalizeDebugOptions(opts?: DebugOptions): DebugConfig {
  const enabled = opts?.enabled === true;
  const debugRtsp = opts?.debugRtsp === true;
  const traceStream = opts?.traceStream === true;
  const traceTalk = opts?.traceTalk === true;
  const debugH264 = opts?.debugH264 === true || enabled;
  const debugParamSets = opts?.debugParamSets === true;

  const dumpEnabled = opts?.dump?.enabled === true;
  const dumpDir = (opts?.dump?.dir && opts.dump.dir.trim()) || path.join(process.cwd(), "test", "frames-debug");
  const dumpBcMedia = opts?.dump?.bcmedia ?? dumpEnabled;
  const dumpNals = opts?.dump?.nals ?? dumpEnabled;

  return { enabled, debugRtsp, traceStream, traceTalk, debugH264, debugParamSets, dumpEnabled, dumpDir, dumpBcMedia, dumpNals };
}

export function ensureDumpDir(cfg: DebugConfig): void {
  if (!cfg.dumpEnabled) return;
  fs.mkdirSync(cfg.dumpDir, { recursive: true });
}

export function debugLog(cfg: DebugConfig, tag: string, message: string): void {
  if (!cfg.enabled) return;
  console.log(`[${tag}] ${message}`);
}

export function debugWarn(cfg: DebugConfig, tag: string, message: string): void {
  if (!cfg.enabled) return;
  console.warn(`[${tag}] ${message}`);
}

export function traceLog(cfg: DebugConfig, tag: string, message: string): void {
  if (!cfg.traceStream) return;
  console.log(`[${tag}] ${message}`);
}

export function talkTraceLog(cfg: DebugConfig, tag: string, message: string): void {
  if (!cfg.traceTalk) return;
  console.log(`[${tag}] ${message}`);
}

export function talkTraceWarn(cfg: DebugConfig, tag: string, message: string): void {
  if (!cfg.traceTalk) return;
  console.warn(`[${tag}] ${message}`);
}

export function rtspLog(cfg: DebugConfig, tag: string, message: string): void {
  if (!cfg.debugRtsp) return;
  console.log(`[${tag}] ${message}`);
}

export function rtspWarn(cfg: DebugConfig, tag: string, message: string): void {
  if (!cfg.debugRtsp) return;
  console.warn(`[${tag}] ${message}`);
}


