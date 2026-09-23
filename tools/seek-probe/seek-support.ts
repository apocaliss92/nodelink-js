/**
 * Does this firmware accept cmd 123 `<ReplaySeek>` at all?
 *
 * Separate from a download on purpose: a camera with no recordings still
 * answers this, and "the command exists" is the fact that decides whether a
 * download on that firmware runs positioned or degraded.
 */
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
const t0 = Date.now();
const ok = await api.replaySeek({ channel, at: new Date(Date.now() - 3600_000) });
console.log(
  `RESULT ${slot} ch${channel} ${info?.type} ${info?.firmwareVersion} :: cmd 123 accepted=${ok} in ${Date.now() - t0}ms`,
);
await api.close({ reason: "probe done" });
process.exit(0);
