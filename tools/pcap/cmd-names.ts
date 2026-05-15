import * as constants from "../../src/protocol/constants";

/**
 * Reverse-lookup table from cmd_id (number) to the semantic constant name.
 * Built dynamically from `src/protocol/constants.ts` so it stays in sync.
 */
function buildCmdNameMap(): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const [name, value] of Object.entries(constants)) {
    if (typeof value !== "number") continue;
    if (!name.startsWith("BC_CMD_ID_")) continue;
    const list = map.get(value);
    if (list) list.push(name);
    else map.set(value, [name]);
  }
  return map;
}

const CMD_NAMES = buildCmdNameMap();

export function describeCmdId(cmdId: number): string {
  const names = CMD_NAMES.get(cmdId);
  if (!names || names.length === 0) return `cmd_${cmdId}`;
  return names.join(" | ");
}

export function describeMessageClass(cls: number): string {
  if (cls === constants.BC_CLASS_LEGACY) return "LEGACY";
  if (cls === constants.BC_CLASS_MODERN_20) return "MODERN_20";
  if (cls === constants.BC_CLASS_MODERN_24) return "MODERN_24";
  if (cls === constants.BC_CLASS_MODERN_24_ALT) return "MODERN_24_ALT";
  if (cls === constants.BC_CLASS_FILE_DOWNLOAD) return "FILE_DL";
  return `0x${cls.toString(16).padStart(4, "0")}`;
}
