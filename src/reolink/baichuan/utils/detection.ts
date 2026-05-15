/**
 * Decoder for the BcMedia `additionalHeader` block carried by every I-frame
 * and P-frame on cmd_id=3 video streams. Extracts Reolink "AI Mark" detection
 * boxes (the rectangles the official app draws around detected objects) AND
 * their class label (people / vehicle / animal / face).
 *
 * Wire layout (reverse-engineered from the macOS Reolink app's
 * `libBCSDKWrapper.dylib` AIDataParser symbols, validated against
 * `pcap/all-traffic.pcapng` and a live DYLD_INSERT_LIBRARIES hook of the SDK
 * + a static dump of the SDK's `s_tlv_types_map` BSS structure):
 *
 *   [outer 8-byte iframe prefix, I-frames only]
 *   [TLV: type=0xff len=N value=[
 *     [TLV: type=1 ...]                  ← parser context: (type1=255, type2=1)
 *     [TLV: type=2 len=K value=[
 *       [TLV: type=1 ...]                ← (type1=255, type2=2)
 *       [TLV: type=2 len=L value=[
 *         <LZ4F frame: 04 22 4d 18 ...>  ← lookup map[255][2][2] = action 2
 *                                           ⇒ DECOMPRESS payload, recurse
 *                                             with fresh (type1=0, type2=0)
 *       ]]
 *     ]]
 *   ]]
 *
 *   After decompression the inner TLV stream contains:
 *     [TLV: type=1 ...]    ← context becomes (type1=1, type2=0) — PEOPLE
 *       [TLV: type=3 ...]  ← (type1=1, type2=3) — view 0 (raw detection)
 *         [TLV: type=4 len=10 value=[x1 y1 x2 y2 conf]]  ← BOX
 *       [TLV: type=5 ...]  ← (type1=1, type2=5) — view 1 (tracked)
 *     [TLV: type=2 ...]    ← VEHICLE
 *     [TLV: type=3 ...]    ← ANIMAL
 *
 * The (type1, type2) tuple at the box determines the class:
 *   type1 = 1 → people
 *   type1 = 2 → vehicle
 *   type1 = 3 → animal
 *
 * Box coordinates are in pixels of the AI processing frame (typically 896×480
 * for substream); we normalize to [0, 1] fractions before emitting.
 */

import * as lz4 from "lz4js";
import type {
  ReolinkDetectionBox,
  ReolinkDetectionDecodeState,
} from "../types";
import { type1ToLabel, type AiClassLabel } from "./aiClassMap";

const MARKER_LENGTH = 8;
const IFRAME_PREFIX_LENGTH = 8;
const COUNTER_OFFSET = 8;
const BASELINE_SIZE = 128;

const FRAME_SIZE_TLV = Buffer.from([0x03, 0x04, 0x00]);
const LZ4F_MAGIC = Buffer.from([0x04, 0x22, 0x4d, 0x18]);

const CONFIDENCE_DIVISOR = 100;

// Fallback frame size if the buffer doesn't carry a frame-size TLV. Reolink's
// AI typically runs against the substream at 896×480; per-stream overrides
// take precedence when present.
const DEFAULT_AI_FRAME_WIDTH = 896;
const DEFAULT_AI_FRAME_HEIGHT = 480;

// Maximum decompressed buffer the SDK allocates per AI block.
const LZ4_DECOMPRESS_MAX = 256 * 1024;

export interface DecodedDetectionHeader {
  state: ReolinkDetectionDecodeState;
  /** Offset within `raw` where the standard 8-byte marker starts (8 for I-frames, 0 for P-frames). */
  markerOffset: number;
  /** Length of the standard block (raw.length - markerOffset). */
  blockLength: number;
  /**
   * 4-byte field at marker+0x08 (uint32_le). For P-frames this is a per-frame
   * counter. For I-frames the layout differs and the value should not be
   * interpreted as a counter.
   */
  counter?: number;
  /** AI processing frame width in pixels, parsed from a `03 04 00` TLV if present. */
  aiFrameWidth?: number;
  /** AI processing frame height in pixels, parsed from a `03 04 00` TLV if present. */
  aiFrameHeight?: number;
  /** Decoded boxes in [0, 1] coordinates relative to the AI processing frame. */
  boxes: ReolinkDetectionBox[];
}

interface RawBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number;
  /** AI class derived from the (type1, type2) parser context where the box was found. */
  label: AiClassLabel;
}

