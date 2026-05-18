/**
 * Probe the 3 cmd_ids the Reolink Client sends but our lib doesn't know:
 * 76, 133, 192. Goal: find which one returns the rich nested `channelAbility`
 * structure with `lightWhiteLed.ver`, `floodLight.ver`, etc.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";
import { xmlEscape } from "../src/protocol/xml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const OUT = path.join(__dirname, "probe-ability-out");
fs.mkdirSync(OUT, { recursive: true });

const UNKNOWN_CMDS = [76, 133, 192];

const slots = ["ARGUS"];

async function probe(slot: string): Promise<void> {
  const host = process.env[`${slot}_HOST`];
  if (!host) return;
  const api = new ReolinkBaichuanApi({
    host,
    port: 9000,
    username: process.env[`${slot}_USERNAME`] ?? "admin",
    password: process.env[`${slot}_PASSWORD`] ?? "",
    transport: "auto",
    ...(process.env[`${slot}_UID`]
      ? { uid: process.env[`${slot}_UID`] as string }
      : {}),
  });
  console.log(`\n=== ${slot} @ ${host} ===`);
  try {
    await api.login();
    const info = await api.getInfo();
    console.log(`  model=${info?.type} fw=${info?.firmwareVersion}`);
    const slug = `${slot}-${String(info?.type ?? "unknown").replace(/[^A-Za-z0-9]+/g, "_")}`;

    const userName = process.env[`${slot}_USERNAME`] ?? "admin";

    for (const cmdId of UNKNOWN_CMDS) {
      // Try three variants of the request: empty, with a minimal Extension carrying the
      // userName (older firmwares require it), and a single-element body.
      const variants: Array<{ name: string; ext?: string }> = [
        { name: "no-ext" },
        {
          name: "with-username",
          ext: `<?xml version="1.0" encoding="UTF-8" ?>\n<Extension version="1.1">\n<userName>${xmlEscape(userName)}</userName>\n</Extension>`,
        },
      ];

      for (const v of variants) {
        try {
          const xml = await api.sendXml({
            cmdId,
            timeoutMs: 3000,
            ...(v.ext ? { extensionXml: v.ext } : {}),
          });
          const out = path.join(OUT, `${slug}__cmd${cmdId}__${v.name}.xml`);
          fs.writeFileSync(out, xml || "(empty)\n");
          const len = xml?.length ?? 0;
          const hints = ["channelAbility", "abilityChn", "lightWhiteLed", "floodLight", "Ability"]
            .filter((kw) => xml?.includes(kw));
          console.log(`  cmd_id=${String(cmdId).padStart(3)} (${v.name.padEnd(13)}): ${len.toString().padStart(6)} bytes${hints.length ? "  HINTS: " + hints.join(",") : ""}`);
        } catch (e) {
          console.log(`  cmd_id=${String(cmdId).padStart(3)} (${v.name.padEnd(13)}): ERROR ${(e as Error).message.slice(0, 80)}`);
        }
      }
    }
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message}`);
  } finally {
    try { await api.close(); } catch { /* ignore */ }
  }
}

(async () => {
  for (const s of slots) await probe(s);
  console.log("\nDone.");
})();
