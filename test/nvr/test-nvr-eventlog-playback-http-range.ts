#!/usr/bin/env node
/**
 * Live test (consumer-style):
 * - Pick an event from cmd_id 516/517 event log
 * - Start native Baichuan event playback (Annex-B access units)
 * - Remux on-the-fly to browser-friendly fragmented MP4 (fMP4) using ffmpeg
 * - Serve over HTTP using chunked transfer (no Range required)
 * - As a client, read the first bytes and assert we see MP4 init boxes (ftyp/moov)
 *
 * Env (.env):
 * - NVR_HOST / NVR_USERNAME / NVR_PASSWORD (required)
 * - NVR_UID (optional)
 *
 * Optional behavior:
 * - EVENTLOG_HOURS (default: 6)
 * - EVENTLOG_PAGE_SIZE (default: 60)
 * - EVENTLOG_INDEX (default: 0)
 * - EVENTLOG_PREFERRED_STREAM=mobileStream|subStream (default: mobileStream)
 * - EVENTLOG_CHANNEL_ID (optional filter)
 * - EVENTLOG_REQUIRE_RECFILE (default: true)
 * - EVENTLOG_INPUT_FPS (default: 25) (Annex-B FPS hint for ffmpeg genpts)
 *
 * HTTP:
 * - EVENTLOG_HTTP_PORT (default: 18080)
 * - EVENTLOG_HTTP_PATH (default: /video.mp4)
 */

import "../env.js";

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";

function envBool(v: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((v ?? "").trim());
}

function parseIsoDateOrUndefined(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTerminationSignal(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolve) => {
    const onInt = () => resolve("SIGINT");
    const onTerm = () => resolve("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
  });
}

function listTopLevelMp4Boxes(buf: Buffer): string[] {
  // Extremely small MP4 box parser just for sanity checks.
  // Parses: [size:4][type:4]... (supports 32-bit sizes only).
  const out: string[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (!Number.isFinite(size) || size < 8) break;
    out.push(type);
    off += size;
  }
  return out;
}

async function consumeFmp4OverHttp(params: {
  url: string;
  signal: AbortSignal;
  /** Validate we can observe MP4 init boxes (ftyp/moov). */
  validateInit: boolean;
  /**
   * Keep reading the response body for this duration.
   * - 0 => read until aborted via signal
   */
  keepReadingMs: number;
}): Promise<void> {
  const r = await fetch(params.url, { signal: params.signal });
  if (r.status !== 200) throw new Error(`Unexpected status: ${r.status}`);

  const reader = r.body?.getReader();
  if (!reader) throw new Error("Response body is not a readable stream");

  let buf = Buffer.alloc(0);
  const MAX_READ = 256 * 1024;
  let validated = !params.validateInit;

  const until = params.keepReadingMs > 0 ? Date.now() + params.keepReadingMs : undefined;

  while (!params.signal.aborted) {
    if (until !== undefined && Date.now() >= until) break;

    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (!validated) {
      if (buf.length < MAX_READ) {
        buf = Buffer.concat([buf, Buffer.from(value)]);
      }
      const boxes = listTopLevelMp4Boxes(buf);
      if (boxes.includes("ftyp") && boxes.includes("moov")) {
        validated = true;
        console.log(`[Client] OK: saw boxes=${boxes.slice(0, 8).join(",")} bytes=${buf.length}`);
        if (params.keepReadingMs <= 0) {
          // In non-keep mode we can stop once validated.
          break;
        }
        // In keep mode, continue reading but keep memory bounded.
        buf = buf.subarray(0, Math.min(buf.length, 64 * 1024));
      } else if (buf.length >= MAX_READ) {
        throw new Error(
          `Did not observe fMP4 init boxes within ${MAX_READ} bytes (boxes=${boxes.join(",") || "<none>"})`,
        );
      }
    }
  }

  if (params.validateInit && !validated) {
    const boxes = listTopLevelMp4Boxes(buf);
    throw new Error(`Did not observe fMP4 init boxes (boxes=${boxes.join(",") || "<none>"})`);
  }
}

