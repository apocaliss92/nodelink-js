import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeAiDetectCfg,
  patchAiDetectCfgXml,
} from "../../src/reolink/baichuan/utils/aiDetectCfg";
import {
  decodeMotionScopeBitmap,
  encodeMotionScopeBitmap,
} from "../../src/reolink/baichuan/utils/motionZone";

const fixturePath = join(
  __dirname,
  "..",
  "fixtures",
  "protocol",
  "getAiAlarm-people-response.json",
);

interface Fixture {
  cmdId: number;
  type: string;
  body: string;
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;

describe("decodeAiDetectCfg", () => {
  it("extracts all scalar fields from the E1 Zoom 'people' response", () => {
    const cfg = decodeAiDetectCfg(fixture.body);
    expect(cfg.type).toBe("people");
    expect(cfg.chn).toBe(0);
    expect(cfg.sensitivity).toBe(60);
    expect(cfg.stayTime).toBe(0);
    expect(cfg.minTargetWidth).toBe(0.5);
    expect(cfg.minTargetHeight).toBe(0.5);
    expect(cfg.maxTargetWidth).toBe(0.5);
    expect(cfg.maxTargetHeight).toBe(0.5);
    expect(cfg.width).toBe(60);
    expect(cfg.height).toBe(33);
    expect(cfg.area).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(cfg.area.length).toBeGreaterThan(0);
  });

  it("decodes the area bitmap via motion-zone helpers", () => {
    const cfg = decodeAiDetectCfg(fixture.body);
    // Fixture is all-FF (full frame monitored) — decode using the bitmap
    // size from the cfg's own grid dims (60×33).
    const grid = decodeMotionScopeBitmap(cfg.area, cfg.width, cfg.height);
    expect(grid.cells.length).toBe(60 * 33);
    expect(grid.cells.every((c) => c === true)).toBe(true);
  });

  it("throws on missing <type>", () => {
    expect(() => decodeAiDetectCfg("<AiDetectCfg></AiDetectCfg>")).toThrow(
      /missing <type>/,
    );
  });
});

describe("patchAiDetectCfgXml", () => {
  it("replaces sensitivity and stayTime independently", () => {
    let out = patchAiDetectCfgXml(fixture.body, { sensitivity: 80 });
    expect(out).toContain("<sensitivity>80</sensitivity>");
    out = patchAiDetectCfgXml(out, { stayTime: 5 });
    expect(out).toContain("<stayTime>5</stayTime>");
    // Other fields preserved
    expect(out).toContain("<minTargetWidth>0.5</minTargetWidth>");
  });

  it("replaces min/max target fractions in scientific notation (camera wire format) and clamps to [0,1]", () => {
    const out = patchAiDetectCfgXml(fixture.body, {
      minTargetWidth: 0.1,
      minTargetHeight: 0.15,
      maxTargetWidth: 1.5, // clamps to 1
      maxTargetHeight: -0.2, // clamps to 0
    });
    // Reolink wire format: scientific notation, 6 decimal places, 2-digit exponent
    expect(out).toContain("<minTargetWidth>1.000000e-01</minTargetWidth>");
    expect(out).toContain("<minTargetHeight>1.500000e-01</minTargetHeight>");
    expect(out).toContain("<maxTargetWidth>1.000000e+00</maxTargetWidth>");
    expect(out).toContain("<maxTargetHeight>0.000000e+00</maxTargetHeight>");
  });

  // Wire-format regression: this body was captured live from the Reolink app
  // (May 2026, E1 Zoom) modifying the dog_cat AI type's min/maxTarget sliders.
  // The exact serialization (scientific notation with 2-digit exponent, field
  // order, no extra whitespace) is what the camera accepts.
  it("emits the exact captured-wire format for non-default fractions", () => {
    const dogCatWireFixturePath = join(
      __dirname,
      "..",
      "fixtures",
      "protocol",
      "setAiAlarm-dog_cat-c2s-body.xml",
    );
    const captured = readFileSync(dogCatWireFixturePath, "utf-8");
    // Sanity check the captured frame's notable values
    expect(captured).toContain("<minTargetHeight>1.960321e-01</minTargetHeight>");
    expect(captured).toContain("<minTargetWidth>3.537037e-01</minTargetWidth>");
    expect(captured).toContain("<maxTargetHeight>5.000000e-01</maxTargetHeight>");
    // Reproduce the camera's serialization through our formatter
    const out = patchAiDetectCfgXml(captured, {
      minTargetHeight: 0.1960321,
      minTargetWidth: 0.3537037,
      maxTargetHeight: 0.5,
      maxTargetWidth: 0.5,
    });
    expect(out).toBe(captured);
  });

  it("round-trips area bitmap via motion-zone encode/decode", () => {
    const cfg = decodeAiDetectCfg(fixture.body);
    const grid = decodeMotionScopeBitmap(cfg.area, cfg.width, cfg.height);
    // Carve out a 10×10 hole in the top-left corner
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        grid.cells[r * cfg.width + c] = false;
      }
    }
    const newArea = encodeMotionScopeBitmap(grid);
    const out = patchAiDetectCfgXml(fixture.body, { area: newArea });
    const reparsed = decodeAiDetectCfg(out);
    expect(reparsed.area).toBe(newArea);
    const back = decodeMotionScopeBitmap(reparsed.area, cfg.width, cfg.height);
    // Top-left 10×10 must be false; rest true
    for (let r = 0; r < 33; r++) {
      for (let c = 0; c < 60; c++) {
        const expected = !(r < 10 && c < 10);
        expect(back.cells[r * 60 + c]).toBe(expected);
      }
    }
  });
});
