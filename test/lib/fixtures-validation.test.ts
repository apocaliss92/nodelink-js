import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

function loadFixture(name: string): any {
  const p = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("Fixture validation (captured from real camera)", () => {
  it("device-info has required fields", () => {
    const info = loadFixture("device-info.json");
    if (!info) return;

    expect(info).toHaveProperty("type");
    expect(info).toHaveProperty("firmwareVersion");
    expect(typeof info.type).toBe("string");
    expect(info.type.length).toBeGreaterThan(0);
  });

  it("channel-count is valid", () => {
    const data = loadFixture("channel-count.json");
    if (!data) return;

    expect(data.channelCount).toBeGreaterThanOrEqual(1);
  });

  it("stream-metadata has streams", () => {
    const meta = loadFixture("stream-metadata.json");
    if (!meta) return;

    expect(meta).toHaveProperty("streams");
    expect(Array.isArray(meta.streams)).toBe(true);
    expect(meta.streams.length).toBeGreaterThan(0);
  });

  it("stream-options has native streams with profiles", () => {
    const opts = loadFixture("stream-options.json");
    if (!opts) return;

    expect(opts).toHaveProperty("nativeStreams");
    expect(Array.isArray(opts.nativeStreams)).toBe(true);

    const profiles = opts.nativeStreams.map((s: any) => s.profile);
    expect(profiles).toContain("main");
    // sub and ext may or may not be present
  });

  it("stream-options main has resolution and codec", () => {
    const opts = loadFixture("stream-options.json");
    if (!opts) return;

    const main = opts.nativeStreams.find((s: any) => s.profile === "main");
    expect(main).toBeDefined();
    expect(main.metadata).toBeDefined();
    expect(main.metadata.width).toBeGreaterThan(0);
    expect(main.metadata.height).toBeGreaterThan(0);
    expect(main.metadata.videoEncType).toBeDefined();
  });

  for (const profile of ["main", "sub", "ext"]) {
    it(`stream-${profile}-frames has captured frames`, () => {
      const frames = loadFixture(`stream-${profile}-frames.json`);
      if (!frames || frames.error) return;

      expect(Array.isArray(frames)).toBe(true);
      expect(frames.length).toBeGreaterThan(0);

      // Should have video frames
      const videoFrames = frames.filter((f: any) => !f.audio);
      expect(videoFrames.length).toBeGreaterThan(0);

      // Video frames should have videoType
      const firstVideo = videoFrames[0];
      expect(firstVideo.videoType).toMatch(/^H26[45]$/);
      expect(firstVideo.dataLength).toBeGreaterThan(0);
      expect(firstVideo.dataHead.length).toBeGreaterThan(0);
    });

    it(`stream-${profile}-frames has keyframes`, () => {
      const frames = loadFixture(`stream-${profile}-frames.json`);
      if (!frames || frames.error) return;

      const keyframes = frames.filter((f: any) => f.isKeyframe);
      expect(keyframes.length).toBeGreaterThan(0);
    });

    it(`stream-${profile}-frames has audio frames`, () => {
      const frames = loadFixture(`stream-${profile}-frames.json`);
      if (!frames || frames.error) return;

      const audioFrames = frames.filter((f: any) => f.audio);
      expect(audioFrames.length).toBeGreaterThan(0);
      expect(audioFrames[0].dataLength).toBeGreaterThan(0);
    });
  }
});
