import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../../src/reolink/baichuan/utils/ttlCache";
import {
  resolveProfileStreamMetadata,
  sharedStreamMetadataKey,
} from "../../src/baichuan/stream/streamMetadataCache";

const META = {
  streams: [
    { profile: "main", frameRate: 15, width: 1920, height: 1080 },
    { profile: "sub", frameRate: 5, width: 640, height: 360 },
  ],
};

describe("sharedStreamMetadataKey", () => {
  it("separates profiles of the same camera", () => {
    expect(sharedStreamMetadataKey("cam-1", 0, "main")).not.toBe(
      sharedStreamMetadataKey("cam-1", 0, "sub"),
    );
  });

  it("separates channels of the same device (NVR)", () => {
    expect(sharedStreamMetadataKey("nvr-1", 0, "main")).not.toBe(
      sharedStreamMetadataKey("nvr-1", 1, "main"),
    );
  });

  it("separates cameras", () => {
    expect(sharedStreamMetadataKey("cam-a", 0, "main")).not.toBe(
      sharedStreamMetadataKey("cam-b", 0, "main"),
    );
  });

  it("is stable for the same inputs, so a rebuilt server finds its entry", () => {
    expect(sharedStreamMetadataKey("cam-1", 0, "sub")).toBe(
      sharedStreamMetadataKey("cam-1", 0, "sub"),
    );
  });
});

describe("resolving through a cache that outlives the server instance", () => {
  /**
   * The per-instance cache is rebuilt cold whenever the RTSP server is, which
   * happens on every camera reconnect — so the camera was read again, and a
   * battery camera woken, on each rebuild (#35).
   */
  it("reads the camera once across repeated server rebuilds", async () => {
    const shared = new TtlCache<{ frameRate: number }>(60_000);
    const key = sharedStreamMetadataKey("cam-1", 0, "sub");
    const fetchMetadata = vi.fn(async () => META);

    for (let rebuild = 0; rebuild < 4; rebuild++) {
      // A fresh server instance has no per-instance metadata of its own.
      const perInstance = undefined;
      const r = await resolveProfileStreamMetadata(
        perInstance ?? shared.get(key),
        "sub",
        fetchMetadata,
      );
      if (r.cacheable) shared.set(key, r.metadata);
    }

    expect(fetchMetadata).toHaveBeenCalledOnce();
    expect(shared.get(key)?.frameRate).toBe(5);
  });

  it("still re-reads once the shared entry has expired", async () => {
    vi.useFakeTimers();
    try {
      const shared = new TtlCache<{ frameRate: number }>(1000);
      const key = sharedStreamMetadataKey("cam-1", 0, "sub");
      const fetchMetadata = vi.fn(async () => META);

      let r = await resolveProfileStreamMetadata(shared.get(key), "sub", fetchMetadata);
      if (r.cacheable) shared.set(key, r.metadata);
      vi.advanceTimersByTime(2000);
      r = await resolveProfileStreamMetadata(shared.get(key), "sub", fetchMetadata);
      if (r.cacheable) shared.set(key, r.metadata);

      expect(fetchMetadata).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poison the shared entry when the camera answers with nothing", async () => {
    const shared = new TtlCache<{ frameRate: number }>(60_000);
    const key = sharedStreamMetadataKey("cam-1", 0, "sub");

    let r = await resolveProfileStreamMetadata(shared.get(key), "sub", async () => META);
    if (r.cacheable) shared.set(key, r.metadata);
    expect(shared.get(key)?.frameRate).toBe(5);

    // A sleeping camera failing the read must not overwrite the good answer
    // with the 25 fps guess.
    r = await resolveProfileStreamMetadata(undefined, "sub", async () => {
      throw new Error("asleep");
    });
    if (r.cacheable) shared.set(key, r.metadata);

    expect(shared.get(key)?.frameRate).toBe(5);
  });
});
