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
import { getDumpZipPath } from "./routers/cameras.js";
import { appRouter } from "./router.js";
import {
  buildSanitizedExport as buildSanitizedCaptureExport,
  buildRedactedPcap,
  getSavedCaptureSanitizedPath,
  getSavedCaptureRawPcapPath,
} from "./capture-manager.js";
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
  enableAutoStreamsOnConnect,
  startStreamsForAllConnectedCameras,
  startReconnectWatchdog,
  stopReconnectWatchdog,
  ensureLocalRtspMux,
  getConnLogs,
  connLogEmitter,
  getOrCreateApiConnection,
} from "./rtsp-manager.js";
import { getSettings, loadSettings, getConfig } from "./settings-store.js";
// go2rtc provides the primary streaming pipeline (WebRTC, HLS, MJPEG, RTSP).
// The native modules (mjpeg-native, hls-native, webrtc-native, stream-pool)
// stay on disk as fallbacks. webrtc-native is now exposed via the `webrtc`
// tRPC router so the UI can use it when go2rtc is disabled or unavailable.
import {
  initEventsManager,
  addSseClient,
  addDetectionSseClient,
  addJsonStreamClient,
  getEventsManagerStatus,
  connectMqtt,
  disconnectMqtt,
} from "./events-manager.js";
import { initGo2rtc, stopGo2rtc, getGo2rtcManager } from "./go2rtc-manager.js";
import {
  startEmailPushServer,
  stopEmailPushServer,
  setEmailPushCameraResolver,
} from "./email-push-server.js";
import { stopAllWebRTCSessions } from "./webrtc-native.js";
import { getActiveSessions } from "./stream-diagnostic.js";
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

// go2rtc same-origin proxy. Required for browsers loading the dashboard over
// HTTPS (reverse proxy with SSL): go2rtc only speaks plain HTTP, so a direct
// `https://host:11984/api/webrtc` request from the page errors out with
// ERR_SSL_PROTOCOL_ERROR. Routing through `/go2rtc/*` here lets the server
// forward the request to go2rtc on loopback while the browser sees a
// same-origin URL.
//
// Issue #11 (David Berdik): WebRTC failed for all cameras when the dashboard
// was reverse-proxied over HTTPS because this proxy was missing — the client
// in `WebRTCInlinePlayer.tsx` sends WHEP signaling to `/go2rtc/api/webrtc?...`
// which previously returned 404 from the SPA fallback handler.
//
// Mounted BEFORE express.json() so the raw request body (WHEP SDP offers,
// arbitrary JSON config payloads) is still readable as a stream.
app.use("/go2rtc", (req, res) => {
  const manager = getGo2rtcManager();
  if (!manager || !manager.isRunning) {
    res.status(503).type("text/plain").send("go2rtc not available");
    return;
  }

  // Express strips the mount prefix, so `req.url` here is the path *under*
  // /go2rtc (e.g. "/api/webrtc?src=foo"). Default to "/" for a bare
  // /go2rtc request so the user lands on the go2rtc UI root.
  const targetPath = req.url || "/";
  const upstreamUrl = new URL(targetPath, manager.apiUrl);

  const forwardedHeaders: http.OutgoingHttpHeaders = { ...req.headers };
  forwardedHeaders.host = upstreamUrl.host;
  delete forwardedHeaders["connection"];
  delete forwardedHeaders["keep-alive"];
  delete forwardedHeaders["transfer-encoding"];
  delete forwardedHeaders["upgrade"];

  const upstream = http.request(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: req.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: forwardedHeaders,
    },
    (upRes) => {
      res.status(upRes.statusCode ?? 502);
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue;
        if (name.toLowerCase() === "transfer-encoding") continue;
        res.setHeader(name, value as string | string[]);
      }
      upRes.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res
        .status(502)
        .type("text/plain")
        .send(`go2rtc upstream error: ${err.message}`);
    } else {
      res.destroy();
    }
  });

  req.pipe(upstream);
});

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

