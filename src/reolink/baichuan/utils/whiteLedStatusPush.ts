export type FloodlightStatusPushEntry = {
  channel: number;
  status: number;
};

/**
 * Parse Baichuan cmd_id 291 (FloodlightStatusList push) into per-channel status entries.
 *
 * The XML shape contains a list where each item has:
 * - <channel>0</channel>
 * - <status>0|1</status>
 *
 * Some firmwares may include multiple channels in the same payload.
 */
export const parseFloodlightStatusListPushXml = (
  xml: string,
): FloodlightStatusPushEntry[] => {
  const out: FloodlightStatusPushEntry[] = [];

  // Non-greedy match: channel ... status within the same logical block.
  const re =
    /<channel>\s*(\d+)\s*<\/channel>[\s\S]*?<status>\s*(\d+)\s*<\/status>/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const channel = Number.parseInt(m[1] ?? "", 10);
    const status = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isFinite(channel) || !Number.isFinite(status)) continue;
    out.push({ channel, status });
  }

  return out;
};
