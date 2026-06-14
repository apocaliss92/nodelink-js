// test/lib/placeholder-renderer.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PlaceholderRenderer } from "../../src/baichuan/stream/PlaceholderRenderer";
import { isH264KeyframeAnnexB } from "../../src/baichuan/stream/H264Converter";
import { isH265KeyframeAnnexB } from "../../src/baichuan/stream/H265Converter";

function ffmpegAvailable(): boolean {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function libx265Available(): boolean {
  try {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
    return /\blibx265\b/.test(out);
  } catch { return false; }
}

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

describe("PlaceholderRenderer decorated mode", () => {
  it("produces a valid H264 IDR with overlay from a real keyframe", async () => {
    if (!ffmpegAvailable()) return; // skip where ffmpeg missing
    const tmp = path.join(process.env.TMPDIR || "/tmp", "ph-src.h264");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1",
      "-frames:v", "1", "-c:v", "libx264", "-bsf:v", "h264_mp4toannexb",
      "-f", "h264", "-y", tmp,
    ]);
    const src = fs.readFileSync(tmp);
    const renderer = new PlaceholderRenderer({
      placeholder: { enabled: true, text: "Sleeping", opacity: 0.5 },
    });
    const out = await renderer.render({ data: src, videoType: "H264" });
    expect(out).not.toBeNull();
    expect(isH264KeyframeAnnexB(out!)).toBe(true);
    expect(out!.equals(src)).toBe(false); // decorated, not the raw keyframe
  });

  it("centers and scales the overlay on a large (720p) frame without error", async () => {
    if (!ffmpegAvailable()) return; // skip where ffmpeg missing
    // 1280x720 exercises the SANS_128 font branch + centered placement.
    const tmp = path.join(process.env.TMPDIR || "/tmp", "ph-src-720p.h264");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=1280x720:d=0.1",
      "-frames:v", "1", "-c:v", "libx264", "-bsf:v", "h264_mp4toannexb",
      "-f", "h264", "-y", tmp,
    ]);
    const src = fs.readFileSync(tmp);
    const renderer = new PlaceholderRenderer({
      placeholder: { enabled: true, text: "Sleeping", opacity: 0.5 },
    });
    const out = await renderer.render({ data: src, videoType: "H264" });
    expect(out).not.toBeNull();
    expect(isH264KeyframeAnnexB(out!)).toBe(true);
    expect(out!.equals(src)).toBe(false); // decorated, not the raw keyframe
  });

  it("produces a valid H265 IDR with overlay from a real keyframe", async () => {
    if (!ffmpegAvailable() || !libx265Available()) return; // skip where ffmpeg/libx265 missing
    const tmp = path.join(process.env.TMPDIR || "/tmp", "ph-src.h265");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1",
      "-frames:v", "1", "-c:v", "libx265",
      "-f", "hevc", "-y", tmp,
    ]);
    const src = fs.readFileSync(tmp);
    const renderer = new PlaceholderRenderer({
      placeholder: { enabled: true, text: "Sleeping", opacity: 0.5 },
    });
    const out = await renderer.render({ data: src, videoType: "H265" });
    expect(out).not.toBeNull();
    expect(isH265KeyframeAnnexB(out!)).toBe(true);
    expect(out!.equals(src)).toBe(false); // decorated, not the raw keyframe
  });
});
