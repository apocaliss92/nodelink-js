import { describe, expect, it, vi } from "vitest";
import {
  AsyncBoundedQueue,
  type BoundedQueueOverflow,
} from "../../src/baichuan/stream/asyncBoundedQueue";

describe("AsyncBoundedQueue", () => {
  it("hands an item straight to a waiting consumer without buffering", async () => {
    const q = new AsyncBoundedQueue<number>(2);
    const pending = q.next();
    q.push(7);
    await expect(pending).resolves.toEqual({ value: 7, done: false });
    expect(q.droppedCount).toBe(0);
  });

  it("keeps the newest items and evicts the oldest once full", async () => {
    const q = new AsyncBoundedQueue<number>(3);
    for (const n of [1, 2, 3, 4, 5]) q.push(n);

    expect((await q.next()).value).toBe(3);
    expect((await q.next()).value).toBe(4);
    expect((await q.next()).value).toBe(5);
  });

  it("reports evicted items instead of dropping them silently", async () => {
    // This is the whole point: a stalled RTSP client used to lose frames here
    // with no counter, no log and no callback, so downstream "dropped frames"
    // reports could never be traced back to this queue.
    const seen: Array<BoundedQueueOverflow<number>> = [];
    const q = new AsyncBoundedQueue<number>(2, (o) => seen.push(o));

    q.push(1);
    q.push(2);
    expect(seen).toHaveLength(0);

    q.push(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.dropped).toEqual([1]);
    expect(seen[0]!.totalDropped).toBe(1);

    q.push(4);
    expect(seen[1]!.dropped).toEqual([2]);
    expect(seen[1]!.totalDropped).toBe(2);
    expect(q.droppedCount).toBe(2);
  });

  it("reports every evicted item when several are shed at once", () => {
    const seen: Array<BoundedQueueOverflow<string>> = [];
    const q = new AsyncBoundedQueue<string>(1, (o) => seen.push(o));
    q.push("a");
    q.push("b");
    expect(seen[0]!.dropped).toEqual(["a"]);
  });

  it("never evicts while a consumer is keeping up", () => {
    const onOverflow = vi.fn();
    const q = new AsyncBoundedQueue<number>(1, onOverflow);
    q.push(1);
    void q.next();
    q.push(2);
    expect(onOverflow).not.toHaveBeenCalled();
  });

  it("survives an overflow callback that throws", () => {
    const q = new AsyncBoundedQueue<number>(1, () => {
      throw new Error("observer blew up");
    });
    q.push(1);
    expect(() => q.push(2)).not.toThrow();
    expect(q.droppedCount).toBe(1);
  });

  it("drops pushes and resolves pending consumers once closed", async () => {
    const onOverflow = vi.fn();
    const q = new AsyncBoundedQueue<number>(1, onOverflow);
    const pending = q.next();
    q.close();
    await expect(pending).resolves.toMatchObject({ done: true });

    q.push(1);
    expect(onOverflow).not.toHaveBeenCalled();
    await expect(q.next()).resolves.toMatchObject({ done: true });
  });

  it("treats a non-positive capacity as a capacity of one", () => {
    const q = new AsyncBoundedQueue<number>(0);
    q.push(1);
    q.push(2);
    expect(q.droppedCount).toBe(1);
  });
});
