/**
 * Baichuan HaCfg webhook HTTP intake.
 *
 * Factory-style entrypoint mirrored after `emailPush/server.ts`. Cameras
 * POST wake/sleep JSON to `POST /webhook/:cameraId` (path prefix
 * configurable). Events land on the process-local bus.
 */

import http from "node:http";
import { URL } from "node:url";
import {
  emitBaichuanWebhookEvent,
  type BaichuanWebhookEvent,
} from "./bus.js";
import { parseBaichuanWebhookBody } from "./parse.js";

export interface BaichuanWebhookServerConfig {
  /** HTTP listen port. */
  port: number;
  /** Bind host (`0.0.0.0` to accept on LAN). */
  bindHost: string;
  /**
   * Path prefix before the camera id. Default `/webhook`.
   * Final route: `${pathPrefix}/:cameraId`.
   */
  pathPrefix?: string;
  /** Maximum accepted body size in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
}

export interface BaichuanWebhookServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  bindHost: string;
  pathPrefix: string;
  messagesAccepted: number;
  messagesRejected: number;
  startedAtMs: number | undefined;
  lastErrorMessage: string | undefined;
}

export interface BaichuanWebhookLogger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface BaichuanWebhookServerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  getStatus(): BaichuanWebhookServerStatus;
  updateConfig(next: BaichuanWebhookServerConfig): void;
  /** Build the URL a camera should POST to for the given cameraId. */
  getCameraWebhookPath(cameraId: string): string;
}

export interface CreateBaichuanWebhookServerParams {
  config: BaichuanWebhookServerConfig;
  /**
   * Optional resolver: map the path camera id segment to the consumer's
   * internal cameraId. Return `undefined` to reject (404). Default: identity.
   */
  cameraResolver?: (pathCameraId: string) => string | undefined;
  logger?: BaichuanWebhookLogger;
  /**
   * When true, `getStatus().enabled` reports true even before start.
   * The manager adapter sets this from settings.
   */
  enabled?: boolean;
}

function normalizePrefix(prefix: string | undefined): string {
  const raw = (prefix ?? "/webhook").trim() || "/webhook";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, "") || "/webhook";
}

export function getCameraWebhookPath(
  cameraId: string,
  pathPrefix = "/webhook",
): string {
  const prefix = normalizePrefix(pathPrefix);
  return `${prefix}/${encodeURIComponent(cameraId)}`;
}

export function createBaichuanWebhookServer(
  params: CreateBaichuanWebhookServerParams,
): BaichuanWebhookServerInstance {
  const log: Required<BaichuanWebhookLogger> = {
    debug: params.logger?.debug ?? (() => {}),
    info: params.logger?.info ?? (() => {}),
    warn: params.logger?.warn ?? (() => {}),
    error: params.logger?.error ?? (() => {}),
  };

  let config = params.config;
  let enabled = params.enabled !== false;
  let server: http.Server | undefined;
  let status = buildInitialStatus(config, enabled);
  const resolve =
    params.cameraResolver ?? ((id: string) => (id ? id : undefined));

  function pathPrefix(): string {
    return normalizePrefix(config.pathPrefix);
  }

  function maxBody(): number {
    return config.maxBodyBytes && config.maxBodyBytes > 0
      ? config.maxBodyBytes
      : 64 * 1024;
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (req.method !== "POST" && req.method !== "PUT") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
        status.messagesRejected += 1;
        return;
      }

      const host = req.headers.host ?? "localhost";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const prefix = pathPrefix();
      if (!url.pathname.startsWith(prefix + "/") && url.pathname !== prefix) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        status.messagesRejected += 1;
        return;
      }

      const rest = url.pathname.slice(prefix.length).replace(/^\/+/, "");
      const pathCameraId = decodeURIComponent(rest.split("/")[0] ?? "");
      const cameraId = resolve(pathCameraId);
      if (!cameraId) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Unknown camera");
        status.messagesRejected += 1;
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      const limit = maxBody();
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > limit) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload Too Large");
          status.messagesRejected += 1;
          return;
        }
        chunks.push(buf);
      }

      const body = Buffer.concat(chunks);
      const parsed = parseBaichuanWebhookBody(body);
      if (!parsed) {
        log.warn(
          `Baichuan webhook: unparseable body for camera=${cameraId} (${body.length}B)`,
        );
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request");
        status.messagesRejected += 1;
        return;
      }

      const event: BaichuanWebhookEvent = {
        cameraId,
        event: parsed.kind === "event" ? parsed.event : `cmd_${parsed.cmdId}`,
        ...(parsed.kind === "event" && parsed.reason
          ? { reason: parsed.reason }
          : {}),
        receivedAtMs: Date.now(),
        raw: parsed,
      };
      emitBaichuanWebhookEvent(event);
      status.messagesAccepted += 1;
      log.debug(
        `Baichuan webhook camera=${cameraId} event=${event.event}` +
          (event.reason ? ` reason=${event.reason}` : ""),
      );

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.lastErrorMessage = msg;
      status.messagesRejected += 1;
      log.error(`Baichuan webhook handler error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error");
      }
    }
  }

  async function start(): Promise<void> {
    if (server) {
      log.debug("startBaichuanWebhookServer called but server already running");
      return;
    }
    enabled = true;
    server = http.createServer((req, res) => {
      void handle(req, res);
    });
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", (err: NodeJS.ErrnoException) => {
        status.lastErrorMessage = err.message;
        status.running = false;
        reject(err);
      });
      server!.listen(config.port, config.bindHost, () => {
        const addr = server!.address();
        if (addr && typeof addr === "object") {
          status.port = addr.port;
        }
        status.running = true;
        status.enabled = true;
        status.startedAtMs = Date.now();
        status.lastErrorMessage = undefined;
        log.info(
          `Baichuan webhook listening on ${config.bindHost}:${status.port} (prefix=${pathPrefix()})`,
        );
        resolveListen();
      });
    });
  }

  async function stop(): Promise<void> {
    const srv = server;
    server = undefined;
    if (!srv) {
      status.running = false;
      return;
    }
    await new Promise<void>((resolveStop) => {
      srv.close(() => resolveStop());
    });
    status.running = false;
    log.info("Baichuan webhook server stopped");
  }

  return {
    start,
    stop,
    async restart() {
      await stop();
      await start();
    },
    getStatus() {
      return { ...status, enabled, pathPrefix: pathPrefix() };
    },
    updateConfig(next) {
      config = next;
      status.port = next.port;
      status.bindHost = next.bindHost;
      status.pathPrefix = normalizePrefix(next.pathPrefix);
    },
    getCameraWebhookPath(cameraId: string) {
      return getCameraWebhookPath(cameraId, pathPrefix());
    },
  };
}

function buildInitialStatus(
  config: BaichuanWebhookServerConfig,
  enabled: boolean,
): BaichuanWebhookServerStatus {
  return {
    enabled,
    running: false,
    port: config.port,
    bindHost: config.bindHost,
    pathPrefix: normalizePrefix(config.pathPrefix),
    messagesAccepted: 0,
    messagesRejected: 0,
    startedAtMs: undefined,
    lastErrorMessage: undefined,
  };
}
