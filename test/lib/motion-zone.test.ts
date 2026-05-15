import { describe, it, expect } from "vitest";
import {
  decodeMotionScopeBitmap,
  encodeMotionScopeBitmap,
  fullCoverageScope,
} from "../../src/reolink/baichuan/utils/motionZone";

describe("motion zone bitmap helpers", () => {
  // Synthetic 8×2 grid where width == columns. Row 0 all on, row 1 all
  // off → bytes = ff 00.
  it("round-trips a small grid where active region equals bitmap", () => {
    const scope = {
      width: 8,
      height: 2,
      columns: 8,
      rows: 2,
      cells: [true, true, true, true, true, true, true, true,
              false, false, false, false, false, false, false, false],
    };
    const encoded = encodeMotionScopeBitmap(scope);
    const decoded = decodeMotionScopeBitmap(encoded, 8, 2, 8, 2);
    expect(decoded.cells).toEqual(scope.cells);
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(2);
  });

  it("encodes a 96×64 full-coverage grid where width also = 96, height = 64", () => {
    const scope = fullCoverageScope(96, 64);
    expect(scope.width).toBe(96);
    expect(scope.height).toBe(64);
    expect(scope.cells).toHaveLength(6144);
    const encoded = encodeMotionScopeBitmap(scope);
    expect(encoded.length).toBe(1024);
    const back = decodeMotionScopeBitmap(encoded, 96, 64, 96, 64);
    expect(back.cells.every((c) => c === true)).toBe(true);
  });

  // Real E1 Zoom shape: bitmap 96×64 but the active region is 60×33.
  // The valueTable encodes a "first 60 cells of first 32 rows all on,
  // rest off" pattern. The decoder should return a 60×33 grid where:
  //   - row 0 .. 31: cell on
  //   - row 32: all cells off (33rd row is at byte boundary 32*96=3072)
  it("decodes the E1 Zoom active region distinctly from the full bitmap", () => {
    const fixture =
      "//////////AAAAAA".repeat(32) + "AAAAAAAAAAAAAAAA".repeat(32);
    const scope = decodeMotionScopeBitmap(fixture, 96, 64, 60, 33);
    expect(scope.width).toBe(60);
    expect(scope.height).toBe(33);
    expect(scope.cells.length).toBe(60 * 33);
    // Row 0: all 60 cells on
    expect(scope.cells.slice(0, 60).every((c) => c === true)).toBe(true);
    // Row 31: all 60 cells on
    expect(scope.cells.slice(31 * 60, 31 * 60 + 60).every((c) => c === true)).toBe(true);
    // Row 32: all 60 cells off (last active row in this fixture)
    expect(scope.cells.slice(32 * 60, 32 * 60 + 60).every((c) => c === false)).toBe(true);
  });

  it("re-encoding the active region preserves bitmap padding bits", () => {
    const fixture =
      "//////////AAAAAA".repeat(32) + "AAAAAAAAAAAAAAAA".repeat(32);
    const scope = decodeMotionScopeBitmap(fixture, 96, 64, 60, 33);
    const reencoded = encodeMotionScopeBitmap(scope);
    // First 32 rows: 60 active bits set then 36 padding bits zero per row.
    // Original `//////////AAAAAA` = 60 ones + 36 zeros, repeats 32 times.
    // Re-encoded must match for those rows. Padding rows 33+ stay 0.
    expect(reencoded.slice(0, 32 * 16)).toBe("//////////AAAAAA".repeat(32));
    expect(reencoded.slice(32 * 16, 33 * 16)).toBe("AAAAAAAAAAAAAAAA");
  });
});
