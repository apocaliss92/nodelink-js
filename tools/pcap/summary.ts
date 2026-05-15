/**
 * Build a chronological digest of every Baichuan command in a capture,
 * suitable for pasting into a GitHub issue or sharing with a reviewer.
 *
 * The digest deliberately omits authentication frames (login handshake,
 * nonce reply, credential hashes) and scrubs any field that historically
 * leaks user secrets (userName / password / nonce / Encryption block).
 *
 * Output is plain text — one block per Baichuan frame, in capture order,
 * with the matching response paired right after the request when possible.
 */
import { describeCmdId, describeMessageClass } from "./cmd-names";
import { formatXml } from "./format";
import type { AnnotatedFrame } from "./decrypt";
import { BC_CMD_ID_LOGIN, BC_CMD_ID_LOGOUT } from "../../src/protocol/constants";

const AUTH_CMD_IDS = new Set<number>([BC_CMD_ID_LOGIN, BC_CMD_ID_LOGOUT]);

/** Regexes for XML fields we never want to leak. Order matters (greedy → safe). */
const SECRET_TAGS = [
  "userName",
  "password",
  "passWord",
  "nonce",
  "newPassword",
  "oldPassword",
  "token",
  "sessionId",
  "uid",
  "serialNumber",
  "mac",
];

const ATTR_REDACT_RE = /(\s)(uid|token|serial|mac)=("[^"]*"|'[^']*')/gi;

export interface SummaryOptions {
  /** Suppress all auth/login frames (always true; kept for clarity). */
  stripAuth?: boolean;
  /** Also redact network-identifying info (IPs, MAC, serial) on top of credentials. */
  stripNetwork?: boolean;
  /** Optional max XML preview bytes per frame (default: full body). */
  maxXmlBytes?: number;
}

/**
 * Render a chronological digest of the capture as plain text.
 * Callers can write it straight to stdout or a file.
 */
export function buildSummary(
  frames: AnnotatedFrame[],
  options: SummaryOptions = {},
): string {
  const opts: Required<SummaryOptions> = {
    stripAuth: true,
    stripNetwork: options.stripNetwork ?? false,
    maxXmlBytes: options.maxXmlBytes ?? Infinity,
  };

  // 1. Drop auth/login frames, preserve capture order.
  const interesting = frames.filter(
    (af) => !AUTH_CMD_IDS.has(af.frame.header.cmdId),
  );

  // 2. Group by `cmd_id:msgNum` so we can pair request + response.
  type Pair = { req?: AnnotatedFrame; res?: AnnotatedFrame };
  const pairs = new Map<string, Pair>();
  const order: string[] = [];

  for (const af of interesting) {
    const key = `${af.frame.header.cmdId}:${af.frame.header.msgNum}:${af.pcap.streamId}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = {};
      pairs.set(key, pair);
      order.push(key);
    }
    if (af.pcap.direction === "c2s") pair.req = af;
    else pair.res = af;
  }

  const blocks: string[] = [];
  const header = [
    "# Baichuan capture digest",
    `Generated: ${new Date().toISOString()}`,
    `Frames (post-auth strip): ${interesting.length}`,
    `Command pairs: ${order.length}`,
    "",
    "Each block shows one client→camera command (`>`) and its server reply (`<`),",
    "ordered by first-seen time. Login/logout frames and credential fields are stripped.",
    "",
  ].join("\n");
  blocks.push(header);

  for (const key of order) {
    const pair = pairs.get(key)!;
    const anchor = pair.req ?? pair.res!;
    const h = anchor.frame.header;

    const ts = new Date(anchor.pcap.timestamp * 1000)
      .toISOString()
      .substring(11, 23);
    const cmd = describeCmdId(h.cmdId);
    const cls = describeMessageClass(h.messageClass);
    const lines: string[] = [
      `--- ${ts}  cmd=${h.cmdId} (${cmd})  ch=${h.channelId}  ${cls}  msg#${h.msgNum}`,
    ];

    if (pair.req) {
      lines.push("  > request:");
      lines.push(renderFrameXml(pair.req, opts));
    }
    if (pair.res) {
      const rc = pair.res.frame.header.responseCode;
      const rcLabel = rc === 0x00c8 ? "OK" : `0x${rc.toString(16)}`;
      lines.push(`  < response (${rcLabel}):`);
      lines.push(renderFrameXml(pair.res, opts));
    }
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n") + "\n";
}

function renderFrameXml(af: AnnotatedFrame, opts: Required<SummaryOptions>): string {
  const ext = af.decryptedExtensionXml ? sanitize(af.decryptedExtensionXml, opts) : "";
  const body = af.decryptedXml ? sanitize(af.decryptedXml, opts) : "";

  const pieces: string[] = [];
  if (ext) pieces.push("    extension:\n" + indent(formatXml(ext), 6));
  if (body) pieces.push("    body:\n" + indent(formatXml(body), 6));
  if (!ext && !body) {
    pieces.push("    (no decryptable XML — body length " + af.frame.body.length + " bytes)");
  }
  const joined = pieces.join("\n");
  if (Number.isFinite(opts.maxXmlBytes) && joined.length > opts.maxXmlBytes) {
    return joined.slice(0, opts.maxXmlBytes) + `\n    … (truncated, total ${joined.length} bytes)`;
  }
  return joined;
}

/**
 * Replace credential-bearing fields with `[REDACTED]` placeholders. Tags are
 * matched case-insensitively to handle the firmware's casing inconsistencies.
 */
export function sanitize(xml: string, opts: Required<SummaryOptions>): string {
  let out = xml;

  // Drop entire <Encryption>…</Encryption> blocks if any survived the auth filter.
  out = out.replace(/<Encryption[^>]*>[\s\S]*?<\/Encryption>/gi, "<Encryption>[REDACTED]</Encryption>");

  for (const tag of SECRET_TAGS) {
    const re = new RegExp(`<(${tag})\\b[^>]*>[\\s\\S]*?</\\1>`, "gi");
    out = out.replace(re, `<${tag}>[REDACTED]</${tag}>`);
  }
  out = out.replace(ATTR_REDACT_RE, '$1$2="[REDACTED]"');

  if (opts.stripNetwork) {
    // IPv4
    out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "0.0.0.0");
    // MAC
    out = out.replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "00:00:00:00:00:00");
    // Long hex blobs (serials, hashes)
    out = out.replace(/\b[0-9a-f]{16,}\b/gi, "[HEX]");
  }
  return out;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => pad + l).join("\n");
}
