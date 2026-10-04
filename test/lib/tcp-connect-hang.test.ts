/**
 * Regression: a TCP socket destroyed mid-handshake must reject connect/sendXml
 * instead of leaving tcpConnectPromise pending forever (doorbell stream hang).
 */

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BaichuanClient } from "../../src/client/BaichuanClient";

const clients: BaichuanClient[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map((c) => c.close({ reason: "test_cleanup" }).catch(() => {})),
  );
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

describe("BaichuanClient TCP connect hang regression", () => {
  it("sendXml fails within its timeout when TCP never connects (TEST-NET blackhole)", async () => {
    // 192.0.2.0/24 is documentation/TEST-NET-1 — typically blackholed, no RST.
    const client = new BaichuanClient({
      host: "192.0.2.1",
      port: 9000,
      username: "admin",
      password: "x",
      transport: "tcp",
    });
    clients.push(client);

    const started = Date.now();
    await expect(
      client.sendXml({ cmdId: 1, timeoutMs: 800 }),
    ).rejects.toThrow(/connect timeout|TCP connection timeout|Baichuan timeout/i);
    const elapsed = Date.now() - started;
    // Must not hang past the request budget (was infinite before the fix).
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  it("close() during an in-flight connect settles the waiter", async () => {
    // Listening server that never accepts keeps the client in SYN_SENT /
    // handshake long enough for close() to destroy the socket mid-connect.
    const hanging = net.createServer({ pauseOnConnect: true });
    servers.push(hanging);
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const hAddr = hanging.address();
    if (!hAddr || typeof hAddr === "string") throw new Error("no port");

    const client = new BaichuanClient({
      host: "127.0.0.1",
      port: hAddr.port,
      username: "admin",
      password: "x",
      transport: "tcp",
    });
    clients.push(client);

    const connectP = client.connect();
    // Yield so doConnectTcp creates the socket, then tear it down.
    await new Promise((r) => setImmediate(r));
    await client.close({ reason: "test_mid_connect_close" });
    await expect(connectP).rejects.toThrow(
      /socket closed|connect aborted|ECONNRESET|TCP connection timeout/i,
    );
  });
});
