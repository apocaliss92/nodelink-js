/**
 * Utility to load environment variables from .env using dotenv.
 */

import { config as dotenvConfig } from "dotenv";

function envBool(v: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((v ?? "").trim());
}

// Load environment variables from .env
// Some dotenv versions emit informational logs; allow silencing for scripts that must output pure JSON.
const dotenvQuiet =
  envBool(process.env.DOTENV_QUIET) ||
  envBool(process.env.EVENTS_QUIET) ||
  envBool(process.env.EVENTS_STDOUT_JSON);

if (dotenvQuiet) {
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  try {
    console.log = () => undefined;
    console.info = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    dotenvConfig();
  } finally {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  }
} else {
  dotenvConfig();
}

export interface TestConfig {
  tcp: {
    host: string;
    username: string;
    password: string;
  };
  tcp265: {
    host: string;
    username: string;
    password: string;
  };
  udp: {
    host: string;
    username: string;
    password: string;
    uid: string;
  };
  /** Separate battery camera profile used for sleep experiments (UDP_SLEEP_* env vars). */
  udpSleep: {
    host: string;
    username: string;
    password: string;
    uid: string;
  };
  nvr: {
    host: string;
    username: string;
    password: string;
    uid: string;
  };
  rtsp: {
    proxyPort: number;
    recordDuration: number;
  };
}

function loadEnv(): TestConfig {
  const getEnv = (key: string, defaultValue: string): string => {
    return process.env[key] || defaultValue;
  };

  // Convenience fallbacks: many setups use a single device for quick tests.
  // If NVR_* are not provided, fall back to TCP_* (host/credentials).
  const tcpHost = getEnv("TCP_HOST", "");
  const tcpUsername = getEnv("TCP_USERNAME", "admin");
  const tcpPassword = getEnv("TCP_PASSWORD", "");

  return {
    tcp: {
      host: tcpHost,
      username: tcpUsername,
      password: tcpPassword,
    },
    tcp265: {
      host: getEnv("TCP265_HOST", ""),
      username: getEnv("TCP265_USERNAME", "admin"),
      password: getEnv("TCP265_PASSWORD", ""),
    },
    udp: {
      host: getEnv("UDP_HOST", ""),
      username: getEnv("UDP_USERNAME", "admin"),
      password: getEnv("UDP_PASSWORD", ""),
      uid: getEnv("UDP_UID", ""),
    },
    udpSleep: {
      host: getEnv("UDP_SLEEP_HOST", ""),
      username: getEnv("UDP_SLEEP_USERNAME", "admin"),
      password: getEnv("UDP_SLEEP_PASSWORD", ""),
      uid: getEnv("UDP_SLEEP_UID", ""),
    },
    nvr: {
      host: getEnv("NVR_HOST", tcpHost),
      username: getEnv("NVR_USERNAME", tcpUsername),
      password: getEnv("NVR_PASSWORD", tcpPassword),
      uid: getEnv("NVR_UID", ""),
    },
    rtsp: {
      proxyPort: Number(getEnv("RTSP_PROXY_PORT", "8080")),
      recordDuration: Number(getEnv("RECORD_DURATION", "10")),
    },
  };
}

export const config = loadEnv();

