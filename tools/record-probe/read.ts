/** READ-ONLY probe: cmd 54 / 81 / 102 raw XML from a mains camera. */
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const slot = process.argv[2] ?? "TCP";
const channel = Number(process.argv[3] ?? "0");

const api = new ReolinkBaichuanApi({
  host: process.env[`${slot}_HOST`] as string,
  port: 9000,
  username: process.env[`${slot}_USERNAME`] ?? "admin",
  password: process.env[`${slot}_PASSWORD`] ?? "",
  transport: "auto",
  ...(process.env[`${slot}_UID`] ? { uid: process.env[`${slot}_UID`] as string } : {}),
});

await api.login();
const info = await api.getInfo();
console.log(`### ${slot} ch${channel} model=${info?.type} fw=${info?.firmwareVersion}`);
for (const [name, cmdId, withChannel] of [
  ["RecordCfg", 54, true],
  ["Record", 81, true],
  ["HddInfoList", 102, false],
] as const) {
  try {
    const xml = await api.sendXml({ cmdId, ...(withChannel ? { channel } : {}), timeoutMs: 8000 });
    console.log(`--- cmd ${cmdId} ${name}\n${xml}`);
  } catch (e) {
    console.log(`--- cmd ${cmdId} ${name} FAILED: ${(e as Error).message}`);
  }
}
console.log("--- typed getHddInfoList:", JSON.stringify(await api.getHddInfoList()));
await api.close?.();
process.exit(0);
