import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { computeExpectedStreamCompatibility } from "../../src/debug/DiagnosticsTools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "..", "fixtures", "models");

function loadComboTest(model: string): any {
  const filePath = path.join(MODELS_DIR, model, "channels", "0", "stream-combination-test.json");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Expected stream compatibility matrix — single-lens camera
// ---------------------------------------------------------------------------
describe("computeExpectedStreamCompatibility — single-lens", () => {
  const compat = computeExpectedStreamCompatibility({ channelCount: 1 });

  it("has 3 pairs (main+sub, main+ext, sub+ext)", () => {
    expect(compat).toHaveLength(3);
  });

  it("main+sub → OK (streamType 0 vs 1)", () => {
    const pair = compat.find((c) => c.pair[0] === "main" && c.pair[1] === "sub");
    expect(pair?.expectedOk).toBe(true);
  });

  it("main+ext → FAIL (both streamType 0)", () => {
    const pair = compat.find((c) => c.pair[0] === "main" && c.pair[1] === "ext");
    expect(pair?.expectedOk).toBe(false);
  });

  it("sub+ext → OK (streamType 1 vs 0)", () => {
    const pair = compat.find((c) => c.pair[0] === "sub" && c.pair[1] === "ext");
    expect(pair?.expectedOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Expected stream compatibility matrix — multifocal camera (2 channels)
// ---------------------------------------------------------------------------
describe("computeExpectedStreamCompatibility — multifocal (2ch)", () => {
  const compat = computeExpectedStreamCompatibility({ channelCount: 2 });

  it("has 15 pairs (6C2 = 15 for 6 streams)", () => {
    expect(compat).toHaveLength(15);
  });

  // Same channel, same streamType → FAIL
  it("ch0_main+ch0_ext → FAIL (same channel, both st=0)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_main" && c.pair[1] === "ch0_ext");
    expect(pair?.expectedOk).toBe(false);
  });

  it("ch1_main+ch1_ext → FAIL (same channel, both st=0)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch1_main" && c.pair[1] === "ch1_ext");
    expect(pair?.expectedOk).toBe(false);
  });

  // Same channel, different streamType → OK
  it("ch0_main+ch0_sub → OK (same channel, st 0 vs 1)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_main" && c.pair[1] === "ch0_sub");
    expect(pair?.expectedOk).toBe(true);
  });

  it("ch1_main+ch1_sub → OK (same channel, st 0 vs 1)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch1_main" && c.pair[1] === "ch1_sub");
    expect(pair?.expectedOk).toBe(true);
  });

  // Cross-channel, same profile → FAIL (multifocal rejects)
  it("ch0_main+ch1_main → FAIL (same profile across channels)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_main" && c.pair[1] === "ch1_main");
    expect(pair?.expectedOk).toBe(false);
  });

  it("ch0_sub+ch1_sub → FAIL (same profile across channels)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_sub" && c.pair[1] === "ch1_sub");
    expect(pair?.expectedOk).toBe(false);
  });

  it("ch0_ext+ch1_ext → FAIL (same profile across channels)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_ext" && c.pair[1] === "ch1_ext");
    expect(pair?.expectedOk).toBe(false);
  });

  // Cross-channel, different streamType → OK (the valid multifocal pairings)
  it("ch0_main+ch1_sub → OK (cross-channel, st 0 vs 1) — streaming:a pairing", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_main" && c.pair[1] === "ch1_sub");
    expect(pair?.expectedOk).toBe(true);
  });

  it("ch0_sub+ch1_main → OK (cross-channel, st 1 vs 0) — general socket pairing", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_sub" && c.pair[1] === "ch1_main");
    expect(pair?.expectedOk).toBe(true);
  });

  it("ch0_sub+ch1_ext → OK (cross-channel, st 1 vs 0)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_sub" && c.pair[1] === "ch1_ext");
    expect(pair?.expectedOk).toBe(true);
  });

  it("ch0_ext+ch1_sub → OK (cross-channel, st 0 vs 1)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_ext" && c.pair[1] === "ch1_sub");
    expect(pair?.expectedOk).toBe(true);
  });

  // Cross-channel, same streamType but different profiles → FAIL
  it("ch0_main+ch1_ext → FAIL (cross-channel, both st=0)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_main" && c.pair[1] === "ch1_ext");
    expect(pair?.expectedOk).toBe(false);
  });

  it("ch0_ext+ch1_main → FAIL (cross-channel, both st=0)", () => {
    const pair = compat.find((c) => c.pair[0] === "ch0_ext" && c.pair[1] === "ch1_main");
    expect(pair?.expectedOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validate live test results against expected matrix (from fixtures)
// ---------------------------------------------------------------------------
describe("stream combination test — E1 Zoom (from fixtures)", () => {
  const data = loadComboTest("E1_Zoom");

  it("fixture exists", () => {
    expect(data).toBeDefined();
  });

  it("is single-lens", () => {
    expect(data?.isMultifocal).toBe(false);
    expect(data?.channelCount).toBe(1);
  });

  it("all results match expected", () => {
    if (!data?.results) return;
    for (const r of data.results) {
      expect(r.matchesExpected).toBe(true);
    }
  });

  it("main+sub is OK", () => {
    const r = data?.results?.find((r: any) => r.pair[0] === "main" && r.pair[1] === "sub");
    expect(r?.ok).toBe(true);
  });

  it("main+ext is FAIL", () => {
    const r = data?.results?.find((r: any) => r.pair[0] === "main" && r.pair[1] === "ext");
    expect(r?.ok).toBe(false);
  });

  it("sub+ext is OK", () => {
    const r = data?.results?.find((r: any) => r.pair[0] === "sub" && r.pair[1] === "ext");
    expect(r?.ok).toBe(true);
  });

  it("no unexpected results", () => {
    expect(data?.summary?.unexpected).toEqual([]);
  });
});
