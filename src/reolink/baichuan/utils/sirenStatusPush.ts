export type SirenStatusPushEntry = {
  channel: number;
  status: number;
  playing?: number;
};

/**
 * Parse Baichuan cmd_id 547 (SirenStatusList / AudioAlarm push) into per-channel entries.
 *
 * Expected payload shape:
 *   <SirenStatusList>
 *     <channelId>0</channelId>
 *     <status>0|1</status>
 *     <playing>0|1</playing>   (optional, present on some firmwares)
 *   </SirenStatusList>
 *
 * Some firmwares also use `<channel>` instead of `<channelId>`, and some
 * emit a list of items. The regex below tolerates both shapes.
 */
export const parseSirenStatusListPushXml = (
  xml: string,
): SirenStatusPushEntry[] => {
  const out: SirenStatusPushEntry[] = [];

  const re =
    /<(?:channelId|channel)>\s*(\d+)\s*<\/(?:channelId|channel)>[\s\S]*?<status>\s*(\d+)\s*<\/status>(?:[\s\S]*?<playing>\s*(\d+)\s*<\/playing>)?/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const channel = Number.parseInt(m[1] ?? "", 10);
    const status = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isFinite(channel) || !Number.isFinite(status)) continue;
    const entry: SirenStatusPushEntry = { channel, status };
    if (m[3] !== undefined) {
      const playing = Number.parseInt(m[3], 10);
      if (Number.isFinite(playing)) entry.playing = playing;
    }
    out.push(entry);
  }

  return out;
};
