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
import {
  BaichuanFrameParser,
  bcDecrypt,
  aesDecrypt,
  deriveAesKey,
  getXmlText,
} from "@apocaliss92/nodelink-js";
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
  /**
   * Decrypted body as plain text (typically XML), best-effort.
   * Populated by the post-stop decryption pass when we have the camera
   * credentials. Login bodies (cmd_id=1) are always replaced with
   * `<redacted>` because they contain username + password digests.
   * `null` means the decryption pass didn't run; `""` means it ran but
   * produced no usable text (binary body, decryption failed, etc.).
   *
   * IMPORTANT: this field is a UTF-8 string. Bodies with non-UTF-8 bytes
   * (e.g. cmd_id=345 SetAiDetectCfg, which appears to use a mixed
   * XML-header + binary-payload format) will have those bytes replaced
   * with U+FFFD, making them unsuitable for byte-accurate reverse
   * engineering. For RE work always use {@link bodyDecryptedBase64}.
   */
  bodyDecrypted: string | null;
  /**
   * Decrypted body as base64. Same lifecycle as {@link bodyDecrypted} but
   * preserves every byte exactly — required when the body contains
   * non-UTF-8 bytes (binary payloads, mixed XML+struct envelopes such as
   * cmd_id=345). `null` means decryption didn't run; `""` means it ran
   * but produced empty bytes.
   */
  bodyDecryptedBase64: string | null;
}

interface CaptureSession {
  id: string;
  cameraHost: string;
  cameraName: string;
  iface: string;
  /**
   * Camera credentials looked up at capture-start so the post-stop decrypt
   * pass can derive the AES key without going back through settings (which
   * could change between start and stop).
   */
  cameraUsername: string;
  cameraPassword: string;
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
 * Per-interface result of `testInterfaces`. The ones with the highest
 * `packetCount` are the ones that actually saw the camera's traffic during
 * the probe window.
 */
export interface InterfaceTestResult {
  iface: string;
  packetCount: number;
  /** True if the OS routing table picked this interface for the camera host. */
  routeSuggested: boolean;
  /** Captured stderr tail when no packets were seen — useful to surface "permission denied". */
  errorHint?: string;
}

/**
 * Probe the most plausible interfaces first and only fan out to the rest if
 * none of them saw any traffic. Returns one entry per probed interface with
 * the packet count we observed during the test window.
 *
 * Plausibility ranking:
 *   1. The interface the OS routing table picks for `cameraHost`
 *      (`route get` on macOS, `ip route get` on Linux). Almost always
 *      correct — we probe it first and short-circuit on success.
 *   2. Interfaces with common LAN names (en0/en1/eth0/eth1/wlan0/wlp*).
 *   3. Everything else (lo / utun / awdl / docker / vboxnet / ...).
 *
 * Each probe runs tshark for ~3s with `host <cameraHost>` and counts the
 * frames that arrive. While probes run we open a short TCP connect to
 * camera:9000 so the device responds with the Baichuan login challenge —
 * that gives the probe something to see even on a quiet link.
 */
export async function testInterfaces(
  cameraHost: string,
  ifaces: string[],
): Promise<InterfaceTestResult[]> {
  if (ifaces.length === 0) return [];

  const routeSuggested = await detectRouteInterface(cameraHost).catch(
    () => undefined,
  );
  const ordered = sortByPlausibility(ifaces, routeSuggested);

  const results: InterfaceTestResult[] = [];

  // Phase 1: probe the routing-table suggestion alone. If it sees traffic we
  // can stop there — most users land here on the first try.
  if (routeSuggested && ordered[0] === routeSuggested) {
    const triggerTimer = setTimeout(() => {
      void triggerCameraTraffic(cameraHost);
    }, 400);
    const r = await probeOneInterface(routeSuggested, cameraHost);
    clearTimeout(triggerTimer);
    r.routeSuggested = true;
    results.push(r);
    if (r.packetCount > 0) {
      return results;
    }
  }

  // Phase 2: parallel probe of the remaining interfaces, plausible names first.
  const remaining = ordered.filter(
    (i) => !results.some((r) => r.iface === i),
  );
  if (remaining.length > 0) {
    const triggerTimer = setTimeout(() => {
      void triggerCameraTraffic(cameraHost);
    }, 400);
    const more = await Promise.all(
      remaining.map((iface) => probeOneInterface(iface, cameraHost)),
    );
    clearTimeout(triggerTimer);
    for (const r of more) {
      if (r.iface === routeSuggested) r.routeSuggested = true;
      results.push(r);
    }
  }

  results.sort((a, b) => b.packetCount - a.packetCount);
  return results;
}

/**
 * Order interfaces by how likely they are to see camera traffic. Routing-table
 * pick first, then LAN-shaped names, then anything else (lo, virtual, VPN).
 */
function sortByPlausibility(
  ifaces: string[],
  routeSuggested: string | undefined,
): string[] {
  const plausible = (name: string): number => {
    if (name === routeSuggested) return 0;
    if (/^(en|eth|wlan|wlp|enp|wls)\d/.test(name)) return 1;
    if (/^(lo|utun|awdl|docker|vboxnet|tap|tun|veth|br-)/i.test(name)) return 9;
    return 5;
  };
  return [...ifaces].sort((a, b) => plausible(a) - plausible(b));
}

async function probeOneInterface(
  iface: string,
  cameraHost: string,
): Promise<InterfaceTestResult> {
  return new Promise((resolve) => {
    const args = [
      "-i", iface,
      "-a", "duration:3",
      "-f", `host ${cameraHost}`,
      "-T", "fields",
      "-e", "frame.number",
      "-l",
      "-q", // suppress per-packet display summary noise
    ];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("tshark", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({
        iface,
        packetCount: 0,
        routeSuggested: false,
        errorHint: "tshark not available",
      });
      return;
    }
    let count = 0;
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      // Each captured packet emits a single line with frame.number; counting
      // newlines is a robust way to tally without parsing.
      count += (chunk.toString("ascii").match(/\n/g) ?? []).length;
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", () => {
      const result: InterfaceTestResult = {
        iface,
        packetCount: count,
        routeSuggested: false,
      };
      if (count === 0) {
        const tail = stderr.slice(-200).trim();
        if (tail) result.errorHint = tail;
      }
      resolve(result);
    });
    proc.on("error", () => {
      resolve({
        iface,
        packetCount: 0,
        routeSuggested: false,
        errorHint: "tshark spawn error",
      });
    });
    // Hard safety timeout in case `-a duration:3` is ignored on some builds.
    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
    }, 6000);
  });
}

