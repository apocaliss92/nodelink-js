/**
 * Tests for the TCP fast-fail classifier — `isTcpFailureThatShouldFallbackToUdp`.
 *
 * Two things this exercises:
 *  1. Every flavor of "host is gone" L3/L4 error now triggers the UDP
 *     fallback path (ECONNREFUSED, EHOSTDOWN, EHOSTUNREACH, ENETUNREACH,
 *     ENETDOWN). Before, EHOSTDOWN / ENETDOWN would fall through and
 *     bubble as a TCP-only failure even though the speculative UDP race
 *     was running in parallel.
 *  2. The autodetect-internal `TCP login deadline exceeded` synthetic
 *     error correctly flips to fallback. Without this, the hard
 *     8s-default deadline that bounds the OS-level connect chain would
 *     get rethrown instead of letting the UDP race resolve.
 *
 * Negative case: authentication errors STILL bubble as TCP-only — no
 * point falling to UDP if creds are wrong (UDP will reject too).
 */

import { describe, expect, it } from "vitest";
import { isTcpFailureThatShouldFallbackToUdp } from "../../src/reolink/autodetect";

const errWith = (msg: string): Error => {
  const e = new Error(msg);
  return e;
};

describe("isTcpFailureThatShouldFallbackToUdp — fallback signals", () => {
  it.each([
    "connect ECONNREFUSED 192.168.1.100:9000",
    "connect ETIMEDOUT 10.0.0.5:9000",
    "connect EHOSTDOWN 192.168.50.59:9000",
    "connect EHOSTUNREACH 192.168.1.129:9000",
    "connect ENETUNREACH 10.42.0.1:9000",
    "connect ENETDOWN 10.42.0.1:9000",
    "socket hang up",
    "TCP connection timeout after 10000ms",
    "Baichuan socket closed before login completed",
    "timeout waiting for nonce after 5000ms",
    "expected encryption info in response",
    "read ECONNRESET",
    "write EPIPE",
    "TCP login deadline exceeded (8000ms) — host unreachable",
  ])(
    "treats %s as a TCP-transport failure (-> fall back to UDP)",
    (msg) => {
      expect(isTcpFailureThatShouldFallbackToUdp(errWith(msg))).toBe(true);
    },
  );
});

describe("isTcpFailureThatShouldFallbackToUdp — non-fallback signals", () => {
  it.each([
    "401 Unauthorized — wrong password",
    "Bad credentials for user 'admin'",
    "Permission denied: invalid user",
    "Login failed: bad signature",
    "Camera returned error code -4 (auth)",
    "modernLogin rejected (rsp=-2)",
  ])(
    "does NOT fall back to UDP on auth-style error %s",
    (msg) => {
      expect(isTcpFailureThatShouldFallbackToUdp(errWith(msg))).toBe(false);
    },
  );

  it("handles non-Error throwables without crashing", () => {
    expect(isTcpFailureThatShouldFallbackToUdp("plain string")).toBe(false);
    expect(isTcpFailureThatShouldFallbackToUdp(null)).toBe(false);
    expect(isTcpFailureThatShouldFallbackToUdp(undefined)).toBe(false);
    expect(isTcpFailureThatShouldFallbackToUdp(42)).toBe(false);
    expect(isTcpFailureThatShouldFallbackToUdp({ no: "message" })).toBe(false);
  });
});
