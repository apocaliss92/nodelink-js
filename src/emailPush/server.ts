/**
 * Email push SMTP intake.
 *
 * Factory-style entrypoint: callers pass a config object + a
 * `cameraResolver` (mapping the RCPT TO localpart to their internal
 * cameraId) and get back an instance with `start / stop / restart /
 * getStatus`. Storage, lifecycle, and settings persistence stay with
 * the consumer; the library only owns the SMTP intake + classification
 * + the bus dispatch.
 *
 * Events are emitted through `bus.ts` so any consumer can subscribe via
 * `onEmailPushEvent(...)` regardless of which app started the server.
 */

import { format as utilFormat } from "node:util";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import {
  emitEmailPushEvent,
  type EmailPushEvent,
  type EmailPushInferredType,
} from "./bus.js";
import {
  loadEmailPushTls,
  type EmailPushTlsOptions,
} from "./tls.js";

export interface EmailPushServerConfig {
  /** SMTP listen port. */
  port: number;
  /** Bind host (`0.0.0.0` to accept on LAN). */
  bindHost: string;
  /** Virtual mail domain — used to extract the camera id from RCPT TO. */
  domain: string;
  /** Require AUTH PLAIN / AUTH LOGIN. */
  requireAuth: boolean;
  /** Expected AUTH username (stored bare, e.g. `nodelink-abcd`). */
  authUsername: string;
  /** Expected AUTH password. */
  authPassword: string;
  /** Enable STARTTLS using cert+key under `tlsDir`. */
  tls: boolean;
  /** Directory holding cert.pem + key.pem when `tls: true`. */
  tlsDir?: string;
  /** Maximum accepted message size in bytes. */
  maxMessageBytes: number;
}

export interface EmailPushServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  bindHost: string;
  domain: string;
  requireAuth: boolean;
  tls: boolean;
  /** Cumulative messages accepted since start. */
  messagesAccepted: number;
  /** Cumulative messages rejected (unknown recipient, parse fail, etc.). */
  messagesRejected: number;
  startedAtMs: number | undefined;
  lastErrorMessage: string | undefined;
}

export interface EmailPushLogger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface EmailPushServerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  getStatus(): EmailPushServerStatus;
  /**
   * Replace the current config; the next `start` / `restart` picks it up.
   * Hot updates of config without restart are not supported on purpose —
   * SMTP server bind options need a fresh `listen()`.
   */
  updateConfig(next: EmailPushServerConfig): void;
}

export interface CreateEmailPushServerParams {
  config: EmailPushServerConfig;
  /**
   * Resolver mapping the `cam-<id>` localpart (the part before `@domain`)
   * to the consumer's internal camera identifier. Return `undefined` to
   * reject the recipient at RCPT TO.
   */
  cameraResolver: (localCameraId: string) => string | undefined;
  /** Optional logger; defaults to no-op. */
  logger?: EmailPushLogger;
  /**
   * Optional TLS loader override. Default uses `loadEmailPushTls` which
   * reads `cert.pem` + `key.pem` from `config.tlsDir`. Consumers (e.g.
   * Scrypted) can pass their own loader to source the material from a
   * different store.
   */
  loadTls?: (
    dir: string,
    warn: (m: string) => void,
  ) => Promise<EmailPushTlsOptions | undefined>;
}

async function defaultLoadTls(
  dir: string,
  warn: (m: string) => void,
): Promise<EmailPushTlsOptions | undefined> {
  return loadEmailPushTls({ dir, warn });
}

function classifyMessage(parsed: ParsedMail): EmailPushInferredType {
  const haystack =
    `${parsed.subject ?? ""} ${parsed.text ?? ""}`.toLowerCase();
  if (/person|people|human/.test(haystack)) return "people";
  if (/vehicle|car|truck/.test(haystack)) return "vehicle";
  if (/dog[_\s-]?cat|pet|animal/.test(haystack)) return "animal";
  if (/face/.test(haystack)) return "face";
  if (/package|parcel/.test(haystack)) return "package";
  if (/doorbell|ring(?:ing)?\s+button/.test(haystack)) return "doorbell";
  if (/motion|alarm|alert|detect/.test(haystack)) return "motion";
  return "other";
}

