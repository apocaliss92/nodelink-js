/**
 * Probe: does the manager's per-connect path re-read stream metadata from the
 * camera, and does that survive a reconnect?
 *
 * The manager registers `onApiConnected → getAvailableProfiles() →
 * buildVideoStreamOptions() → getStreamMetadata() → getEncXml`. That last call
 * is a real Baichuan command, and on a battery camera it wakes it (issue #35).
 * `buildVideoStreamOptions` is cached — but the cache lives on the
 * ReolinkBaichuanApi *instance*, so the question that matters is what happens
 * when the manager rebuilds that instance after a dropped connection.
 *
 * Counts actual Baichuan commands on the wire, by cmdId, which is the ground
 * truth for "did we touch the camera".
 *
 *   npx tsx test/_scratch/probe-manager-metadata.ts
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
});

const HOST = process.env.TCP_HOST!;
const USER = process.env.TCP_USERNAME!;
const PASS = process.env.TCP_PASSWORD!;

/** cmdId 56 = GetEnc — the stream metadata read we are hunting. */
const CMD_GET_ENC = 56;

interface Counter {
  byCmd: Map<number, number>;
  total: number;
}

function instrument(api: ReolinkBaichuanApi): Counter {
  const counter: Counter = { byCmd: new Map(), total: 0 };
  const client: any = api.client;
  const original = client.sendXml.bind(client);
  client.sendXml = async (params: any) => {
    if (params?.internal !== true) {
      counter.total++;
      counter.byCmd.set(params.cmdId, (counter.byCmd.get(params.cmdId) ?? 0) + 1);
    }
    return original(params);
  };
  return counter;
}

function getEnc(c: Counter): number {
  return c.byCmd.get(CMD_GET_ENC) ?? 0;
}

async function makeApi(): Promise<{ api: ReolinkBaichuanApi; counter: Counter }> {
  const api = new ReolinkBaichuanApi({
    host: HOST,
    port: 9000,
    username: USER,
    password: PASS,
    transport: "tcp",
  });
  await api.login();
  const counter = instrument(api); // after login, so we only measure the path under test
  return { api, counter };
}

async function main(): Promise<void> {
  console.log(`Camera ${HOST} — manager-path probe\n`);

  // ── A. Same API instance, repeated calls (what the cache is meant to cover)
  const { api: apiA, counter: cA } = await makeApi();
  for (let i = 1; i <= 4; i++) {
    await apiA.buildVideoStreamOptions({ channel: 0, onNvr: false });
    console.log(`  same instance, call ${i}: GetEnc so far = ${getEnc(cA)}`);
  }
  console.log(
    `\nA) same API instance ×4  → GetEnc=${getEnc(cA)}  (cache working if 1)`,
  );
  console.log(`   commands actually sent: ${JSON.stringify([...cA.byCmd])} total=${cA.total}\n`);
  await apiA.disconnect?.();

  // ── B. Fresh API instance per call — what the manager does when a camera's
  //      connection drops and is rebuilt (battery cameras do this constantly).
  let getEncAcrossInstances = 0;
  for (let i = 1; i <= 3; i++) {
    const { api, counter } = await makeApi();
    await api.buildVideoStreamOptions({ channel: 0, onNvr: false });
    getEncAcrossInstances += getEnc(counter);
    console.log(`  fresh instance ${i}: GetEnc = ${getEnc(counter)}`);
    await api.disconnect?.();
  }
  console.log(
    `\nB) fresh API instance ×3 → GetEnc=${getEncAcrossInstances}  (one camera read per reconnect if 3)\n`,
  );

  console.log("VERDICT");
  console.log(
    getEnc(cA) <= 1
      ? "  · cache holds within one API instance"
      : `  · cache does NOT hold: ${getEnc(cA)} reads on one instance`,
  );
  console.log(
    getEncAcrossInstances >= 3
      ? "  · every rebuilt API instance re-reads metadata from the camera → wakes a battery cam"
      : "  · rebuilt instances did NOT re-read metadata",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
