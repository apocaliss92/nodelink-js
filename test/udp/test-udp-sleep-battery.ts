#!/usr/bin/env node
/**
 * Battery sleep behavior test (BCUDP).
 *
 * Every 5 seconds:
 * - reads sleep status (passive)
 * - reads battery info (best-effort; does not force reconnect/login on UDP)
 *
 * Success criteria:
 * - observe `sleeping` for a sustained period (default: 30s) within a timeout window.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fmtNow(): string {
  return new Date().toISOString();
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const channel = getNumberEnv("UDP_CHANNEL", 0);
  const intervalMs = getNumberEnv("SLEEP_TEST_INTERVAL_MS", 5000);
  const windowMs = getNumberEnv("SLEEP_TEST_WINDOW_MS", 10_000);
  const maxDurationMs = getNumberEnv("SLEEP_TEST_MAX_DURATION_MS", 10 * 60_000);
  const requireSleepingForMs = getNumberEnv("SLEEP_TEST_REQUIRE_SLEEPING_MS", 30_000);

  if (!config.udp.uid) {
    throw new Error("Missing UDP_UID in .env (required for BCUDP discovery)");
  }

  console.log("\nBCUDP Sleep/Battery Test");
  console.log(`- Host (env UDP_HOST): ${config.udp.host || ""}`);
  console.log(`- UID: ${config.udp.uid}`);
  console.log(`- Channel: ${channel}`);
  console.log(`- Interval: ${intervalMs}ms`);
  console.log(`- Sleep window: ${windowMs}ms`);
  console.log(`- Max duration: ${maxDurationMs}ms`);
  console.log(`- Require sleeping for: ${requireSleepingForMs}ms\n`);

  const api = new ReolinkBaichuanApi({
    host: config.udp.host || "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debug: false,
  });

  api.client.on("error", () => {
    // test loop prints its own status; errors are expected on battery cams (D2C_DISC)
  });

  // Initial login (wakes the camera). After this, we only do passive sleep checks + battery reads.
  await api.login();

  const startMs = Date.now();
  let sleepingSinceMs: number | undefined;

  while (Date.now() - startMs < maxDurationMs) {
    const t0 = Date.now();

    const sleepStatus = api.getSleepStatus({ channel, windowMs });

    let batteryInfoSummary = "(no battery info)";
    try {
      const batteryInfo = await api.getBatteryInfo(channel);
      const pct = batteryInfo.batteryPercent;
      batteryInfoSummary = `sleeping=${batteryInfo.sleeping ?? "?"}` + (pct != null ? ` batteryPercent=${pct}` : "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      batteryInfoSummary = `batteryError=${msg}`;
    }

    const socketConnected = api.client.isSocketConnected?.() ?? false;

    console.log(
      `${fmtNow()} ` +
        `sleep=${sleepStatus.state} socket=${socketConnected ? "connected" : "disconnected"} ` +
        `reason="${sleepStatus.reason}" ` +
        `${batteryInfoSummary}`
    );

    if (sleepStatus.state === "sleeping") {
      if (sleepingSinceMs == null) sleepingSinceMs = Date.now();
      const sleepingFor = Date.now() - sleepingSinceMs;
      if (sleepingFor >= requireSleepingForMs) {
        console.log(`\n[OK] Camera reported sleeping for >= ${requireSleepingForMs}ms`);
        await api.close();
        process.exit(0);
      }
    } else {
      sleepingSinceMs = undefined;
    }

    const elapsed = Date.now() - t0;
    const wait = Math.max(0, intervalMs - elapsed);
    await sleep(wait);
  }

  console.error(`\n[FAILED] Never observed sustained sleep for ${requireSleepingForMs}ms within ${maxDurationMs}ms`);
  await api.close();
  process.exit(1);
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});
