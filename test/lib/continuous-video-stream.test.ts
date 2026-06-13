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
