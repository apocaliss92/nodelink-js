/**
 * Unit tests for MpegTsMuxer — the MPEG-TS muxer that feeds Go2rtcTcpServer.
 *
 * Validates:
 *  1. Basic structural properties of emitted MPEG-TS packets (sync byte, length, PID).
 *  2. Per-instance continuity counters (no cross-instance contamination).
 *  3. Audio PES appears on PID 0x0101 when includeAudio=true.
 *  4. Audio is suppressed when includeAudio=false.
 *  5. PAT/PMT appear before keyframes and periodically.
 *  6. PMT stream type reflects the video codec (H.264=0x1B, H.265=0x24).
 *  7. PTS is non-zero and encoded correctly in PES.
 *  8. reset() clears continuity counters.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MpegTsMuxer } from "../../src/baichuan/stream/MpegTsMuxer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TS_SYNC = 0x47;
const TS_SIZE = 188;
const PID_PAT = 0x0000;
const PID_PMT = 0x1000;
const PID_VIDEO = 0x0100;
const PID_AUDIO = 0x0101;

function getPid(pkt: Buffer): number {
  return ((pkt[1]! & 0x1f) << 8) | pkt[2]!;
}

function getCc(pkt: Buffer): number {
  return pkt[3]! & 0x0f;
}

function isPusi(pkt: Buffer): boolean {
  return !!(pkt[1]! & 0x40);
}

function splitTsPackets(buf: Buffer): Buffer[] {
  const pkts: Buffer[] = [];
  for (let i = 0; i + TS_SIZE <= buf.length; i += TS_SIZE) {
    pkts.push(buf.subarray(i, i + TS_SIZE));
  }
  return pkts;
}

/** Extract all TS packets from a mux call and group them by PID. */
function packetsByPid(buf: Buffer): Map<number, Buffer[]> {
  const map = new Map<number, Buffer[]>();
  for (const pkt of splitTsPackets(buf)) {
    const pid = getPid(pkt);
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid)!.push(pkt);
  }
  return map;
}

/** Minimal Annex-B H.264 keyframe (SPS + PPS + IDR NALUs). */
const H264_KEYFRAME = Buffer.from([
  // SPS (nal_unit_type = 7)
  0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f,
  // PPS (nal_unit_type = 8)
  0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x38, 0x80,
  // IDR slice (nal_unit_type = 5)
  0x00, 0x00, 0x00, 0x01, 0x65, 0xb8, 0x00, 0x04,
]);

/** Minimal Annex-B H.264 P-frame (nal_unit_type = 1). */
const H264_PFRAME = Buffer.from([
  0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x00, 0x04,
]);

/** Minimal ADTS AAC frame (44100 Hz, mono, 64 bytes of payload). */
function makeAdts(payloadSize = 64): Buffer {
  // ADTS header: 7 bytes (without CRC)
  const frameSize = 7 + payloadSize;
  const hdr = Buffer.alloc(7);
  hdr[0] = 0xff;
  hdr[1] = 0xf1; // ID=0 (MPEG-4), protection_absent=1
  hdr[2] = 0x50; // profile=1 (LC), sampling_freq_idx=4 (44100Hz)
  hdr[3] = 0x80 | ((frameSize >> 11) & 0x03);
  hdr[4] = (frameSize >> 3) & 0xff;
  hdr[5] = ((frameSize & 0x07) << 5) | 0x1f;
  hdr[6] = 0xfc;
  return Buffer.concat([hdr, Buffer.alloc(payloadSize, 0xaa)]);
}

// ---------------------------------------------------------------------------
// 1. Basic structural properties
// ---------------------------------------------------------------------------

