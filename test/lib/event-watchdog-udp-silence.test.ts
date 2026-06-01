/**
 * Regression: battery cameras on UDP transport were being woken up
 * every 5 minutes by the simpleEventWatchdog's silence-based
 * resubscribe path. Silence is the *normal* operating mode for
 * sleeping battery cams — re-running `ensureSimpleEventSubscribed`
 * drains the battery for no real benefit.
 *
 * Contract:
 *  - Constructor default: `eventWatchdogSilenceResubscribeEnabled` is
 *    `false` for transport=udp, `true` for tcp/auto/unset.
 *  - Explicit `enableEventWatchdogSilenceResubscribe` opt overrides.
 *  - The subscription-failed recovery path (Case 2) is NOT gated by
 *    this flag (verified indirectly via the field default semantics).
 */

import { describe, it, expect } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

function makeApi(opts: {
  transport?: "tcp" | "udp" | "auto";
  enableEventWatchdogSilenceResubscribe?: boolean;
}): ReolinkBaichuanApi {
  return new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65534,
    username: "u",
    password: "p",
    ...(opts.transport ? { transport: opts.transport, uid: "X" } : {}),
    ...(opts.enableEventWatchdogSilenceResubscribe !== undefined
      ? {
          enableEventWatchdogSilenceResubscribe:
            opts.enableEventWatchdogSilenceResubscribe,
        }
      : {}),
  });
}

function getFlag(api: ReolinkBaichuanApi): boolean {
  // Internal field, accessed by name for the test (TypeScript private
  // is a compile-time check only, runtime field is accessible).
  return (api as unknown as { eventWatchdogSilenceResubscribeEnabled: boolean })
    .eventWatchdogSilenceResubscribeEnabled;
}

describe("simpleEventWatchdog silence-based resubscribe gating", () => {
  it("defaults DISABLED on udp transport (battery cam)", async () => {
    const api = makeApi({ transport: "udp" });
    try {
      expect(getFlag(api)).toBe(false);
    } finally {
      await api.close();
    }
  });

  it("defaults ENABLED on tcp transport (wired cam)", async () => {
    const api = makeApi({ transport: "tcp" });
    try {
      expect(getFlag(api)).toBe(true);
    } finally {
      await api.close();
    }
  });

  it("defaults ENABLED when transport is omitted (auto)", async () => {
    const api = makeApi({});
    try {
      expect(getFlag(api)).toBe(true);
    } finally {
      await api.close();
    }
  });

  it("explicit override forces ENABLED on udp", async () => {
    const api = makeApi({
      transport: "udp",
      enableEventWatchdogSilenceResubscribe: true,
    });
    try {
      expect(getFlag(api)).toBe(true);
    } finally {
      await api.close();
    }
  });

  it("explicit override forces DISABLED on tcp", async () => {
    const api = makeApi({
      transport: "tcp",
      enableEventWatchdogSilenceResubscribe: false,
    });
    try {
      expect(getFlag(api)).toBe(false);
    } finally {
      await api.close();
    }
  });
});
