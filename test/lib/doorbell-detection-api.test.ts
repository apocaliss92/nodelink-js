import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import type { SupportInfo } from "../../src/reolink/baichuan/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  __dirname,
  "..",
  "fixtures",
  "models",
  "Reolink_Video_Doorbell_PoE",
  "channels",
  "0",
);

function load(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE, file), "utf-8"));
}

interface Harness {
  api: ReolinkBaichuanApi;
  /** `isDoorbell` as it was handed to probeAutotrackingSupport. */
  autotrackingSawDoorbell: () => boolean | undefined;
}

/**
 * A ReolinkBaichuanApi wired to the captured PoE-doorbell fixture. The
 * constructor does not connect; every collaborator getDeviceCapabilities
 * reaches for is replaced by the fixture, EXCEPT the model lookup, which is
 * the thing under test.
 */
function harness(
  opts: { model?: string; isNvr?: boolean; support?: SupportInfo } = {},
): Harness {
  const api = new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535,
    username: "u",
    password: "p",
    transport: "tcp",
  });

  let sawDoorbell: boolean | undefined;
  const stub = api as unknown as Record<string, unknown>;

  stub.getSupportInfo = async () => opts.support ?? load("support-info.json");
  stub.getAbilityInfo = async () => load("ability-info.json");
  stub.getInfo = async () =>
    opts.model === undefined ? {} : { type: opts.model };
  stub.isNvrDevice = async () => opts.isNvr ?? false;
  stub.probeFloodlightSupportByCmd289 = async () => false;
  stub.getAiDetectTypes = async () => ["people", "vehicle"];
  stub.getPtzPresets = async () => [];
  stub.getDingDongList = async () => [];
  stub.getDingDongCfg = async () => [];
  stub.probeAutotrackingSupport = async (
    _ch: number,
    o?: { isDoorbell?: boolean },
  ) => {
    sawDoorbell = o?.isDoorbell;
    return false;
  };

  return { api, autotrackingSawDoorbell: () => sawDoorbell };
}

describe("getDeviceCapabilities — doorbell by model (issue #25)", () => {
  it("reports a Reolink Video Doorbell PoE as a doorbell", async () => {
    const { api } = harness({ model: "Reolink Video Doorbell PoE" });
    const result = await api.getDeviceCapabilities(0);
    expect(result.capabilities.isDoorbell).toBe(true);
  });

  it("forwards the doorbell verdict to the autotracking probe", async () => {
    // The probe trusts a doorbell's categorical ability flag; a wrong
    // isDoorbell silently changes autotracking detection too.
    const h = harness({ model: "Reolink Video Doorbell PoE" });
    await h.api.getDeviceCapabilities(0);
    expect(h.autotrackingSawDoorbell()).toBe(true);
  });

  it("keeps floodlight and intercom for the PoE doorbell", async () => {
    const { api } = harness({ model: "Reolink Video Doorbell PoE" });
    const result = await api.getDeviceCapabilities(0);
    expect(result.capabilities.hasFloodlight).toBe(true);
    expect(result.capabilities.hasIntercom).toBe(true);
  });

  it("does not invent a doorbell when the model says otherwise", async () => {
    const { api } = harness({ model: "RLC-810A" });
    const result = await api.getDeviceCapabilities(0);
    expect(result.capabilities.isDoorbell).toBe(false);
  });

  it("survives a device that will not tell us its model", async () => {
    // getInfo can fail or answer without `type`; capabilities must still be
    // produced rather than throwing.
    const { api } = harness({});
    const result = await api.getDeviceCapabilities(0);
    expect(result.capabilities).toBeDefined();
    expect(result.capabilities.isDoorbell).toBe(false);
  });
});

describe("getDeviceCapabilities — doorbells behind an NVR", () => {
  const support: SupportInfo = {
    channelNum: 8,
    items: [
      { chnID: 0, channelType: "ipc", doorbellVersion: 0 },
      { chnID: 3, channelType: "Doorbell", doorbellVersion: 0 },
      { chnID: 4, channelType: "ipc", doorbellVersion: 0 },
    ],
  };

  it("recognizes channel 3's explicit type even if model lookup fails", async () => {
    const h = harness({ isNvr: true, support });
    vi.spyOn(h.api, "getInfo").mockRejectedValue(new Error("unsupported"));

    const doorbell = await h.api.getDeviceCapabilities(3);
    expect(doorbell.capabilities.isDoorbell).toBe(true);
    expect(h.autotrackingSawDoorbell()).toBe(true);
    const camera = await h.api.getDeviceCapabilities(4);
    expect(camera.capabilities.isDoorbell).toBe(false);
  });

  it("looks up each channel's model rather than the recorder's model", async () => {
    const h = harness({
      isNvr: true,
      support: {
        channelNum: 8,
        items: support.items.map((item) => ({ ...item, channelType: "ipc" })),
      },
    });
    const getInfo = vi.spyOn(h.api, "getInfo").mockImplementation(async (channel) => {
      if (channel === undefined) return { type: "NVR" };
      return { type: channel === 3 ? "Reolink Video Doorbell PoE" : "RLC-810A" };
    });

    const doorbell = await h.api.getDeviceCapabilities(3);
    expect(doorbell.capabilities.isDoorbell).toBe(true);
    expect(h.autotrackingSawDoorbell()).toBe(true);
    const camera = await h.api.getDeviceCapabilities(0);
    expect(camera.capabilities.isDoorbell).toBe(false);
    for (const channel of [3, 0]) {
      expect(getInfo).toHaveBeenCalledWith(
        channel,
        expect.objectContaining({ timeoutMs: 5000 }),
      );
    }

    await h.api.getDeviceCapabilities(3);
    expect(getInfo).toHaveBeenCalledTimes(2);
  });

  it("keeps using host info for standalone devices", async () => {
    const { api } = harness({ model: "Reolink Video Doorbell PoE" });
    const getInfo = vi.spyOn(api, "getInfo");
    const result = await api.getDeviceCapabilities();
    expect(result.capabilities.isDoorbell).toBe(true);
    expect(getInfo).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });
});