describe("MpegTsMuxer — structural properties", () => {
  it("every byte in the output is in 188-byte TS packets starting with 0x47", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });
    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true);
    expect(buf.length % TS_SIZE).toBe(0);
    for (let i = 0; i < buf.length; i += TS_SIZE) {
      expect(buf[i]).toBe(TS_SYNC);
    }
  });

  it("muxAudio output is also aligned to 188-byte packets", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: true });
    const buf = muxer.muxAudio(makeAdts(), 1_000_000);
    expect(buf.length % TS_SIZE).toBe(0);
    for (let i = 0; i < buf.length; i += TS_SIZE) {
      expect(buf[i]).toBe(TS_SYNC);
    }
  });

  it("video keyframe output contains PAT, PMT and video PID packets", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });
    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true);
    const pids = packetsByPid(buf);
    expect(pids.has(PID_PAT)).toBe(true);
    expect(pids.has(PID_PMT)).toBe(true);
    expect(pids.has(PID_VIDEO)).toBe(true);
  });

  it("audio output contains only audio PID packets (no PAT/PMT)", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: true });
    // Prime tables first
    muxer.muxVideo(H264_KEYFRAME, 0, true);
    const buf = muxer.muxAudio(makeAdts(), 1_000_000);
    const pids = packetsByPid(buf);
    expect(pids.has(PID_AUDIO)).toBe(true);
    expect(pids.has(PID_PAT)).toBe(false);
    expect(pids.has(PID_PMT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-instance continuity counters
// ---------------------------------------------------------------------------

describe("MpegTsMuxer — per-instance continuity counters", () => {
  it("two concurrent instances have independent continuity counters", () => {
    const a = new MpegTsMuxer({ videoType: "H264" });
    const b = new MpegTsMuxer({ videoType: "H264" });

    // Advance instance A's video CC by sending 3 keyframes
    for (let i = 0; i < 3; i++) {
      a.muxVideo(H264_KEYFRAME, i * 33_333, true);
    }

    // Instance B's video packets should still start at CC=0
    const bufB = b.muxVideo(H264_KEYFRAME, 0, true);
    const vidPktsB = packetsByPid(bufB).get(PID_VIDEO) ?? [];
    expect(vidPktsB.length).toBeGreaterThan(0);
    expect(getCc(vidPktsB[0]!)).toBe(0);
  });

  it("continuity counter increments correctly within a single stream", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });

    // Collect video packet CCs across multiple mux calls
    const ccs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const buf = muxer.muxVideo(H264_PFRAME, i * 33_333, false);
      const vidPkts = packetsByPid(buf).get(PID_VIDEO) ?? [];
      for (const pkt of vidPkts) ccs.push(getCc(pkt));
    }

    // Each consecutive CC should be exactly 1 more than the previous (mod 16)
    for (let i = 1; i < ccs.length; i++) {
      expect(ccs[i]).toBe((ccs[i - 1]! + 1) & 0x0f);
    }
  });

  it("reset() restarts continuity counters from 0", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });

    // Advance CC past 0
    for (let i = 0; i < 4; i++) {
      muxer.muxVideo(H264_PFRAME, i * 33_333, false);
    }

    muxer.reset();

    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true);
    const vidPkts = packetsByPid(buf).get(PID_VIDEO) ?? [];
    expect(getCc(vidPkts[0]!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Audio support
// ---------------------------------------------------------------------------

describe("MpegTsMuxer — audio support", () => {
  it("muxAudio returns non-empty buffer when includeAudio=true", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: true });
    muxer.muxVideo(H264_KEYFRAME, 0, true); // prime muxer
    const buf = muxer.muxAudio(makeAdts(), 33_333);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("muxAudio returns empty buffer when includeAudio=false", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: false });
    const buf = muxer.muxAudio(makeAdts(), 33_333);
    expect(buf.length).toBe(0);
  });

  it("audio packets use PID 0x0101", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: true });
    muxer.muxVideo(H264_KEYFRAME, 0, true);
    const buf = muxer.muxAudio(makeAdts(), 33_333);
    const pkts = splitTsPackets(buf);
    expect(pkts.length).toBeGreaterThan(0);
    for (const pkt of pkts) {
      expect(getPid(pkt)).toBe(PID_AUDIO);
    }
  });

  it("audio PES starts at the right offset (PUSI set on first audio packet)", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: true });
    muxer.muxVideo(H264_KEYFRAME, 0, true);
    const buf = muxer.muxAudio(makeAdts(), 33_333);
    const pkts = splitTsPackets(buf);
    expect(isPusi(pkts[0]!)).toBe(true);
    // Continuation packets (if any) must NOT have PUSI set
    for (const pkt of pkts.slice(1)) {
      expect(isPusi(pkt)).toBe(false);
    }
  });

  it("includeAudio defaults to true", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" }); // no includeAudio
    muxer.muxVideo(H264_KEYFRAME, 0, true);
    const buf = muxer.muxAudio(makeAdts(), 33_333);
    expect(buf.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. PAT/PMT emission rules
// ---------------------------------------------------------------------------

describe("MpegTsMuxer — PAT/PMT emission rules", () => {
  it("PAT and PMT are emitted on every keyframe", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });

    for (let i = 0; i < 3; i++) {
      const buf = muxer.muxVideo(H264_KEYFRAME, i * 100_000, true);
      const pids = packetsByPid(buf);
      expect(pids.has(PID_PAT)).toBe(true);
      expect(pids.has(PID_PMT)).toBe(true);
    }
  });

  it("PAT and PMT are emitted on the first non-keyframe (initial send)", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });
    const buf = muxer.muxVideo(H264_PFRAME, 0, false);
    const pids = packetsByPid(buf);
    expect(pids.has(PID_PAT)).toBe(true);
    expect(pids.has(PID_PMT)).toBe(true);
  });

  it("PAT and PMT are NOT emitted on every P-frame after the first send", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });
    muxer.muxVideo(H264_KEYFRAME, 0, true); // send tables

    // Next few P-frames should not re-send tables
    for (let i = 1; i <= 5; i++) {
      const buf = muxer.muxVideo(H264_PFRAME, i * 33_333, false);
      const pids = packetsByPid(buf);
      expect(pids.has(PID_PAT)).toBe(false);
      expect(pids.has(PID_PMT)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. PMT stream type matches codec
// ---------------------------------------------------------------------------

describe("MpegTsMuxer — PMT stream type", () => {
  function getPmtStreamTypes(pmtPkt: Buffer): number[] {
    // PMT payload starts after TS header (4) + pointer field (1) + section header
    // table_id(1) + section_syntax+length(2) + prog_num(2) + version(1) + sec(1) + last(1) + PCR_PID(2) + prog_info_len(2) = 12
    // So first stream_type is at offset 4 + 1 + 3 + 9 = 17
    const types: number[] = [];
    let i = 17;
    while (i + 5 <= TS_SIZE) {
      const st = pmtPkt[i]!;
      if (st === 0xff) break; // stuffing
      types.push(st);
      i += 5;
    }
    return types;
  }

  it("PMT stream type for H.264 is 0x1B", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: false });
    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true);
    const pmtPkts = packetsByPid(buf).get(PID_PMT) ?? [];
    const types = getPmtStreamTypes(pmtPkts[0]!);
    expect(types).toContain(0x1b);
  });

  it("PMT stream type for H.265 is 0x24", () => {
    const muxer = new MpegTsMuxer({ videoType: "H265", includeAudio: false });
    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true); // data doesn't affect stream type
    const pmtPkts = packetsByPid(buf).get(PID_PMT) ?? [];
    const types = getPmtStreamTypes(pmtPkts[0]!);
    expect(types).toContain(0x24);
  });

  it("PMT includes audio stream type 0x0F when includeAudio=true", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: true });
    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true);
    const pmtPkts = packetsByPid(buf).get(PID_PMT) ?? [];
    const types = getPmtStreamTypes(pmtPkts[0]!);
    expect(types).toContain(0x0f); // AAC-ADTS
  });

  it("PMT does NOT include audio stream type when includeAudio=false", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: false });
    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true);
    const pmtPkts = packetsByPid(buf).get(PID_PMT) ?? [];
    const types = getPmtStreamTypes(pmtPkts[0]!);
    expect(types).not.toContain(0x0f);
  });
});

