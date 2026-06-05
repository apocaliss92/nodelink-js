import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as crypto from "node:crypto";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { Logger } from "../../debug/DebugConfig";
import { RtspBackchannel } from "./RtspBackchannel";

/**
 * Dedicated, profile-independent RTSP server that ONLY exposes the
 * client→server talk-back audio leg of a Reolink camera.
 *
 * The Baichuan TalkSession is a per-camera concept (one talk slot per channel,
 * regardless of how many video stream profiles the camera advertises) so this
 * server lives next to the per-profile {@link BaichuanRtspServer} instances
 * rather than inside them. Frigate / go2rtc point a single stream URL at it
 * (typically with `?backchannel=1` so go2rtc switches to RECORD mode) and the
 * dedicated path carries no `main`/`sub`/`ext` profile suffix.
 *
 * Wire protocol: minimal subset of RTSP-over-TCP — OPTIONS, DESCRIBE, SETUP,
 * RECORD, TEARDOWN, optional Digest auth. The DESCRIBE SDP advertises a single
 * `audiobackchannel` track (PCMU 8 kHz, `a=sendonly`, ONVIF-style); SETUP
 * negotiates TCP-interleaved RTP channels; RECORD opens a dedicated
 * TalkSession on the underlying API and `RtspBackchannel` pumps audio.
 */

export interface BaichuanRtspBackchannelServerOptions {
  api: ReolinkBaichuanApi;
  /** Camera channel on the device (NVR child or 0 for standalone). */
  channel: number;
  /** Host to bind the listener to. Default 127.0.0.1. */
  listenHost?: string;
  /** TCP port to bind. Default 8555. */
  listenPort?: number;
  /**
   * Camera-level RTSP path served by this listener. Profile-agnostic by
   * design — e.g. `/talk/camera_studio` or `/camera_studio`. Default: `/talk`.
   */
  path?: string;
  logger?: Logger;

  /**
   * Optional Digest credentials. When set, every method except OPTIONS
   * requires the client to authenticate with one of these users.
   */
  credentials?: Array<
    | { username: string; password: string }
    | { username: string; password?: string; ha1: string }
  >;
  requireAuth?: boolean;
  authRealm?: string;
  /**
   * Optional identifier passed to `createDedicatedTalkSession` so log lines
   * downstream (BaichuanClient, socket pool) attribute the talk socket to a
   * specific camera/device.
   */
  deviceId?: string;
}

type AuthCredential = {
  username: string;
  password?: string | undefined;
  ha1?: string | undefined;
};

const md5Hex = (s: string): string =>
  crypto.createHash("md5").update(s).digest("hex");

interface BackchannelSessionState {
  sessionId: string;
  clientId: string;
  socket: net.Socket;
  rtpChannel: number;
  rtcpChannel: number;
  handler?: RtspBackchannel;
}

