/**
 * A single-consumer async queue with a bounded backlog.
 *
 * Used to fan a shared native camera stream out to individual RTSP clients:
 * each client gets its own queue, so one slow consumer cannot stall the pump
 * that feeds everyone else.
 *
 * The trade-off is that a client which cannot keep up has to lose something.
 * The queue keeps the newest items and evicts the oldest — right for live
 * video, where stale frames are worthless — but that eviction is exactly the
 * kind of loss that shows up downstream as "dropped/choppy frames" while the
 * source itself is provably clean. It is therefore **reported**, never
 * silent: pass `onOverflow` to observe it, or read {@link droppedCount}.
 */

export interface BoundedQueueOverflow<T> {
  /** Items evicted from the head of the queue, oldest first. */
  dropped: readonly T[];
  /** Cumulative number of items this queue has evicted since construction. */
  totalDropped: number;
}

export class AsyncBoundedQueue<T> {
  private readonly maxItems: number;
  private readonly queue: T[] = [];
  private readonly onOverflow:
    | ((overflow: BoundedQueueOverflow<T>) => void)
    | undefined;
  private waiting:
    | {
        resolve: (r: IteratorResult<T>) => void;
      }
    | undefined;
  private closed = false;
  private dropped = 0;

  /**
   * @param maxItems Backlog cap. Values below 1 are clamped to 1.
   * @param onOverflow Called whenever items are evicted. Must not throw —
   *   if it does, the error is swallowed so an observer can never break the
   *   stream pump.
   */
  constructor(
    maxItems: number,
    onOverflow?: (overflow: BoundedQueueOverflow<T>) => void,
  ) {
    this.maxItems = Math.max(1, maxItems | 0);
    this.onOverflow = onOverflow;
  }

  /** Cumulative number of items evicted because the consumer fell behind. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Current backlog depth. */
  get depth(): number {
    return this.queue.length;
  }

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
      return;
    }
    this.queue.push(item);
    if (this.queue.length > this.maxItems) {
      const dropped = this.queue.splice(0, this.queue.length - this.maxItems);
      this.dropped += dropped.length;
      if (this.onOverflow) {
        try {
          this.onOverflow({ dropped, totalDropped: this.dropped });
        } catch {
          // An observer must never take down the pump.
        }
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.closed) return { value: undefined as never, done: true };
    const item = this.queue.shift();
    if (item !== undefined) return { value: item, done: false };
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.waiting = { resolve };
    });
  }
}
