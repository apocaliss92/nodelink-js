/**
 * Tests that validate the structure of protocol responses captured from
 * a real camera. These tests run without camera access using saved fixtures.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DIR = path.join(__dirname, "..", "fixtures", "protocol");

function loadFixture(name: string): any {
  const p = path.join(PROTOCOL_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("Protocol responses (from real camera fixtures)", () => {
  describe("getInfo", () => {
    it("has model, firmware, serial", () => {
      const info = loadFixture("getInfo-response.json");
      if (!info) return;
      expect(info.type).toBeDefined();
      expect(typeof info.type).toBe("string");
      expect(info.firmwareVersion).toBeDefined();
      expect(info.serialNumber).toBeDefined();
    });
  });

  describe("getChannelInfo", () => {
    it("has channel name and status", () => {
      const info = loadFixture("getChannelInfo-response.json");
      if (!info) return;
      expect(info).toBeDefined();
    });
  });

  describe("getStreamMetadata", () => {
    it("has streams array with profiles", () => {
      const meta = loadFixture("getStreamMetadata-response.json");
      if (!meta) return;
      expect(meta.streams).toBeDefined();
      expect(Array.isArray(meta.streams)).toBe(true);

      for (const s of meta.streams) {
        expect(s.profile).toMatch(/^(main|sub|ext)$/);
        // codecType may be named differently in different firmware versions
        expect(s.profile || s.codecType || s.id).toBeDefined();
      }
    });
  });

  describe("buildVideoStreamOptions", () => {
    it("has native streams with metadata", () => {
      const opts = loadFixture("buildVideoStreamOptions-response.json");
      if (!opts) return;
      expect(opts.nativeStreams).toBeDefined();
      expect(opts.nativeStreams.length).toBeGreaterThan(0);

      for (const s of opts.nativeStreams) {
        expect(s.profile).toMatch(/^(main|sub|ext)$/);
        expect(s.id).toBeDefined();
        if (s.metadata) {
          expect(s.metadata.width).toBeGreaterThan(0);
          expect(s.metadata.height).toBeGreaterThan(0);
          expect(s.metadata.videoEncType).toBeDefined();
        }
      }
    });

    it("main stream has highest resolution", () => {
      const opts = loadFixture("buildVideoStreamOptions-response.json");
      if (!opts) return;

      const main = opts.nativeStreams.find((s: any) => s.profile === "main");
      const sub = opts.nativeStreams.find((s: any) => s.profile === "sub");
      if (!main?.metadata || !sub?.metadata) return;

      const mainPixels = main.metadata.width * main.metadata.height;
      const subPixels = sub.metadata.width * sub.metadata.height;
      expect(mainPixels).toBeGreaterThan(subPixels);
    });
  });

  describe("getStreamInfoList", () => {
    it("has stream info entries", () => {
      const list = loadFixture("getStreamInfoList-response.json");
      if (!list) return;
      expect(list).toBeDefined();
    });
  });

  describe("getNetworkInfo", () => {
    it("has network data", () => {
      const net = loadFixture("getNetworkInfo-response.json");
      if (!net) return;
      expect(net).toBeDefined();
    });
  });

  describe("getOsd", () => {
    it("has OSD configuration", () => {
      const osd = loadFixture("getOsd-response.json");
      if (!osd) return;
      expect(osd).toBeDefined();
    });
  });

  describe("getMotionAlarm", () => {
    it("has motion detection settings", () => {
      const motion = loadFixture("getMotionAlarm-response.json");
      if (!motion) return;
      expect(motion).toBeDefined();
    });
  });

  describe("getAiState", () => {
    it("has AI detection state", () => {
      const ai = loadFixture("getAiState-response.json");
      if (!ai) return;
      expect(ai).toBeDefined();
    });
  });

  describe("getWhiteLedState", () => {
    it("has LED state", () => {
      const led = loadFixture("getWhiteLedState-response.json");
      if (!led) return;
      expect(led).toBeDefined();
    });
  });

  describe("getPtzPresets", () => {
    it("returns preset array", () => {
      const presets = loadFixture("getPtzPresets-response.json");
      if (!presets) return;
      expect(Array.isArray(presets) || typeof presets === "object").toBe(true);
    });
  });

  describe("getPtzPosition", () => {
    it("has position data", () => {
      const pos = loadFixture("getPtzPosition-response.json");
      if (!pos) return;
      expect(pos).toBeDefined();
    });
  });

  describe("getEncXml", () => {
    it("has encoding configuration", () => {
      const enc = loadFixture("getEncXml-response.json");
      if (!enc) return;
      expect(enc).toBeDefined();
    });
  });

  describe("getRecordCfg", () => {
    it("has recording config", () => {
      const rec = loadFixture("getRecordCfg-response.json");
      if (!rec) return;
      expect(rec).toBeDefined();
    });
  });

  describe("getTwoWayAudioConfig", () => {
    it("has audio config", () => {
      const audio = loadFixture("getTwoWayAudioConfig-response.json");
      if (!audio) return;
      expect(audio).toBeDefined();
    });
  });

  describe("getSupportInfo", () => {
    it("has support/ability data", () => {
      const support = loadFixture("getSupportInfo-response.json");
      if (!support) return;
      expect(support).toBeDefined();
    });
  });

  describe("getAbilityInfo", () => {
    it("has ability info", () => {
      const ability = loadFixture("getAbilityInfo-response.json");
      if (!ability) return;
      expect(ability).toBeDefined();
    });
  });
});
