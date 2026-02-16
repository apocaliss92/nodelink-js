import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import {
  getRecentEvents,
  getEventsManagerStatus,
} from "../events-manager.js";

function getBaseUrl(req: { headers?: { host?: string }; protocol?: string }) {
  const host = req.headers?.host ?? "localhost:3000";
  const proto = req.protocol === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export const eventsRouter = router({
  getRecent: publicProcedure
    .meta({ description: "Get recent camera events" })
    .input(
      z
        .object({
          cameraId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      return getRecentEvents(input?.cameraId);
    }),

  getStatus: publicProcedure
    .meta({
      description:
        "Events manager status: SSE clients, JSON stream clients, MQTT, registered cameras",
    })
    .input(z.object({}).optional())
    .query(() => getEventsManagerStatus()),

  getSseInfo: publicProcedure
    .meta({
      description:
        "SSE endpoint info for testing: GET /api/events/sse (Server-Sent Events)",
    })
    .input(z.object({}).optional())
    .query(({ ctx }) => {
      const base = getBaseUrl(ctx.req);
      const url = `${base}/api/events/sse`;
      return {
        url,
        method: "GET",
        contentType: "text/event-stream",
        description:
          "Server-Sent Events: real-time events from all cameras. Each event is a 'data: {...}\\n\\n' line.",
        curlExample: `curl -N -H "Authorization: Bearer YOUR_TOKEN" "${url}"`,
      };
    }),

  getStreamInfo: publicProcedure
    .meta({
      description:
        "NDJSON stream endpoint info for testing: GET /api/events/stream",
    })
    .input(z.object({}).optional())
    .query(({ ctx }) => {
      const base = getBaseUrl(ctx.req);
      const url = `${base}/api/events/stream`;
      return {
        url,
        method: "GET",
        contentType: "application/x-ndjson",
        description:
          "NDJSON stream: one JSON event per line. Same payload as SSE.",
        curlExample: `curl -N -H "Authorization: Bearer YOUR_TOKEN" "${url}"`,
      };
    }),
});
