/**
 * Aggregate the raw cmd_146 (`getStreamInfoList`) reply into a UI-friendly
 * shape that enumerates everything `setEnc` will accept on a given channel.
 *
 * Reolink reports one `<StreamInfo>` block per resolution and one
 * `<encodeTable>` per profile inside it, so the same resolution shows up
 * across multiple `StreamInfo` entries. This module deduplicates by
 * `(width, height)` and groups by stream profile (mainStream / subStream /
 * thirdStream).
 */

import type {
  BaichuanStreamInfoList,
  BaichuanStreamEncodeTable,
  EncOptions,
  EncResolutionOption,
  EncStreamOptions,
} from "../types";

export function buildEncOptions(
  list: BaichuanStreamInfoList,
  channel: number,
): EncOptions {
  const result: EncOptions = { channel };
  const main = aggregateByType(list, "mainStream");
  const sub = aggregateByType(list, "subStream");
  const third = aggregateByType(list, "thirdStream");
  if (main) result.mainStream = main;
  if (sub) result.subStream = sub;
  if (third) result.thirdStream = third;
  return result;
}

function aggregateByType(
  list: BaichuanStreamInfoList,
  type: "mainStream" | "subStream" | "thirdStream",
): EncStreamOptions | undefined {
  const seen = new Map<string, EncResolutionOption>();
  for (const stream of list.streams) {
    for (const eb of stream.encodeTables) {
      if (eb.type !== type) continue;
      const mapped = mapEncodeTable(eb);
      if (!mapped) continue;
      const key = `${mapped.width}x${mapped.height}`;
      if (!seen.has(key)) seen.set(key, mapped);
    }
  }
  if (seen.size === 0) return undefined;
  return {
    type,
    resolutions: [...seen.values()],
    encoderTypes: ["vbr", "cbr"],
    encoderProfiles: ["high", "main", "baseline"],
  };
}

function mapEncodeTable(
  eb: BaichuanStreamEncodeTable,
): EncResolutionOption | undefined {
  if (eb.width == null || eb.height == null) return undefined;
  const videoEncTypes: Array<"h264" | "h265"> = (
    eb.videoEncTypeList ?? (eb.videoEncType != null ? [eb.videoEncType] : [])
  )
    .map((t): "h264" | "h265" | undefined =>
      t === 0 ? "h264" : t === 1 ? "h265" : undefined,
    )
    .filter((t): t is "h264" | "h265" => t !== undefined);
  return {
    width: eb.width,
    height: eb.height,
    videoEncTypes,
    ...(eb.defaultFramerate != null
      ? { defaultFramerate: eb.defaultFramerate }
      : {}),
    ...(eb.defaultBitrate != null
      ? { defaultBitrate: eb.defaultBitrate }
      : {}),
    ...(eb.defaultGop != null ? { defaultGop: eb.defaultGop } : {}),
    framerateOptions: eb.framerateTable ?? [],
    bitrateOptions: eb.bitrateTable ?? [],
  };
}
