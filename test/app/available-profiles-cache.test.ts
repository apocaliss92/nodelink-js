import { describe, expect, it, vi } from "vitest";
import {
  AVAILABLE_PROFILES_TTL_MS,
  availableProfilesCache,
  invalidateAvailableProfiles,
} from "../../app/src/available-profiles-cache";

describe("availableProfilesCache (issue #35)", () => {
  it("survives across API instances, which is the whole point", () => {
    // The per-API-instance cache inside buildVideoStreamOptions is rebuilt cold
    // on every reconnect, so a battery camera whose connection cycles was read
    // — and therefore woken — once per cycle. This cache is keyed by camera,
    // not by connection, so a reconnect reuses it.
    availableProfilesCache.set("cam-1", ["main", "sub"]);
    expect(availableProfilesCache.get("cam-1")).toEqual(["main", "sub"]);
  });

  it("keeps cameras independent", () => {
    availableProfilesCache.set("cam-a", ["main"]);
    availableProfilesCache.set("cam-b", ["main", "sub", "ext"]);
    expect(availableProfilesCache.get("cam-a")).toEqual(["main"]);
    expect(availableProfilesCache.get("cam-b")).toEqual(["main", "sub", "ext"]);
  });

  it("expires so a camera whose profiles genuinely changed is re-read", () => {
    vi.useFakeTimers();
    try {
      availableProfilesCache.set("cam-ttl", ["main"]);
      vi.advanceTimersByTime(AVAILABLE_PROFILES_TTL_MS - 1);
      expect(availableProfilesCache.get("cam-ttl")).toEqual(["main"]);
      vi.advanceTimersByTime(2);
      expect(availableProfilesCache.get("cam-ttl")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be invalidated for one camera when its config changes", () => {
    availableProfilesCache.set("cam-x", ["main", "sub"]);
    availableProfilesCache.set("cam-y", ["main"]);
    invalidateAvailableProfiles("cam-x");
    expect(availableProfilesCache.get("cam-x")).toBeUndefined();
    // Unrelated cameras must not be disturbed — otherwise editing one camera
    // wakes every other battery camera on the next reconnect.
    expect(availableProfilesCache.get("cam-y")).toEqual(["main"]);
  });

  it("uses a ttl long enough to absorb a reconnect loop", () => {
    // The reported loop reconnected every ~22s. A ttl below that would cache
    // nothing in practice.
    expect(AVAILABLE_PROFILES_TTL_MS).toBeGreaterThan(60_000);
  });
});
