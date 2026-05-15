import { describe, expect, it } from "vitest";
import { buildEncOptions } from "../../src/reolink/baichuan/utils/encOptions";
import type { BaichuanStreamInfoList } from "../../src/reolink/baichuan/types";

// Mirrors the cmd_146 reply captured in pcap/resolution.pcapng on an
// E1 Outdoor PoE — 3 resolutions for mainStream, all paired with the same
// subStream config. videoEncTypeList = [0, 1] means both H.264 and H.265
// are available at that resolution.
const E1_OUTDOOR_PCAP_LIST: BaichuanStreamInfoList = {
  streams: [
    {
      channelBits: 1,
      encodeTables: [
        {
          type: "mainStream",
          width: 3840,
          height: 2160,
          videoEncType: 0,
          videoEncTypeList: [0, 1],
          defaultFramerate: 25,
          defaultBitrate: 6144,
          framerateTable: [25, 22, 20, 18, 16, 15, 12, 10, 8, 6, 4, 2],
          bitrateTable: [4096, 5120, 6144, 7168, 8192],
          defaultGop: 2,
        },
        {
          type: "subStream",
          width: 640,
          height: 360,
          videoEncType: 0,
          defaultFramerate: 10,
          defaultBitrate: 256,
          framerateTable: [15, 10, 7, 4],
          bitrateTable: [64, 128, 160, 192, 256, 384, 512],
          defaultGop: 4,
        },
      ],
    },
    {
      channelBits: 1,
      encodeTables: [
        {
          type: "mainStream",
          width: 2560,
          height: 1440,
          videoEncType: 0,
          videoEncTypeList: [0, 1],
          defaultFramerate: 25,
          defaultBitrate: 6144,
          framerateTable: [25, 22, 20, 18, 16, 15, 12, 10, 8, 6, 4, 2],
          bitrateTable: [1024, 1536, 2048, 3072, 4096, 5120, 6144, 7168, 8192],
          defaultGop: 2,
        },
        {
          type: "subStream",
          width: 640,
          height: 360,
          videoEncType: 0,
          defaultFramerate: 10,
          defaultBitrate: 256,
          framerateTable: [15, 10, 7, 4],
          bitrateTable: [64, 128, 160, 192, 256, 384, 512],
          defaultGop: 4,
        },
      ],
    },
    {
      channelBits: 1,
      encodeTables: [
        {
          type: "mainStream",
          width: 2304,
          height: 1296,
          videoEncType: 0,
          videoEncTypeList: [0, 1],
          defaultFramerate: 25,
          defaultBitrate: 6144,
          framerateTable: [25, 22, 20, 18, 16, 15, 12, 10, 8, 6, 4, 2],
          bitrateTable: [1024, 1536, 2048, 3072, 4096, 5120, 6144, 7168, 8192],
          defaultGop: 2,
        },
        {
          type: "subStream",
          width: 640,
          height: 360,
          videoEncType: 0,
          defaultFramerate: 10,
          defaultBitrate: 256,
          framerateTable: [15, 10, 7, 4],
          bitrateTable: [64, 128, 160, 192, 256, 384, 512],
          defaultGop: 4,
        },
      ],
    },
  ],
};

describe("buildEncOptions", () => {
  it("aggregates the three mainStream resolutions from the pcap", () => {
    const opts = buildEncOptions(E1_OUTDOOR_PCAP_LIST, 0);
    expect(opts.channel).toBe(0);
    expect(opts.mainStream).toBeDefined();
    expect(opts.mainStream!.type).toBe("mainStream");
    expect(opts.mainStream!.resolutions).toHaveLength(3);
    expect(opts.mainStream!.resolutions.map((r) => `${r.width}x${r.height}`)).toEqual([
      "3840x2160",
      "2560x1440",
      "2304x1296",
    ]);
  });

  it("dedupes the subStream resolution (same 640x360 appears 3 times in pcap)", () => {
    const opts = buildEncOptions(E1_OUTDOOR_PCAP_LIST, 0);
    expect(opts.subStream).toBeDefined();
    expect(opts.subStream!.resolutions).toHaveLength(1);
    expect(opts.subStream!.resolutions[0]!.width).toBe(640);
    expect(opts.subStream!.resolutions[0]!.height).toBe(360);
  });

  it("maps videoEncTypeList [0, 1] to h264/h265 in order", () => {
    const opts = buildEncOptions(E1_OUTDOOR_PCAP_LIST, 0);
    const r = opts.mainStream!.resolutions[0]!;
    expect(r.videoEncTypes).toEqual(["h264", "h265"]);
  });

  it("falls back to a single-codec list when only videoEncType is set", () => {
    const opts = buildEncOptions(E1_OUTDOOR_PCAP_LIST, 0);
    // subStream entries only have videoEncType=0, no list.
    expect(opts.subStream!.resolutions[0]!.videoEncTypes).toEqual(["h264"]);
  });

  it("includes default framerate/bitrate/gop and full allowed lists", () => {
    const opts = buildEncOptions(E1_OUTDOOR_PCAP_LIST, 0);
    const r4k = opts.mainStream!.resolutions[0]!;
    expect(r4k.defaultFramerate).toBe(25);
    expect(r4k.defaultBitrate).toBe(6144);
    expect(r4k.defaultGop).toBe(2);
    expect(r4k.framerateOptions).toEqual([25, 22, 20, 18, 16, 15, 12, 10, 8, 6, 4, 2]);
    expect(r4k.bitrateOptions).toEqual([4096, 5120, 6144, 7168, 8192]);
  });

  it("exposes the static encoderTypes / encoderProfiles the app uses", () => {
    const opts = buildEncOptions(E1_OUTDOOR_PCAP_LIST, 0);
    expect(opts.mainStream!.encoderTypes).toEqual(["vbr", "cbr"]);
    expect(opts.mainStream!.encoderProfiles).toEqual(["high", "main", "baseline"]);
  });

  it("returns undefined per-stream when no encodeTable matches", () => {
    const empty: BaichuanStreamInfoList = { streams: [] };
    const opts = buildEncOptions(empty, 7);
    expect(opts.channel).toBe(7);
    expect(opts.mainStream).toBeUndefined();
    expect(opts.subStream).toBeUndefined();
    expect(opts.thirdStream).toBeUndefined();
  });
});
