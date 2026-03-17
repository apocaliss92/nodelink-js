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
  enableGo2rtcAutoStreams,
} from "./rtsp-manager.js";
import { startRtspProxy, stopRtspProxy } from "./rtsp-proxy.js";
import { getSettings, loadSettings, getConfig } from "./settings-store.js";
// Custom MJPEG/HLS/WebRTC servers removed — go2rtc provides all output formats.
// Legacy modules (mjpeg-native, hls-native, webrtc-native, stream-pool) are still
// on disk but no longer wired into the server.
import {
  initEventsManager,
  addSseClient,
  addJsonStreamClient,
  getEventsManagerStatus,
  connectMqtt,
  disconnectMqtt,
} from "./events-manager.js";
import { initGo2rtc, stopGo2rtc, getGo2rtcManager } from "./go2rtc-manager.js";
import {
  initHomeAssistantMqtt,
  updateHomeAssistantPolling,
} from "./homeassistant-mqtt.js";
import { inferGithubRepoSlug } from "./github-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load settings first
loadSettings();
const settings = getSettings();

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const RTSP_PORT = Number(process.env.RTSP_PORT) || 8554;

type UpdateCheckResult = {
  currentVersion: string | null;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  error?: string;
};

let updatesCache:
  | {
      expiresAtMs: number;
      etag?: string;
      value?: UpdateCheckResult;
    }
  | undefined;

function parseSemver(
  v: string,
): { major: number; minor: number; patch: number } | null {
  const m = String(v)
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function readLocalAppVersion(): string | null {
  if (process.env.APP_VERSION && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim();
  }

  const candidates = [
    path.resolve(process.cwd(), "package.json"),
    path.resolve(process.cwd(), "app/package.json"),
    path.resolve(process.cwd(), "../package.json"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (
        parsed?.name === "nodelink-manager" &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    } catch {
      // ignore
    }
  }

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // ignore
    }
  }

  return null;
}

async function fetchLatestGithubRelease(
  repo: string,
  etag?: string,
): Promise<{
  status: number;
  etag?: string;
  json?: any;
}> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "nodelink-manager",
  };

  if (etag) headers["If-None-Match"] = etag;

  const token = process.env.GITHUB_API_TOKEN || process.env.GITHUB_TOKEN;
  if (token && token.trim()) headers.Authorization = `Bearer ${token.trim()}`;

  const res = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers,
    },
  );

  const newEtag = res.headers.get("etag") ?? undefined;
  if (res.status === 304) return { status: 304, etag: newEtag };
  if (!res.ok) return { status: res.status, etag: newEtag };
  const json = await res.json();
  return { status: res.status, etag: newEtag, json };
}

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

// Update check (GitHub Releases)
app.get("/api/updates", async (req, res) => {
  const force = String(req.query.force ?? "").trim() === "1";
  const ttlMs = Number(process.env.UPDATE_CHECK_TTL_MS) || 6 * 60 * 60 * 1000;
  const nowMs = Date.now();

  if (!force && updatesCache?.value && updatesCache.expiresAtMs > nowMs) {
    res.json(updatesCache.value);
    return;
  }

  const currentVersion = readLocalAppVersion();
  const repo = inferGithubRepoSlug();
  if (!repo) {
    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion: null,
      latestTag: null,
      releaseUrl: null,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      error: "GitHub repo not configured (set UPDATE_REPO=owner/repo)",
    };
    updatesCache = {
      value: result,
      expiresAtMs: nowMs + Math.min(ttlMs, 60_000),
    };
    res.json(result);
    return;
  }

  try {
    const r = await fetchLatestGithubRelease(repo, updatesCache?.etag);

    if (r.status === 304 && updatesCache?.value) {
      updatesCache = {
        ...updatesCache,
        etag: r.etag ?? updatesCache.etag,
        expiresAtMs: nowMs + ttlMs,
      };
      res.json(updatesCache.value);
      return;
    }

    if (r.status < 200 || r.status >= 300 || !r.json) {
      const result: UpdateCheckResult = {
        currentVersion,
        latestVersion: updatesCache?.value?.latestVersion ?? null,
        latestTag: updatesCache?.value?.latestTag ?? null,
        releaseUrl: updatesCache?.value?.releaseUrl ?? null,
        updateAvailable: updatesCache?.value?.updateAvailable ?? false,
        checkedAt: new Date().toISOString(),
        error: `GitHub API error (HTTP ${r.status})`,
      };

      updatesCache = {
        value: result,
        etag: r.etag ?? updatesCache?.etag,
        expiresAtMs: nowMs + Math.min(ttlMs, 60_000),
      };
      res.json(result);
      return;
    }

    const latestTag =
      typeof r.json.tag_name === "string" ? r.json.tag_name : null;
    const latestVersion = latestTag
      ? latestTag.replace(/^v/i, "")
      : typeof r.json.name === "string"
        ? String(r.json.name).trim().replace(/^v/i, "")
        : null;
    const releaseUrl =
      typeof r.json.html_url === "string" ? r.json.html_url : null;

    const updateAvailable =
      !!(currentVersion && latestVersion) &&
      compareSemver(latestVersion, currentVersion) > 0;

    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion,
      latestTag,
      releaseUrl,
      updateAvailable,
      checkedAt: new Date().toISOString(),
    };

    updatesCache = {
      value: result,
      etag: r.etag,
      expiresAtMs: nowMs + ttlMs,
    };

    res.json(result);
  } catch (e) {
    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion: updatesCache?.value?.latestVersion ?? null,
      latestTag: updatesCache?.value?.latestTag ?? null,
      releaseUrl: updatesCache?.value?.releaseUrl ?? null,
      updateAvailable: updatesCache?.value?.updateAvailable ?? false,
      checkedAt: new Date().toISOString(),
      error: String(e),
    };
    updatesCache = {
      value: result,
      etag: updatesCache?.etag,
      expiresAtMs: nowMs + Math.min(ttlMs, 60_000),
    };
    res.json(result);
  }
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

