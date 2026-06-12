/**
 * tRPC routes for the packet-capture tool.
 *
 * The user picks a camera + interface in the UI, hits Start, and we spawn
 * tshark filtered to that camera's TCP 9000 traffic. The UI polls
 * `getStatus(captureId)` to show live progress (auth handshake state,
 * cmd_id histogram). On stop, the .pcapng file is downloadable via a
 * short-lived token from `app/src/server.ts`.
 */
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getConfig } from "../settings-store.js";
import {
  listInterfaces,
  testInterfaces,
  startCapture,
  stopCapture,
  deleteCapture,
  getCaptureStatus,
  listCaptureSessions,
  listSavedCaptures,
  getSavedCapture,
  deleteSavedCapture,
} from "../capture-manager.js";
import { TRPCError } from "@trpc/server";
import { isCaptureAvailable } from "../runtime-env.js";

export const captureRouter = router({
  /** List the network interfaces tshark can capture on (wraps `tshark -D`). */
  listInterfaces: publicProcedure.query(async () => {
    const items = await listInterfaces();
    return { interfaces: items };
  }),

  /**
   * Probe each interface (most plausible first) and return how many packets
   * each one saw to/from the camera during a short test window. The UI uses
   * this to auto-pick the right interface without the user having to know
   * their network topology.
   */
  testInterfaces: publicProcedure
    .input(z.object({ cameraId: z.string() }))
    .mutation(async ({ input }) => {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.cameraId);
      if (!camera) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Camera not found: ${input.cameraId}`,
        });
      }
      if (!camera.host) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Camera ${camera.name} has no host configured`,
        });
      }
      const ifaces = (await listInterfaces()).map((i) => i.id);
      const results = await testInterfaces(camera.host, ifaces);
      return { results };
    }),

  /** List all currently-tracked capture sessions. */
  list: publicProcedure.query(() => {
    return {
      sessions: listCaptureSessions().map((s) => ({
        id: s.id,
        cameraName: s.cameraName,
        cameraHost: s.cameraHost,
        iface: s.iface,
        startedAt: s.startedAt,
        ...(s.stoppedAt !== undefined ? { stoppedAt: s.stoppedAt } : {}),
        phase: s.phase,
      })),
    };
  }),

  /**
   * Start a new capture for the chosen camera. Returns the new session id;
   * the UI then polls `getStatus` to track progress.
   */
  start: publicProcedure
    .input(
      z.object({
        cameraId: z.string(),
        iface: z.string(),
      }),
    )
    .mutation(({ input }) => {
      if (!isCaptureAvailable()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Packet capture is only available on local installations, not under Docker.",
        });
      }
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === input.cameraId);
      if (!camera) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Camera not found: ${input.cameraId}`,
        });
      }
      if (!camera.host) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Camera ${camera.name} has no host configured`,
        });
      }
      const id = startCapture({
        cameraId: input.cameraId,
        cameraName: camera.name || camera.host,
        cameraHost: camera.host,
        iface: input.iface,
        cameraUsername: camera.username,
        cameraPassword: camera.password,
      });
      return { sessionId: id };
    }),

  /** Live status / cmd histogram for the running capture. */
  getStatus: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => {
      const status = getCaptureStatus(input.sessionId);
      if (!status) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Capture session not found: ${input.sessionId}`,
        });
      }
      return status;
    }),

  stop: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      await stopCapture(input.sessionId);
      return { success: true };
    }),

  delete: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => {
      deleteCapture(input.sessionId);
      return { success: true };
    }),

  /** List every persisted capture report (newest first). Reports page uses this. */
  listSaved: publicProcedure.query(() => {
    return { reports: listSavedCaptures() };
  }),

  /** Fetch a saved capture's full sanitized export (for inline view). */
  getSaved: publicProcedure
    .input(z.object({ captureId: z.string() }))
    .query(({ input }) => {
      const m = getSavedCapture(input.captureId);
      if (!m) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Saved capture not found: ${input.captureId}`,
        });
      }
      return m;
    }),

  deleteSaved: publicProcedure
    .input(z.object({ captureId: z.string() }))
    .mutation(({ input }) => {
      deleteSavedCapture(input.captureId);
      return { success: true };
    }),
});
