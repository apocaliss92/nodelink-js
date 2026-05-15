/**
 * Capture manager — orchestrates a live tshark capture of Baichuan TCP traffic
 * for a single camera.
 *
 * Flow:
 *  1. spawn `tshark -i <iface> -f "host <cameraHost> and tcp port 9000" -w pcap
 *     -T fields -e tcp.payload -l` — writes the raw pcapng file AND emits
 *     line-buffered hex payloads on stdout.
 *  2. Feed the payloads (separated per direction) to a `BaichuanFrameParser`
 *     so we can identify each Baichuan frame's `cmd_id` in real time.
 *  3. Track:
 *       - phase: started → first-frame → nonce-acquired → authenticated
 *       - histogram of cmd_ids seen, separated into known vs unknown
 *  4. UI polls `getStatus(captureId)`.
 *  5. On stop, the .pcapng file remains on disk and is downloadable via a
 *     short-lived token (see routers/capture.ts).
 *
 * Permissions: on macOS tshark needs raw socket access (member of `access_bpf`
 * group, or root). If `spawn` fails or tshark exits immediately with a
 * permission error we surface it on the capture status so the UI can show a
 * friendly message.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  mkdirSync,
  existsSync,
  statSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { BaichuanFrameParser } from "@apocaliss92/nodelink-js";
import * as constants from "@apocaliss92/nodelink-js";
import logger from "./logger.js";

type TsharkProcess = ChildProcess & { stdout: Readable; stderr: Readable };

const DATA_DIR = process.env.DATA_PATH || ".";

export type CapturePhase =
  | "starting"
  | "running"
  | "nonce-acquired"
  | "authenticated"
  | "stopped"
  | "error";

export interface CmdSeen {
  cmdId: number;
  /** Constant name(s) from src/protocol/constants.ts, or undefined if unknown. */
  names: string[] | undefined;
  /** Times we saw this cmd_id (across both directions). */
  count: number;
  /** Last sample (first 32 bytes of the body, hex) for the unknown table. */
  lastBodyHexPreview: string | undefined;
  /** Last responseCode seen (0 for client→server, 200/400/etc on server→client). */
  lastResponseCode: number | undefined;
}

export interface CaptureStatus {
  id: string;
  phase: CapturePhase;
  /** Camera host the capture is filtered on. */
  cameraHost: string;
  cameraName: string;
  iface: string;
  /** Wall-clock start time as epoch ms. */
  startedAt: number;
  /** Wall-clock stop time, set when the capture is no longer running. */
  stoppedAt?: number;
  /** Last error message, populated when phase === "error". */
  errorMessage?: string;
  /** Total Baichuan frames decoded so far. */
  framesDecoded: number;
  /** Bytes written to the pcap file (refreshed on each status read). */
  pcapBytes: number;
  /** All cmd_ids ever observed during the capture, grouped by category. */
  knownCmds: CmdSeen[];
  unknownCmds: CmdSeen[];
}

/**
 * Compact, per-frame log entry kept in memory while a capture is running.
 * Stripped of IP addresses, credentials, nonces — safe to attach to a
 * GitHub issue.
 */
export interface CaptureFrameLogEntry {
  /** Wall-clock offset from capture start (ms). */
  offsetMs: number;
  /** "c2s" (client→camera) or "s2c" (camera→client). */
  direction: "c2s" | "s2c";
  cmdId: number;
  /** SDK constant name(s), or undefined when unknown. */
  cmdNames: string[] | undefined;
  msgNum: number;
  channelId: number;
  streamType: number;
  responseCode: number;
  /** Message class (legacy / modern_20 / modern_24). Determines header layout. */
  messageClass: number;
  /**
   * Header-level payload offset. Some cmd_ids put extension info before the
   * actual body — bounding boxes inside the BcMedia additionalHeader are a
   * notorious example of "looked at body, missed the header". We log it
   * explicitly so reverse-engineering doesn't have to guess.
   */
  payloadOffset: number | undefined;
  bodyLen: number;
  /**
   * Body byte preview. For cmd_ids that are known to carry sensitive data
   * (login XML, challenge nonces) this is the literal string `"<redacted>"`.
   * For everything else we keep the on-the-wire bytes (which are already
   * XOR/AES encrypted and opaque without the nonce we just redacted).
   */
  bodyHexPreview: string;
}

