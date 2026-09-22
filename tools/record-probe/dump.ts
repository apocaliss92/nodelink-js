import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
const [slot, chS, prefix] = [process.argv[2] as string, process.argv[3] as string, process.argv[4] as string];
const channel = Number(chS);
const api = new ReolinkBaichuanApi({
  host: process.env[`${slot}_HOST`] as string, port: 9000,
  username: process.env[`${slot}_USERNAME`] ?? "admin",
  password: process.env[`${slot}_PASSWORD`] ?? "",
  transport: "auto",
  ...(process.env[`${slot}_UID`] ? { uid: process.env[`${slot}_UID`] as string } : {}),
});
await api.login();
const out = path.join(__dirname, "..", "..", "test", "fixtures", "record");
for (const [name, cmdId, withCh] of [["recordcfg", 54, true], ["record", 81, true], ["hddinfolist", 102, false]] as const) {
  const xml = await api.sendXml({ cmdId, ...(withCh ? { channel } : {}), timeoutMs: 8000 });
  fs.writeFileSync(path.join(out, `${prefix}-${name}.xml`), xml);
  console.log(prefix, name, xml.length, "bytes");
}
process.exit(0);
