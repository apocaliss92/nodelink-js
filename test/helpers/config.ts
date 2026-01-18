import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config();

export type DeviceKind = "battery" | "nonBattery" | "unknown";
export type IntegrationSuiteName =
  | "core"
  | "events"
  | "eventsArtifacts"
  | "streams"
  | "ptzReadOnly"
  | "whiteLedReadOnly"
  | "pirReadOnly"
  | "aiReadOnly"
  | "battery"
  | "nvrSummary";

export type Transport = "tcp" | "udp";

export type DeviceConfigBase = {
  host: string;
  channel?: number;
  usernameEnv?: string;
  passwordEnv?: string;
  timeoutMs?: number;
  suites?: IntegrationSuiteName[];
};

export type StandaloneTcpDeviceConfig = DeviceConfigBase & {
  transport?: "tcp";
};

export type StandaloneUdpDeviceConfig = DeviceConfigBase & {
  transport?: "udp";
  uid: string;
  udpDiscoveryMethod?: "map" | "probe";
};

export type NvrDeviceConfig = DeviceConfigBase & {
  transport?: "tcp";
  channels?: Record<string, { kind: DeviceKind }>;
};

export type IntegrationConfig = {
  defaults?: {
    usernameEnv?: string;
    passwordEnv?: string;
    timeoutMs?: number;
  };
  standalone?: {
    tcp?: StandaloneTcpDeviceConfig;
    udp?: StandaloneUdpDeviceConfig;
  };
  nvr?: NvrDeviceConfig;
};

const expandEnvString = (input: string): string => {
  // Supports:
  // - "${VAR}" -> replaced with process.env.VAR or "" if missing
  // - "${VAR:-default}" -> replaced with env or default
  // - "$VAR" (only when the whole string matches) -> replaced with env or ""
  const wholeDollarVar = /^\$([A-Z0-9_]+)$/;
  const m = wholeDollarVar.exec(input);
  if (m) {
    return process.env[m[1]!] ?? "";
  }

  const pattern = /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g;
  return input.replace(pattern, (_full, varName: string, defaultValue: string | undefined) => {
    const value = process.env[varName];
    if (value != null && value !== "") return value;
    return defaultValue ?? "";
  });
};

const expandEnvInUnknown = (value: unknown): unknown => {
  if (typeof value === "string") return expandEnvString(value);
  if (Array.isArray(value)) return value.map(expandEnvInUnknown);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvInUnknown(v);
    }
    return out;
  }
  return value;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asStringArray = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined);

export const loadIntegrationConfig = async (): Promise<IntegrationConfig | undefined> => {
  const configPath = process.env.REOLINK_TEST_CONFIG ?? "test/devices.config.json";
  const abs = resolve(process.cwd(), configPath);

  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Allow embedding env var placeholders inside the JSON.
  // Example: { "host": "${REOLINK_TCP_HOST}" }
  parsed = expandEnvInUnknown(parsed);

  if (!isRecord(parsed)) {
    throw new Error(`Invalid config root (expected object) in ${configPath}`);
  }

  const defaultsRaw = isRecord(parsed.defaults) ? parsed.defaults : undefined;
  const defaults = defaultsRaw
    ? {
        ...(asString(defaultsRaw.usernameEnv) ? { usernameEnv: String(defaultsRaw.usernameEnv) } : {}),
        ...(asString(defaultsRaw.passwordEnv) ? { passwordEnv: String(defaultsRaw.passwordEnv) } : {}),
        ...(asNumber(defaultsRaw.timeoutMs) != null ? { timeoutMs: Number(defaultsRaw.timeoutMs) } : {}),
      }
    : undefined;

  const coerceDeviceBase = (rawDev: unknown): DeviceConfigBase | undefined => {
    if (!isRecord(rawDev)) return undefined;
    const host = asString(rawDev.host);
    if (!host) return undefined;
    return {
      host,
      ...(asNumber(rawDev.channel) != null ? { channel: Number(rawDev.channel) } : {}),
      ...(asString(rawDev.usernameEnv) ? { usernameEnv: String(rawDev.usernameEnv) } : {}),
      ...(asString(rawDev.passwordEnv) ? { passwordEnv: String(rawDev.passwordEnv) } : {}),
      ...(asNumber(rawDev.timeoutMs) != null ? { timeoutMs: Number(rawDev.timeoutMs) } : {}),
      ...(asStringArray(rawDev.suites) ? { suites: rawDev.suites as IntegrationSuiteName[] } : {}),
    };
  };

  const standaloneRaw = isRecord(parsed.standalone) ? parsed.standalone : undefined;

  const tcpBase = standaloneRaw ? coerceDeviceBase(standaloneRaw.tcp) : undefined;
  const tcp: StandaloneTcpDeviceConfig | undefined = tcpBase ? { ...tcpBase, transport: "tcp" } : undefined;

  const udpBase = standaloneRaw ? coerceDeviceBase(standaloneRaw.udp) : undefined;
  let udp: StandaloneUdpDeviceConfig | undefined;
  if (udpBase && isRecord(standaloneRaw?.udp)) {
    const uid = asString((standaloneRaw.udp as Record<string, unknown>).uid);
    if (uid) {
      const method = asString((standaloneRaw.udp as Record<string, unknown>).udpDiscoveryMethod);
      udp = {
        ...udpBase,
        transport: "udp",
        uid,
        ...(method === "map" || method === "probe" ? { udpDiscoveryMethod: method } : {}),
      };
    }
  }

  const nvrBase = coerceDeviceBase(parsed.nvr);
  let nvr: NvrDeviceConfig | undefined;
  if (nvrBase && isRecord(parsed.nvr)) {
    const channelsRaw = (parsed.nvr as Record<string, unknown>).channels;
    const channels: Record<string, { kind: DeviceKind }> = {};
    if (isRecord(channelsRaw)) {
      for (const [k, v] of Object.entries(channelsRaw)) {
        if (!isRecord(v)) continue;
        const kind = asString(v.kind);
        if (kind === "battery" || kind === "nonBattery" || kind === "unknown") {
          channels[k] = { kind };
        }
      }
    }

    nvr = {
      ...nvrBase,
      transport: "tcp",
      ...(Object.keys(channels).length ? { channels } : {}),
    };
  }

  return {
    ...(defaults ? { defaults } : {}),
    standalone: {
      ...(tcp ? { tcp } : {}),
      ...(udp ? { udp } : {}),
    },
    ...(nvr ? { nvr } : {}),
  };
};

export const resolveCreds = (cfg: IntegrationConfig, dev?: DeviceConfigBase): { username: string; password: string; timeoutMs: number } => {
  const defaultUserEnv = process.env.TCP_USERNAME != null ? "TCP_USERNAME" : "REOLINK_USER";
  const defaultPassEnv = process.env.TCP_PASSWORD != null ? "TCP_PASSWORD" : "REOLINK_PASS";

  const usernameEnv = dev?.usernameEnv ?? cfg.defaults?.usernameEnv ?? defaultUserEnv;
  const passwordEnv = dev?.passwordEnv ?? cfg.defaults?.passwordEnv ?? defaultPassEnv;

  const username = process.env[usernameEnv];
  const password = process.env[passwordEnv];
  if (!username || !password) {
    throw new Error(`Missing credentials env vars: ${usernameEnv} / ${passwordEnv}`);
  }

  const timeoutMs = dev?.timeoutMs ?? cfg.defaults?.timeoutMs ?? 15000;
  return { username, password, timeoutMs };
};
