import { describe, it, expect } from "vitest";
import {
  getXmlText,
  applyXmlTagPatch,
  upsertXmlTag,
  patchNestedTag,
  applyStreamPatch,
} from "../../src/protocol/xml";

describe("xml.ts helpers (precompiled/cached RegExp behavior)", () => {
  describe("getXmlText", () => {
    it("extracts simple tag text", () => {
      expect(getXmlText("<a>hello</a>", "a")).toBe("hello");
      expect(getXmlText("<nonce>abc123</nonce>", "nonce")).toBe("abc123");
    });

    it("returns undefined when the tag is absent", () => {
      expect(getXmlText("<a>hello</a>", "b")).toBeUndefined();
    });

    it("matches the first occurrence", () => {
      expect(getXmlText("<x>1</x><x>2</x>", "x")).toBe("1");
    });

    it("does not match when text contains nested tags ([^<]* stops at '<')", () => {
      // <x>([^<]*)</x> cannot match because the inner '<' breaks the run before
      // the closing </x>. This documents the existing (intentional) semantics.
      expect(getXmlText("<x>a<b>c</b></x>", "x")).toBeUndefined();
    });

    it("is stable across repeated calls (shared cached regex)", () => {
      for (let i = 0; i < 5; i++) {
        expect(getXmlText("<tag>val</tag>", "tag")).toBe("val");
      }
    });
  });

  describe("applyXmlTagPatch", () => {
    it("replaces the first matching tag value", () => {
      expect(applyXmlTagPatch("<enable>0</enable>", "enable", 1)).toBe(
        "<enable>1</enable>",
      );
    });

    it("coerces booleans to 1/0", () => {
      expect(applyXmlTagPatch("<on>0</on>", "on", true)).toBe("<on>1</on>");
      expect(applyXmlTagPatch("<on>1</on>", "on", false)).toBe("<on>0</on>");
    });

    it("is a no-op when value is undefined", () => {
      expect(applyXmlTagPatch("<a>5</a>", "a", undefined)).toBe("<a>5</a>");
    });

    it("leaves the document untouched when the tag is missing", () => {
      expect(applyXmlTagPatch("<a>5</a>", "b", 9)).toBe("<a>5</a>");
    });

    it("repeated patches with the same tag are deterministic", () => {
      let xml = "<v>1</v>";
      xml = applyXmlTagPatch(xml, "v", 2);
      xml = applyXmlTagPatch(xml, "v", 3);
      expect(xml).toBe("<v>3</v>");
    });
  });

  describe("upsertXmlTag", () => {
    it("replaces an existing tag", () => {
      expect(upsertXmlTag("<a>1</a>", "a", 2)).toBe("<a>2</a>");
    });

    it("appends the tag when absent", () => {
      expect(upsertXmlTag("<a>1</a>", "b", 9)).toBe("<a>1</a><b>9</b>");
    });

    it("test()+replace() share a non-global regex without lastIndex drift", () => {
      // Calling twice must not be affected by any retained lastIndex.
      expect(upsertXmlTag("<x>1</x>", "x", 2)).toBe("<x>2</x>");
      expect(upsertXmlTag("<x>1</x>", "x", 2)).toBe("<x>2</x>");
    });
  });

  describe("patchNestedTag", () => {
    it("patches a child only inside the named parent", () => {
      const xml = "<DayNight><mode>0</mode></DayNight><Other><mode>9</mode></Other>";
      const out = patchNestedTag(xml, "DayNight", "mode", 1);
      expect(out).toBe(
        "<DayNight><mode>1</mode></DayNight><Other><mode>9</mode></Other>",
      );
    });

    it("handles parent tags with attributes", () => {
      const xml = '<P version="1.1"><c>0</c></P>';
      expect(patchNestedTag(xml, "P", "c", 7)).toBe(
        '<P version="1.1"><c>7</c></P>',
      );
    });

    it("is a no-op when value is undefined", () => {
      const xml = "<P><c>0</c></P>";
      expect(patchNestedTag(xml, "P", "c", undefined)).toBe(xml);
    });
  });

  describe("applyStreamPatch", () => {
    const doc =
      "<Compression>" +
      "<mainStream><audio>0</audio><width>1920</width><gop><cur>30</cur></gop></mainStream>" +
      "<subStream><audio>0</audio><width>640</width></subStream>" +
      "</Compression>";

    it("patches only the targeted stream block", () => {
      const out = applyStreamPatch(doc, "mainStream", { audio: 1, width: 2560 });
      expect(out).toContain("<mainStream><audio>1</audio><width>2560</width>");
      // subStream untouched.
      expect(out).toContain("<subStream><audio>0</audio><width>640</width>");
    });

    it("patches the gop <cur> value within the block", () => {
      const out = applyStreamPatch(doc, "mainStream", { gop: 60 });
      expect(out).toContain("<gop><cur>60</cur></gop>");
    });

    it("injects a gop block when missing on sub/third streams", () => {
      const out = applyStreamPatch(doc, "subStream", { gop: 15 });
      expect(out).toContain("<gop><cur>15</cur></gop>");
    });

    it("is a no-op when patch is undefined", () => {
      expect(applyStreamPatch(doc, "mainStream", undefined)).toBe(doc);
    });

    it("repeated calls on the same stream tag are stable (cached block regex)", () => {
      const a = applyStreamPatch(doc, "mainStream", { width: 1280 });
      const b = applyStreamPatch(doc, "mainStream", { width: 1280 });
      expect(a).toBe(b);
    });
  });
});

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
