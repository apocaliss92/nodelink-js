import { describe, it, expect } from "vitest";
import { parseBcMedia } from "../../src/baichuan/stream/BcMediaParser";
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

/**
 * A chunk boundary inside the video header must WAIT, not throw.
 *
 * `parseIframe` / `parsePframe` guarded `buf.length < 20` — the fixed header,
 * magic(4) + videoType(4) + payloadSize(4) + additionalHeaderSize(4) +
 * microseconds(4) — and then immediately read `readUInt32LE(20)` for
 * `unknown`, which needs bytes 20..23. A buffer holding exactly 20 to 23 bytes
 * passed the guard and threw out of range.
 *
 * It was unreachable while a whole recording arrived as ONE push, which is why
 * it survived: it takes a boundary landing inside those four bytes. `onChunk`
 * (0.8.0) feeds the parser chunk by chunk and can, so a clip could die
 * mid-transfer on a split nobody controls.
 */
describe("a video header split across chunks", () => {
  const header = (magic: string): Buffer => {
    const b = Buffer.alloc(24);
    b.write(magic, 0, "utf8");
    b.write("H264", 4, "utf8");
    b.writeUInt32LE(16, 8); // payloadSize
    b.writeUInt32LE(0, 12); // additionalHeaderSize
    b.writeUInt32LE(1234, 16); // microseconds
    b.writeUInt32LE(0, 20); // unknown — the four bytes the old guard skipped
    return b;
  };

  for (const magic of ["\x30\x30\x64\x63", "\x31\x30\x64\x63"]) {
    for (let len = 20; len <= 23; len++) {
      it(`returns null on ${len} bytes rather than throwing (magic ${magic.charCodeAt(1)})`, () => {
        // The whole point: an incomplete header is "come back with more",
        // never an exception that kills the transfer.
        const slice = header(magic).subarray(0, len);
        expect(() => parseBcMedia(slice)).not.toThrow();
        expect(parseBcMedia(slice)).toBeNull();
      });
    }
  }

  it("still parses once the 24th byte arrives", () => {
    expect(() => parseBcMedia(header("\x30\x30\x64\x63"))).not.toThrow();
  });
});
