// Load local environment variables from app/.env (if present)
import "dotenv/config";

import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { renderTrpcPanel } from "trpc-panel";
import { WebSocket, WebSocketServer } from "ws";
import { appLogger, logEmitter, LogEntry, getRecentLogs } from "./logger.js";
import { appRouter } from "./router.js";
import {
  getAuthConfig,
  getAuthTokenFromRequest,
  getUserFromRequest,
  createPersonalAuthToken,
  getPersonalAuthTokenForUser,
  revokeAuthToken,
  verifyCredentials,
  setAuthTokenCookie,
  clearAuthTokenCookie,
} from "./auth.js";
import {
  autoStartRtspServers,
  stopAllRtspServers,
  autoConnectCameras,
  getCameraInfo,
  sanitizeCameraName,
} from "./rtsp-manager.js";
import { startRtspProxy, stopRtspProxy } from "./rtsp-proxy.js";
import { getSettings, loadSettings, getConfig } from "./settings-store.js";
import {
  addMjpegClient,
  stopAllNativeMjpegStreams,
  getNativeMjpegStatus,
} from "./mjpeg-native.js";
import { getHlsStatus, readHlsAsset, stopAllHlsStreams } from "./hls-native.js";
import {
  createWebRTCSession,
  handleWebRTCAnswer,
  addIceCandidate,
  closeWebRTCSession,
  getWebRTCStatus,
  stopAllWebRTCSessions,
} from "./webrtc-native.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load settings first
loadSettings();
const settings = getSettings();

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const RTSP_PORT = Number(process.env.RTSP_PORT) || 8554;

let lastCpuUsage = process.cpuUsage();
let lastHrTime = process.hrtime.bigint();
let lastElu = performance.eventLoopUtilization();

// WebSocket server for real-time logs
const wss = new WebSocketServer({ server, path: "/ws/logs" });

wss.on("connection", (ws, req) => {
  if (getAuthConfig().enabled) {
    const user = getUserFromRequest(req);
    if (!user) {
      ws.close(1008, "Unauthorized");
      return;
    }
  }

  appLogger.debug("WebSocket client connected", { source: "server" });

  // Send historical logs on connect
  const historicalLogs = getRecentLogs(500).slice().reverse();
  ws.send(JSON.stringify({ type: "history", logs: historicalLogs }));

  const onLog = (entry: LogEntry) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "log", ...entry }));
    }
  };

  logEmitter.on("log", onLog);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Handle request for more logs (infinite scroll)
      if (msg.type === "loadMore" && typeof msg.before === "number") {
        const olderLogs = getRecentLogs(100, msg.before).slice().reverse();
        ws.send(
          JSON.stringify({ type: "history", logs: olderLogs, append: true }),
        );
      }
    } catch {
      // Ignore invalid messages
    }
  });

  ws.on("close", () => {
    logEmitter.off("log", onLog);
    appLogger.debug("WebSocket client disconnected", { source: "server" });
  });
});

app.use(cors());
app.use(express.json());

const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!getAuthConfig().enabled) return next();

  // Allow health endpoints to remain unauthenticated for container health checks
  if (req.path === "/health") return next();

  const user = getUserFromRequest(req);
  if (!user) {
    // Accept HTTP Basic if provided, but do NOT trigger browser credential prompts.
    // For docs (loaded via iframe) redirect the user to the UI login screen.
    if (req.baseUrl === "/panel") {
      res.redirect(302, "/login");
      return;
    }

    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  return next();
};

// Auth endpoints (session cookie based) - must be before /api auth guard
app.get("/api/auth/config", (req, res) => {
  res.json(getAuthConfig());
});

function isSecureRequest(req: express.Request): boolean {
  const xfProto = req.headers["x-forwarded-proto"];
  const proto =
    typeof xfProto === "string"
      ? xfProto.split(",")[0]?.trim().toLowerCase()
      : Array.isArray(xfProto)
        ? (xfProto[0] ?? "").trim().toLowerCase()
        : "";

  if (proto === "https") return true;
  // TLS terminated directly on this server.
  return (req.socket as any)?.encrypted === true;
}

