/**
 * In-clip seek: cmd 123 `<ReplaySeek>`, and the two hot-path misreads that
 * hid it.
 *
 * ## What was wrong
 *
 * A Reolink camera can replay one recording from an arbitrary instant inside
 * it — the official app does it constantly (`app/data/captures/
 * cap-muchgow3-97ecb9`: 24 cmd 123 frames, one of them re-opening the SAME
 * 120 s file at +72 s, +80 s and +116 s). This library could not, and the
 * reason was not the firmware.
 *
 * Measured 2026-09-23 on an E1 Outdoor PoE (v3.1.0.5223) and an Argus 3E
 * through a Home Hub (v3.3.0.456): once a replay has been positioned, the
 * camera stamps every cmd 5 frame's `[responseCode|messageClass]` u32 with a
 * WALL-CLOCK SECOND — `0x6ab3_7cfc` = 1 790 128 892. So:
 *
 *  1. `responseCode` read 31996 on a healthy 4K stream, and the old
 *     `rc >= 400 && rc < 60_000` band threw the whole transfer away.
 *  2. `messageClass` read `0x6ab3`, which is in no allow-list, so the frame
 *     was parsed with a 20-byte header: shifted by four bytes, extension lost,
 *     `encryptLen` never read, payload left encrypted.
 *
 * Neither value is a class or a status. Both change every second.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import { decodeHeader, encodeHeader } from "../../src/protocol/framing";
import type { BaichuanFrame } from "../../src/protocol/framing";
import {
  BC_CLASS_LEGACY,
  BC_CLASS_MODERN_20,
  BC_CLASS_MODERN_24,
  BC_CLASS_MODERN_24_ALT,
  BC_CLASS_FILE_DOWNLOAD,
} from "../../src/protocol/constants";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import type { ReplaySeekOutcome } from "../../src/reolink/baichuan/utils/recordingReplay";
import {
  buildReplaySeekXml,
  readFirstIframeWallClock,
  REPLAY_SEEK_MAX_DRIFT_MS,
} from "../../src/reolink/baichuan/utils/recordingReplay";

const FIX = join(__dirname, "..", "fixtures", "recordings");

/** The stamp measured on the wire, 2026-09-23. */
const SEEKED_RESPONSE_CODE = 0x7cfc; // 31996
const SEEKED_MESSAGE_CLASS = 0x6ab3;

