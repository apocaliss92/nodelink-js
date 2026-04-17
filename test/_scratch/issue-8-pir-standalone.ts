/* eslint-disable no-console */
/**
 * Issue #8 point 2 — PIR toggle on STANDALONE battery cameras.
 *
 * The user error is `Baichuan timeout cmdId=212 msgNum=17` when HA MQTT
 * issues a PIR toggle. cmdId 212 is BC_CMD_ID_GET_PIR_INFO. Standalone
 * battery cams take the BCUDP wake path; commands are sent directly over
 * the per-camera socket, not proxied through a Hub/NVR. That's the code
 * path we need to exercise.
 *
 * Tries every standalone battery camera configured in .env:
 *   UDP_HOST / UDP_STANDALONE_HOST / UDP_SLEEP_HOST
 *
 * For each: transport=auto (TCP → BCUDP fallback), ensureConnected, GET PIR,
 * SET PIR back to the same value (the same path setPirInfo runs internally).
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_RETRY_DELAY_MS = 20_000;

async function tryLogin(
  host: string,
  username: string,
  password: string,
  uid: string | undefined,
): Promise<ReolinkBaichuanApi | null> {
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    console.log(`  login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS}…`);
    const api = new ReolinkBaichuanApi({
      host,
      username,
      password,
      transport: "auto",
      ...(uid ? { uid } : {}),
    });
    try {
      const t = Date.now();
      await api.login();
      console.log(
        `    ✓ login ok in ${Date.now() - t}ms (transport=${api.client.getTransport()})`,
      );
      return api;
    } catch (e) {
      console.log(`    ✗ attempt ${attempt} failed: ${String(e).slice(0, 180)}`);
      await api.close().catch(() => {});
      if (attempt < MAX_LOGIN_ATTEMPTS) {
        console.log(`    …waiting ${LOGIN_RETRY_DELAY_MS / 1000}s before retry`);
        await new Promise((r) => setTimeout(r, LOGIN_RETRY_DELAY_MS));
      }
    }
  }
  return null;
}

async function testOne(
  label: string,
  host?: string,
  username?: string,
  password?: string,
  uid?: string,
) {
  if (!host) {
    console.log(`\n[${label}] skipped — not configured`);
    return;
  }
  console.log(`\n── ${label} @ ${host} uid=${uid ?? "-"} ──`);

  const api = await tryLogin(host, username ?? "admin", password ?? "", uid);
  if (!api) {
    console.log(`  ✗ gave up after ${MAX_LOGIN_ATTEMPTS} login attempts`);
    return;
  }

  try {
    const tGet = Date.now();
    let enabled: number | undefined;
    try {
      const info = await api.getPirInfo(0);
      enabled = info.enabled ? 1 : 0;
      console.log(
        `  ✓ GET cmdId=212 ok in ${Date.now() - tGet}ms  enabled=${info.enabled} sensitive=${info.sensitive ?? "?"}`,
      );
    } catch (e) {
      console.log(`  ✗ GET cmdId=212 FAILED in ${Date.now() - tGet}ms: ${e}`);
      return;
    }

    const tSet = Date.now();
    try {
      await api.setPirInfo(0, { enable: enabled ?? 1 });
      console.log(
        `  ✓ SET cmdId=213 ok in ${Date.now() - tSet}ms (round-trip: internal GET+modify+SET)`,
      );
    } catch (e) {
      console.log(`  ✗ SET cmdId=213 FAILED in ${Date.now() - tSet}ms: ${e}`);
    }
  } finally {
    await api.close().catch(() => {});
  }
}

async function main() {
  console.log("== PIR standalone (direct BCUDP) test ==");

  await testOne(
    "UDP_STANDALONE",
    process.env.UDP_STANDALONE_HOST,
    process.env.UDP_STANDALONE_USERNAME,
    process.env.UDP_STANDALONE_PASSWORD,
    process.env.UDP_STANDALONE_UID,
  );

  process.exit(0);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
