/**
 * Coverage for the `ReolinkBaichuanApi` email-push auto-bridge.
 *
 * Verifies the user-visible contract added in this change set:
 *
 *  - When the api is constructed with `emailPushCameraId`, any event
 *    emitted on the global bus whose `cameraId` matches lands on
 *    `api.onSimpleEvent` listeners as if it were native Baichuan push.
 *  - The bridge ignores events for other cameras.
 *  - `mapEmailPushInferredType` is applied (AI sub-types preserved,
 *    `motion` fanned out for non-motion / non-doorbell types).
 *  - The bridge survives across notional "socket transients" — the
 *    underlying TCP can come and go because dispatch is a pure JS
 *    fan-out, not a network operation. We simulate this by emitting
 *    multiple events with arbitrary ordering and asserting they all
 *    reach the listener.
 *  - When the api is closed, the bus subscription is released so the
 *    listener stops receiving further events.
 *  - When `emailPushCameraId` is omitted, the bridge is a no-op.
 *
 * No real network: we only invoke the constructor + `close()`. The
 * BaichuanClient socket pool is created but never connected because
 * we never call `api.login()` or any socket-touching method.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  emitEmailPushEvent,
  _resetEmailPushBusForTests,
  type EmailPushEvent,
  type ReolinkSimpleEvent,
} from "../../src/index.js";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";

function buildEvent(
  overrides: Partial<EmailPushEvent> & Pick<EmailPushEvent, "cameraId">,
): EmailPushEvent {
  return {
    recipient: `cam-${overrides.cameraId}@test.local`,
    inferredType: "motion",
    receivedAtMs: Date.now(),
    subject: "Motion detected",
    from: "cam@test.local",
    bodyExcerpt: "",
    ...overrides,
  };
}

function makeApi(opts: { cameraId?: string; channel?: number }) {
  return new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535, // bound to nothing; the constructor doesn't connect
    username: "u",
    password: "p",
    transport: "tcp",
    ...(opts.cameraId
      ? { emailPushCameraId: opts.cameraId }
      : {}),
    ...(opts.channel !== undefined ? { emailPushChannel: opts.channel } : {}),
  });
}

beforeEach(() => {
  _resetEmailPushBusForTests();
});

afterEach(() => {
  _resetEmailPushBusForTests();
});

describe("ReolinkBaichuanApi email-push auto-bridge", () => {
  it("routes a matching event into api.onSimpleEvent listeners", async () => {
    const api = makeApi({ cameraId: "cam-a" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => {
      seen.push(ev);
    });

    emitEmailPushEvent(
      buildEvent({ cameraId: "cam-a", inferredType: "motion", receivedAtMs: 100 }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "motion",
      channel: 0,
      timestamp: 100,
    });

    await api.close();
  });

  it("preserves AI sub-types and fans out a generic motion alongside", async () => {
    const api = makeApi({ cameraId: "cam-ai", channel: 2 });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitEmailPushEvent(
      buildEvent({
        cameraId: "cam-ai",
        inferredType: "people",
        receivedAtMs: 200,
      }),
    );

    // First the AI sub-type, then the generic motion fan-out.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: "people", channel: 2, timestamp: 200 });
    expect(seen[1]).toMatchObject({ type: "motion", channel: 2, timestamp: 200 });

    await api.close();
  });

  it("does not fan out generic motion for the `motion` type itself", async () => {
    const api = makeApi({ cameraId: "cam-m" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitEmailPushEvent(
      buildEvent({ cameraId: "cam-m", inferredType: "motion", receivedAtMs: 1 }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("motion");

    await api.close();
  });

  it("ignores events for other cameras", async () => {
    const api = makeApi({ cameraId: "cam-a" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitEmailPushEvent(buildEvent({ cameraId: "cam-other" }));

    expect(seen).toHaveLength(0);

    await api.close();
  });

  it("delivers many events in order over the bridge", async () => {
    // Stresses the fan-out path: a burst of motion alerts (e.g. a
    // battery cam in repeated trigger window) must each reach the
    // listener with no drops and the correct chronological order.
    const api = makeApi({ cameraId: "cam-burst" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    const N = 50;
    for (let i = 0; i < N; i++) {
      emitEmailPushEvent(
        buildEvent({
          cameraId: "cam-burst",
          inferredType: "motion",
          receivedAtMs: 1000 + i,
        }),
      );
    }

    expect(seen).toHaveLength(N);
    expect(seen.map((e) => e.timestamp)).toEqual(
      Array.from({ length: N }, (_v, i) => 1000 + i),
    );

    await api.close();
  });

  it("releases the bridge on close — no further events reach listeners", async () => {
    const api = makeApi({ cameraId: "cam-close" });
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitEmailPushEvent(buildEvent({ cameraId: "cam-close" }));
    expect(seen).toHaveLength(1);

    await api.close();

    emitEmailPushEvent(buildEvent({ cameraId: "cam-close" }));
    // Listener is still in the set, but the bus subscription should be
    // gone — nothing routes through dispatchSimpleEvent anymore.
    expect(seen).toHaveLength(1);
  });

  it("does NOT register a bridge when emailPushCameraId is omitted", async () => {
    const api = makeApi({});
    const seen: ReolinkSimpleEvent[] = [];
    api.simpleEventListeners.add((ev) => seen.push(ev));

    emitEmailPushEvent(buildEvent({ cameraId: "cam-any" }));
    expect(seen).toHaveLength(0);

    await api.close();
  });

  it("two apis with different cameraIds both receive only their own events", async () => {
    const apiA = makeApi({ cameraId: "cam-A" });
    const apiB = makeApi({ cameraId: "cam-B" });
    const seenA: ReolinkSimpleEvent[] = [];
    const seenB: ReolinkSimpleEvent[] = [];
    apiA.simpleEventListeners.add((ev) => seenA.push(ev));
    apiB.simpleEventListeners.add((ev) => seenB.push(ev));

    emitEmailPushEvent(buildEvent({ cameraId: "cam-A", receivedAtMs: 10 }));
    emitEmailPushEvent(buildEvent({ cameraId: "cam-B", receivedAtMs: 20 }));
    emitEmailPushEvent(buildEvent({ cameraId: "cam-A", receivedAtMs: 30 }));

    expect(seenA.map((e) => e.timestamp)).toEqual([10, 30]);
    expect(seenB.map((e) => e.timestamp)).toEqual([20]);

    await apiA.close();
    await apiB.close();
  });
});
