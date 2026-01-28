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
      maxFiles: "14d",
      format: jsonFormat,
    }),

    // Error-only file
    new DailyRotateFile({
      dirname: logsDir,
      filename: "error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "30d",
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
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    source: meta?.source,
    meta: meta ? { ...meta, source: undefined } : undefined,
  };

  addLogEntry(entry);
  logger.log(level, message, meta);
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
