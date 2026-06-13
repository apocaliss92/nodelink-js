// test/lib/placeholder-renderer.test.ts
import { describe, it, expect } from "vitest";
import { PlaceholderRenderer } from "../../src/baichuan/stream/PlaceholderRenderer";

describe("PlaceholderRenderer raw mode", () => {
  it("returns the cached keyframe unchanged when decoration disabled", async () => {
    const renderer = new PlaceholderRenderer({ placeholder: { enabled: false } });
    const keyframe = Buffer.from([0, 0, 0, 1, 0x65, 0xde, 0xad]);
    const out = await renderer.render({ data: keyframe, videoType: "H264" });
    expect(out.equals(keyframe)).toBe(true);
  });

  it("returns null when there is no cached keyframe", async () => {
    const renderer = new PlaceholderRenderer({ placeholder: { enabled: false } });
    const out = await renderer.render(null);
    expect(out).toBeNull();
  });
});
