#!/usr/bin/env node
/**
 * Fast sanity test: VOD listings should be responsive (few seconds) and
 * enriched recordings should pick up AI detections when available.
 *
 * Uses config from test/devices.config.json (or REOLINK_TEST_CONFIG).
 *
 * Env:
 * - TCP_HOST / TCP_USERNAME / TCP_PASSWORD (standalone)
 * - NVR_HOST / NVR_USERNAME / NVR_PASSWORD (optional)
 */

import { loadIntegrationConfig, resolveCreds } from "../helpers/config.js";
import { closeApi, createTcpApi, createTestLogger } from "../helpers/api.js";

function nowMs(): number {
  return Date.now();
}

function summarizeDetections(label: string, recs: any[]): void {
  const counts = {
    total: recs.length,
    person: 0,
    vehicle: 0,
    animal: 0,
    face: 0,
    motion: 0,
    doorbell: 0,
    pkg: 0,
    other: 0,
  };

  for (const r of recs) {
    if (r?.hasPerson) counts.person++;
    if (r?.hasVehicle) counts.vehicle++;
    if (r?.hasAnimal) counts.animal++;
    if (r?.hasFace) counts.face++;
    if (r?.hasMotion) counts.motion++;
    if (r?.hasDoorbell) counts.doorbell++;
    if (r?.hasPackage) counts.pkg++;
    if (r?.hasOther) counts.other++;
  }

  // eslint-disable-next-line no-console
  console.log(`${label} detections:`, counts);
}

async function runStandalone(cfg: any): Promise<void> {
  const dev = cfg?.standalone?.tcp;
  if (!dev?.host) return;

  const timeoutMs = 3_000;

  const { username, password } = resolveCreds(cfg, dev);
  const logger = createTestLogger();
  const api = createTcpApi({ dev, username, password, logger });

  try {
    const end = new Date();

    const windowHoursRaw = process.env.STANDALONE_WINDOW_HOURS;
    const windowHours = windowHoursRaw != null ? Number(windowHoursRaw) : undefined;

    const today = process.env.STANDALONE_TODAY === "1";
    const start = today
      ? new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0)
      : new Date(end.getTime() - (Number.isFinite(windowHours) ? (windowHours as number) : 2) * 60 * 60 * 1000);

    const recordType = process.env.STANDALONE_RECORD_TYPE;

    const t0 = nowMs();
    await api.login();
    const tLogin = nowMs();

    const recs = await api.listDeviceRecordings({
      channel: dev.channel ?? 0,
      start,
      end,
      streamType: "mainStream",
      count: 50,
      timeoutMs,
      ...(recordType ? { recordType } : {}),
    });
    const t1 = nowMs();

    // eslint-disable-next-line no-console
    console.log(`\n[Standalone TCP] host=${dev.host}`);
    // eslint-disable-next-line no-console
    console.log(`login: ${tLogin - t0}ms, listDeviceRecordings: ${t1 - tLogin}ms, total: ${t1 - t0}ms`);
    summarizeDetections("standalone", recs);

    // Print a couple samples
    for (const r of recs.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.log(`- ${r.fileName} flags={motion:${r.hasMotion}, person:${r.hasPerson}, vehicle:${r.hasVehicle}, animal:${r.hasAnimal}, face:${r.hasFace}, doorbell:${r.hasDoorbell}, package:${r.hasPackage}}`);
    }
  } finally {
    await closeApi(api);
  }
}

async function runNvr(cfg: any): Promise<void> {
  const dev = cfg?.nvr;
  if (!dev?.host) return;

  const timeoutMs = 3_000;

  const { username, password } = resolveCreds(cfg, dev);
  const logger = createTestLogger();
  const api = createTcpApi({ dev, username, password, logger });

  try {
    const end = new Date();

    const windowHoursRaw = process.env.NVR_WINDOW_HOURS;
    const windowHours = windowHoursRaw != null ? Number(windowHoursRaw) : undefined;

    const today = process.env.NVR_TODAY === "1";
    const start = today
      ? new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0)
      : new Date(end.getTime() - (Number.isFinite(windowHours) ? (windowHours as number) : 2) * 60 * 60 * 1000);
    const envChannelRaw = process.env.NVR_CHANNEL;
    const envChannel = envChannelRaw != null ? Number(envChannelRaw) : undefined;
    const channel = Number.isFinite(envChannel) ? (envChannel as number) : (dev.channel ?? 0);

    const t0 = nowMs();
    await api.login();
    const tLogin = nowMs();

    const recs = await api.listNvrRecordings({
      channel,
      start,
      end,
      streamType: "main",
      autoSearchByDay: false,
      fetchStreamUrls: false,
      timeoutMs,
      source: "baichuan",
    });
    const t1 = nowMs();

    // eslint-disable-next-line no-console
    console.log(`\n[NVR/Hub] host=${dev.host} channel=${channel}`);
    // eslint-disable-next-line no-console
    console.log(`login: ${tLogin - t0}ms, listNvrRecordings: ${t1 - tLogin}ms, total: ${t1 - t0}ms`);
    summarizeDetections("nvr", recs);

    for (const r of recs.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.log(`- ${r.fileName} flags={motion:${r.hasMotion}, person:${r.hasPerson}, vehicle:${r.hasVehicle}, animal:${r.hasAnimal}, face:${r.hasFace}, doorbell:${r.hasDoorbell}, package:${r.hasPackage}}`);
    }
  } finally {
    await closeApi(api);
  }
}

async function main(): Promise<void> {
  const cfg = await loadIntegrationConfig();
  if (!cfg) {
    // eslint-disable-next-line no-console
    console.error("Missing test config. Create test/devices.config.json or set REOLINK_TEST_CONFIG.");
    process.exit(2);
  }

  await runStandalone(cfg);
  await runNvr(cfg);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
