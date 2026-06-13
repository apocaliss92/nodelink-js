// test/lib/continuous-video-stream.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ContinuousVideoStream } from "../../src/baichuan/stream/ContinuousVideoStream";

class FakeLiveStream extends EventEmitter {
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
}

describe("ContinuousVideoStream live passthrough", () => {
  it("forwards videoAccessUnit while live and caches the last keyframe", async () => {
    const fake = new FakeLiveStream();
    const cvs = new ContinuousVideoStream({
      idleFps: 1,
      placeholder: { enabled: false },
      createLiveStream: async () => fake as any,
    });
    const seen: Buffer[] = [];
    cvs.on("videoAccessUnit", (au) => seen.push(au.data));

    await cvs.goLive();
    expect(fake.start).toHaveBeenCalledOnce();

    const kf = { data: Buffer.from([0, 0, 0, 1, 0x65, 1, 2]), isKeyframe: true, videoType: "H264" as const, microseconds: 1000 };
    fake.emit("videoAccessUnit", kf);
    expect(seen).toHaveLength(1);
    expect(cvs.hasCachedKeyframe()).toBe(true);

    await cvs.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
  });
});

describe("ContinuousVideoStream goLive race", () => {
  it("creates only one live stream when goLive() is called concurrently", async () => {
    const fake = new FakeLiveStream();
    const createLiveStream = vi.fn(async () => {
      // Simulate async work so both goLive() calls overlap across the await.
      await new Promise((r) => setTimeout(r, 10));
      return fake as any;
    });
    const cvs = new ContinuousVideoStream({
      idleFps: 1,
      placeholder: { enabled: false },
      createLiveStream,
    });

    await Promise.all([cvs.goLive(), cvs.goLive()]);
    expect(createLiveStream).toHaveBeenCalledOnce();

    await cvs.stop();
  });
});

describe("ContinuousVideoStream idle placeholder", () => {
  it("emits the cached keyframe at idleFps while idle, with advancing microseconds", async () => {
    vi.useFakeTimers();
    const fake = new FakeLiveStream();
    const cvs = new ContinuousVideoStream({
      idleFps: 2, // every 500ms
      placeholder: { enabled: false }, // raw → emits cached keyframe bytes
      createLiveStream: async () => fake as any,
    });
    const seen: { data: Buffer; microseconds: number; isKeyframe: boolean }[] = [];
    cvs.on("videoAccessUnit", (au) => seen.push({ data: au.data, microseconds: au.microseconds, isKeyframe: au.isKeyframe }));

    await cvs.goLive();
    const kf = { data: Buffer.from([0, 0, 0, 1, 0x65, 9]), isKeyframe: true, videoType: "H264" as const, microseconds: 1_000_000 };
    fake.emit("videoAccessUnit", kf);
    await cvs.goIdle();

    await vi.advanceTimersByTimeAsync(1100); // ~2 placeholder frames at 2fps
    const placeholders = seen.slice(1); // first was the live keyframe
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
    expect(placeholders.every((p) => p.isKeyframe)).toBe(true);
    expect(placeholders.every((p) => p.data.equals(kf.data))).toBe(true);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].microseconds).toBeGreaterThan(seen[i - 1].microseconds);
    }
    await cvs.stop();
    vi.useRealTimers();
  });
});
