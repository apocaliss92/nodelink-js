/**
 * Static AI-class dispatch map extracted from libBCSDKWrapper.dylib's
 * `s_tlv_types_map` (and `s_tlv_types_map_2`) BSS structures via runtime
 * walk — see `tools/sdk-probe/dump-class-map.cpp`.
 *
 * The SDK's `AIDataParser::__analysisExtenTLV` performs a three-level
 * dispatch:
 *
 *   map[type1][type2][type3] → action_code
 *
 * where `(type1, type2)` is the recursive parser context (the type bytes of
 * the wrapping TLVs) and `type3` is the type byte of the current TLV. The
 * resulting action_code drives a jump table that picks which "class array"
 * inside `BC_AI_DATA` receives the data.
 *
 * Empirically, action codes cluster densely per AI class, allowing a clean
 * code-range → label mapping:
 *
 *   17–28  people     (per-class action codes for various view×channel splits)
 *   39–50  vehicle
 *   61–72  animal (dog/cat)
 *   79–82  face (via the 0xABCDEF magic context, action 4 recursion)
 *
 * Type1 also encodes the AI class directly when it's a small int:
 *   1  → people
 *   2  → vehicle
 *   3  → animal
 *
 * Type2 distinguishes view0 (raw detection) from view1 (tracked with ID):
 *   3  → view 0
 *   5  → view 1
 *
 * `type1 == 255` is the outer "ff XX 00 01 0b 00 01 08" envelope; (255, 2, 2)
 * dispatches to action 2 = decompress (LZ4 frame).
 *
 * `type1 == 0xABCDEF` is a synthetic marker injected by action_code 4 to
 * indicate a sub-parse that needs face-recognition handling.
 */

export type AiClassLabel =
  | "people"
  | "vehicle"
  | "animal"
  | "face"
  | "unknown";

/** Map (type1, type2, type3) → action_code (from the SDK's static map). */
export const AI_TLV_DISPATCH: ReadonlyArray<{
  type1: number;
  type2: number;
  type3: number;
  action: number;
}> = [
  // people
  { type1: 1, type2: 3, type3: 3, action: 20 },
  { type1: 1, type2: 3, type3: 4, action: 21 },
  { type1: 1, type2: 3, type3: 5, action: 17 },
  { type1: 1, type2: 3, type3: 6, action: 22 },
  { type1: 1, type2: 3, type3: 7, action: 23 },
  { type1: 1, type2: 5, type3: 3, action: 27 },
  { type1: 1, type2: 5, type3: 4, action: 28 },
  { type1: 1, type2: 5, type3: 5, action: 24 },
  // vehicle
  { type1: 2, type2: 3, type3: 3, action: 42 },
  { type1: 2, type2: 3, type3: 4, action: 43 },
  { type1: 2, type2: 3, type3: 5, action: 39 },
  { type1: 2, type2: 3, type3: 6, action: 44 },
  { type1: 2, type2: 3, type3: 7, action: 45 },
  { type1: 2, type2: 5, type3: 3, action: 49 },
  { type1: 2, type2: 5, type3: 4, action: 50 },
  { type1: 2, type2: 5, type3: 5, action: 46 },
  // animal
  { type1: 3, type2: 3, type3: 3, action: 64 },
  { type1: 3, type2: 3, type3: 4, action: 65 },
  { type1: 3, type2: 3, type3: 5, action: 61 },
  { type1: 3, type2: 3, type3: 6, action: 66 },
  { type1: 3, type2: 3, type3: 7, action: 67 },
  { type1: 3, type2: 5, type3: 3, action: 71 },
  { type1: 3, type2: 5, type3: 4, action: 72 },
  { type1: 3, type2: 5, type3: 5, action: 68 },
  // outer envelope (255) → decompress action
  { type1: 255, type2: 2, type3: 2, action: 2 },
  // face / "magic" recursion context (0xABCDEF)
  { type1: 0xabcdef, type2: 3, type3: 6, action: 79 },
  { type1: 0xabcdef, type2: 5, type3: 4, action: 81 },
];

/** action_code → human-readable AI class label. */
export function actionToLabel(action: number): AiClassLabel {
  if (action >= 17 && action <= 28) return "people";
  if (action >= 39 && action <= 50) return "vehicle";
  if (action >= 61 && action <= 72) return "animal";
  if (action >= 79 && action <= 82) return "face";
  return "unknown";
}

/** (type1, type2) tuple → AI class label. */
export function type1ToLabel(type1: number): AiClassLabel {
  switch (type1) {
    case 1:
      return "people";
    case 2:
      return "vehicle";
    case 3:
      return "animal";
    case 0xabcdef:
      return "face";
    default:
      return "unknown";
  }
}
