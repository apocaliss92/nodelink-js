#!/usr/bin/env node
/**
 * NVR/HUB Baichuan alarm-events test
 *
 * Calls ReolinkBaichuanApi.listNvrAlarmEventsViaBaichuan() against the device configured via env (NVR_HOST).
 *
 * Env:
 * - NVR_HOST, NVR_USERNAME, NVR_PASSWORD (required)
 * - EVENTS_HOURS (default 6)
 * - EVENTS_START_ISO / EVENTS_END_ISO (override time window)
 * - EVENTS_CHANNELS (e.g. "0,1,2"; optional)
 * - EVENTS_STREAM_TYPE ("mainStream" | "subStream"; optional)
 * - EVENTS_MAX_ITER (default 50)
 * - EVENTS_ALARM_TYPE (override alarmType list; optional)
 * - EVENTS_COMPARE=1 to compare Baichuan alarm-events vs listNvrRecordings(source=baichuan)
 * - EVENTS_COMPARE_INCLUDE_CGI=1 to also compare listNvrRecordings(source=cgi)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

type AlarmEvent = {
  channel: number;
  uid?: string;
  fileName: string;
  recordType?: string;
  startTime?: Date;
  endTime?: Date;
};

type EnrichedAlarmEvent = AlarmEvent & {
  hasPerson: boolean;
  hasVehicle: boolean;
  hasAnimal: boolean;
  hasFace: boolean;
  hasMotion: boolean;
  hasSchedule: boolean;
  hasDoorbell: boolean;
  hasPackage: boolean;
  hasRf: boolean;
  hasOther: boolean;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
};

type EnrichedRecording = {
  fileName: string;
  recordType?: string;
  hasPerson: boolean;
  hasVehicle: boolean;
  hasAnimal: boolean;
  hasFace: boolean;
  hasMotion: boolean;
  hasSchedule: boolean;
  hasDoorbell: boolean;
  hasPackage: boolean;
  hasRf: boolean;
  hasOther: boolean;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${label})`)), ms);
      // Don't keep the process alive just for the timer
      // (Node supports this on Timeout objects)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t as any).unref?.();
    }),
  ]) as Promise<T>;
}

function parseChannelsEnv(v: string | undefined): number[] | undefined {
  if (!v) return undefined;
  const parts = v
    .split(/[,:\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = parts
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.floor(n));
  return nums.length ? Array.from(new Set(nums)) : undefined;
}

function parseDateEnv(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return undefined;
  return d;
}

async function main(): Promise<void> {
  const { host, username, password, uid } = config.nvr;
  if (!host) throw new Error("Missing NVR_HOST in .env");
  if (!username) throw new Error("Missing NVR_USERNAME in .env");
  if (!password) throw new Error("Missing NVR_PASSWORD in .env");

  const startIso = process.env.EVENTS_START_ISO;
  const endIso = process.env.EVENTS_END_ISO;
  const hours = Number(process.env.EVENTS_HOURS ?? "6");
  const maxIterations = Number(process.env.EVENTS_MAX_ITER ?? "50");

  const now = new Date();
  const start = parseDateEnv(startIso) ?? new Date(now.getTime() - (Number.isFinite(hours) ? hours : 6) * 60 * 60 * 1000);
  const end = parseDateEnv(endIso) ?? now;

  const channels = parseChannelsEnv(process.env.EVENTS_CHANNELS);
  const streamType = process.env.EVENTS_STREAM_TYPE as ("mainStream" | "subStream" | undefined);
  const alarmType = process.env.EVENTS_ALARM_TYPE;
  const source = (process.env.EVENTS_SOURCE ?? "auto").trim().toLowerCase();
  const printAll = /^(1|true|yes)$/i.test(process.env.EVENTS_PRINT_ALL ?? "");
  const maxPrint = Number(process.env.EVENTS_MAX_PRINT ?? "10");
  const jsonOut = (process.env.EVENTS_JSON_OUT ?? "").trim();
  const compareMode = /^(1|true|yes)$/i.test(process.env.EVENTS_COMPARE ?? "");
  const compareIncludeCgi = /^(1|true|yes)$/i.test(process.env.EVENTS_COMPARE_INCLUDE_CGI ?? "");
  const compareMaxChannels = Number(process.env.EVENTS_COMPARE_MAX_CHANNELS ?? "0");

  console.log("\n" + "=".repeat(80));
  console.log("TEST: NVR/HUB alarm events via Baichuan (findAlarmVideo 272/273/274)");
  console.log("=".repeat(80));
  console.log(`Host: ${host}`);
  console.log(`User: ${username}`);
  console.log(
    `Window: start=${start.toISOString()} end=${end.toISOString()} (hours=${Number.isFinite(hours) ? hours : "invalid"})`,
  );
  if (channels?.length) console.log(`Channels: ${channels.join(", ")}`);
  if (streamType) console.log(`StreamType: ${streamType}`);
  if (alarmType) console.log(`AlarmType override: ${alarmType}`);
  console.log(`Source: ${source} (auto|baichuan|cgi)`);
  if (compareMode) console.log(`Compare: enabled (includeCgi=${compareIncludeCgi ? "yes" : "no"})`);
  if (printAll) console.log("PrintAll: enabled");
  if (jsonOut) console.log(`JsonOut: ${jsonOut}`);
  const traceRecordings = /^(1|true|yes)$/i.test(process.env.TRACE_RECORDINGS ?? "");
  if (traceRecordings) console.log("TraceRecordings: enabled");
  console.log("");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid,
    timeoutMs: 30_000,
    ...(traceRecordings ? { debugOptions: { traceRecordings: true } } : {}),
  });

  const scriptTimeoutMs = Number(process.env.SCRIPT_TIMEOUT_MS ?? "240000");
  const hardExitMs = Number(process.env.HARD_EXIT_MS ?? String(scriptTimeoutMs + 60_000));
  const hardExitTimer = setTimeout(() => {
    console.error(`Hard exit after ${hardExitMs}ms (HARD_EXIT_MS).`);
    process.exit(2);
  }, hardExitMs);

  try {
    console.log("Logging in...");
    await withTimeout(api.login(), 45_000, "api.login");
    console.log("Login OK\n");

    const normalizeName = (s: string | undefined): string => (typeof s === "string" ? s.trim() : "");
    const isEventLike = (r: { hasMotion?: boolean; hasPerson?: boolean; hasVehicle?: boolean; hasAnimal?: boolean; hasFace?: boolean; hasDoorbell?: boolean; hasPackage?: boolean; hasRf?: boolean; hasOther?: boolean }): boolean =>
      Boolean(
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

    const eventKey = (name: string): string => normalizeName(name);

    const buildIndex = <T extends { fileName: string }>(items: T[]): Map<string, T> => {
      const m = new Map<string, T>();
      for (const it of items) {
        const k = eventKey(it.fileName);
        if (!k) continue;
        if (!m.has(k)) m.set(k, it);
      }
      return m;
    };

    const diffSets = (a: Map<string, unknown>, b: Map<string, unknown>) => {
      const onlyA: string[] = [];
      const onlyB: string[] = [];
      for (const k of a.keys()) if (!b.has(k)) onlyA.push(k);
      for (const k of b.keys()) if (!a.has(k)) onlyB.push(k);
      onlyA.sort();
      onlyB.sort();
      return { onlyA, onlyB };
    };

    const compareDetections = (a: EnrichedAlarmEvent, b: EnrichedRecording): string[] => {
      const mismatches: string[] = [];
      const pairs: Array<[string, boolean, boolean]> = [
        ["person", a.hasPerson, b.hasPerson],
        ["vehicle", a.hasVehicle, b.hasVehicle],
        ["animal", a.hasAnimal, b.hasAnimal],
        ["face", a.hasFace, b.hasFace],
        ["motion", a.hasMotion, b.hasMotion],
        ["doorbell", a.hasDoorbell, b.hasDoorbell],
        ["package", a.hasPackage, b.hasPackage],
        ["rf", a.hasRf, b.hasRf],
        ["other", a.hasOther, b.hasOther],
      ];
      for (const [k, av, bv] of pairs) if (Boolean(av) !== Boolean(bv)) mismatches.push(k);
      return mismatches;
    };

    const abs = (n: number): number => (n < 0 ? -n : n);
    const msToIso = (ms: number | undefined): string | undefined => {
      if (ms == null) return undefined;
      if (!Number.isFinite(ms) || ms <= 0) return undefined;
      return new Date(ms).toISOString();
    };

    const getChannelsForCompare = async (alarms?: EnrichedAlarmEvent[]): Promise<number[]> => {
      // 1) Explicit env override wins.
      if (channels?.length) return channels;

      // 2) Default: only channels that actually returned alarm-events (fast + avoids placeholder channels).
      const fromAlarms = (alarms ?? [])
        .map((a) => a.channel)
        .filter((n) => Number.isFinite(n) && n >= 0)
        .map((n) => Math.floor(n));
      const uniqFromAlarms = Array.from(new Set(fromAlarms)).sort((a, b) => a - b);
      if (uniqFromAlarms.length) return uniqFromAlarms;

      // 3) Fallback: support.channelNum.
      try {
        const support = await api.getSupportInfo();
        const chNum = (support as any)?.channelNum;
        if (typeof chNum === "number" && Number.isFinite(chNum) && chNum > 0) {
          return Array.from({ length: chNum }, (_, i) => i);
        }
      } catch {
        // ignore
      }
      return [0];
    };

    const fetchBaichuan = async (): Promise<EnrichedAlarmEvent[]> =>
      (api.listNvrAlarmEventsEnrichedViaBaichuan({
        start,
        end,
        ...(channels ? { channels } : {}),
        ...(streamType ? { streamType } : {}),
        ...(alarmType ? { alarmType } : {}),
        ...(Number.isFinite(maxIterations) ? { maxIterations } : {}),
      }) as Promise<EnrichedAlarmEvent[]>);

    const fetchCgi = async (): Promise<EnrichedAlarmEvent[]> =>
      (api.listNvrAlarmEventsEnrichedViaCgi({
        start,
        end,
        ...(channels ? { channels } : {}),
        ...(streamType ? { streamType } : {}),
      }) as Promise<EnrichedAlarmEvent[]>);

    const fetchRecordings = async (opts: { channel: number; source: "baichuan" | "cgi" }): Promise<EnrichedRecording[]> => {
      // listNvrRecordings uses CGI params shape; our Baichuan implementation maps streamType by name.
      const recs = (await api.listNvrRecordings({
        channel: opts.channel,
        start,
        end,
        ...(streamType ? { streamType } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      } as any)) as EnrichedRecording[];

      // For comparison with alarm-events, only keep event-like items.
      return recs.filter((r) => isEventLike(r));
    };

    if (compareMode) {
      const alarms = await withTimeout(fetchBaichuan(), scriptTimeoutMs, "api.listNvrAlarmEventsEnrichedViaBaichuan");
      let chs = await withTimeout(getChannelsForCompare(alarms), 15_000, "getChannelsForCompare");
      if (Number.isFinite(compareMaxChannels) && compareMaxChannels > 0) {
        chs = chs.slice(0, Math.floor(compareMaxChannels));
      }
      console.log(`\nCompare channels: ${chs.join(", ")}`);

      const alarmsByCh = new Map<number, EnrichedAlarmEvent[]>();
      for (const a of alarms) {
        const list = alarmsByCh.get(a.channel) ?? [];
        list.push(a);
        alarmsByCh.set(a.channel, list);
      }

      const perChannelResults: Array<{
        channel: number;
        alarmCount: number;
        recBaichuanCount: number;
        recCgiCount?: number;
        onlyInAlarms: string[];
        onlyInRecordingsBaichuan: string[];
        onlyInRecordingsCgi?: string[];
        mismatchedDetections: Array<{ fileName: string; fields: string[] }>;
        timeSkewMs: Array<{ fileName: string; startDeltaMs: number; endDeltaMs: number }>;
      }> = [];

      for (const ch of chs) {
        const alarmList = (alarmsByCh.get(ch) ?? []).slice();
        const recBaichuan = await withTimeout(fetchRecordings({ channel: ch, source: "baichuan" }), scriptTimeoutMs, `api.listNvrRecordings(${ch},baichuan)`);
        const recCgi = compareIncludeCgi
          ? await withTimeout(fetchRecordings({ channel: ch, source: "cgi" }), scriptTimeoutMs, `api.listNvrRecordings(${ch},cgi)`)
          : undefined;

        const alarmIdx = buildIndex(alarmList);
        const recIdx = buildIndex(recBaichuan);
        const recCgiIdx = recCgi ? buildIndex(recCgi) : undefined;

        const { onlyA: onlyInAlarms, onlyB: onlyInRecordingsBaichuan } = diffSets(alarmIdx, recIdx);
        const onlyInRecordingsCgi = recCgiIdx ? diffSets(alarmIdx, recCgiIdx).onlyB : undefined;

        const mismatchedDetections: Array<{ fileName: string; fields: string[] }> = [];
        const timeSkewMs: Array<{ fileName: string; startDeltaMs: number; endDeltaMs: number }> = [];

        for (const [k, a] of alarmIdx.entries()) {
          const b = recIdx.get(k) as EnrichedRecording | undefined;
          if (!b) continue;
          const aa = a as EnrichedAlarmEvent;

          const det = compareDetections(aa, b);
          if (det.length) mismatchedDetections.push({ fileName: k, fields: det });

          const startDeltaMs = (aa.startTimeMs ?? 0) - (b.startTimeMs ?? 0);
          const endDeltaMs = (aa.endTimeMs ?? 0) - (b.endTimeMs ?? 0);
          if (abs(startDeltaMs) > 2000 || abs(endDeltaMs) > 2000) {
            timeSkewMs.push({ fileName: k, startDeltaMs, endDeltaMs });
          }
        }

        perChannelResults.push({
          channel: ch,
          alarmCount: alarmList.length,
          recBaichuanCount: recBaichuan.length,
          ...(recCgi ? { recCgiCount: recCgi.length } : {}),
          onlyInAlarms,
          onlyInRecordingsBaichuan,
          ...(onlyInRecordingsCgi ? { onlyInRecordingsCgi } : {}),
          mismatchedDetections,
          timeSkewMs,
        });
      }

      console.log("\n" + "=".repeat(80));
      console.log("COMPARE RESULT (alarm-events vs listNvrRecordings)");
      console.log("=".repeat(80));
      for (const r of perChannelResults) {
        console.log("-".repeat(80));
        console.log(
          `Channel ${r.channel}: alarms=${r.alarmCount} recordings.baichuan=${r.recBaichuanCount}` +
            (r.recCgiCount !== undefined ? ` recordings.cgi=${r.recCgiCount}` : ""),
        );

        const showList = (title: string, items: string[], limit = 8) => {
          if (!items.length) return;
          console.log(`  ${title}: ${items.length}`);
          for (const n of items.slice(0, limit)) console.log(`    - ${n}`);
          if (items.length > limit) console.log(`    ... +${items.length - limit} more`);
        };

        showList("only in alarms", r.onlyInAlarms);
        showList("only in recordings (baichuan)", r.onlyInRecordingsBaichuan);
        if (r.onlyInRecordingsCgi) showList("only in recordings (cgi)", r.onlyInRecordingsCgi);

        if (r.mismatchedDetections.length) {
          console.log(`  detection mismatches: ${r.mismatchedDetections.length}`);
          for (const m of r.mismatchedDetections.slice(0, 8)) {
            console.log(`    - ${m.fileName}: ${m.fields.join(", ")}`);
          }
          if (r.mismatchedDetections.length > 8) console.log(`    ... +${r.mismatchedDetections.length - 8} more`);
        }

        if (r.timeSkewMs.length) {
          console.log(`  time skew >2s: ${r.timeSkewMs.length}`);
          for (const t of r.timeSkewMs.slice(0, 8)) {
            console.log(`    - ${t.fileName}: startΔ=${t.startDeltaMs}ms endΔ=${t.endDeltaMs}ms`);
          }
          if (r.timeSkewMs.length > 8) console.log(`    ... +${r.timeSkewMs.length - 8} more`);
        }
      }

      if (jsonOut) {
        const outPath = path.resolve(process.cwd(), jsonOut);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(
          outPath,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              host,
              username,
              window: { start: start.toISOString(), end: end.toISOString() },
              channels: chs,
              compareIncludeCgi,
              results: perChannelResults,
            },
            null,
            2,
          ),
          "utf8",
        );
        console.log(`\nWrote compare JSON: ${outPath}`);
      }

      return;
    }

    let events: EnrichedAlarmEvent[] = [];
    if (source === "cgi") {
      events = await withTimeout(fetchCgi(), scriptTimeoutMs, "api.listNvrAlarmEventsEnrichedViaCgi");
    } else if (source === "baichuan") {
      events = await withTimeout(fetchBaichuan(), scriptTimeoutMs, "api.listNvrAlarmEventsEnrichedViaBaichuan");
    } else {
      events = await withTimeout(fetchBaichuan(), scriptTimeoutMs, "api.listNvrAlarmEventsEnrichedViaBaichuan");
      if (events.length === 0) {
        console.log("No events via Baichuan; falling back to CGI VOD search...\n");
        events = await withTimeout(fetchCgi(), scriptTimeoutMs, "api.listNvrAlarmEventsEnrichedViaCgi");
      }
    }

    console.log(`Returned ${events.length} event(s)\n`);

    const byChannel = new Map<number, AlarmEvent[]>();
    for (const ev of events) {
      const list = byChannel.get(ev.channel) ?? [];
      list.push(ev);
      byChannel.set(ev.channel, list);
    }

    const dump = {
      generatedAt: new Date().toISOString(),
      host,
      username,
      source: "baichuan",
      window: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      events: events.map((e) => {
        const ee = e as EnrichedAlarmEvent;
        return {
          channel: ee.channel,
          uid: ee.uid,
          fileName: ee.fileName,
          recordType: ee.recordType,
          startTime: msToIso(ee.startTimeMs),
          endTime: msToIso(ee.endTimeMs),
          startTimeMs: ee.startTimeMs,
          endTimeMs: ee.endTimeMs,
          durationMs: ee.durationMs,
          detections: {
            person: ee.hasPerson,
            vehicle: ee.hasVehicle,
            animal: ee.hasAnimal,
            face: ee.hasFace,
            motion: ee.hasMotion,
            schedule: ee.hasSchedule,
            doorbell: ee.hasDoorbell,
            package: ee.hasPackage,
            rf: ee.hasRf,
            other: ee.hasOther,
          },
        };
      }),
    };

    if (jsonOut || /^(1|true|yes)$/i.test(process.env.EVENTS_WRITE_JSON ?? "")) {
      const defaultName = `nvr_alarm_events_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      const outPath = jsonOut
        ? path.resolve(process.cwd(), jsonOut)
        : path.resolve(process.cwd(), "test", "diagnostics-dumps", defaultName);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(dump, null, 2), "utf8");
      console.log(`\nWrote JSON: ${outPath}`);
    }

    for (const [ch, list] of [...byChannel.entries()].sort((a, b) => a[0] - b[0])) {
      const sorted = [...list].sort((a, b) => {
        const as = (a as EnrichedAlarmEvent).startTimeMs ?? 0;
        const bs = (b as EnrichedAlarmEvent).startTimeMs ?? 0;
        return as - bs;
      });

      console.log("-".repeat(80));
      console.log(`Channel ${ch}: ${sorted.length} event(s)`);

      const counts = {
        person: 0,
        vehicle: 0,
        animal: 0,
        face: 0,
        motion: 0,
        schedule: 0,
        doorbell: 0,
        pkg: 0,
        rf: 0,
        other: 0,
      };

      for (const e of sorted as EnrichedAlarmEvent[]) {
        if (e.hasPerson) counts.person++;
        if (e.hasVehicle) counts.vehicle++;
        if (e.hasAnimal) counts.animal++;
        if (e.hasFace) counts.face++;
        if (e.hasMotion) counts.motion++;
        if (e.hasSchedule) counts.schedule++;
        if (e.hasDoorbell) counts.doorbell++;
        if (e.hasPackage) counts.pkg++;
        if (e.hasRf) counts.rf++;
        if (e.hasOther) counts.other++;
      }

      console.log(
        `Detections: person=${counts.person} vehicle=${counts.vehicle} animal=${counts.animal} face=${counts.face} motion=${counts.motion} package=${counts.pkg} doorbell=${counts.doorbell} rf=${counts.rf} other=${counts.other} sched=${counts.schedule}`,
      );

      const limit = printAll ? sorted.length : (Number.isFinite(maxPrint) && maxPrint > 0 ? Math.floor(maxPrint) : 10);
      const preview = sorted.slice(0, limit).map((e) => ({
        fileName: e.fileName,
        recordType: e.recordType,
        startTime: msToIso((e as EnrichedAlarmEvent).startTimeMs),
        endTime: msToIso((e as EnrichedAlarmEvent).endTimeMs),
        detections: {
          person: (e as EnrichedAlarmEvent).hasPerson,
          vehicle: (e as EnrichedAlarmEvent).hasVehicle,
          animal: (e as EnrichedAlarmEvent).hasAnimal,
          face: (e as EnrichedAlarmEvent).hasFace,
          motion: (e as EnrichedAlarmEvent).hasMotion,
          package: (e as EnrichedAlarmEvent).hasPackage,
          doorbell: (e as EnrichedAlarmEvent).hasDoorbell,
        },
      }));

      for (const p of preview) {
        console.log(
          `  - ${p.startTime ?? "(no startTime)"} → ${p.endTime ?? "(no endTime)"} type=${p.recordType ?? "?"} detections=${JSON.stringify(
            p.detections,
          )} file=${p.fileName}`,
        );
      }

      if (!printAll && sorted.length > preview.length) console.log(`  ... +${sorted.length - preview.length} more`);
    }

    console.log("\nDone.");
  } finally {
    await withTimeout(api.close().catch(() => undefined), 10_000, "api.close");
    clearTimeout(hardExitTimer);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
