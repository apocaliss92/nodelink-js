import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { computeDeviceCapabilities } from "../../src/reolink/baichuan/capabilities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.join(__dirname, "..", "fixtures", "models");

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

const models = fs
  .readdirSync(MODELS)
  .map((model) => ({ model, dir: path.join(MODELS, model, "channels", "0") }))
  .filter(({ dir }) =>
    ["support-info.json", "ability-info.json", "capabilities.json"].every((f) =>
      fs.existsSync(path.join(dir, f)),
    ),
  );

describe("hasPir derivation over recorded model fixtures", () => {
  it("covers the recorded models", () => {
    expect(models.length).toBeGreaterThanOrEqual(10);
  });

  it.each(models)("$model: hasPir matches the recorded value", ({ dir }) => {
    const recorded = readJson(path.join(dir, "capabilities.json"));
    const caps = computeDeviceCapabilities({
      channel: 0,
      support: readJson(path.join(dir, "support-info.json")),
      abilities: readJson(path.join(dir, "ability-info.json")),
    });
    expect(caps.hasPir).toBe(recorded.capabilities.hasPir);
  });
});

describe("hasPir: a battery alone is not a PIR", () => {
  it("battery camera with no rf signal and no pir ability has no PIR", () => {
    const caps = computeDeviceCapabilities({
      channel: 0,
      support: {
        items: [{ chnID: 0, battery: 2, rfCfg: 0, ptzType: 0 }],
      } as any,
      abilities: { "0": { preview_rw: 1, motion_rw: 1 } } as any,
    });
    expect(caps.hasBattery).toBe(true);
    expect(caps.hasPir).toBe(false);
  });
});
