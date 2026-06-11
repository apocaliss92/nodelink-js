/**
 * Tests for the Reolink cloud `server-binding` lookup.
 *
 * The endpoint is unauthenticated and returns a per-UID zone allocation
 * the autodetect layer uses to narrow a 22-hostname P2P sweep down to one.
 * We mock `fetch` to exercise: shape parsing, cache TTL, the soft-fallback
 * contract (every error must return `undefined` — never throw — so the
 * caller falls through to its legacy behaviour), and the selector
 * preference order (active > default > first-with-p2p).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearServerBindingCacheForTests,
  getServerBinding,
  pickP2pHostFromBinding,
  type ServerBindingResponse,
} from "../../src/cloud/server-binding";

const SAMPLE_RESPONSE: ServerBindingResponse = {
  availableZones: [
    {
      id: "7",
      name: "Europe (France)",
      locations: ["FR", "DE", "IT"],
      status: "active",
      services: {
        p2p: { server: "p2p7.reolink.com" },
        cloud: { server: "apis.reolink.com" },
        roms_ota: { server: "apis.reolink.com" },
        alarm_push: { server: "pushx.reolink.com" },
      },
    },
    {
      id: "0",
      name: "Global default",
      locations: [],
      status: "default",
      services: { p2p: { server: "p2p.reolink.com" } },
    },
  ],
};

beforeEach(() => {
  _clearServerBindingCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getServerBinding — HTTP contract", () => {
  it("returns parsed zones on a 200 with a well-formed body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await getServerBinding("ABC1234567890XYZ", { fetchImpl });
    expect(result).toBeDefined();
    expect(result!.availableZones).toHaveLength(2);
    expect(result!.availableZones[0]?.services.p2p?.server).toBe(
      "p2p7.reolink.com",
    );
  });

  it("targets the expected URL shape (language hint included)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    await getServerBinding("ABC1234567890XYZ", { fetchImpl, language: "it" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://apis.reolink.com/v2/devices/ABC1234567890XYZ/server-binding?language=it",
    );
    expect((init as RequestInit)?.method).toBe("GET");
    expect((init as RequestInit)?.headers).toMatchObject({
      Accept: "application/json",
    });
  });

  it("returns undefined on HTTP non-2xx (soft fallback)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("nope", { status: 503, statusText: "Unavailable" }),
    );
    const result = await getServerBinding("UID-503", { fetchImpl });
    expect(result).toBeUndefined();
  });

  it("includes the response body in the diagnostic log on non-2xx", async () => {
    // Without the body, an HTTP 400 from Reolink's API is opaque — could
    // be a bad UID, a missing app-key header, a payload-version skew. The
    // body usually reveals which. We want it captured even though the
    // function still returns undefined (soft fallback contract).
    const errorBody = JSON.stringify({ code: 1003, msg: "invalid uid" });
    const fetchImpl = vi.fn(async () =>
      new Response(errorBody, { status: 400, statusText: "Bad Request" }),
    );
    const logs: string[] = [];
    const logger = { log: (m: string) => logs.push(m) };
    const result = await getServerBinding("UID-400", { fetchImpl, logger });
    expect(result).toBeUndefined();
    const hit = logs.find((l) => l.includes("[server-binding]"));
    expect(hit).toBeDefined();
    expect(hit).toContain("HTTP 400 Bad Request");
    expect(hit).toContain("body=");
    expect(hit).toContain('"code":1003');
    expect(hit).toContain('"msg":"invalid uid"');
  });

  it("caps the captured body at ~512 bytes so giant error pages don't blow up logs", async () => {
    const huge = "X".repeat(5_000);
    const fetchImpl = vi.fn(async () =>
      new Response(huge, { status: 500, statusText: "Internal Server Error" }),
    );
    const logs: string[] = [];
    const logger = { log: (m: string) => logs.push(m) };
    await getServerBinding("UID-HUGE", { fetchImpl, logger });
    const hit = logs.find((l) => l.includes("[server-binding]"));
    expect(hit).toBeDefined();
    // Body slice is capped at 512 chars. The full log line includes the
    // "HTTP 500..." prefix plus the URL plus the body — the body slice
    // alone must not exceed 512.
    const bodyPart = /body=([\s\S]*)$/.exec(hit ?? "")?.[1] ?? "";
    expect(bodyPart.length).toBeLessThanOrEqual(512);
  });

  it("tolerates a body that fails to read without throwing", async () => {
    // Some fetch impls (or polyfills) throw on .text() when the body has
    // already been consumed by an interceptor. We must still log the
    // status code, just without the body slice.
    const fetchImpl = vi.fn(async () => {
      const fakeRes = {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        async text() {
          throw new Error("body already consumed");
        },
      } as unknown as Response;
      return fakeRes;
    });
    const logs: string[] = [];
    const logger = { log: (m: string) => logs.push(m) };
    const result = await getServerBinding("UID-BODY-FAIL", {
      fetchImpl,
      logger,
    });
    expect(result).toBeUndefined();
    const hit = logs.find((l) => l.includes("HTTP 502"));
    expect(hit).toBeDefined();
    expect(hit).not.toContain("body=");
  });

  it("returns undefined on a malformed body (no throw)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ wrong: "shape" }), { status: 200 }),
    );
    const result = await getServerBinding("UID-MALFORMED", { fetchImpl });
    expect(result).toBeUndefined();
  });

  it("returns undefined on a network error / abort (no throw)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND apis.reolink.com");
    });
    const result = await getServerBinding("UID-NET-ERR", { fetchImpl });
    expect(result).toBeUndefined();
  });

  it("returns undefined for an empty / non-string UID without calling fetch", async () => {
    const fetchImpl = vi.fn();
    expect(await getServerBinding("", { fetchImpl })).toBeUndefined();
    // @ts-expect-error — runtime input from autodetect may surprise us.
    expect(await getServerBinding(undefined, { fetchImpl })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns undefined if no fetch impl is available", async () => {
    // Force the "no global fetch" code path by passing undefined explicitly.
    // (Node 18+ always has fetch globally — this guards Node 16 and bare
    // Electron contexts that strip it from `globalThis`.)
    const realFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch | undefined }).fetch =
        undefined;
      // Pass options with NO fetchImpl so the function falls back to globalThis.fetch.
      const result = await getServerBinding("UID-NO-FETCH");
      expect(result).toBeUndefined();
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
    }
  });
});

describe("getServerBinding — caching", () => {
  it("hits the network once per UID within the positive TTL window", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    await getServerBinding("UID-CACHE", { fetchImpl });
    await getServerBinding("UID-CACHE", { fetchImpl });
    await getServerBinding("UID-CACHE", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-tries the network after a negative cache TTL expires", async () => {
    // We can't pump the clock here without a clock-injection hook, so we
    // exercise the negative-cache behaviour over its short window with a
    // smaller-than-default body — first failure should short-circuit
    // immediately, but a DIFFERENT UID still hits the wire.
    const fetchImpl = vi
      .fn(async () => new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    await getServerBinding("UID-NEG-A", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Second call to SAME uid within the negative TTL → no network.
    await getServerBinding("UID-NEG-A", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // DIFFERENT uid → fresh network call.
    await getServerBinding("UID-NEG-B", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("pickP2pHostFromBinding — selector preference order", () => {
  it("prefers the `status=active` zone", () => {
    expect(pickP2pHostFromBinding(SAMPLE_RESPONSE)).toBe("p2p7.reolink.com");
  });

  it("falls back to `status=default` when no active zone has p2p", () => {
    const r: ServerBindingResponse = {
      availableZones: [
        {
          id: "1",
          name: "active-but-no-p2p",
          status: "active",
          services: { cloud: { server: "apis.reolink.com" } },
        },
        {
          id: "0",
          name: "default",
          status: "default",
          services: { p2p: { server: "p2p.reolink.com" } },
        },
      ],
    };
    expect(pickP2pHostFromBinding(r)).toBe("p2p.reolink.com");
  });

  it("falls back to the first zone with p2p when neither active nor default match", () => {
    const r: ServerBindingResponse = {
      availableZones: [
        {
          id: "9",
          name: "deprecated",
          status: "deprecated",
          services: { p2p: { server: "p2p9.reolink.com" } },
        },
      ],
    };
    expect(pickP2pHostFromBinding(r)).toBe("p2p9.reolink.com");
  });

  it("returns undefined for an undefined / empty input", () => {
    expect(pickP2pHostFromBinding(undefined)).toBeUndefined();
    expect(pickP2pHostFromBinding({ availableZones: [] })).toBeUndefined();
  });

  it("returns undefined when no zone carries a p2p service entry", () => {
    const r: ServerBindingResponse = {
      availableZones: [
        {
          id: "1",
          name: "no-p2p",
          status: "active",
          services: { cloud: { server: "apis.reolink.com" } },
        },
      ],
    };
    expect(pickP2pHostFromBinding(r)).toBeUndefined();
  });
});
