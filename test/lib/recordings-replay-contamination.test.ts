/**
 * A cmd 5 replay must never be handed another transfer's frames.
 *
 * ## The defect
 *
 * A consumer opened a cmd 5 replay, the peer closed it after 236 ms, and a
 * second replay on the SAME host was opened 1 ms later. The second transfer
 * was handed the first one's in-flight frames: against a clean run of the same
 * file it came back with +5 access units, +5 audio frames and a duration short
 * by 3.69 s — exactly where the first transfer had stopped. Downstream, the
 * frame-rate probe read five timestamps at ~3.6 s and then eleven from zero,
 * got a negative span, and could not measure the rate.
 *
 * ## Why it was possible, measured rather than assumed
 *
 * `msgNum` is **0 on every cmd 5 frame in both directions** — Reolink app
 * capture 2026-09-22, 5 937 cmd 5 frames on a standalone, and the 2026-09-20
 * captures through a hub. It discriminates nothing and the app never uses it
 * that way. What the app DOES use is the header channelId: a fresh, strictly
 * increasing session handle per replay (40, 47, 53, 56, 61, … standalone;
 * 105, 111, 124, 142, 163, 170 through a hub), echoed by the camera on the
 * reply and on every binary chunk.
 *
 * This library pinned that channelId on the hub/NVR download path, and then
 * locked its listener on whatever the FIRST frame it saw happened to carry.
 * Reproduced live against a mains standalone (192.168.50.226, 303 s clip),
 * opening a replay, abandoning it, and opening another 1 ms later:
 *
 *   pinned channelId=82 — 9 511 frames in the second transfer's window, all on
 *     channelId 82, its predecessor's tail among them, indistinguishable.
 *   minted channelId    — the second transfer locked onto its predecessor's
 *     243 residue frames and then REJECTED all 4 237 of its own, returning
 *     477 016 bytes of the wrong clip.
 *
 * Both arms are the same root cause: the listener locked on the first frame it
 * saw instead of on the one it had asked for.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import type { BaichuanFrame } from "../../src/protocol/framing";
import { buildReplayStopNameFromFileName } from "../../src/reolink/baichuan/utils/recordingReplay";

const CMD_REPLAY = 5;

interface Emitted {
  channelId: number;
  responseCode: number;
  fill: number;
  payloadLen: number;
}

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

function frameOf(e: Emitted): BaichuanFrame {
  const extension = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" ?>\n<Extension version="1.1">\n<binaryData>1</binaryData>\n</Extension>\n',
    "utf8",
  );
  const payload = Buffer.alloc(e.payloadLen, e.fill);
  const body = Buffer.concat([extension, payload]);
  return {
    header: {
      magic: Buffer.alloc(4),
      cmdId: CMD_REPLAY,
      bodyLen: body.length,
      channelId: e.channelId,
      streamType: 0,
      msgNum: 0, // measured: always 0, on every cmd 5 frame the camera sends
      responseCode: e.responseCode,
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

/** Start a replay transfer and report the header channelId it minted. */
function startTransfer(
  client: BaichuanClient,
  options: {
    onChunk?: (chunk: Buffer) => void;
    channelIdOverride?: number;
  },
): { mintedChannelId: number; result: Promise<Buffer> } {
  // `sendBinaryFileInfoListReplay5` mints with `nextMsgNum()`; peeking the
  // counter here tells the test which handle this transfer will carry.
  const mintedChannelId =
    options.channelIdOverride ?? (client.peekNextMsgNum() as number);
  const result = client.sendBinary({
    cmdId: CMD_REPLAY,
    payloadXml: "<body/>",
    timeoutMs: 120_000,
    idleTimeoutMs: 500,
    ...(options.channelIdOverride != null
      ? { channelIdOverride: options.channelIdOverride }
      : {}),
    ...(options.onChunk ? { onChunk: options.onChunk } : {}),
  });
  result.catch(() => undefined);
  return { mintedChannelId, result };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a superseded cmd 5 replay does not contaminate its successor", () => {
  it("rejects the abandoned transfer's in-flight frames and counts them", async () => {
    const client = makeClient();
    const warnings: string[] = [];
    (
      client as unknown as { logger: { warn: (m: string) => void } }
    ).logger.warn = (m: string) => warnings.push(m);

    // --- Transfer A: opened, fed, then abandoned by a throwing onChunk.
    let aChunks = 0;
    const a = startTransfer(client, {
      onChunk: () => {
        aChunks++;
        if (aChunks >= 3) throw new Error("consumer abandoned transfer A");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) {
      client.emit(
        "frame",
        frameOf({
          channelId: a.mintedChannelId,
          responseCode: i === 0 ? 200 : 0,
          fill: 0xaa,
          payloadLen: 64,
        }),
      );
    }
    await expect(a.result).rejects.toThrow(/abandoned transfer A/);

    // --- Transfer B: opened 1 ms later on the same socket, as in the field.
    await vi.advanceTimersByTimeAsync(1);
    const bChunks: Buffer[] = [];
    const b = startTransfer(client, { onChunk: (c) => bChunks.push(c) });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.mintedChannelId).not.toBe(a.mintedChannelId);

    // The camera is still sending A's clip (measured: 8 126 further frames over
    // 3 475 ms when nothing stops it). Interleave that tail with B's own data.
    for (let i = 0; i < 6; i++) {
      client.emit(
        "frame",
        frameOf({
          channelId: a.mintedChannelId,
          responseCode: 0,
          fill: 0xaa,
          payloadLen: 64,
        }),
      );
      client.emit(
        "frame",
        frameOf({
          channelId: b.mintedChannelId,
          responseCode: i === 0 ? 200 : 0,
          fill: 0xbb,
          payloadLen: 64,
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(600);
    const buf = await b.result;

    // B carries its own clip and nothing else: 6 frames x 64 bytes of 0xbb.
    expect(bChunks).toHaveLength(6);
    expect(buf.length).toBe(6 * 64);
    expect(buf.includes(0xaa)).toBe(false);
    expect([...new Set(buf)]).toEqual([0xbb]);

    // And the discard is observable, with a count.
    expect(
      warnings.some((w) => /dropping frames \(foreign-channel\)/.test(w)),
    ).toBe(true);
  });

  it("a transfer that only ever sees another session's frames fails naming them", async () => {
    const client = makeClient();
    const b = startTransfer(client, {});
    await vi.advanceTimersByTimeAsync(0);
    const foreign = b.mintedChannelId + 77;
    for (let i = 0; i < 5; i++) {
      client.emit(
        "frame",
        frameOf({
          channelId: foreign,
          responseCode: i === 0 ? 200 : 0,
          fill: 0xaa,
          payloadLen: 64,
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(120_001);
    // Not silence, and not a wrong clip: an error that names what did arrive.
    await expect(b.result).rejects.toThrow(
      new RegExp(`rejected 5 cmd 5 frame\\(s\\) on channelId ${foreign}`),
    );
  });

  it("a superseded transfer stops accepting frames even on its own channelId", async () => {
    // The pinned case: two transfers can carry the SAME header channelId, so
    // the wire cannot tell them apart. Supersession still can.
    const client = makeClient();
    const aChunks: Buffer[] = [];
    const a = startTransfer(client, {
      channelIdOverride: 82,
      onChunk: (c) => aChunks.push(c),
    });
    await vi.advanceTimersByTimeAsync(0);
    client.emit(
      "frame",
      frameOf({ channelId: 82, responseCode: 200, fill: 0xaa, payloadLen: 64 }),
    );
    expect(aChunks).toHaveLength(1);

    const b = startTransfer(client, { channelIdOverride: 82 });
    await vi.advanceTimersByTimeAsync(0);
    // A is superseded: this frame must not reach it.
    client.emit(
      "frame",
      frameOf({ channelId: 82, responseCode: 0, fill: 0xaa, payloadLen: 64 }),
    );
    expect(aChunks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600);
    await expect(a.result).resolves.toHaveLength(64);
    await b.result.catch(() => undefined);
  });

  it("FAILS a transfer superseded before its first byte, instead of hanging", async () => {
    // The regression this file's own fix introduced, measured on the live
    // fleet 2026-09-23: a superseded session refuses every frame, and the
    // idle timer only ever completes a transfer that already had chunks — so
    // a session superseded before its first byte could no longer settle by
    // ANY path. Nothing was logged and nothing threw; the caller simply
    // waited. Downstream that wedged every later read of the same clip,
    // because in-flight fetches are deduplicated per clip and each new one
    // was handed the same dead promise.
    const client = makeClient();
    const a = startTransfer(client, { channelIdOverride: 82 });
    await vi.advanceTimersByTimeAsync(50);

    // A has seen NOTHING when its successor opens.
    const b = startTransfer(client, { channelIdOverride: 82 });
    await vi.advanceTimersByTimeAsync(0);

    await expect(a.result).rejects.toThrow(/superseded by a later transfer/);
    // B is left in flight on purpose: under fake timers it settles only when
    // its own 120 s budget is advanced, and awaiting it here would hang the
    // test for a reason that has nothing to do with what it pins.
    void b.result.catch(() => undefined);
  });

  it("does not wait for the idle window to say so", async () => {
    // Promptness is the point: the caller is a player with a person in front
    // of it. Settled with NO timer advanced at all.
    const client = makeClient();
    const a = startTransfer(client, { channelIdOverride: 82 });
    await vi.advanceTimersByTimeAsync(0);
    startTransfer(client, { channelIdOverride: 82 });
    let settled = false;
    void a.result.catch(() => {
      settled = true;
    });
    // No timer advanced — only microtasks drained. The rejection crosses two
    // awaits (the inner promise, then `sendBinary`), so it needs a couple of
    // turns, and NOT the 500 ms idle window the old path depended on.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});

describe("the stop names the channel, not a constant 01", () => {
  it("prefixes the two-digit 1-based channel", () => {
    // Measured, Reolink app capture 2026-09-20 through a hub: the first child
    // (XML <channelId>0</channelId>) is stopped with 01…, the second
    // (<channelId>1</channelId>, "Videocamera porta retro") with 02….
    const file =
      "/mnt/sda/U10952700093ABW14UB-Videocamera porta retro/Mp4Record/2026-09-18/RecS04_DST20260918_181308_181323_0_380_200_033C8000000000_15D980.mp4";
    expect(buildReplayStopNameFromFileName(file, 1)).toBe("0220260918181308");
    expect(buildReplayStopNameFromFileName(file, 0)).toBe("0120260918181308");
    // Default stays what every existing caller got.
    expect(buildReplayStopNameFromFileName(file)).toBe("0120260918181308");
    // An already-shaped name is kept as-is.
    expect(buildReplayStopNameFromFileName("0220260918181308", 0)).toBe(
      "0220260918181308",
    );
  });
});

describe("drainReplayFrames waits for the camera, not for the ack", () => {
  it("returns once cmd 5 frames have stopped, counting what arrived", async () => {
    const client = makeClient();
    const drain = client.drainReplayFrames({ quietMs: 200, maxMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) {
      client.emit(
        "frame",
        frameOf({ channelId: 9, responseCode: 0, fill: 0xaa, payloadLen: 8 }),
      );
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(250);
    await expect(drain).resolves.toBe(4);
  });

  it("is bounded when the camera never goes quiet", async () => {
    const client = makeClient();
    const drain = client.drainReplayFrames({ quietMs: 200, maxMs: 600 });
    await vi.advanceTimersByTimeAsync(0);
    const pump = setInterval(() => {
      client.emit(
        "frame",
        frameOf({ channelId: 9, responseCode: 0, fill: 0xaa, payloadLen: 8 }),
      );
    }, 50);
    await vi.advanceTimersByTimeAsync(700);
    clearInterval(pump);
    await expect(drain).resolves.toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The download path: the session is ended at the CAMERA, and the header
// channelId is minted rather than pinned to the hub's channel.
// ---------------------------------------------------------------------------

import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

interface BinaryCall {
  cmdId: number;
  channelIdOverride?: number;
  onChunk?: (chunk: Buffer) => void;
}
interface XmlCall {
  cmdId: number;
  payloadXml?: string;
}

function makeApi(): {
  api: ReolinkBaichuanApi;
  binary: BinaryCall[];
  xml: XmlCall[];
  drains: number;
  setBinary: (fn: (p: BinaryCall) => Promise<Buffer>) => void;
  order: string[];
} {
  const api = new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535,
    username: "u",
    password: "p",
    transport: "tcp",
    nativeOnly: true,
  });
  const binary: BinaryCall[] = [];
  const xml: XmlCall[] = [];
  const order: string[] = [];
  const state = { drains: 0 };
  let binaryImpl: (p: BinaryCall) => Promise<Buffer> = async () =>
    Buffer.alloc(8, 1);

  const client = api.client as unknown as {
    login: () => Promise<void>;
    sendBinary: (p: BinaryCall) => Promise<Buffer>;
    sendXml: (p: XmlCall) => Promise<string>;
    drainReplayFrames: () => Promise<number>;
  };
  client.login = async () => undefined;
  client.sendBinary = async (p: BinaryCall) => {
    binary.push(p);
    order.push(`binary:${p.cmdId}`);
    return binaryImpl(p);
  };
  client.sendXml = async (p: XmlCall) => {
    xml.push(p);
    order.push(`xml:${p.cmdId}`);
    return "<body/>";
  };
  client.drainReplayFrames = async () => {
    state.drains++;
    order.push("drain");
    return 0;
  };
  return {
    api,
    binary,
    xml,
    get drains() {
      return state.drains;
    },
    setBinary: (fn) => {
      binaryImpl = fn;
    },
    order,
  };
}

const CLIP =
  "/mnt/sda/Mp4Record/2026-09-22/RecM03_DST20260922_051358_051559_6732808_5B99DBE.mp4";

describe("fileInfoListReplayBinaryDownload ends the session at the camera", () => {
  it("does not pin the header channelId, on a HUB child either", async () => {
    const h = makeApi();
    // Force the NVR/hub branch: this is the one that used to pin the header
    // channelId (`headerChannelIdOverride ?? 82`) and so left two transfers on
    // one socket carrying the same session handle.
    const internals = h.api as unknown as {
      resolveHeaderChannelIdForLogicalChannel: (c: number) => number | null;
      ensureUidForRecordings: (c: number, u?: string) => Promise<string>;
    };
    internals.resolveHeaderChannelIdForLogicalChannel = () => 1;
    internals.ensureUidForRecordings = async () => "UID";
    await h.api.fileInfoListReplayBinaryDownload({ channel: 1, fileName: CLIP });
    expect(h.binary).toHaveLength(1);
    // Measured: the Reolink app mints a fresh handle for every replay, hub
    // children included (105, 111, 124, 142, 163, 170 — all rc=200 with data).
    expect(h.binary[0]?.channelIdOverride).toBeUndefined();
  });

  it("sends the cmd 7 stop after a completed transfer, and does NOT pay for a drain", async () => {
    const h = makeApi();
    await h.api.fileInfoListReplayBinaryDownload({ channel: 0, fileName: CLIP });
    const stop = h.xml.find((c) => c.cmdId === 7);
    expect(stop).toBeDefined();
    expect(stop?.payloadXml).toContain("<name>0120260922051358</name>");
    // A completed transfer went quiet for a whole idle window to finish, so
    // there is nothing to drain; waiting would be latency on the common path.
    expect(h.drains).toBe(0);
    // The cmd 123 ahead of the replay is new in 0.11.0 and is the point of
    // it: a `<ReplaySeek>` is STICKY for the life of the connection, so a
    // download that asked for no offset must still RESET the position or it
    // inherits whoever seeked last and comes back silently short. Pinned by
    // content as well as by order — a reset that pointed somewhere else would
    // be worse than no reset at all.
    expect(h.order).toEqual(["xml:123", "binary:5", "xml:7"]);
    const seek = h.xml.find((c) => c.cmdId === 123);
    expect(seek?.payloadXml).toContain("<ReplaySeek version=\"1.1\">");
    // The clip's OWN start, out of its file name: …_20260922_051358_…
    expect(seek?.payloadXml).toContain("<hour>5</hour>");
    expect(seek?.payloadXml).toContain("<minute>13</minute>");
    expect(seek?.payloadXml).toContain("<second>58</second>");
  });

  it("sends the cmd 7 stop when the consumer ABANDONS the transfer", async () => {
    // This is the case that produced the defect: throwing from onChunk failed
    // the transfer locally while the camera kept sending.
    const h = makeApi();
    h.setBinary(async (p) => {
      p.onChunk?.(Buffer.alloc(4, 7));
      throw new Error("consumer abandoned transfer");
    });
    await expect(
      h.api.fileInfoListReplayBinaryDownload({
        channel: 0,
        fileName: CLIP,
        onChunk: () => {
          throw new Error("consumer abandoned transfer");
        },
      }),
    ).rejects.toThrow(/abandoned/);
    expect(h.xml.some((c) => c.cmdId === 7)).toBe(true);
    expect(h.drains).toBe(1);
  });

  it("names the channel in the stop for a hub child", async () => {
    const h = makeApi();
    const child =
      "/mnt/sda/U10952700093ABW14UB-Videocamera porta retro/Mp4Record/2026-09-18/RecS04_DST20260918_181308_181323_0_380_200_033C8000000000_15D980.mp4";
    await h.api.fileInfoListReplayBinaryDownload({ channel: 1, fileName: child });
    const stop = h.xml.find((c) => c.cmdId === 7);
    expect(stop?.payloadXml).toContain("<name>0220260918181308</name>");
  });
});
