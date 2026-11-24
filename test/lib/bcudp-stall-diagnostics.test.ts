import { describe, expect, it, vi } from "vitest";
import {
  BcUdpStream,
  BCUDP_ACK_STALL_MS,
} from "../../src/bcudp/BcUdpStream";

type Internals = {
  connectedAtMs: number;
  sent: Map<number, { packetId: number; buf: Buffer; ts: number }>;
  lastAckRxPacketId: number | undefined;
  lastRxAtMs: number | undefined;
  checkStalls: (now: number) => void;
};

describe("BcUdpStream stall diagnostics", () => {
  const make = () => {
    const s = new BcUdpStream({ mode: "direct", host: "127.0.0.1", port: 1 } as never);
    const warn = vi.fn();
    s.setLogger({ warn } as never);
    return { s, i: s as unknown as Internals, warn };
  };

  it("logs the ack-window stall once, with the session age and last ack id", () => {
    const { i, warn } = make();
    const t0 = 1_000_000;
    i.connectedAtMs = t0 - 29 * 60_000;
    i.lastAckRxPacketId = 41;
    i.lastRxAtMs = t0;
    i.sent.set(42, { packetId: 42, buf: Buffer.alloc(1), ts: t0 - BCUDP_ACK_STALL_MS });
    i.checkStalls(t0);
    i.checkStalls(t0 + 500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("ack window stalled");
    expect(warn.mock.calls[0]![0]).toContain("lastAckRxPacketId=41");
    expect(warn.mock.calls[0]![0]).toContain(`sessionAgeMs=${29 * 60_000}`);
  });

  it("an idle silent session is not a stall; silence with requests outstanding is, and is reported", () => {
    const { s, i, warn } = make();
    const t0 = 2_000_000;
    i.connectedAtMs = t0 - 60_000;
    i.lastRxAtMs = t0 - 60_000;
    i.checkStalls(t0); // idle: nothing outstanding
    expect(warn).not.toHaveBeenCalled();
    i.sent.set(1, { packetId: 1, buf: Buffer.alloc(1), ts: t0 - 6_000 });
    i.checkStalls(t0);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "camera silent while requests are outstanding",
    );
    expect(s.getSessionDiagnostics(t0)).toMatchObject({
      sessionAgeMs: 60_000,
      lastRxAgoMs: 60_000,
      unackedPackets: 1,
      discFromCamera: false,
    });
  });
});
