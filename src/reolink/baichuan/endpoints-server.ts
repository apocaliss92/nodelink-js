import http from "node:http";

import type { BaichuanClientOptions } from "../../client/BaichuanClient";
import type { StreamProfile } from "./types";
import { ReolinkBaichuanApi } from "./ReolinkBaichuanApi";

export type BaichuanEndpointsServerOptions = {
  /** Port to listen on. */
  listenPort: number;
  /** Host to bind to (default: 127.0.0.1). */
  listenHost?: string;

  /** Connection options for Baichuan (host/username/password/transport/etc). */
  baichuan: BaichuanClientOptions;

  /** Where the internal RTSP servers should bind (default: 127.0.0.1). */
  rtspListenHost?: string;
};

function parseIntParam(v: string | null, def: number): number {
  if (v == null) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseProfile(v: string | null): StreamProfile {
  const p = (v ?? "sub").trim();
  if (p === "main" || p === "sub" || p === "ext") return p;
  throw new Error("Invalid profile (must be main, sub, or ext)");
}

/**
 * Minimal HTTP server exposing two endpoints:
 * - `GET /stream?channel=0&profile=main` -> returns a local RTSP URL (Baichuan socket -> RTSP)
 * - `GET /download?channel=0&uid=...&fileName=...` -> downloads a recording via Baichuan socket
 */
export function createBaichuanEndpointsServer(opts: BaichuanEndpointsServerOptions): http.Server {
  const api = new ReolinkBaichuanApi({
    ...opts.baichuan,
  });

  const listenHost = opts.listenHost ?? "127.0.0.1";
  const rtspListenHost = opts.rtspListenHost ?? "127.0.0.1";

  // Cache servers by channel/profile.
  const rtspServers = new Map<string, { url: string }>();

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }

      const u = new URL(req.url, `http://${listenHost}:${opts.listenPort}`);

      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET");
        res.end("Method Not Allowed");
        return;
      }

      if (u.pathname === "/stream") {
        const channel = parseIntParam(u.searchParams.get("channel"), 0);
        const profile = parseProfile(u.searchParams.get("profile"));
        if (!Number.isFinite(channel) || channel < 0) {
          res.statusCode = 400;
          res.end("Invalid channel");
          return;
        }

        const key = `${channel}:${profile}`;
        const cached = rtspServers.get(key);
        if (cached) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ rtspUrl: cached.url }));
          return;
        }

        const rtsp = await api.createRtspStream(channel, profile, {
          listenHost: rtspListenHost,
          listenPort: 0,
          path: `/stream/${channel}/${profile}`,
        });

        const rtspUrl = rtsp.getRtspUrl();
        rtspServers.set(key, { url: rtspUrl });

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ rtspUrl }));
        return;
      }

      if (u.pathname === "/download") {
        const channel = parseIntParam(u.searchParams.get("channel"), 0);
        const uid = (u.searchParams.get("uid") ?? "").trim();
        const fileName = (u.searchParams.get("fileName") ?? "").trim();
        const timeoutMs = parseIntParam(u.searchParams.get("timeoutMs"), 120_000);

        if (!uid) {
          res.statusCode = 400;
          res.end("Missing uid");
          return;
        }
        if (!fileName) {
          res.statusCode = 400;
          res.end("Missing fileName");
          return;
        }

        const buf = await api.downloadRecording({
          channel,
          uid,
          fileName,
          timeoutMs,
          fallbackToHttp: false,
        });

        const outName = fileName.split("/").filter(Boolean).at(-1) ?? "recording.bin";
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
        res.setHeader("Content-Length", String(buf.length));
        res.end(buf);
        return;
      }

      res.statusCode = 404;
      res.end("Not Found");
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end(e instanceof Error ? e.message : String(e));
    }
  });

  // Best-effort cleanup when the server closes.
  server.on("close", () => {
    void api.close().catch(() => undefined);
  });

  return server;
}