// MJPEG/HLS/WebRTC streaming endpoints removed — go2rtc provides all output
// formats via the /go2rtc/ proxy (WebRTC, HLS, MJPEG, RTSP, snapshots).

// ============================================================================
// Events Endpoints (SSE, JSON stream, MQTT)
// ============================================================================

// SSE: Server-Sent Events - real-time events from all cameras
// GET /api/events/sse
app.get("/api/events/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx
  res.flushHeaders();

  addSseClient(res);

  // Keep-alive every 30s
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n");
    }
  }, 30000);

  req.on("close", () => clearInterval(keepAlive));
});

// JSON stream (NDJSON): one event per line
// GET /api/events/stream
app.get("/api/events/stream", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  addJsonStreamClient(res);
});

// Events status
app.get("/api/events/status", (req, res) => {
  res.json(getEventsManagerStatus());
});

// HLS/WebRTC/MJPEG endpoints removed — go2rtc handles all output formats.

// ---- go2rtc API/UI proxy ----
// Proxies /go2rtc/* to the local go2rtc API so the go2rtc web dashboard and
// API endpoints (streams, WebRTC, HLS, MJPEG, snapshots) are accessible
// through the main app server.
app.use("/go2rtc", async (req, res) => {
  const mgr = getGo2rtcManager();
  if (!mgr?.isRunning) {
    res.status(503).json({ error: "go2rtc is not running" });
    return;
  }
  try {
    const targetUrl = `${mgr.apiUrl}${req.url}`;
    const headers: Record<string, string> = {};
    if (req.headers["content-type"]) {
      headers["content-type"] = req.headers["content-type"] as string;
    }

    const fetchInit: RequestInit = {
      method: req.method,
      headers,
    };

    // Forward body for non-GET methods
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Read raw body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      if (chunks.length > 0) {
        fetchInit.body = Buffer.concat(chunks);
      }
    }

    const upstream = await fetch(targetUrl, fetchInit);

    res.status(upstream.status);
    // Forward response headers
    upstream.headers.forEach((value, key) => {
      // Skip hop-by-hop headers
      if (key === "transfer-encoding" || key === "connection") return;
      res.setHeader(key, value);
    });

    if (upstream.body) {
      const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      const body = await upstream.text();
      res.send(body);
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: `go2rtc proxy error: ${error}` });
    }
  }
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
    req.path.startsWith("/ws") ||
    req.path.startsWith("/go2rtc")
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

  // Stop RTSP proxy (if running in legacy mode)
  try {
    await stopRtspProxy();
  } catch (error) {
    appLogger.error(`Error stopping RTSP proxy: ${error}`, {
      source: "server",
    });
  }

  // Disconnect MQTT
  try {
    await disconnectMqtt();
  } catch (error) {
    appLogger.error(`Error disconnecting MQTT: ${error}`, {
      source: "server",
    });
  }

  await stopAllRtspServers();

  // Stop go2rtc
  try {
    await stopGo2rtc();
  } catch (error) {
    appLogger.error(`Error stopping go2rtc: ${error}`, { source: "server" });
  }

  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prevent the process from crashing on unhandled errors.