// Download dump zip file by token
app.get("/api/dump/:token", (req, res) => {
  const zipPath = getDumpZipPath(req.params.token);
  if (!zipPath || !fs.existsSync(zipPath)) {
    return res.status(404).json({ error: "Download not found or expired" });
  }
  const filename = path.basename(zipPath);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/zip");
  return res.sendFile(path.resolve(zipPath));
});

// Sanitized capture export (safe to attach to a GitHub issue).
// JSON dump of header fields + redacted body previews. Two paths:
//   1. live capture (still in-memory): rebuild on the fly
//   2. persisted capture (after stop): serve the file from disk
app.get("/api/capture/:id/export", (req, res) => {
  const id = req.params.id as string;
  const savedPath = getSavedCaptureSanitizedPath(id);
  if (savedPath) {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="nodelink-capture_${id}.json"`,
    );
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.sendFile(path.resolve(savedPath));
  }
  const exportData = buildSanitizedCaptureExport(id);
  if (!exportData) {
    return res.status(404).json({ error: "Capture not found" });
  }
  const safeName = (exportData.cameraDisplayName || "capture")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 64);
  const filename = `nodelink-capture_${safeName}_${exportData.captureId}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.send(JSON.stringify(exportData, null, 2));
});

// Redacted raw .pcapng (login bodies wiped, TCP checksums recomputed).
// Includes the challenge nonce and encrypted bodies — fine to share for
// debugging since nothing identifies the user beyond what was on the wire.
app.get("/api/capture/:id/pcap", async (req, res) => {
  const id = req.params.id as string;
  const savedPath = getSavedCaptureRawPcapPath(id);
  if (savedPath) {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="nodelink-capture_${id}.pcapng"`,
    );
    res.setHeader("Content-Type", "application/vnd.tcpdump.pcap");
    return res.sendFile(path.resolve(savedPath));
  }
  try {
    const r = await buildRedactedPcap(id);
    if (!r) {
      return res.status(404).json({ error: "Capture not found" });
    }
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(r.path)}"`,
    );
    res.setHeader("Content-Type", "application/vnd.tcpdump.pcap");
    res.setHeader(
      "X-Nodelink-Redaction",
      `loginFrames=${r.loginFramesRedacted}, bytes=${r.bytesRedacted}`,
    );
    return res.sendFile(path.resolve(r.path));
  } catch (e) {
    return res.status(500).json({
      error: `Failed to redact pcap: ${(e as Error).message}`,
    });
  }
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

// SSE: detection box firehose — fires per video frame on every active stream
// where the camera reports an AI overlay block. Kept on its own endpoint so
// regular SSE consumers don't pay the per-frame bandwidth cost.
// GET /api/events/detection
app.get("/api/events/detection", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  addDetectionSseClient(res);

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n");
    }
  }, 30000);

  req.on("close", () => clearInterval(keepAlive));
});

