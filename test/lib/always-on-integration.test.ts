import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ContinuousVideoStream } from "../../src/baichuan/stream/ContinuousVideoStream";

const FIXTURES = path.join(__dirname, "..", "fixtures");

class FakeLiveStream extends EventEmitter { start = vi.fn(async () => {}); stop = vi.fn(async () => {}); }

describe("always-on integration (codec-agnostic, raw placeholder)", () => {
  for (const videoType of ["H264", "H265"] as const) {
    it(`repeats the ${videoType} keyframe while idle`, async () => {
      vi.useFakeTimers();
      const fake = new FakeLiveStream();
      const cvs = new ContinuousVideoStream({
        idleFps: 1, placeholder: { enabled: false },
        createLiveStream: async () => fake as any,
      });
      const out: Buffer[] = [];
      cvs.on("videoAccessUnit", (au) => out.push(au.data));
      await cvs.goLive();
      const kfData =
        videoType === "H265" && fs.existsSync(path.join(FIXTURES, "raw-keyframe-h265.bin"))
          ? fs.readFileSync(path.join(FIXTURES, "raw-keyframe-h265.bin"))
          : Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
      fake.emit("videoAccessUnit", { data: kfData, isKeyframe: true, videoType, microseconds: 5_000_000 });
      await cvs.goIdle();
      await vi.advanceTimersByTimeAsync(2_100);
      const idle = out.slice(1);
      expect(idle.length).toBeGreaterThanOrEqual(2);
      expect(idle.every((b) => b.equals(kfData))).toBe(true);
      await cvs.stop();
      vi.useRealTimers();
    });
  }
});
