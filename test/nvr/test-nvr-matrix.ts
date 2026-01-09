#!/usr/bin/env node
/**
 * NVR/HUB recordings + events matrix test
 *
 * Goal: quickly determine which combination is reliable for:
 * - VOD recordings list (must return /mnt/... ids)
 * - Events list (alarm-like clips)
 *
 * It runs the same windows through:
 * - Recordings: ReolinkBaichuanApi.listNvrRecordings(source="baichuan")  (hybrid: Baichuan FileInfoList + CGI fallback)
 * - Recordings: ReolinkBaichuanApi.listNvrRecordings(source="cgi")
 * - Events:     ReolinkBaichuanApi.listNvrAlarmEventsEnrichedViaBaichuan (findAlarmVideo)
 * - Events:     ReolinkBaichuanApi.listNvrAlarmEventsEnrichedViaCgi
 *
 * Env:
 * - NVR_HOST, NVR_USERNAME, NVR_PASSWORD (required)
 * - NVR_UID (optional)
 * - MATRIX_CHANNELS (e.g. "0" or "0,1,2"; default "0")
 * - MATRIX_STREAM ("main"|"sub"; default "main")
 * - MATRIX_END_ISO (default: now)
 * - MATRIX_SHORT_HOURS (default 2)
 * - MATRIX_LONG_HOURS (default 24)
 * - MATRIX_SHORT_START_ISO / MATRIX_LONG_START_ISO (optional overrides)
 * - MATRIX_SHORT_END_ISO / MATRIX_LONG_END_ISO (optional overrides)
 * - MATRIX_TIMEOUT_MS (default 180000)
 * - MATRIX_PRINT (default 5)
 * - MATRIX_JSON_OUT (optional path; writes summary json)
 * - TRACE_RECORDINGS=1 to enable traceRecordings
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";

type WindowSpec = { label: string; start: Date; end: Date };

type Recording = {
  id?: string;
  fileName: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  recordType?: string;
  hasMotion: boolean;
  hasPerson: boolean;
  hasVehicle: boolean;
  hasAnimal: boolean;
  hasFace: boolean;
  hasDoorbell: boolean;
  hasPackage: boolean;
  hasRf: boolean;
  hasOther: boolean;
};

type Event = Recording;

function die(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${label})`)), ms);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t as any).unref?.();
    }),
  ]) as Promise<T>;
}

function parseBool(v: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((v ?? "").trim());
}

function parseChannels(v: string | undefined): number[] {
  const raw = (v ?? "0").trim();
  const parts = raw
    .split(/[,\s:]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = parts
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.floor(n));
  return nums.length ? Array.from(new Set(nums)) : [0];
}

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return undefined;
  return d;
}

function clampIso(d: Date): string {
  return new Date(d.getTime()).toISOString();
}

function isEventLike(r: Recording): boolean {
  return Boolean(
    r.hasMotion ||
      r.hasPerson ||
      r.hasVehicle ||
      r.hasAnimal ||
      r.hasFace ||
      r.hasDoorbell ||
      r.hasPackage ||
      r.hasRf ||
      r.hasOther,
  );
}

function idIsMnt(r: { id?: string; fileName?: string }): boolean {
  const id = (r.id ?? "").trim();
  const fn = (r.fileName ?? "").trim();
  return id.startsWith("/mnt/") || fn.startsWith("/mnt/");
}

function overlapMs(a: { startTimeMs: number; endTimeMs: number }, b: { startTimeMs: number; endTimeMs: number }): number {
  const startMax = Math.max(a.startTimeMs, b.startTimeMs);
  const endMin = Math.min(a.endTimeMs, b.endTimeMs);
  return Math.max(0, endMin - startMax);
}

function summarizeRecordings(items: Recording[]) {
  const total = items.length;
  const mnt = items.filter((r) => idIsMnt(r)).length;
  const withTimes = items.filter((r) => Number.isFinite(r.startTimeMs) && Number.isFinite(r.endTimeMs)).length;
  const eventLike = items.filter((r) => isEventLike(r)).length;

  // App Reolink often shows “clips” as fixed 60s tiles/segments even if the underlying VOD
  // files are longer. This metric approximates that: sum( max(1, ceil(duration / 60s)) ).
  const appLike60s = items.reduce((acc, r) => {
    const durFromTimes = Number.isFinite(r.startTimeMs) && Number.isFinite(r.endTimeMs) ? Math.max(0, r.endTimeMs - r.startTimeMs) : 0;
    const dur = Number.isFinite(r.durationMs) && r.durationMs > 0 ? r.durationMs : durFromTimes;
    return acc + Math.max(1, Math.ceil(dur / 60_000));
  }, 0);
  const types = new Map<string, number>();
  for (const it of items) {
    const t = (it.recordType ?? "").trim() || "(none)";
    types.set(t, (types.get(t) ?? 0) + 1);
  }
  const topTypes = Array.from(types.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => ({ recordType: k, count: v }));

  const minStartMs = items.reduce<number | undefined>((acc, r) => {
    if (!Number.isFinite(r.startTimeMs)) return acc;
    if (acc == null) return r.startTimeMs;
    return Math.min(acc, r.startTimeMs);
  }, undefined);
  const maxEndMs = items.reduce<number | undefined>((acc, r) => {
    if (!Number.isFinite(r.endTimeMs)) return acc;
    if (acc == null) return r.endTimeMs;
    return Math.max(acc, r.endTimeMs);
  }, undefined);

  return { total, mnt, withTimes, eventLike, appLike60s, topTypes, minStartMs, maxEndMs };
}

function summarizeRangeCompliance(items: Recording[], window: { startMs: number; endMs: number }) {
  const startMs = window.startMs;
  const endMs = window.endMs;
  let outOfRange = 0;
  let tooEarly = 0;
  let tooLate = 0;
  for (const r of items) {
    const s = r.startTimeMs;
    const e = r.endTimeMs;
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const early = s < startMs;
    const late = e > endMs;
    if (early || late) outOfRange++;
    if (early) tooEarly++;
    if (late) tooLate++;
  }
  return { outOfRange, tooEarly, tooLate };
}

function summarizeOverlap(vod: Recording[], events: Event[]): { vodWithAnyEvent: number; eventCoveragePct: number } {
  if (vod.length === 0) return { vodWithAnyEvent: 0, eventCoveragePct: 0 };
  if (events.length === 0) return { vodWithAnyEvent: 0, eventCoveragePct: 0 };

  let vodWithAnyEvent = 0;
  for (const v of vod) {
    let ok = false;
    for (const e of events) {
      if (overlapMs(v, e) > 0) {
        ok = true;
        break;
      }
    }
    if (ok) vodWithAnyEvent++;
  }

  return {
    vodWithAnyEvent,
    eventCoveragePct: Math.round((vodWithAnyEvent / vod.length) * 1000) / 10,
  };
}

async function main(): Promise<void> {
  const { host, username, password, uid } = config.nvr;
  if (!host) die("Missing NVR_HOST in .env");
  if (!username) die("Missing NVR_USERNAME in .env");
  if (!password) die("Missing NVR_PASSWORD in .env");

  const channels = parseChannels(process.env.MATRIX_CHANNELS);
  const stream = (process.env.MATRIX_STREAM ?? "main").trim().toLowerCase() === "sub" ? "sub" : "main";
  const streamType = stream === "sub" ? "subStream" : "mainStream";

  const endDefault = parseDate(process.env.MATRIX_END_ISO) ?? new Date();
  const shortHours = Number(process.env.MATRIX_SHORT_HOURS ?? "2");
  const longHours = Number(process.env.MATRIX_LONG_HOURS ?? "24");

  const shortStart =
    parseDate(process.env.MATRIX_SHORT_START_ISO) ??
    new Date(endDefault.getTime() - (Number.isFinite(shortHours) ? shortHours : 2) * 60 * 60 * 1000);
  const shortEnd = parseDate(process.env.MATRIX_SHORT_END_ISO) ?? endDefault;

  const longStart =
    parseDate(process.env.MATRIX_LONG_START_ISO) ??
    new Date(endDefault.getTime() - (Number.isFinite(longHours) ? longHours : 24) * 60 * 60 * 1000);
  const longEnd = parseDate(process.env.MATRIX_LONG_END_ISO) ?? endDefault;

  const windows: WindowSpec[] = [
    { label: `short_${Number.isFinite(shortHours) ? shortHours : 2}h`, start: shortStart, end: shortEnd },
    { label: `long_${Number.isFinite(longHours) ? longHours : 24}h`, start: longStart, end: longEnd },
  ];

  const timeoutMs = Number(process.env.MATRIX_TIMEOUT_MS ?? "180000");
  const printN = Number(process.env.MATRIX_PRINT ?? "5");
  const jsonOut = (process.env.MATRIX_JSON_OUT ?? "").trim();
  const traceRecordings = parseBool(process.env.TRACE_RECORDINGS);

  // eslint-disable-next-line no-console
  console.log("\n" + "=".repeat(90));
  // eslint-disable-next-line no-console
  console.log("TEST: NVR/HUB MATRIX (recordings + events)");
  // eslint-disable-next-line no-console
  console.log("=".repeat(90));
  // eslint-disable-next-line no-console
  console.log(`Host: ${host}`);
  // eslint-disable-next-line no-console
  console.log(`User: ${username}`);
  // eslint-disable-next-line no-console
  console.log(`Channels: ${channels.join(", ")}`);
  // eslint-disable-next-line no-console
  console.log(`Stream: ${stream} (Baichuan ${streamType})`);
  // eslint-disable-next-line no-console
  console.log(`Timeout: ${timeoutMs}ms per call`);
  // eslint-disable-next-line no-console
  console.log(`Windows:`);
  for (const w of windows) {
    // eslint-disable-next-line no-console
    console.log(`  - ${w.label}: ${clampIso(w.start)} -> ${clampIso(w.end)}`);
  }
  // eslint-disable-next-line no-console
  console.log("");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid,
    timeoutMs: 30_000,
    ...(traceRecordings ? { debugOptions: { traceRecordings: true } } : {}),
  });

  const hardExitMs = Number(process.env.HARD_EXIT_MS ?? String(timeoutMs * 6 + 60_000));
  const hardExitTimer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(`Hard exit after ${hardExitMs}ms (HARD_EXIT_MS).`);
    process.exit(2);
  }, hardExitMs);

  const summary: any = {
    host,
    channels,
    stream,
    timeoutMs,
    windows: windows.map((w) => ({ label: w.label, start: w.start.toISOString(), end: w.end.toISOString() })),
    results: [],
  };

  try {
    // eslint-disable-next-line no-console
    console.log("Logging in (Baichuan)...");
    await withTimeout(api.login(), Math.min(45_000, timeoutMs), "api.login");
    // eslint-disable-next-line no-console
    console.log("Login OK\n");

    for (const w of windows) {
      for (const channel of channels) {
        // eslint-disable-next-line no-console
        console.log("-".repeat(90));
        // eslint-disable-next-line no-console
        console.log(`Window=${w.label} channel=${channel}`);
        // eslint-disable-next-line no-console
        console.log("-".repeat(90));

        const resultRow: any = {
          window: w.label,
          channel,
          start: w.start.toISOString(),
          end: w.end.toISOString(),
        };

        const run = async <T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; ms: number; value: T } | { ok: false; ms: number; error: string } > => {
          const t0 = Date.now();
          try {
            const value = await withTimeout(fn(), timeoutMs, label);
            return { ok: true, ms: Date.now() - t0, value };
          } catch (e) {
            return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
          }
        };

        const vodAuto = await run("recordings:auto", async () =>
          api.listNvrRecordings({
            source: "baichuan",
            channel,
            start: w.start,
            end: w.end,
            streamType: stream,
            autoSearchByDay: true,
          }),
        );

        const vodCgi = await run("recordings:cgi", async () =>
          api.listNvrRecordings({
            source: "cgi",
            channel,
            start: w.start,
            end: w.end,
            streamType: stream,
            autoSearchByDay: true,
          }),
        );

        const eventsBc = await run("events:baichuan", async () =>
          api.listNvrAlarmEventsEnrichedViaBaichuan({
            start: w.start,
            end: w.end,
            channels: [channel],
            streamType,
            maxIterations: 50,
          }),
        );

        const eventsCgi = await run("events:cgi", async () =>
          api.listNvrAlarmEventsEnrichedViaCgi({
            start: w.start,
            end: w.end,
            channels: [channel],
            streamType,
            autoSearchByDay: true,
          }),
        );

        const vodAutoItems = vodAuto.ok ? (vodAuto.value as Recording[]) : [];
        const vodCgiItems = vodCgi.ok ? (vodCgi.value as Recording[]) : [];
        const eventsBcItems = eventsBc.ok ? (eventsBc.value as Array<Event & { channel: number }>).map((e) => e as any as Event) : [];
        const eventsCgiItems = eventsCgi.ok ? (eventsCgi.value as Array<Event & { channel: number }>).map((e) => e as any as Event) : [];

        const windowMs = { startMs: w.start.getTime(), endMs: w.end.getTime() };

        const vodAutoSummary = summarizeRecordings(vodAutoItems);
        const vodCgiSummary = summarizeRecordings(vodCgiItems);
        const eventsBcSummary = summarizeRecordings(eventsBcItems);
        const eventsCgiSummary = summarizeRecordings(eventsCgiItems);

        const vodAutoCompliance = summarizeRangeCompliance(vodAutoItems, windowMs);
        const vodCgiCompliance = summarizeRangeCompliance(vodCgiItems, windowMs);
        const eventsBcCompliance = summarizeRangeCompliance(eventsBcItems, windowMs);
        const eventsCgiCompliance = summarizeRangeCompliance(eventsCgiItems, windowMs);

        const overlapAutoWithBcEvents = summarizeOverlap(vodAutoItems, eventsBcItems);
        const overlapCgiWithBcEvents = summarizeOverlap(vodCgiItems, eventsBcItems);

        // eslint-disable-next-line no-console
        console.table([
          {
            label: "recordings:auto",
            ok: vodAuto.ok,
            ms: vodAuto.ms,
            total: vodAutoSummary.total,
            app60s: vodAutoSummary.appLike60s,
            mnt: vodAutoSummary.mnt,
            eventLike: vodAutoSummary.eventLike,
            outOfRange: vodAutoCompliance.outOfRange,
          },
          {
            label: "recordings:cgi",
            ok: vodCgi.ok,
            ms: vodCgi.ms,
            total: vodCgiSummary.total,
            app60s: vodCgiSummary.appLike60s,
            mnt: vodCgiSummary.mnt,
            eventLike: vodCgiSummary.eventLike,
            outOfRange: vodCgiCompliance.outOfRange,
          },
          {
            label: "events:baichuan",
            ok: eventsBc.ok,
            ms: eventsBc.ms,
            total: eventsBcSummary.total,
            app60s: eventsBcSummary.appLike60s,
            mnt: eventsBcSummary.mnt,
            eventLike: eventsBcSummary.eventLike,
            outOfRange: eventsBcCompliance.outOfRange,
          },
          {
            label: "events:cgi",
            ok: eventsCgi.ok,
            ms: eventsCgi.ms,
            total: eventsCgiSummary.total,
            app60s: eventsCgiSummary.appLike60s,
            mnt: eventsCgiSummary.mnt,
            eventLike: eventsCgiSummary.eventLike,
            outOfRange: eventsCgiCompliance.outOfRange,
          },
        ]);

        if (!vodAuto.ok) {
          // eslint-disable-next-line no-console
          console.log(`recordings:auto error: ${vodAuto.error}`);
        }
        if (!vodCgi.ok) {
          // eslint-disable-next-line no-console
          console.log(`recordings:cgi error: ${vodCgi.error}`);
        }
        if (!eventsBc.ok) {
          // eslint-disable-next-line no-console
          console.log(`events:baichuan error: ${eventsBc.error}`);
        }
        if (!eventsCgi.ok) {
          // eslint-disable-next-line no-console
          console.log(`events:cgi error: ${eventsCgi.error}`);
        }

        // eslint-disable-next-line no-console
        console.log(`Overlap (Baichuan events vs recordings:auto): ${overlapAutoWithBcEvents.vodWithAnyEvent}/${vodAutoItems.length} (${overlapAutoWithBcEvents.eventCoveragePct}%)`);
        // eslint-disable-next-line no-console
        console.log(`Overlap (Baichuan events vs recordings:cgi):  ${overlapCgiWithBcEvents.vodWithAnyEvent}/${vodCgiItems.length} (${overlapCgiWithBcEvents.eventCoveragePct}%)`);

        const sample = (items: Recording[]) =>
          items
            .slice(0, Math.max(0, Number.isFinite(printN) ? printN : 5))
            .map((r) => ({
              id: (r.id ?? "").slice(0, 80),
              fileName: (r.fileName ?? "").slice(0, 80),
              start: new Date(r.startTimeMs).toISOString(),
              end: new Date(r.endTimeMs).toISOString(),
              recordType: r.recordType ?? "",
              flags: [
                r.hasMotion ? "motion" : "",
                r.hasPerson ? "person" : "",
                r.hasVehicle ? "vehicle" : "",
                r.hasAnimal ? "animal" : "",
                r.hasFace ? "face" : "",
                r.hasDoorbell ? "doorbell" : "",
                r.hasPackage ? "package" : "",
                r.hasRf ? "rf" : "",
                r.hasOther ? "other" : "",
              ]
                .filter(Boolean)
                .join(","),
            }));

        // eslint-disable-next-line no-console
        console.log("Samples:");
        if (vodAutoItems.length) {
          // eslint-disable-next-line no-console
          console.log("  recordings:auto");
          // eslint-disable-next-line no-console
          console.table(sample(vodAutoItems));
        }
        if (vodCgiItems.length) {
          // eslint-disable-next-line no-console
          console.log("  recordings:cgi");
          // eslint-disable-next-line no-console
          console.table(sample(vodCgiItems));
        }
        if (eventsBcItems.length) {
          // eslint-disable-next-line no-console
          console.log("  events:baichuan");
          // eslint-disable-next-line no-console
          console.table(sample(eventsBcItems));
        }
        if (eventsCgiItems.length) {
          // eslint-disable-next-line no-console
          console.log("  events:cgi");
          // eslint-disable-next-line no-console
          console.table(sample(eventsCgiItems));
        }

        resultRow.recordings = {
          auto: {
            ok: vodAuto.ok,
            ms: vodAuto.ms,
            ...(vodAuto.ok ? { summary: vodAutoSummary, compliance: vodAutoCompliance } : { error: vodAuto.error }),
          },
          cgi: {
            ok: vodCgi.ok,
            ms: vodCgi.ms,
            ...(vodCgi.ok ? { summary: vodCgiSummary, compliance: vodCgiCompliance } : { error: vodCgi.error }),
          },
          overlapWithBaichuanEvents: {
            auto: overlapAutoWithBcEvents,
            cgi: overlapCgiWithBcEvents,
          },
        };

        resultRow.events = {
          baichuan: {
            ok: eventsBc.ok,
            ms: eventsBc.ms,
            ...(eventsBc.ok ? { summary: eventsBcSummary, compliance: eventsBcCompliance } : { error: eventsBc.error }),
          },
          cgi: {
            ok: eventsCgi.ok,
            ms: eventsCgi.ms,
            ...(eventsCgi.ok ? { summary: eventsCgiSummary, compliance: eventsCgiCompliance } : { error: eventsCgi.error }),
          },
        };

        summary.results.push(resultRow);
      }
    }

    if (jsonOut) {
      const outPath = path.isAbsolute(jsonOut) ? jsonOut : path.join(process.cwd(), jsonOut);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
      // eslint-disable-next-line no-console
      console.log(`\nWrote JSON summary: ${outPath}`);
    }
  } finally {
    clearTimeout(hardExitTimer);
    await api.close().catch(() => undefined);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