async function detectRouteInterface(
  cameraHost: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const isLinux = process.platform === "linux";
    const cmd = isLinux ? "ip" : "route";
    const args = isLinux
      ? ["route", "get", cameraHost]
      : ["-n", "get", cameraHost];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    proc.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    proc.on("close", () => {
      // macOS `route -n get`: a line like "   interface: en0"
      // Linux `ip route get`: "...dev en0..."
      const macMatch = out.match(/interface:\s*(\S+)/);
      if (macMatch?.[1]) {
        resolve(macMatch[1]);
        return;
      }
      const linuxMatch = out.match(/\bdev\s+(\S+)/);
      resolve(linuxMatch?.[1]);
    });
    proc.on("error", () => resolve(undefined));
    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
      resolve(undefined);
    }, 2000);
  });
}

/**
 * Open a short TCP connection to camera:9000 to coax a response the probe can
 * count. Reolink will at minimum send TCP SYN-ACK and likely a full Baichuan
 * challenge frame; either is enough.
 */
async function triggerCameraTraffic(cameraHost: string): Promise<void> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const cleanup = (): void => {
      try { socket.destroy(); } catch { /* noop */ }
      resolve();
    };
    socket.setTimeout(2000);
    socket.once("connect", cleanup);
    socket.once("error", cleanup);
    socket.once("timeout", cleanup);
    try {
      socket.connect(9000, cameraHost);
    } catch {
      cleanup();
    }
  });
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
  /** Camera username — kept in memory so the decrypt pass can derive the AES key. */
  cameraUsername: string;
  /** Camera password — same purpose. Never persisted, never echoed in exports. */
  cameraPassword: string;
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
    cameraUsername: opts.cameraUsername,
    cameraPassword: opts.cameraPassword,
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
      bodyDecrypted: null,
      bodyDecryptedBase64: null,
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
 * Re-parse the on-disk .pcapng AND decrypt every body we can. Two reasons:
 *
 *   1. tshark always writes the .pcapng file completely, but its stdout pipe
 *      (which our LIVE parser reads) can backpressure under heavy traffic —
 *      so the live counter may lag the file by the time the user hits Stop.
 *      Re-reading from disk closes that gap.
 *
 *   2. We have the camera credentials in memory (passed to startCapture) so
 *      we can derive the AES key from the nonce that's actually present in
 *      the capture and decrypt every subsequent body. The export then
 *      surfaces readable XML alongside the raw header fields.
 *
 * This rewrites s.cmds, s.frameLog and s.framesDecoded from scratch.
 */
