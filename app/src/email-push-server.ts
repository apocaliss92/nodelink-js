/**
 * Email push server.
 *
 * Listens for SMTP-delivered motion notifications from Reolink battery cameras
 * (Argus, Go, etc.) that don't reliably emit TCP/ONVIF push when sleeping.
 *
 * Flow:
 * 1. Each registered camera gets a virtual recipient `cam-<id>@<domain>`.
 * 2. When a camera sends a motion mail to that recipient, the server parses
 *    the message, inspects subject/body for AI class hints (people/vehicle/…)
 *    and saves any embedded snapshot under `${DATA_PATH}/email-push/<cameraId>/`.
 * 3. A synthetic `ReolinkSimpleEvent` is forwarded to the events-manager so
 *    downstream consumers (SSE, MQTT, HA, Frigate bridge) receive the motion
 *    just like a native push.
 *
 * The pipeline is independent from the Baichuan stack: it works even when the
 * camera is offline/asleep, because the mail is delivered the moment the
 * camera wakes for its short notification window.
 */

import { SMTPServer, type SMTPServerSession } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import { createSelfSignedTlsCert } from "./email-push-tls.js";
import { createSourceLogger } from "./logger.js";
import { getSettings } from "./settings-store.js";
import {
  emitEmailPushEvent,
  getEmailPushCameraResolver,
  getLastEmailPushEvent,
  getRecentEmailPushEvents,
  onEmailPushEvent,
  setEmailPushCameraResolver,
  type EmailPushEvent,
  type EmailPushInferredType,
} from "./email-push-bus.js";

// Re-export bus surface so callers don't need to know the file split.
export {
  getLastEmailPushEvent,
  getRecentEmailPushEvents,
  onEmailPushEvent,
  setEmailPushCameraResolver,
  type EmailPushEvent,
  type EmailPushInferredType,
};

const logger = createSourceLogger("email-push");

// `EmailPushEvent` / `EmailPushInferredType` live in email-push-bus.ts so the
// events-manager and integration tests can import them without dragging in
// the `smtp-server` native dependency. The bus module is the single source
// of truth; the SMTP listener below just emits into it.

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

interface ServerState {
  server: SMTPServer;
  status: EmailPushServerStatus;
}

let state: ServerState | undefined;

/**
 * Subject/body classification. Reolink firmwares put the AI class in the
 * subject with phrases like `"Person detected"`, `"Vehicle alert"`, etc.
 * Falls back to plain "motion" when nothing more specific is recognised.
 */
function classifyMessage(parsed: ParsedMail): EmailPushEvent["inferredType"] {
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

export function getEmailPushServerStatus(): EmailPushServerStatus {
  const settings = getSettings();
  if (state) return { ...state.status };
  return {
    enabled: settings.emailPush.enabled,
    running: false,
    port: settings.emailPush.port,
    bindHost: settings.emailPush.bindHost,
    domain: settings.emailPush.domain,
    requireAuth: settings.emailPush.requireAuth,
    tls: settings.emailPush.tls,
    messagesAccepted: 0,
    messagesRejected: 0,
    startedAtMs: undefined,
    lastErrorMessage: undefined,
  };
}

/** Build the recipient address assigned to a given camera. */
export function getCameraEmailAddress(cameraId: string): string {
  const { domain } = getSettings().emailPush;
  return `cam-${cameraId}@${domain}`;
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
    logger.warn(
      `Failed to parse mail for ${cameraId}: ${err instanceof Error ? err.message : err}`,
    );
    if (state) state.status.messagesRejected++;
    return;
  }

  // Use the manager's reception timestamp rather than `parsed.date`. Some
  // cameras stamp the Date: header rounded to the second (or with clock
  // skew vs. the manager), which breaks `verifyDelivery` polling that
  // compares against a high-resolution "since" timestamp.
  const receivedAtMs = Date.now();

  const event: EmailPushEvent = {
    cameraId,
    recipient,
    inferredType: classifyMessage(parsed),
    receivedAtMs,
    subject: parsed.subject ?? "",
    from:
      typeof parsed.from === "object" && parsed.from !== null && "text" in parsed.from
        ? String(parsed.from.text)
        : "",
    bodyExcerpt: (parsed.text ?? "").slice(0, 500),
  };

  if (state) state.status.messagesAccepted++;
  logger.info(
    `Email push for camera=${cameraId} type=${event.inferredType} subject="${event.subject.slice(0, 80)}"`,
  );
  emitEmailPushEvent(event);
}

