/**
 * Decides how long redials are refused after the camera ends a BCUDP session
 * (D2C_DISC). Pure: no timers, no I/O, so the rules can be tested directly.
 *
 * Two very different situations produce a D2C_DISC:
 *  - the camera is going to SLEEP (battery camera). Redials during that
 *    window would wake it, so they are refused for a long time (120 s on a
 *    storm, 10 s otherwise);
 *  - the camera is AWAKE and its link is flapping (weak Wi-Fi). Refusing for
 *    120 s only creates a recording hole, and every redial re-triggers the
 *    storm, so the refusal is a short capped backoff (10 s, then 30 s).
 *
 * Sleep safety is the hard constraint: the short backoff is used ONLY when
 * the camera is positively known awake AND the dropped session was young.
 * Anything else (asleep, unknown, old session) keeps the sleep behaviour.
 */

export const D2C_DISC_AWAKE_FIRST_BACKOFF_MS = 10_000;
export const D2C_DISC_AWAKE_MAX_BACKOFF_MS = 30_000;
/** A session shorter than this when it is dropped counts as a flapping link. */
export const D2C_DISC_YOUNG_SESSION_MS = 60_000;
/** Awake drops further apart than this start the backoff ladder over. */
export const D2C_DISC_AWAKE_STREAK_RESET_MS = 120_000;

export type D2cDiscCooldownReason =
  | "d2c-disc-awake-backoff"
  | "d2c-disc-sleep"
  | "login-failures";

export type D2cDiscCamState = "awake" | "sleeping" | "unknown";

export interface D2cDiscAwakeDecisionInput {
  /** Sleep inference computed BEFORE this disconnect was recorded. */
  readonly camState: D2cDiscCamState;
  /** How long the dropped session had been up. */
  readonly sessionAgeMs: number;
}

/** True only when the camera is positively awake and the session was young. */
export function isAwakeFlap(input: D2cDiscAwakeDecisionInput): boolean {
  return (
    input.camState === "awake" &&
    input.sessionAgeMs < D2C_DISC_YOUNG_SESSION_MS
  );
}

/** Tracks consecutive awake drops and yields the capped backoff ladder. */
export class AwakeDiscBackoff {
  private streak = 0;
  private lastAtMs = 0;

  /** Records an awake drop at `nowMs`; returns its refusal duration. */
  next(nowMs: number): number {
    if (
      this.lastAtMs === 0 ||
      nowMs - this.lastAtMs > D2C_DISC_AWAKE_STREAK_RESET_MS
    ) {
      this.streak = 0;
    }
    this.streak += 1;
    this.lastAtMs = nowMs;
    return this.streak === 1
      ? D2C_DISC_AWAKE_FIRST_BACKOFF_MS
      : D2C_DISC_AWAKE_MAX_BACKOFF_MS;
  }
}

/** Human label for a refused redial, naming the real reason. */
export function describeCooldownReason(
  reason: D2cDiscCooldownReason,
): string {
  switch (reason) {
    case "d2c-disc-awake-backoff":
      return "cooldown after disconnect (camera awake, link unstable)";
    case "d2c-disc-sleep":
      return "D2C_DISC (camera sleeping)";
    case "login-failures":
      return "repeated login failures";
  }
}
