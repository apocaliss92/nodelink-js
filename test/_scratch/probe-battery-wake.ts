/**
 * Does the manager's per-connect path wake a sleeping battery camera?
 *
 * Established on the wired camera: every `buildVideoStreamOptions()` issues a
 * GetEnc to the camera (the instance cache is a fallback, not a read-avoider),
 * and the manager calls it on every camera connect via
 * `onApiConnected → getAvailableProfiles`.
 *
 * This checks the consequence on the camera that actually matters: a battery
 * camera that is currently asleep.
 *
 *   npx tsx test/_scratch/probe-battery-wake.ts
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
});

const HOST = process.env.UDP_SLEEP_HOST!;
const UID = process.env.UDP_SLEEP_UID!;

async function main(): Promise<void> {
  console.log(`Battery camera ${HOST} (uid=${UID})\n`);

  const api = new ReolinkBaichuanApi({
    host: HOST,
    port: 9000,
    username: process.env.UDP_SLEEP_USERNAME!,
    password: process.env.UDP_SLEEP_PASSWORD!,
    transport: "auto",
    uid: UID,
  });

  const events: Array<{ t: number; type: string }> = [];
  const t0 = Date.now();
  try {
    await api.onSimpleEvent((e: any) => {
      events.push({ t: Date.now() - t0, type: String(e?.type) });
      console.log(`  [event +${Date.now() - t0}ms] ${e?.type}`);
    });
  } catch {
    // Event subscription is best-effort here.
  }

  const tLogin = Date.now();
  await api.login();
  console.log(`login ok in ${Date.now() - tLogin}ms (transport=${api.client.getTransport()})\n`);

  let encCalls = 0;
  const orig = (api as any).getEncXml.bind(api);
  (api as any).getEncXml = async (...a: unknown[]) => {
    encCalls++;
    const s = Date.now();
    const r = await orig(...a);
    console.log(`  getEncXml #${encCalls} took ${Date.now() - s}ms`);
    return r;
  };

  for (let i = 1; i <= 3; i++) {
    const s = Date.now();
    try {
      await api.buildVideoStreamOptions({ channel: 0, onNvr: false });
      console.log(`buildVideoStreamOptions #${i}: ${Date.now() - s}ms, cumulative getEncXml=${encCalls}`);
    } catch (e) {
      console.log(`buildVideoStreamOptions #${i}: FAILED after ${Date.now() - s}ms — ${(e as Error).message}`);
    }
  }

  console.log(
    `\nRESULT: ${encCalls} GetEnc command(s) sent to a battery camera for 3 profile lookups.`,
  );
  console.log(`events seen: ${events.map((e) => `${e.type}@+${e.t}ms`).join(", ") || "(none)"}`);

  await api.disconnect?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(`FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
