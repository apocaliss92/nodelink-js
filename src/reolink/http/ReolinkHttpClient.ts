import { Agent } from "undici";
import { ReolinkCmdRequest, type LoginResponseValue, type ReolinkCmdResponse } from "./types.js";

export type ReolinkHttpClientOptions = {
  host: string;
  username: string;
  password: string;
  port?: number;
  useHttps?: boolean;
  /** Disable TLS verification for HTTPS (default: true, like reolink_aio). */
  insecureTLS?: boolean;
  timeoutMs?: number;
};

export class ReolinkHttpClient {
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private port: number | undefined;
  private useHttps: boolean | undefined;
  private readonly insecureTLS: boolean;
  private readonly timeoutMs: number;

  private token: string | undefined;
  private tokenExpiresAt: number | undefined; // epoch ms

  // `fetch` in Node usa `undici` e accetta `dispatcher`, ma le typings possono differire
  // tra `undici` e `undici-types` (Node). Manteniamo il tipo permissivo.
  private httpsAgent: unknown;

  constructor(opts: ReolinkHttpClientOptions) {
    this.host = opts.host;
    this.username = opts.username;
    this.password = opts.password;
    this.port = opts.port;
    this.useHttps = opts.useHttps;
    this.insecureTLS = opts.insecureTLS ?? true;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    if (this.insecureTLS) {
      this.httpsAgent = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  getToken(): string | undefined {
    return this.token;
  }

  clearToken(): void {
    this.token = undefined;
    this.tokenExpiresAt = undefined;
  }

  private baseUrl(): string {
    const scheme = this.useHttps ? "https" : "http";
    const port = this.port ?? (this.useHttps ? 443 : 80);
    return `${scheme}://${this.host}:${port}`;
  }

  private apiUrl(params: Record<string, string | number | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      qs.set(k, String(v));
    }
    return `${this.baseUrl()}/cgi-bin/api.cgi?${qs.toString()}`;
  }

  private isTokenValid(): boolean {
    if (!this.token || !this.tokenExpiresAt) return false;
    // margine 10s
    return Date.now() + 10_000 < this.tokenExpiresAt;
  }

  async login(): Promise<void> {
    if (this.isTokenValid()) return;

    const body: ReolinkCmdRequest[] = [
      {
        cmd: "Login",
        action: 0,
        param: {
          User: {
            userName: this.username,
            password: this.password,
          },
        },
      },
    ];

    const rsp = await this.sendJson<LoginResponseValue>(body, { cmd: "Login" }, { includeToken: false });
    const first = rsp[0];
    if (!first || first.code !== 0 || !first.value?.Token?.name) {
      throw new Error(`Login failed: ${JSON.stringify(rsp)}`);
    }
    const lease = Number(first.value.Token.leaseTime);
    const token = first.value.Token.name;
    this.token = token;
    this.tokenExpiresAt = Date.now() + (Number.isFinite(lease) ? lease * 1000 : 0);
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await this.call("Logout", { action: 0, param: {} });
    } finally {
      this.clearToken();
    }
  }

  async call<TValue = unknown, TParam = unknown>(
    cmd: string,
    opts?: { action?: number; param?: TParam; /** alcuni comandi sono host-level e non richiedono param */ },
  ): Promise<ReolinkCmdResponse<TValue>[]> {
    await this.login();
    const body: ReolinkCmdRequest<TParam>[] = [
      {
        cmd,
        action: opts?.action ?? 0,
        ...(opts && "param" in opts && opts.param !== undefined ? { param: opts.param } : {}),
      },
    ];
    return await this.sendJson<TValue>(body, { cmd, token: this.token }, { includeToken: true });
  }

  async callMany<TValue = unknown>(cmds: ReolinkCmdRequest[]): Promise<ReolinkCmdResponse<TValue>[]> {
    await this.login();
    return await this.sendJson<TValue>(cmds, { token: this.token }, { includeToken: true });
  }

  private async sendJson<TValue>(
    body: ReolinkCmdRequest[],
    query: Record<string, string | number | undefined>,
    _opts: { includeToken: boolean },
  ): Promise<ReolinkCmdResponse<TValue>[]> {
    const url = this.apiUrl(query);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const init: any = {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
      };
      if (this.useHttps && this.httpsAgent) init.dispatcher = this.httpsAgent as any;

      const res = await fetch(url, init as RequestInit);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const json = JSON.parse(text) as ReolinkCmdResponse<TValue>[];
      return json;
    } finally {
      clearTimeout(t);
    }
  }
}