describe("buildReplaySeekXml", () => {
  it("reproduces the official app's cmd 123 request byte for byte", () => {
    // Captured off the Reolink app against a Home Hub child.
    const captured = readFileSync(
      join(FIX, "hub", "replayseek-123-request.xml"),
      "utf8",
    );
    const built = buildReplaySeekXml({
      channel: 0,
      seq: 1789888527,
      parts: {
        year: 2026,
        month: 9,
        day: 18,
        hour: 18,
        minute: 35,
        second: 54,
      },
    });
    expect(built).toBe(captured);
  });

  it("defaults <seq> to the current unix second, as the app does", () => {
    const built = buildReplaySeekXml({
      channel: 2,
      parts: { year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5 },
    });
    const seq = Number(/<seq>(\d+)<\/seq>/.exec(built)?.[1]);
    expect(Math.abs(seq - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    expect(built).toContain("<channelId>2</channelId>");
  });
});

describe("readFirstIframeWallClock", () => {
  /** A BcMedia I-frame header exactly as it arrives on the wire. */
  const iframe = (unixTime: number, videoType = "H264"): Buffer => {
    const b = Buffer.alloc(64);
    b.writeUInt32LE(0x63643030, 0);
    b.write(videoType, 4, "utf8");
    b.writeUInt32LE(1234, 8); // payloadSize
    b.writeUInt32LE(0x20, 12); // additionalHeaderSize
    b.writeUInt32LE(999, 16); // microseconds
    b.writeUInt32LE(0x3a, 20); // unknown
    b.writeUInt32LE(unixTime, 24); // the wall clock
    return b;
  };

  it("reads the wall clock the camera stamped, in the camera's own zone", () => {
    // Measured: a clip named `…_193129_…` answered 1790105489 on its first
    // I-frame, and that value read in UTC spells 19:31:29.
    expect(readFirstIframeWallClock(iframe(1790105489))).toEqual({
      year: 2026,
      month: 9,
      day: 22,
      hour: 19,
      minute: 31,
      second: 29,
    });
  });

  it("finds an I-frame that does not start the chunk", () => {
    const buf = Buffer.concat([Buffer.alloc(37, 0xab), iframe(1790105489)]);
    expect(readFirstIframeWallClock(buf)?.hour).toBe(19);
  });

  it("accepts H265 as well as H264", () => {
    expect(readFirstIframeWallClock(iframe(1790105489, "H265"))?.minute).toBe(
      31,
    );
  });

  it("returns undefined for a chunk with no I-frame, rather than guessing", () => {
    expect(readFirstIframeWallClock(Buffer.alloc(4096, 0x5a))).toBeUndefined();
    // A P-frame is not an I-frame: its magic is 0x6364313x.
    const p = iframe(1790105489);
    p.writeUInt32LE(0x63643130, 0);
    expect(readFirstIframeWallClock(p)).toBeUndefined();
  });

  it("rejects a magic whose videoType is not a codec we know", () => {
    const b = iframe(1790105489);
    b.write("XXXX", 4, "utf8");
    expect(readFirstIframeWallClock(b)).toBeUndefined();
  });

  it("rejects a timestamp outside any plausible epoch", () => {
    expect(readFirstIframeWallClock(iframe(12))).toBeUndefined();
  });
});

describe("header length is decided, not assumed", () => {
  /** A frame on the wire: 24-byte header written under a chosen class. */
  const wire = (messageClass: number, payloadOffset: number, bodyLen: number) => {
    const header = encodeHeader({
      cmdId: 5,
      bodyLen,
      channelId: 4,
      streamType: 0,
      msgNum: 0,
      responseCode: SEEKED_RESPONSE_CODE,
      messageClass: BC_CLASS_MODERN_24,
      payloadOffset,
    });
    // Restamp the class in place, exactly as the camera does after a seek:
    // the frame keeps its 24-byte shape, only the two bytes change.
    header.writeUInt16LE(messageClass, 18);
    return Buffer.concat([header, Buffer.alloc(bodyLen, 0x31)]);
  };

  it("reads a post-seek frame as 24 bytes even though its class is unknown", () => {
    // THE BUG: 0x6ab3 is the high half of a unix second, not a class.
    const { header, headerLen } = decodeHeader(
      wire(SEEKED_MESSAGE_CLASS, 106, 39594),
    );
    expect(headerLen).toBe(24);
    expect(header.payloadOffset).toBe(106);
    expect(header.messageClass).toBe(SEEKED_MESSAGE_CLASS);
  });

  it("keeps every known 24-byte class exactly as it was", () => {
    for (const cls of [
      BC_CLASS_MODERN_24,
      BC_CLASS_MODERN_24_ALT,
      BC_CLASS_FILE_DOWNLOAD,
    ]) {
      const { headerLen, header } = decodeHeader(wire(cls, 136, 39624));
      expect(headerLen).toBe(24);
      expect(header.payloadOffset).toBe(136);
    }
  });

  it("keeps every known 20-byte class exactly as it was, whatever bytes follow", () => {
    for (const cls of [BC_CLASS_LEGACY, BC_CLASS_MODERN_20]) {
      // Bytes 20..24 here would READ as a perfectly plausible payloadOffset.
      // A known short class must not be second-guessed by them.
      const { headerLen, header } = decodeHeader(wire(cls, 106, 39594));
      expect(headerLen).toBe(20);
      expect(header.payloadOffset).toBeUndefined();
    }
  });

  it("falls back to 20 for an unknown class whose bytes cannot be an offset", () => {
    // payloadOffset > bodyLen is not an offset into this body.
    const { headerLen } = decodeHeader(wire(0x1234, 99_999, 128));
    expect(headerLen).toBe(20);
    // ...and neither is a small integer, which is what binary payload data
    // most often looks like.
    expect(decodeHeader(wire(0x1234, 1, 128)).headerLen).toBe(20);
  });

  it("asks for four more bytes rather than guessing on a short buffer", () => {
    const short = wire(SEEKED_MESSAGE_CLASS, 106, 39594).subarray(0, 22);
    expect(() => decodeHeader(short)).toThrow(/needs 24 bytes/);
  });
});

describe("a stamped replay stream is data, not a refusal", () => {
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

  const frameOf = (o: {
    responseCode: number;
    messageClass?: number;
    extension: string;
    payloadLen: number;
    fill?: number;
  }): BaichuanFrame => {
    const extension = Buffer.from(o.extension, "utf8");
    const payload = Buffer.alloc(o.payloadLen, o.fill ?? 0x31);
    const body = Buffer.concat([extension, payload]);
    return {
      header: {
        magic: Buffer.alloc(4),
        cmdId: 5,
        bodyLen: body.length,
        channelId: 7,
        streamType: 0,
        msgNum: 0,
        responseCode: o.responseCode,
        messageClass: o.messageClass ?? 0,
        payloadOffset: extension.length,
      },
      body,
      extension,
      payload,
      messageKey: 0,
      raw: body,
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps every chunk of a seeked transfer, stamp and all", async () => {
    const client = makeClient();
    const result = client.sendBinary({
      cmdId: 5,
      payloadXml: "<body/>",
      timeoutMs: 120_000,
      idleTimeoutMs: 300,
      channelIdOverride: 7,
    });
    await vi.advanceTimersByTimeAsync(0);

    // The stream header is always a clean 200 — measured on both topologies.
    client.emit(
      "frame",
      frameOf({ responseCode: 200, extension: firstExt, payloadLen: 32 }),
    );
    // Every chunk after it carries the wall-clock stamp.
    for (let i = 0; i < 4; i++) {
      client.emit(
        "frame",
        frameOf({
          responseCode: SEEKED_RESPONSE_CODE,
          messageClass: SEEKED_MESSAGE_CLASS,
          extension: chunkExt,
          payloadLen: 1000,
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(400);

    const buf = await result;
    expect(buf.length).toBe(32 + 4 * 1000);
  });

  it("still rejects a real refusal — it arrives BEFORE any stream opens", async () => {
    const client = makeClient();
    const result = client.sendBinary({
      cmdId: 5,
      payloadXml: "<body/>",
      timeoutMs: 120_000,
      idleTimeoutMs: 300,
      channelIdOverride: 7,
    });
    // Attached before the frame is emitted: the rejection is synchronous and
    // an unhandled one is noise in every other file's run.
    const settled = result.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    client.emit(
      "frame",
      frameOf({ responseCode: 400, extension: "", payloadLen: 0 }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(String(await settled)).toMatch(
      /replay rejected .*responseCode=400/,
    );
  });

  it("does not mistake a stamped FIRST chunk for a refusal when it carries binary data", async () => {
    // Belt and braces for a firmware we have not measured (618 is on this
    // fleet and had no clips to probe): if a camera ever stamps the stream
    // header too, the `<binaryData>1</binaryData>` in its extension still
    // says this is a stream.
    const client = makeClient();
    const result = client.sendBinary({
      cmdId: 5,
      payloadXml: "<body/>",
      timeoutMs: 120_000,
      idleTimeoutMs: 300,
      channelIdOverride: 7,
    });
    await vi.advanceTimersByTimeAsync(0);
    client.emit(
      "frame",
      frameOf({
        responseCode: SEEKED_RESPONSE_CODE,
        messageClass: SEEKED_MESSAGE_CLASS,
        extension: firstExt,
        payloadLen: 64,
      }),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect((await result).length).toBe(64);
  });
});

describe("REPLAY_SEEK_MAX_DRIFT_MS", () => {
  it("is at least one measured GOP on each side", () => {
    // ~2 s on both probed devices, and they round in opposite directions.
    expect(REPLAY_SEEK_MAX_DRIFT_MS).toBeGreaterThanOrEqual(2_000);
  });
});

describe("fileInfoListReplayBinaryDownload positions every transfer", () => {
  interface BinaryCall {
    cmdId: number;
    onChunk?: (chunk: Buffer) => void;
  }
  interface XmlCall {
    cmdId: number;
    payloadXml?: string;
  }

  const CLIP =
    "/mnt/sda/Mp4Record/2026-09-22/RecM03_DST20260922_051358_051559_6732808_5B99DBE.mp4";
  /** 05:13:58 local + 40 s — inside the clip, one minute of it remaining. */
  const clipStart = new Date(2026, 8, 22, 5, 13, 58);

  function makeApi(opts: { seekFails?: boolean; chunk?: Buffer } = {}) {
    const api = new ReolinkBaichuanApi({
      host: "127.0.0.1",
      port: 65535,
      username: "u",
      password: "p",
      transport: "tcp",
      nativeOnly: true,
    });
    const xml: XmlCall[] = [];
    const client = api.client as unknown as {
      login: () => Promise<void>;
      sendBinary: (p: BinaryCall) => Promise<Buffer>;
      sendXml: (p: XmlCall) => Promise<string>;
      drainReplayFrames: () => Promise<number>;
    };
    client.login = async () => undefined;
    client.drainReplayFrames = async () => 0;
    client.sendXml = async (p: XmlCall) => {
      xml.push(p);
      if (p.cmdId === 123 && opts.seekFails) {
        throw new Error("Baichuan request failed (responseCode 400)");
      }
      return "<body/>";
    };
    client.sendBinary = async (p: BinaryCall) => {
      if (opts.chunk) p.onChunk?.(opts.chunk);
      return opts.chunk ?? Buffer.alloc(8, 1);
    };
    return { api, xml, seekOf: () => xml.find((c) => c.cmdId === 123) };
  }

  /** A decrypted chunk whose first I-frame carries `at` as its wall clock. */
  const chunkStartingAt = (at: Date): Buffer => {
    const b = Buffer.alloc(96, 0x31);
    b.writeUInt32LE(0x63643030, 0);
    b.write("H264", 4, "utf8");
    b.writeUInt32LE(32, 8);
    b.writeUInt32LE(0x20, 12);
    b.writeUInt32LE(0, 16);
    b.writeUInt32LE(0x3a, 20);
    // The camera writes its LOCAL wall clock as if it were a unix second.
    b.writeUInt32LE(
      Math.floor(
        Date.UTC(
          at.getFullYear(),
          at.getMonth(),
          at.getDate(),
          at.getHours(),
          at.getMinutes(),
          at.getSeconds(),
        ) / 1000,
      ),
      24,
    );
    return b;
  };

  it("sends a <ReplaySeek> even when the caller asked for no offset", async () => {
    // A seek is sticky for the life of the connection, so "no offset" has to
    // mean "back to the start", not "leave whatever is there".
    const h = makeApi();
    await h.api.fileInfoListReplayBinaryDownload({ channel: 0, fileName: CLIP });
    expect(h.seekOf()).toBeDefined();
    expect(h.seekOf()?.payloadXml).toContain("<hour>5</hour>");
    expect(h.seekOf()?.payloadXml).toContain("<minute>13</minute>");
    expect(h.seekOf()?.payloadXml).toContain("<second>58</second>");
  });

  it("sends the instant the caller asked for", async () => {
    const h = makeApi();
    await h.api.fileInfoListReplayBinaryDownload({
      channel: 0,
      fileName: CLIP,
      seekTo: new Date(clipStart.getTime() + 40_000),
    });
    expect(h.seekOf()?.payloadXml).toContain("<minute>14</minute>");
    expect(h.seekOf()?.payloadXml).toContain("<second>38</second>");
  });

  it("reports the DELIVERED position, not the asked one", async () => {
    // The camera rounds to a keyframe: asked +40 s, delivered +38 s here.
    const delivered = new Date(clipStart.getTime() + 38_000);
    const h = makeApi({ chunk: chunkStartingAt(delivered) });
    let outcome: ReplaySeekOutcome | undefined;
    await h.api.fileInfoListReplayBinaryDownload({
      channel: 0,
      fileName: CLIP,
      seekTo: new Date(clipStart.getTime() + 40_000),
      onSeekOutcome: (o) => {
        outcome = o;
      },
    });
    expect(outcome?.seekApplied).toBe(true);
    expect(outcome?.deliveredAt?.getTime()).toBe(delivered.getTime());
    expect(outcome?.driftMs).toBe(-2_000);
  });

  it("downloads anyway when the camera will not take a seek, and says so", async () => {
    // 618 is a firmware on this fleet we could not probe. A camera without
    // cmd 123 must still hand over the clip.
    const h = makeApi({ seekFails: true, chunk: chunkStartingAt(clipStart) });
    let outcome: ReplaySeekOutcome | undefined;
    const buf = await h.api.fileInfoListReplayBinaryDownload({
      channel: 0,
      fileName: CLIP,
      seekTo: new Date(clipStart.getTime() + 40_000),
      onSeekOutcome: (o) => {
        outcome = o;
      },
    });
    expect(buf.length).toBeGreaterThan(0);
    expect(outcome?.seekApplied).toBe(false);
    expect(outcome?.reason).toMatch(/did not accept cmd 123/);
  });

  it("says the position is unknown rather than inventing one", async () => {
    const h = makeApi({ chunk: Buffer.alloc(256, 0x5a) }); // no I-frame
    let outcome: ReplaySeekOutcome | undefined;
    await h.api.fileInfoListReplayBinaryDownload({
      channel: 0,
      fileName: CLIP,
      onSeekOutcome: (o) => {
        outcome = o;
      },
    });
    expect(outcome?.deliveredAt).toBeNull();
    expect(outcome?.driftMs).toBeNull();
    expect(outcome?.reason).toMatch(/delivered position unknown/);
  });

  it("reports the outcome even when the consumer abandons the transfer", async () => {
    const h = makeApi({ chunk: chunkStartingAt(clipStart) });
    let outcome: ReplaySeekOutcome | undefined;
    await expect(
      h.api.fileInfoListReplayBinaryDownload({
        channel: 0,
        fileName: CLIP,
        onChunk: () => {
          throw new Error("sink closed");
        },
        onSeekOutcome: (o) => {
          outcome = o;
        },
      }),
    ).rejects.toThrow(/sink closed/);
    // The position was read off the bytes BEFORE the consumer saw them.
    expect(outcome?.deliveredAt?.getTime()).toBe(clipStart.getTime());
  });
});
