/**
 * Tests for Baichuan-only NVR/Hub channel enumeration (issue #15).
 *
 * Some Home Hub firmwares (e.g. BASE_WUNNT6NA5) expose no HTTP API, so
 * CGI `GetChannelstatus` is unavailable. The cmd_id 145 push is also
 * unreliable on these devices (live capture: never arrives within 8s) and
 * `AbilitySupport.channelNum` is often absent. The HTTP-free strategy
 * validated against a real hub: bound the candidate range with the
 * Support `chnID` slots, then actively probe each via getInfo — the set
 * that responds matches what CGI reports.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveBaichuanChannels } from "../../src/reolink/baichuan/utils/channelEnumeration";

describe("resolveBaichuanChannels", () => {
  it("uses the cmd_id 145 push cache when populated (no probing)", async () => {
    const probe = vi.fn(async () => true);
    const channels = await resolveBaichuanChannels({
      pushChannels: [2, 0, 1],
      supportChnIds: [0, 1, 2, 3, 4, 5, 6, 7],
      probe,
    });
    expect(channels).toEqual([0, 1, 2]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes the Support slot range when the push cache is empty", async () => {
    // Real hub capture: slots 0-7, only 0/1/3 respond, matches CGI.
    const active = new Set([0, 1, 3]);
    const probe = vi.fn(async (ch: number) => active.has(ch));
    const channels = await resolveBaichuanChannels({
      pushChannels: [],
      supportChnIds: [0, 1, 2, 3, 4, 5, 6, 7],
      probe,
    });
    expect(channels).toEqual([0, 1, 3]);
    expect(probe).toHaveBeenCalledTimes(8);
  });

  it("returns sorted channels regardless of probe completion order", async () => {
    const active = new Set([5, 1, 3]);
    const probe = vi.fn(async (ch: number) => active.has(ch));
    const channels = await resolveBaichuanChannels({
      pushChannels: [],
      supportChnIds: [0, 1, 2, 3, 4, 5],
      probe,
    });
    expect(channels).toEqual([1, 3, 5]);
  });

  it("falls back to channel 0 when Support carries no chnID", async () => {
    const probe = vi.fn(async () => true);
    const channels = await resolveBaichuanChannels({
      pushChannels: [],
      supportChnIds: [],
      probe,
    });
    expect(channels).toEqual([0]);
    expect(probe).toHaveBeenCalledWith(0);
  });

  it("returns empty when nothing is reachable and no slots are known", async () => {
    const probe = vi.fn(async () => false);
    const channels = await resolveBaichuanChannels({
      pushChannels: [],
      supportChnIds: [0],
      probe,
    });
    expect(channels).toEqual([]);
  });
});
