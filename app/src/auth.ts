import crypto from "node:crypto";
import type http from "node:http";
import { getSettings, saveSettings } from "./settings-store.js";
import { verifyPassword } from "./password.js";

export type AuthUser = {
  username: string;
  kind: "env-admin" | "settings" | "trusted-proxy";
  role: "admin" | "user";
};

export type AuthConfig = {
  enabled: boolean;
  adminUsername: string;
  hasAdminPassword: boolean;
};

export type AuthTokenType = "session" | "personal";

const SESSION_COOKIE_NAME = "nodelink_sid";
const AUTH_TOKEN_COOKIE_NAME = "nodelink_token";

const sessions = new Map<string, AuthUser>();

function getEnvAdminUsername(): string {
  return "admin";
}

function getEnvAdminPassword(): string | undefined {
  return process.env.ADMIN_PASSWORD || undefined;
}

function parseBoolEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

function normalizeRemoteIp(ip: string): string {
  // Handle IPv4-mapped IPv6 like ::ffff:127.0.0.1
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
}

type TrustedProxyConfig = {
  enabled: boolean;
  allowedIps: string[];
  usernameHeader: string;
  groupsHeader: string;
  adminGroup: string;
};

function getTrustedProxyConfig(): TrustedProxyConfig {
  const settings = getSettings();
  const cfg = settings.auth?.trustedProxy;

  const allowedIps =
    cfg?.allowedIps && cfg.allowedIps.length > 0
      ? cfg.allowedIps
      : ["127.0.0.1", "::1"];

  return {
    enabled: cfg?.enabled === true,
    allowedIps,
    usernameHeader: (cfg?.usernameHeader || "x-authentik-username")
      .trim()
      .toLowerCase(),
    groupsHeader: (cfg?.groupsHeader || "x-authentik-groups")
      .trim()
      .toLowerCase(),
    adminGroup: (cfg?.adminGroup || "admin").trim(),
  };
}

function getHeaderValue(
  req: http.IncomingMessage,
  headerNameLower: string,
): string | null {
  const v = req.headers[headerNameLower];
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) return (v[0] ?? "").trim() || null;
  return null;
}

function getUserFromTrustedProxy(req: http.IncomingMessage): AuthUser | null {
  const cfg = getTrustedProxyConfig();
  if (!cfg.enabled) return null;

  const remote = req.socket?.remoteAddress;
  if (!remote) return null;
  const remoteNorm = normalizeRemoteIp(remote);
  if (!cfg.allowedIps.includes(remoteNorm)) return null;

  const username = getHeaderValue(req, cfg.usernameHeader);
  if (!username) return null;

  const groupsRaw = getHeaderValue(req, cfg.groupsHeader);
  const groups = groupsRaw
    ? groupsRaw
        .split(/[,;]+/g)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const role = groups.includes(cfg.adminGroup) ? "admin" : "user";
  return { username, kind: "trusted-proxy", role };
}

export function getAuthConfig(): AuthConfig {
  const adminPassword = getEnvAdminPassword();

  // New env names (preferred): AUTH_ENABLED, ADMIN_PASSWORD
  const enabledRaw = process.env.AUTH_ENABLED;
  const enabledParsed = parseBoolEnv(enabledRaw);

  const enabled =
    enabledParsed !== null ? enabledParsed : Boolean(adminPassword);

  return {
    enabled,
    adminUsername: getEnvAdminUsername(),
    hasAdminPassword: Boolean(adminPassword),
  };
}

function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function parseBasicAuthHeader(
  authorization: string | undefined,
): { username: string; password: string } | null {
  if (!authorization) return null;
  const [scheme, encoded] = authorization.split(" ");
  if (!scheme || scheme.toLowerCase() !== "basic") return null;
  if (!encoded) return null;

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

function parseBearerAuthHeader(
  authorization: string | undefined,
): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  if (!token) return null;
  const t = token.trim();
  return t ? t : null;
}

