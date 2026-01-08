import { Agent } from "undici";
import { ReolinkCmdRequest, type LoginResponseValue, type ReolinkCmdResponse } from "./types";

export type ReolinkHttpClientOptions = {
  host: string;
  username: string;
  password: string;
  port?: number;
  useHttps?: boolean;
  /** Disable TLS verification for HTTPS (default: true). */
  insecureTLS?: boolean;
  timeoutMs?: number;
};

export class ReolinkHttpClient {
  private static readonly sessionPool = new Map<
    string,
    {
      token?: string;
      tokenExpiresAt?: number;
      loginInFlight?: Promise<void>;
    }
  >();

  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private port: number | undefined;
  private useHttps: boolean | undefined;
  private readonly insecureTLS: boolean;
  private readonly timeoutMs: number;

  private token: string | undefined;
  private tokenExpiresAt: number | undefined; // epoch ms

  // `fetch` in Node uses `undici` and accepts `dispatcher`, but typings may differ
  // between `undici` and `undici-types` (Node). We keep a permissive type.
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

  getUsername(): string {
    return this.username;
  }

  getToken(): string | undefined {
    return this.token;
  }

  clearToken(): void {
    this.token = undefined;
    this.tokenExpiresAt = undefined;
  }

  private sessionKey(): string {
    const scheme = this.useHttps ? "https" : "http";
    const port = this.port ?? (this.useHttps ? 443 : 80);
    // Token is bound to host + user session. We intentionally do NOT include password here;
    // a password change should be handled by consumer recreating the client or by logout.
    return `${scheme}://${this.host}:${port}|${this.username}`;
  }

  private getSharedSession(): { token?: string; tokenExpiresAt?: number; loginInFlight?: Promise<void> } {
    const key = this.sessionKey();
    const existing = ReolinkHttpClient.sessionPool.get(key);
    if (existing) return existing;
    const created: { token?: string; tokenExpiresAt?: number; loginInFlight?: Promise<void> } = {};
    ReolinkHttpClient.sessionPool.set(key, created);
    return created;
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

  private isSharedTokenValid(shared: { token?: string; tokenExpiresAt?: number }): boolean {
    if (!shared.token || !shared.tokenExpiresAt) return false;
    return Date.now() + 10_000 < shared.tokenExpiresAt;
  }

  private async performLogin(): Promise<void> {
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
    const expiresAt = Date.now() + (Number.isFinite(lease) ? lease * 1000 : 0);

    this.token = token;
    this.tokenExpiresAt = expiresAt;

    const shared = this.getSharedSession();
    shared.token = token;
    shared.tokenExpiresAt = expiresAt;
  }

  async login(): Promise<void> {
    if (this.isTokenValid()) return;

    const shared = this.getSharedSession();
    if (this.isSharedTokenValid(shared)) {
      this.token = shared.token;
      this.tokenExpiresAt = shared.tokenExpiresAt;
      return;
    }

    if (shared.loginInFlight) {
      await shared.loginInFlight;
      if (this.isSharedTokenValid(shared)) {
        this.token = shared.token;
        this.tokenExpiresAt = shared.tokenExpiresAt;
      }
      return;
    }

    shared.loginInFlight = (async () => {
      try {
        await this.performLogin();
      } finally {
        delete shared.loginInFlight;
      }
    })();

    await shared.loginInFlight;
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await this.call("Logout", { action: 0, param: {} });
    } finally {
      this.clearToken();

      const shared = this.getSharedSession();
      delete shared.token;
      delete shared.tokenExpiresAt;
    }
  }

  async call<TValue = unknown, TParam = unknown>(
    cmd: string,
    opts?: { action?: number; param?: TParam; /** Some commands are host-level and do not require a param */ },
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
    // Extract cmd from first request for query string (like reolink_aio does)
    const cmd = cmds[0]?.cmd;
    const query: Record<string, string | number | undefined> = { token: this.token };
    if (cmd) query.cmd = cmd;
    return await this.sendJson<TValue>(cmds, query, { includeToken: true });
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

  /**
   * Take a snapshot via CGI `cmd=Snap` and return the raw JPEG bytes.
   *
   * This is a binary endpoint (not JSON). Requires a valid token.
   */
  async snap(channel: number, opts?: { timeoutMs?: number; rs?: string }): Promise<Buffer> {
    await this.login();
    if (!this.token) throw new Error("Missing token after login");

    const rs = opts?.rs ?? Date.now().toString();
    const url = this.apiUrl({
      cmd: "Snap",
      channel,
      rs,
      token: this.token,
    });

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), opts?.timeoutMs ?? this.timeoutMs);
    try {
      const init: any = {
        method: "GET",
        signal: ac.signal,
      };
      if (this.useHttps && this.httpsAgent) init.dispatcher = this.httpsAgent as any;

      const res = await fetch(url, init as RequestInit);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Download a VOD/recording via CGI `cmd=Download`.
   *
   * Uses POST with a dummy JSON body and query params.
   * Returns the raw binary payload (often mp4).
   */
  async downloadVod(source: string, output?: string, start?: string): Promise<Buffer> {
    await this.login();
    if (!this.token) throw new Error("Missing token after login");

    // NOTE: Do NOT URL-encode '/' in `source`. Many Reolink firmwares expect raw paths
    // like "/mnt/sda/..." and return 404 when `%2F` is used. Only encode spaces.
    const scheme = this.useHttps ? "https" : "http";
    const port = this.port ?? (this.useHttps ? 443 : 80);
    const sourceForQuery = source.replaceAll(" ", "%20");
    const outputForQuery = output ? encodeURIComponent(output) : undefined;
    const startForQuery = start ? encodeURIComponent(start) : undefined;
    const tokenForQuery = encodeURIComponent(this.token);
    const url = `${scheme}://${this.host}:${port}/cgi-bin/api.cgi?cmd=Download&source=${sourceForQuery}${outputForQuery ? `&output=${outputForQuery}` : ""}${startForQuery ? `&start=${startForQuery}` : ""}&token=${tokenForQuery}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const init: any = {
        method: "POST",
        body: "[{}]",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
      };
      if (this.useHttps && this.httpsAgent) init.dispatcher = this.httpsAgent as any;

      const res = await fetch(url, init as RequestInit);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(t);
    }
  }
}

