import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BaichuanClient } from "../../src/client/BaichuanClient";

/**
 * A client whose listeners were all stripped (the general-socket reconnect
 * does this to the discarded client) must survive a late socket reset: the
 * error path must not throw out of the socket's event handler.
 */
describe("BaichuanClient socket error with no listeners", () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("does not throw uncaught when a reset arrives after removeAllListeners()", async () => {
    let serverSock: net.Socket | undefined;
    const server = net.createServer((s) => {
      serverSock = s;
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;

    const client = new BaichuanClient({
      host: "127.0.0.1",
      port,
      username: "u",
      password: "p",
      transport: "tcp",
    });
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));
    expect(serverSock).toBeDefined();

    client.removeAllListeners();

    const uncaught: Error[] = [];
    const handler = (e: Error) => uncaught.push(e);
    process.on("uncaughtException", handler);
    try {
      serverSock!.resetAndDestroy(); // RST -> ECONNRESET on the client socket
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off("uncaughtException", handler);
    }
    expect(uncaught).toEqual([]);
  });
});
