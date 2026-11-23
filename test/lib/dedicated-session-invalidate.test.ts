/**
 * Main and sub of one channel share one pooled socket (one tag). A session
 * that outlives its socket must not act on the socket that replaced it.
 */
import { describe, expect, it, vi } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

type PoolEntry = {
  client: unknown;
  refCount: number;
  createdAt: number;
  lastUsedAt: number;
  idleCloseTimer: ReturnType<typeof setTimeout> | undefined;
};

const makeClient = () => ({
  loggedIn: true,
  login: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
});

const makeEntry = (client: unknown, refCount: number): PoolEntry => ({
  client,
  refCount,
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  idleCloseTimer: undefined,
});

const setup = () => {
  const api = new ReolinkBaichuanApi({
    host: "127.0.0.1",
    username: "admin",
    password: "",
    transport: "udp",
  });
  const pool = (api as unknown as { socketPool: Map<string, PoolEntry> })
    .socketPool;
  return { api, pool };
};

const TAG = "streaming:ch0";

describe("createDedicatedSession — invalidate", () => {
  it("discards the pooled socket so the next session opens a new one", async () => {
    const { api, pool } = setup();
    const zombie = makeClient();
    pool.set(TAG, makeEntry(zombie, 1));

    const session = await api.createDedicatedSession("live:cam:ch0:main");
    expect(session.client).toBe(zombie);

    await session.invalidate("no media for 10000ms");

    expect(zombie.close).toHaveBeenCalledOnce();
    expect(pool.has(TAG)).toBe(false);
  });

  it("a holder of the discarded socket neither releases nor closes the socket that replaced it", async () => {
    const { api, pool } = setup();
    const zombie = makeClient();
    pool.set(TAG, makeEntry(zombie, 0));

    const main = await api.createDedicatedSession("live:cam:ch0:main");
    const sub = await api.createDedicatedSession("live:cam:ch0:sub");
    await main.invalidate("no media for 10000ms");

    // The other profile already reopened: a new socket lives under the tag.
    const fresh = makeClient();
    pool.set(TAG, makeEntry(fresh, 1));

    await sub.invalidate("stream closed");
    await sub.release();

    expect(fresh.close).not.toHaveBeenCalled();
    expect(pool.get(TAG)?.client).toBe(fresh);
    expect(pool.get(TAG)?.refCount).toBe(1);
  });
});
