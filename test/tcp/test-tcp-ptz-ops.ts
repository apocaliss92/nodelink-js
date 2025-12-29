#!/usr/bin/env node
/**
 * TCP -> PTZ operations test (presets + pan/tilt/zoom).
 *
 * Requires .env:
 *  - TCP_HOST / TCP_USERNAME / TCP_PASSWORD
 *
 * Optional env:
 *  - BAICHUAN_DEBUG=1
 *  - BAICHUAN_TRACE_STREAM=1
 *  - BAICHUAN_TRACE_TALK=1
 *  - PTZ_PRESET_WRITE=1   (attempt setPreset; OFF by default to avoid modifying camera state)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n" || v === "off") return false;
  return defaultValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`[OK] ${name} (${ms}ms)`);
  } catch (e) {
    const ms = Date.now() - start;
    console.log(`[FAIL] ${name} (${ms}ms)`);
    console.log(e instanceof Error ? e.stack || e.message : e);
  }
}

function chooseFreePresetId(usedIds: Set<number>): number {
  for (let id = 1; id <= 255; id++) {
    if (!usedIds.has(id)) return id;
  }
  return 255;
}

async function main(): Promise<void> {
  const host = config.tcp.host;
  const username = config.tcp.username;
  const password = config.tcp.password;

  if (!host) throw new Error("Missing TCP_HOST in .env");
  if (!password) throw new Error("Missing TCP_PASSWORD in .env");

  const debugEnabled = envBool(process.env.BAICHUAN_DEBUG, false);
  const debugOptions = {
    enabled: debugEnabled,
    traceTalk: envBool(process.env.BAICHUAN_TRACE_TALK, false),
    traceStream: envBool(process.env.BAICHUAN_TRACE_STREAM, false),
    debugH264: envBool(process.env.BAICHUAN_DEBUG_H264, debugEnabled),
    debugParamSets: envBool(process.env.BAICHUAN_DEBUG_PARAMSETS, false),
  } as const;

  const allowPresetWrite = envBool(process.env.PTZ_PRESET_WRITE, false);

  console.log("\n============================================================");
  console.log("[INFO] Starting PTZ ops test", JSON.stringify({ host, username }, null, 2));
  console.log("============================================================\n");

  const api = new ReolinkBaichuanApi({ host, username, password, debugOptions });

  try {
    const channel = 0;

    let presets: Array<{ id: number; name: string }> = [];
    let newPresetId = 255;

    await runStep("PTZ getPresets", async () => {
      presets = await api.getPtzPresets(channel);
      console.log("[INFO] Presets:", presets);
    });

    await runStep("PTZ moveToPreset (each preset)", async () => {
      if (presets.length === 0) throw new Error("No presets returned");
      for (const preset of presets) {
        console.log(`[INFO] Moving to preset id=${preset.id} name=${preset.name}`);
        await api.moveToPtzPreset(channel, preset.id);
        await sleep(1500);
      }
    });

    if (allowPresetWrite) {
      await runStep("PTZ setPreset (choose free id)", async () => {
        const used = new Set(presets.map((p) => p.id));
        newPresetId = chooseFreePresetId(used);
        const name = `baichuan-js-${new Date().toISOString()}`;
        console.log(`[INFO] Saving preset id=${newPresetId} name=${name}`);
        await api.setPtzPreset(channel, newPresetId, name);
      });

      await runStep("PTZ getPresets (after set)", async () => {
        presets = await api.getPtzPresets(channel);
        const found = presets.find((p) => p.id === newPresetId);
        console.log("[INFO] Presets:", presets);
        if (!found) {
          throw new Error(`Preset id=${newPresetId} not found after set`);
        }
      });
    }

    // Pan tests
    await runStep("PTZ pan left", async () => {
      await api.ptz(channel, { action: "start", command: "Left", speed: 0.5 });
      await sleep(1200);
    });

    await runStep("PTZ pan right", async () => {
      await api.ptz(channel, { action: "start", command: "Right", speed: 0.5 });
      await sleep(1200);
    });

    // Tilt tests
    await runStep("PTZ tilt up", async () => {
      await api.ptz(channel, { action: "start", command: "Up", speed: 0.5 });
      await sleep(1200);
    });

    await runStep("PTZ tilt down", async () => {
      await api.ptz(channel, { action: "start", command: "Down", speed: 0.5 });
      await sleep(1200);
    });

    // Zoom tests (absolute zoom position via cmd_id 294/295)
    let zoomSupported = false;
    await runStep("ZoomFocus read", async () => {
      const zf = await api.getZoomFocus(channel);
      console.log("[INFO] ZoomFocus:", zf);
      zoomSupported = !!zf.zoom;
      if (!zoomSupported) {
        throw new Error("Zoom is not supported (no <zoom> section in response)");
      }
    });

    if (zoomSupported) {
      await runStep("Zoom to 1.2x", async () => {
        await api.zoomToFactor(channel, 1.2);
        await sleep(1200);
      });

      await runStep("Zoom back to 1.0x", async () => {
        await api.zoomToFactor(channel, 1.0);
        await sleep(1200);
      });
    }

    console.log("\n[OK] PTZ ops test completed");
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error("\n[ERROR] PTZ ops test failed");
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exitCode = 1;
});
