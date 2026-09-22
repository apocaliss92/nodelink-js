/**
 * cmd 5 recording download: completion is an idle window, and it is
 * configurable.
 *
 * Measured 2026-09-20 on an E1 Outdoor PoE (v3.1.0.5223) and a Home Hub
 * (v3.3.0.456): the stream header comes with responseCode 200, every chunk
 * with 0, never 201; no trailing frame of any cmdId; the last byte of a
 * 101 s / 1.8 MB clip landed at 1 702 ms with a 59 ms largest gap — and the
 * fixed 15 s idle window then made every download cost ~15 s. The captured
 * frame sequence (`download-5-frames.json`) is replayed here against a
 * client with no socket.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import { DEFAULT_RECORDING_DOWNLOAD_IDLE_MS } from "../../src/protocol/constants";
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

function frameOf(
  f: CapturedFrame,
  overrides: Partial<CapturedFrame> = {},
): BaichuanFrame {
  const h = { ...f, ...overrides };
  const extension = Buffer.from(
    h.responseCode === 200 ? firstExt : chunkExt,
    "utf8",
  );
  // 0x31 = "1": the real first payload starts with the ASCII stream magic
  // "1002"; never "<", so it is not mistaken for XML.
  const payload = Buffer.alloc(h.payloadLen, 0x31);
  const body = Buffer.concat([extension, payload]);
  return {
    header: {
      magic: Buffer.alloc(4),
      cmdId: 5,
      bodyLen: body.length,
      channelId: h.channelId,
      streamType: h.streamType,
      msgNum: h.msgNum,
      responseCode: h.responseCode,
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
  opts: { idleTimeoutMs?: number },
): Promise<{ settled: () => boolean; result: Promise<Buffer> }> {
  let done = false;
  const result = client
    .sendBinary({
      cmdId: 5,
      payloadXml: "<body/>",
      timeoutMs: 120_000,
      ...opts,
    })
    .then((b) => {
      done = true;
      return b;
    });
  await vi.advanceTimersByTimeAsync(0);
  let clock = 0;
  for (const f of capture.frames) {
    await vi.advanceTimersByTimeAsync(f.dtMs - clock);
    clock = f.dtMs;
    client.emit("frame", frameOf(f));
  }
  return { settled: () => done, result };
}

afterEach(() => {
  vi.useRealTimers();
});

for (const topology of ["standalone", "hub"] as const) {
  describe(`replaying the captured ${topology} download`, () => {
    const capture = JSON.parse(
      readFileSync(join(FIX, topology, "download-5-frames.json"), "utf8"),
    ) as Capture;

    it("assembles every chunk (stream header included) and completes after the idle window, not 15 s", async () => {
      vi.useFakeTimers();
      const client = makeClient();
      const { settled, result } = await replay(client, capture, {
        idleTimeoutMs: 2_000,
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled()).toBe(true);
      const buf = await result;
      expect(buf.length).toBe(capture.bytesAssembled);
      // The capture itself documents the cost this fixes.
      expect(capture.returnedAfterMs - capture.lastDataAtMs).toBeGreaterThan(
        14_000,
      );
    });

    it("the default idle window is DEFAULT_RECORDING_DOWNLOAD_IDLE_MS", async () => {
      vi.useFakeTimers();
      const client = makeClient();
      const { settled } = await replay(client, capture, {});
      await vi.advanceTimersByTimeAsync(DEFAULT_RECORDING_DOWNLOAD_IDLE_MS - 1);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled()).toBe(true);
    });
  });
}

describe("end-of-stream rules that still apply", () => {
  it("DEFAULT_RECORDING_DOWNLOAD_IDLE_MS is 2 000 ms — ~34x the largest measured inter-chunk gap", () => {
    expect(DEFAULT_RECORDING_DOWNLOAD_IDLE_MS).toBe(2_000);
  });

  it("a responseCode 201 chunk finishes immediately, before any idle window", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const capture = JSON.parse(
      readFileSync(join(FIX, "standalone", "download-5-frames.json"), "utf8"),
    ) as Capture;
    const three = { ...capture, frames: capture.frames.slice(0, 3) };
    const { settled, result } = await replay(client, three, {
      idleTimeoutMs: 60_000,
    });
    expect(settled()).toBe(false);
    client.emit("frame", frameOf(capture.frames[3]!, { responseCode: 201 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled()).toBe(true);
    const buf = await result;
    expect(buf.length).toBe(
      three.frames.reduce((n, f) => n + f.payloadLen, 0) +
        capture.frames[3]!.payloadLen,
    );
  });
});
