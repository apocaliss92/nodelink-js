import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";
import { ChildProcess, spawn } from "node:child_process";
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
} from "./rtsp-manager.js";
import { getSettings, loadSettings } from "./settings-store.js";

// Track active MJPEG streams for cleanup
const activeMjpegStreams = new Map<string, ChildProcess>();

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
app.use("/static", express.static(path.join(__dirname, "../public")));

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
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// MJPEG streaming endpoint for browser preview
app.get("/api/stream/:cameraId/:profile", (req, res) => {
  const { cameraId, profile } = req.params;
  const streamKey = `${cameraId}:${profile}`;

  // Get RTSP URL for this camera/profile
  const servers = getAllRtspServersInfo();
  const server = servers.find(
    (s) => s.cameraId === cameraId && s.profile === profile,
  );

  if (!server || server.status !== "running" || !server.rtspUrl) {
    res.status(404).json({ error: "Stream not running" });
    return;
  }

  const rtspUrl = server.rtspUrl;
  appLogger.info(
    `Starting MJPEG stream for ${cameraId}/${profile} from ${rtspUrl}`,
    { source: "mjpeg" },
  );

  // Kill existing stream for this key if any
  const existing = activeMjpegStreams.get(streamKey);
  if (existing) {
    existing.kill("SIGTERM");
    activeMjpegStreams.delete(streamKey);
  }

  // Set response headers for MJPEG stream
  res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=frame");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Connection", "close");

  // Start ffmpeg to convert RTSP to MJPEG
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-rtsp_transport",
      "tcp",
      "-i",
      rtspUrl,
      "-f",
      "mjpeg",
      "-q:v",
      "5", // Quality (2-31, lower is better)
      "-r",
      "10", // Frame rate
      "-s",
      "854x480", // Scale to 480p for preview
      "-an", // No audio
      "-",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  activeMjpegStreams.set(streamKey, ffmpeg);

  let buffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xff, 0xd8]); // JPEG start marker
  const EOI = Buffer.from([0xff, 0xd9]); // JPEG end marker

  ffmpeg.stdout?.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Find complete JPEG frames
    let soiIndex = buffer.indexOf(SOI);
    while (soiIndex !== -1) {
      const eoiIndex = buffer.indexOf(EOI, soiIndex + 2);
      if (eoiIndex === -1) break;

      const frame = buffer.subarray(soiIndex, eoiIndex + 2);
      buffer = buffer.subarray(eoiIndex + 2);

      // Write MJPEG frame
      try {
        res.write("--frame\r\n");
        res.write("Content-Type: image/jpeg\r\n");
        res.write(`Content-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write("\r\n");
      } catch (e) {
        // Client disconnected
        ffmpeg.kill("SIGTERM");
        activeMjpegStreams.delete(streamKey);
        return;
      }

      soiIndex = buffer.indexOf(SOI);
    }
  });

  ffmpeg.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes("Error") || msg.includes("error")) {
      appLogger.error(`MJPEG ffmpeg error: ${msg}`, { source: "mjpeg" });
    }
  });

  ffmpeg.on("close", (code) => {
    appLogger.info(`MJPEG stream closed for ${streamKey} with code ${code}`, {
      source: "mjpeg",
    });
    activeMjpegStreams.delete(streamKey);
    if (!res.writableEnded) {
      res.end();
    }
  });

  // Handle client disconnect
  req.on("close", () => {
    appLogger.info(`Client disconnected from MJPEG stream ${streamKey}`, {
      source: "mjpeg",
    });
    ffmpeg.kill("SIGTERM");
    activeMjpegStreams.delete(streamKey);
  });
});

// Stop MJPEG stream endpoint
app.delete("/api/stream/:cameraId/:profile", (req, res) => {
  const { cameraId, profile } = req.params;
  const streamKey = `${cameraId}:${profile}`;

  const ffmpeg = activeMjpegStreams.get(streamKey);
  if (ffmpeg) {
    ffmpeg.kill("SIGTERM");
    activeMjpegStreams.delete(streamKey);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "No active stream" });
  }
});

// Main dashboard - serve static HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Graceful shutdown
async function shutdown() {
  appLogger.info("Shutting down server...", { source: "server" });
  await stopAllRtspServers();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
server.listen(PORT, async () => {
  appLogger.info(`Server started on port ${PORT}`, { source: "server" });
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║          Reolink API Tester & RTSP Manager                ║
╠═══════════════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${String(PORT).padEnd(5)}                      ║
║  API Docs:   http://localhost:${String(PORT).padEnd(5)}/docs                 ║
║  tRPC API:   http://localhost:${String(PORT).padEnd(5)}/api/trpc             ║
║  WS Logs:    ws://localhost:${String(PORT).padEnd(5)}/ws/logs                ║
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

  // Auto-start RTSP servers for streams with autoStart enabled
  try {
    await autoStartRtspServers();
  } catch (error) {
    appLogger.error(`Error auto-starting RTSP servers: ${error}`, {
      source: "server",
    });
  }
});

export { app, server };