// SSE: per-camera connection log stream
// GET /api/cameras/:id/logs
app.get("/api/cameras/:id/logs", requireAuth, (req, res) => {
  const cameraId = req.params.id as string;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send buffered history immediately
  const history = getConnLogs(cameraId);
  if (history.length > 0) {
    res.write(`data: ${JSON.stringify({ type: "history", logs: history })}\n\n`);
  }

  const onLog = (entry: import("./rtsp-manager.js").ConnLogEntry) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "log", ...entry })}\n\n`);
    }
  };
  connLogEmitter.on(`log:${cameraId}`, onLog);

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    connLogEmitter.off(`log:${cameraId}`, onLog);
  });
});

// HTTP snapshot: returns a JPEG snapshot from the camera
// GET /api/cameras/:id/snapshot[?channel=<n>]
//
// Useful for ffmpeg, Home Assistant generic_camera, monitoring dashboards,
// etc. Reuses the managed Baichuan API connection (no extra login per call).
// For NVR/Hub children, the channel is taken from the camera config (or the
// optional `channel` query param). Returns 502 if the connection is not
// available, 404 if the camera id is unknown.
app.get("/api/cameras/:id/snapshot", async (req, res) => {
  const cameraId = req.params.id as string;
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) {
    res.status(404).json({ error: "Camera not found" });
    return;
  }

  // Optional channel override (e.g. NVR with multiple feeds on one connection)
  let channel: number | undefined;
  const channelParam = req.query.channel;
  if (typeof channelParam === "string" && channelParam.trim().length > 0) {
    const parsed = Number(channelParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      res.status(400).json({ error: "Invalid channel" });
      return;
    }
    channel = parsed;
  } else {
    channel = camera.rtspChannel ?? 0;
  }

  try {
    const api = await getOrCreateApiConnection(cameraId);
    const buffer = await api.getSnapshot(channel);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Content-Length", String(buffer.length));
    res.status(200).end(buffer);
  } catch (error) {
    const message =
      (error as { message?: string })?.message ?? String(error);
    appLogger.warn(`Snapshot failed for ${cameraId}: ${message}`, {
      source: "server",
    });
    res.status(502).json({ error: message });
  }
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

// go2rtc same-origin proxy is mounted earlier (right after cors() and BEFORE
// express.json()) so request bodies (WHEP SDP, JSON config writes) remain
// pipeable. See the `/go2rtc` proxy near the top of this file for details.

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

  // Disconnect MQTT
  try {
    await disconnectMqtt();
  } catch (error) {
    appLogger.error(`Error disconnecting MQTT: ${error}`, {
      source: "server",
    });
  }

  // Stop all diagnostic sessions (kills ffmpeg processes)
  try {
    const sessions = getActiveSessions();
    if (sessions.size > 0) {
      appLogger.info(
        `Stopping ${sessions.size} active diagnostic session(s)`,
        { source: "server" },
      );
      await Promise.allSettled(
        Array.from(sessions.values()).map((s) => s.stop()),
      );
    }
  } catch (error) {
    appLogger.error(`Error stopping diagnostic sessions: ${error}`, {
      source: "server",
    });
  }

  stopReconnectWatchdog();

  await stopAllRtspServers();

  // Stop native WebRTC sessions (fallback path; harmless if none active).
  try {
    await stopAllWebRTCSessions();
  } catch (error) {
    appLogger.error(`Error stopping native WebRTC sessions: ${error}`, {
      source: "server",
    });
  }

  // Stop go2rtc
  try {
    await stopGo2rtc();
  } catch (error) {
    appLogger.error(`Error stopping go2rtc: ${error}`, { source: "server" });
  }

  // Stop email push SMTP server.
  try {
    await stopEmailPushServer();
  } catch (error) {
    appLogger.error(`Error stopping email push server: ${error}`, {
      source: "server",
    });
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
  const VITE_PORT = Number(process.env.VITE_PORT) || 5173;
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

  // Start streams automatically whenever a camera connects (register before any connect)
  enableAutoStreamsOnConnect();

  // Auto-connect to all configured cameras
  try {
    await autoConnectCameras();
  } catch (error) {
    appLogger.error(`Error auto-connecting cameras: ${error}`, {
      source: "server",
    });
  }

  // Init events manager (SSE, JSON stream, MQTT). Wrap in try/catch because
  // a thrown error here used to take down the entire startup sequence,
  // preventing go2rtc from ever starting.
  try {
    initEventsManager();
  } catch (error) {
    appLogger.error(`Error initializing events manager: ${error}`, { source: "server" });
  }
  try {
    await connectMqtt();
  } catch (error) {
    appLogger.error(`Error connecting MQTT: ${error}`, { source: "server" });
  }
  try {
    initHomeAssistantMqtt();
  } catch (error) {
    appLogger.error(`Error initializing Home Assistant MQTT discovery: ${error}`, { source: "server" });
  }

  // Email push (SMTP intake) — used by battery cameras that can't keep a
  // long-lived TCP/ONVIF push subscription. Resolver verifies the cameraId
  // extracted from the recipient (`cam-<id>@<domain>`) belongs to a
  // registered camera; settings are persisted, so changes via the tRPC
  // router survive restarts.
  try {
    setEmailPushCameraResolver((candidate) => {
      const lower = candidate.toLowerCase();
      const match = settings.cameras.find(
        (c) =>
          c.id.toLowerCase() === lower ||
          sanitizeCameraName(c.name).toLowerCase() === lower,
      );
      return match?.id;
    });
    // featureEnabled is the master kill switch — when off the SMTP intake
    // never starts, regardless of the user-facing `enabled` toggle.
    if (settings.emailPush?.featureEnabled && settings.emailPush?.enabled) {
      await startEmailPushServer();
    }
  } catch (error) {
    appLogger.error(`Error initializing email push server: ${error}`, {
      source: "server",
    });
  }

  // Step 1: Start go2rtc when it's the selected restreamer. If the user
  // chose the local (BaichuanRtspServer) restreamer, skip go2rtc entirely —
  // no binary download, no YAML, no sidecar process.
  const restreamerMode = settings.restreamer ?? "go2rtc";
  if (restreamerMode === "go2rtc") {
    try {
      const go2rtcConfig = {
        binaryPath: process.env.GO2RTC_PATH || settings.go2rtc.binaryPath,
        apiPort: Number(process.env.GO2RTC_API_PORT) || settings.go2rtc.apiPort,
        rtspPort: Number(process.env.GO2RTC_RTSP_PORT) || settings.go2rtc.rtspPort,
        webrtcPort: Number(process.env.GO2RTC_WEBRTC_PORT) || settings.go2rtc.webrtcPort,
        iceServers: settings.go2rtc.iceServers,
      };
      await initGo2rtc(go2rtcConfig);
      appLogger.info(
        `go2rtc started (API: http://localhost:${go2rtcConfig.apiPort}, RTSP: ${go2rtcConfig.rtspPort}, WebRTC: ${go2rtcConfig.webrtcPort})`,
        { source: "go2rtc" },
      );
      try {
        await startStreamsForAllConnectedCameras();
        appLogger.info("Started streams for already-connected cameras", {
          source: "go2rtc",
        });
      } catch (flushErr) {
        appLogger.error(`Error starting streams after go2rtc: ${flushErr}`, {
          source: "go2rtc",
        });
      }
    } catch (error) {
      appLogger.error(`Error initializing go2rtc: ${error}`, {
        source: "server",
      });
    }
  } else {
    appLogger.info(
      `Restreamer=${restreamerMode}: go2rtc disabled — using library BaichuanRtspServer (RTSP only, no WebRTC/HLS/MJPEG previews)`,
      { source: "server" },
    );

    // Bring up the single-port RTSP multiplexer BEFORE any camera stream
    // is started. startRtspServer (local branch) registers its path on the
    // mux and assumes the listening socket is already bound.
    try {
      const mux = await ensureLocalRtspMux();
      appLogger.info(
        `LocalRtspMux listening on ${mux.listenHost}:${mux.listenPort}`,
        { source: "server" },
      );
    } catch (muxErr) {
      appLogger.error(
        `Error initializing LocalRtspMux: ${muxErr}. Local streams will fail to start.`,
        { source: "server" },
      );
    }

    try {
      await startStreamsForAllConnectedCameras();
      appLogger.info("Started streams for already-connected cameras", {
        source: "server",
      });
    } catch (flushErr) {
      appLogger.error(`Error starting streams: ${flushErr}`, {
        source: "server",
      });
    }
  }

  // Step 2: Auto-start streams for cameras configured with autoStart.
  try {
    await autoStartRtspServers();
    appLogger.info("Auto-started camera streams", { source: "server" });
  } catch (error) {
    appLogger.error(`Error auto-starting streams: ${error}`, {
      source: "server",
    });
  }

  // Step 3: Start reconnect watchdog so dropped connections (WiFi loss,
  // scheduled reboots) are restored automatically.
  try {
    startReconnectWatchdog();
    appLogger.info("Reconnect watchdog started", { source: "server" });
  } catch (error) {
    appLogger.error(`Error starting reconnect watchdog: ${error}`, {
      source: "server",
    });
  }
});

export { app, server };