/**
 * Walk a TLV stream recursively, yielding every box found together with its
 * (type1, type2) parser context. When a `(255, 2, 2)` triple is encountered
 * — the SDK's `action 2 = decompress` — we decompress the payload as LZ4
 * Frame and recurse with a fresh (0, 0) context, mirroring what
 * AIDataParser::__analysisExtenTLV does internally.
 */
function walkBoxes(
  buf: Buffer,
  start: number,
  end: number,
  type1: number,
  type2: number,
  out: RawBox[],
): void {
  let pos = start;
  while (pos + 3 <= end) {
    const t = buf[pos]!;
    if (t === 0) return;
    const length = buf[pos + 1]! | (buf[pos + 2]! << 8);
    const recordEnd = pos + 3 + length;
    if (recordEnd > end) return;

    // Box TLV at the leaf.
    //
    // Box length varies by AI class — verified by decompressing live frames
    // from an E1 Zoom and walking the resulting TLV tree:
    //   - people  (type1=1): type=4, length=10  → 5 u16 LE: x1,y1,x2,y2,conf
    //   - vehicle (type1=2): type=4, length=14  → 5 u16 box + 2 u16 extras
    //                                              (likely subclass + colour)
    //   - animal  (type1=3): type=4, length=13  → 5 u16 box + 3 bytes extras
    //                                              (likely subspecies)
    // The static `s_tlv_types_map_2` also dispatches `type=2 length=10` for
    // some animal flows on older firmwares.
    //
    // In all cases the FIRST 10 bytes of the payload are the (x1, y1, x2, y2,
    // conf) tuple, so we read exactly those and ignore any trailing bytes.
    const isBoxType4 = t === 0x04 && (length === 10 || length === 13 || length === 14);
    const isBoxType2 = t === 0x02 && length === 10;
    if ((isBoxType4 || isBoxType2) && type1 !== 0 && type2 !== 0) {
      const x1 = buf.readUInt16LE(pos + 3);
      const y1 = buf.readUInt16LE(pos + 5);
      const x2 = buf.readUInt16LE(pos + 7);
      const y2 = buf.readUInt16LE(pos + 9);
      const conf = buf.readUInt16LE(pos + 11);
      if (x2 > x1 && y2 > y1) {
        out.push({ x1, y1, x2, y2, conf, label: type1ToLabel(type1) });
      }
      pos = recordEnd;
      continue;
    }

    // Decompress branch: (255, 2, 2) → LZ4F payload → recurse with fresh ctx.
    if (
      type1 === 255 &&
      type2 === 2 &&
      t === 2 &&
      length >= LZ4F_MAGIC.length &&
      buf[pos + 3] === LZ4F_MAGIC[0] &&
      buf[pos + 4] === LZ4F_MAGIC[1] &&
      buf[pos + 5] === LZ4F_MAGIC[2] &&
      buf[pos + 6] === LZ4F_MAGIC[3]
    ) {
      try {
        const decompressed = lz4.decompress(
          buf.subarray(pos + 3, recordEnd),
          LZ4_DECOMPRESS_MAX,
        );
        const decBuf = Buffer.from(decompressed);
        walkBoxes(decBuf, 0, decBuf.length, 0, 0, out);
      } catch {
        // Decompression failed — skip this branch silently.
      }
      pos = recordEnd;
      continue;
    }

    // Plain nested recursion: promote type1 then type2 the way the SDK does.
    if (length > 0) {
      let nextT1 = type1;
      let nextT2 = type2;
      if (type1 === 0) nextT1 = t;
      else if (type2 === 0) nextT2 = t;
      walkBoxes(buf, pos + 3, recordEnd, nextT1, nextT2, out);
    }
    pos = recordEnd;
  }
}

/**
 * Validate the standard marker, extract the per-frame counter, then walk the
 * TLV tree (decompressing LZ4F payloads where the SDK does) to extract every
 * detection box with its class label. Returns boxes normalized to `[0, 1]`
 * fractions of the AI processing frame.
 */
