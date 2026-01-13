#!/usr/bin/env node
/**
 * Unit-ish test: CoverPreview (cmd_id=298) payload parser.
 *
 * No device required.
 */

// @ts-expect-error - Path resolution at runtime
import { BaichuanClient, parseRecordingFileName } from "../../index.js";
// @ts-expect-error - Path resolution at runtime
import { encodeReolinkEventIdV1, decodeReolinkEventIdV1, isReolinkEventIdV1 } from "../../index.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function buildFakeCoverPreviewPayload(): { payload: Buffer; expectedFrame: Buffer } {
  // 32-byte stream header
  const header = Buffer.alloc(32, 0);
  header.write("1001", 0, "ascii");
  u32le(1920).copy(header, 8);
  u32le(1080).copy(header, 12);
  header[17] = 25; // fps

  // Frame header: magic + encoding + frameLen + additionalHeaderLen + microsecond + padding + frameTime
  const frameMagic = Buffer.from("00dc", "ascii");
  const encoding = Buffer.from("H264", "ascii");

  const frame = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84]); // fake Annex-B IDR-ish
  const frameLen = frame.length;

  const additionalHeaderLen = 4; // so headerLen = 28 and frameTime is present
  const frameHeader = Buffer.alloc(24 + additionalHeaderLen, 0);
  frameMagic.copy(frameHeader, 0);
  encoding.copy(frameHeader, 4);
  u32le(frameLen).copy(frameHeader, 8);
  u32le(additionalHeaderLen).copy(frameHeader, 12);
  u32le(123_456).copy(frameHeader, 16); // microsecond (not used)
  u32le(1_700_000_000).copy(frameHeader, 24); // frameTime

  const padding = Buffer.from([0xaa, 0xbb, 0xcc]);
  const payload = Buffer.concat([header, padding, frameHeader, frame]);
  return { payload, expectedFrame: frame };
}

async function main(): Promise<void> {
  // Also validate numeric event id parsing (channel + timestamp).
  const numeric = parseRecordingFileName("0120260107000000");
  assert(!!numeric, "numeric parse should succeed");
  assert(numeric!.channel === 1, `numeric channel should be 1, got ${numeric!.channel}`);

  // Validate eventId v1 roundtrip.
  const eid = encodeReolinkEventIdV1({
    kind: "nvrAlarm",
    channel: 1,
    fileName: "0120260107000000",
    startTimeMs: numeric!.start.getTime(),
    endTimeMs: numeric!.end.getTime(),
  });
  assert(isReolinkEventIdV1(eid), "isReolinkEventIdV1 should be true");
  const decoded = decodeReolinkEventIdV1(eid);
  assert(decoded.kind === "nvrAlarm", "decoded kind should be nvrAlarm");
  assert(decoded.channel === 1, `decoded channel should be 1, got ${decoded.channel}`);
  assert(decoded.fileName === "0120260107000000", "decoded fileName mismatch");
  assert(decoded.startTimeMs === numeric!.start.getTime(), "decoded startTimeMs mismatch");
  assert(decoded.endTimeMs === numeric!.end.getTime(), "decoded endTimeMs mismatch");

  const { payload, expectedFrame } = buildFakeCoverPreviewPayload();
  const res = BaichuanClient.parseCoverPreviewPayload(payload);

  assert(res.encoding === "H264", `encoding should be H264, got ${res.encoding}`);
  assert(res.frameLength === expectedFrame.length, `frameLength mismatch (${res.frameLength} vs ${expectedFrame.length})`);
  assert(res.frame.equals(expectedFrame), "frame bytes mismatch");
  assert(res.streamInfo.width === 1920, `width mismatch (${res.streamInfo.width})`);
  assert(res.streamInfo.height === 1080, `height mismatch (${res.streamInfo.height})`);
  assert(res.streamInfo.frameRate === 25, `frameRate mismatch (${res.streamInfo.frameRate})`);
  assert(res.frameTime === 1_700_000_000, `frameTime mismatch (${res.frameTime})`);

  console.log("OK: CoverPreview payload parser");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
