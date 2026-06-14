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
