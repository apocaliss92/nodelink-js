/**
 * Regression tests for the UDP sleep-inference hysteresis helper.
 *
 * Background:
 *   ReolinkBaichuanApi.startUdpSleepInference polls every 2 s and calls
 *   getSleepStatus(), which reads a rolling 10 s tx/rx-history window.
 *   During stream teardown / idle-disconnect sequences, non-waking traffic
 *   drifts in and out of that window, producing a flap like:
 *
 *       poll:  awake  sleeping  awake  sleeping  awake  sleeping  ...
 *
 *   Pre-fix: every flip emitted an event (awake → sleeping → awake → …),
 *   flooding MQTT / Home Assistant with phantom state changes.
 *
 *   Fix: decideSleepInferenceTransition() applies hysteresis — a state must
 *   be observed on N consecutive polls before it is committed and an event
 *   fires. The helper is a pure function, trivially testable.
 */

import { describe, it, expect } from "vitest";
import {
  decideSleepInferenceTransition,
  type SleepInferencePending,
} from "../../src/reolink/baichuan/utils/sleepInference.js";

// ---------------------------------------------------------------------------
// Poll-sequence simulator: threads state through decideSleepInferenceTransition
// and returns the list of events emitted.
// ---------------------------------------------------------------------------

function simulate(
  sequence: Array<"sleeping" | "awake">,
  hysteresisPolls = 2,
): Array<"sleeping" | "awake"> {
  const emitted: Array<"sleeping" | "awake"> = [];
  let committed: "sleeping" | "awake" | undefined;
  let pending: SleepInferencePending | undefined;

  for (const inferred of sequence) {
    const decision = decideSleepInferenceTransition({
      inferred,
      committed,
      pending,
      hysteresisPolls,
    });
    if (decision.emit) emitted.push(decision.emit);
    committed = decision.nextCommitted as "sleeping" | "awake";
    pending = decision.nextPending;
  }

  return emitted;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decideSleepInferenceTransition — hysteresis", () => {
  describe("first observation (committed = undefined)", () => {
    it("emits sleeping on first poll when camera is sleeping", () => {
      const decision = decideSleepInferenceTransition({
        inferred: "sleeping",
        committed: undefined,
        pending: undefined,
        hysteresisPolls: 2,
      });
      expect(decision.emit).toBe("sleeping");
      expect(decision.nextCommitted).toBe("sleeping");
      expect(decision.nextPending).toBeUndefined();
    });

    it("does NOT emit awake on first poll (awake is the default, would be noisy)", () => {
      const decision = decideSleepInferenceTransition({
        inferred: "awake",
        committed: undefined,
        pending: undefined,
        hysteresisPolls: 2,
      });
      expect(decision.emit).toBeNull();
      expect(decision.nextCommitted).toBe("awake");
      expect(decision.nextPending).toBeUndefined();
    });
  });

  describe("stable state (inferred === committed)", () => {
    it("does not emit when inferred matches committed", () => {
      const decision = decideSleepInferenceTransition({
        inferred: "sleeping",
        committed: "sleeping",
        pending: undefined,
        hysteresisPolls: 2,
      });
      expect(decision.emit).toBeNull();
      expect(decision.nextCommitted).toBe("sleeping");
      expect(decision.nextPending).toBeUndefined();
    });

    it("clears any pending candidate when back to committed state", () => {
      // Had flapped toward "awake", now back to committed "sleeping"
      const decision = decideSleepInferenceTransition({
        inferred: "sleeping",
        committed: "sleeping",
        pending: { state: "awake", count: 1 },
        hysteresisPolls: 2,
      });
      expect(decision.emit).toBeNull();
      expect(decision.nextPending).toBeUndefined();
    });
  });

  describe("hysteresis — 2 consecutive polls required", () => {
    it("first differing poll starts candidate, does NOT emit", () => {
      const decision = decideSleepInferenceTransition({
        inferred: "awake",
        committed: "sleeping",
        pending: undefined,
        hysteresisPolls: 2,
      });
      expect(decision.emit).toBeNull();
      expect(decision.nextCommitted).toBe("sleeping"); // still sleeping
      expect(decision.nextPending).toEqual({ state: "awake", count: 1 });
    });

    it("second consecutive matching poll commits and emits", () => {
      const decision = decideSleepInferenceTransition({
        inferred: "awake",
        committed: "sleeping",
        pending: { state: "awake", count: 1 },
        hysteresisPolls: 2,
      });
      expect(decision.emit).toBe("awake");
      expect(decision.nextCommitted).toBe("awake");
      expect(decision.nextPending).toBeUndefined();
    });

    it("a different inferred state resets the pending candidate", () => {
      // Committed=sleeping, pending=awake@1, now inferred=awake again→ would commit
      // But inject a 'sleeping' poll between — candidate clears (back to committed)
      const decision = decideSleepInferenceTransition({
        inferred: "sleeping",
        committed: "sleeping",
        pending: { state: "awake", count: 1 },
        hysteresisPolls: 2,
      });
      expect(decision.emit).toBeNull();
      expect(decision.nextPending).toBeUndefined();
    });
  });

  describe("production flapping sequences", () => {
    it("suppresses a single-poll transient flap during stream teardown", () => {
      // The exact pattern seen in campanello logs after grace-period expiry:
      //   sleeping (real) → awake (1-poll noise) → sleeping (back) → awake (noise) → …
      // Expected: only the initial sleeping is emitted. All subsequent single-poll
      // flips toward awake die in pending before reaching hysteresis threshold.
      const flap: Array<"sleeping" | "awake"> = [
        "sleeping", // real transition — first observation
        "awake",    // 1-poll noise → pending=awake@1
        "sleeping", // back → clears pending
        "awake",    // noise → pending=awake@1
        "sleeping", // back → clears pending
        "awake",    // noise → pending=awake@1
        "sleeping", // back → clears pending
        "awake",    // noise → pending=awake@1
        "sleeping", // back → clears pending
      ];
      expect(simulate(flap, 2)).toEqual(["sleeping"]);
    });

    it("commits a state change that persists for 2+ polls", () => {
      //   sleeping (init) → awake × 2 (real wake) → sleeping × 2 (real sleep)
      const seq: Array<"sleeping" | "awake"> = [
        "sleeping",
        "awake", "awake",       // real wake after 2 polls
        "sleeping", "sleeping", // real sleep after 2 polls
      ];
      expect(simulate(seq, 2)).toEqual(["sleeping", "awake", "sleeping"]);
    });

    it("ignores all single-poll noise for a 3-poll hysteresis", () => {
      // With hysteresis=3, even a 2-poll awake burst is suppressed as noise.
      const seq: Array<"sleeping" | "awake"> = [
        "sleeping",
        "awake", "awake",           // only 2 polls — not enough, suppressed
        "sleeping",                  // back to committed
        "awake", "awake", "awake",   // 3 polls → real transition
      ];
      expect(simulate(seq, 3)).toEqual(["sleeping", "awake"]);
    });

    it("degenerates to legacy no-hysteresis behaviour when hysteresisPolls=1", () => {
      // Every flip emits — equivalent to the pre-fix code
      const seq: Array<"sleeping" | "awake"> = [
        "sleeping", "awake", "sleeping", "awake", "sleeping",
      ];
      expect(simulate(seq, 1)).toEqual([
        "sleeping", "awake", "sleeping", "awake", "sleeping",
      ]);
    });

    it("stress test: 50 alternating flaps with hysteresis=2 emit only the initial state", () => {
      const seq: Array<"sleeping" | "awake"> = [];
      for (let i = 0; i < 50; i++) {
        seq.push(i % 2 === 0 ? "sleeping" : "awake");
      }
      // First poll emits sleeping; the rest alternate every poll → each flip
      // toward awake restarts pending@1 before reaching the threshold.
      expect(simulate(seq, 2)).toEqual(["sleeping"]);
    });
  });

  describe("awake → sleeping with hysteresis", () => {
    it("requires 2 consecutive sleeping polls to emit sleeping when camera was awake", () => {
      // Initialised awake (no emit on first poll), then real sleep transition
      const seq: Array<"sleeping" | "awake"> = [
        "awake",                 // init, no emit
        "sleeping",              // 1-poll, pending
        "awake",                 // flap back → clears pending
        "sleeping", "sleeping",  // 2 polls → emit sleeping
      ];
      expect(simulate(seq, 2)).toEqual(["sleeping"]);
    });
  });
});