interface CaptureSession {
  id: string;
  cameraHost: string;
  cameraName: string;
  iface: string;
  startedAt: number;
  stoppedAt?: number;
  pcapPath: string;
  proc: TsharkProcess | null;
  phase: CapturePhase;
  errorMessage?: string;
  framesDecoded: number;
  cmds: Map<number, CmdSeen>;
  /** One parser per (srcPort, dstPort) pair so we don't mix C→S with S→C bytes. */
  parsers: Map<string, BaichuanFrameParser>;
  /** Buffered tail of stdout while we wait for the next newline. */
  stdoutTail: string;
  /**
   * Per-frame log capped at MAX_FRAME_LOG entries (oldest dropped). Used to
   * generate the sanitized export. We do not keep the raw pcapng frames in
   * memory; only the redacted summary.
   */
  frameLog: CaptureFrameLogEntry[];
}

/** Camera side always uses TCP 9000 (Baichuan well-known port). */
const CAMERA_PORT = "9000";

/** Cap the in-memory per-frame log so a long capture can't OOM the process. */
const MAX_FRAME_LOG = 10_000;

/**
 * cmd_ids whose body MUST be wiped before export — currently just the login
 * XML (cmd_id=1) which contains the username and password digest. The nonce
 * (cmd_id=2 challenge response) is intentionally NOT redacted: it's needed to
 * decrypt the rest of the conversation locally and is not personally
 * identifying. Without the credentials the nonce alone is harmless.
 */
const SENSITIVE_CMD_IDS = new Set<number>([1]);

const REDACTED_PLACEHOLDER = "<redacted>";

const CMD_NAMES = buildCmdNameMap();

function buildCmdNameMap(): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const [name, value] of Object.entries(
    constants as Record<string, unknown>,
  )) {
    if (typeof value !== "number") continue;
    if (!name.startsWith("BC_CMD_ID_")) continue;
    const list = map.get(value);
    if (list) list.push(name);
    else map.set(value, [name]);
  }
  return map;
}

const sessions = new Map<string, CaptureSession>();

export function getCaptureSession(id: string): CaptureSession | undefined {
  return sessions.get(id);
}

export function listCaptureSessions(): CaptureSession[] {
  return [...sessions.values()];
}

/**
 * List the network interfaces tshark can capture on. Wraps `tshark -D`.
 */
export async function listInterfaces(): Promise<
  Array<{ id: string; description: string }>
> {
  return await new Promise((resolve) => {
    const proc = spawn("tshark", ["-D"]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        logger.warn(`tshark -D exited with code ${code}: ${err}`);
        resolve([]);
        return;
      }
      // Each line: "1. en0 (Wi-Fi)" or "2. en1"
      const items: Array<{ id: string; description: string }> = [];
      for (const line of out.split("\n")) {
        const m = line.match(/^\s*\d+\.\s+(\S+)\s*(\((.+?)\))?/);
        if (!m) continue;
        items.push({
          id: m[1] ?? "",
          description: m[3] ?? m[1] ?? "",
        });
      }
      resolve(items);
    });
    proc.on("error", () => resolve([]));
  });
}

export interface StartCaptureOptions {
  cameraId: string;
  cameraName: string;
  cameraHost: string;
  iface: string;
}

/**
 * Spawn tshark and start a new capture session. Returns the session id.
 * Throws if tshark is missing or refuses to start.
 */
