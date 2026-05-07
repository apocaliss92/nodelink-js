/**
 * Regression test for issue #18: battery camera enters a perpetual sleep/awake
 * cycle after the SECOND streaming session of a process lifetime.
 *
 * Cause: when the streaming socket of a battery camera is torn down (RTSP
 * grace timer fires → SocketPool idle-closes the streaming BaichuanClient),
 * `recomputeGlobalStreamingContribution()` decrements the global streaming
 * registry. But the GENERAL control-socket BaichuanClient last evaluated its
 * idle-disconnect timer while `isDeviceStreamingActive()` was still true, so
 * `kickIdleDisconnectTimer()` returned without scheduling a timer. Nobody
 * notified it that streaming ended, the general socket stayed connected, and
 * the 60 s session-guard interval kept sending getOnlineUserList() to the
 * sleeping camera — waking it every minute.
 *
 * Fix: BaichuanClient maintains a static `deviceClients` registry of every
 * live client per device key, and `recomputeGlobalStreamingContribution()`
 * walks it on streaming-end to kick every sibling's idle timer.
 *
 * This test verifies the registry → kick wiring without spinning up real
 * TCP sockets.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BaichuanClient } from "../../src/client/BaichuanClient.js";

const COMMON_OPTS = {
  host: "192.168.1.234",
  port: 9000,
  username: "admin",
  password: "secret",
  uid: "0000000000ARGUSPT",
  channel: 0,
} as const;

let createdClients: BaichuanClient[] = [];

function makeClient(): BaichuanClient {
  const c = new BaichuanClient({ ...COMMON_OPTS });
  createdClients.push(c);
  return c;
}

beforeEach(() => {
  createdClients = [];
});

afterEach(async () => {
  for (const c of createdClients) {
    try {
      await c.close({ skipLogout: true, reason: "test_cleanup" });
    } catch {
      /* ignore */
    }
  }
  createdClients = [];
});

describe("BaichuanClient sibling idle-timer kick (issue #18)", () => {
  it("kicks sibling clients' idle-disconnect timers when streaming ends device-wide", () => {
    const general = makeClient();
    const streaming = makeClient();

    // Spy BEFORE we trigger streaming so we can observe the eventual kick.
    const generalKick = vi.spyOn(
      general as unknown as { kickIdleDisconnectTimer: () => void },
      "kickIdleDisconnectTimer",
    );
    const selfKick = vi.spyOn(
      streaming as unknown as { kickIdleDisconnectTimer: () => void },
      "kickIdleDisconnectTimer",
    );

    // Subscribe → registry++ for this device key. Sibling kick should NOT
    // fire on subscribe — only on the decrement-to-zero path.
    streaming.subscribeVideoStream(3, 1);
    expect(generalKick).not.toHaveBeenCalled();

    // Unsubscribe → registry-- → reaches zero → sibling general client must
    // be kicked so it can re-evaluate idle-disconnect eligibility.
    streaming.unsubscribeVideoStream(3, 1);
    expect(generalKick).toHaveBeenCalledTimes(1);
    // The streaming client also kicks its own timer (existing behaviour) but
    // not via the sibling-walk — that's a direct call from
    // unsubscribeVideoStream.
    expect(selfKick).toHaveBeenCalled();
  });

  it("does not kick siblings when another client is still streaming the same device", () => {
    const general = makeClient();
    const streamingA = makeClient();
    const streamingB = makeClient();

    const generalKick = vi.spyOn(
      general as unknown as { kickIdleDisconnectTimer: () => void },
      "kickIdleDisconnectTimer",
    );

    streamingA.subscribeVideoStream(3, 1);
    streamingB.subscribeVideoStream(3, 2);

    // First unsubscribe drops the registry from 2 → 1, NOT to zero — sibling
    // must NOT be notified yet.
    streamingA.unsubscribeVideoStream(3, 1);
    expect(generalKick).not.toHaveBeenCalled();

    // Second unsubscribe takes registry to zero — now general gets the kick.
    streamingB.unsubscribeVideoStream(3, 2);
    expect(generalKick).toHaveBeenCalledTimes(1);
  });

  it("does not kick clients of other devices", () => {
    const generalSameDevice = makeClient();
    const otherDevice = new BaichuanClient({
      ...COMMON_OPTS,
      uid: "0000000000DIFFERENT",
      host: "192.168.1.99",
    });
    createdClients.push(otherDevice);
    const streaming = makeClient();

    const sameKick = vi.spyOn(
      generalSameDevice as unknown as { kickIdleDisconnectTimer: () => void },
      "kickIdleDisconnectTimer",
    );
    const otherKick = vi.spyOn(
      otherDevice as unknown as { kickIdleDisconnectTimer: () => void },
      "kickIdleDisconnectTimer",
    );

    streaming.subscribeVideoStream(3, 1);
    streaming.unsubscribeVideoStream(3, 1);

    expect(sameKick).toHaveBeenCalledTimes(1);
    expect(otherKick).not.toHaveBeenCalled();
  });
});
