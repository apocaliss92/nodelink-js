import {
  ReolinkBaichuanApi,
  BaichuanRtspServer,
} from "@apocaliss92/nodelink-js";
import type { CameraConfig, RtspServerConfig, ConnectionParams } from "./types";
import { createSourceLogger } from "./logger.js";
import {
  getCamera,
  getCameras,
  getRtspServers,
  updateRtspServer,
} from "./settings-store.js";

const logger = createSourceLogger("connection-manager");
const rtspLogger = createSourceLogger("rtsp-manager");

interface ActiveConnection {
  api: ReolinkBaichuanApi;
  lastUsed: number;
}

interface ActiveRtspServer {
  server: BaichuanRtspServer;
  config: RtspServerConfig;
  cameraConfig: CameraConfig;
  url: string; // Computed URL for RTSP access
}

// Cache connections for reuse (timeout after 5 minutes of inactivity)
const connectionCache = new Map<string, ActiveConnection>();
const CONNECTION_TIMEOUT = 5 * 60 * 1000;

// Default/active connection credentials
let activeCredentials: ConnectionParams | null = {
  host: "192.168.1.161",
  port: 9000,
  username: "admin",
  password: "",
};

export function setActiveCredentials(params: ConnectionParams): void {
  activeCredentials = params;
  logger.info(`Active credentials set for ${params.host}:${params.port}`);
}

export function getActiveCredentials(): ConnectionParams | null {
  return activeCredentials;
}

export function clearActiveCredentials(): void {
  activeCredentials = null;
  logger.info("Active credentials cleared");
}

export type ResolveCredentialsInput = Partial<ConnectionParams> & {
  cameraId?: string;
};

export function resolveCredentials(
  partial?: ResolveCredentialsInput,
): ConnectionParams {
  // Use configured camera when cameraId is provided (not "manual" or empty)
  const cameraId = partial?.cameraId?.trim();
  if (cameraId && cameraId !== "manual") {
    const camera =
      getCamera(cameraId) ??
      getCameras().find((c) => c.name === cameraId);
    if (camera) {
      const base: ConnectionParams = {
        host: camera.host,
        port: camera.port ?? 9000,
        username: camera.username,
        password: camera.password,
      };
      // Apply manual overrides if provided
      const overrides: Partial<ConnectionParams> = {};
      if (partial?.host && String(partial.host).trim()) {
        overrides.host = partial.host.trim();
      }
      if (partial?.port !== undefined && partial?.port !== null && !isNaN(Number(partial.port))) {
        overrides.port = Number(partial.port);
      }
      if (partial?.username && String(partial.username).trim()) {
        overrides.username = partial.username.trim();
      }
      if (partial?.password !== undefined) {
        overrides.password = partial.password;
      }
      return { ...base, ...overrides };
    }
  }

  // Manual mode: all required connection params provided explicitly
  if (
    partial?.host &&
    String(partial.host).trim() &&
    partial?.username &&
    String(partial.username).trim() &&
    partial?.password !== undefined
  ) {
    return {
      host: partial.host.trim(),
      port: partial.port ?? 9000,
      username: partial.username.trim(),
      password: partial.password,
    };
  }

  if (!activeCredentials) {
    throw new Error(
      "No active credentials set. Use 'setActiveCredentials' first, provide cameraId (from cameras.list), or provide full connection params (host, username, password).",
    );
  }

  // Merge only non-blank values from partial (blank = use active credentials)
  const overrides: Partial<ConnectionParams> = {};
  if (partial?.host && String(partial.host).trim()) {
    overrides.host = partial.host.trim();
  }
  if (partial?.port !== undefined && partial?.port !== null && !isNaN(Number(partial.port))) {
    overrides.port = Number(partial.port);
  }
  if (partial?.username && String(partial.username).trim()) {
    overrides.username = partial.username.trim();
  }
  if (partial?.password !== undefined) {
    overrides.password = partial.password;
  }

  return {
    ...activeCredentials,
    ...overrides,
  };
}

// Active RTSP servers
const activeRtspServers = new Map<string, ActiveRtspServer>();

// Cleanup inactive connections periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, conn] of connectionCache.entries()) {
    if (now - conn.lastUsed > CONNECTION_TIMEOUT) {
      conn.api.close().catch(() => {});
      connectionCache.delete(key);
      logger.debug(`Closed inactive connection: ${key}`);
    }
  }
}, 60 * 1000);

