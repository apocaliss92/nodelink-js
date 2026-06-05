/**
 * Regression tests for the doorbell exception in `probeAutotrackingSupport`.
 *
 * Mirrors the floodlight rule from `computeDeviceCapabilities`: when the
 * device is a doorbell AND the firmware admits `smartTrackModeAbility=0`,
 * trust that "no autotrack" signal over `smartTrackMode`. Without it the
 * 9527000ICL1T1MDS doorbell — which has no PT motor — gets a phantom
 * autotrack icon in the UI because its AiCfg ships smartTrackMode=1.
 */

import { describe, it, expect, vi } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

function buildAiCfgXml(opts: {
  smartTrackMode: number;
  smartTrackModeAbility?: number;
}): string {
  const ability =
    opts.smartTrackModeAbility !== undefined
      ? `<smartTrackModeAbility>${opts.smartTrackModeAbility}</smartTrackModeAbility>`
      : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<body>\n  <AiCfg version="1.1">\n` +
    `    <channelId>0</channelId>\n` +
    `    <smartTrackMode>${opts.smartTrackMode}</smartTrackMode>\n` +
    `    ${ability}\n` +
    `  </AiCfg>\n</body>\n`
  );
}

function makeApiWithAiCfg(xml: string): ReolinkBaichuanApi {
  const api = Object.create(ReolinkBaichuanApi.prototype) as ReolinkBaichuanApi;
  // Stub the small bits probeAutotrackingSupport actually reaches into.
  Object.defineProperty(api, "normalizeChannel", {
    value: (ch: number) => ch,
  });
  Object.defineProperty(api, "sendXml", {
    value: vi.fn(async () => xml),
  });
  return api;
}

describe("probeAutotrackingSupport — doorbell exception", () => {
  it("doorbell + smartTrackModeAbility=0 → false even when smartTrackMode=1", async () => {
    const api = makeApiWithAiCfg(
      buildAiCfgXml({ smartTrackMode: 1, smartTrackModeAbility: 0 }),
    );
    expect(
      await api.probeAutotrackingSupport(0, { isDoorbell: true }),
    ).toBe(false);
  });

  it("doorbell + smartTrackModeAbility=1 → true (E1-class hardware behind doorbell-versioned fw)", async () => {
    const api = makeApiWithAiCfg(
      buildAiCfgXml({ smartTrackMode: 1, smartTrackModeAbility: 1 }),
    );
    expect(
      await api.probeAutotrackingSupport(0, { isDoorbell: true }),
    ).toBe(true);
  });

  it("doorbell without smartTrackModeAbility field → falls back to smartTrackMode>0", async () => {
    const api = makeApiWithAiCfg(buildAiCfgXml({ smartTrackMode: 1 }));
    expect(
      await api.probeAutotrackingSupport(0, { isDoorbell: true }),
    ).toBe(true);
  });

  it("non-doorbell + smartTrackModeAbility=0 + smartTrackMode=1 → unchanged (returns true)", async () => {
    // Preserves the existing behaviour for non-doorbell devices so this fix
    // is the narrowest possible — other false-positive classes (e.g. fixed
    // bullet RLC-510WA, dual-lens Duo 3 WiFi) stay as they were and can be
    // tackled separately if needed.
    const api = makeApiWithAiCfg(
      buildAiCfgXml({ smartTrackMode: 1, smartTrackModeAbility: 0 }),
    );
    expect(
      await api.probeAutotrackingSupport(0, { isDoorbell: false }),
    ).toBe(true);
  });

  it("smartTrackMode=0 → false regardless of doorbell hint", async () => {
    const api = makeApiWithAiCfg(
      buildAiCfgXml({ smartTrackMode: 0, smartTrackModeAbility: 0 }),
    );
    expect(await api.probeAutotrackingSupport(0, { isDoorbell: true })).toBe(
      false,
    );
    expect(await api.probeAutotrackingSupport(0, { isDoorbell: false })).toBe(
      false,
    );
  });
});
