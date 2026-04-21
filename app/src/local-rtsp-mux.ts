/**
 * LocalRtspMux — single-port RTSP multiplexer.
 *
 * Problem it solves
 * -----------------
 * The "local" restreamer uses one `MuxRtspHandler` instance per
 * camera × profile. Previously each instance owned its own TCP port, which
 * meant every stream required a dedicated port hole in firewalls / docker
 * port mappings (e.g. 8554, 8555, 8557, …).
 *
 * This multiplexer binds ONE TCP port and routes every incoming RTSP
 * connection to the correct `MuxRtspHandler` based on the URL path of
 * the very first request line (`OPTIONS|DESCRIBE rtsp://host:port/<path>`
 * `RTSP/1.0`). All streams are then reachable via a single port with
 * distinct paths, e.g. `rtsp://host:8554/studio/main` and
 * `rtsp://host:8554/campanello/sub`.
 *
 * Protocol notes
 * --------------
 * RTSP 1.0 (RFC 2326) message structure is identical to HTTP/1.1 headers:
 * the first line is "METHOD <uri> RTSP/1.0\r\n". We only need to buffer
 * until the first CRLF to learn the target path; no need to parse the full
 * header block or body. Once routed, the socket bytes are replayed back
 * (via `socket.unshift`) and the matched `MuxRtspHandler` takes over.
 *
 * Constraints honoured by this implementation
 * -------------------------------------------
 *   - First request line may arrive in several TCP segments → accumulate.
 *   - Unknown path → 404 Not Found (with best-effort CSeq echoed back).
 *   - Silent client (no bytes within 5 s) → 400 Bad Request + destroy.
 *   - Data already consumed during routing is replayed via `socket.unshift`
 *     BEFORE the handler reads the socket (handled by `injectSocket`).
 *   - The mux never parses auth — the stream server does that after handoff.
 */
import * as net from "net";

/**
 * Structural contract of a mux-compatible RTSP handler.
 *
 * Typed structurally (not as `MuxRtspHandler`) so callers can plug in
 * the stream server whether it was imported from `@apocaliss92/nodelink-js`
 * (the published API surface) or directly from `src/` (local development /
 * E2E tests). Both point at the same class at runtime, but they may refer
 * to separate TypeScript declarations that differ only in private fields.
 * A structural type ignores those private fields and keeps the mux honest
 * about the minimum public API it depends on.
 */
export interface MuxRtspHandler {
  injectSocket(socket: net.Socket, preReadData: Buffer): void;
}

interface MuxLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

/** Maximum bytes we buffer while waiting for the first request line. */
const MAX_FIRST_LINE_BYTES = 8 * 1024; // 8 KiB is way more than RFC requires.

/** How long to wait for the first CRLF after a client connects. */
const FIRST_LINE_TIMEOUT_MS = 5_000;

/** Canonicalise a URL path for lookup: strip query string, collapse trailing `/`. */
function normalizePath(rawPath: string): string {
  // Remove query string if present
  const q = rawPath.indexOf("?");
  const noQuery = q >= 0 ? rawPath.slice(0, q) : rawPath;
  // Collapse trailing slash unless the whole path is "/"
  if (noQuery.length > 1 && noQuery.endsWith("/")) {
    return noQuery.slice(0, -1);
  }
  return noQuery;
}

/**
 * Extract the URL pathname from a raw RTSP request-line.
 * Accepts either an absolute URI (e.g. `rtsp://host:port/studio/main`) or a
 * path-only form (e.g. `/studio/main`).
 */
function parsePathFromRequestLine(line: string): string | null {
  // "METHOD <uri> RTSP/1.0"
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const uri = parts[1];
  if (!uri) return null;

  // Absolute RTSP URI → pull the path component.
  if (/^rtsps?:\/\//i.test(uri)) {
    try {
      // URL does not understand rtsp://, but the HTTP-style parsing is the
      // same. Temporarily rewrite the scheme to http:// to reuse the WHATWG
      // URL parser, which handles IPv6 hosts and weird ports correctly.
      const asHttp = uri.replace(/^rtsps?:/i, "http:");
      const parsed = new URL(asHttp);
      return normalizePath(parsed.pathname || "/");
    } catch {
      // Fallback: manual slice after the authority.
      const schemeEnd = uri.indexOf("://");
      const pathStart = uri.indexOf("/", schemeEnd + 3);
      if (pathStart === -1) return "/";
      return normalizePath(uri.slice(pathStart));
    }
  }

  // Path-only form — already relative.
  if (uri.startsWith("/")) {
    return normalizePath(uri);
  }
  return null;
}

/** Best-effort CSeq extraction from a partially-received header block. */
function extractCSeq(buffer: string): string {
  const m = buffer.match(/\r\nCSeq:\s*(\d+)/i);
  return m ? m[1]! : "0";
}

export class LocalRtspMux {
  private readonly server: net.Server;
  private readonly routes = new Map<string, MuxRtspHandler>();
  private started = false;

  constructor(
    private readonly port: number,
    private readonly bindHost: string,
    private readonly logger: MuxLogger,
  ) {
    this.server = net.createServer({ allowHalfOpen: false });
    this.server.on("connection", (socket) => this.route(socket));
    this.server.on("error", (err) => {
      this.logger.error(`[LocalRtspMux] server error: ${err}`);
    });
  }

  /** Register a path → MuxRtspHandler mapping. Overwrites any previous registration. */
  register(path: string, handler: MuxRtspHandler): void {
    const key = normalizePath(path);
    if (this.routes.has(key)) {
      this.logger.warn(
        `[LocalRtspMux] path "${key}" re-registered — replacing previous handler`,
      );
    }
    this.routes.set(key, handler);
    this.logger.info(
      `[LocalRtspMux] registered path "${key}" (total=${this.routes.size})`,
    );
  }

