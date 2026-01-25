import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

const main = async (): Promise<void> => {
  const end = envDate("EVENTS_END") ?? new Date();
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

  const outDir = resolve(process.cwd(), "downloads/events");
  await mkdir(outDir, { recursive: true });

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
    console.log(`\n=== ${dev.name} (${dev.kind}) ch=${dev.channel} ===`);

    const api = dev.makeApi();
    try {
      const devDir = resolve(outDir, dev.name);
      await mkdir(devDir, { recursive: true });

      for (const w of windows) {
        try {
          const events = (await api.listAlarmEvents({
            channel: dev.channel,
            start: w.start,
            end: w.end,
            streamType: "mainStream",
            timeoutMs: 15_000,
            maxIterations: 20,
          })) as any[];

          const outPath = resolve(
            devDir,
            `events.ch${dev.channel}.${w.dayKey}.json`,
          );

          await writeFile(
            outPath,
            JSON.stringify(
              {
                device: dev,
                window: {
                  label: w.label,
                  start: w.start.toISOString(),
                  end: w.end.toISOString(),
                },
                count: events.length,
                events,
              },
              null,
              2,
            ),
          );

          // eslint-disable-next-line no-console
          console.log(
            `Events ${w.label}: ${events.length} items -> ${outPath}`,
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `Events ${w.label} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      await closeApi(api);
    }
  }
};

await main();
