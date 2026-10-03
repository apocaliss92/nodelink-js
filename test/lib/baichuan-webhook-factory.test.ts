import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  createBaichuanWebhookServer,
  emitBaichuanWebhookEvent,
  getRecentBaichuanWebhookEvents,
  onBaichuanWebhookEvent,
  _resetBaichuanWebhookBusForTests,
  type BaichuanWebhookEvent,
  type BaichuanWebhookServerConfig,
} from "../../src/baichuanWebhook/index.js";

function baseConfig(port: number): BaichuanWebhookServerConfig {
  return {
    port,
    bindHost: "127.0.0.1",
    pathPrefix: "/webhook",
  };
}

beforeEach(() => {
  _resetBaichuanWebhookBusForTests();
});

afterEach(() => {
  _resetBaichuanWebhookBusForTests();
});

describe("createBaichuanWebhookServer factory", () => {
  it("starts, accepts a wake POST, and emits on the bus", async () => {
    const srv = createBaichuanWebhookServer({
      config: baseConfig(0),
      cameraResolver: (id) => (id === "cam-a" ? "cam-a" : undefined),
    });
    await srv.start();
    const port = srv.getStatus().port;

    const received: BaichuanWebhookEvent[] = [];
    const off = onBaichuanWebhookEvent((e) => received.push(e));

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/webhook/cam-a",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ data: { event: "wake", reason: "pir" } }));
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      cameraId: "cam-a",
      event: "wake",
      reason: "pir",
    });
    expect(getRecentBaichuanWebhookEvents(5)).toHaveLength(1);
    expect(srv.getStatus().messagesAccepted).toBe(1);

    off();
    await srv.stop();
  });

  it("rejects unknown camera ids with 404", async () => {
    const srv = createBaichuanWebhookServer({
      config: baseConfig(0),
      cameraResolver: () => undefined,
    });
    await srv.start();
    const port = srv.getStatus().port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/webhook/unknown",
          method: "POST",
        },
        (res) => {
          expect(res.statusCode).toBe(404);
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end("{}");
    });

    expect(srv.getStatus().messagesRejected).toBeGreaterThan(0);
    await srv.stop();
  });

  it("bus emit works without a server", () => {
    const received: BaichuanWebhookEvent[] = [];
    const off = onBaichuanWebhookEvent((e) => received.push(e));
    emitBaichuanWebhookEvent({
      cameraId: "x",
      event: "sleep",
      receivedAtMs: 1,
      raw: { kind: "event", event: "sleep", data: { event: "sleep" } },
    });
    expect(received).toHaveLength(1);
    off();
  });
});