  /** Remove a previously registered path. Safe to call for unknown paths. */
  unregister(path: string): void {
    const key = normalizePath(path);
    if (this.routes.delete(key)) {
      this.logger.info(
        `[LocalRtspMux] unregistered path "${key}" (total=${this.routes.size})`,
      );
    }
  }

  get registeredPaths(): string[] {
    return Array.from(this.routes.keys()).sort();
  }

  get listenPort(): number {
    return this.port;
  }

  get listenHost(): string {
    return this.bindHost;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.bindHost);
    });
    this.started = true;
    this.logger.info(
      `[LocalRtspMux] listening on ${this.bindHost}:${this.port}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.routes.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.started = false;
    this.logger.info(`[LocalRtspMux] stopped`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Routing
  // ──────────────────────────────────────────────────────────────────────

  private route(socket: net.Socket): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    let buffered = Buffer.alloc(0);
    let settled = false;

    // Arm a 5-second timer so a silent (or malformed) client cannot pin a
    // socket to the mux forever.
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      writeStatusAndDestroy(
        socket,
        `RTSP/1.0 400 Bad Request\r\nCSeq: 0\r\n\r\n`,
      );
      this.logger.warn(
        `[LocalRtspMux] ${clientId} → 400 (no request line within ${FIRST_LINE_TIMEOUT_MS}ms)`,
      );
    }, FIRST_LINE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(deadline);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      this.logger.warn(`[LocalRtspMux] ${clientId} socket error: ${err}`);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;

      buffered = Buffer.concat([buffered, chunk]);

      // Look for the end of the first request line (CRLF).
      const crlfIdx = buffered.indexOf("\r\n");

      if (crlfIdx === -1) {
        // Not enough data yet — but guard against a client that sends
        // megabytes without ever terminating the first line.
        if (buffered.length > MAX_FIRST_LINE_BYTES) {
          settled = true;
          cleanup();
          writeStatusAndDestroy(
            socket,
            `RTSP/1.0 400 Bad Request\r\nCSeq: 0\r\n\r\n`,
          );
          this.logger.warn(
            `[LocalRtspMux] ${clientId} → 400 (request line exceeded ${MAX_FIRST_LINE_BYTES} bytes)`,
          );
        }
        return;
      }

      // We have the first line — stop consuming and route.
      settled = true;
      cleanup();

      const firstLine = buffered.slice(0, crlfIdx).toString("utf8");
      const path = parsePathFromRequestLine(firstLine);

      if (!path) {
        writeStatusAndDestroy(
          socket,
          `RTSP/1.0 400 Bad Request\r\nCSeq: ${extractCSeq(buffered.toString("utf8"))}\r\n\r\n`,
        );
        this.logger.warn(
          `[LocalRtspMux] ${clientId} → 400 (unparseable request line: ${JSON.stringify(firstLine)})`,
        );
        return;
      }

      const handler = this.routes.get(path);
      if (!handler) {
        writeStatusAndDestroy(
          socket,
          `RTSP/1.0 404 Not Found\r\nCSeq: ${extractCSeq(buffered.toString("utf8"))}\r\n\r\n`,
        );
        this.logger.warn(
          `[LocalRtspMux] ${clientId} → 404 (no route for path "${path}") known=[${this.registeredPaths.join(",")}]`,
        );
        return;
      }

      this.logger.info(
        `[LocalRtspMux] ${clientId} → route "${path}" (firstLine=${JSON.stringify(firstLine)})`,
      );

      // Hand off: pause while we swap listeners so no further 'data' events
      // are delivered to a dead listener; injectSocket() unshifts the
      // buffered bytes and resumes the flow.
      try {
        socket.pause();
        handler.injectSocket(socket, buffered);
        socket.resume();
      } catch (err) {
        this.logger.error(
          `[LocalRtspMux] ${clientId} → handler.injectSocket failed: ${err}`,
        );
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
    };

    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("data", onData);
  }
}

function writeStatusAndDestroy(socket: net.Socket, response: string): void {
  try {
    if (!socket.destroyed) {
      socket.end(response);
    }
  } catch {
    // ignore
  }
  // `end()` triggers FIN; if the peer is rude enough to hold the socket
  // open, destroy after a short grace period.
  setTimeout(() => {
    try {
      if (!socket.destroyed) socket.destroy();
    } catch {
      // ignore
    }
  }, 200).unref();
}

// ──────────────────────────────────────────────────────────────────────
// Singleton lifecycle — one mux per manager process.
// ──────────────────────────────────────────────────────────────────────

let _mux: LocalRtspMux | null = null;

export function getLocalRtspMux(): LocalRtspMux | null {
  return _mux;
}

export function initLocalRtspMux(
  port: number,
  bindHost: string,
  logger: MuxLogger,
): LocalRtspMux {
  if (_mux) {
    if (_mux.listenPort === port && _mux.listenHost === bindHost) {
      return _mux;
    }
    logger.warn(
      `[LocalRtspMux] init called with different bind (${bindHost}:${port} vs current ${_mux.listenHost}:${_mux.listenPort}); caller should stop the old instance first`,
    );
  }
  _mux = new LocalRtspMux(port, bindHost, logger);
  return _mux;
}

export async function stopLocalRtspMux(): Promise<void> {
  if (!_mux) return;
  const current = _mux;
  _mux = null;
  await current.stop();
}