app.get("/api/auth/me", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // If the client authenticates via Bearer (e.g. token stored in localStorage),
  // also mirror it into a HttpOnly cookie so the /docs (tRPC panel) can call
  // /api/trpc without custom headers.
  const token = getAuthTokenFromRequest(req);
  if (token)
    setAuthTokenCookie(res, token, { isSecureRequest: isSecureRequest(req) });

  res.json({ user });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = (req.body ?? {}) as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: "username and password required" });
    return;
  }

  const user = verifyCredentials({ username, password });
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = createPersonalAuthToken(user);
  setAuthTokenCookie(res, token, { isSecureRequest: isSecureRequest(req) });
  res.json({ user, token });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getAuthTokenFromRequest(req);
  if (token) revokeAuthToken(token);
  clearAuthTokenCookie(res, { isSecureRequest: isSecureRequest(req) });
  res.json({ ok: true });
});

// Generate a long-lived personal token for the currently authenticated user.
// This does NOT revoke session tokens.
app.post("/api/auth/personal-token", requireAuth, (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = createPersonalAuthToken(user);
  setAuthTokenCookie(res, token, { isSecureRequest: isSecureRequest(req) });
  res.json({ token });
});

// Return the stored personal token for the current user (if any).
app.get("/api/auth/personal-token", requireAuth, (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = getPersonalAuthTokenForUser(user);
  if (!token) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json({ token });
});

// Protect all other /api routes
app.use("/api", requireAuth);

// Serve static files for the dashboard
// Prefer built frontend assets (dist/public) if present.
// - Dev: you can use Vite (`npm run dev`) which serves the React UI separately.
// - Prod/start: `npm run build` generates dist/public.
const distPublicPath = path.resolve(__dirname, "public");
const hasBuiltUi = fs.existsSync(path.join(distPublicPath, "index.html"));
const publicPath = distPublicPath;

appLogger.debug(`cwd: ${process.cwd()}`, { source: "server" });
appLogger.debug(`__dirname: ${__dirname}`, { source: "server" });
appLogger.debug(`publicPath: ${publicPath}`, { source: "server" });
if (hasBuiltUi) {
  app.use("/static", express.static(publicPath));
  appLogger.info(`Serving static files from: ${publicPath}`, {
    source: "server",
  });
} else {
  appLogger.warn(
    `Built UI not found at ${path.join(publicPath, "index.html")}. Run "npm run build" before "npm start", or run "npm run dev" to use the separate UI dev server. Server is running on http://localhost:${PORT}.`,
    { source: "server" },
  );
}

// tRPC API endpoint
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: ({ req, res }) => ({
      req,
      res,
      authUser: getUserFromRequest(req),
    }),
  }),
);

