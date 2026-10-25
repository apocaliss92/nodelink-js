import { afterEach, describe, expect, it, vi } from "vitest";
import { Rfc4571Muxer, type VideoType } from "../../src/rfc/rfc4571";
import {
  Rfc4571SocketFixture,
  rtpPacketFixture,
  videoAccessUnitFixture,
} from "../fixtures/rfc4571-backpressure";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const muxers: Rfc4571Muxer[] = [];

function setup() {
  const logger = { ...console, warn: vi.fn() };
  const muxer = new Rfc4571Muxer(logger, 96, 97);
  muxers.push(muxer);
  return { logger, muxer };
}

afterEach(() => {
  for (const muxer of muxers) muxer.close();
  muxers.length = 0;
});

describe("RFC4571 slow-consumer isolation", () => {
  it.each<VideoType>(["H264", "H265"])(
    "bounds a stalled %s consumer without interrupting a healthy client",
    (videoType) => {
      const { logger, muxer } = setup();
      const stalled = new Rfc4571SocketFixture(true);
      const healthy = new Rfc4571SocketFixture();
      muxer.addClient(stalled);
      muxer.addClient(healthy);
      const frame = videoAccessUnitFixture(videoType);

      for (let i = 0; i < 80; i++) {
        muxer.sendVideoAccessUnit(videoType, frame, true, i * 40_000);
        expect(stalled.writableLength).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
      }

      expect(stalled.destroyed).toBe(true);
      expect(stalled.peakBufferedBytes).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn.mock.calls[0]?.[0]).toMatch(/rfc4571.*backpressure/i);
      expect(healthy.destroyed).toBe(false);
      expect(healthy.writableLength).toBe(0);
      expect(
        healthy.packets.reduce((total, packet) => total + packet.length, 0),
      ).toBeGreaterThan(MAX_BUFFERED_BYTES);
      expect(
        healthy.packets.filter((packet) => (packet[3]! & 0x80) !== 0),
      ).toHaveLength(80);
      for (const packet of healthy.packets) {
        expect(packet.readUInt16BE(0)).toBe(packet.length - 2);
      }

      const reconstructed = [Buffer.from([0, 0, 0, 1])];
      for (const packet of healthy.packets) {
        const payload = packet.subarray(14);
        const fragmentHeader = payload[videoType === "H264" ? 1 : 2]!;
        if ((fragmentHeader & 0x80) !== 0) {
          reconstructed.push(
            videoType === "H264"
              ? Buffer.from([(payload[0]! & 0xe0) | (fragmentHeader & 0x1f)])
              : Buffer.from([
                  (payload[0]! & 0x81) | ((fragmentHeader & 0x3f) << 1),
                  payload[1]!,
                ]),
          );
        }
        reconstructed.push(payload.subarray(videoType === "H264" ? 2 : 3));
        if ((packet[3]! & 0x80) !== 0) break;
      }
      expect(Buffer.concat(reconstructed)).toEqual(frame);
    },
  );

  it("tolerates a fragmented keyframe exceeding the Writable high-water mark", () => {
    const { logger, muxer } = setup();
    const socket = new Rfc4571SocketFixture(true);
    muxer.addClient(socket);
    muxer.sendVideoAccessUnit("H264", videoAccessUnitFixture("H264"), true, 0);

    expect(socket.writableNeedDrain).toBe(true);
    expect(socket.writableLength).toBeGreaterThan(socket.writableHighWaterMark);
    expect(socket.destroyed).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();

    socket.resumeWrites();
    expect(socket.writableLength).toBe(0);
    muxer.sendVideoAccessUnit(
      "H264",
      videoAccessUnitFixture("H264", false, 4096),
      false,
      40_000,
    );
    expect(socket.destroyed).toBe(false);
    expect(
      socket.packets.filter((packet) => (packet[3]! & 0x80) !== 0),
    ).toHaveLength(2);
  });

  it("allows exactly the cap, then disconnects before another packet exceeds it", () => {
    const { logger, muxer } = setup();
    const socket = new Rfc4571SocketFixture(true);
    const packet = rtpPacketFixture();
    socket.write(Buffer.alloc(MAX_BUFFERED_BYTES - packet.length - 2));
    muxer.addClient(socket);

    muxer.sendVideoRtpPacket("H264", packet);
    expect(socket.writableLength).toBe(MAX_BUFFERED_BYTES);
    expect(socket.destroyed).toBe(false);

    muxer.sendAudioRtpPacket(packet);
    expect(socket.destroyed).toBe(true);
    expect(socket.peakBufferedBytes).toBe(MAX_BUFFERED_BYTES);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  const audioFrame = Buffer.alloc(4096, 0x55);
  const adtsFrame = Buffer.concat([
    Buffer.from([0xff, 0xf1, 0x6c, 0x42, 0x00, 0xff, 0xfc]),
    audioFrame,
  ]);
  const audioSenders = [
    {
      name: "raw AAC",
      send: (muxer: Rfc4571Muxer) => muxer.sendAudioAacRawFrame(audioFrame),
    },
    {
      name: "ADTS AAC",
      send: (muxer: Rfc4571Muxer) => muxer.sendAudioAdtsFrame(adtsFrame),
    },
    {
      name: "passthrough audio RTP",
      send: (muxer: Rfc4571Muxer) =>
        muxer.sendAudioRtpPacket(rtpPacketFixture(0x55, 4096)),
    },
  ];

  it.each(audioSenders)("bounds buffering for $name", ({ send }) => {
    const { logger, muxer } = setup();
    const stalled = new Rfc4571SocketFixture(true);
    const healthy = new Rfc4571SocketFixture();
    muxer.addClient(stalled);
    muxer.addClient(healthy);
    muxer.sendVideoRtpPacket("H264", rtpPacketFixture());

    for (let i = 0; i < 2200; i++) {
      send(muxer);
      expect(stalled.writableLength).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    }

    expect(stalled.destroyed).toBe(true);
    expect(stalled.peakBufferedBytes).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    expect(healthy.destroyed).toBe(false);
    expect(healthy.packets).toHaveLength(2201);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it.each<VideoType>(["H264", "H265"])(
    "gates a replacement %s client until the next keyframe",
    (videoType) => {
      const { muxer } = setup();
      const stalled = new Rfc4571SocketFixture(true);
      muxer.addClient(stalled);
      stalled.write(Buffer.alloc(MAX_BUFFERED_BYTES));
      muxer.sendVideoAccessUnit(
        videoType,
        videoAccessUnitFixture(videoType),
        true,
        0,
      );
      expect(stalled.destroyed).toBe(true);

      const replacement = new Rfc4571SocketFixture();
      muxer.addClient(replacement);
      muxer.sendVideoAccessUnit(
        videoType,
        videoAccessUnitFixture(videoType, false, 4096),
        false,
        40_000,
      );
      muxer.sendAudioAacRawFrame(audioFrame);
      expect(replacement.packets).toHaveLength(0);

      muxer.sendVideoAccessUnit(
        videoType,
        videoAccessUnitFixture(videoType),
        true,
        80_000,
      );
      muxer.sendAudioAacRawFrame(audioFrame);
      expect(replacement.packets.length).toBeGreaterThan(1);
      expect(replacement.destroyed).toBe(false);
    },
  );
});