// ---------------------------------------------------------------------------
// 6. PTS encoding
// ---------------------------------------------------------------------------

describe("MpegTsMuxer — PTS encoding", () => {
  /**
   * Extract PTS from the first PES in a batch of TS packets for the given PID.
   * Returns the PTS in 90 kHz ticks.
   */
  function extractPts(buf: Buffer, pid: number): number | null {
    const pkts = packetsByPid(buf).get(pid);
    if (!pkts || pkts.length === 0) return null;

    // Find the packet with PUSI set — that's where the PES starts
    const first = pkts.find((p) => isPusi(p));
    if (!first) return null;

    // Locate start of PES within the TS payload
    // TS header = 4 bytes, adaptation field may be present
    const adaptControl = (first[3]! >> 4) & 0x03;
    let payloadStart = 4;
    if (adaptControl === 3 || adaptControl === 2) {
      // Adaptation field present
      payloadStart += 1 + first[4]!; // +1 for adaptation_field_length byte itself
    }

    // PES: 00 00 01 stream_id length(2) flags(2) header_data_len pts...
    const pes = first.subarray(payloadStart);
    if (pes.length < 14) return null;
    if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return null;

    const ptsDtsFlags = (pes[7]! >> 6) & 0x03;
    if (ptsDtsFlags < 2) return null; // no PTS

    const p = pes.subarray(9); // PTS bytes
    const pts =
      (((p[0]! >> 1) & 0x07) * 2 ** 30) +
      (p[1]! * 2 ** 22) +
      (((p[2]! >> 1) & 0x7f) * 2 ** 15) +
      (p[3]! * 2 ** 7) +
      ((p[4]! >> 1) & 0x7f);
    return pts;
  }

  it("PTS is 0 for ptsUs=0", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });
    const buf = muxer.muxVideo(H264_KEYFRAME, 0, true);
    const pts = extractPts(buf, PID_VIDEO);
    expect(pts).toBe(0);
  });

  it("PTS for 1 second (1_000_000 µs) is 90000 ticks", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });
    const buf = muxer.muxVideo(H264_KEYFRAME, 1_000_000, true);
    const pts = extractPts(buf, PID_VIDEO);
    expect(pts).toBe(90_000);
  });

  it("PTS for audio at 33333 µs (≈1 video frame at 30fps) is 3000 ticks", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264", includeAudio: true });
    muxer.muxVideo(H264_KEYFRAME, 0, true);
    const buf = muxer.muxAudio(makeAdts(), 33_333);
    const pts = extractPts(buf, PID_AUDIO);
    expect(pts).toBe(Math.floor((33_333 * 90) / 1000));
  });

  it("PTS increases monotonically across consecutive frames", () => {
    const muxer = new MpegTsMuxer({ videoType: "H264" });
    let prevPts = -1;
    for (let i = 0; i < 5; i++) {
      const ptsUs = i * 33_333;
      const buf = muxer.muxVideo(H264_PFRAME, ptsUs, false);
      const pts = extractPts(buf, PID_VIDEO);
      expect(pts).not.toBeNull();
      expect(pts!).toBeGreaterThan(prevPts);
      prevPts = pts!;
    }
  });
});
