/**
 * Frigate REST API client for configuration management.
 *
 * Endpoints used:
 *   GET  /api/config       — full config as JSON
 *   GET  /api/config/raw   — raw YAML text
 *   POST /api/config/save  — save config (JSON body, ?save_option=saveonly|restart)
 *   POST /api/restart      — restart Frigate
 *   GET  /api/version      — version string
 */

import { createSourceLogger } from "./logger.js";

const logger = createSourceLogger("frigate");

export interface FrigateClientOptions {
  host: string;
  username?: string;
  password?: string;
}

export class FrigateClient {
  private readonly baseUrl: string;
  private readonly auth: string | undefined;

  constructor(options: FrigateClientOptions) {
    // Normalize: strip trailing slash
    this.baseUrl = options.host.replace(/\/+$/, "");
    if (options.username && options.password) {
      this.auth = Buffer.from(
        `${options.username}:${options.password}`,
      ).toString("base64");
    }
  }

  private async request(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (this.auth) {
      headers["Authorization"] = `Basic ${this.auth}`;
    }
    const res = await fetch(url, { ...init, headers });
    return res;
  }

  /** Test connection to Frigate. */
  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await this.request("/api/version");
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const version = await res.text();
      return { ok: true, version: version.trim() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /** Get the full Frigate config as JSON. */
  async getConfig(): Promise<Record<string, any>> {
    const res = await this.request("/api/config");
    if (!res.ok) {
      throw new Error(`Failed to get Frigate config: HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, any>;
  }

  /**
   * Get the raw YAML config text.
   * Frigate returns the YAML as a JSON-encoded string (quoted with escaped \n),
   * so we JSON.parse() the response to get the actual YAML text.
   */
  async getRawConfig(): Promise<string> {
    const res = await this.request("/api/config/raw");
    if (!res.ok) {
      throw new Error(`Failed to get Frigate raw config: HTTP ${res.status}`);
    }
    const text = await res.text();
    // Frigate wraps the YAML in JSON string quotes — unwrap
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not JSON-wrapped — return as-is
    }
    return text;
  }

  /**
   * Save config to Frigate.
   * Frigate expects the full config as raw YAML text.
   * @param yamlText — full config as YAML string
   * @param restart — if true, Frigate restarts after saving
   */
  async saveRawConfig(
    yamlText: string,
    restart = false,
  ): Promise<{ success: boolean; error?: string }> {
    const option = restart ? "restart" : "saveonly";
    const res = await this.request(
      `/api/config/save?save_option=${option}`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: yamlText,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, error: `HTTP ${res.status}: ${body}` };
    }
    return { success: true };
  }

  /** Restart Frigate. */
  async restart(): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await this.request("/api/restart", { method: "POST" });
      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Get the list of cameras currently in the Frigate config.
   * Returns camera names as keys.
   */
  async getCameraNames(): Promise<string[]> {
    const config = await this.getConfig();
    const cameras = config.cameras;
    if (!cameras || typeof cameras !== "object") return [];
    return Object.keys(cameras);
  }

  /**
   * Get go2rtc streams currently configured in Frigate.
   */
  async getGo2rtcStreams(): Promise<Record<string, any>> {
    const config = await this.getConfig();
    return config.go2rtc?.streams ?? {};
  }
}

/** Create a FrigateClient from current settings. Throws if host is not configured. */
export function createFrigateClientFromSettings(frigateSettings: {
  host: string;
  username?: string;
  password?: string;
}): FrigateClient {
  if (!frigateSettings.host) {
    throw new Error("Frigate host is not configured. Set it in Settings → Frigate.");
  }
  return new FrigateClient({
    host: frigateSettings.host,
    username: frigateSettings.username || undefined,
    password: frigateSettings.password || undefined,
  });
}
