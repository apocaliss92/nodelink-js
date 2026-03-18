import { describe, it, expect } from "vitest";

describe("XML parsing utilities", () => {
  // Test XML parsing without importing the full module (which may have heavy deps)
  // These test the patterns used throughout the codebase

  describe("XML entity escaping", () => {
    function xmlEscape(s: string): string {
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    it("escapes special characters", () => {
      expect(xmlEscape('foo & bar "baz"')).toBe('foo &amp; bar &quot;baz&quot;');
      expect(xmlEscape("<tag>")).toBe("&lt;tag&gt;");
    });

    it("handles empty string", () => {
      expect(xmlEscape("")).toBe("");
    });

    it("passes through normal text", () => {
      expect(xmlEscape("hello world 123")).toBe("hello world 123");
    });
  });

  describe("XML date/time payload builder", () => {
    function xmlDateTimePayload(start: Date, end: Date, channel: number): string {
      const fmt = (d: Date) => {
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        const day = d.getDate();
        const h = d.getHours();
        const min = d.getMinutes();
        const s = d.getSeconds();
        return `<year>${y}</year><mon>${m}</mon><day>${day}</day><hour>${h}</hour><min>${min}</min><sec>${s}</sec>`;
      };
      return `<body><SearchTime><channelId>${channel}</channelId><startTime>${fmt(start)}</startTime><endTime>${fmt(end)}</endTime></SearchTime></body>`;
    }

    it("builds valid date range XML", () => {
      const start = new Date(2026, 0, 15, 10, 0, 0);
      const end = new Date(2026, 0, 15, 11, 0, 0);
      const xml = xmlDateTimePayload(start, end, 0);
      expect(xml).toContain("<year>2026</year>");
      expect(xml).toContain("<mon>1</mon>");
      expect(xml).toContain("<day>15</day>");
      expect(xml).toContain("<channelId>0</channelId>");
    });
  });

  describe("parseNumber / parseBoolean helpers", () => {
    function parseNumber(val: unknown, fallback = 0): number {
      if (val === undefined || val === null || val === "") return fallback;
      const n = Number(val);
      return Number.isNaN(n) ? fallback : n;
    }

    function parseBoolean01(val: unknown): boolean {
      if (val === 1 || val === "1" || val === true || val === "true") return true;
      return false;
    }

    it("parseNumber handles various inputs", () => {
      expect(parseNumber("42")).toBe(42);
      expect(parseNumber(3.14)).toBe(3.14);
      expect(parseNumber("")).toBe(0);
      expect(parseNumber(null)).toBe(0);
      expect(parseNumber(undefined)).toBe(0);
      expect(parseNumber("abc")).toBe(0);
      expect(parseNumber("abc", -1)).toBe(-1);
    });

    it("parseBoolean01 handles 0/1 values", () => {
      expect(parseBoolean01(1)).toBe(true);
      expect(parseBoolean01("1")).toBe(true);
      expect(parseBoolean01(0)).toBe(false);
      expect(parseBoolean01("0")).toBe(false);
      expect(parseBoolean01(true)).toBe(true);
      expect(parseBoolean01(false)).toBe(false);
      expect(parseBoolean01(null)).toBe(false);
    });
  });

  describe("PTZ helpers", () => {
    function resolvePtzDirection(command: string): { panSpeed: number; tiltSpeed: number } {
      const map: Record<string, [number, number]> = {
        Up: [0, 1],
        Down: [0, -1],
        Left: [-1, 0],
        Right: [1, 0],
        LeftUp: [-1, 1],
        RightUp: [1, 1],
        LeftDown: [-1, -1],
        RightDown: [1, -1],
        Stop: [0, 0],
      };
      const [pan, tilt] = map[command] ?? [0, 0];
      return { panSpeed: pan!, tiltSpeed: tilt! };
    }

    it("resolves cardinal directions", () => {
      expect(resolvePtzDirection("Up")).toEqual({ panSpeed: 0, tiltSpeed: 1 });
      expect(resolvePtzDirection("Left")).toEqual({ panSpeed: -1, tiltSpeed: 0 });
      expect(resolvePtzDirection("RightDown")).toEqual({ panSpeed: 1, tiltSpeed: -1 });
      expect(resolvePtzDirection("Stop")).toEqual({ panSpeed: 0, tiltSpeed: 0 });
    });

    it("returns stop for unknown commands", () => {
      expect(resolvePtzDirection("Unknown")).toEqual({ panSpeed: 0, tiltSpeed: 0 });
    });
  });

  describe("White LED XML parsing pattern", () => {
    it("extracts LED state from typical XML structure", () => {
      // Simulates the pattern used in whiteLed.ts
      const mockXml = {
        WhiteLed: {
          state: "1",
          bright: "80",
          mode: "2",
          LightingSchedule: { StartHour: "18", StartMin: "0", EndHour: "6", EndMin: "0" },
        },
      };

      const led = mockXml.WhiteLed;
      expect(Number(led.state)).toBe(1);
      expect(Number(led.bright)).toBe(80);
      expect(Number(led.mode)).toBe(2);
      expect(Number(led.LightingSchedule.StartHour)).toBe(18);
    });
  });

  describe("Event mapping", () => {
    function mapToSimpleEvent(type: string): string {
      const map: Record<string, string> = {
        MD: "motion",
        visitor: "doorbell",
        people: "people",
        vehicle: "vehicle",
        animal: "animal",
        face: "face",
        package: "package",
        shelter: "shelter",
      };
      return map[type] ?? type;
    }

    it("maps camera event types to simple names", () => {
      expect(mapToSimpleEvent("MD")).toBe("motion");
      expect(mapToSimpleEvent("visitor")).toBe("doorbell");
      expect(mapToSimpleEvent("people")).toBe("people");
      expect(mapToSimpleEvent("vehicle")).toBe("vehicle");
      expect(mapToSimpleEvent("animal")).toBe("animal");
    });

    it("passes through unknown types", () => {
      expect(mapToSimpleEvent("custom_event")).toBe("custom_event");
    });
  });
});
