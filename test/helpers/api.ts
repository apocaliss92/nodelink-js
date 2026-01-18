import type { Logger } from "../../src/debug/DebugConfig";
import type { BaichuanClientOptions } from "../../src/client/BaichuanClient";
import type { StandaloneTcpDeviceConfig, StandaloneUdpDeviceConfig } from "./config";

export type IntegrationApi = any;

type ReolinkBaichuanApiConstructor = new (options: BaichuanClientOptions) => IntegrationApi;

// Import the built library runtime (dist/index.js) relative to the compiled test output.
// When compiled, this file becomes dist/test/helpers/api.js, so ../../index.js points to dist/index.js.
const { ReolinkBaichuanApi } = (await import(new URL("../../index.js", import.meta.url).href)) as unknown as {
  ReolinkBaichuanApi: ReolinkBaichuanApiConstructor;
};

export const createTestLogger = (): Logger => {
  const log = (level: string, msg: string, data?: unknown) => {
    const payload = data !== undefined ? ` ${JSON.stringify(data)}` : "";
    // Keep output small; node --test will capture stdout.
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${msg}${payload}`);
  };

  return {
    debug: (msg: string, data?: unknown) => log("debug", msg, data),
    info: (msg: string, data?: unknown) => log("info", msg, data),
    warn: (msg: string, data?: unknown) => log("warn", msg, data),
    error: (msg: string, data?: unknown) => log("error", msg, data),
    log: (msg: string, data?: unknown) => log("log", msg, data),
  };
};

export const createTcpApi = (params: { dev: StandaloneTcpDeviceConfig; username: string; password: string; logger?: Logger }) => {
  const base: BaichuanClientOptions = {
    host: params.dev.host,
    username: params.username,
    password: params.password,
    logger: params.logger ?? createTestLogger(),
    debugOptions: {},
    transport: "tcp",
  };

  const api = new ReolinkBaichuanApi(base);
  return api;
};

export const createUdpApi = (params: { dev: StandaloneUdpDeviceConfig; username: string; password: string; logger?: Logger }) => {
  const base: BaichuanClientOptions = {
    host: params.dev.host,
    username: params.username,
    password: params.password,
    logger: params.logger ?? createTestLogger(),
    debugOptions: {},
    transport: "udp",
    uid: params.dev.uid,
    ...(params.dev.udpDiscoveryMethod ? { udpDiscoveryMethod: params.dev.udpDiscoveryMethod } : {}),
    idleDisconnect: true,
  } as any;

  const api = new ReolinkBaichuanApi(base);
  return api;
};

export const closeApi = async (api: IntegrationApi): Promise<void> => {
  try {
    await api.unsubscribeEvents?.();
  } catch {
    // ignore
  }

  try {
    await api.client?.close?.({ reason: "integration_test_end" });
  } catch {
    // ignore
  }
};
