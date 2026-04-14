import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  StreamDiagnostic,
  getActiveSession,
  getActiveSessions,
  sessionKey,
  listReports,
  readReport,
  deleteReport,
  MAX_CONCURRENT_SESSIONS,
} from "../stream-diagnostic.js";
import { getRtspServerInstance } from "../rtsp-manager.js";
import { BaichuanRtspServer } from "@apocaliss92/nodelink-js";
import { getConfig } from "../settings-store.js";

export const diagnosticsRouter = router({
  start: publicProcedure
    .input(
      z.object({
        cameraId: z.string(),
        profile: z.enum(["main", "sub", "ext"]),
        channel: z.number().int().min(0).default(0),
        durationMinutes: z.number().int().min(1).max(60).default(5),
      }),
    )
    .mutation(async ({ input }) => {
      const key = sessionKey(input.cameraId, input.profile, input.channel);
      const existing = getActiveSession(key);
      if (existing) {
        const st = existing.getStatus();
        if (st === "running") {
          // Already running — return existing session instead of error
          return { sessionId: key };
        }
        // Stale session (completed/error) — stop and remove
        try { await existing.stop(); } catch { /* ignore */ }
      }
      if (getActiveSessions().size >= MAX_CONCURRENT_SESSIONS) {
        throw new Error(
          `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`,
        );
      }

      // Get the stream server instance for this stream. Stream diagnostics
      // require the BaichuanRtspServer implementation — Go2rtcTcpServer does
      // not expose the diagnostic subscription API (go2rtc handles the stream
      // itself, so use go2rtc's own debugging tools instead).
      const server = getRtspServerInstance(
        input.cameraId,
        input.profile,
        input.channel,
      );
      if (!server) {
        throw new Error(
          `No running stream server for ${input.cameraId}/${input.profile}/ch${input.channel}. Start the stream first.`,
        );
      }
      if (!(server instanceof BaichuanRtspServer)) {
        throw new Error(
          `Stream diagnostics are not supported for go2rtc-backed streams. ` +
          `Disable go2rtc in settings to use the legacy RTSP server for diagnostics.`,
        );
      }

      // Resolve camera name
      const config = getConfig();
      const camera = config.cameras.find((c: { id: string }) => c.id === input.cameraId);
      const cameraName = camera?.name ?? input.cameraId;

      // Create and start the diagnostic session
      const diagnostic = new StreamDiagnostic(server, cameraName, {
        cameraId: input.cameraId,
        profile: input.profile,
        channel: input.channel,
        durationMinutes: input.durationMinutes,
      });

      await diagnostic.start();
      return { sessionId: key };
    }),

  stop: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      const session = getActiveSession(input.sessionId);
      if (!session) {
        throw new Error(`No active session: ${input.sessionId}`);
      }
      await session.stop();
      return { stopped: true };
    }),

  status: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => {
      const session = getActiveSession(input.sessionId);
      if (!session) {
        return { status: "not_found" as const, progress: 0 };
      }
      return { status: session.getStatus(), progress: session.getProgress() };
    }),

  list: publicProcedure
    .input(z.object({ cameraId: z.string().optional() }))
    .query(({ input }) => {
      const dataPath = process.env.DATA_PATH || ".";
      return listReports(dataPath, input.cameraId);
    }),

  download: publicProcedure
    .input(z.object({ reportId: z.string() }))
    .query(({ input }) => {
      const dataPath = process.env.DATA_PATH || ".";
      const report = readReport(dataPath, input.reportId);
      if (!report) {
        throw new Error(`Report not found: ${input.reportId}`);
      }
      return report;
    }),

  delete: publicProcedure
    .input(z.object({ reportId: z.string() }))
    .mutation(({ input }) => {
      const dataPath = process.env.DATA_PATH || ".";
      const deleted = deleteReport(dataPath, input.reportId);
      if (!deleted) {
        throw new Error(`Report not found: ${input.reportId}`);
      }
      return { deleted: true };
    }),
});
