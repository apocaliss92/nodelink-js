/**
 * Tests for the TCP fallback inside `pingHost`.
 *
 * The probe exists because ICMP is unreliable in real-world deployments:
 * Scrypted plugins on macOS sandbox often can't spawn `ping`, many
 * routers / hotels drop ICMP echo, and battery cameras in deep sleep
 * sometimes don't answer ICMP either. The TCP RST probe gives us a
 * second, much more deployable signal — ANY response from the peer
 * (SYN-ACK, RST/ECONNREFUSED, even a slow accept) proves the host is up
 * at the IP layer. Only a real timeout / EHOSTUNREACH / ENETUNREACH means
 * "not reachable".
 *
 * We spin up a real `net.Server` to validate the SYN-ACK path, exploit
 * the deterministic ECONNREFUSED on an unused localhost port to validate
 * the RST path, and rely on TEST-NET-1 / IPv4-doc ranges for the
 * unreachable path (no live network needed).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { tcpReachabilityProbe } from "../../src/reolink/autodetect";

describe("tcpReachabilityProbe", () => {
  let listener: net.Server | undefined;
  let listenerPort = 0;

  beforeEach(async () => {
    // Bind to an OS-chosen port on localhost — used by the "accepts SYN"
    // case below.
    await new Promise<void>((resolve) => {
      listener = net.createServer((s) => s.end());
      listener.listen(0, "127.0.0.1", () => {
        const addr = listener!.address();
        if (addr && typeof addr === "object") listenerPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (listener) {
      await new Promise<void>((resolve) => {
        listener!.close(() => resolve());
      });
      listener = undefined;
    }
  });

  it("returns true when the peer accepts the connection", async () => {
    expect(await tcpReachabilityProbe("127.0.0.1", listenerPort, 1000)).toBe(true);
  });

  it("returns true on ECONNREFUSED (host responded with RST → still reachable)", async () => {
    // Port chosen to be reliably closed on localhost. If a CI runner ever
    // happens to have a service on this port, the test fails loudly — at
    // which point pick another. 1 is technically tcpmux which nobody runs.
    expect(await tcpReachabilityProbe("127.0.0.1", 1, 1000)).toBe(true);
  });

  it("returns false when the peer never answers (real timeout)", async () => {
    // 192.0.2.0/24 is RFC5737 TEST-NET-1 — guaranteed never routed on
    // the public internet, so we'll hit the timeout deterministically.
    // 500ms cap keeps the test snappy.
    const t0 = Date.now();
    const result = await tcpReachabilityProbe("192.0.2.1", 9000, 500);
    const elapsed = Date.now() - t0;
    expect(result).toBe(false);
    // Should be at most ~1.5x the timeout to catch regressions where
    // the probe doesn't cancel cleanly.
    expect(elapsed).toBeLessThan(1500);
  });

  it("does not throw on garbage hostnames (returns false)", async () => {
    // Triggers a DNS / EAI failure path inside socket.connect — should
    // bubble back as `false`, not an unhandled rejection.
    expect(
      await tcpReachabilityProbe("not.a.real.hostname.invalid", 9000, 500),
    ).toBe(false);
  });
});
