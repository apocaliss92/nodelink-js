/**
 * A general session the camera abandoned silently keeps its transport "up":
 * every command times out and nothing is received. After N consecutive
 * timeouts with receive silence the session is recycled and logged in again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaichuanClient } from "../../src/client/BaichuanClient.js";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

type ClientInternals = {
  noteRequestTimeout: () => void;
  lastRxAtMs: number | undefined;
  sessionStartedAtMs: number | undefined;
  handleFrame: (f: unknown) => void;
};

const N = BaichuanClient.SESSION_STALL_TIMEOUTS;

describe("BaichuanClient sessionStalled", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const client = new BaichuanClient({
      host: "127.0.0.1",
      username: "u",
      password: "p",
    });
    const internals = client as unknown as ClientInternals;
    internals.sessionStartedAtMs = Date.now();
    const stalled = vi.fn();
    client.on("sessionStalled", stalled);
    return { internals, stalled };
  };

  it("fires after N consecutive timeouts with receive silence, once, with the session age", () => {
    const { internals, stalled } = make();
    internals.lastRxAtMs = Date.now();
    vi.advanceTimersByTime(30 * 60_000);
    for (let i = 0; i < N - 1; i++) internals.noteRequestTimeout();
    expect(stalled).not.toHaveBeenCalled();
    internals.noteRequestTimeout();
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0]![0]).toMatchObject({
      consecutiveTimeouts: N,
      sessionAgeMs: 30 * 60_000,
    });
    internals.noteRequestTimeout();
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it("does not fire while the camera is still sending frames", () => {
    const { internals, stalled } = make();
    for (let i = 0; i < N * 2; i++) {
      internals.lastRxAtMs = Date.now(); // traffic keeps arriving
      internals.noteRequestTimeout();
    }
    expect(stalled).not.toHaveBeenCalled();
  });
});

describe("ReolinkBaichuanApi general session recycling", () => {
  const setup = (transport: "udp" | "tcp" = "udp") => {
    const api = new ReolinkBaichuanApi({
      host: "127.0.0.1",
      username: "admin",
      password: "",
      transport,
    });
    const reconnect = vi.fn(async () => {});
    (api as unknown as { reconnectGeneralSocket: () => Promise<void> })
      .reconnectGeneralSocket = reconnect;
    const client = new BaichuanClient({
      host: "127.0.0.1",
      username: "u",
      password: "p",
    });
    (client as unknown as { transport: string }).transport = transport;
    (
      api as unknown as { socketPool: Map<string, unknown> }
    ).socketPool.set("general", { client, refCount: 1 });
    (
      api as unknown as { setupGeneralClientListeners: () => void }
    ).setupGeneralClientListeners();
    return { api, client, reconnect };
  };
  const info = {
    consecutiveTimeouts: N,
    sessionAgeMs: 1_800_000,
    lastRxAgoMs: 60_000,
    lastRxCmdId: 56,
    transport: "udp" as const,
  };
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("recycles when the consumer's guard asserts the camera is always on", async () => {
    const { api, client, reconnect } = setup();
    api.setGeneralSessionRecycling({ guard: () => true });
    client.emit("sessionStalled", info);
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
  });

  it("does not recycle when the consumer's guard refuses", async () => {
    const { api, client, reconnect } = setup();
    api.setGeneralSessionRecycling({ guard: () => false });
    client.emit("sessionStalled", info);
    await settle();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does NOT recycle when the sleep state is unknown on a BCUDP camera (a login would wake a battery camera)", async () => {
    const { client, reconnect } = setup("udp");
    client.emit("sessionStalled", info);
    await settle();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("recycles a BCUDP camera that is known to be awake, never one asleep", async () => {
    const { api, client, reconnect } = setup("udp");
    const states = (
      api as unknown as { udpLastInferredSleepStateByChannel: Map<number, string> }
    ).udpLastInferredSleepStateByChannel;
    states.set(0, "sleeping");
    client.emit("sessionStalled", info);
    await settle();
    expect(reconnect).not.toHaveBeenCalled();
    states.set(0, "awake");
    client.emit("sessionStalled", info);
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
  });

  it("recycles a wired TCP camera with no battery signal", async () => {
    const { client, reconnect } = setup("tcp");
    client.emit("sessionStalled", info);
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
  });

  it("bounds the loop: a minimum interval between recycles and a per-hour cap", async () => {
    const { api, client, reconnect } = setup("tcp");
    api.setGeneralSessionRecycling({ minIntervalMs: 60_000, maxPerHour: 2 });
    let now = 10_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      client.emit("sessionStalled", info);
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
      now += 30_000; // too soon
      client.emit("sessionStalled", info);
      await settle();
      expect(reconnect).toHaveBeenCalledTimes(1);
      now += 60_000;
      client.emit("sessionStalled", info);
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(2));
      now += 60_000; // interval ok, hourly cap (2) reached
      client.emit("sessionStalled", info);
      await settle();
      expect(reconnect).toHaveBeenCalledTimes(2);
      now += 3_600_000; // window slid
      client.emit("sessionStalled", info);
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(3));
    } finally {
      spy.mockRestore();
    }
  });
});
