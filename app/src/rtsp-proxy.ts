import * as net from "net";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import { createSourceLogger } from "./logger.js";
import {
  getSettings,
  getConfig,
  getRtspCredentials,
} from "./settings-store.js";
import {
  getAllRtspServersInfo,
  sanitizeCameraName,
  startRtspServer,
  stopRtspServer,
} from "./rtsp-manager.js";

const logger = createSourceLogger("rtsp-proxy");

/** Time to wait before stopping a backend with no clients (ms) */
const BACKEND_IDLE_TIMEOUT_MS = 30_000;

/**
 * RTSP Proxy Server - Simple TCP Pipe with Digest Authentication
 *
 * Exposes a single port for all RTSP streams with path-based routing.
 * Path format: /camera-name/profile (e.g., /living-room/main, /garage/sub)
 *
 * This is a simple TCP proxy that:
 * 1. Optionally authenticates clients using Digest auth
 * 2. Reads the first RTSP request to determine the target path
 * 3. Starts the backend RTSP server on-demand if needed
 * 4. Creates a bidirectional pipe to the backend
 *
 * No URL rewriting needed since backend uses same paths.
 */

interface RtspProxyOptions {
  port: number;
  host?: string;
}

interface AuthSession {
  nonce: string;
  authenticated: boolean;
  realm: string;
}

export class RtspProxyServer extends EventEmitter {
  private server: net.Server | null = null;
  private port: number;
  private host: string;
  private connections = new Map<
    string,
    {
      client: net.Socket;
      backend: net.Socket | null;
      auth?: AuthSession;
      backendKey?: string;
    }
  >();
  private readonly realm = "RTSP Proxy";

