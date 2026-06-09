import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  StreamDiagnostic,
  checkFfmpeg,
  getActiveSession,
  getActiveSessions,
  sessionKey,
  listReports,
  readReport,
  deleteReport,
  MAX_CONCURRENT_SESSIONS,
  type DiagnosticStreamServer,
} from "../stream-diagnostic.js";
import { getRtspServerInstance } from "../rtsp-manager.js";
import { getConfig } from "../settings-store.js";
import { createSourceLogger } from "../logger.js";

const logger = createSourceLogger("diagnostic");

/**
 * Duck-type check: any stream server that implements the three required
 * diagnostic methods can drive the StreamDiagnostic session.
 * Both BaichuanRtspServer (legacy) and Go2rtcTcpServer (current default)
 * implement this surface.
 */
function implementsDiagnosticServer(s: unknown): s is DiagnosticStreamServer {
  if (s == null || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.subscribeDiagnostic === "function" &&
    typeof o.unsubscribeDiagnostic === "function" &&
    typeof o.getAudioInfo === "function"
  );
}

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

      // Get the stream server instance for this stream. Both Go2rtcTcpServer
      // and BaichuanRtspServer implement DiagnosticStreamServer (duck-typed),
      // so the diagnostic session works regardless of the underlying backend.
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
      if (!implementsDiagnosticServer(server)) {
        throw new Error(
          `The active stream server does not expose the diagnostic hooks ` +
          `(subscribeDiagnostic/unsubscribeDiagnostic/getAudioInfo).`,
        );
      }

      // Preflight ffmpeg here so the client sees a synchronous error instead
      // of a session that silently fails right after we return.
      if (!checkFfmpeg()) {
        throw new Error("ffmpeg not found on PATH");
      }

      // Resolve camera name
      const config = getConfig();
      const camera = config.cameras.find((c: { id: string }) => c.id === input.cameraId);
      const cameraName = camera?.name ?? input.cameraId;

      // Best-effort: read the camera's advertised frame rate for this
      // profile so the report can score `verdict.fpsDeltaPct`. Skipped if
      // the camera isn't reachable or the lookup throws — the diagnostic
      // still works, just without the expected/observed delta signal.
      let expectedFps: number | null = null;
      try {
        const { getOrCreateApiConnection } = await import("../rtsp-manager.js");
        const api = await getOrCreateApiConnection(input.cameraId);
        const isNvr = camera?.isNvr || !!camera?.nvrId;
        const opts = await api.buildVideoStreamOptions({
          channel: input.channel,
          onNvr: isNvr,
        });
        const match = opts.nativeStreams.find(
          (s) =>
            s.profile === input.profile &&
            (s.channel ?? 0) === input.channel,
        );
        const fr = match?.metadata?.frameRate;
        if (typeof fr === "number" && fr > 0) expectedFps = fr;
      } catch (err) {
        logger.warn(
          `Diagnostic ${key}: failed to read expectedFps (continuing without it): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const diagnostic = new StreamDiagnostic(server, cameraName, {
        cameraId: input.cameraId,
        profile: input.profile,
        channel: input.channel,
        durationMinutes: input.durationMinutes,
        expectedFps,
      });

      // Fire-and-forget: start() awaits the full feed loop (up to
      // durationMinutes). Returning the sessionId immediately lets the
      // client navigate away and reconcile via diagnostics.status without
      // holding open a multi-minute HTTP request.
      void diagnostic.start().catch((err) => {
        logger.error(
          `Diagnostic session ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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