function parseRecipient(rcpt: string): { local: string; domain: string } | undefined {
  const [local, domain] = rcpt.toLowerCase().split("@");
  if (!local || !domain) return undefined;
  return { local, domain };
}

function resolveCameraIdFromRecipient(rcpt: string): string | undefined {
  const parsed = parseRecipient(rcpt);
  if (!parsed) return undefined;
  const expectedDomain = getSettings().emailPush.domain.toLowerCase();
  if (parsed.domain !== expectedDomain) return undefined;

  // Format: cam-<id>
  const match = parsed.local.match(/^cam-(.+)$/);
  if (!match || !match[1]) return undefined;
  const candidate = match[1];

  // Defer to the resolver: the cameraId must correspond to a registered camera.
  return getEmailPushCameraResolver()(candidate);
}

/** Start the SMTP server using current settings. No-op if already running. */
export async function startEmailPushServer(): Promise<void> {
  if (state) {
    logger.debug("startEmailPushServer called but server already running");
    return;
  }
  const settings = getSettings();
  if (!settings.emailPush.enabled) {
    logger.debug("Email push is disabled in settings; not starting");
    return;
  }

  const tlsOptions = settings.emailPush.tls
    ? await createSelfSignedTlsCert()
    : undefined;

  const status: EmailPushServerStatus = {
    enabled: true,
    running: false,
    port: settings.emailPush.port,
    bindHost: settings.emailPush.bindHost,
    domain: settings.emailPush.domain,
    requireAuth: settings.emailPush.requireAuth,
    tls: settings.emailPush.tls,
    messagesAccepted: 0,
    messagesRejected: 0,
    startedAtMs: undefined,
    lastErrorMessage: undefined,
  };

  const server = new SMTPServer({
    authOptional: !settings.emailPush.requireAuth,
    disabledCommands: settings.emailPush.requireAuth ? [] : ["AUTH"],
    allowInsecureAuth: !settings.emailPush.tls,
    size: settings.emailPush.maxMessageBytes,
    // Pipe smtp-server's protocol logs into our logger at debug level so
    // diagnostic info (EHLO greeting, AUTH method negotiation, STARTTLS
    // requests, error replies) shows up alongside the connect/close
    // events when a Reolink firmware hangs up early.
    logger: {
      info: (...args: unknown[]) =>
        logger.debug(`[smtp] ${args.map((a) => String(a)).join(" ")}`),
      debug: (...args: unknown[]) =>
        logger.debug(`[smtp] ${args.map((a) => String(a)).join(" ")}`),
      error: (...args: unknown[]) =>
        logger.warn(`[smtp] ${args.map((a) => String(a)).join(" ")}`),
    } as unknown as false,
    ...(tlsOptions ? { secure: false, ...tlsOptions } : {}),
    onConnect(session, callback) {
      logger.info(
        `SMTP connect from ${session.remoteAddress} (sessionId=${session.id})`,
      );
      callback();
    },
    onClose(session) {
      logger.debug(
        `SMTP close ${session.remoteAddress} (sessionId=${session.id})`,
      );
    },
    onMailFrom(address, session, callback) {
      logger.info(
        `SMTP MAIL FROM ${address.address} (sessionId=${session.id})`,
      );
      callback();
    },
    onAuth(auth, session, callback) {
      const expectedUser = settings.emailPush.authUsername;
      const expectedPass = settings.emailPush.authPassword;
      if (!expectedUser || !expectedPass) {
        logger.warn(
          `SMTP AUTH rejected from ${session.remoteAddress} (sessionId=${session.id}): server has no credentials configured`,
        );
        return callback(new Error("Email push auth not configured"));
      }
      // Reolink firmwares are configured with `userName = bareUser@domain`
      // (auto-configure wraps the bare username in an email-shaped form so
      // the camera can use it in `MAIL FROM`). On AUTH the camera sends
      // back the wrapped form too, so strip the configured domain suffix
      // before comparing — that way `nodelink-5f6a1620@nodelink.local`
      // matches the stored `nodelink-5f6a1620` and the user is free to
      // keep credentials in either form in settings.json.
      const stripDomain = (u: string): string => {
        const at = u.lastIndexOf("@");
        if (at < 0) return u;
        const local = u.slice(0, at);
        const domain = u.slice(at + 1).toLowerCase();
        return domain === settings.emailPush.domain.toLowerCase() ? local : u;
      };
      const triedUserNorm = stripDomain(auth.username ?? "");
      const expectedUserNorm = stripDomain(expectedUser);
      if (
        triedUserNorm === expectedUserNorm &&
        auth.password === expectedPass
      ) {
        logger.info(
          `SMTP AUTH ok method=${auth.method} user=${auth.username} (sessionId=${session.id})`,
        );
        return callback(null, { user: auth.username });
      }
      logger.warn(
        `SMTP AUTH FAIL method=${auth.method} from=${session.remoteAddress} ` +
          `triedUser="${auth.username}" expectedUser="${expectedUser}" ` +
          `triedPasswordLen=${auth.password?.length ?? 0} (sessionId=${session.id})`,
      );
      return callback(new Error("Invalid username or password"));
    },
    onRcptTo(address, _session, callback) {
      const cameraId = resolveCameraIdFromRecipient(address.address);
      if (!cameraId) {
        status.messagesRejected++;
        return callback(
          new Error(`Unknown recipient ${address.address} (not registered)`),
        );
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const recipients =
          session.envelope.rcptTo?.map((r) => r.address) ?? [];
        const buffer = Buffer.concat(chunks);
        // Reolink batches a single mail per event; if multiple recipients
        // belong to different cameras (unusual), we route to each.
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
            logger.error(`Email push pipeline error: ${msg}`);
            status.lastErrorMessage = msg;
            callback(new Error(msg));
          });
      });
      stream.on("error", (err: Error) => {
        logger.warn(`SMTP stream error: ${err.message}`);
        callback(err);
      });
    },
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    status.lastErrorMessage = err.message;
    logger.error(`Email push server error: ${err.message}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(
      settings.emailPush.port,
      settings.emailPush.bindHost,
      () => {
        status.running = true;
        status.startedAtMs = Date.now();
        logger.info(
          `Email push SMTP listening on ${settings.emailPush.bindHost}:${settings.emailPush.port} (domain=${settings.emailPush.domain}, auth=${settings.emailPush.requireAuth}, tls=${settings.emailPush.tls})`,
        );
        resolve();
      },
    );
    server.once("error", reject);
  });

  state = { server, status };
}

/** Stop the SMTP server. Safe to call when already stopped. */
export async function stopEmailPushServer(): Promise<void> {
  if (!state) return;
  const { server } = state;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  state = undefined;
  logger.info("Email push SMTP server stopped");
}

/** Stop and re-start to apply new settings. */
export async function restartEmailPushServer(): Promise<void> {
  await stopEmailPushServer();
  await startEmailPushServer();
}

/** Test hook: dispatch a synthetic event into the bus without an SMTP round-trip. */
export function emitSyntheticEmailPushEventForTest(event: EmailPushEvent): void {
  emitEmailPushEvent(event);
}
