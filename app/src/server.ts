import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTrpcPanel } from "trpc-panel";
import { WebSocket, WebSocketServer } from "ws";
import { appLogger, logEmitter, LogEntry, getRecentLogs } from "./logger.js";
import { appRouter } from "./router.js";
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
const PORT = process.env.PORT || settings.serverPort || 3000;

// WebSocket server for real-time logs
const wss = new WebSocketServer({ server, path: "/ws/logs" });

wss.on("connection", (ws) => {
  appLogger.debug("WebSocket client connected", { source: "server" });

  // Send historical logs on connect
  const historicalLogs = getRecentLogs(500);
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
        const olderLogs = getRecentLogs(100, msg.before);
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

// Serve static files for the dashboard
// Prefer built frontend assets (dist/public) if present.
// - Dev: you can use Vite (`npm run dev`) which serves the React UI separately.
// - Prod/start: `npm run build` generates dist/public.
const distPublicPath = path.resolve(__dirname, "public");
const hasBuiltUi = fs.existsSync(path.join(distPublicPath, "index.html"));
const publicPath = distPublicPath;

console.log(`[Server] cwd: ${process.cwd()}`);
console.log(`[Server] __dirname: ${__dirname}`);
console.log(`[Server] publicPath: ${publicPath}`);
if (hasBuiltUi) {
  app.use("/static", express.static(publicPath));
  appLogger.info(`Serving static files from: ${publicPath}`, {
    source: "server",
  });
} else {
  appLogger.warn(
    `Built UI not found at ${path.join(publicPath, "index.html")}. Use "npm run dev" (open http://localhost:5173) or run "npm run build" before "npm start".`,
    { source: "server" },
  );
}

// tRPC API endpoint
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
  }),
);

// tRPC Panel UI (Docs section)
app.use("/docs", (req, res) => {
  res.send(
    renderTrpcPanel(appRouter, {
      url: `http://localhost:${PORT}/api/trpc`,
    }),
  );
});

// Legacy panel route redirect
app.use("/panel", (req, res) => {
  res.redirect("/docs");
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Native MJPEG streaming endpoint for browser preview
// Uses native Baichuan protocol directly (bypasses RTSP)
// Path: /api/stream/:cameraName/:profile (cameraName is sanitized name like "living_room")
app.get("/api/stream/:cameraName/:profile", async (req, res) => {
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
});

// Stop MJPEG stream endpoint (legacy - streams now auto-stop when no clients)
app.delete("/api/stream/:cameraId/:profile", (req, res) => {
  res.json({ success: true, message: "Streams auto-stop when no clients" });
});

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
        Dev: run <code>npm run dev</code> and open <a href="http://localhost:5173">http://localhost:5173</a>.
      </p>
      <p>
        Prod: run <code>npm run build</code> then <code>npm start</code>.
      </p>
      <p>
        API docs: <a href="/docs">/docs</a>
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
    req.path.startsWith("/docs") ||
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

  const proxyPort = settings.rtspProxyPort || 8554;
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              Nodelink.js Manager - RTSP Dashboard                ║
╠═══════════════════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${String(PORT).padEnd(5)}                          ║
║  API Docs:   http://localhost:${String(PORT).padEnd(5)}/docs                     ║
║  tRPC API:   http://localhost:${String(PORT).padEnd(5)}/api/trpc                 ║
║  WS Logs:    ws://localhost:${String(PORT).padEnd(5)}/ws/logs                    ║
╠═══════════════════════════════════════════════════════════════╣
║  RTSP:       rtsp://localhost:${String(proxyPort).padEnd(5)}/<camera>/<profile>     ║
║  MJPEG:      http://localhost:${String(PORT).padEnd(5)}/api/stream/<cam>/<prof>  ║
║  WebRTC:     POST /api/webrtc/session (signaling endpoint)    ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  // Log MJPEG endpoint info
  appLogger.info(`MJPEG streaming available on port ${PORT}`, {
    source: "mjpeg",
  });
  appLogger.info(
    `Access streams via: http://<host>:${PORT}/api/stream/<camera-name>/<profile>`,
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
      appLogger.info(`RTSP Proxy started on port ${proxyPort}`, {
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
