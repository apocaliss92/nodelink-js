import { describe, expect, it } from "vitest";
import { Rfc4571Muxer } from "../../src/rfc/rfc4571";

// Characterisation (planning#695): the "video timing: discarded" branch does not
// hold or drop output. It advances the RTP clock by ONE frame for the whole
// jump, so a real 30-47 s camera-side pause is a log line, not the cause of a hole.
describe("rfc4571 video timing: large forward delta", () => {
  it("advances the RTP clock by one frame, not by the jump", () => {
    const m = new Rfc4571Muxer({ logger: { warn: () => {} } } as never) as unknown as {
      setVideoTimestampFromMicroseconds(us: number): void;
      videoRtp: { advanceTimestamp(n: number): void };
    };
    const advances: number[] = [];
    const orig = m.videoRtp.advanceTimestamp.bind(m.videoRtp);
    m.videoRtp.advanceTimestamp = (n: number) => {
      advances.push(n);
      orig(n);
    };
    m.setVideoTimestampFromMicroseconds(1_000_000);
    m.setVideoTimestampFromMicroseconds(1_066_000);
    m.setVideoTimestampFromMicroseconds(1_066_000 + 40_000_000); // 40 s jump
    expect(advances).toHaveLength(2);
    expect(advances[1]!).toBeLessThan(90_000);
  });
});
