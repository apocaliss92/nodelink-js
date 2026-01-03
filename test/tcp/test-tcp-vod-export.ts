#!/usr/bin/env node
/**
 * Test: export/stream a recording via RTMP VOD playback (strategy B).
 *
 * Env:
 * - TCP_HOST / TCP_USERNAME / TCP_PASSWORD (required)
 * - TCP_UID (recommended)
 * - VOD_FILE (optional): recording path (e.g. /mnt/sda/Mp4Record/...mp4). If missing, uses first from listRecordings.
 * - RECORDINGS_DAYS_BACK or VOD_DAYS_BACK (optional, default 2): lookback window when auto-selecting a recording.
 * - VOD_SECONDS (optional, default 5): how many seconds to pull via ffmpeg.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";
import { spawn } from "node:child_process";

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

async function main() {
  if (!config.tcp.host) die("Missing TCP_HOST in .env");
  if (!config.tcp.password) die("Missing TCP_PASSWORD in .env");

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: (process.env.DEBUG ?? "").trim() === "1",
  });

  await api.login();

  try {
    const uid = (process.env.TCP_UID ?? "").trim();
    if (!uid) die("Missing TCP_UID (set it; use test:tcp:recordings to discover)");

    let fileName = (process.env.VOD_FILE ?? "").trim();
    if (!fileName) {
      const end = new Date();

      const daysBackRaw = (process.env.VOD_DAYS_BACK ?? process.env.RECORDINGS_DAYS_BACK ?? "2").trim();
      const daysBackParsed = Number.parseInt(daysBackRaw, 10);
      const baseDays = Number.isFinite(daysBackParsed) && daysBackParsed > 0 ? daysBackParsed : 2;

      const tryDays = Array.from(new Set([baseDays, 7, 14, 30]));

      let recs: Array<{ fileName: string }> = [];
      for (const days of tryDays) {
        const start = new Date(end);
        start.setDate(start.getDate() - days);
        start.setHours(0, 0, 0, 0);

        console.log(`\nListing recordings for VOD export: last ${days} day(s) (${start.toISOString()} -> ${end.toISOString()})`);

        recs = await api.listRecordings({
          channel: 0,
          uid,
          start,
          end,
          streamType: "mainStream",
          maxIterations: 50,
        });

        if (recs.length) break;
      }

      if (!recs.length) {
        die("No recordings found in lookback window. Set VOD_FILE to a known recording path, or increase VOD_DAYS_BACK/RECORDINGS_DAYS_BACK.");
      }

      fileName = recs[0]!.fileName;
    }

    const rtmpUrl = await api.getVodRtmpUrl({
      channel: 0,
      fileName,
      streamType: "mainStream",
      ensureEnabled: true,
    });

    console.log("\n=== VOD EXPORT TEST ===");
    console.log("file:", fileName);
    console.log("rtmp:", rtmpUrl);

    const seconds = Number.parseInt((process.env.VOD_SECONDS ?? "5").trim(), 10);
    const dur = Number.isFinite(seconds) && seconds > 0 ? seconds : 5;

    console.log(`\nPulling ${dur}s via ffmpeg -> /dev/null (sanity check)`);

    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtmp_live",
        "live",
        "-i",
        rtmpUrl,
        "-t",
        String(dur),
        "-c",
        "copy",
        "-f",
        "null",
        "-",
      ]);

      let stderr = "";
      ff.stderr.on("data", (d) => {
        stderr += String(d);
      });

      ff.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
      });

      ff.on("error", reject);
    });
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
