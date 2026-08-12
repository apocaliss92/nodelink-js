import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `seedControlStates()` issues ~8 Baichuan commands and runs on every
 * registerCamera() and rediscoverAll(). On a battery camera whose connection
 * cycles, that burst was paid on every reconnect — measured at +11 commands
 * per connect on a real Argus 3E (issue #35).
 *
 * The module keeps a per-camera timestamp so the burst is paid once per TTL.
 * These cover that gate directly, mirroring the module's own logic, because
 * importing homeassistant-mqtt pulls in an MQTT client and a live settings
 * store.
 */
const SEED_TTL_MS = 30 * 60 * 1000;

function makeGate() {
  const seededAt = new Map<string, number>();
  return {
    shouldSeed(cameraId: string, force = false): boolean {
      const last = seededAt.get(cameraId);
      if (!force && last !== undefined && Date.now() - last < SEED_TTL_MS) {
        return false;
      }
      seededAt.set(cameraId, Date.now());
      return true;
    },
    invalidate(cameraId: string) {
      seededAt.delete(cameraId);
    },
  };
}

describe("Home Assistant control-state seeding gate", () => {
  beforeEach(() => vi.useRealTimers());

  it("seeds the first time a camera registers", () => {
    const g = makeGate();
    expect(g.shouldSeed("cam-1")).toBe(true);
  });

  it("does not re-seed on a reconnect within the ttl", () => {
    const g = makeGate();
    g.shouldSeed("cam-1");
    expect(g.shouldSeed("cam-1")).toBe(false);
    expect(g.shouldSeed("cam-1")).toBe(false);
  });

  it("keeps cameras independent", () => {
    const g = makeGate();
    g.shouldSeed("cam-1");
    expect(g.shouldSeed("cam-2")).toBe(true);
  });

  it("seeds again once the ttl has passed", () => {
    vi.useFakeTimers();
    try {
      const g = makeGate();
      g.shouldSeed("cam-1");
      vi.advanceTimersByTime(SEED_TTL_MS + 1);
      expect(g.shouldSeed("cam-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-seeds on demand when forced", () => {
    // Needed when HA restarts and genuinely has no retained state.
    const g = makeGate();
    g.shouldSeed("cam-1");
    expect(g.shouldSeed("cam-1", true)).toBe(true);
  });

  it("re-seeds after explicit invalidation", () => {
    const g = makeGate();
    g.shouldSeed("cam-1");
    g.invalidate("cam-1");
    expect(g.shouldSeed("cam-1")).toBe(true);
  });

  it("uses a ttl far longer than a reconnect cycle", () => {
    // The reported loop reconnected every ~22s; a short ttl would cache nothing.
    expect(SEED_TTL_MS).toBeGreaterThan(60_000);
  });
});
