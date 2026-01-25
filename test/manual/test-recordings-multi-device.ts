import "dotenv/config";

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const { closeApi, createTcpApi, createTestLogger, createUdpApi } =
  (await import(new URL("../helpers/api.js", import.meta.url).href)) as any;

type AnyApi = any;

type DeviceSpec = {
  name: string;
  kind: "tcp" | "udp" | "nvr";
  channel: number;
  makeApi: () => AnyApi;
};

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
};

const envNumber = (name: string): number | undefined => {
  const v = env(name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const envDate = (name: string): Date | undefined => {
  const v = env(name);
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
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
  const base = p.split("/").filter(Boolean).at(-1) ?? "recording";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
};

const sniffExt = (buf: Buffer): string => {
  // mp4: size(4) + 'ftyp'(4)
  if (buf.length >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp")
    return "mp4";
  return "bin";
};

const main = async (): Promise<void> => {
  const outDir = resolve(
    process.cwd(),
    "test/artifacts/recordings-multi-device",
  );
  await mkdir(outDir, { recursive: true });

  const downloadsDir = resolve(process.cwd(), "downloads/daily-recordings");
  await mkdir(downloadsDir, { recursive: true });

  const end = envDate("RECORDINGS_END") ?? new Date();
  const start =
    envDate("RECORDINGS_START") ??
    new Date(
      end.getTime() -
        (envNumber("RECORDINGS_LOOKBACK_HOURS") ?? 72) * 3600 * 1000,
    );

  const todayStart = startOfLocalDay(end);
  const yesterdayStart = addLocalDays(todayStart, -1);
  const windows = [
    {
      label: "yesterday",
      start: yesterdayStart,
      end: new Date(todayStart.getTime() - 1),
      dayKey: toDayKey(yesterdayStart),
    },
    {
      label: "today",
      start: todayStart,
      end,
      dayKey: toDayKey(todayStart),
    },
  ];

  const devices: DeviceSpec[] = [];

  const tcpHost = env("TCP_HOST");
  const tcpUser = env("TCP_USERNAME") ?? "admin";
  const tcpPass = env("TCP_PASSWORD");
  if (tcpHost && tcpPass) {
    devices.push({
      name: "tcp",
      kind: "tcp",
      channel: envNumber("TCP_CHANNEL") ?? 0,
      makeApi: () =>
        createTcpApi({
          dev: { host: tcpHost },
          username: tcpUser,
          password: tcpPass,
          logger: createTestLogger(),
        }),
    });
  }

  const udpHost = env("UDP_HOST");
  const udpUser = env("UDP_USERNAME") ?? "admin";
  const udpPass = env("UDP_PASSWORD");
  const udpUid = env("UDP_UID");
  if (udpHost && udpPass && udpUid) {
    devices.push({
      name: "udp",
      kind: "udp",
      channel: envNumber("UDP_CHANNEL") ?? 0,
      makeApi: () =>
        createUdpApi({
          dev: { host: udpHost, uid: udpUid },
          username: udpUser,
          password: udpPass,
          logger: createTestLogger(),
        }),
    });
  }

  const nvrHost = env("NVR_HOST");
  const nvrUser = env("NVR_USERNAME") ?? "admin";
  const nvrPass = env("NVR_PASSWORD");
  const nvrUid = env("NVR_UID");
  if (nvrHost && nvrPass && nvrUid) {
    const logger = createTestLogger();

    const { ReolinkBaichuanApi } = (await import(
      new URL("../../index.js", import.meta.url).href
    )) as any;

    devices.push({
      name: "nvr",
      kind: "nvr",
      channel: envNumber("NVR_CHANNEL") ?? 0,
      makeApi: () =>
        new ReolinkBaichuanApi({
          host: nvrHost,
          username: nvrUser,
          password: nvrPass,
          uid: nvrUid,
          transport: "tcp",
          logger,
          debugOptions: {},
        }),
    });
  }

  if (devices.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      "No devices configured. Set at least one of: TCP_HOST+TCP_PASSWORD, UDP_HOST+UDP_PASSWORD+UDP_UID, NVR_HOST+NVR_PASSWORD+NVR_UID",
    );
    process.exitCode = 2;
    return;
  }

  for (const dev of devices) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${dev.name} (${dev.kind}) ===`);

    const api = dev.makeApi();
    try {
      let clips: Array<any>;
      try {
        clips = (await api.listRecordings({
          channel: dev.channel,
          start,
          end,
          streamType: "mainStream",
          fallbackToAlarmVideo: false,
          enriched: true,
          includeAlarms: true,
        })) as Array<any>;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `Listing failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      // Download at least one recording for yesterday and today.
      for (const w of windows) {
        try {
          const dayRecs = (await api.listRecordings({
            channel: dev.channel,
            start: w.start,
            end: w.end,
            streamType: "mainStream",
            fallbackToAlarmVideo: false,
            enriched: true,
            includeAlarms: true,
            timeoutMs: 30_000,
          })) as Array<any>;

          const candidates = dayRecs
            .filter(
              (r) => typeof r?.durationMs === "number" && r.durationMs > 0,
            )
            .sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0));

          const chosen = candidates.at(0) ?? dayRecs.at(-1);
          if (!chosen?.fileName) {
            // eslint-disable-next-line no-console
            console.log(
              `No recordings found for ${w.label} (window=${w.start.toISOString()}..${w.end.toISOString()})`,
            );
            continue;
          }

          const buf = (await api.downloadRecording({
            channel: dev.channel,
            fileName: String(chosen.fileName),
            timeoutMs: 180_000,
            fallbackToHttp: false,
          })) as Buffer;

          const ext = sniffExt(buf);
          const devDir = resolve(downloadsDir, dev.name);
          await mkdir(devDir, { recursive: true });

          const outBase = `${dev.name}.ch${dev.channel}.${w.dayKey}.${safeBasename(String(chosen.fileName))}`;
          const outPath = resolve(devDir, `${outBase}.${ext}`);
          await writeFile(outPath, buf);

          const metaPath = resolve(devDir, `${outBase}.json`);
          await writeFile(
            metaPath,
            JSON.stringify(
              {
                device: dev,
                day: w,
                chosen,
                bytes: buf.length,
                savedAs: outPath,
              },
              null,
              2,
            ),
          );

          // eslint-disable-next-line no-console
          console.log(
            `Downloaded ${w.label}: ${outPath} (${buf.length} bytes)`,
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `Daily download failed (${w.label}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const clip = clips.at(-1);
      if (!clip) {
        // eslint-disable-next-line no-console
        console.log(
          `No recordings found (window=${start.toISOString()}..${end.toISOString()})`,
        );
        continue;
      }

      const fileName = clip.fileName as string;
      const startTimeMs =
        typeof clip.startTimeMs === "number"
          ? clip.startTimeMs
          : start.getTime();
      const coverTime = new Date(startTimeMs + 1000);

      // eslint-disable-next-line no-console
      console.log(`Selected clip: ${fileName}`);

      // Cover JPEG (prefer sub).
      try {
        const { jpeg, snapshot } = await api.snapshotFromPlaybackJpeg({
          channel: dev.channel,
          time: coverTime,
          snapType: "sub",
          timeoutMs: 30_000,
          jpegQuality: 2,
        });

        const coverPath = resolve(outDir, `${dev.name}.cover.jpg`);
        await writeFile(coverPath, jpeg);
        // eslint-disable-next-line no-console
        console.log(
          `Cover: ${coverPath} (${snapshot.encoding}, ${snapshot.frameLength} bytes raw)`,
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `Cover failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const saveReplay = async (streamType: "mainStream" | "subStream") => {
        const outPath = resolve(outDir, `${dev.name}.${streamType}.mp4`);
        const { mp4, stop } = await api.createRecordingReplayMp4Stream({
          channel: dev.channel,
          fileName,
        });

        try {
          await pipeline(mp4, createWriteStream(outPath));
          // eslint-disable-next-line no-console
          console.log(`Clip ${streamType}: ${outPath}`);
        } finally {
          await stop();
          try {
            mp4.destroy();
          } catch {
            // ignore
          }
        }
      };

      await saveReplay("mainStream");
      try {
        await saveReplay("subStream");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `Substream clip failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      await closeApi(api);
    }
  }
};

await main();
