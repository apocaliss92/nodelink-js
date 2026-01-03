#!/usr/bin/env node
/**
 * Integration test: battery-friendly recordings list + local MP4 predownload.
 *
 * Goal:
 * - Wake the camera (battery-safe)
 * - Fetch recordings list
 * - Download/export the first recording locally as MP4 into ./downloads
 *
 * Env:
 * - BATTERY_HOST / BATTERY_USERNAME / BATTERY_PASSWORD (fallback to TCP_HOST/TCP_USERNAME/TCP_PASSWORD)
 * - BATTERY_UID (fallback to TCP_UID) REQUIRED for listRecordings
 * - BATTERY_CHANNEL (default 0)
 * - BATTERY_TRANSPORT: tcp|udp|auto (default tcp)
 * - RECORDINGS_DAYS_BACK (default 2)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

function sanitizeFileName(name: string): string {
  return name
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replaceAll(":", "_")
    .replaceAll("?", "_")
    .replaceAll("*", "_")
    .replaceAll('"', "_")
    .replaceAll("<", "_")
    .replaceAll(">", "_")
    .replaceAll("|", "_");
}

function envOrUndefined(key: string): string | undefined {
  const v = process.env[key];
  const t = v?.trim();
  return t ? t : undefined;
}

async function main() {
  const channel = Number(process.env.BATTERY_CHANNEL ?? "0");

    const transport = (process.env.BATTERY_TRANSPORT as "tcp" | "udp" | "auto" | undefined) ?? "tcp";
    const useUdpDefaults = transport !== "tcp";

  const host = envOrUndefined("BATTERY_HOST") ?? (useUdpDefaults ? config.udp.host : config.tcp.host);
  const username = envOrUndefined("BATTERY_USERNAME") ?? (useUdpDefaults ? config.udp.username : config.tcp.username);
  const password = envOrUndefined("BATTERY_PASSWORD") ?? (useUdpDefaults ? config.udp.password : config.tcp.password);
  const uid = (envOrUndefined("BATTERY_UID") ?? (useUdpDefaults ? config.udp.uid : undefined) ?? envOrUndefined("TCP_UID") ?? "").trim();
    const ffmpegPath = (process.env.FFMPEG_PATH ?? "").trim() || "ffmpeg";

  if (!host) die("Missing BATTERY_HOST/TCP_HOST in .env");
  if (!password) die("Missing BATTERY_PASSWORD/TCP_PASSWORD in .env");
  if (!uid) die("Missing BATTERY_UID (or TCP_UID). Required to fetch recordings list.");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid: transport === "tcp" ? undefined : uid,
    transport,
    debug: (process.env.DEBUG ?? "").trim() === "1",
  });

  await api.login();

  try {
    // Battery-safe: wake before heavy operations.
    await api.wakeUp(channel, { waitAfterWakeMs: 1500, attempts: 3 });

    const end = new Date();

    const hoursBackRaw = envOrUndefined("RECORDINGS_HOURS_BACK") ?? envOrUndefined("BATTERY_HOURS_BACK");
    const daysBackRaw = envOrUndefined("RECORDINGS_DAYS_BACK") ?? "2";

    const hoursBackParsed = hoursBackRaw != null ? Number.parseInt(hoursBackRaw, 10) : NaN;
    const hoursBack = Number.isFinite(hoursBackParsed) && hoursBackParsed > 0 ? hoursBackParsed : undefined;

    const daysBackParsed = Number.parseInt(daysBackRaw, 10);
    const daysBack = Number.isFinite(daysBackParsed) && daysBackParsed > 0 ? daysBackParsed : 2;

    const start = new Date(end);
    if (hoursBack != null) {
      start.setHours(start.getHours() - hoursBack);
    } else {
      // Default behavior (matches other tests): anchor to local midnight to avoid boundary misses.
      start.setDate(start.getDate() - daysBack);
      start.setHours(0, 0, 0, 0);
    }

    console.log("\n=== BATTERY PRE-DOWNLOAD TEST ===");
    console.log(`host: ${host}`);
    console.log(`transport: ${transport}`);
    console.log(`uid: ${uid}`);
    console.log(`channel: ${channel}`);
    console.log(`list window: ${start.toISOString()} -> ${end.toISOString()}`);

    const tryWindows: Array<{ label: string; start: Date }> = [];
    tryWindows.push({ label: "primary", start });

    // If the user asked for an hours-based window (e.g. 4/5 hours ago) but it returns nothing,
    // retry with wider windows. Battery cams can be finicky about indexing.
    if (hoursBack != null) {
      const s24 = new Date(end);
      s24.setHours(s24.getHours() - 24);
      tryWindows.push({ label: "fallback-24h", start: s24 });

      const s48 = new Date(end);
      s48.setHours(s48.getHours() - 48);
      tryWindows.push({ label: "fallback-48h", start: s48 });
    }

    // Always have a final fallback to daysBack anchored at midnight.
    const sDays = new Date(end);
    sDays.setDate(sDays.getDate() - daysBack);
    sDays.setHours(0, 0, 0, 0);
    tryWindows.push({ label: `fallback-${daysBack}d-midnight`, start: sDays });

    let recs: Array<{ fileName: string; startTime?: Date; endTime?: Date }> = [];
    for (const w of tryWindows) {
      console.log(`\nListing recordings (${w.label}): ${w.start.toISOString()} -> ${end.toISOString()}`);

      // Wake before each attempt (battery cams may go back to sleep quickly).
      await api.wakeUp(channel, { waitAfterWakeMs: 1500, attempts: 3 });

      recs = await api.listRecordings({
        channel,
        uid,
        start: w.start,
        end,
        streamType: "mainStream",
        maxIterations: 50,
      });
      if (recs.length) break;
    }

    if (!recs.length) {
      die(
        "No recordings found in the requested window (and fallbacks). Try increasing RECORDINGS_HOURS_BACK or RECORDINGS_DAYS_BACK, or verify the camera has clips accessible via Baichuan/BCUDP.",
      );
    }

    const firstRec = recs[0]!;
    const first = firstRec.fileName;
    console.log(`\nFound ${recs.length} recordings; downloading first:`);
    console.log(`- ${first}`);

    const outDir = join(process.cwd(), "downloads");
    await mkdir(outDir, { recursive: true });

    const base = sanitizeFileName(basename(first) || "recording.mp4");
    const outName = base.toLowerCase().endsWith(".mp4") ? base : `${base}.mp4`;
    let outPath = join(outDir, outName);
    try {
      await stat(outPath);
      // If the file already exists, pick a unique name to avoid collisions.
      const stamp = new Date().toISOString().replaceAll(":", "-");
      outPath = join(outDir, outName.replace(/\.mp4$/i, `_${stamp}.mp4`));
    } catch {
      // doesn't exist
    }

    const screenshotPath = outPath.replace(/\.mp4$/i, "_mid.jpg");

    console.log(`\nSaving to: ${outPath}`);

    await api.predownloadRecordingMp4({
      channel,
      fileName: first,
      outputPath: outPath,
      streamType: "mainStream",
      ensureAwake: true,
      ffmpegPath,
    });

    const st = await stat(outPath);
    if (st.size <= 0) die(`Downloaded file is empty: ${outPath}`);

    // Midpoint screenshot: prefer listing-provided times (often inferred from filename).
    let midpointSeconds = 0;
    if (firstRec.startTime && firstRec.endTime) {
      const ms = firstRec.endTime.getTime() - firstRec.startTime.getTime();
      if (Number.isFinite(ms) && ms > 0) midpointSeconds = Math.max(0, Math.floor(ms / 1000 / 2));
    }

    console.log(`\nGenerating screenshot at ~midpoint: t=${midpointSeconds}s`);
    await api.generateMp4Screenshot({
      inputPath: outPath,
      outputPath: screenshotPath,
      atSeconds: midpointSeconds,
      ffmpegPath,
    });

    const ss = await stat(screenshotPath);
    if (ss.size <= 0) die(`Screenshot file is empty: ${screenshotPath}`);

    console.log(`\n[OK] Downloaded MP4 (${st.size} bytes): ${outPath}`);
    console.log(`[OK] Screenshot (${ss.size} bytes): ${screenshotPath}`);
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
