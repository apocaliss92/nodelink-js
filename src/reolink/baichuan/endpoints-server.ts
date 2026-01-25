import http from "node:http";
import { spawn } from "node:child_process";

import type { BaichuanClientOptions } from "../../client/BaichuanClient";
import type { StreamProfile } from "./types";
import { ReolinkBaichuanApi } from "./ReolinkBaichuanApi";

type NativeVariantParam = "default" | "autotrack" | "telephoto";

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

function parseBoolParam(v: string | null, def: boolean): boolean {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n") return false;
  return def;
}

function parseProfile(v: string | null): StreamProfile {
  const p = (v ?? "sub").trim();
  if (p === "main" || p === "sub" || p === "ext") return p;
  throw new Error("Invalid profile (must be main, sub, or ext)");
}

function parseNativeVariant(v: string | null): NativeVariantParam {
  const s = (v ?? "default").trim().toLowerCase();
  if (s === "" || s === "default") return "default";
  if (s === "autotrack") return "autotrack";
  if (s === "telephoto") return "telephoto";
  throw new Error("Invalid variant (must be default, autotrack, or telephoto)");
}

function parseDateParam(v: string | null): Date {
  if (!v) throw new Error("Missing time");
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new Error("Invalid time (expected ISO string)");
  return d;
}

