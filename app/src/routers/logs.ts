import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import { getRecentLogs, clearLogBuffer, LogEntry } from "../logger.js";
import fs from "node:fs";
import path from "node:path";

/** Resolve the logs directory (same logic as logger.ts) */
function getLogsDir(): string {
  const dataDir = process.env.DATA_PATH || ".";
  return path.resolve(path.join(dataDir, "logs"));
}

export const logsRouter = router({
  // Get recent logs from memory buffer
  getRecent: publicProcedure
    .meta({ description: "Get recent logs from memory buffer" })
    .input(
      z.object({
        count: z.number().default(100),
        level: z.enum(["error", "warn", "info", "debug"]).optional(),
        source: z.string().optional(),
      }),
    )
    .query(({ input }) => {
      let logs = getRecentLogs(input.count);

      // Filter by level if specified
      if (input.level) {
        const levelPriority: Record<string, number> = {
          error: 0,
          warn: 1,
          info: 2,
          debug: 3,
        };
        const minPriority = levelPriority[input.level];
        logs = logs.filter((log) => levelPriority[log.level] <= minPriority);
      }

      // Filter by source if specified
      if (input.source) {
        logs = logs.filter((log) => log.source === input.source);
      }

      // Newest-first
      return logs.slice().reverse();
    }),

  // Clear log buffer
  clear: publicProcedure
    .meta({ description: "Clear the in-memory log buffer" })
    .mutation(() => {
      clearLogBuffer();
      return { success: true };
    }),

  // List log files
  listFiles: publicProcedure
    .meta({ description: "List available log files" })
    .query(() => {
      const logsPath = getLogsDir();

      if (!fs.existsSync(logsPath)) {
        return [];
      }

      const files = fs.readdirSync(logsPath);
      return files
        .filter((f) => f.endsWith(".log"))
        .map((filename) => {
          const filePath = path.join(logsPath, filename);
          const stats = fs.statSync(filePath);
          return {
            filename,
            size: stats.size,
            modified: stats.mtime,
          };
        })
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    }),

  // Read a log file
  readFile: publicProcedure
    .meta({ description: "Read contents of a log file" })
    .input(
      z.object({
        filename: z.string(),
        lines: z.number().default(500),
        offset: z.number().default(0),
      }),
    )
    .query(({ input }) => {
      const logsPath = getLogsDir();
      const filePath = path.join(logsPath, input.filename);

      // Security check - prevent directory traversal
      if (!filePath.startsWith(logsPath)) {
        throw new Error("Invalid filename");
      }

      if (!fs.existsSync(filePath)) {
        throw new Error("Log file not found");
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const allLines = content.split("\n").filter(Boolean);

      const start = Math.max(0, allLines.length - input.lines - input.offset);
      const end = allLines.length - input.offset;
      const lines = allLines.slice(start, end);

      // Try to parse JSON logs
      const parsedLogs: LogEntry[] = lines.map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return {
            timestamp: "",
            level: "info",
            message: line,
          };
        }
      });

      return {
        logs: parsedLogs.reverse(),
        totalLines: allLines.length,
        hasMore: start > 0,
      };
    }),

  // Delete a log file
  deleteFile: publicProcedure
    .meta({ description: "Delete a log file" })
    .input(z.object({ filename: z.string() }))
    .mutation(({ input }) => {
      const logsPath = getLogsDir();
      const filePath = path.join(logsPath, input.filename);

      // Security check
      if (!filePath.startsWith(logsPath)) {
        throw new Error("Invalid filename");
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return { success: true };
    }),

  // Get unique sources from recent logs
  getSources: publicProcedure
    .meta({ description: "Get list of unique log sources" })
    .query(() => {
      const logs = getRecentLogs(1000);
      const sources = new Set<string>();

      for (const log of logs) {
        if (log.source) {
          sources.add(log.source);
        }
      }

      return Array.from(sources).sort();
    }),
});
