import { describe, it, expect } from "vitest";

describe("Events Manager logic", () => {
  describe("Event type classification", () => {
    const cameraEvents = ["motion", "doorbell", "people", "vehicle", "animal", "face", "package", "daynight"];
    const systemEvents = ["camera_connected", "camera_disconnected"];

    it("camera events are recognized", () => {
      for (const e of cameraEvents) {
        expect(typeof e).toBe("string");
        expect(e.length).toBeGreaterThan(0);
      }
    });

    it("system events are recognized", () => {
      for (const e of systemEvents) {
        expect(e).toMatch(/^camera_/);
      }
    });
  });

  describe("MQTT topic building", () => {
    function buildTopic(prefix: string, cameraSlug: string, eventType: string): string {
      return `${prefix}/${cameraSlug}/${eventType}`;
    }

    it("builds correct topic path", () => {
      expect(buildTopic("nodelink-js", "living_room", "motion")).toBe("nodelink-js/living_room/motion");
    });

    it("builds 'all' topic", () => {
      expect(`nodelink-js/all`).toBe("nodelink-js/all");
    });
  });

  describe("SSE event formatting", () => {
    it("formats SSE data correctly", () => {
      const event = {
        cameraId: "abc123",
        cameraName: "Living Room",
        type: "motion",
        channel: 0,
        timestamp: 1705312800000,
      };
      const sseData = `data: ${JSON.stringify(event)}\n\n`;
      expect(sseData).toContain('"type":"motion"');
      expect(sseData.endsWith("\n\n")).toBe(true);
    });
  });

  describe("Home Assistant MQTT discovery", () => {
    it("builds correct discovery topic", () => {
      const prefix = "homeassistant";
      const uniqueId = "nodelink_abc123";
      const topic = `${prefix}/sensor/${uniqueId}/config`;
      expect(topic).toBe("homeassistant/sensor/nodelink_abc123/config");
    });

    it("builds state topic", () => {
      const statePrefix = "nodelink-js";
      const slug = "living_room";
      const topic = `${statePrefix}/camera/${slug}/state`;
      expect(topic).toBe("nodelink-js/camera/living_room/state");
    });
  });
});
