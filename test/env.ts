/**
 * Utility to load environment variables from .env using dotenv.
 */

import { config as dotenvConfig } from "dotenv";

// Load environment variables from .env
dotenvConfig();

export interface TestConfig {
  tcp: {
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

  return {
    tcp: {
      host: getEnv("TCP_HOST", ""),
      username: getEnv("TCP_USERNAME", "admin"),
      password: getEnv("TCP_PASSWORD", ""),
    },
    udp: {
      host: getEnv("UDP_HOST", ""),
      username: getEnv("UDP_USERNAME", "admin"),
      password: getEnv("UDP_PASSWORD", ""),
      uid: getEnv("UDP_UID", ""),
    },
    nvr: {
      host: getEnv("NVR_HOST", ""),
      username: getEnv("NVR_USERNAME", "admin"),
      password: getEnv("NVR_PASSWORD", ""),
      uid: getEnv("NVR_UID", ""),
    },
    rtsp: {
      proxyPort: Number(getEnv("RTSP_PROXY_PORT", "8080")),
      recordDuration: Number(getEnv("RECORD_DURATION", "10")),
    },
  };
}

export const config = loadEnv();

