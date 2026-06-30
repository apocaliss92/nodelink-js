/**
 * Regression (Bug #30): the TCP-interleaved RTSP delivery path forwarded RTP
 * without honouring socket backpressure, and the only send-buffer guard lived
 * in an unreachable branch (`useTcpInterleaved && !useDirectRtp`, but
 * useDirectRtp === useTcpInterleaved). A 100 KB+ keyframe fragmented into ~94
 * FU-A writes could flood/coalesce on the socket, so a downstream consumer
 * (ffmpeg/Frigate) saw dropped/choppy frames even though the source was clean.
 *
 * Contract for the (now reachable) backpressure guard:
 *  - below the cap → keep the client;
 *  - above the cap → disconnect (drop the dead/slow client rather than buffer
 *    unbounded RAM).
 */

import { describe, it, expect } from "vitest";
import { BaichuanRtspServer } from "../../src/baichuan/stream/BaichuanRtspServer.js";

describe("BaichuanRtspServer backpressure guard", () => {
  const cap = BaichuanRtspServer.MAX_CLIENT_BUFFERED_BYTES;

  it("does not disconnect when the send buffer is within the cap", () => {
    expect(BaichuanRtspServer.shouldDisconnectForBackpressure(0)).toBe(false);
    expect(BaichuanRtspServer.shouldDisconnectForBackpressure(cap)).toBe(false);
    expect(
      BaichuanRtspServer.shouldDisconnectForBackpressure(cap - 1),
    ).toBe(false);
  });

  it("disconnects once the send buffer grows past the cap", () => {
    expect(BaichuanRtspServer.shouldDisconnectForBackpressure(cap + 1)).toBe(
      true,
    );
    expect(
      BaichuanRtspServer.shouldDisconnectForBackpressure(cap * 4),
    ).toBe(true);
  });

  it("uses a sane (multi-MB) cap so transient keyframe bursts are tolerated", () => {
    // A single 4K keyframe is well under a megabyte; the cap must be large
    // enough not to trip on a normal burst but small enough to bound RAM.
    expect(cap).toBeGreaterThanOrEqual(1 * 1024 * 1024);
    expect(cap).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