function getTokenFromUrlQuery(urlRaw: string | undefined): string | null {
  if (!urlRaw) return null;
  try {
    const u = new URL(urlRaw, "http://localhost");
    const token = u.searchParams.get("token");
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isSameUser(a: unknown, b: AuthUser): boolean {
  const au = a as any;
  return au?.username === b.username && au?.kind === b.kind;
}

export function createAuthToken(user: AuthUser): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHashHex = sha256Hex(token);
  const settings = getSettings();
  const now = Date.now();
  const entry = {
    id: crypto.randomUUID(),
    tokenHashHex,
    type: "session" as AuthTokenType,
    user,
    createdAt: now,
  };

  const current = ((settings as any).authTokens ?? []) as any[];
  const next = [...current, entry];
  saveSettings({ authTokens: next } as any);
  return token;
}

export function createPersonalAuthToken(user: AuthUser): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHashHex = sha256Hex(token);
  const settings = getSettings();
  const now = Date.now();
  const entry = {
    id: crypto.randomUUID(),
    tokenHashHex,
    type: "personal" as AuthTokenType,
    user,
    createdAt: now,
  };

  const personalTokenEntry = {
    id: crypto.randomUUID(),
    user: { username: user.username, kind: user.kind },
    token,
    createdAt: now,
  };

  const current = ((settings as any).authTokens ?? []) as Array<any>;
  const nextAuthTokens = current
    .filter((t) => {
      const tu = t?.user;
      // Enforce a single valid token per user: generating a personal token
      // revokes any previous token (session or personal) for the same user.
      return !(tu?.username === user.username && tu?.kind === user.kind);
    })
    .concat(entry);

  const currentPersonal = ((settings as any).personalTokens ??
    []) as Array<any>;
  const nextPersonalTokens = currentPersonal
    .filter((t) => !isSameUser(t?.user, user))
    .concat(personalTokenEntry);

  saveSettings({
    authTokens: nextAuthTokens,
    personalTokens: nextPersonalTokens,
  } as any);
  return token;
}

export function getPersonalAuthTokenForUser(user: AuthUser): string | null {
  const settings = getSettings();

  const currentPersonal = ((settings as any).personalTokens ??
    []) as Array<any>;
  const stored = currentPersonal.find((t) => isSameUser(t?.user, user));
  const token = typeof stored?.token === "string" ? stored.token : null;
  if (!token) return null;

  // Ensure the stored token is actually valid (matches authTokens).
  const tokenHashHex = sha256Hex(token);
  const tokens = ((settings as any).authTokens ?? []) as Array<any>;
  const valid = tokens.some(
    (t) =>
      t?.tokenHashHex === tokenHashHex &&
      t?.user?.username === user.username &&
      t?.user?.kind === user.kind,
  );

  if (valid) return token;

  // Cleanup stale cleartext token entry.
  const nextPersonalTokens = currentPersonal.filter(
    (t) => !isSameUser(t?.user, user),
  );
  saveSettings({ personalTokens: nextPersonalTokens } as any);
  return null;
}

export function revokeAuthToken(token: string): boolean {
  const settings = getSettings();
  const tokenHashHex = sha256Hex(token);
  const current = ((settings as any).authTokens ?? []) as Array<{
    tokenHashHex: string;
  }>;
  const next = current.filter(
    (t) => !timingSafeEqualString(t.tokenHashHex, tokenHashHex),
  );
  if (next.length === current.length) return false;
  saveSettings({ authTokens: next } as any);
  return true;
}

function getUserFromToken(token: string): AuthUser | null {
  const settings = getSettings();
  const tokenHashHex = sha256Hex(token);
  const tokens = ((settings as any).authTokens ?? []) as Array<{
    tokenHashHex: string;
    user: AuthUser;
  }>;
  for (const t of tokens) {
    if (timingSafeEqualString(t.tokenHashHex, tokenHashHex)) return t.user;
  }
  return null;
}

