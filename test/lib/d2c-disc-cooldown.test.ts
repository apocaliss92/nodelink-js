/**
 * A D2C_DISC on an AWAKE camera (flapping link) must give a short capped
 * backoff (10 s, then 30 s), never the 120 s storm cooldown, while a genuine
 * sleep keeps refusing redials for 120 s. The refusal names the real reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

type CooldownEntry = { cooldownUntil: number };
type Internals = {
  notifyD2cDisc(sessionAgeMs: number): void;
  socketPoolCooldowns: Map<string, CooldownEntry>;
  getSleepStatus: () => { state: "awake" | "sleeping" | "unknown" };
  acquirePooledSocket(tag: string): Promise<unknown>;
};

const makeApi = (state: "awake" | "sleeping" | "unknown") => {
  const api = new ReolinkBaichuanApi({
    host: "192.0.2.1",
    username: "u",
    password: "p",
    transport: "udp",
  } as never);
  const i = api as unknown as Internals;
  i.getSleepStatus = () => ({ state });
  return i;
};

const remaining = (i: Internals, now: number) =>
  (i.socketPoolCooldowns.get("192.0.2.1")?.cooldownUntil ?? now) - now;

describe("D2C_DISC cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("awake flapping: 10 s, then 30 s, never 120 s", () => {
    const i = makeApi("awake");
    const seen: number[] = [];
    for (let n = 0; n < 6; n++) {
      i.notifyD2cDisc(5_000);
      seen.push(remaining(i, Date.now()));
      vi.advanceTimersByTime(12_000);
    }
    expect(seen[0]).toBe(10_000);
    expect(seen.slice(1).every((ms) => ms === 30_000)).toBe(true);
  });

  it("real sleep: 3 drops in the window still give the 120 s cooldown", () => {
    const i = makeApi("sleeping");
    for (let n = 0; n < 3; n++) {
      i.notifyD2cDisc(300_000);
      vi.advanceTimersByTime(1_000);
    }
    expect(remaining(i, Date.now())).toBeGreaterThan(110_000);
  });

  it("unknown sleep state keeps the legacy behaviour", () => {
    const i = makeApi("unknown");
    for (let n = 0; n < 3; n++) i.notifyD2cDisc(1_000);
    expect(remaining(i, Date.now())).toBe(120_000);
  });

  it("a redial during a real sleep is refused and labelled sleeping", async () => {
    const i = makeApi("sleeping");
    i.notifyD2cDisc(300_000);
    await expect(i.acquirePooledSocket("general")).rejects.toThrow(
      /camera sleeping/,
    );
  });

  it("a redial after an awake flap is refused with the real reason", async () => {
    const i = makeApi("awake");
    i.notifyD2cDisc(5_000);
    const err = await i.acquirePooledSocket("general").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/cooldown after disconnect/);
    expect((err as Error).message).not.toMatch(/camera sleeping/);
  });
});
