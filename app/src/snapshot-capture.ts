/**
 * Snapshot capture helper shared by the MQTT/HA integration.
 *
 * Battery cameras go back to sleep within seconds of pushing a motion
 * alert (native Baichuan or SMTP e-mail). If `getSnapshot` (cmd_id 109)
 * reaches the device after it has slept, the snapshot push never arrives
 * and the call times out (issue #36). Waking the camera first on the
 * existing Baichuan socket keeps it awake long enough to serve the frame
 * — the same approach the Scrypted plugin uses in its motion path.
 */

/** Minimal surface of the Baichuan API needed to capture a snapshot. */
export interface SnapshotApi {
  wakeUp(channel?: number): Promise<void>;
  getSnapshot(
    channel?: number,
    options?: { timeoutMs?: number },
  ): Promise<Buffer>;
}

export interface FetchSnapshotOptions {
  /** getSnapshot timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Invoked when the pre-snapshot wakeUp fails (non-fatal). */
  onWakeError?: (error: unknown) => void;
}

/**
 * Fetch a JPEG snapshot, first waking battery cameras so the cmd_id 109
 * push has time to arrive before the camera sleeps again.
 *
 * A failed wakeUp is swallowed (reported via `onWakeError`) — the
 * snapshot fetch is still attempted, since the camera may already be
 * awake from the triggering event. `getSnapshot` errors propagate to the
 * caller.
 */
export async function fetchSnapshotWithWake(
  api: SnapshotApi,
  channel: number,
  isBattery: boolean,
  options?: FetchSnapshotOptions,
): Promise<Buffer> {
  if (isBattery) {
    try {
      await api.wakeUp(channel);
    } catch (error) {
      options?.onWakeError?.(error);
    }
  }
  return await api.getSnapshot(channel, {
    timeoutMs: options?.timeoutMs ?? 5_000,
  });
}
