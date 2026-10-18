import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  computeDeviceCapabilities,
  parseSupportXml,
} from "../../src/reolink/baichuan/capabilities";
import type {
  DeviceAbilities,
  SupportInfo,
} from "../../src/reolink/baichuan/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "..", "fixtures", "models");

function loadModelJson(model: string, channel: number, file: string): any {
  const filePath = path.join(MODELS_DIR, model, "channels", String(channel), file);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

interface ModelFixture {
  model: string;
  support: SupportInfo | undefined;
  abilities: DeviceAbilities | undefined;
}

function loadFixture(dir: string): ModelFixture {
  const summary = loadModelJson(dir, 0, "_summary.json");
  return {
    model: summary?.model ?? "unknown",
    support: loadModelJson(dir, 0, "support-info.json"),
    abilities: loadModelJson(dir, 0, "ability-info.json"),
  };
}

// Every doorbell captured before the PoE one reports a positive
// `doorbellVersion` in SupportInfo, which is why the model fallback was never
// exercised — and never noticed to be unreachable.
const DOORBELLS_WITH_SUPPORT_FLAG = [
  "Reolink_Video_Doorbell",
  "Reolink_Video_Doorbell_WiFi",
  "Reolink_Video_Doorbell_WiFi-W",
];

const NON_DOORBELLS = [
  "Argus_3E",
  "Argus_PT_Plus",
  "Argus_PT_Ultra",
  "E1_Outdoor_PoE",
  "E1_Zoom",
  "Reolink_Duo_3_WiFi",
  "RLC-510WA",
  "RLC-810A",
];

describe("doorbell detection", () => {
  describe("NVR channel type", () => {
    const support = parseSupportXml(`<Support><channelNum>8</channelNum>
      <item><chnID>3</chnID><channelType>Doorbell</channelType><doorbellVersion>0</doorbellVersion></item>
      <item><chnID>4</chnID><channelType>ipc</channelType><doorbellVersion>0</doorbellVersion></item>
    </Support>`);

    it("recognizes Doorbell with doorbellVersion=0 after parsing SupportInfo", () => {
      expect(computeDeviceCapabilities({ channel: 3, support }).isDoorbell).toBe(true);
    });

    it("does not apply another channel's type", () => {
      expect(computeDeviceCapabilities({ channel: 4, support }).isDoorbell).toBe(false);
      expect(computeDeviceCapabilities({ channel: 2, support }).isDoorbell).toBe(false);
    });

    it.each(["doorbell", "DOORBELL", " Doorbell "])(
      "accepts channelType %j",
      (channelType) => {
        const caps = computeDeviceCapabilities({
          channel: 3,
          support: { items: [{ chnID: 3, channelType, doorbellVersion: 0 }] },
        });
        expect(caps.isDoorbell).toBe(true);
      },
    );
  });

  describe("Reolink Video Doorbell PoE (issue #25)", () => {
    // DB_566128M5MP_P, fw v3.0.0.2033_23041302. Standalone TCP, not on an NVR.
    // Its SupportInfo carries no `doorbellVersion` at all, so the model name is
    // the only signal the firmware gives us.
    const fixture = loadFixture("Reolink_Video_Doorbell_PoE");

    it("the fixture really lacks doorbellVersion (guards the premise)", () => {
      expect(fixture.support).toBeDefined();
      const items = (fixture.support as any).items ?? [];
      expect(items.length).toBeGreaterThan(0);
      expect(items.some((i: any) => "doorbellVersion" in i)).toBe(false);
    });

    it("is detected as a doorbell from the model name", () => {
      const caps = computeDeviceCapabilities({
        channel: 0,
        model: fixture.model,
        ...(fixture.support && { support: fixture.support }),
        ...(fixture.abilities && { abilities: fixture.abilities }),
      });
      expect(caps.isDoorbell).toBe(true);
    });

    it("keeps its floodlight — the doorbell/lightType override must not fire", () => {
      // capabilities.ts guards the floodlight with `isDoorbellFromSupport`, not
      // `isDoorbell`. This device has no doorbellVersion, so learning it is a
      // doorbell from the model must leave hasFloodlight alone.
      const caps = computeDeviceCapabilities({
        channel: 0,
        model: fixture.model,
        ...(fixture.support && { support: fixture.support }),
        ...(fixture.abilities && { abilities: fixture.abilities }),
      });
      expect(caps.hasFloodlight).toBe(true);
      expect(caps.hasIntercom).toBe(true);
    });

    it("without a model it is NOT detected — the support flag alone cannot see it", () => {
      // Documents exactly what issue #25 hit: this is the shape produced when
      // the caller omits `model`.
      const caps = computeDeviceCapabilities({
        channel: 0,
        ...(fixture.support && { support: fixture.support }),
        ...(fixture.abilities && { abilities: fixture.abilities }),
      });
      expect(caps.isDoorbell).toBe(false);
    });
  });

  describe("doorbells that advertise doorbellVersion", () => {
    it.each(DOORBELLS_WITH_SUPPORT_FLAG)(
      "%s is detected without needing the model",
      (dir) => {
        const fixture = loadFixture(dir);
        const caps = computeDeviceCapabilities({
          channel: 0,
          ...(fixture.support && { support: fixture.support }),
          ...(fixture.abilities && { abilities: fixture.abilities }),
        });
        expect(caps.isDoorbell).toBe(true);
      },
    );
  });

  describe("non-doorbells stay non-doorbells", () => {
    it.each(NON_DOORBELLS)("%s with its real model name", (dir) => {
      const fixture = loadFixture(dir);
      const caps = computeDeviceCapabilities({
        channel: 0,
        model: fixture.model,
        ...(fixture.support && { support: fixture.support }),
        ...(fixture.abilities && { abilities: fixture.abilities }),
      });
      expect(caps.isDoorbell).toBe(false);
    });
  });
});
