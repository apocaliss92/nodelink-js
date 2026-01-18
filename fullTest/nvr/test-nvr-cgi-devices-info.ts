import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error - Path resolution at runtime
import { ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";

function safeNow(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function main(): Promise<void> {
  const { host, username, password } = config.nvr;
  if (!host) throw new Error("Missing NVR_HOST in .env");
  if (!username) throw new Error("Missing NVR_USERNAME in .env");
  if (!password) throw new Error("Missing NVR_PASSWORD in .env");

  const api = new ReolinkCgiApi({
    host,
    username,
    password,
    timeoutMs: 30_000,
  });

  // One round-trip each (batched inside methods).
  const hubInfo = await api.getNvrInfo();
  const devicesInfo = await api.getDevicesInfo();

  const dump = {
    meta: {
      when: new Date().toISOString(),
      host,
      channels: devicesInfo.channels,
    },
    hubInfo,
    devicesInfo,
  };

  const dir = join(process.cwd(), "test", "diagnostics-dumps");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `cgi_nvr_devices_info_${safeNow()}.json`);
  writeFileSync(outPath, JSON.stringify(dump, null, 2), "utf8");

  console.log(`Wrote ${outPath}`);
  console.log(`Channels: ${devicesInfo.channels.join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
