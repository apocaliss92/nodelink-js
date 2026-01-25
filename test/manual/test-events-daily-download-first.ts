import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { closeApi, createTcpApi, createTestLogger } = (await import(
  new URL("../helpers/api.js", import.meta.url).href
)) as any;

type AnyApi = any;

type EventsListFile = {
  window?: { dayKey?: string; start?: string; end?: string };
  channel?: number;
  events?: Array<any>;
};

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
};

const envBool = (name: string, def: boolean): boolean => {
  const v = env(name);
  if (!v) return def;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n") return false;
  return def;
};

const safeBasename = (p: string): string => {
  const base = p.split("/").filter(Boolean).at(-1) ?? "clip";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.length > 140 ? cleaned.slice(0, 140) : cleaned;
};

const pickFirstEvent = (events: Array<any>): any | undefined => {
  if (!events.length) return undefined;

  const scored = events
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
    .sort((a, b) => {
      if (a.startTimeMs !== b.startTimeMs) return a.startTimeMs - b.startTimeMs;
      return a.i - b.i;
    });

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

  // Fallback: closest by start time.
  return recordings
    .map((r) => {
      const rs = typeof r?.startTimeMs === "number" ? r.startTimeMs : 0;
      return { r, d: Math.abs(rs - evStartMs) };
    })
    .sort((a, b) => a.d - b.d)[0]?.r;
};

const listJsonFiles = async (dir: string): Promise<string[]> => {
  const entries = await (
    await import("node:fs/promises")
  ).readdir(dir, {
    withFileTypes: true,
  });
  const out: string[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".json")) continue;
    out.push(resolve(dir, ent.name));
  }
  return out.sort();
};

const parseDayKeyFromFilename = (filePath: string): string | undefined => {
  const m = filePath.match(/events\.(\d{4}-\d{2}-\d{2})\./);
  return m?.[1];
};

