/**
 * `login({ maxAttempts })`: a caller that only asks whether credentials work
 * (a connection test) sends the handshake once; the default keeps 3 attempts.
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
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
});

/** A host that accepts every connection and drops it before any reply. */
async function droppingHost(): Promise<{ port: number; connections: () => number }> {
  let count = 0;
  const server = net.createServer((socket) => {
    count += 1;
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { port: addr.port, connections: () => count };
}

function clientFor(port: number): BaichuanClient {
  const client = new BaichuanClient({
    host: "127.0.0.1",
    port,
    username: "admin",
    password: "wrong",
    transport: "tcp",
  });
  clients.push(client);
  return client;
}

describe("BaichuanClient.login maxAttempts", () => {
  it("tries the handshake once when maxAttempts is 1", async () => {
    const host = await droppingHost();
    await expect(clientFor(host.port).login("full_aes", { maxAttempts: 1 })).rejects.toThrow();
    expect(host.connections()).toBe(1);
  }, 20_000);

  it("keeps three attempts by default", async () => {
    const host = await droppingHost();
    await expect(clientFor(host.port).login()).rejects.toThrow();
    expect(host.connections()).toBe(3);
  }, 30_000);

  it("refuses a maxAttempts below 1", async () => {
    const host = await droppingHost();
    await expect(clientFor(host.port).login("full_aes", { maxAttempts: 0 })).rejects.toThrow(
      RangeError,
    );
    expect(host.connections()).toBe(0);
  });
});
