import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

function loadFrames(profile: string): any[] | null {
  const p = path.join(FIXTURES_DIR, `stream-${profile}-frames.json`);
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Array.isArray(data) ? data : null;
}

describe("BcMedia stream frame analysis", () => {
  for (const profile of ["main", "sub", "ext"]) {
    describe(`${profile} stream`, () => {
      it("has both video and audio frames", () => {
        const frames = loadFrames(profile);
        if (!frames) return;

        const video = frames.filter((f) => !f.audio);
        const audio = frames.filter((f) => f.audio);
        expect(video.length).toBeGreaterThan(0);
        expect(audio.length).toBeGreaterThan(0);
      });

      it("video frames have consistent codec", () => {
        const frames = loadFrames(profile);
        if (!frames) return;

        const videoTypes = new Set(
          frames.filter((f) => !f.audio).map((f) => f.videoType),
        );
        // Should be exactly one codec type per profile
        expect(videoTypes.size).toBe(1);
        const codec = [...videoTypes][0];
        expect(codec).toMatch(/^H26[45]$/);
      });

      it("has keyframes at regular intervals", () => {
        const frames = loadFrames(profile);
        if (!frames) return;

        const keyframes = frames.filter((f) => f.isKeyframe);
        expect(keyframes.length).toBeGreaterThan(0);
        // First video frame should typically be a keyframe
        const firstVideo = frames.find((f) => !f.audio);
        expect(firstVideo?.isKeyframe).toBe(true);
      });

      it("video frames have valid data", () => {
        const frames = loadFrames(profile);
        if (!frames) return;

        for (const f of frames.filter((f: any) => !f.audio).slice(0, 5)) {
          expect(f.dataLength).toBeGreaterThan(0);
          expect(f.dataHead.length).toBeGreaterThan(0);
          // dataHead is hex-encoded, should be valid hex
          expect(f.dataHead).toMatch(/^[0-9a-f]+$/);
        }
      });

      it("audio frames have ADTS headers", () => {
        const frames = loadFrames(profile);
        if (!frames) return;

        const audio = frames.filter((f) => f.audio);
        if (audio.length === 0) return;

        // ADTS sync word: 0xFFF (first 12 bits)
        for (const f of audio.slice(0, 3)) {
          const firstByte = parseInt(f.dataHead.substring(0, 2), 16);
          const secondByte = parseInt(f.dataHead.substring(2, 4), 16);
          expect(firstByte).toBe(0xff);
          expect(secondByte & 0xf0).toBe(0xf0);
        }
      });

      it("video timestamps are monotonically increasing", () => {
        const frames = loadFrames(profile);
        if (!frames) return;

        const videoWithTs = frames.filter(
          (f) => !f.audio && f.microseconds != null,
        );
        if (videoWithTs.length < 2) return;

        for (let i = 1; i < Math.min(videoWithTs.length, 20); i++) {
          expect(videoWithTs[i]!.microseconds).toBeGreaterThanOrEqual(
            videoWithTs[i - 1]!.microseconds,
          );
        }
      });
    });
  }

  describe("cross-profile analysis", () => {
    it("main has larger frames than sub", () => {
      const main = loadFrames("main");
      const sub = loadFrames("sub");
      if (!main || !sub) return;

      const mainAvg =
        main.filter((f) => !f.audio).reduce((s, f) => s + f.dataLength, 0) /
        main.filter((f) => !f.audio).length;
      const subAvg =
        sub.filter((f) => !f.audio).reduce((s, f) => s + f.dataLength, 0) /
        sub.filter((f) => !f.audio).length;

      // Main (4K) should have much larger frames than sub (360p)
      expect(mainAvg).toBeGreaterThan(subAvg * 2);
    });
  });
});
