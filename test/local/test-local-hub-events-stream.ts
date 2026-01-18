#!/usr/bin/env node
/**
 * Local test: HomeHub/NVR events list + thumbnail + clip streaming.
 *
 * Env (from .env via test/env.ts):
 * - NVR_USERNAME / NVR_PASSWORD (required)
 * - NVR_UID (optional, but recommended)
 *
 * Target:
 * - hub: NVR_HOST (from .env via test/env.ts)
 * - channel: 0
 *
 * Optional env:
 * - EVENTS_OUT_DIR (default: .tmp/local-events)
 */

import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

async function writeFileFromAsyncIterable(outPath: string, it: AsyncIterable<Uint8Array>): Promise<number> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const ws = fs.createWriteStream(outPath);

  let total = 0;
  try {
    for await (const chunk of it) {
      total += chunk.byteLength;
      if (!ws.write(chunk)) {
        await new Promise<void>((resolve) => ws.once("drain", resolve));
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve());
      ws.on("error", reject);
    });
  }

  return total;
}

async function main() {
  if (!config.nvr.host) die("Missing NVR_HOST in .env");
  if (!config.nvr.password) die("Missing NVR_PASSWORD in .env");

  const host = config.nvr.host;
  const channelEnv = (process.env.EVENTS_CHANNEL ?? "0").trim().toLowerCase();
  const channel = channelEnv === "all" ? undefined : Number.parseInt(channelEnv, 10);
  if (channelEnv !== "all" && !Number.isFinite(channel as number)) die(`Invalid EVENTS_CHANNEL: ${process.env.EVENTS_CHANNEL}`);
  const outDir = (process.env.EVENTS_OUT_DIR ?? ".tmp/local-events").trim() || ".tmp/local-events";
  const maxChannels = (() => {
    const v = Number.parseInt((process.env.EVENTS_MAX_CHANNELS ?? "16").trim(), 10);
    return Number.isFinite(v) && v > 0 ? v : 16;
  })();

  const fallbackAllChannels = (() => {
    const v = (process.env.EVENTS_FALLBACK_ALL_CHANNELS ?? "1").trim();
    return v === "1" || v.toLowerCase() === "true";
  })();

  const now = new Date();
  const todayStart = startOfLocalDay(now);
  const todayEnd = now;
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStart = startOfLocalDay(y);
  const yesterdayEnd = endOfLocalDay(y);

  const api = new ReolinkBaichuanApi({
    host,
    username: config.nvr.username,
    password: config.nvr.password,
    uid: config.nvr.uid || undefined,
    transport: "tcp",
    debugOptions: {
      general: false,
      traceRecordings: true,
    },
  });

  await api.login();

  console.log("\n=== HUB EVENTS LOCAL TEST ===");
  console.log(`host: ${host}`);
  console.log(`channel: ${channelEnv}`);

  const runDay = async (label: string, start: Date, end: Date) => {
    console.log(`\n--- ${label} ---`);
    console.log(`range: ${start.toISOString()} -> ${end.toISOString()}`);

    let events =
      channelEnv === "all"
        ? await api.listNvrAlarmEventsEnrichedViaBaichuan({ start, end, channels: Array.from({ length: maxChannels }, (_, i) => i) })
        : await api.fetchHubAlarmEvents({ channel: channel as number, start, end });

    if (events.length === 0 && channelEnv !== "all" && fallbackAllChannels) {
      console.log(`events: 0 (channel=${channelEnv}) -> fallback scan all channels 0..${maxChannels - 1}`);
      events = await api.listNvrAlarmEventsEnrichedViaBaichuan({ start, end, channels: Array.from({ length: maxChannels }, (_, i) => i) });
    }

    console.log(`events: ${events.length}`);

    const sorted = [...events].sort((a, b) => a.startTimeMs - b.startTimeMs);
    const first = sorted[0];
    if (!first) {
      console.log("first event: (none)");
      return;
    }

    const t = new Date(first.startTimeMs);
    const eventChannel = first.channel;
    const eventUid = first.uid;
    const eventStartMs = first.startTimeMs;
    const eventDurMs = first.durationMs;

    console.log(
      `first event: ${t.toISOString()} durationMs=${first.durationMs} fileName=${first.fileName} id=${(first as any).id}${first.uid ? ` uid=${first.uid}` : ""}${(first as any).rtmpUrl ? ` rtmpUrl=${(first as any).rtmpUrl}` : ""} channel=${eventChannel}`,
    );

    const baseName = `${label.toLowerCase().replace(/\s+/g, "-")}_ch${eventChannel}_${first.startTimeMs}`;
    const clipPath = path.join(outDir, `${baseName}.mp4`);
    const thumbPath = path.join(outDir, `${baseName}.jpg`);

    // 1) Clip MP4
    // HomeHub alarm-event ids (e.g. 012026...) are NOT valid RTMP VOD paths.
    // On NVR/Hub the reliable way is: prepareNvrVodDownload(start/end) -> returns a VOD filename -> stream via RTMP.
    let clipOk = false;
    try {
      const ffmpegTimeoutMs = (() => {
        const v = Number.parseInt((process.env.EVENTS_FFMPEG_TIMEOUT_MS ?? "120000").trim(), 10);
        return Number.isFinite(v) && v > 0 ? v : 120_000;
      })();

      const ffmpegLoglevel = (process.env.EVENTS_FFMPEG_LOGLEVEL ?? "error").trim() || "error";
      const ffmpegRtmpLive = (process.env.EVENTS_FFMPEG_RTMP_LIVE ?? "recorded").trim() || "recorded";

      const preMs = 2_000;
      const clipTargetSec = Math.min(60, Math.max(12, Math.ceil(eventDurMs / 1000) + 8));

      const clipStart = new Date(eventStartMs - preMs);
      const clipEnd = new Date(clipStart.getTime() + clipTargetSec * 1000);

      const toReolinkTime = (d: Date) => ({
        year: d.getFullYear(),
        mon: d.getMonth() + 1,
        day: d.getDate(),
        hour: d.getHours(),
        min: d.getMinutes(),
        sec: d.getSeconds(),
      });

      const preparedFileName = await api.prepareNvrVodDownload(
        eventChannel,
        toReolinkTime(clipStart),
        toReolinkTime(clipEnd),
        "sub",
      );

      console.log(
        `vod-prepared: start=${clipStart.toISOString()} end=${clipEnd.toISOString()} fileName=${preparedFileName}`,
      );

      const rtmpUrl = await api.getVodRtmpUrl({
        channel: eventChannel,
        fileName: preparedFileName,
        streamType: "subStream",
        ensureEnabled: true,
      });

      const ss = 0;
      const tSec = Math.max(1, (clipEnd.getTime() - clipStart.getTime()) / 1000);

      await mkdir(path.dirname(clipPath), { recursive: true });

      await new Promise<void>((resolve, reject) => {
        const args = [
          "-hide_banner",
          "-nostdin",
          "-loglevel",
          ffmpegLoglevel,
          "-y",
          "-rtmp_live",
          ffmpegRtmpLive,
          "-ss",
          ss.toFixed(3),
          "-t",
          tSec.toFixed(3),
          "-i",
          rtmpUrl,
          "-c",
          "copy",
          "-movflags",
          "frag_keyframe+empty_moov",
          "-f",
          "mp4",
          clipPath,
        ];

        console.log(`ffmpeg: ffmpeg ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);

        const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

        let stderr = "";
        ff.stderr.on("data", (d) => {
          const s = String(d);
          stderr += s;
          process.stderr.write(s);
        });

        const t = setTimeout(() => {
          ff.kill("SIGKILL");
        }, ffmpegTimeoutMs);

        const finalize = (err?: Error) => {
          clearTimeout(t);
          if (err) return reject(err);
          resolve();
        };

        ff.on("close", (code, signal) => {
          if (signal) {
            return finalize(new Error(`ffmpeg killed by signal ${signal} after ${ffmpegTimeoutMs}ms`));
          }
          if (code === 0) return finalize();
          finalize(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        });

        ff.on("error", (e) => finalize(e as Error));
      });

      const st = fs.statSync(clipPath);
      console.log(`clip: ${clipPath} (${st.size} bytes)`);
      clipOk = st.size > 0;
      if (!clipOk) {
        try {
          fs.unlinkSync(clipPath);
        } catch {
          // ignore
        }
        throw new Error("ffmpeg produced an empty file");
      }
    } catch (e) {
      console.warn(`clip: failed (${e instanceof Error ? e.message : String(e)})`);
    }

    // 2) Screenshot JPEG
    // Prefer extracting from MP4 if available (more reliable than CoverPreview on some hub firmwares).
    if (clipOk) {
      try {
        await api.generateMp4Screenshot({ inputPath: clipPath, outputPath: thumbPath, atSeconds: 1 });
        const st = fs.statSync(thumbPath);
        console.log(`thumbnail(from-mp4): ${thumbPath} (${st.size} bytes)`);
      } catch (e) {
        console.warn(`thumbnail(from-mp4): failed (${e instanceof Error ? e.message : String(e)})`);
      }
    } else {
      try {
        const thumb = await api.fetchEventThumbnail({
          channel: eventChannel,
          ...(eventUid ? { uid: eventUid } : {}),
          time: t,
          snapType: "sub",
          format: "jpeg",
          timeoutMs: 5_000,
        });
        await mkdir(path.dirname(thumbPath), { recursive: true });
        fs.writeFileSync(thumbPath, thumb.data);
        console.log(`thumbnail: ${thumbPath} (${thumb.data.length} bytes)`);
      } catch (e) {
        console.warn(`thumbnail: failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  };

  await runDay("Yesterday", yesterdayStart, yesterdayEnd);
  await runDay("Today", todayStart, todayEnd);

  await api.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
