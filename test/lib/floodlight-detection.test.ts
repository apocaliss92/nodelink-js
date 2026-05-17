import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  computeDeviceCapabilities,
  xmlIndicatesFloodlight,
} from "../../src/reolink/baichuan/capabilities";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "..", "fixtures", "models");

// Helper to load a model fixture file
function loadModelFixture(model: string, channel: number, file: string): string | undefined {
  const filePath = path.join(MODELS_DIR, model, "channels", String(channel), file);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function loadModelJson(model: string, channel: number, file: string): any {
  const raw = loadModelFixture(model, channel, file);
  return raw ? JSON.parse(raw) : undefined;
}

// ---------------------------------------------------------------------------
// xmlIndicatesFloodlight — pure XML probe logic
// ---------------------------------------------------------------------------
describe("xmlIndicatesFloodlight", () => {
  // ── Fixture-driven tests (real camera XML from test/fixtures/models/) ────

  describe("from model fixtures", () => {
    it("E560P (E1 Outdoor PoE) — has floodlight via FloodlightTask", () => {
      const xml = loadModelFixture("E1_Outdoor_PoE", 0, "cmd289-white-led.xml");
      expect(xml).toBeDefined();
      expect(xmlIndicatesFloodlight(xml!)).toBe(true);
    });

    it("E340 (E1 Zoom) — has FloodlightTask but lightType=0 overrides", () => {
      const xml = loadModelFixture("E1_Zoom", 0, "cmd289-white-led.xml");
      expect(xml).toBeDefined();
      // The XML contains <FloodlightTask> so the probe itself returns true,
      // but the caller (getDeviceCapabilities) uses lightType=0 as authoritative.
      expect(xmlIndicatesFloodlight(xml!)).toBe(true);
    });

    it("Argus PT Ultra — has floodlight via FloodlightTask", () => {
      const xml = loadModelFixture("Argus_PT_Ultra", 0, "cmd289-white-led.xml");
      expect(xml).toBeDefined();
      expect(xmlIndicatesFloodlight(xml!)).toBe(true);
    });

    it("D340W (Video Doorbell WiFi) — bare WhiteLed, NO floodlight", () => {
      const xml = loadModelFixture("D340W", 0, "cmd289-white-led.xml");
      expect(xml).toBeDefined();
      expect(xmlIndicatesFloodlight(xml!)).toBe(false);
    });
  });

  // ── Synthetic tests ─────────────────────────────────────────────────────

  describe("synthetic XML patterns", () => {
    it("accepts WhiteLed with <bright> and <LightingSchedule> as floodlight", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body><WhiteLed version="1.1"><channel>0</channel><state>1</state>
<bright>80</bright><mode>2</mode>
<LightingSchedule><StartHour>18</StartHour><StartMin>0</StartMin>
<EndHour>6</EndHour><EndMin>0</EndMin></LightingSchedule>
</WhiteLed></body>`;
      expect(xmlIndicatesFloodlight(xml)).toBe(true);
    });

    it("accepts WhiteLed with <brightness_cur> as floodlight", () => {
      const xml = `<body><WhiteLed><channel>0</channel><state>1</state><brightness_cur>75</brightness_cur></WhiteLed></body>`;
      expect(xmlIndicatesFloodlight(xml)).toBe(true);
    });

    it("detects FloodlightManual tag", () => {
      const xml = `<body><FloodlightManual><channel>0</channel><status>0</status><duration>180</duration></FloodlightManual></body>`;
      expect(xmlIndicatesFloodlight(xml)).toBe(true);
    });

    it("detects FloodlightStatusList tag", () => {
      const xml = `<body><FloodlightStatusList><channel>0</channel></FloodlightStatusList></body>`;
      expect(xmlIndicatesFloodlight(xml)).toBe(true);
    });

    it("returns false for empty/unrelated XML", () => {
      expect(xmlIndicatesFloodlight("")).toBe(false);
      expect(xmlIndicatesFloodlight("<body><OtherTag/></body>")).toBe(false);
    });

    it("returns false for empty body", () => {
      expect(xmlIndicatesFloodlight(`<?xml version="1.0" encoding="UTF-8" ?><body></body>`)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// computeDeviceCapabilities — fixture-driven tests
// ---------------------------------------------------------------------------
describe("computeDeviceCapabilities — from model fixtures", () => {
  // E340 (E1 Zoom) — no floodlight (lightType=0)
  describe("E340 (E1 Zoom)", () => {
    const caps = loadModelJson("E1_Zoom", 0, "capabilities.json");

    it("fixture exists", () => {
      expect(caps).toBeDefined();
    });

    it("hasFloodlight is false (lightType=0)", () => {
      expect(caps?.capabilities?.hasFloodlight).toBe(false);
    });

    it("hasPtz is true", () => {
      expect(caps?.capabilities?.hasPtz).toBe(true);
    });

    it("hasAutotracking is true", () => {
      expect(caps?.capabilities?.hasAutotracking).toBe(true);
    });
  });

  // E560P (E1 Outdoor PoE) — has floodlight
  describe("E560P (E1 Outdoor PoE)", () => {
    const caps = loadModelJson("E1_Outdoor_PoE", 0, "capabilities.json");

    it("fixture exists", () => {
      expect(caps).toBeDefined();
    });

    it("hasFloodlight is true", () => {
      expect(caps?.capabilities?.hasFloodlight).toBe(true);
    });
  });

  // D340W (Video Doorbell WiFi) — firmware exposes the doorbell LED ring as
  // a controllable "floodlight" via cmd 289 + ledCtrl bitmask (= 35840). The
  // previous assertion (no floodlight) reflected an outdated assumption that
  // pre-dated the ledCtrl rescue path; PR #24 contributor confirms the camera
  // has a light, and capabilities.json captured from a live D340W reports
  // `hasFloodlight: true`. See `floodlight-detection-ledctrl.test.ts`.
  describe("D340W (Video Doorbell WiFi)", () => {
    // D340W doesn't have full capabilities.json from the device,
    // so we test computeDeviceCapabilities directly
    const supportItem = loadModelJson("D340W", 0, "support-item.json");
    const deviceInfo = loadModelJson("D340W", 0, "device-info.json");

    it("fixtures exist", () => {
      expect(supportItem).toBeDefined();
      expect(deviceInfo).toBeDefined();
    });

    it("hasFloodlight is true (no lightType, but ledCtrl=35840 indicates controllable LED)", () => {
      const support = {
        ptzMode: "none",
        channelNum: 1,
        audioNum: 1,
        audioTalk: 1,
        items: [
          { chnID: 0, name: "googleHome", ver: 1 },
          { chnID: 0, name: "amazonAlexa", ver: 1 },
          supportItem,
        ],
      };
      const abilities = {
        "0": {
          preview_rw: 1, compress_rw: 1, snap_rw: 1, rtsp_rw: 1,
          streamTable_ro: 1, motion_rw: 1, osdName_rw: 1, osdTime_rw: 1,
          shelter_rw: 1, ispBasic_rw: 1, ispAdvance_rw: 1, ledState_rw: 1,
        },
        Host: {
          general_rw: 1, norm_rw: 1, version_ro: 1, uid_ro: 1,
          autoReboot_rw: 1, restore_rw: 1, reboot_rw: 1, shutdown_rw: 1,
          dst_rw: 1, log_ro: 1, performance_ro: 1, upgrade_rw: 1,
          export_rw: 1, import_rw: 1, bootPwd_rw: 1, control_rw: 1,
          preset_rw: 1, cruise_rw: 1, track_rw: 1, decoder_rw: 1,
          ptzInfo_ro: 1, user_rw: 1, userOnline_rw: 1, port_rw: 1,
          dns_rw: 1, email_rw: 1, ftp_rw: 1, ftpSchedule_rw: 1,
          ipFilter_rw: 1, localLink_rw: 1, pppoe_rw: 1, upnp_rw: 1,
          wifi_rw: 1, ntp_rw: 1, netStatus_rw: 1, ptop_rw: 1,
          autontp_rw: 1, userName: "admin",
        },
      };

      const caps = computeDeviceCapabilities({
        channel: 0,
        support: support as any,
        abilities: abilities as any,
        model: deviceInfo.type,
      });

      expect(caps.hasFloodlight).toBe(true);
      expect(caps.isDoorbell).toBe(true);
      expect(caps.hasIntercom).toBe(true);
      expect(caps.hasSiren).toBe(true);
      expect(caps.hasBattery).toBe(false);
      expect(caps.hasPtz).toBe(false);
    });
  });

  // RLC-510WA — fixed camera, NO PTZ despite ptzControl=64 and Host abilities
  describe("RLC-510WA", () => {
    const caps = loadModelJson("RLC-510WA", 0, "capabilities.json");

    it("fixture exists", () => {
      expect(caps).toBeDefined();
    });

    it("hasPtz is false (ptzType=0, ptzMode=none — ptzControl=64 is NOT physical PTZ)", () => {
      const result = computeDeviceCapabilities({
        channel: 0,
        support: caps?.support,
        abilities: caps?.abilities,
      });
      expect(result.hasPtz).toBe(false);
      expect(result.hasPan).toBe(false);
      expect(result.hasTilt).toBe(false);
      expect(result.hasPresets).toBe(false);
    });

    it("hasFloodlight is false (lightType=0)", () => {
      expect(caps?.capabilities?.hasFloodlight).toBe(false);
    });
  });

  // Argus PT Ultra (behind Hub, but stored as standalone model)
  describe("Argus PT Ultra", () => {
    const caps = loadModelJson("Argus_PT_Ultra", 0, "capabilities.json");

    it("fixture exists", () => {
      expect(caps).toBeDefined();
    });

    it("hasFloodlight is true (NVR path: ledCtrl>0)", () => {
      expect(caps?.capabilities?.hasFloodlight).toBe(true);
    });

    it("hasBattery is true", () => {
      expect(caps?.capabilities?.hasBattery).toBe(true);
    });
  });

  // Argus PT Plus — battery-powered pan/tilt (no zoom, no presets),
  // H.264 main 2560x1440 + sub 896x512, floodlight + siren + PIR + intercom,
  // AI: people + vehicle, no wireless chime, no autotracking.
  describe("Argus PT Plus", () => {
    const caps = loadModelJson("Argus_PT_Plus", 0, "capabilities.json");

    it("fixture exists", () => {
      expect(caps).toBeDefined();
    });

    it("computeDeviceCapabilities from support+abilities returns expected values", () => {
      // Round-trip validation: computing capabilities from the raw
      // SupportInfo + DeviceAbilities must produce the expected detection
      // for this camera class. Note: `hasFloodlight` is NOT checked here
      // because the Argus PT Plus SupportItem has no `lightType` — the
      // final value is determined at runtime by a cmd 289 probe
      // (see ReolinkBaichuanApi.getDeviceCapabilities). The stored
      // capabilities.json reflects that post-processed value and is
      // asserted in the next test.
      const result = computeDeviceCapabilities({
        channel: 0,
        support: caps?.support,
        abilities: caps?.abilities,
      });
      expect(result.hasPtz).toBe(true);
      expect(result.hasPan).toBe(true);
      expect(result.hasTilt).toBe(true);
      expect(result.hasZoom).toBe(false);
      expect(result.hasPresets).toBe(false);
      expect(result.hasBattery).toBe(true);
      expect(result.hasSiren).toBe(true);
      expect(result.hasPir).toBe(true);
      expect(result.hasIntercom).toBe(true);
      expect(result.isDoorbell).toBe(false);
      expect(result.hasAutotracking).toBe(false);
      expect(result.hasWirelessChime).toBe(false);
      expect(result.ptzMode).toBe("pt");
    });

    it("stored capabilities reflect battery + pan/tilt + floodlight", () => {
      expect(caps?.capabilities?.hasBattery).toBe(true);
      expect(caps?.capabilities?.hasPtz).toBe(true);
      expect(caps?.capabilities?.hasZoom).toBe(false);
      expect(caps?.capabilities?.hasFloodlight).toBe(true);
      expect(caps?.capabilities?.hasPir).toBe(true);
    });

    it("supports people + vehicle AI detection (aitype 3687)", () => {
      const supportItem = caps?.support?.items?.find(
        (i: any) => i?.chnID === 0 && i?.aitype !== undefined,
      );
      expect(supportItem?.aitype).toBe(3687);
      expect(caps?.objects).toContain("people");
      expect(caps?.objects).toContain("vehicle");
    });

    it("exposes main + sub H.264 streams with expected resolutions", () => {
      const meta = loadModelJson("Argus_PT_Plus", 0, "stream-metadata.json");
      expect(meta).toBeDefined();
      const main = meta.streams.find((s: any) => s.profile === "main");
      const sub = meta.streams.find((s: any) => s.profile === "sub");
      expect(main).toMatchObject({
        width: 2560,
        height: 1440,
        videoEncType: "H.264",
      });
      expect(sub).toMatchObject({
        width: 896,
        height: 512,
        videoEncType: "H.264",
      });
    });

    it("stream combination test behaves as expected on a single-lens battery PT", () => {
      const combo = loadModelJson("Argus_PT_Plus", 0, "stream-combination-test.json");
      expect(combo).toBeDefined();
      expect(combo.isMultifocal).toBe(false);
      expect(combo.channelCount).toBe(1);
      // Library invariant: different streamTypes may run concurrently,
      // same streamType on the same channel must not. Every captured pair
      // must match its predicted outcome.
      expect(combo.summary.matchesExpected).toBe(combo.summary.total);
      expect(combo.summary.unexpected).toEqual([]);

      const byPair = (a: string, b: string) =>
        combo.results.find(
          (r: any) => (r.pair?.[0] === a && r.pair?.[1] === b) || (r.pair?.[0] === b && r.pair?.[1] === a),
        );
      expect(byPair("main", "sub")?.ok).toBe(true);
      expect(byPair("sub", "ext")?.ok).toBe(true);
      expect(byPair("main", "ext")?.ok).toBe(false);
    });

    it("is not a dual-lens device", () => {
      const dual = loadModelJson("Argus_PT_Plus", 0, "dual-lens-info.json");
      expect(dual?.isDualLens).toBe(false);
      expect(dual?.streamChannelCount).toBe(1);
    });

    it("has cmd289 WhiteLed XML that indicates floodlight", () => {
      const xml = loadModelFixture("Argus_PT_Plus", 0, "cmd289-white-led.xml");
      expect(xml).toBeDefined();
      expect(xmlIndicatesFloodlight(xml!)).toBe(true);
    });
  });
});
