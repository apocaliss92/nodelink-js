#!/usr/bin/env tsx
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function main(): Promise<void> {
  const host = process.argv[2];
  const password = process.argv[3];
  if (!host || !password) {
    process.stderr.write("usage: check-audio-cfg.ts <host> <password>\n");
    process.exit(1);
  }
  const api = new ReolinkBaichuanApi({ host, username: "admin", password });
  await api.client.connect();
  await api.login();
  try {
    const meta = await api.getStreamMetadata(0);
    process.stdout.write(`audioEnabled (channel-level): ${meta.audioEnabled}\n`);
    for (const s of meta.streams) {
      process.stdout.write(
        `  ${s.profile}: audio=${s.audio} codec=${s.audioCodec}\n`,
      );
    }
    process.stdout.write(`\n--- AudioCfg (cmd_264) ---\n`);
    try {
      const audioCfg = await api.sendXml({ cmdId: 264, channel: 0 });
      process.stdout.write(`${audioCfg}\n\n`);
    } catch (e) {
      process.stderr.write(`cmd_264 failed: ${(e as Error).message}\n`);
    }
    process.stdout.write(`--- TalkAbility (cmd_10) ---\n`);
    try {
      const talk = await api.sendXml({ cmdId: 10, channel: 0 });
      process.stdout.write(`${talk}\n\n`);
    } catch (e) {
      process.stderr.write(`cmd_10 failed: ${(e as Error).message}\n`);
    }
  } finally {
    await api.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
