import * as fs from "node:fs";
import * as path from "node:path";

export type DebugOptions = {
  /** Enables generic debug logs. */
  enabled?: boolean;
  /** Enables stream command tracing (tx/rx cmd_id 3/4 + rx stream frames). */
  traceStream?: boolean;
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
  traceStream: boolean;
  debugH264: boolean;
  debugParamSets: boolean;
  dumpEnabled: boolean;
  dumpDir: string;
  dumpBcMedia: boolean;
  dumpNals: boolean;
};

export function normalizeDebugOptions(opts?: DebugOptions): DebugConfig {
  const enabled = opts?.enabled === true;
  const traceStream = opts?.traceStream === true;
  const debugH264 = opts?.debugH264 === true || enabled;
  const debugParamSets = opts?.debugParamSets === true;

  const dumpEnabled = opts?.dump?.enabled === true;
  const dumpDir = (opts?.dump?.dir && opts.dump.dir.trim()) || path.join(process.cwd(), "test", "frames-debug");
  const dumpBcMedia = opts?.dump?.bcmedia ?? dumpEnabled;
  const dumpNals = opts?.dump?.nals ?? dumpEnabled;

  return { enabled, traceStream, debugH264, debugParamSets, dumpEnabled, dumpDir, dumpBcMedia, dumpNals };
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