async function reparseFromPcap(s: CaptureSession): Promise<void> {
  if (!existsSync(s.pcapPath)) return;

  // Reset live state: we're rebuilding from authoritative file content.
  s.cmds.clear();
  s.parsers.clear();
  s.frameLog.length = 0;
  s.framesDecoded = 0;
  s.stdoutTail = "";

  // Phase 1: parse all frames from the pcap, keep the full encrypted body
  // alongside each log entry so the decryption pass below can use it.
  const fullBodies: Buffer[] = [];

  await new Promise<void>((resolve) => {
    const args = [
      "-r", s.pcapPath,
      "-Y", "tcp.port == 9000",
      "-T", "fields",
      "-e", "tcp.srcport",
      "-e", "tcp.dstport",
      "-e", "tcp.payload",
      "-l",
    ];
    const proc = spawn("tshark", args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = tail + chunk.toString("latin1");
      const lines = text.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) parseLineForReparse(s, line, fullBodies);
    });
    proc.on("close", () => {
      if (tail.trim()) parseLineForReparse(s, tail, fullBodies);
      resolve();
    });
    proc.on("error", () => resolve());
  });

  // Phase 2: decrypt bodies (best-effort).
  decryptCapturedBodies(s, fullBodies);
}

/**
 * Like handleTsharkLine but ALSO captures the full (still-encrypted) body for
 * each frame in `fullBodies`, indexed in the same order as the frameLog
 * entries we just appended. Phase 2 needs the full body to decrypt; the
 * frameLog itself only carries a hex preview for display.
 */
function parseLineForReparse(
  session: CaptureSession,
  line: string,
  fullBodies: Buffer[],
): void {
  if (!line.trim()) return;
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
  try { frames = parser.push(payload); } catch { return; }

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
    const bodyHexPreview = SENSITIVE_CMD_IDS.has(cmdId)
      ? REDACTED_PLACEHOLDER
      : f.body && f.body.length > 0
        ? f.body.subarray(0, Math.min(64, f.body.length)).toString("hex")
        : "";
    if (session.frameLog.length >= MAX_FRAME_LOG) {
      session.frameLog.shift();
      fullBodies.shift();
    }
    session.frameLog.push({
      offsetMs: 0, // we lose timing on the reparse — set to 0 for consistency
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
      bodyDecrypted: null,
      bodyDecryptedBase64: null,
    });
    fullBodies.push(f.body ?? Buffer.alloc(0));

    // Phase tracking (mirrors handleTsharkLine).
    if (cmdId === 1 && f.header.responseCode === 56594) {
      if (session.phase === "starting" || session.phase === "running") {
        session.phase = "nonce-acquired";
      }
    } else if (cmdId === 1 && f.header.responseCode === 200) {
      if (session.phase !== "stopped" && session.phase !== "error") {
        session.phase = "authenticated";
      }
    }
  }
}

/**
 * Walk the frame log, find the nonce frame (cmd_id=1 with responseCode>>8 ==
 * 0xDD), derive the AES key with the camera password, then decrypt every
 * subsequent body and stash the plaintext on the matching frameLog entry.
 *
 * Decryption is best-effort: if a body isn't valid XML after decrypt or the
 * encryption type is something we don't handle, we leave `bodyDecrypted` as
 * an empty string instead of null so the UI can still distinguish "tried but
 * failed" from "didn't try".
 */
