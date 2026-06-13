import { describe, it, expect, vi } from "vitest";
import { AlwaysOnController } from "../../src/baichuan/stream/AlwaysOnController";

type SimpleEvent = { type: string; channel: number; timestamp: number };

function makeApi() {
  let cb: ((e: SimpleEvent) => void) | null = null;
  return {
    onSimpleEvent: vi.fn(async (f: (e: SimpleEvent) => void) => { cb = f; }),
    offSimpleEvent: vi.fn(async () => { cb = null; }),
    wakeUp: vi.fn(async () => {}),
    emitEvent: (e: SimpleEvent) => cb?.(e),
  };
}

describe("AlwaysOnController", () => {
  it("opens a window on a matching trigger and closes it after windowMs", async () => {
    vi.useFakeTimers();
    const api = makeApi();
    const goLive = vi.fn(async () => {});
    const goIdle = vi.fn(async () => {});
    const ctrl = new AlwaysOnController({
      api: api as any,
      channel: 0,
      options: { enabled: true, triggers: ["motion"], windowMs: 15_000, primeOnStart: false },
      goLive,
      goIdle,
    });
    await ctrl.start();

    api.emitEvent({ type: "motion", channel: 0, timestamp: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(goLive).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(14_000);
    api.emitEvent({ type: "motion", channel: 0, timestamp: 2 }); // extends window
    await vi.advanceTimersByTimeAsync(14_000);
    expect(goIdle).not.toHaveBeenCalled(); // extended

    await vi.advanceTimersByTimeAsync(2_000);
    expect(goIdle).toHaveBeenCalledOnce();

    await ctrl.stop();
    vi.useRealTimers();
  });

  it("ignores non-matching channels and event types", async () => {
    const api = makeApi();
    const goLive = vi.fn(async () => {});
    const ctrl = new AlwaysOnController({
      api: api as any, channel: 0,
      options: { enabled: true, triggers: ["motion"], primeOnStart: false },
      goLive, goIdle: vi.fn(async () => {}),
    });
    await ctrl.start();
    api.emitEvent({ type: "motion", channel: 1, timestamp: 1 }); // wrong channel
    api.emitEvent({ type: "people", channel: 0, timestamp: 2 }); // not a trigger
    expect(goLive).not.toHaveBeenCalled();
    await ctrl.stop();
  });
});
