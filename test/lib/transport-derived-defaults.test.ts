import { describe, expect, it } from "vitest";
import { resolveTransportDerivedDefaults } from "../../src/reolink/baichuan/utils/transportDefaults";

/**
 * Battery cameras run BCUDP. Two behaviours are gated on that: the periodic
 * event-subscription renewal and the silence watchdog's resubscribe. Both wake
 * a sleeping camera, so both must be off on UDP.
 *
 * The gate used to read the *constructor option*. A camera configured as
 * "auto" that resolves to UDP at login therefore kept the TCP behaviour for
 * the whole life of that connection — renewing every 5 minutes and letting the
 * watchdog force full reconnects, each one a wake (issue #35).
 */
describe("resolveTransportDerivedDefaults", () => {
  it("disables both renewals once the transport resolves to udp", () => {
    const r = resolveTransportDerivedDefaults({ resolvedTransport: "udp" });
    expect(r.eventResubscribeEnabled).toBe(false);
    expect(r.eventWatchdogSilenceResubscribeEnabled).toBe(false);
  });

  it("keeps them enabled on tcp", () => {
    const r = resolveTransportDerivedDefaults({ resolvedTransport: "tcp" });
    expect(r.eventResubscribeEnabled).toBe(true);
    expect(r.eventWatchdogSilenceResubscribeEnabled).toBe(true);
  });

  it("treats a configured 'auto' that resolved to udp exactly like udp", () => {
    // The regression: configuredTransport is what the old code looked at.
    const r = resolveTransportDerivedDefaults({
      configuredTransport: "auto",
      resolvedTransport: "udp",
    });
    expect(r.eventResubscribeEnabled).toBe(false);
    expect(r.eventWatchdogSilenceResubscribeEnabled).toBe(false);
  });

  it("still honours an explicit override over the transport default", () => {
    const r = resolveTransportDerivedDefaults({
      resolvedTransport: "udp",
      explicitResubscribe: true,
      explicitWatchdogResubscribe: true,
    });
    expect(r.eventResubscribeEnabled).toBe(true);
    expect(r.eventWatchdogSilenceResubscribeEnabled).toBe(true);
  });

  it("honours an explicit false on tcp", () => {
    const r = resolveTransportDerivedDefaults({
      resolvedTransport: "tcp",
      explicitResubscribe: false,
      explicitWatchdogResubscribe: false,
    });
    expect(r.eventResubscribeEnabled).toBe(false);
    expect(r.eventWatchdogSilenceResubscribeEnabled).toBe(false);
  });

  it("falls back to the configured transport before the connection resolves one", () => {
    const r = resolveTransportDerivedDefaults({ configuredTransport: "udp" });
    expect(r.eventResubscribeEnabled).toBe(false);
  });

  it("defaults to the non-udp behaviour when nothing is known yet", () => {
    const r = resolveTransportDerivedDefaults({});
    expect(r.eventResubscribeEnabled).toBe(true);
    expect(r.eventWatchdogSilenceResubscribeEnabled).toBe(true);
  });
});
