#!/usr/bin/env tsx
/**
 * Verify that our setPortConfig payload is accepted by the camera.
 * Reads each port, toggles HTTPS (the safest "I noticed nothing"
 * change), reads back, restores the original. If both writes are
 * accepted (responseCode 200) and survive the read, our XML schema
 * matches what the firmware expects.
 */
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

interface PortBlock { enable?: number; rtspport?: number; [k: string]: unknown }
interface PortsResp { https?: PortBlock; rtsp?: PortBlock; [k: string]: unknown }

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
  try {
    const before = (await api.getPorts()) as PortsResp;
    const beforeEnable = Number(before.https?.enable ?? 0);
    process.stdout.write(`HTTPS before: enable=${beforeEnable}\n`);

    const target = beforeEnable === 1 ? false : true;
    process.stdout.write(`\nWriting HTTPS enable=${target ? 1 : 0} ...\n`);
    await api.setPortConfig({ https: { enable: target } });

    const after = (await api.getPorts()) as PortsResp;
    const afterEnable = Number(after.https?.enable ?? 0);
    process.stdout.write(`HTTPS after:  enable=${afterEnable}\n`);
    if (afterEnable !== (target ? 1 : 0)) {
      process.stderr.write(
        `MISMATCH: expected ${target ? 1 : 0}, got ${afterEnable}\n`,
      );
      process.exitCode = 2;
    }

    // Restore
    process.stdout.write(`\nRestoring HTTPS enable=${beforeEnable} ...\n`);
    await api.setPortConfig({ https: { enable: beforeEnable === 1 } });
    const restored = (await api.getPorts()) as PortsResp;
    process.stdout.write(`HTTPS restored: enable=${Number(restored.https?.enable ?? 0)}\n`);

    // Test changing a port number — RTSP from current to current+1 and back.
    const beforeRtsp = Number(before.rtsp?.rtspport ?? 554);
    process.stdout.write(`\nRTSP before: port=${beforeRtsp}\n`);
    const newRtsp = beforeRtsp === 554 ? 5541 : 554;
    process.stdout.write(`Writing RTSP port=${newRtsp} ...\n`);
    await api.setPortConfig({ rtsp: { port: newRtsp } });
    const afterRtsp = (await api.getPorts()) as PortsResp;
    const afterRtspPort = Number(afterRtsp.rtsp?.rtspport ?? 0);
    process.stdout.write(`RTSP after:  port=${afterRtspPort}\n`);
    if (afterRtspPort !== newRtsp) {
      process.stderr.write(
        `MISMATCH: expected port ${newRtsp}, got ${afterRtspPort}\n`,
      );
      process.exitCode = 2;
    }
    process.stdout.write(`Restoring RTSP port=${beforeRtsp} ...\n`);
    await api.setPortConfig({ rtsp: { port: beforeRtsp } });
    const restoredRtsp = (await api.getPorts()) as PortsResp;
    process.stdout.write(`RTSP restored: port=${Number(restoredRtsp.rtsp?.rtspport ?? 0)}\n`);
  } finally {
    await api.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
