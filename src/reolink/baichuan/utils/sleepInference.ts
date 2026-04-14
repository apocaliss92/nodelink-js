/**
 * Pure helpers for the UDP sleep-state inference running inside
 * `ReolinkBaichuanApi.startUdpSleepInference()`.
 *
 * The inference polls `getSleepStatus()` every 2 s. That helper reads a rolling
 * 10 s tx/rx-history window and infers whether the battery camera is asleep or
 * awake. During stream teardown or idle-disconnect sequences, non-waking
 * keepalive / battery-info traffic drifts in and out of the window, which can
 * cause the inferred state to flap rapidly:
 *
 *     awake → sleeping → awake → sleeping → awake → ...
 *
 * Emitting every flap as a `sleeping`/`awake` event floods downstream consumers
 * (events-manager, MQTT, Home Assistant) with phantom state changes even
 * though the camera has not been touched. Hysteresis smooths this out: a new
 * state must be observed on N consecutive polls before it is committed and an
 * event is emitted. N=2 adds a 2 s detection latency (acceptable for battery
 * cameras) while eliminating single-poll noise entirely.
 */

import type { SleepState } from "../types";

export interface SleepInferencePending {
  state: SleepState;
  count: number;
}

export interface SleepInferenceInput {
  /** State returned by the current getSleepStatus() poll — must not be "unknown". */
  inferred: Exclude<SleepState, "unknown">;
  /** Previously committed state (undefined = first observation after inference start). */
  committed: SleepState | undefined;
  /** Pending candidate state and consecutive match count, if any. */
  pending: SleepInferencePending | undefined;
  /** Consecutive polls of the same inferred state required to commit. */
  hysteresisPolls: number;
}

export interface SleepInferenceDecision {
  /** The event to dispatch, or null if no event should fire this poll. */
  emit: "sleeping" | "awake" | null;
  /** New committed state to store (never "unknown"). */
  nextCommitted: SleepState;
  /** New pending candidate to store, or undefined to clear it. */
  nextPending: SleepInferencePending | undefined;
}

/**
 * Decide whether a new sleep-inference poll should emit an event, given the
 * previously committed state and any pending hysteresis candidate.
 *
 * Rules:
 *   1. First observation (committed === undefined): always adopt as committed.
 *      Emit "sleeping" but not "awake" — awake is the implicit default, so
 *      emitting on startup would be noisy.
 *   2. Inferred matches committed: stable, clear any pending candidate.
 *   3. Inferred differs from committed but matches the pending candidate:
 *      increment count. When count reaches hysteresisPolls, commit and emit.
 *   4. Inferred differs from committed AND from any pending candidate:
 *      restart the candidate at count=1 (does not emit).
 */
export function decideSleepInferenceTransition(
  input: SleepInferenceInput,
): SleepInferenceDecision {
  const { inferred, committed, pending, hysteresisPolls } = input;

  // Rule 1 — first observation
  if (committed === undefined) {
    return {
      emit: inferred === "sleeping" ? "sleeping" : null,
      nextCommitted: inferred,
      nextPending: undefined,
    };
  }

  // Rule 2 — stable
  if (inferred === committed) {
    return {
      emit: null,
      nextCommitted: committed,
      nextPending: undefined,
    };
  }

  // Rule 3/4 — transition candidate
  const effectivePolls = Math.max(1, hysteresisPolls);

  if (!pending || pending.state !== inferred) {
    // Rule 4 — start (or reset) the candidate
    if (effectivePolls <= 1) {
      // Threshold 1 degenerates into the legacy no-hysteresis behaviour:
      // commit on the first differing poll.
      return {
        emit: inferred === "sleeping" ? "sleeping" : "awake",
        nextCommitted: inferred,
        nextPending: undefined,
      };
    }
    return {
      emit: null,
      nextCommitted: committed,
      nextPending: { state: inferred, count: 1 },
    };
  }

  // Rule 3 — candidate matches, bump count
  const nextCount = pending.count + 1;
  if (nextCount < effectivePolls) {
    return {
      emit: null,
      nextCommitted: committed,
      nextPending: { state: inferred, count: nextCount },
    };
  }

  // Threshold reached — commit and emit
  return {
    emit: inferred === "sleeping" ? "sleeping" : "awake",
    nextCommitted: inferred,
    nextPending: undefined,
  };
}
