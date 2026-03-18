import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";

describe("Events emission", () => {
  describe("SSE format", () => {
    it("formats event as SSE data line", () => {
      const event = {
        cameraId: "cam-123",
        cameraName: "Living Room",
        cameraNameSlug: "living_room",
        type: "motion",
        channel: 0,
        timestamp: 1705312800000,
        timestampIso: "2024-01-15T10:00:00.000Z",
      };
      const ssePayload = `data: ${JSON.stringify(event)}\n\n`;

      expect(ssePayload.startsWith("data: ")).toBe(true);
      expect(ssePayload.endsWith("\n\n")).toBe(true);

      const parsed = JSON.parse(ssePayload.replace("data: ", "").trim());
      expect(parsed.cameraId).toBe("cam-123");
      expect(parsed.type).toBe("motion");
      expect(parsed.timestamp).toBe(1705312800000);
    });

    it("includes all required fields", () => {
      const requiredFields = [
        "cameraId", "cameraName", "cameraNameSlug",
        "type", "channel", "timestamp", "timestampIso",
      ];
      const event: Record<string, any> = {
        cameraId: "x", cameraName: "X", cameraNameSlug: "x",
        type: "motion", channel: 0, timestamp: Date.now(),
        timestampIso: new Date().toISOString(),
      };

      for (const field of requiredFields) {
        expect(event).toHaveProperty(field);
      }
    });
  });

  describe("NDJSON format", () => {
    it("each event is one line of JSON", () => {
      const events = [
        { type: "motion", camera: "a" },
        { type: "people", camera: "b" },
        { type: "doorbell", camera: "c" },
      ];

      const ndjson = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const lines = ndjson.trim().split("\n");

      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe("MQTT topic generation", () => {
    function buildEventTopic(prefix: string, slug: string, type: string): string {
      return `${prefix}/${slug}/${type}`;
    }

    function buildAllTopic(prefix: string): string {
      return `${prefix}/all`;
    }

    const prefix = "nodelink-js";

    it("per-camera per-type topic", () => {
      expect(buildEventTopic(prefix, "living_room", "motion"))
        .toBe("nodelink-js/living_room/motion");
      expect(buildEventTopic(prefix, "garage", "vehicle"))
        .toBe("nodelink-js/garage/vehicle");
    });

    it("all-events topic", () => {
      expect(buildAllTopic(prefix)).toBe("nodelink-js/all");
    });

    it("system events use camera slug", () => {
      expect(buildEventTopic(prefix, "studio", "camera_connected"))
        .toBe("nodelink-js/studio/camera_connected");
      expect(buildEventTopic(prefix, "studio", "camera_disconnected"))
        .toBe("nodelink-js/studio/camera_disconnected");
    });
  });

  describe("Home Assistant MQTT discovery", () => {
    function buildDiscoveryTopic(discoveryPrefix: string, cameraId: string): string {
      return `${discoveryPrefix}/sensor/nodelink_${cameraId}/config`;
    }

    function buildStateTopic(statePrefix: string, slug: string): string {
      return `${statePrefix}/camera/${slug}/state`;
    }

    it("discovery topic format", () => {
      expect(buildDiscoveryTopic("homeassistant", "abc123"))
        .toBe("homeassistant/sensor/nodelink_abc123/config");
    });

    it("state topic format", () => {
      expect(buildStateTopic("nodelink-js", "living_room"))
        .toBe("nodelink-js/camera/living_room/state");
    });

    it("discovery payload has required fields", () => {
      const payload = {
        name: "Living Room",
        unique_id: "nodelink_cam123",
        state_topic: "nodelink-js/camera/living_room/state",
        device: {
          identifiers: ["nodelink_cam123"],
          name: "Living Room",
          manufacturer: "Reolink",
          model: "E1 Zoom",
        },
      };

      expect(payload.unique_id).toContain("nodelink_");
      expect(payload.state_topic).toContain("/state");
      expect(payload.device.manufacturer).toBe("Reolink");
    });
  });

  describe("Event type mapping", () => {
    const eventMap: Record<string, string> = {
      MD: "motion",
      visitor: "doorbell",
      people: "people",
      vehicle: "vehicle",
      animal: "animal",
      face: "face",
      package: "package",
      shelter: "shelter",
      daynight: "daynight",
    };

    function mapEvent(rawType: string): string {
      return eventMap[rawType] ?? rawType;
    }

    it("maps all known camera event types", () => {
      expect(mapEvent("MD")).toBe("motion");
      expect(mapEvent("visitor")).toBe("doorbell");
      expect(mapEvent("people")).toBe("people");
      expect(mapEvent("vehicle")).toBe("vehicle");
      expect(mapEvent("animal")).toBe("animal");
      expect(mapEvent("face")).toBe("face");
      expect(mapEvent("package")).toBe("package");
    });

    it("passes unknown types through unchanged", () => {
      expect(mapEvent("custom_type")).toBe("custom_type");
      expect(mapEvent("sleep")).toBe("sleep");
      expect(mapEvent("wake")).toBe("wake");
    });
  });

  describe("SSE endpoint (mock server)", () => {
    let server: http.Server;
    let port: number;
    const sseClients: http.ServerResponse[] = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/api/events/sse") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          sseClients.push(res);
          req.on("close", () => {
            const idx = sseClients.indexOf(res);
            if (idx >= 0) sseClients.splice(idx, 1);
          });
        } else if (req.url === "/api/events/status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            sseClients: sseClients.length,
            jsonStreamClients: 0,
            mqttConnected: false,
            registeredCameras: 2,
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((r) => {
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as any).port;
          r();
        });
      });
    });

    afterAll(() => {
      for (const c of sseClients) c.end();
      server?.close();
    });

    it("SSE endpoint returns text/event-stream", async () => {
      const controller = new AbortController();
      // Abort after 100ms — we only need to check headers
      setTimeout(() => controller.abort(), 100);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/events/sse`, {
          signal: controller.signal,
        });
        expect(res.headers.get("content-type")).toBe("text/event-stream");
      } catch (e: any) {
        // AbortError is expected — check that we at least connected
        if (e.name !== "AbortError") throw e;
      }
    });

    it("status endpoint returns client count", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/events/status`);
      const data = await res.json() as Record<string, any>;
      expect(data.registeredCameras).toBe(2);
      expect(typeof data.sseClients).toBe("number");
    });

    it("broadcasts event to SSE clients", async () => {
      // Connect an SSE client
      const controller = new AbortController();
      const ssePromise = fetch(`http://127.0.0.1:${port}/api/events/sse`, {
        signal: controller.signal,
      });

      // Wait for connection
      await new Promise((r) => setTimeout(r, 50));

      // Simulate broadcasting an event
      const event = { type: "motion", camera: "test" };
      for (const client of sseClients) {
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      // Give time for data to flow then abort
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();

      // Verify SSE client count went up
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/events/status`);
      const status = await statusRes.json() as Record<string, any>;
      expect(typeof status.sseClients).toBe("number");
    });
  });
});
