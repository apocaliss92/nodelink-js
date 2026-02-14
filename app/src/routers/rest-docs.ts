/**
 * REST API documentation router.
 * These procedures appear in the tRPC panel and return the REST API docs.
 * They do not call REST endpoints - they serve as in-panel documentation.
 */
import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import { inferGithubRepoSlug } from "../github-utils.js";

const REST_DOCS = {
  overview: `# Manager REST API

HTTP endpoints for auth, streaming, events, and metrics.
Base URL: http://HOST:3000 (or your configured port)

## Quick reference

| Category | Endpoints |
|---------|-----------|
| Auth | GET /api/auth/config, POST /api/auth/login, POST /api/auth/personal-token |
| Streaming | GET /api/mpeg/:camera/:profile, GET /api/hls/:camera/:profile/playlist.m3u8, POST /api/webrtc/session |
| Events | GET /api/events/sse, GET /api/events/stream, GET /api/events/status |
| System | GET /api/health, GET /api/metrics, GET /api/updates |
`,

  auth: `## Authentication

GET /api/auth/config - Auth config (no auth)
GET /api/auth/me - Current user (Bearer or cookie)
POST /api/auth/login - { username, password }
POST /api/auth/logout
POST /api/auth/personal-token - Generate long-lived token (auth required)
GET /api/auth/personal-token - Get stored token (auth required)
`,

  streaming: `## Streaming

MJPEG: GET /api/mpeg/:cameraName/:profile (?token= for auth)
HLS: GET /api/hls/:cameraName/:profile/playlist.m3u8 (?token= for auth)
WebRTC: POST /api/webrtc/session { cameraName, profile, enableIntercom? }
  POST /api/webrtc/session/:id/answer { sdp, type: "answer" }
  POST /api/webrtc/session/:id/ice { candidate, sdpMid?, sdpMLineIndex? }
  DELETE /api/webrtc/session/:id
`,

  events: `## Events (SSE, JSON stream)

GET /api/events/sse - Server-Sent Events (Content-Type: text/event-stream)
GET /api/events/stream - NDJSON (one JSON per line)
GET /api/events/status - { sseClients, jsonStreamClients, mqttConnected, registeredCameras }

Event payload: { cameraId, cameraName, cameraNameSlug, type, channel, timestamp, timestampIso }
Camera types: motion, doorbell, people, vehicle, animal, face, package, daynight, etc.
System types: camera_connected, camera_disconnected, stream_clients (with streamType, profile, clientCount)
`,

  system: `## System

GET /api/health - { status, timestamp }
GET /api/updates - Update check (?force=1 to bypass cache)
GET /api/metrics - CPU, memory, event loop (admin when auth enabled)
`,
};

export const restDocsRouter = router({
  getOverview: publicProcedure
    .meta({
      description:
        "REST API overview and quick reference. Use HTTP directly, not tRPC.",
    })
    .input(z.void())
    .query(() => ({
      docs: REST_DOCS.overview,
      fullDocsUrl: inferGithubRepoSlug()
        ? `https://github.com/${inferGithubRepoSlug()}/blob/main/documentation/manager-api.md`
        : null,
    })),

  getAuth: publicProcedure
    .meta({
      description: "REST Auth endpoints: /api/auth/*",
    })
    .input(z.void())
    .query(() => ({ docs: REST_DOCS.auth })),

  getStreaming: publicProcedure
    .meta({
      description: "REST Streaming: MJPEG, HLS, WebRTC",
    })
    .input(z.void())
    .query(() => ({ docs: REST_DOCS.streaming })),

  getEvents: publicProcedure
    .meta({
      description: "REST Events: SSE, JSON stream, status",
    })
    .input(z.void())
    .query(() => ({ docs: REST_DOCS.events })),

  getSystem: publicProcedure
    .meta({
      description: "REST System: health, updates, metrics",
    })
    .input(z.void())
    .query(() => ({ docs: REST_DOCS.system })),
});
