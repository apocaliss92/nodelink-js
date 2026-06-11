/**
 * Tests for the IPv4 "non-routable for P2P" classifier — the predicate that
 * `BcUdpStream.p2pUidLookup` uses to decide whether a `dns.lookup()` answer
 * for a Reolink P2P hostname is real or has been intercepted by a DNS
 * filter / `/etc/hosts` rewrite.
 *
 * The error path this enables is observable in the wild: users behind
 * Pi-hole / AdGuard / NextDNS that block *.reolink.com end up resolving
 * `p2p*.reolink.com` to 127.0.0.1 (or 0.0.0.0), then waste 30s of UDP
 * timeouts before our code reports `P2P UID lookup timeout (127.0.0.1:9999)`
 * — utterly opaque to a user who's never seen the codebase. Returning
 * `true` here lets us surface a clear, actionable error instead.
 *
 * We keep the classifier strict: a valid Reolink P2P relay address is on
 * the public internet (Reolink's AWS / Aliyun ranges). ANY loopback, any
 * unspecified `0.0.0.0`, any RFC1918, and any CGNAT (RFC6598) is treated
 * as a sinkhole. Multicast and reserved ranges aren't checked because
 * `dns.lookup` virtually never returns them.
 */

import { describe, it, expect } from "vitest";
import { isUnroutableForP2P } from "../../src/bcudp/BcUdpStream";

describe("isUnroutableForP2P — DNS sinkhole detection", () => {
  it("flags 127.0.0.1 (most common Pi-hole / hosts-file sinkhole)", () => {
    expect(isUnroutableForP2P("127.0.0.1")).toBe(true);
  });

  it("flags any 127.0.0.0/8 loopback address", () => {
    expect(isUnroutableForP2P("127.0.0.11")).toBe(true); // Docker embedded DNS
    expect(isUnroutableForP2P("127.255.255.255")).toBe(true);
    expect(isUnroutableForP2P("127.1.2.3")).toBe(true);
  });

  it("flags 0.0.0.0 (AdGuard / NextDNS unspecified sinkhole)", () => {
    expect(isUnroutableForP2P("0.0.0.0")).toBe(true);
  });

  it("flags RFC1918 private ranges (no legit Reolink relay lives there)", () => {
    expect(isUnroutableForP2P("10.0.0.1")).toBe(true);
    expect(isUnroutableForP2P("10.255.255.255")).toBe(true);
    expect(isUnroutableForP2P("192.168.1.1")).toBe(true);
    expect(isUnroutableForP2P("172.16.0.1")).toBe(true);
    expect(isUnroutableForP2P("172.31.255.255")).toBe(true);
  });

  it("does NOT flag IPs adjacent to RFC1918 boundaries", () => {
    // 172.15.x and 172.32.x are public — they look RFC1918 but aren't.
    expect(isUnroutableForP2P("172.15.0.1")).toBe(false);
    expect(isUnroutableForP2P("172.32.0.1")).toBe(false);
  });

  it("flags RFC6598 CGNAT (100.64.0.0/10)", () => {
    expect(isUnroutableForP2P("100.64.0.1")).toBe(true);
    expect(isUnroutableForP2P("100.127.255.254")).toBe(true);
  });

  it("does NOT flag 100.x outside the CGNAT range (still public)", () => {
    expect(isUnroutableForP2P("100.63.255.255")).toBe(false);
    expect(isUnroutableForP2P("100.128.0.1")).toBe(false);
  });

  it("does NOT flag real Reolink relay AWS IPs", () => {
    // Sample of actual responses observed at the time of writing — these
    // are AWS Frankfurt / Singapore ranges Reolink rents for p2p.reolink.com.
    // The exact addresses rotate; only that they're public/non-sinkhole
    // matters here.
    expect(isUnroutableForP2P("35.156.78.129")).toBe(false);
    expect(isUnroutableForP2P("3.124.124.128")).toBe(false);
    expect(isUnroutableForP2P("54.169.0.1")).toBe(false);
  });

  it("treats malformed / empty input as unroutable (fail-safe)", () => {
    expect(isUnroutableForP2P("")).toBe(true);
    // @ts-expect-error — runtime input from dns.lookup may surprise us.
    expect(isUnroutableForP2P(undefined)).toBe(true);
    // @ts-expect-error — runtime input from dns.lookup may surprise us.
    expect(isUnroutableForP2P(null)).toBe(true);
  });
});