// Without these handlers, any unhandled rejection or uncaught exception
// will terminate the Node.js process (and kill the Docker container).
process.on("uncaughtException", (err) => {
  appLogger.error(`Uncaught exception: ${err?.message ?? err}`, {
    source: "server",
  });
  if (err?.stack) {
    appLogger.error(err.stack, { source: "server" });
  }
});

process.on("unhandledRejection", (reason) => {
  const msg =
    reason instanceof Error
      ? reason.message
      : String(reason);
  appLogger.error(`Unhandled rejection: ${msg}`, { source: "server" });
  if (reason instanceof Error && reason.stack) {
    appLogger.error(reason.stack, { source: "server" });
  }
});

// Start server
server.listen(PORT, async () => {
  appLogger.info(`Server started on port ${PORT}`, { source: "server" });

  const go2rtcApiPort = settings.go2rtc?.apiPort ?? 11984;
  const go2rtcRtspPort = settings.go2rtc?.rtspPort ?? 18554;
  const VITE_PORT = 5173;
  appLogger.info(
    `\n╔═══════════════════════════════════════════════════════════════╗\n` +
      `║              Nodelink.js Manager                                 ║\n` +
      `╠═══════════════════════════════════════════════════════════════╣\n` +
      `║  UI (Vite):   http://localhost:${String(VITE_PORT).padEnd(5)}                          ║\n` +
      `║  API Docs:   http://localhost:${String(PORT).padEnd(5)}/docs                     ║\n` +
      `║  tRPC API:   http://localhost:${String(PORT).padEnd(5)}/api/trpc                 ║\n` +
      `╠═══════════════════════════════════════════════════════════════╣\n` +
      `║  go2rtc UI:  http://localhost:${String(PORT).padEnd(5)}/go2rtc/                  ║\n` +
      `║  go2rtc API: http://localhost:${String(go2rtcApiPort).padEnd(5)}                          ║\n` +
      `║  RTSP:       rtsp://localhost:${String(go2rtcRtspPort).padEnd(5)}/<stream_name>       ║\n` +
      `║  Events:     http://localhost:${String(PORT).padEnd(5)}/api/events/sse            ║\n` +
      `╚═══════════════════════════════════════════════════════════════╝\n`,
    { source: "server" },
  );

  // Auto-connect to all configured cameras
  try {
    await autoConnectCameras();
  } catch (error) {
    appLogger.error(`Error auto-connecting cameras: ${error}`, {
      source: "server",
    });
  }

  // Init events manager (SSE, JSON stream, MQTT)
  initEventsManager();
  try {
    await connectMqtt();
  } catch (error) {
    appLogger.error(`Error connecting MQTT: ${error}`, { source: "server" });
  }
  // Init Home Assistant MQTT device discovery
  initHomeAssistantMqtt();

  // Start go2rtc if enabled
  if (settings.go2rtc?.enabled) {
    try {
      await initGo2rtc({
        binaryPath: settings.go2rtc.binaryPath,
        apiPort: settings.go2rtc.apiPort,
        rtspPort: settings.go2rtc.rtspPort,
        webrtcPort: settings.go2rtc.webrtcPort,
        iceServers: settings.go2rtc.iceServers,
      });
      appLogger.info(
        `go2rtc started (API: http://localhost:${settings.go2rtc.apiPort}, RTSP: ${settings.go2rtc.rtspPort})`,
        { source: "go2rtc" },
      );
      // Register listener to auto-start streams when cameras connect on the fly
      enableGo2rtcAutoStreams();
    } catch (error) {
      appLogger.error(`Failed to start go2rtc: ${error}`, {
        source: "go2rtc",
      });
    }
  }

  // When go2rtc is enabled, always auto-start streams (they become Go2rtcTcpServer
  // instances registered with go2rtc — the RTSP proxy is not needed since go2rtc
  // provides its own RTSP/WebRTC/HLS output).
  if (settings.go2rtc?.enabled) {
    try {
      await autoStartRtspServers();
      appLogger.info(
        "Auto-started camera streams via go2rtc (RTSP proxy skipped — go2rtc provides output)",
        { source: "server" },
      );
    } catch (error) {
      appLogger.error(`Error auto-starting go2rtc streams: ${error}`, {
        source: "server",
      });
    }
  } else if (settings.rtspProxyEnabled) {
    // Classic mode: RTSP proxy starts servers on-demand
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
    // No proxy, no go2rtc: auto-start individual RTSP servers
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
