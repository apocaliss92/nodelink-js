import { describe, expect, it } from "vitest";
import { RTCIceCandidate } from "werift";
import { toWeriftIceCandidateInit } from "../../src/baichuan/stream/BaichuanWebRTCServer";

const LINE = "candidate:0 1 UDP 2130706431 192.168.1.50 50000 typ host";

describe("toWeriftIceCandidateInit", () => {
  it("produces an init object werift actually populates", () => {
    // Regression guard for #38: werift's RTCIceCandidate constructor takes a
    // single init object (`Object.assign(this, props)`). Passing the candidate
    // string positionally spreads it into numeric keys and leaves
    // `.candidate` undefined, so IceCandidate.fromJSON() throws and the
    // candidate is dropped without any error surfacing.
    const positional = new RTCIceCandidate(LINE as any, "0" as any);
    expect(positional.candidate).toBeUndefined();

    const fixed = new RTCIceCandidate(
      toWeriftIceCandidateInit({
        candidate: LINE,
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    );
    expect(fixed.candidate).toBe(LINE);
    expect(fixed.sdpMid).toBe("0");
    expect(fixed.sdpMLineIndex).toBe(0);
  });

  it("defaults sdpMid to \"0\" when the browser omits it", () => {
    const init = toWeriftIceCandidateInit({ candidate: LINE });
    expect(init.sdpMid).toBe("0");
  });

  it("derives sdpMLineIndex from a numeric sdpMid when absent", () => {
    // werift routes via getTransportByMLineIndex and only accepts a *number*;
    // with sdpMid alone it silently falls back to iceTransports[0].
    const init = toWeriftIceCandidateInit({ candidate: LINE, sdpMid: "1" });
    expect(init.sdpMLineIndex).toBe(1);
  });

  it("keeps an explicit sdpMLineIndex of 0 instead of treating it as missing", () => {
    const init = toWeriftIceCandidateInit({
      candidate: LINE,
      sdpMid: "1",
      sdpMLineIndex: 0,
    });
    expect(init.sdpMLineIndex).toBe(0);
  });

  it("leaves sdpMLineIndex undefined for a non-numeric sdpMid", () => {
    const init = toWeriftIceCandidateInit({ candidate: LINE, sdpMid: "audio" });
    expect(init.sdpMid).toBe("audio");
    expect(init.sdpMLineIndex).toBeUndefined();
  });
});
