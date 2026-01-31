import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "node:path";
import { EventEmitter } from "node:events";
import { getSettings } from "./settings-store";

// Event emitter for real-time log streaming
export const logEmitter = new EventEmitter();

// In-memory log buffer for recent logs
const LOG_BUFFER_SIZE = 1000;
const logBuffer: LogEntry[] = [];

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
  source?: string;
}

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE =
  /^(?:pass|password|pwd|token|access[_-]?token|refresh[_-]?token|authorization|auth|cookie|set-cookie|session|sid|username|user|users)$/i;

function redactString(input: string): string {
  return (
    input
      .replace(/\bBearer\s+[^\s]+/gi, `Bearer ${REDACTED}`)
      .replace(/([?&]token=)[^&\s]+/gi, `$1${REDACTED}`)
      .replace(
        /(authorization\s*:\s*)(bearer|basic)\s+[^\s]+/gi,
        `$1$2 ${REDACTED}`,
      )
      // URLs with basic auth: scheme://user:pass@host
      .replace(
        /(\w+:\/\/)([^:\/\s]+):([^@\/\s]+)@/g,
        `$1${REDACTED}:${REDACTED}@`,
      )
      // JSON-ish inline secrets
      .replace(/("password"\s*:\s*")([^"]+)(")/gi, `$1${REDACTED}$3`)
      .replace(/("token"\s*:\s*")([^"]+)(")/gi, `$1${REDACTED}$3`)
      .replace(/("username"\s*:\s*")([^"]+)(")/gi, `$1${REDACTED}$3`)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer length=${value.length}]`;

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((v) => sanitizeForLog(v, seen));
    }

    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(k)) {
          out[k] = REDACTED;
          continue;
        }
        out[k] = sanitizeForLog(v, seen);
      }
      return out;
    }

    // Fallback for non-plain objects (avoid leaking internals / circular refs)
    try {
      return redactString(String(value));
    } catch {
      return "[Unserializable]";
    }
  }

  return redactString(String(value));
}

function sanitizeMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const cleaned = sanitizeForLog(meta);
  return isPlainObject(cleaned) ? cleaned : undefined;
}

// Custom format for console and file
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, source, ...meta }) => {
    const sourceStr = source ? `[${source}]` : "";
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${sourceStr} ${message}${metaStr}`;
  }),
);

// JSON format for structured logging
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Create the logger instance
function createLogger() {
  const settings = getSettings();
  const dataDir = process.env.DATA_PATH || ".";
  const logsDir = path.join(dataDir, "logs");

  const retentionDays = Math.max(1, Number(settings.logRetentionDays || 14));

  const transports: winston.transport[] = [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), customFormat),
    }),

    // Daily rotating file transport
    new DailyRotateFile({
      dirname: logsDir,
      filename: "app-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: `${retentionDays}d`,
      format: jsonFormat,
    }),

    // Error-only file
    new DailyRotateFile({
      dirname: logsDir,
      filename: "error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: `${retentionDays}d`,
      level: "error",
      format: jsonFormat,
    }),
  ];

  return winston.createLogger({
    level: settings.logLevel || "info",
    transports,
  });
}

let logger = createLogger();

// Reload logger when settings change
export function reloadLogger() {
  logger = createLogger();
}

// Add log entry to buffer and emit
function addLogEntry(entry: LogEntry) {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
  logEmitter.emit("log", entry);
}

function shouldEmit(level: LogEntry["level"]): boolean {
  const settings = getSettings();
  const min = settings.logLevel || "info";

  const prio: Record<string, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };

  const lvl = prio[level] ?? prio.info;
  const minLvl = prio[min] ?? prio.info;
  return lvl <= minLvl;
}

// Get recent logs with optional pagination (for infinite scroll)
export function getRecentLogs(count = 100, beforeIndex?: number): LogEntry[] {
  if (beforeIndex !== undefined && beforeIndex >= 0) {
    // Return logs before the given index (for infinite scroll)
    const start = Math.max(0, beforeIndex - count);
    return logBuffer.slice(start, beforeIndex);
  }
  return logBuffer.slice(-count);
}

// Get total log count (for pagination)
export function getLogCount(): number {
  return logBuffer.length;
}

// Clear log buffer
export function clearLogBuffer() {
  logBuffer.length = 0;
}

// Wrapper function to log with source tagging
export function log(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  meta?: Record<string, unknown> & { source?: string },
) {
  const sanitizedMessage = redactString(message);
  const sanitizedMeta = sanitizeMeta(meta);
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message: sanitizedMessage,
    source: meta?.source,
    meta: sanitizedMeta ? { ...sanitizedMeta, source: undefined } : undefined,
  };

  if (shouldEmit(level)) {
    addLogEntry(entry);
  }
  logger.log(level, sanitizedMessage, sanitizedMeta);
}

// Convenience methods
export const appLogger = {
  info: (
    message: string,
    meta?: Record<string, unknown> & { source?: string },
  ) => log("info", message, meta),
  warn: (
    message: string,
    meta?: Record<string, unknown> & { source?: string },
  ) => log("warn", message, meta),
  error: (
    message: string,
    meta?: Record<string, unknown> & { source?: string },
  ) => log("error", message, meta),
  debug: (
    message: string,
    meta?: Record<string, unknown> & { source?: string },
  ) => log("debug", message, meta),
};

// Create a logger for a specific source (camera, rtsp, etc.)
export function createSourceLogger(source: string) {
  return {
    info: (message: string, meta?: Record<string, unknown>) =>
      log("info", message, { ...meta, source }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      log("warn", message, { ...meta, source }),
    error: (message: string, meta?: Record<string, unknown>) =>
      log("error", message, { ...meta, source }),
    debug: (message: string, meta?: Record<string, unknown>) =>
      log("debug", message, { ...meta, source }),
  };
}

export default appLogger;
