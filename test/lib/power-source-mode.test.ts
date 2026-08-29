import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSwitchBatteryAdapterModeXml,
  parseSwitchBatteryAdapterModeResponse,
  powerSourceFromBatteryInfo,
} from "../../src/reolink/baichuan/utils/powerSource.js";
import {
  computeDeviceCapabilities,
  supportsPowerSourceSwitch,
} from "../../src/reolink/baichuan/capabilities.js";
import { BC_CMD_ID_SWITCH_BATTERY_ADAPTER_MODE } from "../../src/protocol/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.join(__dirname, "..", "fixtures", "models");

function loadChannelFixture(model: string, file: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(MODELS, model, "channels", "0", file), "utf-8"),
  );
}

describe("SwitchBatteryAdapterMode (cmd 805) — XML builder", () => {
  it("uses command id 805", () => {
    expect(BC_CMD_ID_SWITCH_BATTERY_ADAPTER_MODE).toBe(805);
  });

  it("builds the adapter (wired) payload with dryRun disabled by default", () => {
    expect(buildSwitchBatteryAdapterModeXml("adapter"))
      .toBe(`<?xml version="1.0" encoding="UTF-8" ?>
<body>
<SwitchBatteryAdapterMode version="1.1">
<mode>adapter</mode>
<dryRun>0</dryRun>
</SwitchBatteryAdapterMode>
</body>`);
  });

  it("builds the battery payload", () => {
    expect(buildSwitchBatteryAdapterModeXml("battery")).toContain(
      "<mode>battery</mode>",
    );
  });

  it("emits dryRun=1 when asked for a dry run", () => {
    expect(buildSwitchBatteryAdapterModeXml("adapter", true)).toContain(
      "<dryRun>1</dryRun>",
    );
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      buildSwitchBatteryAdapterModeXml("wired" as any),
    ).toThrowError(/mode/i);
  });
});

describe("SwitchBatteryAdapterMode (cmd 805) — response parsing", () => {
  it("treats an empty body as success (firmware answers 200 + empty body)", () => {
    const res = parseSwitchBatteryAdapterModeResponse("", "adapter", false);
    expect(res).toEqual({ mode: "adapter", dryRun: false, accepted: true });
  });

  it("treats whitespace-only body as success", () => {
    expect(
      parseSwitchBatteryAdapterModeResponse("\n  \n", "battery", true).accepted,
    ).toBe(true);
  });

  it("reads back the echoed mode when the firmware returns one", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<SwitchBatteryAdapterMode version="1.1">
<mode>battery</mode>
</SwitchBatteryAdapterMode>
</body>`;
    const res = parseSwitchBatteryAdapterModeResponse(xml, "adapter", false);
    expect(res.mode).toBe("battery");
    expect(res.accepted).toBe(true);
  });

  it("reports a non-zero rspCode as rejected", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<rspCode>-2</rspCode>
</body>`;
    const res = parseSwitchBatteryAdapterModeResponse(xml, "adapter", false);
    expect(res.accepted).toBe(false);
    expect(res.rspCode).toBe(-2);
  });

  it("keeps rspCode 200 as accepted", () => {
    const xml = `<body><rspCode>200</rspCode></body>`;
    expect(
      parseSwitchBatteryAdapterModeResponse(xml, "adapter", false).accepted,
    ).toBe(true);
  });
});

describe("Current power source from BatteryInfo", () => {
  it("adapterStatus=adapter → wired", () => {
    expect(powerSourceFromBatteryInfo({ adapterStatus: "adapter" })).toBe(
      "adapter",
    );
  });

  it("adapterStatus=solarPanel → battery (solar charges, it is not wired mode)", () => {
    expect(powerSourceFromBatteryInfo({ adapterStatus: "solarPanel" })).toBe(
      "battery",
    );
  });

  it("adapterStatus=none → battery", () => {
    expect(powerSourceFromBatteryInfo({ adapterStatus: "none" })).toBe(
      "battery",
    );
  });

  it("missing adapterStatus → undefined (unknown)", () => {
    expect(powerSourceFromBatteryInfo({})).toBeUndefined();
  });
});

describe("Power-source switch capability detection", () => {
  it("battery cam reporting batteryMode=32 → supported", () => {
    expect(supportsPowerSourceSwitch({ chnID: 3, battery: 1, batteryMode: 32 })).toBe(
      true,
    );
  });

  it("battery cam reporting batteryMode=0 → not supported", () => {
    expect(supportsPowerSourceSwitch({ chnID: 0, battery: 2, batteryMode: 0 })).toBe(
      false,
    );
  });

  it("non-battery device with a stray batteryMode → not supported", () => {
    expect(supportsPowerSourceSwitch({ chnID: 0, battery: 0, batteryMode: 32 })).toBe(
      false,
    );
  });

  it("firmware that does not report batteryMode → not supported (probe required)", () => {
    expect(supportsPowerSourceSwitch({ chnID: 0, battery: 1 })).toBe(false);
  });

  it("undefined support item → not supported", () => {
    expect(supportsPowerSourceSwitch(undefined)).toBe(false);
  });

  it("Argus 3E fixture (battery=2, batteryMode=0) → no power-source switch", () => {
    const caps = computeDeviceCapabilities({
      channel: 0,
      support: loadChannelFixture("Argus_3E", "support-info.json"),
      abilities: loadChannelFixture("Argus_3E", "ability-info.json"),
    });
    expect(caps.hasBattery).toBe(true);
    expect(caps.hasPowerSourceSwitch).toBe(false);
  });

  it("Reolink Video Doorbell WiFi fixture (wired, battery=0) → no power-source switch", () => {
    const caps = computeDeviceCapabilities({
      channel: 0,
      support: loadChannelFixture(
        "Reolink_Video_Doorbell_WiFi",
        "support-info.json",
      ),
      abilities: loadChannelFixture(
        "Reolink_Video_Doorbell_WiFi",
        "ability-info.json",
      ),
    });
    expect(caps.hasPowerSourceSwitch).toBe(false);
  });

  it("Reolink Video Doorbell fixture (battery doorbell, no batteryMode reported) → hint is false, probe required", () => {
    const support = loadChannelFixture(
      "Reolink_Video_Doorbell",
      "support-info.json",
    );
    const item = support.items.find(
      (i: any) => i.chnID === 0 && i.battery !== undefined,
    );
    // Regression guard: this firmware (v3.0.0.5298) simply never emits
    // batteryMode, so the capability hint cannot see the switch even though
    // the device is a battery doorbell. probePowerSourceSwitchSupport() is the
    // only way to know.
    expect(item.battery).toBe(2);
    expect(item.doorbellVersion).toBe(31);
    expect(item.batteryMode).toBeUndefined();

    const caps = computeDeviceCapabilities({
      channel: 0,
      support,
      abilities: loadChannelFixture(
        "Reolink_Video_Doorbell",
        "ability-info.json",
      ),
    });
    expect(caps.hasBattery).toBe(true);
    expect(caps.isDoorbell).toBe(true);
    expect(caps.hasPowerSourceSwitch).toBe(false);
  });

  it("Home Hub channel 3 fixture (battery=1, batteryMode=32) → power-source switch", () => {
    const support = JSON.parse(
      fs.readFileSync(
        path.join(MODELS, "Reolink_Home_Hub", "support-info.json"),
        "utf-8",
      ),
    );
    const caps = computeDeviceCapabilities({ channel: 3, support });
    expect(caps.hasBattery).toBe(true);
    expect(caps.hasPowerSourceSwitch).toBe(true);
  });
});
