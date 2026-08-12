/**
 * A tiny time-bounded cache for values that are expensive to obtain because
 * they require talking to the camera.
 *
 * Every Baichuan read is a command on the wire, and on a battery camera a
 * command wakes it. So anything asked for repeatedly — stream options,
 * capabilities — needs to be answered from memory between refreshes rather
 * than re-read on every caller's whim.
 *
 * Two distinct reads are offered on purpose:
 *
 * - {@link get} — fresh value only; the caller should refresh when it misses.
 * - {@link getStale} — last known value regardless of age, for the case where
 *   the refresh came back empty. Cameras answer with nothing more often than
 *   one would like (NVR/hub quirks, a battery camera drifting back to sleep),
 *   and an empty answer must never erase a previously good one.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();

  /** @param ttlMs Freshness window. Values ≤ 0 mean "never serve as fresh". */
  constructor(private readonly ttlMs: number) {}

  /** The value for `key` if it is still within the ttl. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.ttlMs <= 0) return undefined;
    if (Date.now() - entry.at > this.ttlMs) return undefined;
    return entry.value;
  }

  /** The last known value for `key`, however old. */
  getStale(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, at: Date.now() });
  }

  /** Drop a single entry, leaving the rest untouched. */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drop everything — call when the underlying camera config has changed. */
  clear(): void {
    this.entries.clear();
  }
}
