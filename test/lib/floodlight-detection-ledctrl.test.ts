import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDeviceCapabilities,
  xmlIndicatesFloodlight,
} from "../../src/reolink/baichuan/capabilities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.join(__dirname, "..", "fixtures", "models");

function load(model: string, file: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(MODELS, model, "channels", "0", file), "utf-8"),
  );
}

function detect(model: string): boolean {
  const support = load(model, "support-info.json");
  const abilities = load(model, "ability-info.json");
  return computeDeviceCapabilities({
    channel: 0,
    support,
    abilities,
  }).hasFloodlight;
}

describe("Floodlight detection — driven by captured SupportInfo / AbilityInfo", () => {
  it("Reolink Duo 3 WiFi (lightType=1 + ledCtrl=38) → has floodlight (PR #22 regression)", () => {
    expect(detect("Reolink_Duo_3_WiFi")).toBe(true);
  });

  it("Reolink Video Doorbell WiFi (lightType undef + ledCtrl=35840) → has floodlight", () => {
    expect(detect("Reolink_Video_Doorbell_WiFi")).toBe(true);
  });

  it("Reolink Video Doorbell WiFi-W (lightType undef + ledCtrl=35840) → has floodlight", () => {
    expect(detect("Reolink_Video_Doorbell_WiFi-W")).toBe(true);
  });

  it("Reolink E1 Outdoor PoE (lightType undef + ledCtrl=3) → has floodlight", () => {
    expect(detect("E1_Outdoor_PoE")).toBe(true);
  });

  it("Reolink E1 Zoom (lightType=0 + ledCtrl=1) → no floodlight (status LED only)", () => {
    expect(detect("E1_Zoom")).toBe(false);
  });

  it("Reolink Video Doorbell (UID 9527…, lightType=0 + ledCtrl=3073 + doorbellVersion=31) → no floodlight", () => {
    // Regression for a doorbell whose owner confirmed the hardware has no
    // spotlight, yet ledCtrl=3073 (>1) would historically promote the rescue
    // path to hasFloodlight=true. Rule: when the firmware says lightType=0
    // on a doorbell (doorbellVersion > 0), trust it. See capabilities.ts.
    expect(detect("Reolink_Video_Doorbell")).toBe(false);
  });
});

describe("xmlIndicatesFloodlight caveat", () => {
  it("returns true even on E1 Zoom (no real spotlight) because firmware sends boilerplate FloodlightTask", () => {
    // Documents the well-known unreliability of cmd 289 XML as a sole
    // discriminator: the firmware emits a generic FloodlightTask template
    // (brightness controls, schedule, lightSensThreshold) on cameras that
    // don't physically have a floodlight. This is why the ledCtrl-bitmask
    // rescue path in `computeDeviceCapabilities` matters.
    const xml = fs.readFileSync(
      path.join(MODELS, "E1_Zoom", "channels", "0", "cmd289-white-led.xml"),
      "utf-8",
    );
    expect(xmlIndicatesFloodlight(xml)).toBe(true);
  });
});
