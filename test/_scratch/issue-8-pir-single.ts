/* eslint-disable no-console */
/**
 * One clean attempt to login + PIR round-trip against UDP_STANDALONE.
 * No retries (avoids cooldown cascades and BCUDP rate limits).
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function main() {
  const host = process.env.UDP_STANDALONE_HOST!;
  const username = process.env.UDP_STANDALONE_USERNAME ?? "admin";
  const password = process.env.UDP_STANDALONE_PASSWORD ?? "";
  const uid = process.env.UDP_STANDALONE_UID;
  if (!host) throw new Error("UDP_STANDALONE_HOST not set");

  console.log(`\n── ${host} uid=${uid ?? "-"} — one-shot PIR test ──`);
  const method = (process.env.PIR_DISCOVERY ?? "local-direct") as
    | "local-direct"
    | "local"
    | "map"
    | "remote";
  console.log(`  discovery method: ${method}`);
  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    transport: "udp", // force BCUDP-only so we see the real rejection path
    udpDiscoveryMethod: method,
    ...(uid ? { uid } : {}),
  });

  try {
    const t0 = Date.now();
    await api.login();
    console.log(
      `✓ login ok in ${Date.now() - t0}ms (transport=${api.client.getTransport()})`,
    );

    // Device info for context
    try {
      const info = await api.getDeviceInfo();
      console.log(
        `  device: ${info.model ?? "?"} firmware=${info.firmwareVersion ?? "?"} serial=${info.serialNumber ?? "?"}`,
      );
    } catch (e) {
      console.log(`  (getDeviceInfo failed: ${e})`);
    }

    // GET PIR (cmdId 212) — the user's reported failing path
    const tGet = Date.now();
    let enabled: number | undefined;
    try {
      const info = await api.getPirInfo(0);
      enabled = info.enabled ? 1 : 0;
      console.log(
        `✓ GET cmdId=212 getPirInfo ok in ${Date.now() - tGet}ms  enabled=${info.enabled} sensitive=${info.sensitive ?? "?"} reduceFalseAlarm=${info.reduceFalseAlarm ?? "?"}`,
      );
    } catch (e) {
      console.log(`✗ GET cmdId=212 getPirInfo FAILED in ${Date.now() - tGet}ms: ${e}`);
      return;
    }

    // SET PIR (GET + modify + cmdId 213 SET)
    const tSet = Date.now();
    try {
      await api.setPirInfo(0, { enable: enabled ?? 1 });
      console.log(
        `✓ SET cmdId=213 setPirInfo ok in ${Date.now() - tSet}ms (wrote enable=${enabled})`,
      );
    } catch (e) {
      console.log(`✗ SET cmdId=213 setPirInfo FAILED in ${Date.now() - tSet}ms: ${e}`);
    }
  } catch (e) {
    console.log(`✗ login failed: ${e}`);
  } finally {
    await api.close().catch(() => {});
  }
  process.exit(0);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
