/**
 * Probe the Reolink HTTP CGI `GetAbility` endpoint against each .env camera.
 *
 * This is the path the Reolink Electron client uses internally (URL
 * `/json_api/ability/getAbility` in the bcsdk JSON-API surface — under the
 * hood it POSTs to `cgi-bin/api.cgi`). The response is JSON with a nested
 * `channelAbility[ch].lightWhiteLed.ver` structure that we can't get from
 * the Baichuan cmd_id 151 (which only emits the flat `_rw`/`_ro` schema).
 *
 * Usage:
 *   npx tsx tools/probe-cgi-getability.ts
 *
 * Output: writes `<slot>-<model>__getability.json` per camera under
 * `tools/probe-ability-out/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const OUT_DIR = path.join(__dirname, "probe-ability-out");
fs.mkdirSync(OUT_DIR, { recursive: true });

interface CamCfg {
  slot: string;
  host: string;
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
      username: process.env[`${slot}_USERNAME`] ?? "admin",
      password: process.env[`${slot}_PASSWORD`] ?? "",
    });
  }
  return cams;
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

async function postCgi(
  host: string,
  cmd: string,
  body: unknown,
  token?: string,
): Promise<unknown> {
  // Reolink CGI requires the `cmd` to appear in BOTH the query string and the
  // body element — the query string drives the dispatcher, the body carries
  // the params.
  const params = new URLSearchParams({ cmd });
  if (token) params.set("token", token);
  const url = `http://${host}/cgi-bin/api.cgi?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function probeCamera(cfg: CamCfg): Promise<void> {
  console.log(`\n=== ${cfg.slot} @ ${cfg.host} ===`);

  try {
    // Login
    const loginResp = (await postCgi(
      cfg.host,
      "Login",
      [
        {
          cmd: "Login",
          action: 0,
          param: {
            User: { Version: 0, userName: cfg.username, password: cfg.password },
          },
        },
      ],
    )) as Array<{ code: number; value?: { Token?: { name?: string; leaseTime?: number } } }>;
    const token = loginResp[0]?.value?.Token?.name;
    if (!token) {
      console.log(`  LOGIN FAIL:`, JSON.stringify(loginResp).slice(0, 300));
      return;
    }
    console.log(`  login OK (token=${token.slice(0, 12)}…)`);

    // Get model from GetDevInfo for naming
    const devResp = (await postCgi(
      cfg.host,
      "GetDevInfo",
      [{ cmd: "GetDevInfo", action: 0 }],
      token,
    )) as Array<{ code: number; value?: { DevInfo?: { model?: string } } }>;
    const model = devResp[0]?.value?.DevInfo?.model ?? "unknown";
    console.log(`  model=${model}`);
    const slug = `${safeName(cfg.slot)}-${safeName(model)}`;

    // GetAbility
    const abilityResp = await postCgi(
      cfg.host,
      "GetAbility",
      [
        {
          cmd: "GetAbility",
          action: 0,
          param: { User: { userName: cfg.username } },
        },
      ],
      token,
    );
    const out = path.join(OUT_DIR, `${slug}__getability.json`);
    fs.writeFileSync(out, JSON.stringify(abilityResp, null, 2));
    const ab = (abilityResp as any)?.[0]?.value?.Ability;
    if (ab?.abilityChn) {
      const ch0 = ab.abilityChn[0] ?? {};
      const lightSummary = [
        "lightWhiteLed",
        "lightIrLed",
        "lightDoorbell",
        "lightPower",
        "battery",
        "siren",
        "pir",
      ]
        .map((k) => `${k}=${ch0?.[k]?.ver ?? "—"}`)
        .join(", ");
      console.log(`  ch0 abilities: ${lightSummary}`);
    } else {
      console.log(`  no abilityChn in response — see ${out}`);
    }

    fs.writeFileSync(
      path.join(OUT_DIR, `${slug}__getdevinfo.json`),
      JSON.stringify(devResp, null, 2),
    );
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message}`);
  }
}

(async () => {
  const cams = loadCameras();
  console.log(`Probing CGI on ${cams.length} camera(s); output -> ${OUT_DIR}`);
  for (const c of cams) await probeCamera(c);
  console.log("\nDone.");
})();
