/**
 * WebRTC tRPC router — exposes the in-process BaichuanWebRTCServer as a
 * fallback for environments where go2rtc is not available (or the user
 * deliberately wants the native pipeline, e.g. to ship detection-box overlays
 * with a known frame timing).
 *
 * Signaling flow (server creates offer, browser answers):
 *   1. Browser calls `webrtc.create({ cameraId, profile })` → receives offer SDP
 *   2. Browser sets remote description, creates answer, sets local description
 *   3. Browser calls `webrtc.answer({ sessionId, sdp })`
 *   4. Browser optionally trickles ICE via `webrtc.addIce({ sessionId, candidate })`
 *   5. Browser calls `webrtc.close({ sessionId })` on tear-down
 *
 * The server peer-connection gathers full ICE before returning the offer when
 * `iceServers` are configured, so trickle ICE on the browser side is optional
 * for most LAN setups.
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  createWebRTCSession,
  handleWebRTCAnswer,
  addIceCandidate,
  closeWebRTCSession,
  getWebRTCStatus,
} from "../webrtc-native.js";

const profileSchema = z.enum(["main", "sub", "ext"]);

const sdpSchema = z.object({
  type: z.literal("offer").or(z.literal("answer")),
  sdp: z.string(),
});

const iceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
});

export const webrtcRouter = router({
  /**
   * Open a new native WebRTC session for the given camera/profile and return
   * the SDP offer the browser must answer.
   */
  create: publicProcedure
    .meta({ description: "Create a native WebRTC session and return the SDP offer" })
    .input(
      z.object({
        cameraId: z.string(),
        profile: profileSchema,
        enableIntercom: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { sessionId, offer } = await createWebRTCSession(
        input.cameraId,
        input.profile,
        input.enableIntercom,
      );
      return {
        sessionId,
        offer: { type: offer.type, sdp: offer.sdp },
      };
    }),

  /** Submit the browser's SDP answer for the given session. */
  answer: publicProcedure
    .meta({ description: "Submit the browser's SDP answer" })
    .input(
      z.object({
        sessionId: z.string(),
        sdp: sdpSchema,
      }),
    )
    .mutation(async ({ input }) => {
      await handleWebRTCAnswer(input.sessionId, {
        type: "answer",
        sdp: input.sdp.sdp,
      });
      return { ok: true };
    }),

  /** Trickle an ICE candidate from the browser to the server peer connection. */
  addIce: publicProcedure
    .meta({ description: "Forward a browser ICE candidate to the server" })
    .input(
      z.object({
        sessionId: z.string(),
        candidate: iceCandidateSchema,
      }),
    )
    .mutation(async ({ input }) => {
      await addIceCandidate(input.sessionId, {
        candidate: input.candidate.candidate,
        sdpMid: input.candidate.sdpMid ?? undefined,
        sdpMLineIndex: input.candidate.sdpMLineIndex ?? undefined,
      });
      return { ok: true };
    }),

  /** Tear down a WebRTC session and free its peer connection. */
  close: publicProcedure
    .meta({ description: "Close a WebRTC session" })
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      await closeWebRTCSession(input.sessionId);
      return { ok: true };
    }),

  /** List all active native WebRTC sessions with their stats. */
  status: publicProcedure
    .meta({ description: "List active native WebRTC sessions" })
    .query(() => {
      return getWebRTCStatus();
    }),
});
