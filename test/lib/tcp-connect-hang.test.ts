/**
 * Regression: a TCP socket destroyed mid-handshake must reject connect/sendXml
 * instead of leaving tcpConnectPromise pending forever (doorbell stream hang).
 *
 * The close-during-connect specs pin the socket state they test instead of
 * relying on scheduler timing. On Linux a loopback handshake completes inside
 * the kernel (into the listener's backlog, even with `pauseOnConnect`), and
 * libuv delivers `connect` in the poll phase — BEFORE a `setImmediate`
 * callback. A spec that yields one `setImmediate` and then closes therefore
 * closes an ALREADY CONNECTED client on Linux (connect correctly resolved)
 * and an in-flight one on macOS. Each ordering is now its own spec.
 */

import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaichuanClient } from "../../src/client/BaichuanClient";

const clients: BaichuanClient[] = [];
const servers: net.Server[] = [];
const serverSockets: net.Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    clients.splice(0).map((c) => c.close({ reason: "test_cleanup" }).catch(() => {})),
  );
  // A `pauseOnConnect` server never reads, so it never sees the client's FIN
  // and `server.close()` would wait forever for its accepted sockets.
  for (const s of serverSockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

type ListeningServer = { port: number };

async function listenPaused(): Promise<ListeningServer> {
  const server = net.createServer({ pauseOnConnect: true }, (s) => {
    serverSockets.push(s);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { port: addr.port };
}

function makeClient(port: number): BaichuanClient {
  const client = new BaichuanClient({
    host: "127.0.0.1",
    port,
    username: "admin",
    password: "x",
    transport: "tcp",
  });
  clients.push(client);
  return client;
}

const CONNECT_ABORTED = /socket closed|connect aborted|ECONNRESET|TCP connection timeout/i;

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
    // A socket that never connects: the handshake is in flight for as long as
    // the spec wants, on every OS. Only `close()` can end it here — the
    // 10 s handshake bound would otherwise fire after the test timeout.
    const neverConnects = new net.Socket();
    vi.spyOn(net, "createConnection").mockReturnValue(neverConnects);
    const client = makeClient(9);

    const connectP = client.connect();
    expect(neverConnects.destroyed).toBe(false);
    const started = Date.now();
    await client.close({ reason: "test_mid_connect_close" });
    await expect(connectP).rejects.toThrow(CONNECT_ABORTED);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("close() after the kernel finished the handshake but before Node saw `connect` settles the waiter", async () => {
    // The state CI's Linux runner reaches: the SYN/ACK exchange is done in the
    // kernel (loopback, into the listener's backlog) while the socket is still
    // `connecting` in Node, because libuv has not polled yet. Node issues the
    // connect syscall from a nextTick queued by createConnection(); ours runs
    // after it, and close() is called synchronously before the event loop
    // can deliver `connect`.
    const { port } = await listenPaused();
    const client = makeClient(port);

    const connectP = client.connect();
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await client.close({ reason: "test_post_handshake_close" });
    await expect(connectP).rejects.toThrow(CONNECT_ABORTED);
  });

  it("close() after `connect` was delivered leaves a resolved connect and a closed socket", async () => {
    // The other legitimate ordering: connect already settled (resolved), so
    // there is no waiter left — close() must still finish promptly.
    const { port } = await listenPaused();
    const client = makeClient(port);

    await client.connect();
    expect(client.isSocketConnected()).toBe(true);
    const started = Date.now();
    await client.close({ reason: "test_post_connect_close" });
    expect(client.isSocketConnected()).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
