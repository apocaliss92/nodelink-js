export const BCUDP_MAGIC_NEGO = 0x2a87cf3a;
export const BCUDP_MAGIC_ACK = 0x2a87cf20;
export const BCUDP_MAGIC_DATA = 0x2a87cf10;

export const BCUDP_DEFAULT_MTU = 1350;
export const BCUDP_DATA_HEADER_SIZE = 20;

// Local discovery ports used by Reolink.
//
// 2015 = "any" channel — non-UID discovery (C2D_S without UID). Responds
//        with `<D2C_C_R>` if a device is listening.
// 2018 = "uid" channel — UID-targeted discovery (C2D_C with UID). Same
//        framing, narrower target.
// 9999 = P2P scan channel. The Reolink desktop SDK probes this port in
//        addition to 2015/2018 because BATTERY cameras (Argus / B-series)
//        often don't listen on 2015/2018 — their always-on UDP listener
//        is bound to 9999 (the same port the P2P relay servers use,
//        deliberately, so the camera reuses one well-known socket for
//        both LAN probes and cloud-relay-initiated punches). Sending
//        our existing BCUDP-framed C2D_S packet here costs one extra
//        UDP datagram per discovery attempt and dramatically improves
//        local-direct discovery for battery cams — for AC cams it just
//        no-ops (no listener, packet dropped silently).
export const BCUDP_DISCOVERY_PORT_LOCAL_ANY = 2015;
export const BCUDP_DISCOVERY_PORT_LOCAL_UID = 2018;
export const BCUDP_DISCOVERY_PORT_P2P_SCAN = 9999;

