import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { closeApi, createTcpApi, createTestLogger } = (await import(
  new URL("../helpers/api.js", import.meta.url).href
)) as any;

type AnyApi = any;

type CameraDeviceSpec = {
  name: string;
  kind: "tcp" | "tcp265";
  channel: number;
  makeApi: () => AnyApi;
};

type NvrDeviceSpec = {
  name: string;
  kind: "nvr";
  channels: number[];
  makeApi: () => AnyApi;
};

type DeviceSpec = CameraDeviceSpec | NvrDeviceSpec;

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

const main = async (): Promise<void> => {
  const outDir = resolve(process.cwd(), "test/artifacts/events-daily");
  await mkdir(outDir, { recursive: true });

  const now = new Date();
  const todayStart = startOfLocalDay(now);
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
      end: now,
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
      channel: 0,
      makeApi: () =>
        createTcpApi({
          dev: { host: tcpHost },
          username: tcpUser,
          password: tcpPass,
          logger: createTestLogger(),
        }),
    });
  }

  const tcp265Host = env("TCP265_HOST");
  const tcp265User = env("TCP265_USERNAME") ?? "admin";
  const tcp265Pass = env("TCP265_PASSWORD");
  if (tcp265Host && tcp265Pass) {
    devices.push({
      name: "tcp265",
      kind: "tcp265",
      channel: 0,
      makeApi: () =>
        createTcpApi({
          dev: { host: tcp265Host },
          username: tcp265User,
          password: tcp265Pass,
          logger: createTestLogger(),
        }),
    });
  }

  const nvrHost = env("NVR_HOST");
  const nvrUser = env("NVR_USERNAME") ?? "admin";
  const nvrPass = env("NVR_PASSWORD");
  const nvrUid = env("NVR_UID");
  if (nvrHost && nvrPass) {
    const logger = createTestLogger();

    const { ReolinkBaichuanApi } = (await import(
      new URL("../../index.js", import.meta.url).href
    )) as any;

    devices.push({
      name: "nvr",
      kind: "nvr",
      channels: [0, 1],
      makeApi: () =>
        new ReolinkBaichuanApi({
          host: nvrHost,
          username: nvrUser,
          password: nvrPass,
          ...(nvrUid ? { uid: nvrUid } : {}),
          transport: "tcp",
          logger,
          debugOptions: {},
        }),
    });
  }

  if (devices.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      "No devices configured. Set TCP_HOST+TCP_PASSWORD and/or TCP265_HOST+TCP265_PASSWORD and/or NVR_HOST+NVR_PASSWORD",
    );
    process.exitCode = 2;
    return;
  }

  for (const dev of devices) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${dev.name} (${dev.kind}) ===`);

    const api = dev.makeApi();
    try {
      const devOutDir = resolve(outDir, dev.name);
      await mkdir(devOutDir, { recursive: true });

      for (const w of windows) {
        try {
          if (dev.kind === "nvr") {
            const events = (await api.listNvrAlarmEventsEnrichedViaBaichuan({
              start: w.start,
              end: w.end,
              channels: dev.channels,
              streamType: "mainStream",
              maxIterations: 50,
            })) as Array<any>;

            // Persist both the full list and a per-channel split for convenience.
            const byChannel: Record<string, Array<any>> = {};
            for (const ev of events) {
              const ch = String(ev?.channel ?? "unknown");
              (byChannel[ch] ??= []).push(ev);
            }

            await writeFile(
              resolve(devOutDir, `events.${w.dayKey}.all.json`),
              JSON.stringify(
                { device: dev, window: w, count: events.length, events },
                null,
                2,
              ),
            );

            for (const ch of Object.keys(byChannel).sort()) {
              const evs = byChannel[ch] ?? [];
              await writeFile(
                resolve(devOutDir, `events.${w.dayKey}.ch${ch}.json`),
                JSON.stringify(
                  {
                    device: dev,
                    window: w,
                    channel: Number(ch),
                    count: evs.length,
                    events: evs,
                  },
                  null,
                  2,
                ),
              );
            }

            // eslint-disable-next-line no-console
            console.log(
              `Events ${w.label}: total=${events.length} (channels=${dev.channels.join(",")})`,
            );
          } else {
            const events = (await api.listAlarmEvents({
              channel: dev.channel,
              start: w.start,
              end: w.end,
              streamType: "mainStream",
              maxIterations: 50,
              timeoutMs: 30_000,
            })) as Array<any>;

            await writeFile(
              resolve(devOutDir, `events.${w.dayKey}.ch${dev.channel}.json`),
              JSON.stringify(
                {
                  device: dev,
                  window: w,
                  channel: dev.channel,
                  count: events.length,
                  events,
                },
                null,
                2,
              ),
            );

            // eslint-disable-next-line no-console
            console.log(`Events ${w.label}: count=${events.length}`);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `Events failed (${w.label}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      await closeApi(api);
    }
  }
};

await main();
