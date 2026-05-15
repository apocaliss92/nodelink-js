#!/usr/bin/env tsx
/**
 * Verify that our setPortConfig payload is accepted by the camera.
 * Reads each port, toggles HTTPS (the safest "I noticed nothing"
 * change), reads back, restores the original. If both writes are
 * accepted (responseCode 200) and survive the read, our XML schema
 * matches what the firmware expects.
 */
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

type PortKey = "http" | "https" | "rtsp" | "rtmp" | "onvif";
interface PortBlock { enable?: number; [k: string]: unknown }
type PortsResp = Partial<Record<PortKey | "server", PortBlock>>;

async function main(): Promise<void> {
  const host = process.argv[2];
  const password = process.argv[3];
  if (!host || !password) {
    process.stderr.write("usage: test-set-ports.ts <host> <password>\n");
    process.exit(1);
  }
  const api = new ReolinkBaichuanApi({ host, username: "admin", password });
  await api.client.connect();
  await api.login();
  const portField = (k: PortKey): string => `${k}port`;

  const readEnable = (resp: PortsResp, k: PortKey): number =>
    Number(resp[k]?.enable ?? 0);
  const readPort = (resp: PortsResp, k: PortKey): number =>
    Number((resp[k] as Record<string, unknown> | undefined)?.[portField(k)] ?? 0);

  try {
    // Test EVERY non-Server port. We skip Server (cmd_id 9000 = the
    // Baichuan connection we're using) since toggling it disconnects us.
    const targets: PortKey[] = ["http", "https", "rtsp", "rtmp", "onvif"];

    const before = (await api.getPorts()) as PortsResp;
    process.stdout.write(`=== Initial state ===\n`);
    for (const k of targets) {
      process.stdout.write(
        `  ${k.padEnd(6)} port=${readPort(before, k)} enable=${readEnable(before, k)}\n`,
      );
    }

    type Result = { port: "ok" | "mismatch" | "skip"; enable: "ok" | "mismatch" | "skip" };
    const results: Record<PortKey, Result> = {} as Record<PortKey, Result>;

    for (const k of targets) {
      results[k] = { port: "skip", enable: "skip" };
      const initialEnable = readEnable(before, k);
      const initialPort = readPort(before, k);
      // HTTP is what the dashboard / mobile app talks to over LAN.
      // Disabling it could lock the user out of the camera's web UI on
      // a different network path, but we're going to RESTORE the
      // original value, so the test is reversible. Still, skip the
      // HTTP enable toggle to avoid any chance of leaving the camera
      // unreachable from the browser if the script errors mid-way.
      if (k !== "http") {
        const target = initialEnable === 1 ? false : true;
        process.stdout.write(`\n[${k}] enable ${initialEnable} → ${target ? 1 : 0}\n`);
        await api.setPortConfig({ [k]: { enable: target } });
        const after = (await api.getPorts()) as PortsResp;
        const got = readEnable(after, k);
        results[k].enable = got === (target ? 1 : 0) ? "ok" : "mismatch";
        process.stdout.write(`         readback=${got} → ${results[k].enable}\n`);
        // Restore
        await api.setPortConfig({ [k]: { enable: initialEnable === 1 } });
      }

      // Try a port-number toggle — pick a value 1 off the default so
      // we can spot dropped writes. Skip HTTP because changing it
      // breaks the same path the manager uses to talk to the camera
      // on some networks.
      if (k !== "http") {
        const newPort = initialPort + 1;
        process.stdout.write(`[${k}] port ${initialPort} → ${newPort}\n`);
        try {
          await api.setPortConfig({ [k]: { port: newPort } });
          const after = (await api.getPorts()) as PortsResp;
          const got = readPort(after, k);
          results[k].port = got === newPort ? "ok" : "mismatch";
          process.stdout.write(`         readback=${got} → ${results[k].port}\n`);
        } catch (e) {
          results[k].port = "mismatch";
          process.stdout.write(`         write rejected: ${(e as Error).message}\n`);
        }
        // Restore
        await api.setPortConfig({ [k]: { port: initialPort } });
      }
    }

    process.stdout.write(`\n=== Summary ===\n`);
    process.stdout.write(`port    | port-change | enable-toggle\n`);
    for (const k of targets) {
      process.stdout.write(
        `${k.padEnd(7)} | ${results[k].port.padEnd(11)} | ${results[k].enable}\n`,
      );
    }
  } finally {
    await api.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