export class BaichuanRtspBackchannelServer extends EventEmitter<{
  client: [string];
  clientDisconnected: [string];
  error: [Error];
}> {
  private readonly api: ReolinkBaichuanApi;
  private readonly channel: number;
  private readonly listenHost: string;
  private readonly listenPort: number;
  private readonly path: string;
  private readonly logger: Logger;
  private readonly authCredentials: AuthCredential[];
  private readonly requireAuth: boolean;
  private readonly authRealm: string;
  private readonly deviceId: string | undefined;

  private server: net.Server | undefined = undefined;
  /** Active backchannel sessions keyed by their per-client unique id. */
  private readonly sessionByClient = new Map<string, BackchannelSessionState>();
  private readonly nonces = new Map<string, { nonce: string; ts: number }>();
  private static readonly NONCE_TTL_MS = 5 * 60 * 1000;

  constructor(options: BaichuanRtspBackchannelServerOptions) {
    super();
    this.api = options.api;
    this.channel = options.channel;
    this.listenHost = options.listenHost ?? "127.0.0.1";
    this.listenPort = options.listenPort ?? 8555;
    this.path = options.path ?? "/talk";
    this.logger = options.logger ?? console;
    this.authCredentials = (options.credentials ?? []).map((c) => ({
      username: c.username,
      ...(c.password !== undefined ? { password: c.password } : {}),
      ...((c as { ha1?: string }).ha1 !== undefined
        ? { ha1: (c as { ha1: string }).ha1 }
        : {}),
    }));
    this.requireAuth = options.requireAuth ?? this.authCredentials.length > 0;
    this.authRealm = options.authRealm ?? "BaichuanRtspBackchannelServer";
    this.deviceId = options.deviceId;
  }

  get listening(): boolean {
    return this.server !== undefined && this.server.listening;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      const onError = (err: Error) => {
        server.removeListener("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(this.listenPort, this.listenHost, () => {
        server.removeListener("error", onError);
        this.server = server;
        this.logger.info?.(
          `[BaichuanRtspBackchannelServer] listening on ${this.listenHost}:${this.listenPort} path=${this.path}`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    // Tear down any in-flight sessions.
    for (const session of this.sessionByClient.values()) {
      this.sessionByClient.delete(session.clientId);
      if (session.handler) {
        void session.handler.stop();
      }
      try {
        session.socket.destroy();
      } catch {
        // ignore
      }
    }
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private handleConnection(socket: net.Socket): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    const connectedAt = Date.now();
    let buffer = Buffer.alloc(0);
    this.logger.info?.(
      `[BaichuanRtspBackchannelServer] client connected client=${clientId} path=${this.path}`,
    );
    this.emit("client", clientId);

    const cleanup = () => {
      const session = this.sessionByClient.get(clientId);
      const durationMs = Date.now() - connectedAt;
      if (session) {
        this.sessionByClient.delete(clientId);
        if (session.handler) {
          const stats = session.handler.stats;
          this.logger.info?.(
            `[BaichuanRtspBackchannelServer] client disconnected client=${clientId} session=${session.sessionId} duration=${durationMs}ms rtpRx=${stats.rtpPacketsReceived} rtpDropped=${stats.rtpPacketsDropped} adpcmBlocks=${stats.adpcmBlocksSent}`,
          );
          void session.handler.stop();
        } else {
          this.logger.info?.(
            `[BaichuanRtspBackchannelServer] client disconnected client=${clientId} session=${session.sessionId} duration=${durationMs}ms (no RECORD)`,
          );
        }
      } else {
        this.logger.info?.(
          `[BaichuanRtspBackchannelServer] client disconnected client=${clientId} duration=${durationMs}ms (no SETUP)`,
        );
      }
      this.nonces.delete(clientId);
      this.emit("clientDisconnected", clientId);
    };

    socket.on("close", cleanup);
    socket.on("error", (err) => {
      this.logger.warn?.(
        `[BaichuanRtspBackchannelServer] socket error client=${clientId}: ${err.message}`,
      );
      cleanup();
    });

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      this.drainBuffer(socket, clientId, (b) => {
        buffer = b;
      }, () => buffer);
    });
  }

  /**
   * Drain pending bytes from the per-client buffer. Each iteration first
   * peels off any TCP-interleaved `$` frames at the head (routing them to
   * the session's RtspBackchannel handler when their channel matches) and
   * then attempts to parse a complete RTSP request.
   *
   * Implemented as a thin loop so the parser can yield back to the event
   * loop when the buffer is partial — no async work between frames keeps
   * the data path tight.
   */
  private drainBuffer(
    socket: net.Socket,
    clientId: string,
    setBuffer: (b: Buffer) => void,
    getBuffer: () => Buffer,
  ): void {
    const tryDrainInterleaved = (): boolean => {
      let consumed = false;
      while (true) {
        const buf = getBuffer();
        if (buf.length === 0 || buf[0] !== 0x24) return consumed;
        if (buf.length < 4) return consumed;
        const channel = buf[1] ?? 0;
        const len = buf.readUInt16BE(2);
        if (buf.length < 4 + len) return consumed;
        const rtpPacket = buf.subarray(4, 4 + len);
        setBuffer(buf.subarray(4 + len));
        consumed = true;
        const session = this.sessionByClient.get(clientId);
        if (session && session.rtpChannel === channel && session.handler) {
          session.handler.feedRtp(Buffer.from(rtpPacket));
        }
      }
    };

    void (async () => {
      while (true) {
        tryDrainInterleaved();
        const buf = getBuffer();
        if (buf.length === 0) return;
        if (buf[0] === 0x24) return; // partial interleaved frame, wait for more.
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const requestText = buf.subarray(0, headerEnd).toString("utf8");
        setBuffer(buf.subarray(headerEnd + 4));
        try {
          await this.handleRequest(socket, clientId, requestText);
        } catch (e) {
          this.logger.warn?.(
            `[BaichuanRtspBackchannelServer] handleRequest failed for ${clientId}: ${(e as Error).message}`,
          );
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          return;
        }
      }
    })();
  }

  private async handleRequest(
    socket: net.Socket,
    clientId: string,
    requestText: string,
  ): Promise<void> {
    const lines = requestText.split("\r\n");
    const head = lines[0]?.split(" ") ?? [];
    if (head.length < 3) {
      this.logger.warn?.(
        `[BaichuanRtspBackchannelServer] malformed request from ${clientId}: "${(lines[0] ?? "").slice(0, 120)}"`,
      );
      return;
    }
    const method = head[0] ?? "";
    const url = head[1] ?? "";
    const protocol = head[2] ?? "RTSP/1.0";
    const cseqMatch = requestText.match(/CSeq:\s*(\d+)/i);
    const cseq = cseqMatch ? parseInt(cseqMatch[1] ?? "0", 10) : 0;
    const sessionMatch = requestText.match(/Session:\s*([^;\r\n]+)/i);
    let sessionId = sessionMatch?.[1]?.trim();
    const userAgent = requestText
      .match(/User-Agent:\s*([^\r\n]+)/i)?.[1]
      ?.trim();

    this.logger.info?.(
      `[BaichuanRtspBackchannelServer] >> ${method} ${url} client=${clientId} cseq=${cseq}` +
        (sessionId ? ` session=${sessionId}` : "") +
        (userAgent ? ` ua="${userAgent}"` : ""),
    );

    const send = (
      status: number,
      reason: string,
      headers: Record<string, string> = {},
      body?: string,
    ) => {
      let r = `${protocol} ${status} ${reason}\r\nCSeq: ${cseq}\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        r += `${k}: ${v}\r\n`;
      }
      if (body) {
        const buf = Buffer.from(body, "utf8");
        r += `Content-Length: ${buf.length}\r\n\r\n`;
        socket.write(r);
        socket.write(buf);
      } else {
        r += "\r\n";
        socket.write(r);
      }
      const headerSummary = Object.entries(headers)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      this.logger.info?.(
        `[BaichuanRtspBackchannelServer] << ${status} ${reason} client=${clientId} cseq=${cseq}` +
          (headerSummary ? ` [${headerSummary}]` : "") +
          (body ? ` body=${body.length}B` : ""),
      );
    };

    if (this.requireAuth && method !== "OPTIONS") {
      const authHeader = requestText.match(/Authorization:\s*([^\r\n]+)/i)?.[1] ?? "";
      if (!authHeader) {
        this.logger.info?.(
          `[BaichuanRtspBackchannelServer] auth challenge issued client=${clientId} method=${method}`,
        );
        send(401, "Unauthorized", {
          "WWW-Authenticate": this.wwwAuthenticate(clientId),
        });
        return;
      }
      if (!this.validateDigest(authHeader, method, url, clientId)) {
        this.logger.warn?.(
          `[BaichuanRtspBackchannelServer] auth rejected client=${clientId} method=${method}`,
        );
        this.nonces.delete(clientId);
        send(401, "Unauthorized", {
          "WWW-Authenticate": this.wwwAuthenticate(clientId),
        });
        return;
      }
    }

    switch (method) {
      case "OPTIONS":
        send(200, "OK", {
          Public: "OPTIONS, DESCRIBE, SETUP, RECORD, TEARDOWN",
        });
        return;

      case "DESCRIBE": {
        const sdp = this.buildSdp();
        this.logger.debug?.(
          `[BaichuanRtspBackchannelServer] DESCRIBE sdp for ${clientId}:\n${sdp.trimEnd()}`,
        );
        send(
          200,
          "OK",
          {
            "Content-Type": "application/sdp",
            "Content-Base": `rtsp://${this.listenHost}:${this.listenPort}${this.path}/`,
          },
          sdp,
        );
        return;
      }

      case "SETUP": {
        if (!url.includes("audiobackchannel")) {
          this.logger.warn?.(
            `[BaichuanRtspBackchannelServer] SETUP rejected (unknown track) client=${clientId} url=${url}`,
          );
          send(404, "Not Found");
          return;
        }
        const transportLine = requestText.match(/Transport:\s*([^\r\n]+)/i)?.[1] ?? "";
        this.logger.info?.(
          `[BaichuanRtspBackchannelServer] SETUP transport="${transportLine}" client=${clientId}`,
        );
        if (
          !transportLine.toUpperCase().includes("RTP/AVP/TCP") &&
          !transportLine.toLowerCase().includes("interleaved")
        ) {
          // UDP backchannel from a remote RTSP client would need a bound UDP
          // pair on our side; go2rtc only ever asks for TCP-interleaved.
          this.logger.warn?.(
            `[BaichuanRtspBackchannelServer] SETUP rejected (non-TCP transport) client=${clientId}`,
          );
          send(461, "Unsupported Transport");
          return;
        }
        const interleaved = parseInterleavedChannels(transportLine) ?? {
          rtp: 0,
          rtcp: 1,
        };
        if (!sessionId) {
          sessionId = newSessionId();
        }
        this.sessionByClient.set(clientId, {
          sessionId,
          clientId,
          socket,
          rtpChannel: interleaved.rtp,
          rtcpChannel: interleaved.rtcp,
        });
        this.logger.info?.(
          `[BaichuanRtspBackchannelServer] SETUP ok client=${clientId} session=${sessionId} interleaved=${interleaved.rtp}-${interleaved.rtcp}`,
        );
        send(200, "OK", {
          Transport: `RTP/AVP/TCP;unicast;interleaved=${interleaved.rtp}-${interleaved.rtcp};mode=record`,
          Session: sessionId,
        });
        return;
      }

      case "RECORD": {
        const session = sessionId
          ? Array.from(this.sessionByClient.values()).find(
              (s) => s.sessionId === sessionId,
            )
          : this.sessionByClient.get(clientId);
        if (!session) {
          this.logger.warn?.(
            `[BaichuanRtspBackchannelServer] RECORD without active session client=${clientId} requestedSession=${sessionId ?? "(none)"}`,
          );
          send(454, "Session Not Found");
          return;
        }
        if (session.handler) {
          this.logger.info?.(
            `[BaichuanRtspBackchannelServer] RECORD idempotent (already recording) client=${clientId} session=${session.sessionId}`,
          );
          send(200, "OK", { Session: session.sessionId });
          return;
        }
        const apiRef = this.api;
        const channelForCamera = this.channel;
        const loggerRef = this.logger;
        const deviceIdRef = this.deviceId ?? `rtsp-backchannel-${clientId}`;
        const handler = new RtspBackchannel({
          openTalkSession: () =>
            apiRef.createDedicatedTalkSession(channelForCamera, {
              deviceId: deviceIdRef,
              logger: loggerRef,
            }),
          logger: loggerRef,
        });
        const recordStart = Date.now();
        this.logger.info?.(
          `[BaichuanRtspBackchannelServer] RECORD opening TalkSession client=${clientId} session=${session.sessionId} channel=${channelForCamera} deviceId="${deviceIdRef}"`,
        );
        try {
          const talk = await handler.start();
          this.logger.info?.(
            `[BaichuanRtspBackchannelServer] RECORD talk session ready client=${clientId} session=${session.sessionId} blockSize=${talk.info.blockSize} fullBlockSize=${talk.info.fullBlockSize} sampleRate=${talk.info.audioConfig.sampleRate} audioType=${talk.info.audioConfig.audioType} duplex setupMs=${Date.now() - recordStart}`,
          );
        } catch (e) {
          this.logger.warn?.(
            `[BaichuanRtspBackchannelServer] RECORD failed to open TalkSession client=${clientId} session=${session.sessionId} setupMs=${Date.now() - recordStart} error="${(e as Error).message}"`,
          );
          send(503, "Service Unavailable");
          return;
        }
        session.handler = handler;
        send(200, "OK", { Session: session.sessionId });
        return;
      }

      case "TEARDOWN": {
        const session = this.sessionByClient.get(clientId);
        if (session) {
          this.sessionByClient.delete(clientId);
          if (session.handler) {
            const stats = session.handler.stats;
            this.logger.info?.(
              `[BaichuanRtspBackchannelServer] TEARDOWN client=${clientId} session=${session.sessionId} rtpRx=${stats.rtpPacketsReceived} rtpDropped=${stats.rtpPacketsDropped} adpcmBlocks=${stats.adpcmBlocksSent}`,
            );
            void session.handler.stop();
          } else {
            this.logger.info?.(
              `[BaichuanRtspBackchannelServer] TEARDOWN client=${clientId} session=${session.sessionId} (no RECORD)`,
            );
          }
        } else {
          this.logger.info?.(
            `[BaichuanRtspBackchannelServer] TEARDOWN client=${clientId} (no active session)`,
          );
        }
        send(200, "OK", { Session: sessionId ?? "" });
        try {
          socket.end();
        } catch {
          // ignore
        }
        return;
      }

      default:
        this.logger.warn?.(
          `[BaichuanRtspBackchannelServer] unknown method ${method} from ${clientId} — replying 501`,
        );
        send(501, "Not Implemented");
    }
  }

  private buildSdp(): string {
    return (
      "v=0\r\n" +
      `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.listenHost}\r\n` +
      "s=Baichuan Backchannel\r\n" +
      `c=IN IP4 ${this.listenHost}\r\n` +
      "t=0 0\r\n" +
      "a=control:*\r\n" +
      "m=audio 0 RTP/AVP 0\r\n" +
      "a=rtpmap:0 PCMU/8000\r\n" +
      "a=sendonly\r\n" +
      "a=control:audiobackchannel\r\n"
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // Digest auth helpers (mirror BaichuanRtspServer's behaviour so
  // operators can re-use the same credentials store across both servers).
  // ─────────────────────────────────────────────────────────────────────

  private wwwAuthenticate(clientId: string): string {
    const nonce = this.nonceFor(clientId);
    return `Digest realm="${this.authRealm}", nonce="${nonce}"`;
  }

  private nonceFor(clientId: string): string {
    const now = Date.now();
    const existing = this.nonces.get(clientId);
    if (existing && now - existing.ts < BaichuanRtspBackchannelServer.NONCE_TTL_MS) {
      return existing.nonce;
    }
    const nonce = crypto.randomBytes(16).toString("hex");
    this.nonces.set(clientId, { nonce, ts: now });
    return nonce;
  }

  private validateDigest(
    header: string,
    method: string,
    uri: string,
    clientId: string,
  ): boolean {
    const params = parseDigestHeader(header);
    if (!params) return false;
    if (params.realm && params.realm !== this.authRealm) return false;
    const nonce = this.nonces.get(clientId);
    if (!nonce || nonce.nonce !== params.nonce) return false;
    if (Date.now() - nonce.ts > BaichuanRtspBackchannelServer.NONCE_TTL_MS)
      return false;
    const cred = this.authCredentials.find((c) => c.username === params.username);
    if (!cred) return false;
    const ha1 =
      cred.ha1 ??
      (cred.password !== undefined
        ? md5Hex(`${cred.username}:${this.authRealm}:${cred.password}`)
        : undefined);
    if (!ha1) return false;
    const ha2 = md5Hex(`${method}:${params.uri || uri}`);
    const expected = md5Hex(`${ha1}:${params.nonce}:${ha2}`);
    return expected === params.response;
  }
}

function newSessionId(): string {
  return `talk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function parseInterleavedChannels(
  transport: string,
): { rtp: number; rtcp: number } | undefined {
  const m = transport.match(/interleaved\s*=\s*(\d+)\s*-\s*(\d+)/i);
  if (!m) return undefined;
  const rtp = parseInt(m[1] ?? "", 10);
  const rtcp = parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(rtp) || !Number.isFinite(rtcp)) return undefined;
  return { rtp, rtcp };
}

interface DigestParams {
  username: string;
  realm: string;
  nonce: string;
  uri: string;
  response: string;
}

function parseDigestHeader(header: string): DigestParams | null {
  if (!/^digest\s+/i.test(header)) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)\s*=\s*("([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(header)) !== null) {
    const key = (match[1] ?? "").toLowerCase();
    const value = match[3] ?? match[4] ?? "";
    params[key] = value;
  }
  if (
    !params.username ||
    !params.nonce ||
    !params.uri ||
    !params.response
  ) {
    return null;
  }
  return {
    username: params.username,
    realm: params.realm ?? "",
    nonce: params.nonce,
    uri: params.uri,
    response: params.response,
  };
}
