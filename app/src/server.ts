import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTrpcPanel } from "trpc-panel";
import { WebSocket, WebSocketServer } from "ws";
import { appLogger, logEmitter, LogEntry, getRecentLogs } from "./logger.js";
import { appRouter } from "./router.js";
import {
  autoStartRtspServers,
  stopAllRtspServers,
  getAllRtspServersInfo,
  autoConnectCameras,
  startRtspServer,
  getCameraInfo,
} from "./rtsp-manager.js";
import { startRtspProxy, stopRtspProxy } from "./rtsp-proxy.js";
import { getSettings, loadSettings } from "./settings-store.js";
import {
  addMjpegClient,
  stopAllNativeMjpegStreams,
  getNativeMjpegStatus,
} from "./mjpeg-native.js";

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
    } catch (e) {
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
// In Docker: /app/dist and /app/public, so ../public works
// In dev: /app/src and /app/public, so ../public works
const publicPath = path.join(__dirname, "../public");
console.log(`[Server] __dirname: ${__dirname}`);
console.log(`[Server] publicPath: ${publicPath}`);
app.use("/static", express.static(publicPath));
appLogger.info(`Serving static files from: ${publicPath}`, {
  source: "server",
});

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
app.get("/api/stream/:cameraId/:profile", async (req, res) => {
  const { cameraId, profile } = req.params;

  // Validate profile
  if (profile !== "main" && profile !== "sub" && profile !== "ext") {
    res
      .status(400)
      .json({ error: "Invalid profile (must be main, sub, or ext)" });
    return;
  }

  // Check if camera is connected
  const camInfo = getCameraInfo(cameraId);
  if (!camInfo || camInfo.status !== "connected") {
    res.status(404).json({ error: "Camera not connected" });
    return;
  }

  appLogger.info(`Starting native MJPEG stream for ${cameraId}/${profile}`, {
    source: "mjpeg",
  });

  try {
    // Add client to native MJPEG stream
    const { clientId, cleanup } = await addMjpegClient(
      cameraId,
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

// Main dashboard - serve static HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// Favicon
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(publicPath, "favicon.ico"), (err) => {
    if (err) res.status(204).end();
  });
});

// Graceful shutdown
async function shutdown() {
  appLogger.info("Shutting down server...", { source: "server" });

  // Stop native MJPEG streams
  try {
    await stopAllNativeMjpegStreams();
  } catch (error) {
    appLogger.error(`Error stopping MJPEG streams: ${error}`, {
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
╔═══════════════════════════════════════════════════════════╗
║            Nodelink Manager - RTSP Dashboard              ║
╠═══════════════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${String(PORT).padEnd(5)}                      ║
║  API Docs:   http://localhost:${String(PORT).padEnd(5)}/docs                 ║
║  tRPC API:   http://localhost:${String(PORT).padEnd(5)}/api/trpc             ║
║  WS Logs:    ws://localhost:${String(PORT).padEnd(5)}/ws/logs                ║
╠═══════════════════════════════════════════════════════════╣
║  RTSP Proxy: rtsp://localhost:${String(proxyPort).padEnd(5)}/<camera>/<profile> ║
╚═══════════════════════════════════════════════════════════╝
  `);

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
