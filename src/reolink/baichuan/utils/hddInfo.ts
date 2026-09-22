/**
 * `<HddInfoList>` (cmd 102) — the camera's own view of its card.
 *
 * The shape this library declared until 0.9.0 was wrong, and wrong in the way
 * that hurts most: a reader written against it found nothing and said so
 * silently. It declared `body.HddInfoList.item[{ id, size, used }]`. Nothing
 * on the wire carries any of those names. Measured 2026-09-22:
 *
 * ```xml
 * <HddInfoList version="1.1">
 *   <HddInfo>
 *     <number>0</number>
 *     <capacity>238</capacity><capacityM>271</capacityM>
 *     <format>1</format><mount>1</mount>
 *     <remainSize>0</remainSize><remainSizeM>990</remainSizeM>
 *   </HddInfo>
 * </HddInfoList>
 * ```
 *
 * Two traps beyond the names:
 *
 *   - **Size is split across two fields.** `capacity` is whole gigabytes and
 *     `capacityM` is the megabyte remainder: E1 Outdoor PoE answers 238 + 271,
 *     i.e. 238.26 GB. Reading `capacity` alone loses a quarter of a gigabyte;
 *     reading `capacityM` alone loses the card.
 *   - **Newer firmwares add an exact byte count.** Reolink Home Hub
 *     v3.3.0.456 also sends `capacityV2` / `remainSizeV2` (62528618496 bytes =
 *     58.23 GB, matching its own 58 + 239), plus `type` and `index`. When the
 *     V2 pair is present it is authoritative; the split pair is the fallback.
 *
 * `number` is not an ordinal: the Home Hub calls its card 17.
 */
import { getXmlText } from "../../../protocol/xml";
import { getXmlBlocks } from "../xmlUtils";
import { parseNumber } from "./parsing";

/** One volume, exactly as the camera describes it, plus the two derived sizes. */
export type BaichuanHddInfo = {
  /** The camera's own id for the volume (`<number>`). Not an index. */
  readonly number: number | null;
  /** Whole gigabytes. Pair with {@link capacityM}. */
  readonly capacity: number | null;
  /** Megabyte remainder of {@link capacity}. */
  readonly capacityM: number | null;
  /** Exact size in bytes (`capacityV2`), on the firmwares that send it. */
  readonly capacityBytes: number | null;
  readonly remainSize: number | null;
  readonly remainSizeM: number | null;
  readonly remainSizeBytes: number | null;
  /** 1 = formatted and usable. 0 = a card the camera cannot write to. */
  readonly format: number | null;
  /** 1 = mounted. 0 = no card at all. */
  readonly mount: number | null;
  /** Storage kind, newer firmwares only. */
  readonly type: number | null;
  /** Slot index, newer firmwares only. */
  readonly index: number | null;
  /**
   * Total size in MB, from the byte count when the camera gave one and from
   * the split pair otherwise. **Null when the camera stated neither** — a size
   * that was not read is not a size of zero.
   */
  readonly capacityMb: number | null;
  /** Free space in MB, on the same terms as {@link capacityMb}. */
  readonly remainMb: number | null;
};

const BYTES_PER_MB = 1024 * 1024;

const num = (xml: string, tag: string): number | null => {
  const value = parseNumber(getXmlText(xml, tag));
  return value === undefined ? null : value;
};

/** Megabytes from whichever pair the camera actually sent. */
const megabytes = (
  bytes: number | null,
  whole: number | null,
  remainder: number | null,
): number | null => {
  if (bytes !== null) return bytes / BYTES_PER_MB;
  if (whole === null && remainder === null) return null;
  return (whole ?? 0) * 1024 + (remainder ?? 0);
};

/** Parse a cmd 102 reply into one record per volume. */
export const parseHddInfoListXml = (xml: string): readonly BaichuanHddInfo[] => {
  const list = getXmlBlocks(xml, "HddInfoList")[0];
  if (list === undefined) return [];
  return getXmlBlocks(list, "HddInfo").map((block): BaichuanHddInfo => {
    const capacity = num(block, "capacity");
    const capacityM = num(block, "capacityM");
    const capacityBytes = num(block, "capacityV2");
    const remainSize = num(block, "remainSize");
    const remainSizeM = num(block, "remainSizeM");
    const remainSizeBytes = num(block, "remainSizeV2");
    return {
      number: num(block, "number"),
      capacity,
      capacityM,
      capacityBytes,
      remainSize,
      remainSizeM,
      remainSizeBytes,
      format: num(block, "format"),
      mount: num(block, "mount"),
      type: num(block, "type"),
      index: num(block, "index"),
      capacityMb: megabytes(capacityBytes, capacity, capacityM),
      remainMb: megabytes(remainSizeBytes, remainSize, remainSizeM),
    };
  });
};
