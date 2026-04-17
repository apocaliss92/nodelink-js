/* eslint-disable no-console */
/**
 * Enumerate channels on NVR / HUB and mark which are battery-powered.
 * Used as input for the issue-#8 reproduction harness.
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function probe(
  name: string,
  host: string | undefined,
  user: string | undefined,
  pass: string | undefined,
) {
  if (!host) {
    console.log(`[${name}] skipped — host not configured`);
    return;
  }
  console.log(`\n=== ${name} @ ${host} ===`);
  const api = new ReolinkBaichuanApi({
    host,
    username: user ?? "admin",
    password: pass ?? "",
  });
  try {
    await api.login();
    const summary = await api
      .getNvrChannelsSummary({ source: "cgi" })
      .catch(async (e) => {
        console.log(`  cgi summary failed (${e}); trying baichuan fallback`);
        return api.getNvrChannelsSummary({ source: "baichuan" });
      });

    console.log(`  ${summary.devices.length} channel(s) (channels array: [${summary.channels.join(", ")}])`);
    for (const c of summary.devices) {
      console.log(
        `    ch${c.channel}: name="${c.name ?? "?"}" model=${c.model ?? "?"} ` +
          `battery=${c.isBattery ?? false} doorbell=${c.isDoorbell ?? false} ` +
          `sleeping=${c.sleeping ?? "?"} online=${c.online ?? "?"} ` +
          `uid=${c.uid ?? "-"}`,
      );
    }
  } catch (e) {
    console.log(`  failed: ${e}`);
  } finally {
    await api.close().catch(() => {});
  }
}

async function main() {
  await probe("HUB", process.env.HUB_HOST, process.env.HUB_USERNAME, process.env.HUB_PASSWORD);
  await probe("NVR", process.env.NVR_HOST, process.env.NVR_USERNAME, process.env.NVR_PASSWORD);
  await probe("TCP", process.env.TCP_HOST, process.env.TCP_USERNAME, process.env.TCP_PASSWORD);
  await probe(
    "TCP265",
    process.env.TCP265_HOST,
    process.env.TCP265_USERNAME,
    process.env.TCP265_PASSWORD,
  );
  process.exit(0);
}

void main();
