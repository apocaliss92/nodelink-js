/**
 * Verify `support.items[*].binoCfg` is enough on its own to identify a
 * multi-focal / binocular camera, independent of the legacy model-name list.
 *
 * Driven by reverse-engineering the Reolink Electron client against an
 * Argus 3 standalone (UDP/Baichuan capture, 2026-05-18): the desktop app
 * derives `systemCfg.cameraType === "binocular"` from the same SupportInfo
 * `binoCfg` flag we read via cmd_id 199, so this is the firmware-level
 * source of truth.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.join(__dirname, "..", "fixtures", "models");

function loadSupport(model: string): any {
  const p = path.join(MODELS, model, "channels", "0", "support-info.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function findItem(si: any): any {
  return (si?.items ?? []).find(
    (it: any) => it && typeof it === "object" && "ledCtrl" in it,
  );
}

function binoFlag(model: string): number | undefined {
  const si = loadSupport(model);
  const item = findItem(si);
  if (!item) return undefined;
  const v = item.binoCfg;
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) : undefined;
}

function doorbellVersion(model: string): number | undefined {
  const si = loadSupport(model);
  const item = findItem(si);
  if (!item) return undefined;
  const v = item.doorbellVersion;
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) : undefined;
}

describe("Multi-focal / binocular detection via SupportInfo.binoCfg", () => {
  it("Reolink Duo 3 WiFi reports binoCfg=1 (stitched dual sensor)", () => {
    expect(binoFlag("Reolink_Duo_3_WiFi")).toBe(1);
  });

  it("Standard single-lens cameras report binoCfg=0 or absent", () => {
    expect(binoFlag("E1_Outdoor_PoE") ?? 0).toBe(0);
    expect(binoFlag("E1_Zoom") ?? 0).toBe(0);
    expect(binoFlag("RLC-510WA") ?? 0).toBe(0);
    expect(binoFlag("E1_E321") ?? 0).toBe(0);
  });

  it("NVR child Argus cameras report binoCfg=0 (single channel each)", () => {
    expect(binoFlag("Argus_3E") ?? 0).toBe(0);
    expect(binoFlag("Argus_PT_Ultra") ?? 0).toBe(0);
  });

  it("Doorbell cameras report binoCfg=0 or absent", () => {
    expect(binoFlag("Reolink_Video_Doorbell_WiFi") ?? 0).toBe(0);
    expect(binoFlag("Reolink_Video_Doorbell_WiFi-W") ?? 0).toBe(0);
  });
});

describe("Doorbell detection via SupportInfo.doorbellVersion", () => {
  it("Video Doorbell WiFi reports doorbellVersion=25", () => {
    expect(doorbellVersion("Reolink_Video_Doorbell_WiFi")).toBe(25);
  });

  it("Video Doorbell WiFi-W reports doorbellVersion=1", () => {
    expect(doorbellVersion("Reolink_Video_Doorbell_WiFi-W")).toBe(1);
  });

  it("Non-doorbell cameras report doorbellVersion=0 or absent", () => {
    expect(doorbellVersion("Reolink_Duo_3_WiFi") ?? 0).toBe(0);
    expect(doorbellVersion("E1_Outdoor_PoE") ?? 0).toBe(0);
    expect(doorbellVersion("E1_Zoom") ?? 0).toBe(0);
    expect(doorbellVersion("Argus_3E") ?? 0).toBe(0);
  });
});
