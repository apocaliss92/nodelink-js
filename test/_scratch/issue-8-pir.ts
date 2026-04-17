/* eslint-disable no-console */
/**
 * Reproduction harness for issue #8 point 2:
 *   "Testing some capabilities like toggling PIR from HA MQTT : not working
 *    [homeassistant-mqtt] Command pir failed: Error: Baichuan timeout cmdId=212 msgNum=17"
 *
 * cmdId 212 is BC_CMD_ID_GET_PIR_INFO. setPirInfo() internally does GET→modify→SET,
 * so the GET is where the timeout hits.
 *
 * This script exercises getPirInfo and setPirInfo against every battery
 * channel behind the NVR (Argus 3E, Argus PT Ultra) and records whether each
 * call succeeds or times out.
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function testPirOnChannel(api: ReolinkBaichuanApi, ch: number, label: string) {
  console.log(`\n  ── ch${ch} (${label}) ──`);

  // 1) GET
  const t0 = Date.now();
  let currentEnabled: number | undefined;
  try {
    const info = await api.getPirInfo(ch);
    const dt = Date.now() - t0;
    currentEnabled = info.enabled ? 1 : 0;
    console.log(
      `    GET getPirInfo  ok in ${dt}ms  enabled=${info.enabled} sensitive=${info.sensitive ?? "?"} reduceFalseAlarm=${info.reduceFalseAlarm ?? "?"}`,
    );
  } catch (e) {
    const dt = Date.now() - t0;
    console.log(`    GET getPirInfo  FAILED after ${dt}ms: ${e}`);
    return; // can't proceed to SET without the current value
  }

  // 2) SET idempotent: write back the same enable value.
  //    This exercises the same full GET→modify→SET flow HA MQTT runs.
  const t1 = Date.now();
  try {
    await api.setPirInfo(ch, { enable: currentEnabled ?? 1 });
    const dt = Date.now() - t1;
    console.log(`    SET setPirInfo  ok in ${dt}ms  (wrote enable=${currentEnabled})`);
  } catch (e) {
    const dt = Date.now() - t1;
    console.log(`    SET setPirInfo  FAILED after ${dt}ms: ${e}`);
  }
}

async function main() {
  const host = process.env.NVR_HOST!;
  const username = process.env.NVR_USERNAME ?? "admin";
  const password = process.env.NVR_PASSWORD ?? "";
  if (!host) throw new Error("NVR_HOST not set");

  const api = new ReolinkBaichuanApi({ host, username, password });
  await api.login();
  const summary = await api.getNvrChannelsSummary({ source: "cgi" });

  console.log(`\n== PIR repro on NVR ${host} ==`);
  for (const dev of summary.devices) {
    if (!dev.isBattery) continue;
    const sleepingNote = dev.sleeping ? " [sleeping]" : "";
    await testPirOnChannel(api, dev.channel, `${dev.name} ${dev.model}${sleepingNote}`);
  }

  await api.close().catch(() => {});
  process.exit(0);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
