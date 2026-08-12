import { describe, expect, it, vi } from "vitest";
import { resolveProfileStreamMetadata } from "../../src/baichuan/stream/streamMetadataCache";

const META = {
  streams: [
    { profile: "main", frameRate: 15, width: 1920, height: 1080 },
    { profile: "sub", frameRate: 5, width: 640, height: 360 },
  ],
};

describe("resolveProfileStreamMetadata", () => {
  it("returns the cached value without touching the camera", async () => {
    const fetchMetadata = vi.fn();
    const r = await resolveProfileStreamMetadata(
      { frameRate: 5, width: 640, height: 360 },
      "sub",
      fetchMetadata,
    );
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(r.metadata.frameRate).toBe(5);
    expect(r.cacheable).toBe(false); // nothing new to store
  });

  it("fetches when there is no cache and marks the result cacheable", async () => {
    // The bug in #35: this result was assigned to a local variable and thrown
    // away, so every DESCRIBE re-issued a getEncXml to the camera. On a battery
    // camera each of those wakes it — once per client reconnect, forever.
    const fetchMetadata = vi.fn(async () => META);
    const r = await resolveProfileStreamMetadata(undefined, "sub", fetchMetadata);

    expect(fetchMetadata).toHaveBeenCalledOnce();
    expect(r.metadata).toEqual({ frameRate: 5, width: 640, height: 360 });
    expect(r.cacheable).toBe(true);
  });

  it("re-fetches when the cached entry has no frame rate", async () => {
    const fetchMetadata = vi.fn(async () => META);
    const r = await resolveProfileStreamMetadata(
      { frameRate: 0 },
      "main",
      fetchMetadata,
    );
    expect(fetchMetadata).toHaveBeenCalledOnce();
    expect(r.metadata.frameRate).toBe(15);
    expect(r.cacheable).toBe(true);
  });

  it("picks the requested profile, not simply the first stream", async () => {
    const r = await resolveProfileStreamMetadata(undefined, "main", async () => META);
    expect(r.metadata).toEqual({ frameRate: 15, width: 1920, height: 1080 });
  });

  it("defaults a missing frame rate to 25 rather than 0", async () => {
    const r = await resolveProfileStreamMetadata(undefined, "sub", async () => ({
      streams: [{ profile: "sub", width: 640, height: 360 }],
    }));
    expect(r.metadata.frameRate).toBe(25);
  });

  it("falls back to 25 fps when the camera call fails, and does NOT cache it", async () => {
    // Caching a failure would pin the stream to a wrong frame rate for the rest
    // of the server's life, so a sleeping camera must be retried later.
    const onWarn = vi.fn();
    const r = await resolveProfileStreamMetadata(
      undefined,
      "sub",
      async () => {
        throw new Error("camera asleep");
      },
      { onWarn },
    );
    expect(r.metadata.frameRate).toBe(25);
    expect(r.cacheable).toBe(false);
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("does not cache when the profile is absent from the response", async () => {
    const r = await resolveProfileStreamMetadata(undefined, "ext", async () => META);
    expect(r.cacheable).toBe(false);
    expect(r.metadata.frameRate).toBe(25);
  });

  it("only hits the camera once when the caller honours cacheable", async () => {
    // End-to-end shape of the fix: simulate repeated DESCRIBEs.
    const fetchMetadata = vi.fn(async () => META);
    let cache: { frameRate: number } | undefined;
    for (let describe = 0; describe < 5; describe++) {
      const r = await resolveProfileStreamMetadata(cache, "sub", fetchMetadata);
      if (r.cacheable) cache = r.metadata;
    }
    expect(fetchMetadata).toHaveBeenCalledOnce();
  });
});
