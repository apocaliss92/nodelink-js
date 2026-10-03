import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  emitBaichuanWebhookEvent,
  _resetBaichuanWebhookBusForTests,
  type BaichuanWebhookEvent,
  type ReolinkSimpleEvent,
} from "../../src/index.js";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

function buildEvent(
  overrides: Partial<BaichuanWebhookEvent> &
    Pick<BaichuanWebhookEvent, "cameraId" | "event">,
): BaichuanWebhookEvent {
  return {
    receivedAtMs: Date.now(),
    raw: {
      kind: "event",
      event: overrides.event,
      ...(overrides.reason ? { reason: overrides.reason } : {}),
      data: {
        event: overrides.event,
        ...(overrides.reason ? { reason: String(overrides.reason) } : {}),
      },
    },
    ...overrides,
  };
}

function makeApi(opts: { cameraId?: string; channel?: number }) {
  return new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535,
    username: "u",
    password: "p",
    transport: "tcp",
    ...(opts.cameraId
      ? { baichuanWebhookCameraId: opts.cameraId }
      : {}),
    ...(opts.channel !== undefined
      ? { baichuanWebhookChannel: opts.channel }
      : {}),
  });
}

beforeEach(() => {
  _resetBaichuanWebhookBusForTests();
});

afterEach(() => {
  _resetBaichuanWebhookBusForTests();
});

describe("ReolinkBaichuanApi baichuan-webhook auto-bridge", () => {
  it("routes wake/pir into onSimpleEvent as motion + awake", async () => {
    const api = makeApi({ cameraId: "cam-a" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => {
      seen.push(ev);
    });

    emitBaichuanWebhookEvent(
      buildEvent({
        cameraId: "cam-a",
        event: "wake",
        reason: "pir",
        receivedAtMs: 100,
      }),
    );

    expect(seen).toEqual([
      { type: "motion", channel: 0, timestamp: 100, source: "baichuanWebhook" },
      { type: "awake", channel: 0, timestamp: 100, source: "baichuanWebhook" },
    ]);

    await api.close();
  });

  it("routes wake/doorbell as doorbell + awake on the configured channel", async () => {
    const api = makeApi({ cameraId: "cam-d", channel: 2 });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitBaichuanWebhookEvent(
      buildEvent({
        cameraId: "cam-d",
        event: "wake",
        reason: "doorbell",
        receivedAtMs: 200,
      }),
    );

    expect(seen).toEqual([
      {
        type: "doorbell",
        channel: 2,
        timestamp: 200,
        source: "baichuanWebhook",
      },
      { type: "awake", channel: 2, timestamp: 200, source: "baichuanWebhook" },
    ]);

    await api.close();
  });

  it("ignores events for other cameras", async () => {
    const api = makeApi({ cameraId: "cam-a" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitBaichuanWebhookEvent(
      buildEvent({ cameraId: "cam-b", event: "wake", reason: "pir" }),
    );
    expect(seen).toHaveLength(0);

    await api.close();
  });

  it("stops receiving after close()", async () => {
    const api = makeApi({ cameraId: "cam-a" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    await api.close();
    emitBaichuanWebhookEvent(
      buildEvent({ cameraId: "cam-a", event: "wake", reason: "pir" }),
    );
    expect(seen).toHaveLength(0);
  });

  it("is a no-op when baichuanWebhookCameraId is omitted", async () => {
    const api = makeApi({});
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitBaichuanWebhookEvent(
      buildEvent({ cameraId: "cam-a", event: "wake", reason: "pir" }),
    );
    expect(seen).toHaveLength(0);

    await api.close();
  });
});
