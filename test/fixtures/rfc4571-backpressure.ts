import { Socket } from "node:net";
import type { VideoType } from "../../src/rfc/rfc4571";

type WriteCallback = (error?: Error | null) => void;

/** Real Writable accounting, with a controllable simulated network write. */
export class Rfc4571SocketFixture extends Socket {
  readonly packets: Buffer[] = [];
  peakBufferedBytes = 0;
  private pendingWrite: WriteCallback | undefined;

  constructor(private blocked = false) {
    super();
  }

  override write(chunk: Uint8Array | string, callback?: WriteCallback): boolean;
  override write(
    chunk: Uint8Array | string,
    encoding?: BufferEncoding,
    callback?: WriteCallback,
  ): boolean;
  override write(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    const ready =
      typeof encodingOrCallback === "function"
        ? super.write(chunk, encodingOrCallback)
        : super.write(chunk, encodingOrCallback, callback);
    this.peakBufferedBytes = Math.max(
      this.peakBufferedBytes,
      this.writableLength,
    );
    return ready;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: WriteCallback,
  ): void {
    this.acceptWrites([chunk], callback);
  }

  override _writev(
    chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>,
    callback: WriteCallback,
  ): void {
    this.acceptWrites(chunks.map(({ chunk }) => chunk), callback);
  }

  private acceptWrites(chunks: Buffer[], callback: WriteCallback): void {
    this.packets.push(...chunks);
    if (this.blocked) {
      this.pendingWrite = callback;
    } else {
      callback();
    }
  }

  resumeWrites(): void {
    this.blocked = false;
    const callback = this.pendingWrite;
    this.pendingWrite = undefined;
    callback?.();
  }
}

/** Synthetic NALs exercise fragmentation, not video decoding. */
export function videoAccessUnitFixture(
  videoType: VideoType,
  keyframe = true,
  bytes = 160 * 1024,
): Buffer {
  const frame = Buffer.alloc(bytes, 0x55);
  frame.set([0, 0, 0, 1]);
  if (videoType === "H264") {
    frame[4] = keyframe ? 0x65 : 0x41;
  } else {
    frame[4] = keyframe ? 0x26 : 0x02;
    frame[5] = 0x01;
  }
  return frame;
}

export function rtpPacketFixture(nalHeader = 0x65, bytes = 1200): Buffer {
  const packet = Buffer.alloc(bytes, 0x55);
  packet[0] = 0x80;
  packet[1] = 96;
  packet[12] = nalHeader;
  return packet;
}
