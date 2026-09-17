/**
 * Validate the instrumentation itself before trusting any measurement.
 *
 * A probe that reports "0 camera reads" is worthless if the hook simply is not
 * firing. This calls getEncXml directly — a known camera read — and checks the
 * counter moves. Only then does it measure buildVideoStreamOptions.
 *
 *   npx tsx test/_scratch/probe-validate-hook.ts
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
});

const HOST = process.env.TCP_HOST!;

async function main(): Promise<void> {
  const api = new ReolinkBaichuanApi({
    host: HOST,
    port: 9000,
    username: process.env.TCP_USERNAME!,
    password: process.env.TCP_PASSWORD!,
    transport: "tcp",
  });
  await api.login();

  // Hook the API-level funnels for a metadata read.
  const counts = { getEncXml: 0, getStreamMetadata: 0 };
  const origEnc = (api as any).getEncXml.bind(api);
  (api as any).getEncXml = async (...a: unknown[]) => {
    counts.getEncXml++;
    return origEnc(...a);
  };
  const origMeta = api.getStreamMetadata.bind(api);
  (api as any).getStreamMetadata = async (...a: unknown[]) => {
    counts.getStreamMetadata++;
    return origMeta(...a);
  };

  console.log(`Camera ${HOST}\n`);

  // 1. Does the hook fire at all?
  await api.getStreamMetadata(0);
  console.log(
    `hook check → getStreamMetadata=${counts.getStreamMetadata} getEncXml=${counts.getEncXml}` +
      `  ${counts.getEncXml > 0 ? "(hook WORKS)" : "(HOOK BROKEN — measurements meaningless)"}`,
  );

  // 2. With a validated hook, measure the manager's path.
  const base = { ...counts };
  for (let i = 1; i <= 3; i++) {
    await api.buildVideoStreamOptions({ channel: 0, onNvr: false });
    console.log(
      `buildVideoStreamOptions #${i} → cumulative getEncXml=${counts.getEncXml}` +
        ` (delta from baseline ${counts.getEncXml - base.getEncXml})`,
    );
  }

  // 3. Fresh instance = what the manager builds after a dropped connection.
  const api2 = new ReolinkBaichuanApi({
    host: HOST,
    port: 9000,
    username: process.env.TCP_USERNAME!,
    password: process.env.TCP_PASSWORD!,
    transport: "tcp",
  });
  await api2.login();
  let enc2 = 0;
  const o2 = (api2 as any).getEncXml.bind(api2);
  (api2 as any).getEncXml = async (...a: unknown[]) => {
    enc2++;
    return o2(...a);
  };
  await api2.buildVideoStreamOptions({ channel: 0, onNvr: false });
  console.log(`\nfresh API instance → buildVideoStreamOptions caused getEncXml=${enc2}`);

  await api.disconnect?.();
  await api2.disconnect?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
