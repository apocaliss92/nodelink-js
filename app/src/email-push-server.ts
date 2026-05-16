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
import { simpleParser, type ParsedMail, type Attachment } from "mailparser";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createSelfSignedTlsCert } from "./email-push-tls.js";
import { createSourceLogger } from "./logger.js";
import { getSettings } from "./settings-store.js";

const logger = createSourceLogger("email-push");

const DATA_DIR = process.env.DATA_PATH || ".";
const SNAPSHOT_ROOT = path.join(DATA_DIR, "email-push");

/** Maximum size of a single attachment we'll persist (best-effort safety). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface EmailPushEvent {
  cameraId: string;
  /** Original recipient address that matched this camera. */
  recipient: string;
  /** Reolink AI class extracted from subject/body, or "motion" as fallback. */
  inferredType:
    | "motion"
    | "people"
    | "vehicle"
    | "animal"
    | "face"
    | "package"
    | "doorbell"
    | "other";
  /** Mail timestamp (parsed Date or fall-back to receipt time). */
  receivedAtMs: number;
  subject: string;
  from: string;
  /** Path of the saved snapshot attachment, if any. Relative to DATA_PATH. */
  snapshotPath?: string;
  /** Raw body text excerpt (max 500 chars) — useful for debugging unknown firmwares. */
  bodyExcerpt: string;
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

type CameraResolver = (recipient: string) => string | undefined;
type EventHandler = (event: EmailPushEvent) => void;

interface ServerState {
  server: SMTPServer;
  status: EmailPushServerStatus;
  pruneTimer: NodeJS.Timeout | undefined;
}

let state: ServerState | undefined;
let cameraResolver: CameraResolver = () => undefined;
const emitter = new EventEmitter();
const recentEventsByCamera = new Map<string, EmailPushEvent[]>();

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

/**
 * Extract the first image attachment likely to be a snapshot. Reolink ships
 * either a single JPEG or an MP4 clip; we save both but flag only the image
 * as the preview snapshot.
 */
function pickSnapshotAttachment(parsed: ParsedMail): Attachment | undefined {
  const attachments = parsed.attachments ?? [];
  return attachments.find(
    (a) =>
      typeof a.contentType === "string" &&
      a.contentType.toLowerCase().startsWith("image/"),
  );
}

/**
 * Persist all attachments (max 10MB each) under a per-camera/per-timestamp
 * folder. Returns the relative path of the snapshot image when present.
 */
async function persistAttachments(
  cameraId: string,
  receivedAtMs: number,
  parsed: ParsedMail,
): Promise<string | undefined> {
  const attachments = parsed.attachments ?? [];
  if (attachments.length === 0) return undefined;

  const dir = path.join(SNAPSHOT_ROOT, cameraId, String(receivedAtMs));
  fs.mkdirSync(dir, { recursive: true });

  let snapshotRelative: string | undefined;
  for (const att of attachments) {
    if (!att.content) continue;
    if (att.content.length > MAX_ATTACHMENT_BYTES) {
      logger.warn(
        `Attachment too large (${att.content.length} bytes) on camera ${cameraId}, skipping`,
      );
      continue;
    }
    const safeName =
      att.filename?.replace(/[^a-zA-Z0-9._-]/g, "_") ??
      `attachment-${Date.now()}`;
    const filePath = path.join(dir, safeName);
    try {
      fs.writeFileSync(filePath, att.content);
      if (!snapshotRelative && att.contentType?.toLowerCase().startsWith("image/")) {
        snapshotRelative = path.relative(DATA_DIR, filePath);
      }
    } catch (err) {
      logger.warn(
        `Failed to write attachment ${safeName} for camera ${cameraId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return snapshotRelative;
}

/**
 * Trim the in-memory recent-events ring per camera.
 */
function pushRecentEvent(event: EmailPushEvent): void {
  const settings = getSettings();
  const max = settings.emailPush.recentEventsPerCamera;
  if (max <= 0) return;
  const list = recentEventsByCamera.get(event.cameraId) ?? [];
  list.unshift(event);
  if (list.length > max) list.length = max;
  recentEventsByCamera.set(event.cameraId, list);
}

/**
 * Best-effort cleanup of expired snapshot folders. Runs every hour while the
 * server is active. Retention `0` means keep forever.
 */
function pruneOldSnapshots(): void {
  const settings = getSettings();
  const retentionDays = settings.emailPush.snapshotRetentionDays;
  if (retentionDays <= 0) return;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(SNAPSHOT_ROOT)) return;

  for (const cameraDir of fs.readdirSync(SNAPSHOT_ROOT)) {
    const cameraPath = path.join(SNAPSHOT_ROOT, cameraDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(cameraPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ts = Number(entry);
      if (!Number.isFinite(ts) || ts >= cutoffMs) continue;
      const dirPath = path.join(cameraPath, entry);
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `Failed to prune ${dirPath}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}

/**
 * Set the callback that maps a recipient address (e.g. `cam-abc@nodelink.local`)
 * to a known cameraId. Returning `undefined` rejects the recipient at RCPT TO.
 */
export function setEmailPushCameraResolver(resolver: CameraResolver): void {
  cameraResolver = resolver;
}

/**
 * Register a handler invoked for every accepted email-push event. Multiple
 * handlers can be registered (e.g. events-manager, MQTT bridge).
 */
export function onEmailPushEvent(handler: EventHandler): () => void {
  emitter.on("event", handler);
  return () => emitter.off("event", handler);
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

/** Recover the recent events buffered in memory for a given camera. */
export function getRecentEmailPushEvents(
  cameraId: string,
  limit?: number,
): EmailPushEvent[] {
  const list = recentEventsByCamera.get(cameraId) ?? [];
  return typeof limit === "number" ? list.slice(0, limit) : [...list];
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
  const snapshotPath = await persistAttachments(cameraId, receivedAtMs, parsed);

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
    ...(snapshotPath ? { snapshotPath } : {}),
    bodyExcerpt: (parsed.text ?? "").slice(0, 500),
  };

  pushRecentEvent(event);
  if (state) state.status.messagesAccepted++;
  logger.info(
    `Email push for camera=${cameraId} type=${event.inferredType} subject="${event.subject.slice(0, 80)}"`,
  );
  emitter.emit("event", event);
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
  return cameraResolver(candidate);
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

  fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });

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
    logger: false,
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
    onAuth(auth, _session, callback) {
      const expectedUser = settings.emailPush.authUsername;
      const expectedPass = settings.emailPush.authPassword;
      if (!expectedUser || !expectedPass) {
        return callback(new Error("Email push auth not configured"));
      }
      if (auth.username === expectedUser && auth.password === expectedPass) {
        return callback(null, { user: auth.username });
      }
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

  const pruneTimer = setInterval(pruneOldSnapshots, 60 * 60 * 1000);
  pruneTimer.unref();

  state = { server, status, pruneTimer };
}

/** Stop the SMTP server. Safe to call when already stopped. */
export async function stopEmailPushServer(): Promise<void> {
  if (!state) return;
  const { server, pruneTimer } = state;
  if (pruneTimer) clearInterval(pruneTimer);
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
  pushRecentEvent(event);
  emitter.emit("event", event);
}
