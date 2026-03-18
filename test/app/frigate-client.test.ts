import { describe, it, expect } from "vitest";
import * as http from "node:http";

describe("FrigateClient", () => {
  // Create a mock Frigate server for testing
  let server: http.Server;
  let port: number;

  const mockConfig = {
    cameras: {
      ingresso: {
        enabled: true,
        ffmpeg: {
          inputs: [
            { path: "rtsp://127.0.0.1:8554/ingresso_main", roles: ["record"] },
            { path: "rtsp://127.0.0.1:8554/ingresso_sub", roles: ["detect"] },
          ],
        },
        detect: { enabled: true, width: 640, height: 360 },
      },
    },
    go2rtc: {
      streams: {
        ingresso_main: "rtsp://192.168.1.4:61692/xxxxx",
      },
    },
  };

  const mockRawYaml = `cameras:
  ingresso:
    enabled: true
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/ingresso_main
          roles:
            - record
        - path: rtsp://127.0.0.1:8554/ingresso_sub
          roles:
            - detect`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/api/version") {
        res.end('"0.17.0-test"');
      } else if (req.url === "/api/config") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(mockConfig));
      } else if (req.url === "/api/config/raw") {
        res.end(JSON.stringify(mockRawYaml));
      } else if (req.url?.startsWith("/api/config/save")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: true }));
        });
      } else if (req.url === "/api/restart" && req.method === "POST") {
        res.end(JSON.stringify({ success: true }));
      } else {
        res.statusCode = 404;
        res.end("Not found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("pings successfully", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: `http://127.0.0.1:${port}` });
    const result = await client.ping();
    expect(result.ok).toBe(true);
    // Version comes as JSON string — client trims but may include quotes
    expect(result.version).toContain("0.17.0-test");
  });

  it("gets config as JSON", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: `http://127.0.0.1:${port}` });
    const config = await client.getConfig();
    expect(config.cameras).toBeDefined();
    expect(config.cameras.ingresso).toBeDefined();
  });

  it("gets raw config as YAML string", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: `http://127.0.0.1:${port}` });
    const raw = await client.getRawConfig();
    expect(typeof raw).toBe("string");
    expect(raw).toContain("ingresso");
  });

  it("gets camera names", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: `http://127.0.0.1:${port}` });
    const names = await client.getCameraNames();
    expect(names).toContain("ingresso");
  });

  it("gets go2rtc streams", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: `http://127.0.0.1:${port}` });
    const streams = await client.getGo2rtcStreams();
    expect(streams.ingresso_main).toBeDefined();
  });

  it("saves raw config", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: `http://127.0.0.1:${port}` });
    const result = await client.saveRawConfig("test: yaml", false);
    expect(result.success).toBe(true);
  });

  it("restarts", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: `http://127.0.0.1:${port}` });
    const result = await client.restart();
    expect(result.success).toBe(true);
  });

  it("handles auth headers", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({
      host: `http://127.0.0.1:${port}`,
      username: "admin",
      password: "secret",
    });
    const result = await client.ping();
    expect(result.ok).toBe(true);
  });

  it("handles connection failure gracefully", async () => {
    const { FrigateClient } = await import("../../app/src/frigate-client.js");
    const client = new FrigateClient({ host: "http://127.0.0.1:1" });
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