function parseDateParamNamed(name: string, v: string | null): Date {
  if (!v) throw new Error(`Missing ${name}`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new Error(`Invalid ${name} (expected ISO string)`);
  return d;
}

/**
 * Minimal HTTP server exposing two endpoints:
 * - `GET /stream?channel=0&profile=main` -> returns a local RTSP URL (Baichuan socket -> RTSP)
 * - `GET /download?channel=0&uid=...&fileName=...` -> downloads a recording via Baichuan socket
 */
export function createBaichuanEndpointsServer(
  opts: BaichuanEndpointsServerOptions,
): http.Server {
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
        const variant = parseNativeVariant(u.searchParams.get("variant"));
        if (!Number.isFinite(channel) || channel < 0) {
          res.statusCode = 400;
          res.end("Invalid channel");
          return;
        }

        const key = `${channel}:${profile}:${variant}`;
        const cached = rtspServers.get(key);
        if (cached) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ rtspUrl: cached.url }));
          return;
        }

        const rtsp = await api.createRtspStream(channel, profile, {
          listenHost: rtspListenHost,
          listenPort: 0,
          path: `/stream/${channel}/${profile}${variant === "default" ? "" : `/${variant}`}`,
          ...(variant === "default" ? {} : { variant }),
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
        const timeoutMs = parseIntParam(
          u.searchParams.get("timeoutMs"),
          120_000,
        );

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
        });

        const outName =
          fileName.split("/").filter(Boolean).at(-1) ?? "recording.bin";
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${outName}"`,
        );
        res.setHeader("Content-Length", String(buf.length));
        res.end(buf);
        return;
      }

      if (u.pathname === "/recordings") {
        const channel = parseIntParam(u.searchParams.get("channel"), 0);
        const streamType = (
          u.searchParams.get("streamType") ?? "subStream"
        ).trim();
        const start = parseDateParamNamed("start", u.searchParams.get("start"));
        const end = parseDateParamNamed("end", u.searchParams.get("end"));
        const recordType = (u.searchParams.get("recordType") ?? "").trim();
        const count = parseIntParam(u.searchParams.get("count"), 0);
        const timeoutMs = parseIntParam(
          u.searchParams.get("timeoutMs"),
          30_000,
        );

        if (streamType !== "mainStream" && streamType !== "subStream") {
          res.statusCode = 400;
          res.end("Invalid streamType (must be mainStream or subStream)");
          return;
        }

        let recordings = await api.getVideoclips({
          channel,
          start,
          end,
          streamType: streamType as any,
          ...(recordType ? { recordType } : {}),
          timeoutMs,
        });

        if (count > 0) recordings = recordings.slice(-count);

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            channel,
            streamType,
            start: start.toISOString(),
            end: end.toISOString(),
            recordings,
          }),
        );
        return;
      }

      if (u.pathname === "/vod/stream" || u.pathname === "/vod/download") {
        const channel = parseIntParam(u.searchParams.get("channel"), 0);
        const fileName = (u.searchParams.get("fileName") ?? "").trim();
        const streamType = (
          u.searchParams.get("streamType") ?? "mainStream"
        ).trim();
        const rtspTransport = (
          u.searchParams.get("rtmpTransport") ?? "tcp"
        ).trim();

        if (!fileName) {
          res.statusCode = 400;
          res.end("Missing fileName");
          return;
        }
        if (streamType !== "mainStream" && streamType !== "subStream") {
          res.statusCode = 400;
          res.end("Invalid streamType (must be mainStream or subStream)");
          return;
        }
        if (rtspTransport !== "tcp" && rtspTransport !== "udp") {
          res.statusCode = 400;
          res.end("Invalid rtmpTransport (must be tcp or udp)");
          return;
        }

        const rtmpUrl = await api.getVodRtmpUrl({
          channel,
          fileName,
          streamType: streamType as any,
          ensureEnabled: true,
        });

        const outName =
          fileName.split("/").filter(Boolean).at(-1) ?? "recording.mp4";

        if (u.pathname === "/vod/stream") {
          // Stream-only: RTMP -> MPEG-TS passthrough.
          res.writeHead(200, {
            "Content-Type": "video/mp2t",
            "Cache-Control": "no-cache",
            Connection: "close",
          });

          const ff = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-rtmp_live",
            "live",
            "-i",
            rtmpUrl,
            "-c",
            "copy",
            "-f",
            "mpegts",
            "pipe:1",
          ]);

          ff.stdout.pipe(res);

          const cleanup = () => {
            ff.kill("SIGKILL");
          };
          req.on("close", cleanup);
          res.on("close", cleanup);
          ff.on("close", () => {
            res.end();
          });
          return;
        }

        // Download/export: RTMP -> MP4 (best-effort streamable MP4).
        res.statusCode = 200;
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${outName}"`,
        );
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "close");

        const ff = spawn("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-rtmp_live",
          "live",
          "-i",
          rtmpUrl,
          "-c",
          "copy",
          "-movflags",
          "frag_keyframe+empty_moov",
          "-f",
          "mp4",
          "pipe:1",
        ]);

        ff.stdout.pipe(res);

        const cleanup = () => {
          ff.kill("SIGKILL");
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        ff.on("close", () => {
          res.end();
        });
        return;
      }

      if (u.pathname === "/replay/cover.jpg") {
        const channel = parseIntParam(u.searchParams.get("channel"), 0);
        const time = parseDateParam(u.searchParams.get("time"));
        const snapType = (u.searchParams.get("snapType") ?? "sub").trim();
        const timeoutMs = parseIntParam(
          u.searchParams.get("timeoutMs"),
          30_000,
        );
        const jpegQuality = parseIntParam(u.searchParams.get("jpegQuality"), 2);

        if (snapType !== "main" && snapType !== "sub") {
          res.statusCode = 400;
          res.end("Invalid snapType (must be main or sub)");
          return;
        }

        const { jpeg, snapshot } = await api.snapshotFromPlaybackJpeg({
          channel,
          time,
          snapType: snapType as any,
          timeoutMs,
          jpegQuality,
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Reolink-Encoding", snapshot.encoding);
        res.setHeader("X-Reolink-Frame-Length", String(snapshot.frameLength));
        res.setHeader("Content-Length", String(jpeg.length));
        res.end(jpeg);
        return;
      }

      if (u.pathname === "/replay/stream.mp4") {
        const channel = parseIntParam(u.searchParams.get("channel"), 0);
        const fileName = (u.searchParams.get("fileName") ?? "").trim();

        if (!fileName) {
          res.statusCode = 400;
          res.end("Missing fileName");
          return;
        }

        const { mp4, stop } = await api.createRecordingReplayMp4Stream({
          channel,
          fileName,
        });

        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Cache-Control": "no-cache",
          Connection: "close",
        });
        mp4.pipe(res);

        const cleanup = () => {
          void stop();
          try {
            mp4.destroy();
          } catch {
            // ignore
          }
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        mp4.on("end", () => {
          res.end();
        });
        mp4.on("error", () => {
          res.end();
        });
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
