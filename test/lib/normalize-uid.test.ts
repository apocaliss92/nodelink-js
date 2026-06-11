/**
 * Tests for normalizeUid — the canonical entry-point UID scrubber.
 *
 * Two non-obvious constraints to keep:
 *
 * 1. Result MUST be uppercase. Reolink's cloud API is case-sensitive
 *    on UID and returns HTTP 400 invalid_parameters for lowercase,
 *    losing us the per-UID zone hint. BCUDP discovery packets embed
 *    the UID in the <uid> XML field and cameras self-match
 *    case-sensitively, so a lowercase UID also makes local-direct
 *    discovery silently fail.
 *
 * 2. Empty / whitespace-only / undefined / null inputs must return
 *    `undefined` (not an empty string). Several callers downstream
 *    treat the absence of a UID as the signal to use only
 *    `local-direct` discovery; an empty string would corrupt that
 *    branch.
 */

import { describe, expect, it } from "vitest";
import { maskUid, normalizeUid } from "../../src/reolink/autodetect";

describe("normalizeUid", () => {
  it("returns the uid uppercase + trimmed", () => {
    expect(normalizeUid("  aaaa1111bbbb2222  ")).toBe("AAAA1111BBBB2222");
  });

  it("uppercases lowercase input (fixes Reolink HTTP 400 + BCUDP self-match)", () => {
    expect(normalizeUid("aaaa1111bbbb2222")).toBe("AAAA1111BBBB2222");
  });

  it("uppercases mixed-case input", () => {
    expect(normalizeUid("AaBb1111CcDd2222")).toBe("AABB1111CCDD2222");
  });

  it("leaves digits and already-uppercase letters alone", () => {
    expect(normalizeUid("AAAA1111BBBB2222")).toBe("AAAA1111BBBB2222");
  });

  it("returns undefined for empty / whitespace-only input", () => {
    expect(normalizeUid("")).toBeUndefined();
    expect(normalizeUid("   ")).toBeUndefined();
  });

  it("returns undefined for null / undefined input", () => {
    expect(normalizeUid(undefined)).toBeUndefined();
    // @ts-expect-error — runtime defensive contract
    expect(normalizeUid(null)).toBeUndefined();
  });
});

describe("maskUid", () => {
  it("masks the middle of a long UID for safe logging", () => {
    expect(maskUid("AAAA1111BBBB2222")).toBe("AAAA…2222");
  });

  it("returns short UIDs (<=8 chars) verbatim — nothing to hide", () => {
    expect(maskUid("ABCD1234")).toBe("ABCD1234");
  });

  it("trims whitespace before masking", () => {
    expect(maskUid("  AAAA1111BBBB2222  ")).toBe("AAAA…2222");
  });
});
