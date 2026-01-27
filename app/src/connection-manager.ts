import {
  ReolinkBaichuanApi,
  BaichuanRtspServer,
} from "@apocaliss92/reolink-baichuan-js";
import type { CameraConfig, RtspServerConfig, ConnectionParams } from "./types";
import {
  getCamera,
  getRtspServers,
  updateRtspServer,
} from "./settings-store.js";

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
  password: "Ruocco123",
};

export function setActiveCredentials(params: ConnectionParams): void {
  activeCredentials = params;
  console.log(
    `[ConnectionManager] Active credentials set for ${params.host}:${params.port}`,
  );
}

export function getActiveCredentials(): ConnectionParams | null {
  return activeCredentials;
}

export function clearActiveCredentials(): void {
  activeCredentials = null;
  console.log("[ConnectionManager] Active credentials cleared");
}

export function resolveCredentials(
  partial?: Partial<ConnectionParams>,
): ConnectionParams {
  if (partial?.host && partial?.username && partial?.password) {
    return {
      host: partial.host,
      port: partial.port || 9000,
      username: partial.username,
      password: partial.password,
    };
  }

  if (!activeCredentials) {
    throw new Error(
      "No active credentials set. Use 'setActiveCredentials' first or provide full connection params.",
    );
  }

  return {
    ...activeCredentials,
    ...partial,
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
      console.log(`[ConnectionManager] Closed inactive connection: ${key}`);
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
  console.log(`[ConnectionManager] New connection established: ${key}`);

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
    console.log(`[ConnectionManager] Closed connection: ${key}`);
  }
}

export async function closeAllConnections(): Promise<void> {
  for (const [key, conn] of connectionCache.entries()) {
    await conn.api.close().catch(() => {});
    console.log(`[ConnectionManager] Closed connection: ${key}`);
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

  const rtspServer = new BaichuanRtspServer({
    api,
    profile: serverConfig.profile as "main" | "sub" | "ext",
    channel: serverConfig.channel,
    listenPort: serverConfig.port,
    logger: console,
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

  console.log(
    `[RtspManager] Started RTSP server ${serverId} on port ${serverConfig.port}`,
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

  console.log(`[RtspManager] Stopped RTSP server ${serverId}`);
}

export async function stopAllRtspServers(): Promise<void> {
  for (const [id, active] of activeRtspServers.entries()) {
    await active.server.stop().catch(() => {});
    console.log(`[RtspManager] Stopped RTSP server ${id}`);
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
      console.error(`[RtspManager] Failed to auto-start ${server.id}:`, error);
    }
  }
}