/** Build the recipient address assigned to a given camera. */
export function getCameraEmailAddress(
  cameraId: string,
  domain: string,
): string {
  return `cam-${cameraId}@${domain}`;
}

export function createEmailPushServer(
  params: CreateEmailPushServerParams,
): EmailPushServerInstance {
  const log: Required<EmailPushLogger> = {
    debug: params.logger?.debug ?? (() => {}),
    info: params.logger?.info ?? (() => {}),
    warn: params.logger?.warn ?? (() => {}),
    error: params.logger?.error ?? (() => {}),
  };

  let config = params.config;
  let server: SMTPServer | undefined;
  let status: EmailPushServerStatus = buildInitialStatus(config);

  // NOTE: the factory does NOT touch the bus's resolver slot.
  // `params.cameraResolver` is invoked directly from
  // `resolveCameraIdFromRecipient` below — registering it on the bus
  // too would create a recursion when consumers proxy through
  // `getEmailPushCameraResolver()` (manager-app adapter pattern).

  function parseRecipient(
    rcpt: string,
  ): { local: string; domain: string } | undefined {
    const [local, domain] = rcpt.toLowerCase().split("@");
    if (!local || !domain) return undefined;
    return { local, domain };
  }

  function resolveCameraIdFromRecipient(rcpt: string): string | undefined {
    const parsed = parseRecipient(rcpt);
    if (!parsed) return undefined;
    if (parsed.domain !== config.domain.toLowerCase()) return undefined;
    const match = parsed.local.match(/^cam-(.+)$/);
    if (!match || !match[1]) return undefined;
    return params.cameraResolver(match[1]);
  }

  async function handleIncomingMessage(
    cameraId: string,
    recipient: string,
    raw: Buffer,
  ): Promise<void> {
    let parsed: ParsedMail;
    try {
      parsed = await simpleParser(raw);
    } catch (err) {
      log.warn(
        `Failed to parse mail for ${cameraId}: ${err instanceof Error ? err.message : err}`,
      );
      status.messagesRejected++;
      return;
    }

    const receivedAtMs = Date.now();
    // mailparser exposes every attachment in `parsed.attachments`; we
    // keep only the first inline image (the snapshot Reolink sends
    // when `attachmentType=picture`) so consumers can refresh the
    // camera's cached thumbnail without waking the device. Multiple
    // attachments are rare from Reolink firmwares; we pick the first
    // image and drop the rest to keep the bus event light.
    const imageAttachment = (parsed.attachments ?? []).find(
      (a) =>
        a &&
        typeof a.contentType === "string" &&
        a.contentType.toLowerCase().startsWith("image/") &&
        Buffer.isBuffer(a.content),
    );
    const event: EmailPushEvent = {
      cameraId,
      recipient,
      inferredType: classifyMessage(parsed),
      receivedAtMs,
      subject: parsed.subject ?? "",
      from:
        typeof parsed.from === "object" &&
        parsed.from !== null &&
        "text" in parsed.from
          ? String(parsed.from.text)
          : "",
      bodyExcerpt: (parsed.text ?? "").slice(0, 500),
      ...(imageAttachment
        ? {
            attachment: {
              contentType: imageAttachment.contentType,
              data: imageAttachment.content as Buffer,
              ...(imageAttachment.filename
                ? { filename: imageAttachment.filename }
                : {}),
            },
          }
        : {}),
    };

    status.messagesAccepted++;
    log.info(
      `Email push for camera=${cameraId} type=${event.inferredType} ` +
        `attachment=${event.attachment ? `${event.attachment.contentType} ${event.attachment.data.length}B` : "none"} ` +
        `subject="${event.subject.slice(0, 80)}"`,
    );
    emitEmailPushEvent(event);
  }

  async function start(): Promise<void> {
    if (server) {
      log.debug("startEmailPushServer called but server already running");
      return;
    }

    const tlsOptions = config.tls
      ? await (params.loadTls ?? defaultLoadTls)(
          config.tlsDir ?? "./email-push-tls",
          (m) => log.warn(m),
        )
      : undefined;

    status = buildInitialStatus(config);

    const next = new SMTPServer({
      authOptional: !config.requireAuth,
      disabledCommands: config.requireAuth ? [] : ["AUTH"],
      allowInsecureAuth: !config.tls,
      size: config.maxMessageBytes,
      // smtp-server invokes its internal logger as
      //   logger.info(metadata, formatString, ...args)
      // where `metadata` is an opaque session/connection object and
      // `formatString` may contain printf-style placeholders.
      // Naive `.map(String).join(" ")` would surface `[object Object]`
      // and leave `%s` unresolved (which is what the user was seeing).
      // Here we strip the metadata (keeping a compact `tnx`/`cid` tag
      // when present), then apply `util.format` so placeholders are
      // expanded by Node exactly like the smtp-server defaults do.
      logger: {
        info: (...args: unknown[]) => log.info(formatSmtpLogArgs(args)),
        debug: (...args: unknown[]) => log.debug(formatSmtpLogArgs(args)),
        error: (...args: unknown[]) => log.warn(formatSmtpLogArgs(args)),
      } as unknown as false,
      ...(tlsOptions ? { secure: false, ...tlsOptions } : {}),
      onConnect(session, callback) {
        log.info(
          `SMTP connect from ${session.remoteAddress} (sessionId=${session.id})`,
        );
        callback();
      },
      onClose(session) {
        log.debug(
          `SMTP close ${session.remoteAddress} (sessionId=${session.id})`,
        );
      },
      onMailFrom(address, session, callback) {
        log.info(
          `SMTP MAIL FROM ${address.address} (sessionId=${session.id})`,
        );
        callback();
      },
      onAuth(auth, session, callback) {
        const expectedUser = config.authUsername;
        const expectedPass = config.authPassword;
        if (!expectedUser || !expectedPass) {
          log.warn(
            `SMTP AUTH rejected from ${session.remoteAddress} (sessionId=${session.id}): server has no credentials configured`,
          );
          return callback(new Error("Email push auth not configured"));
        }
        const stripDomain = (u: string): string => {
          const at = u.lastIndexOf("@");
          if (at < 0) return u;
          const local = u.slice(0, at);
          const domain = u.slice(at + 1).toLowerCase();
          return domain === config.domain.toLowerCase() ? local : u;
        };
        const triedUserNorm = stripDomain(auth.username ?? "");
        const expectedUserNorm = stripDomain(expectedUser);
        if (
          triedUserNorm === expectedUserNorm &&
          auth.password === expectedPass
        ) {
          log.info(
            `SMTP AUTH ok method=${auth.method} user=${auth.username} (sessionId=${session.id})`,
          );
          return callback(null, { user: auth.username });
        }
        log.warn(
          `SMTP AUTH FAIL method=${auth.method} from=${session.remoteAddress} ` +
            `triedUser="${auth.username}" expectedUser="${expectedUser}" ` +
            `triedPasswordLen=${auth.password?.length ?? 0} (sessionId=${session.id})`,
        );
        return callback(new Error("Invalid username or password"));
      },
      onRcptTo(address, session, callback) {
        const cameraId = resolveCameraIdFromRecipient(address.address);
        if (!cameraId) {
          status.messagesRejected++;
          log.warn(
            `SMTP RCPT TO rejected ${address.address} — unknown recipient ` +
              `(sessionId=${session.id})`,
          );
          return callback(
            new Error(
              `Unknown recipient ${address.address} (not registered)`,
            ),
          );
        }
        log.info(
          `SMTP RCPT TO ${address.address} → camera=${cameraId} ` +
            `(sessionId=${session.id})`,
        );
        callback();
      },
      onData(stream, session, callback) {
        const startedAt = Date.now();
        log.debug(
          `SMTP DATA start (sessionId=${session.id} from=${session.envelope.mailFrom ? (session.envelope.mailFrom as { address: string }).address : "?"})`,
        );
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          const recipients =
            session.envelope.rcptTo?.map((r) => r.address) ?? [];
          const buffer = Buffer.concat(chunks);
          log.info(
            `SMTP DATA received ${buffer.length}B in ${Date.now() - startedAt}ms ` +
              `for ${recipients.length} recipient(s) (sessionId=${session.id})`,
          );
          const matched = recipients
            .map((r) => ({
              recipient: r,
              cameraId: resolveCameraIdFromRecipient(r),
            }))
            .filter((m): m is { recipient: string; cameraId: string } =>
              Boolean(m.cameraId),
            );
          if (matched.length === 0) {
            status.messagesRejected++;
            log.warn(
              `SMTP DATA dropped — no recognised recipients in [${recipients.join(", ")}] ` +
                `(sessionId=${session.id})`,
            );
            return callback(new Error("No recognised recipients"));
          }
          Promise.all(
            matched.map((m) =>
              handleIncomingMessage(m.cameraId, m.recipient, buffer),
            ),
          )
            .then(() => callback())
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              log.error(
                `Email push pipeline error (sessionId=${session.id}): ${msg}`,
              );
              status.lastErrorMessage = msg;
              callback(new Error(msg));
            });
        });
        stream.on("error", (err: Error) => {
          log.warn(`SMTP stream error (sessionId=${session.id}): ${err.message}`);
          callback(err);
        });
      },
    });

    next.on("error", (err: NodeJS.ErrnoException) => {
      status.lastErrorMessage = err.message;
      log.error(`Email push server error: ${err.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      next.listen(config.port, config.bindHost, () => {
        status.running = true;
        status.startedAtMs = Date.now();
        log.info(
          `Email push SMTP listening on ${config.bindHost}:${config.port} (domain=${config.domain}, auth=${config.requireAuth}, tls=${config.tls})`,
        );
        resolve();
      });
      next.once("error", reject);
    });

    server = next;
  }

  async function stop(): Promise<void> {
    if (!server) return;
    const active = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      active.close(() => resolve());
    });
    status.running = false;
    log.info("Email push SMTP server stopped");
  }

  async function restart(): Promise<void> {
    await stop();
    await start();
  }

  return {
    start,
    stop,
    restart,
    getStatus(): EmailPushServerStatus {
      // Return a copy so callers can't mutate internal counters.
      return { ...status };
    },
    updateConfig(next: EmailPushServerConfig): void {
      config = next;
    },
  };
}

/**
 * Format smtp-server's `(metadata, formatString, ...args)` log calls
 * back into a single printable string. smtp-server prepends a
 * session/connection metadata object to every log line; we strip it
 * (keeping `tnx`/`cid` when present) and apply Node's `util.format`
 * so `%s` / `%d` placeholders in the format string are resolved.
 */
function formatSmtpLogArgs(args: unknown[]): string {
  if (args.length === 0) return "[smtp]";
  const [first, ...rest] = args;
  // smtp-server first arg is the metadata bag — extract a compact tag
  // so we can correlate lines without dumping the full object.
  let tag = "";
  let formatArgs: unknown[] = args;
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const meta = first as Record<string, unknown>;
    const tnx = typeof meta.tnx === "string" ? meta.tnx : undefined;
    const cid = typeof meta.cid === "string" ? meta.cid : undefined;
    const sid = typeof meta.sid === "string" ? meta.sid : undefined;
    const bits: string[] = [];
    if (tnx) bits.push(tnx);
    if (cid) bits.push(`cid=${cid}`);
    if (sid) bits.push(`sid=${sid}`);
    if (bits.length > 0) tag = ` [${bits.join(" ")}]`;
    formatArgs = rest;
  }
  // `formatArgs[0]` is typically the printf-style format string.
  // util.format gracefully handles both "no placeholders + extra args"
  // (concatenates with spaces) and "format + matching args".
  return `[smtp]${tag} ${utilFormat(...(formatArgs as [unknown, ...unknown[]]))}`;
}

function buildInitialStatus(
  config: EmailPushServerConfig,
): EmailPushServerStatus {
  return {
    enabled: true,
    running: false,
    port: config.port,
    bindHost: config.bindHost,
    domain: config.domain,
    requireAuth: config.requireAuth,
    tls: config.tls,
    messagesAccepted: 0,
    messagesRejected: 0,
    startedAtMs: undefined,
    lastErrorMessage: undefined,
  };
}
