/**
 * Probe raw cmd_id 151 (ABILITY_INFO) responses across the .env cameras to
 * discover whether the response carries the nested `channelAbility` block
 * that the Reolink Electron client reads (`channelAbility[ch].lightWhiteLed.ver`
 * etc.). The current `parseAbilityInfoXml` only extracts the flat `_rw`/`_ro`
 * tokens — if the camera also returns a nested block we'd be silently losing
 * it.
 *
 * Also tries the same cmd_id 151 with several `<token>` extensions (the
 * Reolink legacy schema uses `system, streaming, ...`; newer schemas may
 * accept `ability` / `light` / `all`).
 *
 * Usage:
 *   npx tsx tools/probe-ability-raw.ts
 *
 * Output: writes one `.xml` per (camera, token-set) under
 * `tools/probe-ability-out/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";
import { xmlEscape } from "../src/protocol/xml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const OUT_DIR = path.join(__dirname, "probe-ability-out");
fs.mkdirSync(OUT_DIR, { recursive: true });

interface CamCfg {
  slot: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

function loadCameras(): CamCfg[] {
  const cams: CamCfg[] = [];
  for (const slot of ["TCP", "TCP265", "NVR", "HUB"]) {
    const host = process.env[`${slot}_HOST`];
    if (!host) continue;
    cams.push({
      slot,
      host,
      port: Number(process.env[`${slot}_PORT`] ?? 9000),
      username: process.env[`${slot}_USERNAME`] ?? "admin",
      password: process.env[`${slot}_PASSWORD`] ?? "",
    });
  }
  return cams;
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

// Token variants: the legacy set, then a few guesses for newer schemas.
const TOKEN_VARIANTS: Array<{ name: string; tokens: string }> = [
  {
    name: "legacy",
    tokens:
      "system, streaming, PTZ, IO, security, replay, disk, network, alarm, record, video, image",
  },
  { name: "ability", tokens: "ability" },
  { name: "light", tokens: "light" },
  { name: "channelAbility", tokens: "channelAbility" },
  { name: "all", tokens: "all" },
];

function buildExtension(username: string, tokens: string): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Extension version="1.1">
<userName>${xmlEscape(username)}</userName>
<token>${tokens}</token>
</Extension>`;
}

async function probeCamera(cfg: CamCfg): Promise<void> {
  console.log(`\n=== ${cfg.slot} @ ${cfg.host} ===`);
  const api = new ReolinkBaichuanApi({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password,
  });

  try {
    await api.login();
    const info = await api.getInfo();
    const model = String(info?.type ?? "unknown");
    console.log(`  model: ${model} | fw: ${info?.firmwareVersion}`);
    const slug = `${safeName(cfg.slot)}-${safeName(model)}`;

    for (const variant of TOKEN_VARIANTS) {
      try {
        const ext = buildExtension(cfg.username, variant.tokens);
        const xml = await api.sendXml({
          cmdId: 151,
          extensionXml: ext,
          timeoutMs: 4000,
        });
        const out = path.join(OUT_DIR, `${slug}__cmd151__${variant.name}.xml`);
        fs.writeFileSync(out, xml || "(empty response)\n");
        const len = xml ? xml.length : 0;
        const hasNested =
          xml.includes("<channelAbility") ||
          xml.includes("<lightWhiteLed") ||
          xml.includes("<lightIrLed") ||
          xml.includes("<lightDoorbell") ||
          xml.includes("<lightPower");
        console.log(
          `  ${variant.name.padEnd(15)}: ${len.toString().padStart(6)} bytes${hasNested ? "  <-- NESTED LIGHT BLOCK!" : ""}`,
        );
      } catch (e) {
        console.log(
          `  ${variant.name.padEnd(15)}: ERROR ${(e as Error).message?.slice(0, 80)}`,
        );
      }
    }
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message}`);
  } finally {
    try {
      await api.close();
    } catch {
      /* ignore */
    }
  }
}

(async () => {
  const cams = loadCameras();
  console.log(`Probing ${cams.length} camera(s); output -> ${OUT_DIR}`);
  for (const c of cams) await probeCamera(c);
  console.log("\nDone.");
})();