// tRPC Panel UI (backend-only). The React app uses /docs and embeds this in an iframe.
app.use("/panel", requireAuth, (req, res) => {
  const forwardedProto = (
    req.headers["x-forwarded-proto"] as string | undefined
  )
    ?.split(",")[0]
    ?.trim();
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || req.headers.host;
  const proto = forwardedProto || "http";

  const url = host ? `${proto}://${host}/api/trpc` : `/api/trpc`;

  res.send(
    renderTrpcPanel(appRouter, {
      url,
    }),
  );
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Resource usage metrics (admin only)
app.get("/api/metrics", (req, res) => {
  if (getAuthConfig().enabled) {
    const user = getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (user.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  const nowCpu = process.cpuUsage();
  const nowHr = process.hrtime.bigint();
  const nowElu = performance.eventLoopUtilization();

  const deltaUserUs = nowCpu.user - lastCpuUsage.user;
  const deltaSystemUs = nowCpu.system - lastCpuUsage.system;
  const deltaWallMs = Number(nowHr - lastHrTime) / 1e6;

  // Percent of a single core over the sampling window.
  const cpuPercent =
    deltaWallMs > 0
      ? ((deltaUserUs + deltaSystemUs) / 1000 / deltaWallMs) * 100
      : null;

  const deltaElu = performance.eventLoopUtilization(nowElu, lastElu);

  lastCpuUsage = nowCpu;
  lastHrTime = nowHr;
  lastElu = nowElu;

  const mem = process.memoryUsage();
  const cpuCount = os.cpus()?.length ?? null;

  res.json({
    timestamp: new Date().toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      cpu: {
        percent: cpuPercent,
        userUs: deltaUserUs,
        systemUs: deltaSystemUs,
        windowMs: deltaWallMs,
      },
      eventLoop: {
        utilization: deltaElu.utilization,
      },
    },
    system: {
      cpuCount,
      loadAvg: os.loadavg(),
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
    },
  });
});

// Native MJPEG streaming endpoint for browser preview
// Uses native Baichuan protocol directly (bypasses RTSP)
// Path: /api/mpeg/:cameraName/:profile (cameraName is sanitized name like "living_room")
// Legacy alias: /api/stream/:cameraName/:profile
const handleMjpegStream = async (
  req: express.Request,
  res: express.Response,
) => {
  const { cameraName, profile } = req.params;

  // Validate profile
  if (profile !== "main" && profile !== "sub" && profile !== "ext") {
    res
      .status(400)
      .json({ error: "Invalid profile (must be main, sub, or ext)" });
    return;
  }

  // Find camera by sanitized name
  const config = getConfig();
  const camera = config.cameras.find(
    (c) => sanitizeCameraName(c.name) === cameraName || c.id === cameraName,
  );

  if (!camera) {
    res.status(404).json({ error: "Camera not found" });
    return;
  }

  // Check if camera is connected
  const camInfo = getCameraInfo(camera.id);
  if (!camInfo || camInfo.status !== "connected") {
    res.status(404).json({ error: "Camera not connected" });
    return;
  }

  appLogger.info(`Starting native MJPEG stream for ${camera.name}/${profile}`, {
    source: "mjpeg",
  });

  try {
    // Add client to native MJPEG stream
    const { clientId, cleanup } = await addMjpegClient(
      camera.id,
      profile as "main" | "sub" | "ext",
      res,
    );

    // Handle client disconnect
    req.on("close", () => {
      appLogger.info(`Client ${clientId} disconnected from MJPEG stream`, {
        source: "mjpeg",
      });
      cleanup();
    });

    res.on("error", () => {
      cleanup();
    });
  } catch (err) {
    appLogger.error(`Failed to start native MJPEG stream: ${err}`, {
      source: "mjpeg",
    });
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start stream" });
    }
  }
};

app.get("/api/mpeg/:cameraName/:profile", handleMjpegStream);
app.get("/api/stream/:cameraName/:profile", handleMjpegStream);

// Stop MJPEG stream endpoint (legacy - streams now auto-stop when no clients)
const handleMjpegStop = (req: express.Request, res: express.Response) => {
  res.json({ success: true, message: "Streams auto-stop when no clients" });
};

app.delete("/api/mpeg/:cameraId/:profile", handleMjpegStop);
app.delete("/api/stream/:cameraId/:profile", handleMjpegStop);

// MJPEG stream status endpoint
app.get("/api/mjpeg/status", (req, res) => {
  const status = getNativeMjpegStatus();
  res.json(status);
});

// ============================================================================
// HLS Endpoints (live preview)
// ============================================================================

// HLS status endpoint
app.get("/api/hls/status", (req, res) => {
  res.json(getHlsStatus());
});

// HLS playlist/segments
// Base URL: /api/hls/:cameraName/:profile/playlist.m3u8
// Segments: /api/hls/:cameraName/:profile/segment_00001.ts
app.get("/api/hls/:cameraName/:profile/:asset", async (req, res) => {
  try {
    const { cameraName, profile, asset } = req.params;

    if (profile !== "main" && profile !== "sub" && profile !== "ext") {
      res
        .status(400)
        .json({ error: "Invalid profile (must be main, sub, or ext)" });
      return;
    }

    const clientKey =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const result = await readHlsAsset({
      cameraNameOrId: cameraName,
      profile: profile as "main" | "sub" | "ext",
      asset,
      clientKey,
    });

    res.status(result.status);
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    res.end(result.body);
  } catch (err) {
    appLogger.error(`Failed to serve HLS: ${err}`, { source: "hls" });
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================================
// WebRTC Endpoints
// ============================================================================

// Create WebRTC session (returns offer SDP)
// POST /api/webrtc/session
// Body: { cameraName: string, profile: "main" | "sub" | "ext", enableIntercom?: boolean }
app.post("/api/webrtc/session", async (req, res) => {
  try {
    const { cameraName, profile, enableIntercom } = req.body;

    if (!cameraName || !profile) {
      res.status(400).json({ error: "cameraName and profile are required" });
      return;
    }

    if (profile !== "main" && profile !== "sub" && profile !== "ext") {
      res
        .status(400)
        .json({ error: "Invalid profile (must be main, sub, or ext)" });
      return;
    }

    const { sessionId, offer } = await createWebRTCSession(
      cameraName,
      profile,
      enableIntercom ?? false,
    );

    res.json({ sessionId, offer });
  } catch (err) {
    appLogger.error(`Failed to create WebRTC session: ${err}`, {
      source: "webrtc",
    });
    res.status(500).json({ error: String(err) });
  }
});

// Handle WebRTC answer (browser response)
// POST /api/webrtc/session/:sessionId/answer
// Body: { sdp: string, type: "answer" }
app.post("/api/webrtc/session/:sessionId/answer", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const answer = req.body;

    if (!answer?.sdp || answer?.type !== "answer") {
      res.status(400).json({ error: "Invalid answer format" });
      return;
    }

    await handleWebRTCAnswer(sessionId, answer);
    res.json({ success: true });
  } catch (err) {
    appLogger.error(`Failed to handle WebRTC answer: ${err}`, {
      source: "webrtc",
    });
    res.status(500).json({ error: String(err) });
  }
});

// Add ICE candidate
// POST /api/webrtc/session/:sessionId/ice
// Body: { candidate: string, sdpMid?: string, sdpMLineIndex?: number }
app.post("/api/webrtc/session/:sessionId/ice", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const candidate = req.body;

    if (!candidate?.candidate) {
      res.status(400).json({ error: "Invalid ICE candidate" });
      return;
    }

    await addIceCandidate(sessionId, candidate);
    res.json({ success: true });
  } catch (err) {
    appLogger.error(`Failed to add ICE candidate: ${err}`, {
      source: "webrtc",
    });
    res.status(500).json({ error: String(err) });
  }
});

// Close WebRTC session
// DELETE /api/webrtc/session/:sessionId
app.delete("/api/webrtc/session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    await closeWebRTCSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    appLogger.error(`Failed to close WebRTC session: ${err}`, {
      source: "webrtc",
    });
    res.status(500).json({ error: String(err) });
  }
});

