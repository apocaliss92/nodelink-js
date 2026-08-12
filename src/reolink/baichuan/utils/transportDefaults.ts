/**
 * Behaviours that must be gated on the transport a connection is *actually*
 * using, not on the one it was configured with.
 *
 * Battery cameras speak BCUDP. Two periodic behaviours wake them and are
 * therefore disabled on UDP: the event-subscription renewal, and the silence
 * watchdog's resubscribe (a sleeping camera is silent by definition, so the
 * watchdog would treat normal sleep as a fault and reconnect).
 *
 * The gate used to be computed once, in the constructor, from the caller's
 * configured transport. A camera configured `"auto"` that resolves to UDP at
 * login therefore ran the TCP behaviour for that whole connection — renewing
 * every 5 minutes and letting the watchdog force full reconnects, each of
 * which is a wake. Recomputing from the resolved transport closes that gap
 * (issue #35).
 */

export type ConfiguredTransport = "tcp" | "udp" | "auto" | string;

export interface TransportDerivedInput {
  /** What the caller asked for; may be "auto". */
  configuredTransport?: ConfiguredTransport | undefined;
  /** What the connection actually negotiated, once known. */
  resolvedTransport?: "tcp" | "udp" | string | undefined;
  /** Caller override; wins over the transport default when set. */
  explicitResubscribe?: boolean | undefined;
  /** Caller override; wins over the transport default when set. */
  explicitWatchdogResubscribe?: boolean | undefined;
}

export interface TransportDerivedDefaults {
  eventResubscribeEnabled: boolean;
  eventWatchdogSilenceResubscribeEnabled: boolean;
  /** The transport the decision was based on, for logging. */
  effectiveTransport: string | undefined;
}

export function resolveTransportDerivedDefaults(
  input: TransportDerivedInput,
): TransportDerivedDefaults {
  // Prefer what the connection negotiated; fall back to the configured value
  // while the connection has not resolved one yet.
  const effectiveTransport = input.resolvedTransport ?? input.configuredTransport;
  const isUdp = effectiveTransport === "udp";

  return {
    eventResubscribeEnabled:
      typeof input.explicitResubscribe === "boolean"
        ? input.explicitResubscribe
        : !isUdp,
    eventWatchdogSilenceResubscribeEnabled:
      typeof input.explicitWatchdogResubscribe === "boolean"
        ? input.explicitWatchdogResubscribe
        : !isUdp,
    effectiveTransport,
  };
}
