import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { subscribeVideoStreamAsSource } from "../../src/baichuan/stream/videoStreamSource";

describe("subscribeVideoStreamAsSource", () => {
  it("yields video+audio frames and stops on close, cleaning up listeners", async () => {
    const stream = new EventEmitter();
    const ac = new AbortController();
    const frames: { audio: boolean; data: Buffer; isKeyframe?: boolean }[] = [];

    const gen = subscribeVideoStreamAsSource(stream as any, ac.signal);
    const pump = (async () => {
      for await (const f of gen) frames.push({ audio: f.audio, data: f.data, isKeyframe: f.isKeyframe });
    })();

    // give the generator a tick to attach listeners
    await new Promise((r) => setTimeout(r, 0));
    expect(stream.listenerCount("videoAccessUnit")).toBe(1);

    stream.emit("videoAccessUnit", { data: Buffer.from([1]), isKeyframe: true, videoType: "H264", microseconds: 100 });
    stream.emit("audioFrame", Buffer.from([2]));
    stream.emit("videoAccessUnit", { data: Buffer.from([3]), isKeyframe: false, videoType: "H264", microseconds: 200 });
    stream.emit("close");

    await pump;

    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ audio: false, isKeyframe: true });
    expect(frames[1].audio).toBe(true);
    expect(frames[2]).toMatchObject({ audio: false, isKeyframe: false });
    // listeners removed in finally
    expect(stream.listenerCount("videoAccessUnit")).toBe(0);
    expect(stream.listenerCount("audioFrame")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  });

  it("discards the backlog and resyncs on the next keyframe under backpressure", async () => {
    // Mirrors createNativeStream: when the queue overflows on an inter-frame
    // codec, dropping arbitrary frames would corrupt the GOP (H.265 won't
    // decode). Instead the backlog is discarded and delivery resumes from the
    // next keyframe.
    const stream = new EventEmitter();
    const ac = new AbortController();
    const gen = subscribeVideoStreamAsSource(stream as any, ac.signal, {
      maxQueue: 3,
    });

    // Start the generator so it attaches listeners and waits for frames.
    const firstPull = gen.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(stream.listenerCount("videoAccessUnit")).toBe(1);

    // Synchronous burst > maxQueue: keyframe + P-frames overflows the queue,
    // then a fresh keyframe must resync. (Emitted synchronously so nothing is
    // pulled mid-burst.)
    const v = (n: number, kf: boolean) =>
      stream.emit("videoAccessUnit", {
        data: Buffer.from([n]),
        isKeyframe: kf,
        videoType: "H265",
        microseconds: 0,
      });
    v(1, true); // original keyframe (will be discarded on overflow)
    v(10, false);
    v(11, false);
    v(12, false); // overflow here → backlog discarded, needs resync
    v(13, false); // dropped (waiting for keyframe)
    v(99, true); // resync keyframe
    v(100, false);

    const got: Array<{ data: number; isKeyframe?: boolean }> = [];
    const a = (await firstPull).value as { data: Buffer; isKeyframe?: boolean };
    got.push({ data: a.data[0]!, isKeyframe: a.isKeyframe });
    const b = (await gen.next()).value as { data: Buffer; isKeyframe?: boolean };
    got.push({ data: b.data[0]!, isKeyframe: b.isKeyframe });

    ac.abort();
    await gen.next();

    // Delivery resumes from the resync keyframe (99), not the corrupted backlog.
    expect(got).toEqual([
      { data: 99, isKeyframe: true },
      { data: 100, isKeyframe: false },
    ]);
    expect(stream.listenerCount("videoAccessUnit")).toBe(0);
  });

  it("stops and cleans up when the signal aborts", async () => {
    const stream = new EventEmitter();
    const ac = new AbortController();
    const gen = subscribeVideoStreamAsSource(stream as any, ac.signal);
    const pump = (async () => { for await (const _ of gen) { /* drain */ } })();
    await new Promise((r) => setTimeout(r, 0));
    expect(stream.listenerCount("videoAccessUnit")).toBe(1);
    ac.abort();
    await pump;
    expect(stream.listenerCount("videoAccessUnit")).toBe(0);
  });
});
