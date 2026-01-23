#!/usr/bin/env node
/**
 * Standalone CGI probe: tries to fetch events + recordings via HTTP CGI.
 *
 * Intended to answer: "does this device expose anything useful over CGI even when Baichuan VOD/events are empty?"
 *
 * Env:
 * - CGI_HOST (fallback: TCP_HOST)
 * - CGI_USERNAME / CGI_PASSWORD (fallback: config / TCP_USERNAME / TCP_PASSWORD)
 * - CGI_TIMEOUT_MS=5000
 * - CGI_WINDOW_HOURS=24
 * - CGI_AUTO_SEARCH_BY_DAY=0
 */

import { loadIntegrationConfig, resolveCreds } from "../helpers/config.js";
import { createTestLogger } from "../helpers/api.js";

const { ReolinkCgiApi } = (await import(new URL("../../index.js", import.meta.url).href)) as unknown as {
  ReolinkCgiApi: new (opts: { host: string; username: string; password: string; timeoutMs?: number; logger?: any }) => any;
};

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v == null) return defaultValue;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v == null) return defaultValue;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

async function main(): Promise<void> {
  const cfg = (await loadIntegrationConfig()) ?? ({ standalone: {} } as any);

  const host = process.env.CGI_HOST || process.env.TCP_HOST || cfg?.standalone?.tcp?.host;
  if (!host) {
    // eslint-disable-next-line no-console
    console.error("Missing host (set CGI_HOST or TCP_HOST, or set standalone.tcp.host in test/devices.config.json)");
    process.exit(2);
  }

  const dev = (cfg as any)?.standalone?.tcp ?? { host };
  const { username, password } = resolveCreds(cfg as any, dev as any);

  const timeoutMs = envInt("CGI_TIMEOUT_MS", 5_000);
  const windowHours = envInt("CGI_WINDOW_HOURS", 24);
  const autoSearchByDay = envBool("CGI_AUTO_SEARCH_BY_DAY", false);

  const end = new Date();
  const start = new Date(end.getTime() - windowHours * 60 * 60 * 1000);

  const logger = createTestLogger();
  const cgi = new ReolinkCgiApi({ host, username, password, timeoutMs, logger });

  // eslint-disable-next-line no-console
  console.log("\n[CGI] probing", { host, timeoutMs, windowHours, autoSearchByDay });

  await cgi.login();

  try {
    const devInfoRsp = await cgi.GetDevInfo();
    const devInfo = (devInfoRsp as any)?.[0]?.value?.DevInfo;
    // eslint-disable-next-line no-console
    console.log("[CGI] GetDevInfo", {
      model: devInfo?.model ?? devInfo?.type ?? devInfo?.exactType,
      firmVer: devInfo?.firmVer,
      diskNum: devInfo?.diskNum,
      channelNum: devInfo?.channelNum,
      wifi: devInfo?.wifi,
    });

    // Events (realtime-ish status)
    const eventsRsp = await cgi.GetEvents(0);
    // eslint-disable-next-line no-console
    console.log("[CGI] GetEvents(0)", {
      count: Array.isArray(eventsRsp) ? eventsRsp.length : 0,
      sample: Array.isArray(eventsRsp) ? eventsRsp[0] : undefined,
    });

    // Some firmwares don't support GetEvents; try state-style endpoints.
    try {
      const mdRsp = await cgi.GetMdState(0);
      // eslint-disable-next-line no-console
      console.log("[CGI] GetMdState(0)", {
        count: Array.isArray(mdRsp) ? mdRsp.length : 0,
        sample: Array.isArray(mdRsp) ? mdRsp[0] : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.log("[CGI] GetMdState(0) failed", { error: msg });
    }

    try {
      const aiRsp = await cgi.GetAiState(0);
      const value = (aiRsp as any)?.[0]?.value;
      // eslint-disable-next-line no-console
      console.log("[CGI] GetAiState(0)", {
        count: Array.isArray(aiRsp) ? aiRsp.length : 0,
        sample: Array.isArray(aiRsp) ? aiRsp[0] : undefined,
        keys: value && typeof value === "object" ? Object.keys(value) : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.log("[CGI] GetAiState(0) failed", { error: msg });
    }

    // Try to list VOD-like recordings via Search. This may work on NVR/Hub and on some standalone firmwares.
    let recordings: any[] = [];
    try {
      recordings = await cgi.listNvrRecordings({
        channel: 0,
        start,
        end,
        streamType: "main",
        iLogicChannel: 0,
        autoSearchByDay,
        bypassCache: true,
      });

      const summary = {
        motion: 0,
        person: 0,
        vehicle: 0,
        animal: 0,
        face: 0,
        package: 0,
        doorbell: 0,
        rf: 0,
        other: 0,
      };
      for (const r of recordings) {
        if (r?.hasMotion) summary.motion++;
        if (r?.hasPerson) summary.person++;
        if (r?.hasVehicle) summary.vehicle++;
        if (r?.hasAnimal) summary.animal++;
        if (r?.hasFace) summary.face++;
        if (r?.hasPackage) summary.package++;
        if (r?.hasDoorbell) summary.doorbell++;
        if (r?.hasRf) summary.rf++;
        if (r?.hasOther) summary.other++;
      }

      // eslint-disable-next-line no-console
      console.log("[CGI] Search/listNvrRecordings", {
        range: { start: start.toISOString(), end: end.toISOString() },
        total: recordings.length,
        summary,
        firstIds: recordings.slice(0, 3).map((r) => r?.id).filter(Boolean),
        sample: recordings[0]
          ? {
              name: recordings[0].name,
              id: recordings[0].id,
              startTimeMs: recordings[0].startTimeMs,
              endTimeMs: recordings[0].endTimeMs,
              hasMotion: recordings[0].hasMotion,
              hasPerson: recordings[0].hasPerson,
              hasVehicle: recordings[0].hasVehicle,
              hasAnimal: recordings[0].hasAnimal,
            }
          : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.log("[CGI] Search/listNvrRecordings failed", { error: msg });
    }

    if ((recordings?.length ?? 0) === 0) {
      // eslint-disable-next-line no-console
      console.log(
        "[Hint] If you expect clips: ensure the camera has storage (SD/NVR) and recording is enabled; CGI Search often returns 0 when no storage/recording.",
      );
    }
  } finally {
    await cgi.logout().catch(() => undefined);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