const main = async (): Promise<void> => {
  const artifactsBase = resolve(process.cwd(), "test/artifacts/events-daily");
  const downloadsBase = resolve(process.cwd(), "downloads/events-first");
  await mkdir(downloadsBase, { recursive: true });

  const tcpHost = env("TCP_HOST");
  const tcpUser = env("TCP_USERNAME") ?? "admin";
  const tcpPass = env("TCP_PASSWORD");

  const tcp265Host = env("TCP265_HOST");
  const tcp265User = env("TCP265_USERNAME") ?? "admin";
  const tcp265Pass = env("TCP265_PASSWORD");

  const nvrHost = env("NVR_HOST");
  const nvrUser = env("NVR_USERNAME") ?? "admin";
  const nvrPass = env("NVR_PASSWORD");
  const nvrUid = env("NVR_UID");

  const enableNativeDownload = envBool("EVENTS_NATIVE_DOWNLOAD", true);
  const enableNativeReplay = envBool("EVENTS_NATIVE_REPLAY", true);
  const enableNativeJpeg = envBool("EVENTS_NATIVE_JPEG", true);

  const { ReolinkBaichuanApi } = (await import(
    new URL("../../index.js", import.meta.url).href
  )) as any;

  const jobs: Array<{
    deviceName: string;
    makeApi: () => AnyApi;
    listDir: string;
    fileFilter: (filePath: string) => boolean;
  }> = [];

  if (tcpHost && tcpPass) {
    jobs.push({
      deviceName: "tcp",
      makeApi: () =>
        createTcpApi({
          dev: { host: tcpHost },
          username: tcpUser,
          password: tcpPass,
          logger: createTestLogger(),
        }),
      listDir: resolve(artifactsBase, "tcp"),
      fileFilter: (p) => /\.ch0\.json$/.test(p),
    });
  }

  if (tcp265Host && tcp265Pass) {
    jobs.push({
      deviceName: "tcp265",
      makeApi: () =>
        createTcpApi({
          dev: { host: tcp265Host },
          username: tcp265User,
          password: tcp265Pass,
          logger: createTestLogger(),
        }),
      listDir: resolve(artifactsBase, "tcp265"),
      fileFilter: (p) => /\.ch0\.json$/.test(p),
    });
  }

  if (nvrHost && nvrPass) {
    jobs.push({
      deviceName: "nvr",
      makeApi: () =>
        new ReolinkBaichuanApi({
          host: nvrHost,
          username: nvrUser,
          password: nvrPass,
          ...(nvrUid ? { uid: nvrUid } : {}),
          transport: "tcp",
          logger: createTestLogger(),
          debugOptions: {},
        }),
      listDir: resolve(artifactsBase, "nvr"),
      fileFilter: (p) => /\.all\.json$/.test(p),
    });
  }

  if (!jobs.length) {
    // eslint-disable-next-line no-console
    console.error("No env configured (TCP_HOST/TCP265_HOST/NVR_HOST)");
    process.exitCode = 2;
    return;
  }

  for (const job of jobs) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${job.deviceName}: download first clip per list ===`);

    const api = job.makeApi();
    try {
      const files = (await listJsonFiles(job.listDir)).filter(job.fileFilter);
      if (!files.length) {
        // eslint-disable-next-line no-console
        console.log(`No list files in ${job.listDir}`);
        continue;
      }

      const deviceOutDir = resolve(downloadsBase, job.deviceName);
      await mkdir(deviceOutDir, { recursive: true });

      for (const filePath of files) {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as EventsListFile;
        const events = Array.isArray(parsed.events) ? parsed.events : [];
        const chosen = pickFirstEvent(events);

        const dayKey =
          parsed.window?.dayKey ??
          parseDayKeyFromFilename(filePath) ??
          "unknown-day";

        if (!chosen?.fileName) {
          // eslint-disable-next-line no-console
          console.log(`Skip ${dayKey}: no events in ${filePath}`);
          continue;
        }

        const channel =
          typeof chosen.channel === "number"
            ? chosen.channel
            : typeof parsed.channel === "number"
              ? parsed.channel
              : 0;

        const eventFileName = String(chosen.fileName);

        const evStartMs =
          typeof chosen?.startTimeMs === "number"
            ? chosen.startTimeMs
            : typeof chosen?.startTime === "string"
              ? new Date(chosen.startTime).getTime()
              : 0;
        const evEndMs =
          typeof chosen?.endTimeMs === "number"
            ? chosen.endTimeMs
            : typeof chosen?.endTime === "string"
              ? new Date(chosen.endTime).getTime()
              : evStartMs;

        // Alarm-event fileName is often NOT directly replayable/downloadable via FileInfoList.
        // Map it to a real recording entry (FileInfoList) by time overlap.
        let recordingFileName = eventFileName;
        let resolvedRecording: any | undefined;
        try {
          const windowStart =
            typeof parsed.window?.start === "string"
              ? new Date(parsed.window.start)
              : new Date((evStartMs || Date.now()) - 6 * 60 * 60_000);
          const windowEnd =
            typeof parsed.window?.end === "string"
              ? new Date(parsed.window.end)
              : new Date((evEndMs || Date.now()) + 6 * 60 * 60_000);

          const recs = (await api.listRecordings({
            channel,
            start: windowStart,
            end: windowEnd,
            streamType: "mainStream",
            fallbackToAlarmVideo: false,
            enriched: true,
            includeAlarms: false,
            timeoutMs: 30_000,
          })) as Array<any>;

          resolvedRecording = pickBestRecordingForEvent({
            recordings: recs,
            evStartMs,
            evEndMs,
          });

          if (resolvedRecording?.fileName) {
            recordingFileName = String(resolvedRecording.fileName);
          }
        } catch {
          // ignore: if listing recordings fails we still try the event fileName
        }

        const base = `${job.deviceName}.events.${dayKey}.ch${channel}.${safeBasename(recordingFileName)}`;

        // 1) Native download via Baichuan (cmdId=13)
        if (enableNativeDownload) {
          try {
            const buf = (await api.downloadRecording({
              channel,
              ...(chosen.uid ? { uid: String(chosen.uid) } : {}),
              fileName: recordingFileName,
              timeoutMs: 180_000,
              fallbackToHttp: false,
            })) as Buffer;

            const outPath = resolve(deviceOutDir, `${base}.download.bin`);
            await writeFile(outPath, buf);

            // eslint-disable-next-line no-console
            console.log(
              `Native download OK ${dayKey} ch${channel}: ${outPath} (${buf.length} bytes)`,
            );
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(
              `Native download FAIL ${dayKey} ch${channel}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        // 2) Native stream via replay socket (cmdId=5) -> MP4 stream
        if (enableNativeReplay) {
          try {
            const outPath = resolve(deviceOutDir, `${base}.replay.mp4`);
            const { mp4, stop } = await api.createRecordingReplayMp4Stream({
              channel,
              fileName: recordingFileName,
            });

            try {
              // Lazy-import to avoid pulling stream deps when disabled
              const { pipeline } = await import("node:stream/promises");
              const { createWriteStream } = await import("node:fs");
              await pipeline(mp4, createWriteStream(outPath));
            } finally {
              await stop();
              try {
                mp4.destroy();
              } catch {
                // ignore
              }
            }

            // eslint-disable-next-line no-console
            console.log(`Native replay OK ${dayKey} ch${channel}: ${outPath}`);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(
              `Native replay FAIL ${dayKey} ch${channel}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        // 3) Native thumbnail JPEG via CoverPreview (cmdId=298)
        if (enableNativeJpeg) {
          try {
            const recStartMs =
              typeof resolvedRecording?.startTimeMs === "number"
                ? resolvedRecording.startTimeMs
                : evStartMs || Date.now();
            const coverTime = new Date(recStartMs + 1_000);

            const { jpeg } = await api.snapshotFromPlaybackJpeg({
              channel,
              time: coverTime,
              snapType: "sub",
              timeoutMs: 30_000,
              jpegQuality: 2,
            });

            const outPath = resolve(deviceOutDir, `${base}.cover.jpg`);
            await writeFile(outPath, jpeg);

            // eslint-disable-next-line no-console
            console.log(`Native jpeg OK ${dayKey} ch${channel}: ${outPath}`);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(
              `Native jpeg FAIL ${dayKey} ch${channel}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        // Persist context once per list for debugging.
        const metaPath = resolve(deviceOutDir, `${base}.meta.json`);
        await writeFile(
          metaPath,
          JSON.stringify(
            {
              listFile: filePath,
              dayKey,
              channel,
              chosen,
              eventFileName,
              recordingFileName,
              resolvedRecording,
              flags: {
                enableNativeDownload,
                enableNativeReplay,
                enableNativeJpeg,
              },
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await closeApi(api);
    }
  }
};

await main();
