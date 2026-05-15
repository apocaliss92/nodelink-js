import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function main(): Promise<void> {
  const host = process.argv[2];
  const password = process.argv[3];
  if (!host || !password) {
    process.stderr.write("usage: check-ai-caps.ts <host> <password>\n");
    process.exit(1);
  }
  const api = new ReolinkBaichuanApi({ host, username: "admin", password });
  await api.client.connect();
  await api.login();
  try {
    const aiCfg = await api.sendXml({ cmdId: 299, channel: 0 });
    process.stdout.write(`=== AI Cfg (cmd_299) ===\n${aiCfg}\n\n`);
    const aiAlarm = await api.sendXml({ cmdId: 342, channel: 0 });
    process.stdout.write(`=== AI Alarm Caps (cmd_342) ===\n${aiAlarm}\n\n`);
    try {
      const detect = await api.sendXml({ cmdId: 295, channel: 0 });
      process.stdout.write(`=== AI Detect Cfg (cmd_295) ===\n${detect}\n\n`);
    } catch (e) {
      process.stderr.write(`cmd_295 not supported: ${(e as Error).message}\n`);
    }
  } finally {
    await api.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
