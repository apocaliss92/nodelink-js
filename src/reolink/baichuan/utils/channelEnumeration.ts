/**
 * Baichuan-only NVR/Hub channel enumeration (issue #15).
 *
 * Discovering which channels carry a camera normally goes through CGI
 * (`GetChannelstatus`, HTTP). Hubs with HTTP disabled need an HTTP-free
 * path. Two Baichuan-native signals are unreliable on some Home Hub
 * firmwares:
 *   - the cmd_id 145 channel-info push may never arrive (live capture:
 *     empty cache after 8s), and
 *   - `AbilitySupport.channelNum` is frequently absent.
 *
 * The validated approach: take the channel *slot* range advertised by the
 * Support response (`items[].chnID`) and actively probe each slot via
 * `getInfo` — the slots that respond are the populated channels. Against a
 * real hub this reproduced the CGI channel list exactly.
 */

export interface ResolveBaichuanChannelsDeps {
  /** Channels already known from the cmd_id 145 push cache (may be empty). */
  pushChannels: number[];
  /** Channel slot ids advertised by Support `items[].chnID` (bounds the probe). */
  supportChnIds: number[];
  /** Active probe — resolves true when a camera answers on the channel. */
  probe: (channel: number) => Promise<boolean>;
}

/**
 * Resolve the populated channel list using Baichuan only.
 *
 * Prefers the push cache when populated; otherwise probes the Support slot
 * range concurrently. Returns a sorted, de-duplicated channel list.
 */
export async function resolveBaichuanChannels(
  deps: ResolveBaichuanChannelsDeps,
): Promise<number[]> {
  const fromPush = dedupeSorted(deps.pushChannels);
  if (fromPush.length > 0) return fromPush;

  const slots = dedupeSorted(deps.supportChnIds);
  // Fall back to channel 0 when Support advertised no slots (standalone-ish).
  const candidates = slots.length > 0 ? slots : [0];

  const probed = await Promise.all(
    candidates.map(async (channel) =>
      (await deps.probe(channel)) ? channel : undefined,
    ),
  );
  return dedupeSorted(
    probed.filter((c): c is number => c !== undefined),
  );
}

function dedupeSorted(values: number[]): number[] {
  const set = new Set<number>();
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}