async function writeTo(res: http.ServerResponse, chunk: Buffer): Promise<void> {
  if (!res.write(chunk)) {
    await once(res, "drain");
  }
}

async function writeToWritable(w: Writable, chunk: Buffer): Promise<void> {
  if (!w.write(chunk)) {
    await once(w, "drain");
  }
}

function safeFileComponent(s: string): string {
  return (s ?? "")
    .trim()
    .replace(/[:\\/]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 120);
}

async function waitForChannelPushCache(api: ReolinkBaichuanApi, timeoutMs = 6_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = api.getChannelInfoFromPushCache();
    if (m.size > 0) return;
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const host = config.nvr.host;
  const username = config.nvr.username;
  const password = config.nvr.password;
  const uid = config.nvr.uid;

  if (!host || !username || !password) {
    throw new Error("Missing NVR_HOST/NVR_USERNAME/NVR_PASSWORD in .env");
  }

  const startIso = parseIsoDateOrUndefined(process.env.EVENTLOG_START_ISO);
  const endIso = parseIsoDateOrUndefined(process.env.EVENTLOG_END_ISO);
  const hours = Number.parseFloat((process.env.EVENTLOG_HOURS ?? "6").trim());
  const pageSize = Number.parseInt((process.env.EVENTLOG_PAGE_SIZE ?? "60").trim(), 10);

  const now = new Date();
  const end = endIso ?? now;
  const start = startIso ?? new Date(now.getTime() - (Number.isFinite(hours) ? hours : 6) * 3600_000);

  const index = Math.max(0, Number.parseInt((process.env.EVENTLOG_INDEX ?? "0").trim(), 10) || 0);
  const preferredStream = ((process.env.EVENTLOG_PREFERRED_STREAM ?? "mobileStream").trim() || "mobileStream") as
    | "mobileStream"
    | "subStream";

  const channelIdRaw = (process.env.EVENTLOG_CHANNEL_ID ?? "").trim();
  const channelIdFilter = channelIdRaw ? Number.parseInt(channelIdRaw, 10) : undefined;

  const requireHasRecFileRaw = (process.env.EVENTLOG_REQUIRE_RECFILE ?? "").trim().toLowerCase();
  const requireHasRecFile =
    requireHasRecFileRaw === ""
      ? true
      : /^(0|false|no|off)$/.test(requireHasRecFileRaw)
        ? false
        : true;

  fs.mkdirSync(path.resolve(process.cwd(), "test/nvr/exports"), { recursive: true });

  const httpPort = Math.max(1, Number.parseInt((process.env.EVENTLOG_HTTP_PORT ?? "18080").trim(), 10) || 18080);
  const httpPath = (process.env.EVENTLOG_HTTP_PATH ?? "/video.mp4").trim() || "/video.mp4";
  const stayOpen = envBool(process.env.EVENTLOG_STAY_OPEN);
  const keepClientMs = Math.max(
    0,
    Number.parseInt((process.env.EVENTLOG_KEEP_CLIENT_MS ?? "0").trim(), 10) || 0,
  );
  const saveMp4 = envBool(process.env.EVENTLOG_SAVE_MP4) || !!(process.env.EVENTLOG_SAVE_MP4_PATH ?? "").trim();
  const saveMp4PathRaw = (process.env.EVENTLOG_SAVE_MP4_PATH ?? "").trim();
  const saveMp4DurationMs = Math.max(0, Number.parseInt((process.env.EVENTLOG_SAVE_DURATION_MS ?? "0").trim(), 10) || 0);

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid,
    logger: {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      error: console.error,
    },
  });

  try {
    await api.login();
    await waitForChannelPushCache(api);

    // Keep the underlying Baichuan client open while this script is running.
    // This mirrors the streaming behavior where cmd_id=3 (ping) keeps the session alive.
    const wantPermit = stayOpen || keepClientMs > 0;
    const permitHoldMs = stayOpen ? 0 : keepClientMs;
    const releasePermit = wantPermit ? api.client.acquirePermit(permitHoldMs, "test:nvr:eventlog-http-range") : undefined;

    const events = await api.listEventLogs({
      start,
      end,
      pageSize: Number.isFinite(pageSize) ? pageSize : 60,
      ...(Number.isFinite(channelIdFilter as number) ? { channelId: channelIdFilter as number } : {}),
      requireHasRecFile,
    });

    if (events.length === 0) {
      throw new Error("No events returned for the requested window");
    }

    const ev = events[Math.min(index, events.length - 1)]!;
    console.log(`[Event] idx=${index} uid=${ev.uid} channelId=${ev.channelId ?? "?"} start=${ev.startTime.toISOString()} end=${ev.endTime.toISOString()} alarmType=${ev.alarmType ?? ""}`);

    const defaultSavePath = path.resolve(
      process.cwd(),
      "test/nvr/exports",
      `eventlog-stream_${safeFileComponent(ev.uid)}_${safeFileComponent(ev.startTime.toISOString())}.mp4`,
    );
    const saveMp4Path = saveMp4 ? (saveMp4PathRaw || defaultSavePath) : undefined;
    if (saveMp4Path) {
      fs.mkdirSync(path.dirname(saveMp4Path), { recursive: true });
      console.log(`[Save] enabled: ${saveMp4Path} (durationMs=${saveMp4DurationMs || 0})`);
    }

    const inputFps = Math.max(1, Math.trunc(Number.parseInt((process.env.EVENTLOG_INPUT_FPS ?? "25").trim(), 10) || 25));

    const activeHttpHandlers = new Set<Promise<void>>();

    // HTTP server: stream fMP4 (chunked) produced on-the-fly from Annex-B.
    const server = http.createServer(async (req, res) => {
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      activeHttpHandlers.add(done);

      if (!req.url || req.method !== "GET") {
        res.statusCode = 404;
        res.end();
        resolveDone?.();
        activeHttpHandlers.delete(done);
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${httpPort}`);
      if (url.pathname !== httpPath) {
        res.statusCode = 404;
        res.end("Not found");
        resolveDone?.();
        activeHttpHandlers.delete(done);
        return;
      }

      // For a stream we do not support Range: browsers will just progressively download.
      if (req.headers.range) {
        res.statusCode = 416;
        res.setHeader("Accept-Ranges", "none");
        res.end("Range not supported for live stream");
        resolveDone?.();
        activeHttpHandlers.delete(done);
        return;
      }

      const ac = new AbortController();
      const killOnClose = () => ac.abort();
      req.on("close", killOnClose);

      let ffmpeg: ReturnType<typeof spawn> | undefined;
      let stderr = "";
      let fileOut: fs.WriteStream | undefined;
      let fileBytes = 0;
      try {
        const { stream } = await api.createEventPlaybackAnnexBStream({
          event: ev,
          preferredStream,
          signal: ac.signal,
        });

        const it = stream[Symbol.asyncIterator]();
        const first = await it.next();
        if (first.done || !first.value) {
          res.statusCode = 502;
          res.end("Playback stream ended before first access unit");
          return;
        }

        const firstUnit = first.value;
        const inputFormat = firstUnit.videoType === "H265" ? "hevc" : "h264";

        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Cache-Control": "no-cache",
          Connection: "close",
          // Helpful metadata for clients (optional).
          "X-Stream-Container": "fmp4",
          "X-Stream-VideoType": firstUnit.videoType,
          "X-Stream-InputFps": String(inputFps),
        });

        if (saveMp4Path) {
          try {
            fileOut = fs.createWriteStream(saveMp4Path);
          } catch (e: any) {
            // Don't fail streaming if the file can't be created.
            console.warn(`[Save] failed to create file: ${String(e?.message || e)}`);
            fileOut = undefined;
          }
        }

        ffmpeg = spawn(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-r",
            String(inputFps),
            "-fflags",
            "+genpts",
            "-f",
            inputFormat,
            "-i",
            "pipe:0",
            "-an",
            "-sn",
            "-c:v",
            "copy",
            "-movflags",
            "frag_keyframe+empty_moov",
            "-f",
            "mp4",
            "pipe:1",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );

        ffmpeg.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString();
          if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
        });

        const stopAll = () => {
          try {
            if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGKILL");
          } catch {
            // ignore
          }
        };

        req.on("close", stopAll);
        res.on("close", stopAll);
        ac.signal.addEventListener("abort", stopAll, { once: true });

        // Feed ffmpeg stdin with Annex-B access units.
        const writeIn = async (b: Buffer) => {
          if (!ffmpeg?.stdin || ffmpeg.stdin.destroyed) return;
          if (!ffmpeg.stdin.write(b)) await once(ffmpeg.stdin, "drain");
        };

        void (async () => {
          try {
            await writeIn(firstUnit.data);
            for await (const u of {
              [Symbol.asyncIterator]() {
                return it;
              },
            } as AsyncIterable<typeof firstUnit>) {
              if (ac.signal.aborted) break;
              await writeIn(u.data);
            }
          } catch {
            // ignore, we'll end via close/abort
          } finally {
            try {
              ffmpeg?.stdin?.end();
            } catch {
              // ignore
            }
          }
        })();

        // Stream bytes to the browser using chunked transfer.
        const ffOut = ffmpeg.stdout;
        if (!ffOut) throw new Error("ffmpeg stdout is not available");
        for await (const chunk of ffOut) {
          if (ac.signal.aborted) break;
          const b = chunk as Buffer;
          if (fileOut) {
            fileBytes += b.length;
            await writeToWritable(fileOut, b);
          }
          await writeTo(res, b);
        }

        res.end();

        if (fileOut) {
          try {
            fileOut.end();
            await once(fileOut, "close");
            console.log(`[Save] wrote ${fileBytes} bytes to ${saveMp4Path}`);
          } catch {
            // ignore
          }
        }
        return;
      } catch (e: any) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain");
        }
        res.end(`Stream error: ${String(e?.message || e)}${stderr ? `\nffmpeg: ${stderr.trim()}` : ""}`);
      } finally {
        try {
          req.off("close", killOnClose);
        } catch {
          // ignore
        }
        try {
          if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGKILL");
        } catch {
          // ignore
        }

        try {
          fileOut?.end();
        } catch {
          // ignore
        }

        resolveDone?.();
        activeHttpHandlers.delete(done);
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(httpPort, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    const url = `http://127.0.0.1:${httpPort}${httpPath}`;
    console.log(`[HTTP] serving ${url}`);

    // Consumer-style progressive download.
    // - When stayOpen=1 we run the client in background (keeps the stream alive; enables saving to file even without a browser).
    // - Otherwise we run it foreground and exit after validation (+ optional keep duration).
    if (stayOpen) {
      console.log("[HTTP] staying open until SIGINT/SIGTERM (manual mode); starting background client");
      const ac = new AbortController();
      const bg = consumeFmp4OverHttp({
        url,
        signal: ac.signal,
        validateInit: true,
        keepReadingMs: saveMp4DurationMs, // 0 => run until SIGINT/SIGTERM
      });
      await Promise.race([
        (async () => {
          await waitForTerminationSignal();
          ac.abort();
        })(),
        bg,
      ]);
      try {
        ac.abort();
      } catch {
        // ignore
      }
    } else {
      const ac = new AbortController();
      await consumeFmp4OverHttp({
        url,
        signal: ac.signal,
        validateInit: true,
        keepReadingMs: saveMp4DurationMs,
      });
      ac.abort();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Ensure all handler cleanup is complete before closing the API.
    // Otherwise late stop/abort logic can race with api.close() and trigger reconnects.
    await Promise.allSettled(Array.from(activeHttpHandlers));
    console.log("[OK] fMP4 chunked streaming validated (ftyp/moov present)");

    try {
      releasePermit?.();
    } catch {
      // ignore
    }
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
