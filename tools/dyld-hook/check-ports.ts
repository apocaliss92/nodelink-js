#!/usr/bin/env tsx
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function main(): Promise<void> {
  const host = process.argv[2];
  const password = process.argv[3];
  if (!host || !password) {
    process.stderr.write("usage: check-ports.ts <host> <password>\n");
    process.exit(1);
  }
  const api = new ReolinkBaichuanApi({ host, username: "admin", password });
  await api.client.connect();
  await api.login();
  try {
    const ports = await api.getPorts();
    process.stdout.write(`=== getPorts ===\n${JSON.stringify(ports, null, 2)}\n\n`);
    // Also dump the raw XML
    const xml = await api.sendXml({ cmdId: 37 });
    process.stdout.write(`=== raw cmd_37 XML ===\n${xml}\n`);
  } finally {
    await api.close();
  }
}
main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