// Get WebRTC status
app.get("/api/webrtc/status", (req, res) => {
  const status = getWebRTCStatus();
  res.json(status);
});

// Main dashboard - serve static HTML file
app.get("/", (req, res) => {
  if (!hasBuiltUi) {
    res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nodelink Manager</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 24px; }
      code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 6px; }
      .card { max-width: 860px; border: 1px solid rgba(0,0,0,0.12); border-radius: 12px; padding: 18px; }
      a { color: inherit; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>UI not built</h2>
      <p>The React dashboard is not built yet.</p>
      <p>
        Dev: run <code>npm run dev</code> to start the separate UI dev server.
      </p>
      <p>
        Prod: run <code>npm run build</code> then <code>npm start</code>.
      </p>
      <p>
        API docs: <a href="/panel">/panel</a>
      </p>
      <p>
        Server: <a href="http://localhost:${PORT}">http://localhost:${PORT}</a>
      </p>
    </div>
  </body>
</html>`);
    return;
  }

  res.sendFile(path.join(publicPath, "index.html"));
});

// Favicon
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(publicPath, "favicon.ico"), (err) => {
    if (err) res.status(204).end();
  });
});

// SPA fallback (React router)
app.get("*", (req, res, next) => {
  if (req.method !== "GET") return next();
  if (
    req.path.startsWith("/api") ||
    req.path.startsWith("/panel") ||
    req.path.startsWith("/static") ||
    req.path.startsWith("/ws")
  ) {
    return next();
  }

  if (!hasBuiltUi) {
    return res.redirect("/");
  }

  res.sendFile(path.join(publicPath, "index.html"));
});

// Graceful shutdown
async function shutdown() {
  appLogger.info("Shutting down server...", { source: "server" });

  // Stop WebRTC sessions
  try {
    await stopAllWebRTCSessions();
  } catch (error) {
    appLogger.error(`Error stopping WebRTC sessions: ${error}`, {
      source: "server",
    });
  }

  // Stop native MJPEG streams
  try {
    await stopAllNativeMjpegStreams();
  } catch (error) {
    appLogger.error(`Error stopping MJPEG streams: ${error}`, {
      source: "server",
    });
  }

  // Stop HLS streams
  try {
    await stopAllHlsStreams();
  } catch (error) {
    appLogger.error(`Error stopping HLS streams: ${error}`, {
      source: "server",
    });
  }

  // Stop RTSP proxy
  try {
    await stopRtspProxy();
  } catch (error) {
    appLogger.error(`Error stopping RTSP proxy: ${error}`, {
      source: "server",
    });
  }

  await stopAllRtspServers();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
server.listen(PORT, async () => {
  appLogger.info(`Server started on port ${PORT}`, { source: "server" });

  appLogger.info(
    `\n╔═══════════════════════════════════════════════════════════════╗\n` +
      `║              Nodelink.js Manager - RTSP Dashboard                ║\n` +
      `╠═══════════════════════════════════════════════════════════════╣\n` +
      `║  Dashboard:  http://localhost:${String(PORT).padEnd(5)}                          ║\n` +
      `║  API Docs:   http://localhost:${String(PORT).padEnd(5)}/docs                     ║\n` +
      `║  tRPC API:   http://localhost:${String(PORT).padEnd(5)}/api/trpc                 ║\n` +
      `║  WS Logs:    ws://localhost:${String(PORT).padEnd(5)}/ws/logs                    ║\n` +
      `╠═══════════════════════════════════════════════════════════════╣\n` +
      `║  RTSP:       rtsp://localhost:${String(RTSP_PORT).padEnd(5)}/<camera>/<profile>     ║\n` +
      `║  MJPEG:      http://localhost:${String(PORT).padEnd(5)}/api/mpeg/<cam>/<prof>    ║\n` +
      `║  WebRTC:     POST /api/webrtc/session (signaling endpoint)    ║\n` +
      `╚═══════════════════════════════════════════════════════════════╝\n`,
    { source: "server" },
  );

  // Log MJPEG endpoint info
  appLogger.info(`MJPEG streaming available on port ${PORT}`, {
    source: "mjpeg",
  });
  appLogger.info(
    `Access streams via: http://<host>:${PORT}/api/mpeg/<camera-name>/<profile>`,
    { source: "mjpeg" },
  );
  appLogger.info(`MJPEG streams are started on-demand when clients connect`, {
    source: "mjpeg",
  });

  // Log WebRTC endpoint info
  appLogger.info(`WebRTC signaling available on port ${PORT}`, {
    source: "webrtc",
  });
  appLogger.info(
    `Create session via: POST http://<host>:${PORT}/api/webrtc/session`,
    { source: "webrtc" },
  );
  appLogger.info(`WebRTC sessions support bidirectional audio (intercom)`, {
    source: "webrtc",
  });

  // Auto-connect to all configured cameras
  try {
    await autoConnectCameras();
  } catch (error) {
    appLogger.error(`Error auto-connecting cameras: ${error}`, {
      source: "server",
    });
  }

  // Start RTSP proxy if enabled (BEFORE auto-starting servers)
  // When proxy is enabled, servers will be started on-demand by the proxy
  if (settings.rtspProxyEnabled) {
    try {
      await startRtspProxy();
      appLogger.info(`RTSP Proxy started on port ${RTSP_PORT}`, {
        source: "server",
      });
      appLogger.info(`RTSP servers will be started on-demand by the proxy`, {
        source: "server",
      });
    } catch (error) {
      appLogger.error(`Error starting RTSP proxy: ${error}`, {
        source: "server",
      });
    }
  } else {
    // Auto-start RTSP servers only if proxy is NOT enabled
    // (when proxy is enabled, servers start on-demand)
    try {
      await autoStartRtspServers();
    } catch (error) {
      appLogger.error(`Error auto-starting RTSP servers: ${error}`, {
        source: "server",
      });
    }
  }
});

export { app, server };