export function decodeDetectionHeader(
  raw: Buffer,
  frameType: "Iframe" | "Pframe",
): DecodedDetectionHeader {
  const markerOffset = frameType === "Iframe" ? IFRAME_PREFIX_LENGTH : 0;
  const blockLength = raw.length - markerOffset;
  const empty: DecodedDetectionHeader = {
    state: "invalid-marker",
    markerOffset,
    blockLength,
    boxes: [],
  };

  if (blockLength < MARKER_LENGTH) return empty;
  if (!hasStandardMarker(raw, markerOffset)) return empty;
  if (blockLength < COUNTER_OFFSET + 4) return empty;

  const counter = raw.readUInt32LE(markerOffset + COUNTER_OFFSET);

  // Walk the OUTER TLV (type=0xff). The walker handles the entire tree: the
  // 8-byte marker `ff XX 00 01 0b 00 01 08` is itself the start of a TLV
  // (`ff XX 00` then payload starting with `01 0b ...`).
  const rawBoxes: RawBox[] = [];
  walkBoxes(raw, markerOffset, raw.length, 0, 0, rawBoxes);

  // Find the AI frame size from a 03 04 00 TLV anywhere in the raw bytes
  // (it's emitted alongside the boxes inside the decompressed stream — but
  // some firmwares put a copy in the outer wrapping too). We walk the raw
  // stream once for its presence; failing that, fall back to defaults.
  let aiFrameWidth = DEFAULT_AI_FRAME_WIDTH;
  let aiFrameHeight = DEFAULT_AI_FRAME_HEIGHT;
  let frameSizeFound = false;
  const searchStart = markerOffset + MARKER_LENGTH;
  for (let i = searchStart; i + 7 <= raw.length; i++) {
    if (
      raw[i] === FRAME_SIZE_TLV[0] &&
      raw[i + 1] === FRAME_SIZE_TLV[1] &&
      raw[i + 2] === FRAME_SIZE_TLV[2]
    ) {
      const w = raw.readUInt16LE(i + 3);
      const h = raw.readUInt16LE(i + 5);
      if (w >= 64 && w <= 8192 && h >= 64 && h <= 8192) {
        aiFrameWidth = w;
        aiFrameHeight = h;
        frameSizeFound = true;
        break;
      }
    }
  }

  // Reolink cameras (e.g. E1 Zoom) emit the SAME bounding box under multiple
  // top-level class wrappers — the people array, the vehicle array AND the
  // animal array all carry copies of every detection, varying only in box
  // length (10 / 14 / 13 bytes respectively) and trailing class-specific
  // metadata bytes. The SDK app then picks the most specific class.
  //
  // Empirically (verified against live captures and the original people fixture
  // at coords [189,267,332,296,34]):
  //   - A real person populates people + vehicle wrappers (animal empty).
  //   - A real animal populates all three wrappers.
  // So `vehicle` is the most common false-positive class — when it appears
  // alongside people, the truth is people. Animal, when present, almost always
  // wins because the NN only fires animal for a confirmed non-person/vehicle.
  //
  // Specificity ranking (most → least): face > animal > people > vehicle.
  const specificity: Record<string, number> = {
    face: 4,
    animal: 3,
    people: 2,
    vehicle: 1,
    unknown: 0,
  };
  const dedup = new Map<string, RawBox>();
  for (const rb of rawBoxes) {
    if (rb.x2 > aiFrameWidth || rb.y2 > aiFrameHeight) continue;
    const key = `${rb.x1}_${rb.y1}_${rb.x2}_${rb.y2}`;
    const prev = dedup.get(key);
    if (!prev || (specificity[rb.label] ?? 0) > (specificity[prev.label] ?? 0)) {
      dedup.set(key, rb);
    }
  }

  const boxes: ReolinkDetectionBox[] = [];
  for (const rb of dedup.values()) {
    boxes.push({
      x: rb.x1 / aiFrameWidth,
      y: rb.y1 / aiFrameHeight,
      width: (rb.x2 - rb.x1) / aiFrameWidth,
      height: (rb.y2 - rb.y1) / aiFrameHeight,
      ...(rb.conf > 0 && rb.conf <= 100
        ? { confidence: rb.conf / CONFIDENCE_DIVISOR }
        : {}),
      ...(rb.label !== "unknown" ? { label: rb.label } : {}),
    });
  }

  let state: ReolinkDetectionDecodeState;
  if (boxes.length > 0) state = "overlay-decoded";
  else if (blockLength === BASELINE_SIZE) state = "no-overlay";
  else state = "overlay-undecoded";

  return {
    state,
    markerOffset,
    blockLength,
    counter,
    ...(frameSizeFound
      ? { aiFrameWidth, aiFrameHeight }
      : {}),
    boxes,
  };
}

/** True if `raw[offset..offset+8]` matches the `ff XX 00 01 0b 00 01 08` pattern. */
export function hasStandardMarker(raw: Buffer, offset: number): boolean {
  if (raw.length < offset + MARKER_LENGTH) return false;
  return (
    raw[offset] === 0xff &&
    raw[offset + 2] === 0x00 &&
    raw[offset + 3] === 0x01 &&
    raw[offset + 4] === 0x0b &&
    raw[offset + 5] === 0x00 &&
    raw[offset + 6] === 0x01 &&
    raw[offset + 7] === 0x08
  );
}
