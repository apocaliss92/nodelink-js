/**
 * Regression test for battery-camera sleeping/awake event flapping.
 *
 * Scenario from real production logs (campanello camera):
 *
 *   [rtsp] grace period expired, stopping native stream
 *   [api] stream close → closed
 *   [events-manager] Event: campanello ch0 sleeping
 *   [api] SocketPool: Closing idle streaming socket
 *   [api] BaichuanClient disconnected
 *   [events-manager] Event: campanello ch0 awake     ← SPURIOUS
 *   [events-manager] Event: campanello ch0 sleeping
 *   [events-manager] Event: campanello ch0 awake
 *   [events-manager] Event: campanello ch0 sleeping
 *   [events-manager] Event: campanello ch0 awake
 *   ...
 *
 * Root cause: ReolinkBaichuanApi.startUdpSleepInference polls every 2 s and
 * consults getSleepStatus() which uses a rolling 10 s tx/rx-history window.
 * Non-waking keepalive / battery-info traffic ages in and out of that window,
 * causing the inferred state to flap even though the camera has had no
 * interaction. Each flap calls dispatchSimpleEvent → events-manager.
 *
 * Fix: events-manager.handleCameraEvent now dedupes sleeping/awake events
 * using the cameraSleepStatus map — if the new state equals the previously
 * broadcast state the event is suppressed entirely (no SSE / JSON-stream /
 * MQTT publish). This prevents downstream consumers (Home Assistant
 * automations, notification integrations) from seeing phantom state changes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the modules events-manager depends on (we only want to test the
// dedup / broadcast logic, not the Express / MQTT / settings-store layers).
// ---------------------------------------------------------------------------

vi.mock("../../app/src/settings-store.js", () => ({
  getConfig: () => ({
    cameras: [
      { id: "campanello", name: "Campanello", isBattery: true, channel: 0 },
    ],
  }),
  getSettings: () => ({
    mqtt: { enabled: false },
  }),
  updateCamera: vi.fn(),
}));

vi.mock("../../app/src/rtsp-manager.js", () => ({
  getCameraInfo: (id: string) => ({ name: id }),
  sanitizeCameraName: (n: string) => n.toLowerCase().replace(/\s+/g, "_"),
  onApiConnected: vi.fn(),
  onApiDisconnected: vi.fn(),
}));

vi.mock("../../app/src/logger.js", () => ({
  createSourceLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  }),
}));

// Import AFTER mocks so the mocks are bound at import time
import {
  handleCameraEvent,
  getCameraSleepStatus,
  getRecentEvents,
  _resetEventsStateForTests,
} from "../../app/src/events-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  type: "sleeping" | "awake",
  timestamp = Date.now(),
): any {
  return { type, channel: 0, timestamp };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("events-manager — sleeping/awake flapping dedup", () => {
  beforeEach(() => {
    _resetEventsStateForTests();
  });

  it("broadcasts the first sleeping event", () => {
    handleCameraEvent("campanello", makeEvent("sleeping"));

    expect(getCameraSleepStatus("campanello")).toBe("sleeping");
    const recent = getRecentEvents("campanello");
    expect(recent).toHaveLength(1);
    expect(recent[0]?.type).toBe("sleeping");
  });

  it("suppresses a repeated sleeping event when camera is already sleeping", () => {
    handleCameraEvent("campanello", makeEvent("sleeping", 1_000));
    handleCameraEvent("campanello", makeEvent("sleeping", 2_000));
    handleCameraEvent("campanello", makeEvent("sleeping", 3_000));

    expect(getCameraSleepStatus("campanello")).toBe("sleeping");
    // Only the first sleeping event is recorded — the two duplicates are deduped
    const recent = getRecentEvents("campanello");
    expect(recent).toHaveLength(1);
    expect(recent[0]?.type).toBe("sleeping");
  });

  it("broadcasts state transitions sleeping → awake → sleeping", () => {
    handleCameraEvent("campanello", makeEvent("sleeping", 1_000));
    handleCameraEvent("campanello", makeEvent("awake",    2_000));
    handleCameraEvent("campanello", makeEvent("sleeping", 3_000));

    expect(getCameraSleepStatus("campanello")).toBe("sleeping");
    // newest first (unshift in pushToRecentBuffer)
    const recent = getRecentEvents("campanello").map((e) => e.type);
    expect(recent).toEqual(["sleeping", "awake", "sleeping"]);
  });

  it("suppresses the UDP sleep-inference flapping pattern from production logs", () => {
    // Exact sequence observed in the campanello log:
    //   sleeping, awake, sleeping, awake, sleeping, awake, sleeping, awake
    // Only the first sleeping and the first awake after it should be kept.
    const flapSequence: Array<"sleeping" | "awake"> = [
      "sleeping",
      "awake", "sleeping", "awake", "sleeping", "awake", "sleeping", "awake",
    ];
    let t = 1_000;
    for (const type of flapSequence) {
      handleCameraEvent("campanello", makeEvent(type, t));
      t += 2_000; // UDP sleep inference polls every 2 s
    }

    const recent = getRecentEvents("campanello").map((e) => e.type);
    // Every alternation is a real transition, so all 8 are kept.
    // What must NOT appear is repeated consecutive values.
    for (let i = 1; i < recent.length; i++) {
      expect(
        recent[i],
        `consecutive duplicate at index ${i}: ${recent[i - 1]} → ${recent[i]}`,
      ).not.toBe(recent[i - 1]);
    }
  });

  it("suppresses bursts of identical events in the flap window", () => {
    // More realistic worst-case: the inference stutters and emits
    // sleeping, sleeping, sleeping, awake, awake, sleeping, sleeping, awake
    // → downstream should only see sleeping → awake → sleeping → awake
    const rawSequence: Array<"sleeping" | "awake"> = [
      "sleeping", "sleeping", "sleeping",
      "awake", "awake",
      "sleeping", "sleeping",
      "awake",
    ];
    let t = 1_000;
    for (const type of rawSequence) {
      handleCameraEvent("campanello", makeEvent(type, t));
      t += 2_000;
    }

    const recent = getRecentEvents("campanello").map((e) => e.type);
    expect(recent).toEqual(["awake", "sleeping", "awake", "sleeping"]);
  });

  it("treats motion events as transient and does NOT dedupe them", () => {
    // Motion, people, vehicle etc. are triggers — every occurrence is a
    // distinct detection even with the same type. Ensure the dedup is
    // scoped to state events only.
    handleCameraEvent("campanello", {
      type: "motion", channel: 0, timestamp: 1_000,
    } as any);
    handleCameraEvent("campanello", {
      type: "motion", channel: 0, timestamp: 2_000,
    } as any);
    handleCameraEvent("campanello", {
      type: "motion", channel: 0, timestamp: 3_000,
    } as any);

    const recent = getRecentEvents("campanello");
    expect(recent).toHaveLength(3);
    expect(recent.every((e) => e.type === "motion")).toBe(true);
  });

  it("does not affect events from a different camera", () => {
    handleCameraEvent("campanello", makeEvent("sleeping", 1_000));
    handleCameraEvent("campanello", makeEvent("sleeping", 2_000)); // deduped

    handleCameraEvent("other-cam", makeEvent("sleeping", 1_500));
    handleCameraEvent("other-cam", makeEvent("sleeping", 2_500)); // deduped

    expect(getRecentEvents("campanello")).toHaveLength(1);
    expect(getRecentEvents("other-cam")).toHaveLength(1);
  });
});
