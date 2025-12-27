import http from "node:http";
import { spawn } from "node:child_process";
import { buildRtspUrl, type RtspStreamProfile } from "./urls.js";

export type RtspProxyServerOptions = {
  listenPort: number;
  host: string;
  username: string;
  password: string;
  rtspPort?: number;
  /**
   * RTSP transport towards the camera.
   * - `tcp` is often more reliable on LAN
   * - `udp` can reduce latency but is more fragile
   */
  rtspTransport?: "tcp" | "udp";
};

/**
 * Server Node.js minimale che espone:
 * - `GET /stream?channel=0&profile=main`
 *
 * Implementazione: usa `ffmpeg` per leggere RTSP e fare passthrough in MPEG-TS su HTTP.
 * Richiede `ffmpeg` installato nel sistema.
 */
export function createRtspProxyServer(opts: RtspProxyServerOptions): http.Server {
  return http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }
    const u = new URL(req.url, `http://127.0.0.1:${opts.listenPort}`);
    if (u.pathname !== "/stream") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const channel = Number(u.searchParams.get("channel") ?? "0");
    const profile = (u.searchParams.get("profile") ?? "sub") as RtspStreamProfile;
    if (!Number.isFinite(channel) || channel < 0) {
      res.statusCode = 400;
      res.end("Invalid channel");
      return;
    }
    if (profile !== "main" && profile !== "sub" && profile !== "ext") {
      res.statusCode = 400;
      res.end("Invalid profile (must be main, sub, or ext)");
      return;
    }

    const rtspUrl = buildRtspUrl({
      host: opts.host,
      username: opts.username,
      password: opts.password,
      channel,
      stream: profile,
      ...(opts.rtspPort === undefined ? {} : { port: opts.rtspPort }),
    });

    res.writeHead(200, {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache",
      Connection: "close",
    });

    const rtspTransport = opts.rtspTransport ?? "tcp";
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      rtspTransport,
      "-i",
      rtspUrl,
      "-an",
      "-c:v",
      "copy",
      "-f",
      "mpegts",
      "pipe:1",
    ]);

    ff.stdout.pipe(res);
    ff.stderr.on("data", () => {
      // opzionale: log
    });

    const cleanup = () => {
      ff.kill("SIGKILL");
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    ff.on("close", () => {
      res.end();
    });
  });
}