export function getAuthTokenFromRequest(
  req: http.IncomingMessage,
): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[AUTH_TOKEN_COOKIE_NAME];
  return (
    parseBearerAuthHeader(req.headers.authorization) ??
    getTokenFromUrlQuery(req.url) ??
    (cookieToken && cookieToken.trim() ? cookieToken.trim() : null)
  );
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function verifyCredentials(input: {
  username: string;
  password: string;
}): AuthUser | null {
  // 1) Env admin
  const adminPassword = getEnvAdminPassword();
  const adminUsername = getEnvAdminUsername();
  if (
    adminPassword &&
    input.username === adminUsername &&
    timingSafeEqualString(input.password, adminPassword)
  ) {
    return { username: input.username, kind: "env-admin", role: "admin" };
  }

  // 2) Stored users
  const settings = getSettings();
  const users = (settings as any).dashboardUsers as
    | Array<{
        username: string;
        role?: "admin" | "user";
        passwordHash: string;
        passwordSalt: string;
      }>
    | undefined;

  const user = users?.find((u) => u.username === input.username);
  if (!user) return null;
  if (!verifyPassword(input.password, user.passwordSalt, user.passwordHash)) {
    return null;
  }

  return {
    username: input.username,
    kind: "settings",
    role: user.role === "admin" ? "admin" : "user",
  };
}

export function createSession(user: AuthUser): string {
  const sid = crypto.randomUUID();
  sessions.set(sid, user);
  return sid;
}

export function destroySession(sid: string | undefined) {
  if (!sid) return;
  sessions.delete(sid);
}

export function getSessionFromRequest(req: http.IncomingMessage): {
  sid: string | null;
  user: AuthUser | null;
} {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE_NAME];
  if (!sid) return { sid: null, user: null };
  const user = sessions.get(sid) ?? null;
  return { sid, user };
}

export function getUserFromRequest(req: http.IncomingMessage): AuthUser | null {
  const { user } = getSessionFromRequest(req);
  if (user) return user;

  const trusted = getUserFromTrustedProxy(req);
  if (trusted) return trusted;

  const token = getAuthTokenFromRequest(req);
  if (token) {
    const u = getUserFromToken(token);
    if (u) return u;
  }

  const basic = parseBasicAuthHeader(req.headers.authorization);
  if (!basic) return null;
  return verifyCredentials(basic);
}

export function setSessionCookie(
  res: { setHeader: (name: string, value: string | string[]) => void },
  sid: string,
  opts?: { isSecureRequest?: boolean },
) {
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  const secureEnv =
    process.env.COOKIE_SECURE ?? process.env.NODELINK_COOKIE_SECURE;
  const isSecureRequest = opts?.isSecureRequest === true;
  const shouldSecure =
    secureEnv === "1" ? true : secureEnv === "0" ? false : isSecureRequest;
  if (shouldSecure) cookie.push("Secure");

  res.setHeader("Set-Cookie", cookie.join("; "));
}

export function clearSessionCookie(
  res: {
    setHeader: (name: string, value: string | string[]) => void;
  },
  opts?: { isSecureRequest?: boolean },
) {
  const cookie = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  const secureEnv =
    process.env.COOKIE_SECURE ?? process.env.NODELINK_COOKIE_SECURE;
  const isSecureRequest = opts?.isSecureRequest === true;
  const shouldSecure =
    secureEnv === "1" ? true : secureEnv === "0" ? false : isSecureRequest;
  if (shouldSecure) cookie.push("Secure");
  res.setHeader("Set-Cookie", cookie.join("; "));
}

export function setAuthTokenCookie(
  res: { setHeader: (name: string, value: string | string[]) => void },
  token: string,
  opts?: { isSecureRequest?: boolean },
) {
  const cookie = [
    `${AUTH_TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  const secureEnv =
    process.env.COOKIE_SECURE ?? process.env.NODELINK_COOKIE_SECURE;
  const isSecureRequest = opts?.isSecureRequest === true;
  const shouldSecure =
    secureEnv === "1" ? true : secureEnv === "0" ? false : isSecureRequest;
  if (shouldSecure) cookie.push("Secure");

  res.setHeader("Set-Cookie", cookie.join("; "));
}

export function clearAuthTokenCookie(
  res: {
    setHeader: (name: string, value: string | string[]) => void;
  },
  opts?: { isSecureRequest?: boolean },
) {
  const cookie = [
    `${AUTH_TOKEN_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  const secureEnv =
    process.env.COOKIE_SECURE ?? process.env.NODELINK_COOKIE_SECURE;
  const isSecureRequest = opts?.isSecureRequest === true;
  const shouldSecure =
    secureEnv === "1" ? true : secureEnv === "0" ? false : isSecureRequest;
  if (shouldSecure) cookie.push("Secure");
  res.setHeader("Set-Cookie", cookie.join("; "));
}
