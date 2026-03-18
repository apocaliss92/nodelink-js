import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";

/**
 * Tests for Frigate HTTP API client logic.
 * Uses a mock HTTP server — does NOT import app modules (avoids winston dependency).
 */

// Inline minimal Frigate client for testing (same logic as app/src/frigate-client.ts)
class TestFrigateClient {
  private baseUrl: string;
  private auth: string | undefined;

  constructor(opts: { host: string; username?: string; password?: string }) {
    this.baseUrl = opts.host.replace(/\/+$/, "");
    if (opts.username && opts.password) {
      this.auth = Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (this.auth) headers["Authorization"] = `Basic ${this.auth}`;
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  async ping() {
    try {
      const res = await this.request("/api/version");
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const text = await res.text();
      let version = text.trim();
      try { const parsed = JSON.parse(text); if (typeof parsed === "string") version = parsed; } catch {}
      return { ok: true, version };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async getConfig() {
    const res = await this.request("/api/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as Record<string, any>;
  }

  async getRawConfig() {
    const res = await this.request("/api/config/raw");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try { const parsed = JSON.parse(text); if (typeof parsed === "string") return parsed; } catch {}
    return text;
  }

  async getCameraNames() {
    const config = await this.getConfig();
    return Object.keys(config.cameras ?? {});
  }

  async getGo2rtcStreams() {
    const config = await this.getConfig();
    return config.go2rtc?.streams ?? {};
  }

  async saveRawConfig(yaml: string, restart = false) {
    const option = restart ? "restart" : "saveonly";
    const res = await this.request(`/api/config/save?save_option=${option}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    return { success: true };
  }

  async restart() {
    try {
      const res = await this.request("/api/restart", { method: "POST" });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}

describe("FrigateClient", () => {
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
      },
    },
    go2rtc: { streams: { ingresso_main: "rtsp://192.168.1.4:61692/xxxxx" } },
  };

  const mockRawYaml = `cameras:\n  ingresso:\n    enabled: true`;

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
        req.on("data", (c: Buffer) => (body += c));
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

  afterAll(() => { server?.close(); });

  it("pings successfully", async () => {
    const client = new TestFrigateClient({ host: `http://127.0.0.1:${port}` });
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.17.0-test");
  });

  it("gets config as JSON", async () => {
    const client = new TestFrigateClient({ host: `http://127.0.0.1:${port}` });
    const config = await client.getConfig();
    expect(config.cameras).toBeDefined();
    expect(config.cameras.ingresso).toBeDefined();
  });

  it("gets raw config as YAML string", async () => {
    const client = new TestFrigateClient({ host: `http://127.0.0.1:${port}` });
    const raw = await client.getRawConfig();
    expect(typeof raw).toBe("string");
    expect(raw).toContain("ingresso");
  });

  it("gets camera names", async () => {
    const client = new TestFrigateClient({ host: `http://127.0.0.1:${port}` });
    const names = await client.getCameraNames();
    expect(names).toContain("ingresso");
  });

  it("gets go2rtc streams", async () => {
    const client = new TestFrigateClient({ host: `http://127.0.0.1:${port}` });
    const streams = await client.getGo2rtcStreams();
    expect(streams.ingresso_main).toBeDefined();
  });

  it("saves raw config", async () => {
    const client = new TestFrigateClient({ host: `http://127.0.0.1:${port}` });
    const result = await client.saveRawConfig("test: yaml", false);
    expect(result.success).toBe(true);
  });

  it("restarts", async () => {
    const client = new TestFrigateClient({ host: `http://127.0.0.1:${port}` });
    const result = await client.restart();
    expect(result.success).toBe(true);
  });

  it("handles auth headers", async () => {
    const client = new TestFrigateClient({
      host: `http://127.0.0.1:${port}`,
      username: "admin",
      password: "secret",
    });
    const result = await client.ping();
    expect(result.ok).toBe(true);
  });

  it("handles connection failure gracefully", async () => {
    const client = new TestFrigateClient({ host: "http://127.0.0.1:1" });
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
