import { describe, expect, it, vi } from "vitest";
import { BcUdpStream, BCUDP_HOL_STALL_MS } from "../../src/bcudp/BcUdpStream";

type Internals = {
  clientId: number | null;
  connectedAtMs: number;
  handlePacket: (
    p: { kind: "data"; connectionId: number; packetId: number; payload: Buffer },
    host: string,
    port: number,
  ) => void;
  checkStalls: (now: number) => void;
};

const CID = 7;
const data = (packetId: number) => ({
  kind: "data" as const,
  connectionId: CID,
  packetId,
  payload: Buffer.from([packetId & 0xff]),
});

describe("BcUdpStream head-of-line blocking (planning#695)", () => {
  const make = () => {
    const s = new BcUdpStream({ mode: "direct", host: "127.0.0.1", port: 1 } as never);
    const warn = vi.fn();
    s.setLogger({ warn } as never);
    const i = s as unknown as Internals;
    i.clientId = CID;
    const delivered: number[] = [];
    s.on("data", (b: Buffer) => delivered.push(b[0]!));
    return { s, i, warn, delivered };
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it("withholds every later packet behind one missing packet, and reports how long", async () => {
    const { s, i, warn, delivered } = make();
    const t0 = Date.now();
    i.connectedAtMs = t0;
    for (const id of [0, 1, 2, 4, 5, 6, 7]) i.handlePacket(data(id), "127.0.0.1", 1);
    await tick();
    // 3 is lost: ids 4..7 (a whole frame burst) are withheld.
    expect(delivered).toEqual([0, 1, 2]);

    const diag = s.getSessionDiagnostics(t0 + BCUDP_HOL_STALL_MS + 100);
    expect(diag.holMissingPacketId).toBe(3);
    expect(diag.holBufferedPackets).toBe(4);
    expect(diag.holBlockedMs).toBeGreaterThanOrEqual(BCUDP_HOL_STALL_MS);

    i.checkStalls(t0 + BCUDP_HOL_STALL_MS + 100);
    i.checkStalls(t0 + BCUDP_HOL_STALL_MS + 600);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("head-of-line stall: packet 3 missing");
  });

  it("clears the stall when the retransmission arrives", async () => {
    const { s, i, delivered } = make();
    i.connectedAtMs = Date.now();
    for (const id of [0, 2, 3]) i.handlePacket(data(id), "127.0.0.1", 1);
    i.handlePacket(data(1), "127.0.0.1", 1);
    await tick();
    expect(delivered).toEqual([0, 1, 2, 3]);
    expect(s.getSessionDiagnostics().holBlockedMs).toBeUndefined();
    expect(s.getSessionDiagnostics().holBufferedPackets).toBe(0);
  });
});
