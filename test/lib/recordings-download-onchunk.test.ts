/**
 * cmd 5 recording download: the chunks are handed on AS THEY ARRIVE.
 *
 * ## Why this seam exists
 *
 * Every download entry point in this library returns `Promise<Buffer>`, so a
 * consumer could not begin until the last byte had landed. Downstream
 * (CamStack) that meant a clip was downloaded whole, muxed, read back and
 * base64'd before a single frame could be shown — measured 7.9 s for a 1.8 MB
 * clip through a Home Hub's shared session.
 *
 * The captured frame sequences replayed here say where that time is NOT: on a
 * standalone the last byte of a 101 s / 1.8 MB clip lands at 1 702 ms with a
 * 59 ms largest gap (`recordings-download-idle.test.ts`). The chunks were
 * always arriving early and decrypted one frame at a time; nothing exposed
 * them.
 *
 * `onChunk` is additive. These cases pin both halves of that: a caller that
 * passes one sees the bytes progressively, and the Buffer every existing
 * caller gets back is unchanged, byte for byte.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import type { BaichuanFrame } from "../../src/protocol/framing";

const FIX = join(__dirname, "..", "fixtures", "recordings");

interface CapturedFrame {
  dtMs: number;
  responseCode: number;
  msgNum: number;
  channelId: number;
  streamType: number;
  payloadLen: number;
  extensionLen: number;
}
interface Capture {
  frames: CapturedFrame[];
  bytesAssembled: number;
  lastDataAtMs: number;
  returnedAfterMs: number;
}

const firstExt = readFileSync(
  join(FIX, "standalone", "download-5-first-extension.xml"),
  "utf8",
);
const chunkExt = readFileSync(
  join(FIX, "standalone", "download-5-chunk-extension.xml"),
  "utf8",
);

function makeClient(): BaichuanClient {
  const client = new BaichuanClient({
    host: "127.0.0.1",
    port: 65535,
    username: "u",
    password: "p",
  });
  const internals = client as unknown as {
    connect: () => Promise<void>;
    writeWire: (b: Buffer) => void;
    encodeBodyXml: () => Buffer;
  };
  internals.connect = async () => undefined;
  internals.writeWire = () => undefined;
  internals.encodeBodyXml = () => Buffer.alloc(0);
  return client;
}

function frameOf(f: CapturedFrame): BaichuanFrame {
  const extension = Buffer.from(
    f.responseCode === 200 ? firstExt : chunkExt,
    "utf8",
  );
  const payload = Buffer.alloc(f.payloadLen, 0x31);
  const body = Buffer.concat([extension, payload]);
  return {
    header: {
      magic: Buffer.alloc(4),
      cmdId: 5,
      bodyLen: body.length,
      channelId: f.channelId,
      streamType: f.streamType,
      msgNum: f.msgNum,
      responseCode: f.responseCode,
      messageClass: 0,
      payloadOffset: extension.length,
    },
    body,
    extension,
    payload,
    messageKey: 0,
    raw: body,
  };
}

async function replay(
  client: BaichuanClient,
  capture: Capture,
  onChunk?: (chunk: Buffer) => void,
): Promise<{ result: Promise<Buffer>; seenAt: () => number[] }> {
  const seenAt: number[] = [];
  let clock = 0;
  const result = client.sendBinary({
    cmdId: 5,
    payloadXml: "<body/>",
    timeoutMs: 120_000,
    idleTimeoutMs: 300,
    ...(onChunk
      ? {
          onChunk: (c: Buffer) => {
            seenAt.push(clock);
            onChunk(c);
          },
        }
      : {}),
  });
  await vi.advanceTimersByTimeAsync(0);
  for (const f of capture.frames) {
    await vi.advanceTimersByTimeAsync(f.dtMs - clock);
    clock = f.dtMs;
    client.emit("frame", frameOf(f));
  }
  await vi.advanceTimersByTimeAsync(400);
  return { result, seenAt: () => seenAt };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

for (const topology of ["standalone", "hub"] as const) {
  describe(`onChunk over the captured ${topology} download`, () => {
    const capture = JSON.parse(
      readFileSync(join(FIX, topology, "download-5-frames.json"), "utf8"),
    ) as Capture;

    it("delivers the first bytes LONG before the transfer completes", async () => {
      const client = makeClient();
      const chunks: Buffer[] = [];
      const { result, seenAt } = await replay(client, capture, (c) =>
        chunks.push(c),
      );
      await result;

      expect(chunks.length).toBeGreaterThan(1);
      // The whole point: something is playable-shaped well before the end.
      const first = seenAt()[0] ?? Number.POSITIVE_INFINITY;
      expect(first).toBeLessThan(capture.lastDataAtMs);
    });

    it("hands on EVERY byte it accumulates, in order", async () => {
      // If the two ever disagree, a consumer that trusts the stream is
      // watching a different file from the one the Buffer holds.
      const client = makeClient();
      const chunks: Buffer[] = [];
      const { result } = await replay(client, capture, (c) => chunks.push(c));
      const buffer = await result;

      expect(Buffer.concat(chunks).equals(buffer)).toBe(true);
    });

    it("returns the SAME Buffer when no callback is passed", async () => {
      // The additive half. Every existing caller must be byte-for-byte
      // unaffected by the seam's existence.
      const withCb = await replay(makeClient(), capture, () => undefined);
      const without = await replay(makeClient(), capture);
      expect((await withCb.result).equals(await without.result)).toBe(true);
    });

    it("calls back nothing at all when the caller asks for nothing", async () => {
      const { result, seenAt } = await replay(makeClient(), capture);
      await result;
      expect(seenAt()).toEqual([]);
    });
  });
}

describe("a throwing consumer fails the transfer loudly", () => {
  const capture = JSON.parse(
    readFileSync(join(FIX, "standalone", "download-5-frames.json"), "utf8"),
  ) as Capture;

  it("rejects rather than returning a half-download nobody notices", async () => {
    // `onChunk` is called inside the collector's try, deliberately. A consumer
    // that throws — a full queue, a closed sink — must not leave the caller
    // holding a truncated Buffer that looks complete.
    const client = makeClient();
    const { result } = await replay(client, capture, () => {
      throw new Error("sink closed");
    });
    await expect(result).rejects.toThrow(/sink closed/);
  });
});
