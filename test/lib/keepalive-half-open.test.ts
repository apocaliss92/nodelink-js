/**
 * Regression (Bug #37): after a camera reboot the TCP control socket can go
 * half-open — the peer is gone but no FIN/RST is received, so the Node socket
 * is NOT `destroyed` and `isSocketConnected()` reports stale-true forever.
 * That stale-true short-circuits `ensureConnected()`, so the stream stays dead
 * for hours.
 *
 * Contract:
 *  - A successful keepalive PING clears the failure run.
 *  - After KEEPALIVE_MAX_PING_FAILURES consecutive unanswered TCP pings, the
 *    socket is destroyed (which fires 'close' → resets loggedIn/subscribed),
 *    converting the undetectable half-open state into a normal close that the
 *    reconnect machinery already handles.
 */

import { describe, it, expect, vi } from "vitest";
import { BaichuanClient } from "../../src/client/BaichuanClient.js";

type Internals = {
  transport: string;
  loggedIn: boolean;
  tcpSocket: { destroyed: boolean; destroy: () => void } | undefined;
  consecutiveKeepalivePingFailures: number;
  sendPing: () => Promise<void>;
  sendFrame: (...args: unknown[]) => Promise<unknown>;
};

function makeClient(): { client: BaichuanClient; internals: Internals } {
  const client = new BaichuanClient({
    host: "127.0.0.1",
    port: 65534,
    username: "u",
    password: "p",
  });
  return {
    client,
    internals: client as unknown as Internals,
  };
}

function attachFakeAliveSocket(internals: Internals): {
  destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn(function (this: { destroyed: boolean }) {
    this.destroyed = true;
  });
  internals.transport = "tcp";
  internals.loggedIn = true;
  internals.tcpSocket = { destroyed: false, destroy };
  internals.consecutiveKeepalivePingFailures = 0;
  return { destroy };
}

const MAX_FAILURES = (
  BaichuanClient as unknown as { KEEPALIVE_MAX_PING_FAILURES: number }
).KEEPALIVE_MAX_PING_FAILURES;

describe("BaichuanClient keepalive half-open detection", () => {
  it("destroys the socket after consecutive unanswered TCP pings", async () => {
    const { client, internals } = makeClient();
    const { destroy } = attachFakeAliveSocket(internals);

    // Simulate a half-open socket: the ping never gets a reply (timeout).
    internals.sendFrame = vi.fn().mockRejectedValue(new Error("ping timeout"));

    try {
      // First failures (below threshold) must NOT destroy the socket.
      for (let i = 1; i < MAX_FAILURES; i++) {
        await internals.sendPing();
        expect(destroy).not.toHaveBeenCalled();
        expect(internals.consecutiveKeepalivePingFailures).toBe(i);
      }

      // The threshold-th failure destroys the half-open socket.
      await internals.sendPing();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("clears the failure run when a ping succeeds", async () => {
    const { client, internals } = makeClient();
    const { destroy } = attachFakeAliveSocket(internals);

    // One failure, then a success → counter resets, socket survives.
    const sendFrame = vi
      .fn()
      .mockRejectedValueOnce(new Error("ping timeout"))
      .mockResolvedValueOnce({});
    internals.sendFrame = sendFrame;

    try {
      await internals.sendPing();
      expect(internals.consecutiveKeepalivePingFailures).toBe(1);

      await internals.sendPing();
      expect(internals.consecutiveKeepalivePingFailures).toBe(0);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      await client.close().catch(() => {});
    }
  });
});
