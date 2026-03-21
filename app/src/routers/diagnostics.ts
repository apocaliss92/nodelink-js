import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  getActiveSession,
  getActiveSessions,
  sessionKey,
  listReports,
  readReport,
  deleteReport,
  MAX_CONCURRENT_SESSIONS,
} from "../stream-diagnostic.js";

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
      if (getActiveSession(key)) {
        throw new Error(`Diagnostic already running for ${key}`);
      }
      if (getActiveSessions().size >= MAX_CONCURRENT_SESSIONS) {
        throw new Error(
          `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`,
        );
      }
      // Note: actual start requires BaichuanRtspServer reference - will be wired in integration
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