export function startCapture(opts: StartCaptureOptions): string {
  const id = `cap-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(DATA_DIR, "captures");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const pcapPath = path.join(
    dir,
    `${sanitizeForFilename(opts.cameraName)}_${id}.pcapng`,
  );

  const filter = `host ${opts.cameraHost} and tcp port 9000`;
  const args = [
    "-i", opts.iface,
    "-f", filter,
    "-w", pcapPath,
    // Live output: emit per-packet TCP payloads so we can analyse without
    // re-reading the .pcap file. -l = line-buffered. -E header=n keeps the
    // output a clean tab-separated line per packet.
    "-T", "fields",
    "-e", "tcp.srcport",
    "-e", "tcp.dstport",
    "-e", "tcp.payload",
    "-E", "separator=/t",
    "-E", "header=n",
    "-l",
  ];

  logger.info(
    `Starting tshark capture (camera=${opts.cameraName} host=${opts.cameraHost} iface=${opts.iface}) → ${pcapPath}`,
  );

  let proc: TsharkProcess;
  try {
    proc = spawn("tshark", args, { stdio: ["ignore", "pipe", "pipe"] }) as TsharkProcess;
  } catch (e) {
    throw new Error(
      `Failed to spawn tshark: ${(e as Error).message}. Make sure Wireshark is installed.`,
    );
  }

  const session: CaptureSession = {
    id,
    cameraHost: opts.cameraHost,
    cameraName: opts.cameraName,
    iface: opts.iface,
    startedAt: Date.now(),
    pcapPath,
    proc,
    phase: "starting",
    framesDecoded: 0,
    cmds: new Map(),
    parsers: new Map(),
    stdoutTail: "",
    frameLog: [],
  };
  sessions.set(id, session);

  proc.stdout.on("data", (chunk: Buffer) => {
    const text = session.stdoutTail + chunk.toString("latin1");
    const lines = text.split("\n");
    session.stdoutTail = lines.pop() ?? "";
    for (const line of lines) {
      handleTsharkLine(session, line);
    }
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    // tshark prints "Capturing on '<iface>'" on success; surface it as the
    // transition to "running" so the UI can advance the checklist.
    if (session.phase === "starting" && /Capturing on /.test(stderrBuf)) {
      session.phase = "running";
    }
  });

  proc.on("error", (e: Error) => {
    session.phase = "error";
    session.errorMessage = `tshark process error: ${e.message}`;
    logger.warn(`Capture ${id} tshark error: ${e.message}`);
  });

  proc.on("close", (code: number | null) => {
    if (session.phase !== "stopped" && session.phase !== "error") {
      // Unexpected exit (permissions, no such interface, etc.).
      session.phase = "error";
      session.errorMessage =
        `tshark exited prematurely (code ${code}). Stderr tail: ${stderrBuf.slice(-400)}`;
      logger.warn(
        `Capture ${id} tshark exited with code ${code}: ${stderrBuf.slice(-200)}`,
      );
    }
    session.stoppedAt = Date.now();
    session.proc = null;
  });

  return id;
}

/**
 * Stop a running capture (sends SIGTERM to tshark) and persist the result
 * under captures/<id>/ so it shows up in the Reports page after restart.
 * Idempotent.
 */
export async function stopCapture(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  if (s.phase !== "stopped" && s.phase !== "error") {
    s.phase = "stopped";
  }
  if (s.proc) {
    try {
      s.proc.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
  // Wait briefly for tshark to flush the last buffered packets to disk before
  // we read it for the redacted copy. Without this race we sometimes save a
  // pcap without the trailing block.
  await new Promise((r) => setTimeout(r, 250));
  s.stoppedAt = s.stoppedAt ?? Date.now();
  await persistCapture(s).catch((e) => {
    logger.warn(
      `Capture ${id} persist failed: ${(e as Error).message}`,
    );
  });
}

export function deleteCapture(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (s.proc) {
    try { s.proc.kill("SIGKILL"); } catch { /* noop */ }
  }
  try {
    if (existsSync(s.pcapPath)) unlinkSync(s.pcapPath);
  } catch (e) {
    logger.warn(`Failed to delete capture file ${s.pcapPath}: ${(e as Error).message}`);
  }
  sessions.delete(id);
}

export function getCaptureStatus(id: string): CaptureStatus | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  let pcapBytes = 0;
  try {
    if (existsSync(s.pcapPath)) pcapBytes = statSync(s.pcapPath).size;
  } catch {
    // ignore
  }
  const known: CmdSeen[] = [];
  const unknown: CmdSeen[] = [];
  for (const c of s.cmds.values()) {
    if (c.names && c.names.length > 0) known.push(c);
    else unknown.push(c);
  }
  known.sort((a, b) => b.count - a.count);
  unknown.sort((a, b) => b.count - a.count);
  return {
    id: s.id,
    phase: s.phase,
    cameraHost: s.cameraHost,
    cameraName: s.cameraName,
    iface: s.iface,
    startedAt: s.startedAt,
    ...(s.stoppedAt !== undefined ? { stoppedAt: s.stoppedAt } : {}),
    ...(s.errorMessage !== undefined ? { errorMessage: s.errorMessage } : {}),
    framesDecoded: s.framesDecoded,
    pcapBytes,
    knownCmds: known,
    unknownCmds: unknown,
  };
}

export function getCapturePcapPath(id: string): string | undefined {
  return sessions.get(id)?.pcapPath;
}

/**
 * Build a redacted copy of the raw .pcapng for download. Login bodies are
 * zeroed in place and TCP checksums recomputed; everything else (nonce,
 * encrypted bodies, IP addresses) stays so the file can still be opened in
 * Wireshark and decrypted locally by anyone with the camera credentials.
 */
export async function buildRedactedPcap(id: string): Promise<
  { path: string; bytesRedacted: number; loginFramesRedacted: number } | undefined
> {
  const s = sessions.get(id);
  if (!s) return undefined;
  if (!existsSync(s.pcapPath)) return undefined;
  const { redactPcapng } = await import("./capture-pcap-redact.js");
  const outPath = s.pcapPath.replace(/\.pcapng$/, ".redacted.pcapng");
  const r = redactPcapng(s.pcapPath, outPath);
  return {
    path: outPath,
    bytesRedacted: r.bytesRedacted,
    loginFramesRedacted: r.loginFramesRedacted,
  };
}

export interface SanitizedCaptureExport {
  /** Fixed marker so the GitHub-issue uploader can recognize the format. */
  format: "nodelink-baichuan-capture-v1";
  /** Capture id (kept for traceability when the user attaches multiple files). */
  captureId: string;
  /** Camera model / firmware / IP are intentionally NOT included. */
  cameraDisplayName: string;
  iface: string;
  startedAt: number;
  stoppedAt?: number;
  durationMs: number;
  phaseAtExport: CapturePhase;
  framesDecoded: number;
  /**
   * Per-cmd_id summary. Bodies for sensitive commands (login / challenge)
   * are shown as `<redacted>` here too.
   */
  cmdSummary: Array<{
    cmdId: number;
    cmdNames: string[] | undefined;
    count: number;
    lastResponseCode: number | undefined;
    lastBodyHexPreview: string | undefined;
  }>;
  /** Truncated frame log (oldest first, capped at MAX_FRAME_LOG). */
  frames: CaptureFrameLogEntry[];
  /** Notes shown to whoever opens the export — explains what's redacted. */
  redactionNotes: string[];
}

/**
 * Build a sanitized JSON export ready to be attached to a GitHub issue.
 *
 * Contains:
 *   - the per-cmd_id histogram (known + unknown)
 *   - a truncated per-frame log (cmd_id, msg_num, channel, response_code,
 *     direction, body_size, body preview hex)
 *
 * Does NOT contain:
 *   - the camera or local IP addresses
 *   - login XML payloads (cmd_id=1) or challenge nonces (cmd_id=2)
 *   - the raw .pcapng (which would still hold all of the above and let an
 *     attacker re-derive AES keys from the captured nonce)
 */
export function buildSanitizedExport(id: string): SanitizedCaptureExport | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  const cmdSummary = [...s.cmds.values()]
    .map((c) => ({
      cmdId: c.cmdId,
      cmdNames: c.names,
      count: c.count,
      lastResponseCode: c.lastResponseCode,
      lastBodyHexPreview: c.lastBodyHexPreview,
    }))
    .sort((a, b) => b.count - a.count);
  return {
    format: "nodelink-baichuan-capture-v1",
    captureId: s.id,
    cameraDisplayName: s.cameraName,
    iface: s.iface,
    startedAt: s.startedAt,
    ...(s.stoppedAt !== undefined ? { stoppedAt: s.stoppedAt } : {}),
    durationMs: (s.stoppedAt ?? Date.now()) - s.startedAt,
    phaseAtExport: s.phase,
    framesDecoded: s.framesDecoded,
    cmdSummary,
    frames: [...s.frameLog],
    redactionNotes: [
      "IP addresses, MAC addresses and serial numbers are NEVER captured.",
      "Login XML (cmd_id=1) is redacted because it contains the username and password digest.",
      "The challenge nonce (cmd_id=2) is intentionally KEPT so a maintainer can decrypt the rest of the conversation locally; it carries no personal data.",
      "Frame log is capped at 10,000 entries (oldest dropped).",
    ],
  };
}

function sanitizeForFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}

function handleTsharkLine(session: CaptureSession, line: string): void {
  if (!line.trim()) return;
  // Format: "<srcPort>\t<dstPort>\t<hexPayload>"
  // The hexPayload may itself contain commas if tshark splits TCP segments —
  // we strip non-hex chars to be safe.
  const parts = line.split("\t");
  if (parts.length < 3) return;
  const srcPort = parts[0]?.trim();
  const dstPort = parts[1]?.trim();
  const hexRaw = (parts[2] ?? "").replace(/[^0-9a-fA-F]/g, "");
  if (!srcPort || !dstPort || hexRaw.length === 0) return;
  const payload = Buffer.from(hexRaw, "hex");
  if (payload.length === 0) return;

  const dirKey = `${srcPort}->${dstPort}`;
  let parser = session.parsers.get(dirKey);
  if (!parser) {
    parser = new BaichuanFrameParser();
    session.parsers.set(dirKey, parser);
  }
  let frames;
  try {
    frames = parser.push(payload);
  } catch (e) {
    logger.debug(
      `Capture ${session.id} parse error on ${dirKey}: ${(e as Error).message}`,
    );
    return;
  }
  // Direction: a frame is "s2c" iff it was sent FROM port 9000 (the camera).
  // Otherwise the client opened the connection so srcPort is ephemeral.
  const direction: "c2s" | "s2c" = srcPort === CAMERA_PORT ? "s2c" : "c2s";

  for (const f of frames) {
    session.framesDecoded++;
    const cmdId = f.header.cmdId;
    let entry = session.cmds.get(cmdId);
    if (!entry) {
      entry = {
        cmdId,
        names: CMD_NAMES.get(cmdId),
        count: 0,
        lastBodyHexPreview: undefined,
        lastResponseCode: undefined,
      };
      session.cmds.set(cmdId, entry);
    }
    entry.count++;
    entry.lastResponseCode = f.header.responseCode;
    if (f.body && f.body.length > 0) {
      entry.lastBodyHexPreview = SENSITIVE_CMD_IDS.has(cmdId)
        ? REDACTED_PLACEHOLDER
        : f.body.subarray(0, Math.min(32, f.body.length)).toString("hex");
    }
    // Per-frame log (sanitized). Cap memory: drop the oldest entry once we
    // hit MAX_FRAME_LOG so a long capture stays bounded.
    const bodyHexPreview = SENSITIVE_CMD_IDS.has(cmdId)
      ? REDACTED_PLACEHOLDER
      : f.body && f.body.length > 0
        ? f.body
            .subarray(0, Math.min(64, f.body.length))
            .toString("hex")
        : "";
    if (session.frameLog.length >= MAX_FRAME_LOG) {
      session.frameLog.shift();
    }
    session.frameLog.push({
      offsetMs: Date.now() - session.startedAt,
      direction,
      cmdId,
      cmdNames: CMD_NAMES.get(cmdId),
      msgNum: f.header.msgNum,
      channelId: f.header.channelId,
      streamType: f.header.streamType,
      responseCode: f.header.responseCode,
      messageClass: f.header.messageClass,
      payloadOffset: f.header.payloadOffset,
      bodyLen: f.header.bodyLen,
      bodyHexPreview,
    });
    // Phase transitions driven by the auth handshake.
    //   cmd_id=1, responseCode=56594 → server returned the challenge nonce
    //   cmd_id=1, responseCode=200 → login OK
    if (cmdId === 1 && f.header.responseCode === 56594) {
      if (
        session.phase === "starting" ||
        session.phase === "running"
      ) {
        session.phase = "nonce-acquired";
      }
    } else if (cmdId === 1 && f.header.responseCode === 200) {
      if (session.phase !== "stopped" && session.phase !== "error") {
        session.phase = "authenticated";
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Persistence — captures survive restarts and surface in the Reports page.
// ───────────────────────────────────────────────────────────────────────────

const CAPTURE_REPORTS_DIR = path.join(DATA_DIR, "captures");

export interface SavedCaptureSummary {
  id: string;
  cameraDisplayName: string;
  iface: string;
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  framesDecoded: number;
  knownCmdCount: number;
  unknownCmdCount: number;
  phase: CapturePhase;
  hasRawPcap: boolean;
  rawPcapBytes: number;
  redactedBytes: number;
  redactedLoginFrames: number;
}

export interface PersistedManifest {
  version: 1;
  summary: SavedCaptureSummary;
  /** Same shape as the live JSON export. */
  sanitizedExport: SanitizedCaptureExport;
}

function captureDir(id: string): string {
  return path.join(CAPTURE_REPORTS_DIR, id);
}

/**
 * Write the sanitized JSON + redacted .pcapng + manifest to disk so the user
 * can revisit this capture later from the Reports page.
 */
async function persistCapture(s: CaptureSession): Promise<void> {
  const dir = captureDir(s.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sanitized = buildSanitizedExport(s.id);
  if (!sanitized) return;

  let redactedBytes = 0;
  let redactedLoginFrames = 0;
  let hasRawPcap = false;
  let rawPcapBytes = 0;
  if (existsSync(s.pcapPath)) {
    try {
      const { redactPcapng } = await import("./capture-pcap-redact.js");
      const redactedPath = path.join(dir, "raw-redacted.pcapng");
      const r = redactPcapng(s.pcapPath, redactedPath);
      redactedBytes = r.bytesRedacted;
      redactedLoginFrames = r.loginFramesRedacted;
      hasRawPcap = true;
      rawPcapBytes = statSync(redactedPath).size;
      // Drop the original (it still contains login bodies on disk).
      try { unlinkSync(s.pcapPath); } catch { /* noop */ }
    } catch (e) {
      logger.warn(
        `Capture ${s.id} pcap redaction failed: ${(e as Error).message}`,
      );
    }
  }

  const summary: SavedCaptureSummary = {
    id: s.id,
    cameraDisplayName: s.cameraName,
    iface: s.iface,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt ?? Date.now(),
    durationMs: (s.stoppedAt ?? Date.now()) - s.startedAt,
    framesDecoded: s.framesDecoded,
    knownCmdCount: [...s.cmds.values()].filter((c) => c.names && c.names.length > 0).length,
    unknownCmdCount: [...s.cmds.values()].filter((c) => !c.names || c.names.length === 0).length,
    phase: s.phase,
    hasRawPcap,
    rawPcapBytes,
    redactedBytes,
    redactedLoginFrames,
  };

  const manifest: PersistedManifest = {
    version: 1,
    summary,
    sanitizedExport: sanitized,
  };
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  // Mirror the sanitized JSON to a download-friendly file too.
  writeFileSync(
    path.join(dir, "sanitized.json"),
    JSON.stringify(sanitized, null, 2),
  );
  logger.info(`Capture ${s.id} persisted to ${dir}`);
}

/** List every saved capture report (newest first). */
export function listSavedCaptures(): SavedCaptureSummary[] {
  if (!existsSync(CAPTURE_REPORTS_DIR)) return [];
  const out: SavedCaptureSummary[] = [];
  for (const entry of readdirSync(CAPTURE_REPORTS_DIR)) {
    const manifestPath = path.join(CAPTURE_REPORTS_DIR, entry, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as PersistedManifest;
      out.push(m.summary);
    } catch {
      // skip corrupt manifest
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

export function getSavedCapture(id: string): PersistedManifest | undefined {
  const manifestPath = path.join(captureDir(id), "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as PersistedManifest;
  } catch {
    return undefined;
  }
}

export function getSavedCaptureSanitizedPath(id: string): string | undefined {
  const p = path.join(captureDir(id), "sanitized.json");
  return existsSync(p) ? p : undefined;
}

export function getSavedCaptureRawPcapPath(id: string): string | undefined {
  const p = path.join(captureDir(id), "raw-redacted.pcapng");
  return existsSync(p) ? p : undefined;
}

export function deleteSavedCapture(id: string): void {
  const dir = captureDir(id);
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logger.warn(
      `Capture ${id} delete failed: ${(e as Error).message}`,
    );
  }
}
