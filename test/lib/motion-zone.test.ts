import { describe, it, expect } from "vitest";
import {
  decodeMotionScopeBitmap,
  encodeMotionScopeBitmap,
  fullCoverageScope,
} from "../../src/reolink/baichuan/utils/motionZone";

describe("motion zone bitmap helpers", () => {
  // Synthetic 8×2 grid: row 0 all on, row 1 all off → bytes = ff 00 → "/wA="
  it("round-trips a small grid", () => {
    const scope = {
      columns: 8,
      rows: 2,
      cells: [true, true, true, true, true, true, true, true,
              false, false, false, false, false, false, false, false],
    };
    const encoded = encodeMotionScopeBitmap(scope);
    const decoded = decodeMotionScopeBitmap(encoded, 8, 2);
    expect(decoded.cells).toEqual(scope.cells);
  });

  it("encodes a 96×64 full-coverage grid to the camera's idle pattern", () => {
    const scope = fullCoverageScope(96, 64);
    const encoded = encodeMotionScopeBitmap(scope);
    // 96 * 64 = 6144 bits = 768 bytes = 1024 base64 chars (all 'A' would be
    // empty, '/' = 0x3F so all-on encodes to '/'+ pattern). Verify length
    // and that roundtrip preserves cells.
    expect(encoded.length).toBe(1024);
    const back = decodeMotionScopeBitmap(encoded, 96, 64);
    expect(back.cells.every((c) => c === true)).toBe(true);
  });

  // Real fixture captured from the in-app Capture tool on an E1 Zoom.
  // The interesting bit: the bitmap is NOT a pure "everything on" — there's
  // an alternating columns-on/columns-off pattern in the bottom half. The
  // round-trip must preserve this exactly or the camera rejects the SET.
  it("round-trips the E1 Zoom capture fixture", () => {
    const fixture =
      "//////////AAAAAA".repeat(32) + "AAAAAAAAAAAAAAAA".repeat(32);
    const scope = decodeMotionScopeBitmap(fixture, 96, 64);
    expect(scope.cells.length).toBe(6144);
    // First row should follow the //////////AAAAAA pattern → first 60 cells
    // on (5*12=60), next 36 off.
    expect(scope.cells.slice(0, 60).every((c) => c === true)).toBe(true);
    expect(scope.cells.slice(60, 96).every((c) => c === false)).toBe(true);
    expect(encodeMotionScopeBitmap(scope)).toBe(fixture);
  });
});