function decryptCapturedBodies(s: CaptureSession, fullBodies: Buffer[]): void {
  if (s.frameLog.length !== fullBodies.length) {
    logger.warn(
      `Capture ${s.id} decrypt skipped: frameLog/body length mismatch (${s.frameLog.length} vs ${fullBodies.length})`,
    );
    return;
  }
  if (!s.cameraPassword) {
    // No credentials → mark every entry as "didn't try".
    return;
  }

  // Find the encryption-info response: cmd_id=1, responseCode upper byte 0xDD.
  // Body is XOR-encrypted regardless of final encryption type.
  let nonce: string | undefined;
  let encType: number | undefined;
  let nonceFrameIdx = -1;
  for (let i = 0; i < s.frameLog.length; i++) {
    const fr = s.frameLog[i]!;
    if (fr.cmdId !== 1) continue;
    if ((fr.responseCode >>> 8) !== 0xdd) continue;
    encType = fr.responseCode & 0xff;
    const body = fullBodies[i]!;
    if (body.length === 0) continue;
    // XOR-decrypt the body using the channel id as the offset (matches
    // BaichuanClient.tryDecryptXml for the negotiation phase).
    const xml =
      encType === 0x00
        ? body.toString("utf8")
        : bcDecrypt(body, fr.channelId).toString("utf8");
    const n = getXmlText(xml, "nonce");
    if (n) {
      nonce = n;
      nonceFrameIdx = i;
      // Mark the nonce body as decrypted (it's safe — nonce is not personal).
      fr.bodyDecrypted = xml;
      break;
    }
  }
  if (!nonce || encType === undefined) {
    logger.debug(
      `Capture ${s.id} decrypt: no nonce frame found in capture`,
    );
    return;
  }

  // Derive the per-camera AES key once.
  const aesKey =
    encType === 0x02 || encType === 0x12
      ? deriveAesKey(nonce, s.cameraPassword)
      : undefined;

  for (let i = 0; i < s.frameLog.length; i++) {
    if (i === nonceFrameIdx) continue; // already decoded above
    const fr = s.frameLog[i]!;
    const body = fullBodies[i]!;
    if (body.length === 0) {
      fr.bodyDecrypted = "";
      fr.bodyDecryptedBase64 = "";
      continue;
    }
    // Login frame always stays redacted — its plaintext contains the
    // username and password digests. Signal "decrypted ran but redacted".
    if (fr.cmdId === 1) {
      fr.bodyDecrypted = REDACTED_PLACEHOLDER;
      fr.bodyDecryptedBase64 = REDACTED_PLACEHOLDER;
      continue;
    }
    // Decrypt to raw bytes first (preserves binary), then derive both the
    // UTF-8 string view and the lossless base64 view.
    //
    // IMPORTANT: BaichuanClient encrypts the wire body as TWO separate
    // AES-CFB streams concatenated:
    //   1. Extension XML envelope (offset 0..payloadOffset) — fresh IV
    //   2. Body payload     (offset payloadOffset..bodyLen) — fresh IV again
    // (see BaichuanClient.ts encodeBody — two `aesEncrypt()` calls).
    // Decrypting the whole thing as one continuous stream gets the
    // Extension right but corrupts the payload (CFB chaining mismatch).
    // We split at payloadOffset and run two fresh decrypt passes.
    const splitAt =
      fr.payloadOffset != null && fr.payloadOffset > 0 && fr.payloadOffset < body.length
        ? fr.payloadOffset
        : 0;
    let rawBytes: Buffer | undefined;
    try {
      if (encType === 0x00) {
        rawBytes = body;
      } else if (encType === 0x01) {
        if (splitAt > 0) {
          rawBytes = Buffer.concat([
            bcDecrypt(body.subarray(0, splitAt), fr.channelId),
            bcDecrypt(body.subarray(splitAt), fr.channelId),
          ]);
        } else {
          rawBytes = bcDecrypt(body, fr.channelId);
        }
      } else if ((encType === 0x02 || encType === 0x12) && aesKey) {
        if (splitAt > 0) {
          rawBytes = Buffer.concat([
            aesDecrypt(body.subarray(0, splitAt), aesKey),
            aesDecrypt(body.subarray(splitAt), aesKey),
          ]);
        } else {
          rawBytes = aesDecrypt(body, aesKey);
        }
      }
    } catch {
      rawBytes = undefined;
    }
    if (!rawBytes) {
      fr.bodyDecrypted = "";
      fr.bodyDecryptedBase64 = "";
      continue;
    }
    fr.bodyDecryptedBase64 = rawBytes.toString("base64");
    const plaintext: string = rawBytes.toString("utf8");
    if (!plaintext) {
      fr.bodyDecrypted = "";
      continue;
    }
    // Only keep "<?xml" / valid-looking XML output. Binary bodies (cmd_id=3
    // video stream) decrypt to BcMedia bytes which are not XML; we surface
    // "<binary N bytes>" so the export shows we tried.
    const trimmed = plaintext.trim();
    if (trimmed.startsWith("<")) {
      fr.bodyDecrypted = plaintext;
    } else {
      fr.bodyDecrypted = `<binary ${body.length} bytes>`;
    }
  }
}

/**
 * Write the sanitized JSON + redacted .pcapng + manifest to disk so the user
 * can revisit this capture later from the Reports page.
 */
async function persistCapture(s: CaptureSession): Promise<void> {
  const dir = captureDir(s.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Re-parse the file to make sure the manifest counts are authoritative
  // (they include any frames the live stdout pipe missed under backpressure).
  await reparseFromPcap(s);

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