export async function getConnection(
  host: string,
  port: number,
  username: string,
  password: string,
): Promise<ReolinkBaichuanApi> {
  const key = `${host}:${port}:${username}`;

  const cached = connectionCache.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.api;
  }

  const api = new ReolinkBaichuanApi({
    host,
    port,
    username,
    password,
  });

  await api.login();

  connectionCache.set(key, { api, lastUsed: Date.now() });
  logger.info(`New connection established: ${key}`);

  return api;
}

export async function getConnectionFromCamera(
  cameraId: string,
): Promise<ReolinkBaichuanApi> {
  const camera = getCamera(cameraId);
  if (!camera) {
    throw new Error(`Camera not found: ${cameraId}`);
  }
  return getConnection(
    camera.host,
    camera.port,
    camera.username,
    camera.password,
  );
}

export async function closeConnection(
  host: string,
  port: number,
  username: string,
): Promise<void> {
  const key = `${host}:${port}:${username}`;
  const cached = connectionCache.get(key);
  if (cached) {
    await cached.api.close();
    connectionCache.delete(key);
    logger.debug(`Closed connection: ${key}`);
  }
}

export async function closeAllConnections(): Promise<void> {
  for (const [key, conn] of connectionCache.entries()) {
    await conn.api.close().catch(() => {});
    logger.debug(`Closed connection: ${key}`);
  }
  connectionCache.clear();
}

// RTSP Server management
export async function startRtspServer(serverId: string): Promise<string> {
  if (activeRtspServers.has(serverId)) {
    const active = activeRtspServers.get(serverId)!;
    return active.url;
  }

  const servers = getRtspServers();
  const serverConfig = servers.find((s) => s.id === serverId);
  if (!serverConfig) {
    throw new Error(`RTSP server config not found: ${serverId}`);
  }

  const camera = getCamera(serverConfig.cameraId);
  if (!camera) {
    throw new Error(`Camera not found: ${serverConfig.cameraId}`);
  }

  const api = await getConnection(
    camera.host,
    camera.port,
    camera.username,
    camera.password,
  );

  const streamLogger = createSourceLogger(
    `rtsp:${camera.name}:${serverConfig.profile}`,
  );

  const rtspServer = new BaichuanRtspServer({
    api,
    profile: serverConfig.profile as "main" | "sub" | "ext",
    channel: serverConfig.channel,
    listenPort: serverConfig.port,
    logger: {
      log: (msg: unknown) => streamLogger.info(String(msg)),
      info: (msg: string) => streamLogger.info(msg),
      warn: (msg: string) => streamLogger.warn(msg),
      error: (msg: string) => streamLogger.error(msg),
      debug: (msg: string) => streamLogger.debug(msg),
    },
  });

  await rtspServer.start();

  // Build the RTSP URL
  const rtspUrl = `rtsp://localhost:${serverConfig.port}/stream/${serverConfig.profile}`;

  activeRtspServers.set(serverId, {
    server: rtspServer,
    config: serverConfig,
    cameraConfig: camera,
    url: rtspUrl,
  });

  updateRtspServer(serverId, { enabled: true });

  rtspLogger.info(
    `Started RTSP server ${serverId} on port ${serverConfig.port}`,
  );

  return rtspUrl;
}

export async function stopRtspServer(serverId: string): Promise<void> {
  const active = activeRtspServers.get(serverId);
  if (!active) {
    return;
  }

  await active.server.stop();
  activeRtspServers.delete(serverId);
  updateRtspServer(serverId, { enabled: false });

  rtspLogger.info(`Stopped RTSP server ${serverId}`);
}

export async function stopAllRtspServers(): Promise<void> {
  for (const [id, active] of activeRtspServers.entries()) {
    await active.server.stop().catch(() => {});
    rtspLogger.info(`Stopped RTSP server ${id}`);
  }
  activeRtspServers.clear();
}

export function getActiveRtspServers(): Array<{
  id: string;
  url: string;
  config: RtspServerConfig;
  cameraName: string;
}> {
  return Array.from(activeRtspServers.entries()).map(([id, active]) => ({
    id,
    url: active.url,
    config: active.config,
    cameraName: active.cameraConfig.name,
  }));
}

export function isRtspServerRunning(serverId: string): boolean {
  return activeRtspServers.has(serverId);
}

// Auto-start enabled servers on startup
export async function autoStartRtspServers(): Promise<void> {
  const servers = getRtspServers().filter((s) => s.enabled);
  for (const server of servers) {
    try {
      await startRtspServer(server.id);
    } catch (error) {
      rtspLogger.error(`Failed to auto-start ${server.id}: ${error}`);
    }
  }
}
