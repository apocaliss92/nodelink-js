import { describe, it, expect, vi } from "vitest";
import { mulaw } from "alawmulaw";
import {
  RtspBackchannel,
  parseRtpPacket,
} from "../../src/baichuan/stream/RtspBackchannel";
import type { TalkSession } from "../../src/reolink/baichuan/types";

/**
 * Synthesize an RTP packet that carries the supplied G.711 μ-law / A-law
 * payload. The header is minimal but valid (V=2, no padding, no extension,
 * no CSRCs) so parseRtpPacket() reads the bytes back unchanged.
 */
function buildRtp(
  payloadType: number,
  payload: Buffer | Uint8Array,
  seq = 1,
  timestamp = 0,
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt8(0x80, 0); // V=2
  header.writeUInt8(payloadType & 0x7f, 1);
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(0xdeadbeef, 8);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * Fake TalkSession that records every ADPCM block it is sent. Block size
 * mirrors Reolink's default `lengthPerEncoder=1024` minus the 4-byte
 * predictor state (matches scrypted plugin defaults).
 */
function makeFakeTalk(opts?: { blockSize?: number; rejectAfter?: number }): {
  session: TalkSession;
  receivedBlocks: () => Buffer[];
  stopped: () => boolean;
} {
  const blockSize = opts?.blockSize ?? 1024;
  const rejectAfter = opts?.rejectAfter;
  const blocks: Buffer[] = [];
  let sendCount = 0;
  let isStopped = false;
  const session: TalkSession = {
    info: {
      channel: 0,
      audioConfig: {
        audioType: "adpcm",
        sampleRate: 16000,
        samplePrecision: 16,
        lengthPerEncoder: blockSize,
        soundTrack: "mono",
        priority: 0,
      },
      blockSize,
      fullBlockSize: blockSize + 4,
    },
    sendAudio: async (adpcm: Buffer) => {
      sendCount++;
      if (rejectAfter !== undefined && sendCount > rejectAfter) {
        throw new Error("synthetic talk error");
      }
      blocks.push(Buffer.from(adpcm));
    },
    stop: async () => {
      isStopped = true;
    },
  };
  return {
    session,
    receivedBlocks: () => blocks,
    stopped: () => isStopped,
  };
}

describe("parseRtpPacket", () => {
  it("returns null for short packets", () => {
    expect(parseRtpPacket(Buffer.alloc(8))).toBeNull();
  });

  it("rejects non-version-2 packets", () => {
    const p = Buffer.alloc(12);
    p.writeUInt8(0x00, 0); // V=0
    expect(parseRtpPacket(p)).toBeNull();
  });

  it("decodes a standard PCMU payload", () => {
    const audio = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    const rtp = buildRtp(0, audio, 7, 1234);
    const parsed = parseRtpPacket(rtp);
    expect(parsed?.payloadType).toBe(0);
    expect(parsed?.payload).toEqual(audio);
  });

  it("skips CSRC list when CC > 0", () => {
    const audio = Buffer.from([0xaa, 0xbb]);
    const cc = 2;
    const header = Buffer.alloc(12);
    header.writeUInt8(0x80 | cc, 0);
    header.writeUInt8(0, 1);
    const csrc = Buffer.alloc(cc * 4); // dummy
    const rtp = Buffer.concat([header, csrc, audio]);
    expect(parseRtpPacket(rtp)?.payload).toEqual(audio);
  });

  it("respects padding length byte at the end", () => {
    const audio = Buffer.from([0x11, 0x22]);
    const pad = Buffer.from([0xff, 0xff, 0x03]); // 3 bytes total, last says pad=3
    const header = Buffer.alloc(12);
    header.writeUInt8(0x80 | 0x20, 0); // V=2, P=1
    header.writeUInt8(0, 1);
    const rtp = Buffer.concat([header, audio, pad]);
    expect(parseRtpPacket(rtp)?.payload).toEqual(audio);
  });

  it("returns null when padding byte is invalid", () => {
    const header = Buffer.alloc(12);
    header.writeUInt8(0x80 | 0x20, 0); // V=2, P=1
    header.writeUInt8(0, 1);
    const bogus = Buffer.from([0xff]); // pad-length byte says 0xFF = 255 > payload length
    expect(parseRtpPacket(Buffer.concat([header, bogus]))).toBeNull();
  });

  it("skips RTP extension headers", () => {
    const audio = Buffer.from([0xde, 0xad]);
    const header = Buffer.alloc(12);
    header.writeUInt8(0x80 | 0x10, 0); // V=2, X=1
    header.writeUInt8(0, 1);
    const extHeader = Buffer.alloc(4);
    extHeader.writeUInt16BE(0xbede, 0); // profile id
    extHeader.writeUInt16BE(2, 2); // 2 extension words follow
    const extBody = Buffer.alloc(8); // 2 words = 8 bytes
    const rtp = Buffer.concat([header, extHeader, extBody, audio]);
    expect(parseRtpPacket(rtp)?.payload).toEqual(audio);
  });
});

describe("RtspBackchannel", () => {
  function pcmuPayload(sampleCount: number, freqHz = 220): Buffer {
    const pcm = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * freqHz * i) / 8000));
    }
    return Buffer.from(mulaw.encode(pcm));
  }

  it("packets received before start() are dropped, not crashed", () => {
    const ch = new RtspBackchannel({
      openTalkSession: async () => makeFakeTalk().session,
    });
    ch.feedRtp(buildRtp(0, pcmuPayload(160)));
    expect(ch.stats.rtpPacketsReceived).toBe(1);
    expect(ch.stats.rtpPacketsDropped).toBe(1);
    expect(ch.isActive).toBe(false);
  });

  it("decodes RTP PCMU frames and emits ADPCM blocks of the configured size", async () => {
    const fake = makeFakeTalk({ blockSize: 256 }); // 513 samples per ADPCM block
    const ch = new RtspBackchannel({ openTalkSession: async () => fake.session });
    await ch.start();
    expect(ch.isActive).toBe(true);

    // 32 RTP frames × 160 samples × 2x upsample = 10 240 PCM16 samples at 16 kHz.
    // 10 240 / 513 = 19 full blocks + 13 samples tail.
    for (let i = 0; i < 32; i++) {
      ch.feedRtp(buildRtp(0, pcmuPayload(160), i + 1, i * 160));
    }
    // Allow async pump to drain.
    await new Promise((r) => setTimeout(r, 30));

    const blocks = fake.receivedBlocks();
    // Each call to sendAudio may carry multiple blocks; sum the byte counts.
    const totalBytes = blocks.reduce((acc, b) => acc + b.length, 0);
    const blockBytes = 4 + 256; // header + payload
    expect(totalBytes % blockBytes).toBe(0);
    expect(totalBytes / blockBytes).toBe(19);
  });

  it("auto-detects PCMA via payload type 8", async () => {
    const fake = makeFakeTalk({ blockSize: 256 });
    const ch = new RtspBackchannel({ openTalkSession: async () => fake.session });
    await ch.start();
    // 600 samples at PT=8 → still feeds the pipeline without errors
    const alawBytes = Buffer.alloc(600).fill(0xd5); // arbitrary A-law byte
    ch.feedRtp(buildRtp(8, alawBytes));
    await new Promise((r) => setTimeout(r, 20));
    expect(ch.stats.rtpPacketsDropped).toBe(0);
  });

  it("drops oldest samples instead of growing latency when downstream stalls", async () => {
    const blockSize = 256;
    // Synthetic talk session that never returns from sendAudio() — simulates a
    // wedged camera or a slow socket. The backchannel should clamp its backlog.
    let releaseSend: (() => void) | undefined;
    const sendPending: Promise<void>[] = [];
    const stallingSession: TalkSession = {
      info: {
        channel: 0,
        audioConfig: {
          audioType: "adpcm",
          sampleRate: 16000,
          samplePrecision: 16,
          lengthPerEncoder: blockSize,
          soundTrack: "mono",
          priority: 0,
        },
        blockSize,
        fullBlockSize: blockSize + 4,
      },
      sendAudio: () => {
        const p = new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        sendPending.push(p);
        return p;
      },
      stop: async () => {},
    };

    const logger = { log: vi.fn() };
    const ch = new RtspBackchannel({
      openTalkSession: async () => stallingSession,
      logger,
      maxPcmBacklogBytes: 16_000, // ~500 ms @ 16 kHz mono
    });
    await ch.start();

    // Pump 2 s of audio while sendAudio is stuck on the first batch.
    for (let i = 0; i < 100; i++) {
      ch.feedRtp(buildRtp(0, pcmuPayload(160), i + 1, i * 160));
    }
    await new Promise((r) => setTimeout(r, 20));

    // Backlog clamp must have logged at least once.
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("PCM backlog clamped"),
    );

    // Release the stalled send so the test can finish cleanly.
    releaseSend?.();
    await Promise.all(sendPending);
  });

  it("stop() flushes the talk session and is idempotent", async () => {
    const fake = makeFakeTalk();
    const ch = new RtspBackchannel({ openTalkSession: async () => fake.session });
    await ch.start();
    await ch.stop();
    await ch.stop();
    expect(fake.stopped()).toBe(true);
    expect(ch.isActive).toBe(false);
  });

  it("disables itself on a TalkSession error and stops calling sendAudio", async () => {
    const fake = makeFakeTalk({ blockSize: 256, rejectAfter: 1 });
    const logger = { log: vi.fn() };
    const ch = new RtspBackchannel({
      openTalkSession: async () => fake.session,
      logger,
    });
    await ch.start();
    for (let i = 0; i < 60; i++) {
      ch.feedRtp(buildRtp(0, pcmuPayload(160), i + 1, i * 160));
    }
    // Yield so the pump processes the failure.
    await new Promise((r) => setTimeout(r, 20));
    expect(ch.isActive).toBe(false);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("sendAudio FAILED"),
    );
  });
});
