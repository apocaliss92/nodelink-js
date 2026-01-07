#!/usr/bin/env node
/**
 * Test: fetch videoclips from TCP camera using getVideoClips-like API.
 *
 * Env:
 * - TCP_HOST / TCP_USERNAME / TCP_PASSWORD (required)
 * - TCP_UID (optional, used as reference if set)
 * - RECORDINGS_DAYS_BACK (optional, default: 2)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

function extractUidLike(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (typeof v === "string") {
      const s = v.trim();
      // Typical Reolink UID: uppercase alnum, ~16 chars (e.g. 9527000HZ56U1ORU)
      if (/^[0-9A-Z]{12,24}$/.test(s) && /[A-Z]/.test(s)) return s;
      return undefined;
    }
    if (typeof v !== "object") return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const it of v) {
        const r = walk(it);
        if (r) return r;
      }
      return undefined;
    }

    for (const vv of Object.values(v as Record<string, unknown>)) {
      const r = walk(vv);
      if (r) return r;
    }
    return undefined;
  };
  return walk(value);
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

  try {
    await api.login();

    const info = await api.getInfo();
    const serial = info.serialNumber ?? "";

    let uid = (process.env.TCP_UID ?? "").trim();
    if (!uid) {
      // Try to discover via HTTP CGI API.
      try {
        const cgi = new ReolinkCgiApi({
          host: config.tcp.host,
          username: config.tcp.username,
          password: config.tcp.password,
        });
        await cgi.login();

        try {
          const p2p = await cgi.call("GetP2p", {});
          uid = extractUidLike(p2p) ?? uid;
        } catch {
          // ignore
        }

        const devInfo = await cgi.GetDevInfo();
        uid = extractUidLike(devInfo) ?? uid;

        if (!uid) {
          const ch = await cgi.GetChannelstatus();
          uid = extractUidLike(ch) ?? uid;
        }

        await cgi.logout().catch(() => undefined);
      } catch {
        // ignore and fallback
      }
    }

    if (!uid) {
      // Try via Baichuan directly (reolink_aio: cmdId=114 maps to GetP2p).
      try {
        const p2pXml = await api.sendXml({ cmdId: 114, timeoutMs: 10_000 });
        uid = extractUidLike(p2pXml) ?? uid;
      } catch {
        // ignore
      }
    }

    // Last resort: use serialNumber (some firmwares accept it as uid).
    if (!uid) uid = serial.trim();

    console.log("\n=== TCP VIDEOCLIPS TEST ===");
    console.log(`host: ${config.tcp.host}`);
    console.log(`dev serialNumber: ${serial}`);
    console.log(`uid used: ${uid || "(missing)"}`);

    if (!uid) {
      die("No UID available. Set TCP_UID in .env (camera UID) and retry.");
    }

    const end = new Date();
    // const daysBack = Number.parseInt((process.env.RECORDINGS_DAYS_BACK ?? "0").trim(), 10);
    // const days = Number.isFinite(daysBack) && daysBack > 0 ? daysBack : 2;
    const days = 1;
    // Anchor to local midnight to avoid missing recordings near the rolling boundary.
    const start = new Date();
    end.setDate(end.getDate() - days);
    start.setDate(start.getDate() - (days + 1));
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    console.log(`\nFetching videoclips: ${start.toISOString()} -> ${end.toISOString()}`);

    // Use listRecordingsByTime which is what getVideoClips uses internally
    const recordings = await api.listRecordingsByTime({
      channel: 0,
      ...(uid ? { uid } : {}),
      start,
      end,
      streamType: "mainStream",
    });

    console.log(`\nFound ${recordings.length} recordings`);

    // Convert to VideoClip-like format
    const clips: Array<{
      id: string;
      startTime: number;
      duration: number;
      event?: string;
      description: string;
      fileName: string;
      videoHref?: string;
    }> = [];

    for (const rec of recordings.slice(0, 20)) {
      const recStart = rec.startTime ?? rec.parsedFileName?.start ?? start;
      const recEnd = rec.endTime ?? rec.parsedFileName?.end ?? recStart;

      const recStartMs = recStart.getTime();
      const recEndMs = Math.max(recEnd.getTime(), recStartMs);
      const duration = recEndMs - recStartMs;

      const id = rec.fileName;

      // Try to get playback URL
      let videoHref: string | undefined;
      try {
        const { rtmpVodUrl } = await api.getRecordingPlaybackUrls({
          channel: 0,
          fileName: rec.fileName,
        });
        videoHref = rtmpVodUrl;
      } catch (e) {
        // Silently ignore - not all recordings may have playback URLs available
      }

      clips.push({
        id,
        startTime: recStartMs,
        duration,
        event: rec.recordType,
        description: rec.fileName,
        fileName: rec.fileName,
        ...(videoHref ? { videoHref } : {}),
      });

      const size = rec.sizeBytes != null ? ` (${rec.sizeBytes} bytes)` : "";
      const urlInfo = videoHref ? ` [URL: ${videoHref}]` : "";
      console.log(`- ${rec.fileName}${size}${urlInfo}`);
      console.log(`  Start: ${recStart.toISOString()}, Duration: ${Math.round(duration / 1000)}s, Type: ${rec.recordType || "unknown"}`);
    }

    if (recordings.length > 20) {
      console.log(`... (${recordings.length - 20} more recordings)`);
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total clips found: ${clips.length}`);
    console.log(`Clips with playback URL: ${clips.filter((c) => c.videoHref).length}`);

    if (clips.length === 0) {
      console.log("\n[INFO] No videoclips found in the specified time window.");
      console.log("Try increasing RECORDINGS_DAYS_BACK or check if the camera has recordings enabled.");
    }
  } finally {
    await api.close().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error("[FATAL] Videoclips test failed:", e);
  process.exit(1);
});

