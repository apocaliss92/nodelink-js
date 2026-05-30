/**
 * Smoke test for the public `createEmailPushServer` factory exported by
 * the library. Covers the lifecycle (start/stop/restart), the status
 * shape, and the bus emit/subscribe loop via the synthetic emit helper.
 *
 * No real SMTP traffic is exchanged — start/stop bind to an ephemeral
 * port so the test runs in any environment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:net";
import {
  createEmailPushServer,
  emitEmailPushEvent,
  getCameraEmailAddress,
  getRecentEmailPushEvents,
  onEmailPushEvent,
  _resetEmailPushBusForTests,
  type EmailPushEvent,
  type EmailPushServerConfig,
} from "../../src/emailPush";

async function pickPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.listen(0, () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.once("error", reject);
  });
}

function baseConfig(port: number): EmailPushServerConfig {
  return {
    port,
    bindHost: "127.0.0.1",
    domain: "test.local",
    requireAuth: false,
    authUsername: "",
    authPassword: "",
    tls: false,
    maxMessageBytes: 1024 * 1024,
  };
}

beforeEach(() => {
  _resetEmailPushBusForTests();
});

afterEach(() => {
  _resetEmailPushBusForTests();
});

describe("createEmailPushServer factory", () => {
  it("start binds the configured port and getStatus reflects it", async () => {
    const port = await pickPort();
    const srv = createEmailPushServer({
      config: baseConfig(port),
      cameraResolver: () => undefined,
    });
    expect(srv.getStatus().running).toBe(false);
    await srv.start();
    try {
      const s = srv.getStatus();
      expect(s.running).toBe(true);
      expect(s.port).toBe(port);
      expect(s.bindHost).toBe("127.0.0.1");
      expect(s.startedAtMs).toBeGreaterThan(0);
    } finally {
      await srv.stop();
    }
    expect(srv.getStatus().running).toBe(false);
  });

  it("restart preserves config and produces a running instance", async () => {
    const port = await pickPort();
    const srv = createEmailPushServer({
      config: baseConfig(port),
      cameraResolver: () => undefined,
    });
    await srv.start();
    try {
      await srv.restart();
      expect(srv.getStatus().running).toBe(true);
    } finally {
      await srv.stop();
    }
  });

  it("bus subscribers receive synthetic events and recent events ring fills", async () => {
    const received: EmailPushEvent[] = [];
    const off = onEmailPushEvent((e) => received.push(e));
    try {
      const evt: EmailPushEvent = {
        cameraId: "cam-x",
        recipient: "cam-cam-x@test.local",
        inferredType: "motion",
        receivedAtMs: 1,
        subject: "alarm",
        from: "x@test.local",
        bodyExcerpt: "body",
      };
      emitEmailPushEvent(evt);
      expect(received).toHaveLength(1);
      expect(received[0]?.subject).toBe("alarm");
      const ring = getRecentEmailPushEvents(10);
      expect(ring).toHaveLength(1);
      expect(ring[0]?.subject).toBe("alarm");
    } finally {
      off();
    }
  });

  it("getCameraEmailAddress builds the cam-<id>@<domain> recipient", () => {
    expect(getCameraEmailAddress("abcd", "test.local")).toBe(
      "cam-abcd@test.local",
    );
  });
});
