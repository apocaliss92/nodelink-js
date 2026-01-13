#!/usr/bin/env node
/**
 * Live test: list Hub/NVR event logs via cmd_id 516/517 (findEventLog) and optionally play back
 * a single event through a consumer-friendly local RTSP URL.
 *
 * Env (.env):
 * - NVR_HOST / NVR_USERNAME / NVR_PASSWORD (required)
 * - NVR_UID (optional)
 *
 * Optional behavior:
 * - EVENTLOG_START_ISO / EVENTLOG_END_ISO (ISO timestamps)
 * - EVENTLOG_HOURS (default: 6)
 * - EVENTLOG_COUNT (default: 30)
 * - EVENTLOG_PAGE_SIZE (default: 60)
 * - EVENTLOG_PLAY=1 (enable RTSP playback)
 * - EVENTLOG_INDEX (default: 0)
 * - EVENTLOG_PREFERRED_STREAM=mobileStream|subStream (default: mobileStream)
 * - EVENTLOG_LISTEN_HOST / EVENTLOG_LISTEN_PORT
 * - EVENTLOG_KEEPALIVE_SEC (default: 60)
 */

import "../env.js";

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

import fs from "node:fs";
import path from "node:path";

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

function normalizeDetectionType(alarmType: string | null | undefined): string | null {
  const v = (alarmType ?? "").trim();
  if (!v) return null;
  // Keep original values where possible; apply only a tiny normalization.
  // HomeHub commonly uses "people" but most consumers expect "person".
  if (v === "people") return "person";
  return v;
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
  const countRaw = (process.env.EVENTLOG_COUNT ?? "").trim();
  const count = countRaw ? Number.parseInt(countRaw, 10) : undefined;
  const pageSize = Number.parseInt((process.env.EVENTLOG_PAGE_SIZE ?? "60").trim(), 10);

  const now = new Date();
  const end = endIso ?? now;
  const start = startIso ?? new Date(now.getTime() - (Number.isFinite(hours) ? hours : 6) * 3600_000);

  const play = envBool(process.env.EVENTLOG_PLAY);
  const index = Math.max(0, Number.parseInt((process.env.EVENTLOG_INDEX ?? "0").trim(), 10) || 0);
  const preferredStream = ((process.env.EVENTLOG_PREFERRED_STREAM ?? "mobileStream").trim() || "mobileStream") as
    | "mobileStream"
    | "subStream";

  const listenHost = (process.env.EVENTLOG_LISTEN_HOST ?? "").trim() || undefined;
  const listenPortRaw = (process.env.EVENTLOG_LISTEN_PORT ?? "").trim();
  const listenPort = listenPortRaw ? Number.parseInt(listenPortRaw, 10) : undefined;

  const keepAliveSec = Math.max(1, Number.parseInt((process.env.EVENTLOG_KEEPALIVE_SEC ?? "60").trim(), 10) || 60);

  const channelIdRaw = (process.env.EVENTLOG_CHANNEL_ID ?? "").trim();
  const channelIdFilter = channelIdRaw ? Number.parseInt(channelIdRaw, 10) : undefined;
  const requireHasRecFileRaw = (process.env.EVENTLOG_REQUIRE_RECFILE ?? "").trim().toLowerCase();
  const requireHasRecFile =
    requireHasRecFileRaw === ""
      ? true
      : /^(0|false|no|off)$/.test(requireHasRecFileRaw)
        ? false
        : true;

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid,
    logger: {
      log: console.log,
      debug: undefined,
      warn: console.warn,
      error: console.error,
    },
  });

  try {
    await api.login();

    // The UID->channel mapping comes from cmd_id 145 pushes; give it a moment.
    await waitForChannelPushCache(api);

    const events = await api.listEventLogs({
      start,
      end,
      ...(count !== undefined && Number.isFinite(count) ? { count } : {}),
      pageSize: Number.isFinite(pageSize) ? pageSize : 60,
      ...(Number.isFinite(channelIdFilter as number) ? { channelId: channelIdFilter as number } : {}),
      requireHasRecFile,
    });

    const outDir = path.resolve(process.cwd(), "test/nvr/exports");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.resolve(outDir, "eventlog-events.filtered.json");
    const json = {
      meta: {
        generatedAt: new Date().toISOString(),
        host,
        window: { start: start.toISOString(), end: end.toISOString() },
        countRequested: count ?? null,
        pageSize: Number.isFinite(pageSize) ? pageSize : 60,
        filters: {
          requireHasRecFile,
          channelId: Number.isFinite(channelIdFilter as number) ? (channelIdFilter as number) : null,
        },
        returned: events.length,
      },
      events: events.map((ev: (typeof events)[number]) => ({
        uid: ev.uid,
        channelId: ev.channelId ?? null,
        logicChn: ev.logicChn ?? null,
        logicChnBitmap: ev.logicChnBitmap ?? null,
        alarmType: ev.alarmType ?? null,
        detectionType: normalizeDetectionType(ev.alarmType ?? null),
        startTime: ev.startTime.toISOString(),
        endTime: ev.endTime.toISOString(),
        hasRecFile: ev.hasRecFile ?? null,
        encrypted: ev.encrypted ?? null,
        deleted: ev.deleted ?? null,
      })),
    };
    fs.writeFileSync(outPath, JSON.stringify(json, null, 2), "utf8");

    console.log("\n=== HUB/NVR EVENT LOGS (516/517) ===");
    console.log(`host: ${host}`);
    console.log(`window: ${start.toISOString()} -> ${end.toISOString()}`);
    console.log(`returned: ${events.length}`);
    console.log(`saved: ${outPath}`);

    for (const [i, ev] of events.entries()) {
      const durSec = Math.max(0, Math.round((ev.endTime.getTime() - ev.startTime.getTime()) / 1000));
      const ch = ev.channelId ?? -1;
      const alarm = (ev.alarmType ?? "").trim() || "(unknown)";
      console.log(
        `${String(i).padStart(3, " ")} ch=${String(ch).padStart(2, " ")} uid=${ev.uid} type=${alarm} ` +
          `start=${ev.startTime.toISOString()} end=${ev.endTime.toISOString()} dur=${durSec}s`,
      );
    }

    if (!play) return;

    if (!events.length) {
      throw new Error("No events returned. Try increasing EVENTLOG_HOURS or adjusting EVENTLOG_START_ISO/END_ISO.");
    }

    const chosen = events[index] ?? events[0];
    console.log("\n=== EVENT PLAYBACK (ReplayByTimeV2 -> local RTSP) ===");
    console.log(`selected index: ${index}`);
    console.log(`uid: ${chosen.uid}`);
    console.log(`channelId: ${chosen.channelId ?? "(missing)"}`);
    console.log(`alarmType: ${chosen.alarmType ?? "(unknown)"}`);
    console.log(`start: ${chosen.startTime.toISOString()}`);
    console.log(`end: ${chosen.endTime.toISOString()}`);

    const { url, streamType, stop } = await api.createEventPlaybackRtspUrl({
      event: chosen,
      preferredStream,
      ...(listenHost ? { listenHost } : {}),
      ...(Number.isFinite(listenPort as number) ? { listenPort: listenPort as number } : {}),
    });

    console.log(`\nRTSP URL (${streamType}): ${url}`);
    console.log(`Try: vlc "${url}"`);
    console.log(`Keeping server alive for ${keepAliveSec}s...`);

    await sleep(keepAliveSec * 1000);

    await stop();
    console.log("Stopped RTSP server.");
  } finally {
    await api.close().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