  /** Track clients per backend (key: "cameraName/profile") */
  private backendClients = new Map<string, Set<string>>();
  /** Track idle timers per backend */
  private backendIdleTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: RtspProxyOptions) {
    super();
    this.port = options.port;
    this.host = options.host || "0.0.0.0";
  }

  /**
   * Generate a random nonce for Digest auth
   */
  private generateNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  /**
   * Calculate MD5 hash
   */
  private md5(data: string): string {
    return crypto.createHash("md5").update(data).digest("hex");
  }

  /**
   * Parse Authorization header from RTSP request
   */
  private parseAuthHeader(data: Buffer): {
    username?: string;
    realm?: string;
    nonce?: string;
    uri?: string;
    response?: string;
  } | null {
    const text = data.toString("utf-8");
    const authMatch = text.match(
      /Authorization:\s*Digest\s+(.+?)(?:\r\n|\r|\n)/i,
    );
    if (!authMatch) return null;

    const authParams = authMatch[1];
    const result: Record<string, string> = {};

    // Parse key="value" pairs
    const regex = /(\w+)="?([^",]+)"?/g;
    let match;
    while ((match = regex.exec(authParams)) !== null) {
      result[match[1]] = match[2];
    }

    return result;
  }

  /**
   * Extract CSeq from RTSP request
   */
  private extractCSeq(data: Buffer): string {
    const text = data.toString("utf-8");
    const match = text.match(/CSeq:\s*(\d+)/i);
    return match ? match[1] : "1";
  }

  /**
   * Extract method from RTSP request
   */
  private extractMethod(data: Buffer): string {
    const text = data.toString("utf-8");
    const match = text.match(/^(\w+)\s+/);
    return match ? match[1] : "OPTIONS";
  }

  /**
   * Validate Digest authentication
   */
  private validateAuth(
    data: Buffer,
    session: AuthSession,
  ): { valid: boolean; username?: string } {
    const authParams = this.parseAuthHeader(data);
    if (!authParams || !authParams.username || !authParams.response) {
      return { valid: false };
    }

    const { username, nonce, uri, response } = authParams;

    // Check nonce matches
    if (nonce !== session.nonce) {
      logger.debug(`Nonce mismatch: expected ${session.nonce}, got ${nonce}`);
      return { valid: false };
    }

    // Find credential
    const credentials = getRtspCredentials();
    const credential = credentials.find((c) => c.username === username);
    if (!credential) {
      logger.debug(`Unknown user: ${username}`);
      return { valid: false };
    }

    // Calculate expected response
    // HA1 = MD5(username:realm:password)
    // HA2 = MD5(method:uri)
    // response = MD5(HA1:nonce:HA2)
    const method = this.extractMethod(data);
    const ha1 = this.md5(`${username}:${session.realm}:${credential.password}`);
    const ha2 = this.md5(`${method}:${uri}`);
    const expectedResponse = this.md5(`${ha1}:${session.nonce}:${ha2}`);

    if (response === expectedResponse) {
      return { valid: true, username };
    }

    logger.debug(`Auth response mismatch for ${username}`);
    return { valid: false };
  }

  /**
   * Send 401 Unauthorized response
   */
  private sendUnauthorized(
    socket: net.Socket,
    cseq: string,
    nonce: string,
  ): void {
    const response = [
      "RTSP/1.0 401 Unauthorized",
      `CSeq: ${cseq}`,
      `WWW-Authenticate: Digest realm="${this.realm}", nonce="${nonce}"`,
      "",
      "",
    ].join("\r\n");
    socket.write(response);
  }

  /**
   * Check if authentication is required
   */
  private isAuthRequired(): boolean {
    const settings = getSettings();
    return settings.rtspRequireAuth && getRtspCredentials().length > 0;
  }

  /**
   * Parse path from RTSP request
   * Returns { cameraName, profile } or null
   */
  private parseRtspPath(
    data: Buffer,
  ): { cameraName: string; profile: string; fullPath: string } | null {
    const text = data.toString("utf-8");
    const lines = text.split("\r\n");
    if (lines.length < 1) return null;

    // Parse request line: METHOD rtsp://host:port/path RTSP/1.0
    const requestLine = lines[0];
    const match = requestLine.match(/^\w+\s+(\S+)\s+RTSP/);
    if (!match) return null;

    const uri = match[1];

    // Extract path from URI
    let path = uri;
    const urlMatch = uri.match(/^rtsp:\/\/[^/]+(\/.*)?$/);
    if (urlMatch) {
      path = urlMatch[1] || "/";
    }

    // Parse path: /camera-name/profile or /camera-name/profile/track0
    const pathMatch = path.match(/^\/([^/]+)\/(main|sub|ext)(\/.*)?$/i);
    if (!pathMatch) return null;

    const [, cameraName, profile] = pathMatch;
    return {
      cameraName: cameraName.toLowerCase(),
      profile: profile.toLowerCase(),
      fullPath: `/${cameraName.toLowerCase()}/${profile.toLowerCase()}`,
    };
  }

  /**
   * Get backend key for tracking
   */
  private getBackendKey(cameraName: string, profile: string): string {
    return `${cameraName}/${profile}`;
  }

  /**
   * Register a client for a backend
   */
  private registerBackendClient(backendKey: string, clientId: string): void {
    // Clear any pending idle timer for this backend
    const existingTimer = this.backendIdleTimers.get(backendKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.backendIdleTimers.delete(backendKey);
      logger.debug(`Cleared idle timer for ${backendKey}`);
    }

    // Add client to backend's client set
    let clients = this.backendClients.get(backendKey);
    if (!clients) {
      clients = new Set();
      this.backendClients.set(backendKey, clients);
    }
    clients.add(clientId);
    logger.debug(`Backend ${backendKey} now has ${clients.size} client(s)`);
  }

  /**
   * Unregister a client from a backend
   */
  private unregisterBackendClient(backendKey: string, clientId: string): void {
    const clients = this.backendClients.get(backendKey);
    if (!clients) return;

    clients.delete(clientId);
    logger.debug(`Backend ${backendKey} now has ${clients.size} client(s)`);

    // If no more clients, start idle timer
    if (clients.size === 0) {
      this.backendClients.delete(backendKey);
      this.startBackendIdleTimer(backendKey);
    }
  }

  /**
   * Start idle timer for a backend with no clients
   */
  private startBackendIdleTimer(backendKey: string): void {
    // Clear any existing timer
    const existingTimer = this.backendIdleTimers.get(backendKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    logger.info(
      `Backend ${backendKey} has no clients, starting ${BACKEND_IDLE_TIMEOUT_MS / 1000}s idle timer`,
    );

    const timer = setTimeout(async () => {
      this.backendIdleTimers.delete(backendKey);

      // Double-check no clients have connected
      const clients = this.backendClients.get(backendKey);
      if (clients && clients.size > 0) {
        logger.debug(
          `Backend ${backendKey} got clients during idle period, keeping alive`,
        );
        return;
      }

      // Find and stop the backend server
      const [cameraName, profile] = backendKey.split("/");
      await this.stopBackendServer(cameraName!, profile!);
    }, BACKEND_IDLE_TIMEOUT_MS);

    // Don't prevent process exit
    timer.unref();
    this.backendIdleTimers.set(backendKey, timer);
  }

  /**
   * Stop a backend RTSP server
   */
  private async stopBackendServer(
    cameraName: string,
    profile: string,
  ): Promise<void> {
    const normalizedProfile = profile as "main" | "sub" | "ext";
    const config = getConfig();

    // Find the camera
    const camera = config.cameras.find((c) => {
      const sanitized = sanitizeCameraName(c.name);
      return sanitized === cameraName || c.id === cameraName;
    });

    if (!camera) {
      logger.warn(`Cannot stop backend: camera not found: ${cameraName}`);
      return;
    }

    // Find running server
    const servers = getAllRtspServersInfo();
    const server = servers.find(
      (s) =>
        s.status === "running" &&
        s.cameraId === camera.id &&
        s.profile === normalizedProfile,
    );

    if (!server) {
      logger.debug(`No running backend to stop for ${cameraName}/${profile}`);
      return;
    }

    try {
      logger.info(`Stopping idle backend: ${cameraName}/${profile}`);
      await stopRtspServer(server.streamKey);
      logger.info(`Backend stopped: ${cameraName}/${profile}`);
    } catch (error) {
      logger.error(`Failed to stop backend ${cameraName}/${profile}: ${error}`);
    }
  }

  /**
   * Find or start backend RTSP server
   */
  private async findOrStartBackend(
    cameraName: string,
    profile: string,
  ): Promise<{ host: string; port: number } | null> {
    const normalizedProfile = profile as "main" | "sub" | "ext";

    // Check for running server
    let servers = getAllRtspServersInfo();
    for (const server of servers) {
      if (server.status !== "running") continue;
      const serverCameraName = sanitizeCameraName(
        server.cameraName || server.cameraId,
      );
      if (
        serverCameraName === cameraName &&
        server.profile === normalizedProfile
      ) {
        logger.info(`Found running backend: ${server.port}`);
        return { host: "127.0.0.1", port: server.port };
      }
    }

    // Start server on-demand
    logger.info(
      `No running server for ${cameraName}/${profile}, starting on-demand...`,
    );

    const config = getConfig();
    const camera = config.cameras.find((c) => {
      const sanitized = sanitizeCameraName(c.name);
      return sanitized === cameraName || c.id === cameraName;
    });

    if (!camera) {
      logger.warn(`Camera not found: ${cameraName}`);
      return null;
    }

    try {
      await startRtspServer(camera.id, {
        profile: normalizedProfile,
        channel: 0,
      });

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Find the newly started server
      servers = getAllRtspServersInfo();
      for (const server of servers) {
        if (server.status !== "running") continue;
        if (
          server.cameraId === camera.id &&
          server.profile === normalizedProfile
        ) {
          logger.info(`On-demand backend started: ${server.port}`);
          return { host: "127.0.0.1", port: server.port };
        }
      }
    } catch (error) {
      logger.error(`Failed to start backend: ${error}`);
    }

    return null;
  }

  /**
   * Handle new client connection
   */
  private handleConnection(clientSocket: net.Socket): void {
    const clientId = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    logger.info(`Client connected: ${clientId}`);

    // Initialize auth session if required
    const authRequired = this.isAuthRequired();
    const authSession: AuthSession | undefined = authRequired
      ? { nonce: this.generateNonce(), authenticated: false, realm: this.realm }
      : undefined;

    this.connections.set(clientId, {
      client: clientSocket,
      backend: null,
      auth: authSession,
      backendKey: undefined,
    });

    let initialBuffer = Buffer.alloc(0);
    let backendConnected = false;

    const cleanup = () => {
      const conn = this.connections.get(clientId);
      if (conn) {
        // Unregister from backend tracking
        if (conn.backendKey) {
          this.unregisterBackendClient(conn.backendKey, clientId);
        }
        if (conn.backend) {
          conn.backend.destroy();
        }
        conn.client.destroy();
        this.connections.delete(clientId);
      }
    };

    // Handle initial data to determine routing
    const onInitialData = async (data: Buffer) => {
      initialBuffer = Buffer.concat([initialBuffer, data]);

      // Need at least one complete request (ends with \r\n\r\n)
      if (!initialBuffer.includes("\r\n\r\n")) return;

      // Check authentication if required
      const conn = this.connections.get(clientId);
      if (conn?.auth && !conn.auth.authenticated) {
        const cseq = this.extractCSeq(initialBuffer);
        const authResult = this.validateAuth(initialBuffer, conn.auth);

        if (!authResult.valid) {
          logger.info(`Auth required for ${clientId}, sending 401`);
          // Generate new nonce for retry
          conn.auth.nonce = this.generateNonce();
          this.sendUnauthorized(clientSocket, cseq, conn.auth.nonce);
          // Reset buffer for next attempt
          initialBuffer = Buffer.alloc(0);
          return;
        }

        logger.info(
          `Client ${clientId} authenticated as ${authResult.username}`,
        );
        conn.auth.authenticated = true;
      }

      // Parse the path
      const parsed = this.parseRtspPath(initialBuffer);
      if (!parsed) {
        logger.warn(`Invalid RTSP path from ${clientId}`);
        clientSocket.end();
        cleanup();
        return;
      }

      logger.info(
        `Client ${clientId} requesting: ${parsed.cameraName}/${parsed.profile}`,
      );

      // Find or start backend
      const backend = await this.findOrStartBackend(
        parsed.cameraName,
        parsed.profile,
      );
      if (!backend) {
        logger.warn(`No backend available for ${parsed.fullPath}`);
        // Send 404 response
        const cseq = this.extractCSeq(initialBuffer);
        clientSocket.write(
          `RTSP/1.0 404 Not Found\r\nCSeq: ${cseq}\r\n\r\n`,
          () => {
            clientSocket.end();
            cleanup();
          },
        );
        return;
      }

      // Remove initial data handler
      clientSocket.removeListener("data", onInitialData);

      // Track this client for the backend
      const backendKey = this.getBackendKey(parsed.cameraName, parsed.profile);

      // Connect to backend
      const backendSocket = net.createConnection(
        { host: backend.host, port: backend.port },
        () => {
          logger.info(
            `Connected to backend ${backend.host}:${backend.port} for ${clientId}`,
          );
          backendConnected = true;

          // Update connection tracking
          const conn = this.connections.get(clientId);
          if (conn) {
            conn.backend = backendSocket;
            conn.backendKey = backendKey;
          }

          // Register client for this backend (for auto-stop tracking)
          this.registerBackendClient(backendKey, clientId);

          // Forward the initial buffered data
          backendSocket.write(initialBuffer);

          // Set up bidirectional pipe
          clientSocket.pipe(backendSocket);
          backendSocket.pipe(clientSocket);
        },
      );

      backendSocket.on("error", (err) => {
        logger.error(`Backend error for ${clientId}: ${err.message}`);
        cleanup();
      });

      backendSocket.on("close", () => {
        logger.info(`Backend closed for ${clientId}`);
        cleanup();
      });
    };

    clientSocket.on("data", onInitialData);

    clientSocket.on("close", () => {
      logger.info(`Client disconnected: ${clientId}`);
      cleanup();
    });

    clientSocket.on("error", (err) => {
      logger.error(`Client error ${clientId}: ${err.message}`);
      cleanup();
    });
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.on("error", (err) => {
        logger.error(`Proxy server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        logger.info(`RTSP Proxy started on ${this.host}:${this.port}`);
        logger.info(
          `Access streams via: rtsp://<host>:${this.port}/<camera-name>/<profile>`,
        );
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    // Clear all idle timers
    for (const [key, timer] of this.backendIdleTimers) {
      clearTimeout(timer);
    }
    this.backendIdleTimers.clear();
    this.backendClients.clear();

    // Close all connections
    for (const [clientId, conn] of this.connections) {
      if (conn.backend) conn.backend.destroy();
      conn.client.destroy();
      this.connections.delete(clientId);
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info("RTSP Proxy stopped");
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get proxy status
   */
  getStatus(): {
    running: boolean;
    port: number;
    host: string;
    connections: number;
  } {
    return {
      running: this.server !== null && this.server.listening,
      port: this.port,
      host: this.host,
      connections: this.connections.size,
    };
  }

  /**
   * List available streams through proxy
   */
  listAvailableStreams(): Array<{
    path: string;
    cameraName: string;
    profile: string;
    proxyUrl: string;
  }> {
    const settings = getSettings();
    const proxyHost = settings.serviceIp || "localhost";
    const servers = getAllRtspServersInfo();
    const streams: Array<{
      path: string;
      cameraName: string;
      profile: string;
      proxyUrl: string;
    }> = [];

    for (const server of servers) {
      if (server.status !== "running") continue;

      const cameraPath = sanitizeCameraName(
        server.cameraName || server.cameraId,
      );
      const path = `/${cameraPath}/${server.profile}`;

      streams.push({
        path,
        cameraName: server.cameraName || server.cameraId,
        profile: server.profile,
        proxyUrl: `rtsp://${proxyHost}:${this.port}${path}`,
      });
    }

    return streams;
  }
}

// Singleton instance
let proxyInstance: RtspProxyServer | null = null;

/**
 * Get or create the RTSP proxy instance
 */
export function getRtspProxy(): RtspProxyServer | null {
  return proxyInstance;
}

/**
 * Start the RTSP proxy with settings
 */
export async function startRtspProxy(): Promise<RtspProxyServer> {
  if (proxyInstance) {
    return proxyInstance;
  }

  const port = Number(process.env.RTSP_PROXY_PORT) || 8554;

  proxyInstance = new RtspProxyServer({
    port,
    host: "0.0.0.0",
  });

  await proxyInstance.start();
  return proxyInstance;
}

/**
 * Stop the RTSP proxy
 */
export async function stopRtspProxy(): Promise<void> {
  if (proxyInstance) {
    await proxyInstance.stop();
    proxyInstance = null;
  }
}
