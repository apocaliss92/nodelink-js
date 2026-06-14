/**
 * Tests for `fetchSnapshotWithWake` — the snapshot helper that wakes
 * battery cameras before fetching cmd_id 109 (issue #36).
 *
 * Regression guard: before the fix, battery cameras that pushed motion
 * via SMTP went straight back to sleep and the snapshot fetch timed out,
 * so HA never received a frame. The fix wakes the camera on its existing
 * Baichuan socket first — these tests pin that ordering and the
 * non-fatal handling of a wakeUp failure.
 */

import { describe, it, expect, vi } from "vitest";
import {
  fetchSnapshotWithWake,
  type SnapshotApi,
} from "../../app/src/snapshot-capture.js";

function makeApi(
  overrides?: Partial<SnapshotApi>,
): { api: SnapshotApi; calls: string[] } {
  const calls: string[] = [];
  const api: SnapshotApi = {
    wakeUp: vi.fn(async () => {
      calls.push("wakeUp");
    }),
    getSnapshot: vi.fn(async () => {
      calls.push("getSnapshot");
      return Buffer.from("ffd8ffe0", "hex");
    }),
    ...overrides,
  };
  return { api, calls };
}

describe("fetchSnapshotWithWake", () => {
  it("wakes a battery camera before fetching the snapshot", async () => {
    const { api, calls } = makeApi();
    const jpeg = await fetchSnapshotWithWake(api, 0, true);
    expect(calls).toEqual(["wakeUp", "getSnapshot"]);
    expect(api.wakeUp).toHaveBeenCalledWith(0);
    expect(jpeg.length).toBeGreaterThan(0);
  });

  it("does NOT wake a mains-powered camera", async () => {
    const { api, calls } = makeApi();
    await fetchSnapshotWithWake(api, 2, false);
    expect(calls).toEqual(["getSnapshot"]);
    expect(api.wakeUp).not.toHaveBeenCalled();
    expect(api.getSnapshot).toHaveBeenCalledWith(2, { timeoutMs: 5_000 });
  });

  it("still fetches the snapshot when wakeUp fails, reporting the error", async () => {
    const wakeErr = new Error("Baichuan timeout");
    const { api, calls } = makeApi({
      wakeUp: vi.fn(async () => {
        calls.push("wakeUp");
        throw wakeErr;
      }),
    });
    const onWakeError = vi.fn();
    const jpeg = await fetchSnapshotWithWake(api, 0, true, { onWakeError });
    expect(calls).toEqual(["wakeUp", "getSnapshot"]);
    expect(onWakeError).toHaveBeenCalledWith(wakeErr);
    expect(jpeg.length).toBeGreaterThan(0);
  });

  it("propagates a getSnapshot failure to the caller", async () => {
    const snapErr = new Error("Baichuan timeout");
    const { api } = makeApi({
      getSnapshot: vi.fn(async () => {
        throw snapErr;
      }),
    });
    await expect(fetchSnapshotWithWake(api, 0, true)).rejects.toThrow(
      "Baichuan timeout",
    );
  });

  it("honours a custom timeout", async () => {
    const { api } = makeApi();
    await fetchSnapshotWithWake(api, 1, false, { timeoutMs: 8_000 });
    expect(api.getSnapshot).toHaveBeenCalledWith(1, { timeoutMs: 8_000 });
  });
});
