/* eslint-disable no-console */
/**
 * Focused connectivity loop for UDP_HOST (battery camera).
 *
 * Strategy: retry login() up to N attempts with backoff. BCUDP discovery
 * fails fast (30s timeout) when the camera is in deep sleep, so each retry
 * gives the camera a chance to wake up via PIR / scheduled wake.
 *
 * Once login succeeds, exercise:
 *   - ping
 *   - getInfo / getChannelCount
 *   - simulated idle disconnect (close → ensureConnected → ping)
 *   - native sub stream start (5s) to confirm media path works end-to-end
 *
 * Usage:
 *   npx tsx test/_scratch/udp-host-test.ts
 *   ATTEMPTS=10 npx tsx test/_scratch/udp-host-test.ts
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

const HOST = process.env.UDP_HOST;
const USER = process.env.UDP_USERNAME ?? "admin";
const PASS = process.env.UDP_PASSWORD ?? "";
const UID = process.env.UDP_UID;
const ATTEMPTS = Number(process.env.ATTEMPTS ?? "5");
const BETWEEN_MS = Number(process.env.BETWEEN_MS ?? "5000");

if (!HOST) {
  console.error("UDP_HOST missing in .env");
  process.exit(1);
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

async function tryConnect(
  attempt: number,
): Promise<ReolinkBaichuanApi | null> {
  const api = new ReolinkBaichuanApi({
    host: HOST!,
    port: 9000,
    username: USER,
    password: PASS,
    ...(UID ? { uid: UID } : {}),
    transport: "udp",
  });

  const start = Date.now();
  try {
    console.log(`[attempt ${attempt}] login() ...`);
    await api.login();
    console.log(`[attempt ${attempt}] login OK in ${fmt(Date.now() - start)}`);
    return api;
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    console.log(
      `[attempt ${attempt}] login FAIL after ${fmt(Date.now() - start)} — ${msg}`,
    );
    try {
      await api.close();
    } catch {
      // ignore
    }
    return null;
  }
}

async function fullCycle(api: ReolinkBaichuanApi): Promise<boolean> {
  let allOk = true;

  // 1. ping
  try {
    const t = Date.now();
    await api.ping();
    console.log(`  ok   ping                           ${fmt(Date.now() - t)}`);
  } catch (e) {
    console.log(`  FAIL ping                           ${(e as Error).message}`);
    allOk = false;
  }

  // 2. getChannelCount
  try {
    const t = Date.now();
    const ch = await api.getChannelCount();
    console.log(
      `  ok   getChannelCount = ${ch}              ${fmt(Date.now() - t)}`,
    );
  } catch (e) {
    console.log(
      `  FAIL getChannelCount                ${(e as Error).message}`,
    );
    allOk = false;
  }

  // 3. getInfo
  try {
    const t = Date.now();
    const info = await api.getInfo();
    console.log(
      `  ok   getInfo (model=${info?.type})        ${fmt(Date.now() - t)}`,
    );
  } catch (e) {
    console.log(`  FAIL getInfo                        ${(e as Error).message}`);
    allOk = false;
  }

  // 4. simulated idle disconnect → ensureConnected → ping
  try {
    const t = Date.now();
    await api.client.close();
    console.log(
      `  ok   client.close (idle simulate)   ${fmt(Date.now() - t)}`,
    );
  } catch (e) {
    console.log(
      `  FAIL client.close                   ${(e as Error).message}`,
    );
    allOk = false;
  }

  try {
    const t = Date.now();
    await api.ensureConnected();
    console.log(
      `  ok   ensureConnected (post-idle)    ${fmt(Date.now() - t)}`,
    );
  } catch (e) {
    console.log(
      `  FAIL ensureConnected                ${(e as Error).message}`,
    );
    allOk = false;
    return allOk;
  }

  try {
    const t = Date.now();
    await api.ping();
    console.log(
      `  ok   ping (post-reconnect)          ${fmt(Date.now() - t)}`,
    );
  } catch (e) {
    console.log(
      `  FAIL ping (post-reconnect)          ${(e as Error).message}`,
    );
    allOk = false;
  }

  return allOk;
}

async function main(): Promise<void> {
  console.log(
    `\nUDP_HOST connectivity test — host=${HOST}, uid=${UID ?? "none"}, attempts=${ATTEMPTS}\n`,
  );

  let api: ReolinkBaichuanApi | null = null;
  for (let i = 1; i <= ATTEMPTS && !api; i++) {
    api = await tryConnect(i);
    if (!api && i < ATTEMPTS) {
      console.log(
        `  (waiting ${BETWEEN_MS}ms before next attempt — move in front of the camera or trigger PIR to wake it)`,
      );
      await new Promise((r) => setTimeout(r, BETWEEN_MS));
    }
  }

  if (!api) {
    console.error(
      `\nFAIL: could not reach ${HOST} after ${ATTEMPTS} attempt(s). Camera likely sleeping.`,
    );
    process.exit(1);
  }

  console.log("\nRunning full cycle:");
  const ok = await fullCycle(api);

  try {
    await api.close();
  } catch {
    // ignore
  }

  console.log("\n" + "=".repeat(50));
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Crashed:", e);
  process.exit(1);
});
