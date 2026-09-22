/**
 * A downloaded clip has sound.
 *
 * Measured 2026-09-20, read-only, one session each:
 *
 * - E1 Outdoor PoE v3.1.0.5223 (standalone): a 2 s clip came back as
 *   1 967 336 bytes in 2 662 ms and carried **51 H.264 access units and 32
 *   AAC frames** (16 608 bytes).
 * - Home Hub v3.3.0.456, child channel 0: a 43 s clip came back as
 *   11 680 272 bytes in 9 074 ms and carried **661 H.265 access units and
 *   688 AAC frames** (357 072 bytes).
 *
 * So the cmd 5 download has always carried the audio — `downloadRecording`
 * returns it inside the BcMedia stream and `downloadRecordingDemuxed`
 * registered no `onAudioFrame`, so it fell on the floor. Both cameras speak
 * **AAC-LC, 16 kHz, mono, in ADTS frames of 519 bytes**, which is exactly
 * what `ffmpeg -f aac -i … -c:a copy -bsf:a aac_adtstoasc` reads, so a
 * consumer keeps `+faststart`, a real duration and Range.
 *
 * The fixtures are those two downloads, 40 packets each, with every BcMedia
 * header intact and every payload sanitised (see the `-meta.json`).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BcMediaAnnexBDecoder } from "../../src/baichuan/stream/BcMediaAnnexBDecoder";
import {
  parseAdtsHeader,
  ADTS_HEADER_BYTES,
  ADTS_SAMPLES_PER_FRAME,
} from "../../src/reolink/baichuan/utils/recordingAudio";

const FIX = join(__dirname, "..", "fixtures", "recordings");
const bin = (topology: string): Buffer =>
  readFileSync(join(FIX, topology, "download-5-bcmedia-audio.bin"));
const meta = (topology: string): Record<string, never> =>
  JSON.parse(
    readFileSync(
      join(FIX, topology, "download-5-bcmedia-audio-meta.json"),
      "utf8",
    ),
  );

function makeApi(raw: Buffer): ReolinkBaichuanApi {
  const api = new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535,
    username: "u",
    password: "p",
    transport: "tcp",
    nativeOnly: true,
  });
  (
    api as unknown as { downloadRecording: () => Promise<Buffer> }
  ).downloadRecording = vi.fn(async () => raw);
  return api;
}

const cases = [
  {
    topology: "standalone",
    videoType: "H264",
    audioFrames: 15,
    videoAus: 24,
    fps: 25,
    infoFps: 25,
    spanSeconds: 0.905,
  },
  {
    topology: "hub",
    videoType: "H265",
    audioFrames: 20,
    videoAus: 19,
    fps: 15,
    infoFps: 30,
    spanSeconds: 1.158,
  },
] as const;

describe("cmd 5 download: the audio is there, and it comes back", () => {
  it("the captured ADTS header is AAC-LC 16 kHz mono and self-delimiting", () => {
    for (const { topology } of cases) {
      const frames: Buffer[] = [];
      const decoder = new BcMediaAnnexBDecoder({
        strict: false,
        onAudioFrame: ({ data }) => frames.push(data),
      });
      decoder.push(bin(topology));

      const head = parseAdtsHeader(frames[0]!);
      expect(head, topology).not.toBeNull();
      expect(head!.sampleRate).toBe(16_000);
      expect(head!.channels).toBe(1);
      // the header's frame_length is the packet: concatenating the frames
      // yields an elementary stream ffmpeg can walk on its own.
      expect(head!.frameLength).toBe(frames[0]!.length);
      expect(frames[0]!.length).toBe(519);
      expect(ADTS_HEADER_BYTES).toBe(7);
      expect(ADTS_SAMPLES_PER_FRAME).toBe(1024);
    }
  });

  it.each(cases)(
    "$topology: downloadRecordingDemuxed returns the audio track beside the video",
    async ({ topology, videoType, audioFrames, videoAus }) => {
      const api = makeApi(bin(topology));
      const out = await api.downloadRecordingDemuxed({
        channel: 0,
        fileName: "x",
      });

      expect(out.videoType).toBe(videoType);
      expect(out.stats.videoPackets).toBe(videoAus);
      expect(out.annexB.length).toBeGreaterThan(0);

      expect(out.audio).not.toBeNull();
      expect(out.audio!.codec).toBe("Aac");
      expect(out.audio!.format).toBe("adts");
      expect(out.audio!.frames).toBe(audioFrames);
      expect(out.audio!.sampleRate).toBe(16_000);
      expect(out.audio!.channels).toBe(1);
      expect(out.audio!.data.length).toBe(audioFrames * 519);
      expect(out.audio!.bytes).toBe(audioFrames * 519);
      expect(out.audio!.durationSeconds).toBeCloseTo(
        (audioFrames * 1024) / 16_000,
        6,
      );
      // every frame in `data` is reachable by walking frame_length only
      let offset = 0;
      let walked = 0;
      while (offset < out.audio!.data.length) {
        const h = parseAdtsHeader(out.audio!.data.subarray(offset));
        expect(h, `${topology} frame ${walked}`).not.toBeNull();
        offset += h!.frameLength;
        walked += 1;
      }
      expect(walked).toBe(audioFrames);
      expect(offset).toBe(out.audio!.data.length);
    },
  );

  it.each(cases)(
    "$topology: the result carries the frame rate the mux needs, from the timestamps",
    async ({ topology, fps, spanSeconds, infoFps }) => {
      const api = makeApi(bin(topology));
      const out = await api.downloadRecordingDemuxed({
        channel: 0,
        fileName: "x",
      });

      // The InfoV1/InfoV2 header is the FILE's nominal rate and the hub child
      // overstates it by 2x. Only the access-unit timestamps say what was
      // actually delivered, so that is what `-r` must be given.
      expect(out.stats.fpsSource).toBe("timestamps");
      expect(out.stats.fps).toBe(fps);
      expect(out.stats.infoFps).toBe(infoFps);
      expect(out.stats.durationSeconds).toBeCloseTo(spanSeconds, 3);
    },
  );

  it.each(cases)(
    "$topology: the decoder counts audio bytes with no callback attached",
    ({ topology, audioFrames }) => {
      const decoder = new BcMediaAnnexBDecoder({ strict: false });
      decoder.push(bin(topology));
      const stats = decoder.getStats();
      expect(stats.audioPackets).toBe(audioFrames);
      // a statistic that only exists when someone is listening is a lie
      expect(stats.audioBytesOut).toBe(audioFrames * 519);
    },
  );

  it("the fixture metadata matches what the fixture decodes to", () => {
    for (const { topology, audioFrames, videoAus, videoType } of cases) {
      const m = meta(topology) as unknown as {
        fixture: { audioPackets: number; videoPackets: number };
        wholeDownload: { videoType: string };
      };
      expect(m.fixture.audioPackets).toBe(audioFrames);
      expect(m.fixture.videoPackets).toBe(videoAus);
      expect(m.wholeDownload.videoType).toBe(videoType);
    }
  });
});
