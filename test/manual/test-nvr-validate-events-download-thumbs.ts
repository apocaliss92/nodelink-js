import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { closeApi, createTestLogger } = (await import(
  new URL("../helpers/api.js", import.meta.url).href
)) as any;

type AnyApi = any;

type WindowSpec = {
  label: string;
  start: Date;
  end: Date;
  dayKey: string;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const withTimeout = async <T>(
  label: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    // Don't keep the process alive just for this timeout.
    (t as any).unref?.();
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
};

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
};

const startOfLocalDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

const addLocalDays = (d: Date, days: number): Date =>
  new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );

const toDayKey = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

const safeBasename = (p: string): string => {
  const base = p.split("/").filter(Boolean).at(-1) ?? "clip";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.length > 140 ? cleaned.slice(0, 140) : cleaned;
};

const pickFirstByStartTime = (items: any[]): any | undefined => {
  const scored = items
    .map((e, i) => {
      const startTimeMs =
        typeof e?.startTimeMs === "number"
          ? e.startTimeMs
          : typeof e?.startTime === "string"
            ? new Date(e.startTime).getTime()
            : 0;
      return {
        e,
        i,
        startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : 0,
      };
    })
    .sort((a, b) =>
      a.startTimeMs !== b.startTimeMs
        ? a.startTimeMs - b.startTimeMs
        : a.i - b.i,
    );
  return scored[0]?.e;
};

const pickBestRecordingForEvent = (params: {
  recordings: Array<any>;
  evStartMs: number;
  evEndMs: number;
}): any | undefined => {
  const { recordings, evStartMs, evEndMs } = params;
  if (!recordings.length) return undefined;

  const overlaps = recordings.filter((r) => {
    const rs = typeof r?.startTimeMs === "number" ? r.startTimeMs : 0;
    const re = typeof r?.endTimeMs === "number" ? r.endTimeMs : rs;
    return rs <= evEndMs && re >= evStartMs;
  });
  if (overlaps.length) {
    overlaps.sort((a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0));
    return overlaps[0];
  }

  return recordings
    .map((r) => {
      const rs = typeof r?.startTimeMs === "number" ? r.startTimeMs : 0;
      return { r, d: Math.abs(rs - evStartMs) };
    })
    .sort((a, b) => a.d - b.d)[0]?.r;
};

const parseChannels = (v: string | undefined): number[] => {
  if (!v) return [0, 1];
  const out = v
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return out.length ? [...new Set(out)] : [0, 1];
};

