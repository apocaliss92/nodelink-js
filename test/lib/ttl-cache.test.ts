import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../../src/reolink/baichuan/utils/ttlCache";

describe("TtlCache", () => {
  it("returns a stored value while it is still fresh", () => {
    const c = new TtlCache<string>(1000);
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
  });

  it("treats a value as absent once the ttl has elapsed", () => {
    vi.useFakeTimers();
    try {
      const c = new TtlCache<string>(1000);
      c.set("k", "v");
      vi.advanceTimersByTime(999);
      expect(c.get("k")).toBe("v");
      vi.advanceTimersByTime(2);
      expect(c.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps entries separated by key", () => {
    const c = new TtlCache<number>(1000);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
  });

  it("exposes a stale value so callers can prefer it over an empty result", () => {
    // A camera that answers with nothing (common on NVR/hub, or a sleeping
    // battery cam) must not be allowed to erase a previously good answer.
    vi.useFakeTimers();
    try {
      const c = new TtlCache<string>(1000);
      c.set("k", "good");
      vi.advanceTimersByTime(5000);
      expect(c.get("k")).toBeUndefined();
      expect(c.getStale("k")).toBe("good");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears everything on invalidate", () => {
    const c = new TtlCache<number>(1000);
    c.set("a", 1);
    c.set("b", 2);
    c.clear();
    expect(c.get("a")).toBeUndefined();
    expect(c.getStale("a")).toBeUndefined();
    expect(c.get("b")).toBeUndefined();
  });

  it("overwrites and refreshes the timestamp on re-set", () => {
    vi.useFakeTimers();
    try {
      const c = new TtlCache<string>(1000);
      c.set("k", "old");
      vi.advanceTimersByTime(900);
      c.set("k", "new");
      vi.advanceTimersByTime(900);
      // Would have expired against the first write, still fresh against the second.
      expect(c.get("k")).toBe("new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a non-positive ttl as 'never cache'", () => {
    const c = new TtlCache<string>(0);
    c.set("k", "v");
    expect(c.get("k")).toBeUndefined();
    // Still retrievable as stale, so it can serve as an empty-result fallback.
    expect(c.getStale("k")).toBe("v");
  });
});
