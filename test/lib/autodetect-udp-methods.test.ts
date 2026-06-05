import { describe, it, expect } from "vitest";
import {
  ALL_UDP_DISCOVERY_METHODS,
  selectViableUdpMethods,
  type UdpDiscoveryMethod,
} from "../../src/reolink/autodetect";

// Regression coverage for the no-UID battery-cam fallback path.
// Before this fix, local-broadcast was included in the no-UID race but createBaichuanApi
// rejected it synchronously with "UID is required for UDP cameras (BCUDP) unless using
// local-direct discovery", spamming the logs and wasting one of the parallel race slots.
describe("selectViableUdpMethods", () => {
  it("returns only local-direct when no UID is available", () => {
    expect(selectViableUdpMethods(false)).toEqual(["local-direct"]);
  });

  it("returns all methods in declared order when a UID is available", () => {
    expect(selectViableUdpMethods(true)).toEqual([
      "local-direct",
      "local-broadcast",
      "remote",
      "relay",
      "map",
    ]);
  });

  it("never includes methods that require a UID when none is provided", () => {
    const result = selectViableUdpMethods(false);
    const uidRequired: UdpDiscoveryMethod[] = [
      "local-broadcast",
      "remote",
      "relay",
      "map",
    ];
    for (const m of uidRequired) {
      expect(result).not.toContain(m);
    }
  });

  it("does not mutate the input list", () => {
    const input: UdpDiscoveryMethod[] = ["local-direct", "remote"];
    const snapshot = [...input];
    selectViableUdpMethods(true, input);
    expect(input).toEqual(snapshot);
  });

  it("ALL_UDP_DISCOVERY_METHODS contains every known method exactly once", () => {
    expect(new Set(ALL_UDP_DISCOVERY_METHODS).size).toBe(
      ALL_UDP_DISCOVERY_METHODS.length,
    );
    expect(ALL_UDP_DISCOVERY_METHODS).toEqual([
      "local-direct",
      "local-broadcast",
      "remote",
      "relay",
      "map",
    ]);
  });
});