const envInt = (name: string, def: number): number => {
  const v = env(name);
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const envBool = (name: string, def: boolean): boolean => {
  const v = env(name);
  if (!v) return def;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
};

const resolveHeaderChannelIdFromPushMap = (
  logicalChannel: number,
  pushMap: Map<number, any>,
): number | undefined => {
  const wantIndex1 = logicalChannel + 1;
  const wantIndex0 = logicalChannel;
  let byIndex1: number | undefined;
  let byIndex0: number | undefined;

  for (const [headerChannelId, info] of pushMap.entries()) {
    const idx = typeof info?.index === "number" ? info.index : undefined;
    if (idx === wantIndex1) byIndex1 = headerChannelId;
    if (idx === wantIndex0) byIndex0 = headerChannelId;
  }

  return byIndex1 ?? byIndex0;
};

const main = async (): Promise<void> => {
  const nvrHost = env("NVR_HOST");
  const nvrUser = env("NVR_USERNAME") ?? "admin";
  const nvrPass = env("NVR_PASSWORD");
  const nvrUid = env("NVR_UID");
  const channels = parseChannels(env("NVR_CHANNELS"));
  const replaySeconds = envInt("NVR_REPLAY_SECONDS", 15);
  const replayStartTimeoutMs = envInt("NVR_REPLAY_START_TIMEOUT_MS", 4000);
  const downloadTimeoutMs = envInt("NVR_DOWNLOAD_TIMEOUT_MS", 30_000);
  const includeReplay = envBool("NVR_INCLUDE_REPLAY", false);
  const downloadFallbackToHttp = envBool("NVR_DOWNLOAD_FALLBACK_HTTP", false);
  const hardTimeoutMs = envInt(
    "NVR_HARD_TIMEOUT_MS",
    // Keep it comfortably above replay + CoverPreview + download per channel.
    // When operations fail, they often consume their full timeouts.
    Math.max(
      90_000,
      channels.length * (replaySeconds * 1000 + downloadTimeoutMs + 75_000),
    ),
  );

  if (!nvrHost || !nvrPass) {
    // eslint-disable-next-line no-console
    console.error("Missing NVR_HOST or NVR_PASSWORD");
    process.exitCode = 2;
    return;
  }

  const now = new Date();
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = addLocalDays(todayStart, -1);

  const windows: WindowSpec[] = [
    {
      label: "today",
      start: todayStart,
      end: now,
      dayKey: toDayKey(todayStart),
    },
    {
      label: "yesterday",
      start: yesterdayStart,
      end: new Date(todayStart.getTime() - 1),
      dayKey: toDayKey(yesterdayStart),
    },
  ];

  const outBase = resolve(process.cwd(), "downloads/nvr-validation");
  await mkdir(outBase, { recursive: true });

  const { ReolinkBaichuanApi } = (await import(
    new URL("../../index.js", import.meta.url).href
  )) as any;

  const api: AnyApi = new ReolinkBaichuanApi({
    host: nvrHost,
    username: nvrUser,
    password: nvrPass,
    ...(nvrUid ? { uid: nvrUid } : {}),
    transport: "tcp",
    nativeOnly: true,
    logger: createTestLogger(),
    debugOptions: { traceRecordings: true },
  });

  const hardTimer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(`Hard timeout reached (${hardTimeoutMs}ms). Forcing exit.`);
    process.exit(2);
  }, hardTimeoutMs);
  (hardTimer as any).unref?.();

  const cleanupAndExit = async (code: number): Promise<void> => {
    try {
      await withTimeout("closeApi", 2500, async () => {
        await closeApi(api);
      });
    } catch {
      // ignore
    }
    process.exit(code);
  };

  const sigHandler = (sig: string) => {
    // eslint-disable-next-line no-console
    console.warn(`Received ${sig}, cleaning up...`);
    void cleanupAndExit(130);
  };
  process.once("SIGINT", () => sigHandler("SIGINT"));
  process.once("SIGTERM", () => sigHandler("SIGTERM"));

  try {
    // eslint-disable-next-line no-console
    console.log(
      `\n=== NVR validate: channels=${channels.join(",")} (replay=${includeReplay ? "on" : "off"}, downloadFallbackToHttp=${downloadFallbackToHttp ? "on" : "off"}) ===`,
    );

    let hadFailure = false;

    for (const channel of channels) {
      // eslint-disable-next-line no-console
      console.log(`\n--- channel ${channel} ---`);

      // The NVR often sends cmd_id=145 channel info asynchronously after connect.
      // Many flows (events/download) work much better when we have the per-channel UID.
      // Wait a bit to avoid racey “no events found”.
      if (typeof api.getChannelInfoFromPushCache === "function") {
        const waitMs = envInt("NVR_PUSH_CACHE_WAIT_MS", 4000);

        // Poke the NVR to trigger cmd145 push on some firmwares.
        // This may fail (FileInfoList can be unsupported) and that's fine.
        try {
          const now = new Date();
          await withTimeout("poke_listRecordings", 2500, async () => {
            await api.listRecordings({
              channel,
              start: new Date(now.getTime() - 6 * 60 * 60 * 1000),
              end: now,
              streamType: "mainStream",
              enriched: false,
              includeAlarms: false,
            });
          });
        } catch {
          // ignore
        }

        try {
          await withTimeout("wait_push_cache", waitMs, async () => {
            const deadline = Date.now() + waitMs;
            while (Date.now() < deadline) {
              const info =
                typeof api.getChannelInfoFromPushCacheByLogicalChannel ===
                "function"
                  ? api.getChannelInfoFromPushCacheByLogicalChannel(channel)
                  : api.getChannelInfoFromPushCache().get(channel);
              if (info?.uid) return;
              await delay(200);
            }
          });
        } catch {
          // ignore (best-effort)
        }

        // Diagnostic dump (best-effort): show raw cmd145 cache keys and logical->header mapping.
        try {
          const raw = api.getChannelInfoFromPushCache();
          const rawKeys = Array.from(raw.keys())
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n))
            .sort((a, b) => a - b);

          const headerChannelId = resolveHeaderChannelIdFromPushMap(
            channel,
            raw,
          );
          const entryByHeader =
            headerChannelId != null ? raw.get(headerChannelId) : undefined;

          const entryByLogical =
            typeof api.getChannelInfoFromPushCacheByLogicalChannel ===
            "function"
              ? api.getChannelInfoFromPushCacheByLogicalChannel(channel)
              : raw.get(channel);

          // eslint-disable-next-line no-console
          console.log(
            `pushCache keys=${rawKeys.join(",")} | logical=${channel} -> headerChannelId=${headerChannelId ?? "(unknown)"}`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `pushCache byLogical: ${JSON.stringify(entryByLogical ?? null)}`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `pushCache byHeader: ${JSON.stringify(entryByHeader ?? null)}`,
          );
        } catch {
          // ignore
        }
      }

      let chosenWindow: WindowSpec | undefined;
      let chosenEvent: any | undefined;
      let eventSource: "events" | "recordings" = "events";

      // Prefer events list (today, then yesterday)
      for (const w of windows) {
        const evs = (await api.listNvrAlarmEventsEnrichedViaBaichuan({
          start: w.start,
          end: w.end,
          channels: [channel],
          streamType: "mainStream",
          maxIterations: 50,
        })) as any[];

        const pick = pickFirstByStartTime(evs);
        if (pick) {
          chosenWindow = w;
          chosenEvent = pick;
          eventSource = "events";
          // eslint-disable-next-line no-console
          console.log(
            `Picked event from ${w.label}: ${pick.fileName ?? "(no fileName)"}`,
          );
          break;
        }
      }

      // If no events, fall back to first recording in today/yesterday
      if (!chosenEvent) {
        for (const w of windows) {
          const recs = (await api.listRecordings({
            channel,
            start: w.start,
            end: w.end,
            streamType: "mainStream",
            enriched: true,
            includeAlarms: false,
          })) as any[];

          const pick = pickFirstByStartTime(recs);
          if (pick) {
            chosenWindow = w;
            chosenEvent = pick;
            eventSource = "recordings";
            // eslint-disable-next-line no-console
            console.log(
              `Picked recording from ${w.label}: ${pick.fileName ?? "(no fileName)"}`,
            );
            break;
          }
        }
      }

      if (!chosenWindow || !chosenEvent?.fileName) {
        // eslint-disable-next-line no-console
        console.log("No event/recording found for this channel.");
        hadFailure = true;
        continue;
      }

      const evStartMs =
        typeof chosenEvent?.startTimeMs === "number"
          ? chosenEvent.startTimeMs
          : typeof chosenEvent?.startTime === "string"
            ? new Date(chosenEvent.startTime).getTime()
            : 0;
      const evEndMs =
        typeof chosenEvent?.endTimeMs === "number"
          ? chosenEvent.endTimeMs
          : typeof chosenEvent?.endTime === "string"
            ? new Date(chosenEvent.endTime).getTime()
            : evStartMs;

      // Map event->recording by overlap (alarm fileName may be different).
      const recordings = (await api.listRecordings({
        channel,
        start: chosenWindow.start,
        end: chosenWindow.end,
        streamType: "mainStream",
        enriched: true,
        includeAlarms: false,
      })) as any[];
      const best = pickBestRecordingForEvent({
        recordings,
        evStartMs,
        evEndMs,
      });

      // Prefer a full <Id> path when available (NVR FileInfoList replay cmdId=5 often requires it).
      const resolvedIdent = String(
        best?.id ?? best?.fileName ?? chosenEvent.fileName,
      );
      const baseName = safeBasename(resolvedIdent);

      const chDir = resolve(outBase, `${chosenWindow.dayKey}`, `ch${channel}`);
      await mkdir(chDir, { recursive: true });

      const meta = {
        channel,
        window: chosenWindow,
        eventSource,
        chosenEvent,
        resolvedRecording: best ?? null,
        resolvedIdent,
      };
      await writeFile(
        resolve(chDir, `${baseName}.meta.json`),
        JSON.stringify(meta, null, 2),
      );

      // 1) Optional: Native replay -> MP4 (cmdId=5)
      if (includeReplay) {
        // eslint-disable-next-line no-console
        console.log("Replay stream -> MP4 (native)");
        try {
          const mp4Buffer = await withTimeout(
            "replay_mp4",
            (replaySeconds + 20) * 1000,
            async () => {
              const { mp4, stop } = await api.createRecordingReplayMp4Stream({
                channel,
                fileName: resolvedIdent,
              });

              const mp4Chunks: Buffer[] = [];
              const killTimer = setTimeout(
                () => {
                  mp4.destroy(new Error("mp4 stream timeout"));
                },
                (replaySeconds + 15) * 1000,
              );
              (killTimer as any).unref?.();

              try {
                await new Promise<void>((resolvePromise, rejectPromise) => {
                  mp4.on("data", (c: Buffer) => mp4Chunks.push(c));
                  mp4.once("end", () => resolvePromise());
                  mp4.once("close", () => resolvePromise());
                  mp4.once("error", (e: unknown) => rejectPromise(e));
                });
              } finally {
                clearTimeout(killTimer);
                try {
                  await withTimeout("replay_stop", 2000, async () => {
                    await stop();
                  });
                } catch {
                  // ignore
                }
                try {
                  mp4.destroy();
                } catch {
                  // ignore
                }
              }

              return Buffer.concat(mp4Chunks);
            },
          );
          await writeFile(resolve(chDir, `${baseName}.replay.mp4`), mp4Buffer);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // eslint-disable-next-line no-console
          console.warn(`Replay failed: ${msg}`);
          hadFailure = true;
        }
      }

      // 2) Thumbnail JPEG (CoverPreview cmdId=298)
      // eslint-disable-next-line no-console
      console.log("CoverPreview -> JPEG");
      try {
        const time = new Date((best?.startTimeMs ?? evStartMs) || Date.now());
        const { jpeg, snapshot } = await withTimeout(
          "cover_jpeg",
          35_000,
          async () => {
            return await api.snapshotFromPlaybackJpeg({
              channel,
              time,
              snapType: "sub",
              timeoutMs: 30_000,
              jpegQuality: 2,
            });
          },
        );
        await writeFile(resolve(chDir, `${baseName}.cover.jpg`), jpeg);
        await writeFile(
          resolve(chDir, `${baseName}.cover.json`),
          JSON.stringify({
            encoding: snapshot?.encoding,
            frameLength: snapshot?.frameLength,
            streamInfo: snapshot?.streamInfo,
          }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.warn(`Cover skipped/failed: ${msg}`);
        hadFailure = true;
      }

      // 3) Download. Native-only (Baichuan). The library will try cmdId=5 first, then cmdId=13.
      // (HTTP/CGI fallback is intentionally off by default in this manual validation script.)
      const chUidFromPush =
        typeof api.getChannelInfoFromPushCacheByLogicalChannel === "function"
          ? api.getChannelInfoFromPushCacheByLogicalChannel(channel)?.uid
          : typeof api.getChannelInfoFromPushCache === "function"
            ? api.getChannelInfoFromPushCache().get(channel)?.uid
            : undefined;
      try {
        // eslint-disable-next-line no-console
        console.log(
          `Download (native Baichuan cmdId=5->13, best-effort, timeout=${downloadTimeoutMs}ms)`,
        );
        const bin = (await api.downloadRecording({
          channel,
          // Prefer per-channel UID when available; avoid forcing the NVR UID.
          uid: String(chUidFromPush ?? best?.uid ?? chosenEvent?.uid ?? ""),
          fileName: resolvedIdent,
          fallbackToHttp: downloadFallbackToHttp,
          timeoutMs: downloadTimeoutMs,
        })) as Buffer;
        await writeFile(resolve(chDir, `${baseName}.download.bin`), bin);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.warn(`Download skipped/failed: ${msg}`);
        hadFailure = true;
      }

      // eslint-disable-next-line no-console
      console.log(`Artifacts written: ${chDir}`);
    }

    if (hadFailure) {
      process.exitCode = 2;
    }
  } finally {
    clearTimeout(hardTimer);
    try {
      await withTimeout("closeApi", 2500, async () => {
        await closeApi(api);
      });
    } catch {
      // ignore
    }

    // Force-exit guard: if something keeps the event loop alive, exit anyway.
    const exitTimer = setTimeout(() => {
      process.exit(process.exitCode ?? 0);
    }, 750);
    (exitTimer as any).unref?.();
  }
};

await main();
