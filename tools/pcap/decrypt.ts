import {
  aesDecrypt,
  bcDecrypt,
  deriveAesKey,
  type EncryptionProtocol,
} from "../../src/protocol/crypto";
import { BaichuanFrameParser, type BaichuanFrame } from "../../src/protocol/framing";
import type { PcapTcpPayload } from "./tshark";

/** Encryption mode negotiated for the post-login phase of a session. */
export type NegotiatedEnc =
  | { kind: "none" }
  | { kind: "bc" }
  | { kind: "aes"; key: Buffer; nonce: string; password: string }
  | { kind: "full_aes"; key: Buffer; nonce: string; password: string };

/**
 * A single Baichuan frame seen on the wire, paired with the originating pcap
 * metadata and the best-effort decrypted XML payload (if any).
 */
export interface AnnotatedFrame {
  pcap: PcapTcpPayload;
  streamKey: string;
  frame: BaichuanFrame;
  /** The encryption mode that produced `decryptedXml`, if a decrypt succeeded. */
  decryptedAs?: EncryptionProtocol["kind"];
  decryptedXml?: string;
  decryptedExtensionXml?: string;
}

export interface SessionSummary {
  streamId: number;
  c2sFrames: number;
  s2cFrames: number;
  loginNonce?: string;
  loginEncType?: "none" | "bc" | "aes" | "full_aes";
  resolvedPassword?: string;
  loginXmlPreview?: string;
}

export interface DecryptOptions {
  /** Candidate passwords; the first that yields valid XML wins. */
  passwords?: string[];
  /** Override the detected encType (rare; useful when negotiation is missing). */
  forceEnc?: NegotiatedEnc;
}

const NONCE_RESP_PREFIX = 0xdd; // server reply byte indicating <nonce> payload

/**
 * Parse a pcap's raw payloads into ordered Baichuan frames per
 * (streamId, direction). The parser handles fragmentation by buffering.
 */
export function parseFrames(
  payloads: PcapTcpPayload[],
): { frames: AnnotatedFrame[]; streamKeys: Set<string> } {
  const parsers = new Map<string, BaichuanFrameParser>();
  const frames: AnnotatedFrame[] = [];
  const streamKeys = new Set<string>();

  for (const p of payloads) {
    const key = `${p.streamId}:${p.direction}`;
    streamKeys.add(key);
    let parser = parsers.get(key);
    if (!parser) {
      parser = new BaichuanFrameParser();
      parsers.set(key, parser);
    }
    const out = parser.push(p.payload);
    for (const frame of out) {
      frames.push({ pcap: p, streamKey: key, frame });
    }
  }

  return { frames, streamKeys };
}

/**
 * For each TCP stream, find the login handshake and derive the negotiated
 * encryption. The handshake pattern is:
 *
 *   c2s cmd_id=1 bodyLen=0 responseCode=0xDC??  (client requests encType)
 *   s2c cmd_id=1 responseCode=0xDDxx body=<Encryption><nonce>...
 *
 * The low byte of the server reply determines the post-login enc kind.
 * The nonce + password (md5StrModern) derive the AES key for aes/full_aes.
 */
export function detectSessions(
  frames: AnnotatedFrame[],
  options: DecryptOptions = {},
): Map<number, NegotiatedEnc | undefined> {
  const sessions = new Map<number, NegotiatedEnc | undefined>();
  const passwords = options.passwords ?? [];

  // Pair (streamId) -> the server reply that carried <nonce>.
  const nonceReplies = new Map<number, AnnotatedFrame>();
  for (const af of frames) {
    if (af.frame.header.cmdId !== 1) continue;
    if (af.pcap.direction !== "s2c") continue;
    const rc = af.frame.header.responseCode;
    if (rc >>> 8 !== NONCE_RESP_PREFIX) continue;
    if (!nonceReplies.has(af.pcap.streamId)) {
      nonceReplies.set(af.pcap.streamId, af);
    }
  }

  for (const [streamId, reply] of nonceReplies.entries()) {
    if (options.forceEnc) {
      sessions.set(streamId, options.forceEnc);
      continue;
    }
    const encType = reply.frame.header.responseCode & 0xff;

    if (encType === 0x00) {
      sessions.set(streamId, { kind: "none" });
      continue;
    }
    if (encType === 0x01) {
      sessions.set(streamId, { kind: "bc" });
      continue;
    }

    const nonce = extractNonce(reply);
    if (!nonce) {
      sessions.set(streamId, undefined);
      continue;
    }
    if (encType !== 0x02 && encType !== 0x12) {
      sessions.set(streamId, undefined);
      continue;
    }

    const password = resolveAesPassword(frames, streamId, nonce, passwords);
    if (!password) {
      sessions.set(streamId, undefined);
      continue;
    }
    const key = deriveAesKey(nonce, password);
    sessions.set(streamId, {
      kind: encType === 0x02 ? "aes" : "full_aes",
      key,
      nonce,
      password,
    });
  }

  return sessions;
}

function extractNonce(reply: AnnotatedFrame): string | undefined {
  // The nonce reply is BC-encrypted with the channelId offset (XOR), unless
  // encType=0x00 which is plaintext.
  const channelId = reply.frame.header.channelId;
  const encType = reply.frame.header.responseCode & 0xff;
  const buf = reply.frame.body;
  const candidates: Buffer[] = [];
  if (encType === 0x00) {
    candidates.push(buf);
  } else {
    candidates.push(bcDecrypt(buf, channelId));
    // fallbacks for odd channelId / firmware quirks
    candidates.push(buf);
    candidates.push(bcDecrypt(buf, 0));
  }
  for (const c of candidates) {
    const xml = c.toString("utf8");
    const m = /<nonce>([^<]+)<\/nonce>/i.exec(xml);
    if (m) return m[1].trim();
  }
  return undefined;
}

/**
 * Try every candidate password against the modern login frame (cmd_id=1, c2s,
 * sent right after the nonce reply). The login payload is BC-encrypted and
 * its first hash equals md5StrModern(`${username}${nonce}`) — but since we
 * don't know the username, we settle for a structural check: a valid
 * `<?xml` prefix once BC-decrypted with the channelId.
 *
 * If multiple passwords would "work" (they won't, because AES decrypt of
 * later frames will only succeed with the correct one), we filter via the
 * first AES-encrypted post-login frame.
 */
function resolveAesPassword(
  frames: AnnotatedFrame[],
  streamId: number,
  nonce: string,
  passwords: string[],
): string | undefined {
  if (passwords.length === 0) return undefined;

  const afterLogin = frames.filter(
    (af) =>
      af.pcap.streamId === streamId &&
      af.frame.header.cmdId !== 1 &&
      af.frame.body.length > 0,
  );
  if (afterLogin.length === 0) {
    // No further traffic: any password will produce the same login XML on
    // BC; we can't disambiguate. Return the first candidate optimistically.
    return passwords[0];
  }

  for (const pw of passwords) {
    const key = deriveAesKey(nonce, pw);
    let hits = 0;
    for (const af of afterLogin) {
      const dec = safeAesDecrypt(af.frame.body, key);
      if (!dec) continue;
      if (looksLikeBaichuanXml(dec)) {
        hits += 1;
        if (hits >= 2) return pw;
      }
    }
    if (hits >= 1) return pw;
  }
  return undefined;
}

function safeAesDecrypt(buf: Buffer, key: Buffer): Buffer | undefined {
  try {
    return aesDecrypt(buf, key);
  } catch {
    return undefined;
  }
}

function looksLikeBaichuanXml(buf: Buffer): boolean {
  const s = buf.toString("utf8");
  return s.startsWith("<?xml") || s.startsWith("<body");
}

/**
 * Annotate every frame with the best-effort decrypted body XML.
 *
 * The Baichuan body is `[extensionXml?][payloadXml?]`, split by the optional
 * 24-byte header's `payloadOffset`. Both halves are encrypted with the same
 * algorithm. For "bc" the XOR offset is the frame's channelId; for AES the
 * key is the per-session derived key.
 */
export function annotateDecryption(
  frames: AnnotatedFrame[],
  sessions: Map<number, NegotiatedEnc | undefined>,
): AnnotatedFrame[] {
  for (const af of frames) {
    const enc = sessions.get(af.pcap.streamId);
    decryptInPlace(af, enc);
  }
  return frames;
}

function decryptInPlace(af: AnnotatedFrame, enc: NegotiatedEnc | undefined): void {
  const { header, body, extension, payload } = af.frame;
  if (body.length === 0) return;

  const channelId = header.channelId;
  // Login frames (cmd_id=1) are always BC (or "none" if negotiated) regardless
  // of the post-login enc.
  const isLoginFrame = header.cmdId === 1;

  const candidates: Array<{ kind: EncryptionProtocol["kind"]; ext: Buffer; pay: Buffer }> = [];

  const push = (kind: EncryptionProtocol["kind"], decFn: (b: Buffer) => Buffer) => {
    try {
      candidates.push({ kind, ext: decFn(extension), pay: decFn(payload) });
    } catch {
      /* ignore */
    }
  };

  if (isLoginFrame) {
    const encType = header.responseCode & 0xff;
    // The nonce reply (0xDD00) is plaintext; everything else under cmd_id=1
    // uses BC encryption.
    if (header.responseCode === 0xdd00) {
      push("none", (b) => b);
    } else {
      push("bc", (b) => bcDecrypt(b, channelId));
      push("none", (b) => b);
    }
  } else if (enc) {
    if (enc.kind === "none") {
      push("none", (b) => b);
    } else if (enc.kind === "bc") {
      push("bc", (b) => bcDecrypt(b, channelId));
    } else {
      push(enc.kind, (b) => aesDecrypt(b, enc.key));
    }
    // Always also try BC as a fallback — some commands use BC even on AES
    // sessions (legacy behaviour).
    if (enc.kind !== "bc") push("bc", (b) => bcDecrypt(b, channelId));
  } else {
    // Unknown session: try all
    push("bc", (b) => bcDecrypt(b, channelId));
    push("none", (b) => b);
  }

  // Decrypt extension and payload independently — a video frame can have an
  // XML extension and a binary payload (BcMedia), so requiring both to look
  // like XML would discard real extension data.
  for (const c of candidates) {
    if (af.decryptedExtensionXml === undefined) {
      const extStr = c.ext.toString("utf8");
      if (c.ext.length === 0 || looksLikeXml(extStr)) {
        af.decryptedExtensionXml = c.ext.length === 0 ? "" : extStr;
        af.decryptedAs ??= c.kind;
      }
    }
    if (af.decryptedXml === undefined) {
      const payStr = c.pay.toString("utf8");
      if (c.pay.length === 0 || looksLikeXml(payStr)) {
        af.decryptedXml = c.pay.length === 0 ? "" : payStr;
        af.decryptedAs ??= c.kind;
      }
    }
    if (af.decryptedExtensionXml !== undefined && af.decryptedXml !== undefined) break;
  }
}

function looksLikeXml(s: string): boolean {
  return s.startsWith("<?xml") || s.startsWith("<body") || s.startsWith("<Extension");
}

/** Convenience: full pipeline + per-stream summary. */
export function analyzePcap(
  payloads: PcapTcpPayload[],
  options: DecryptOptions = {},
): { frames: AnnotatedFrame[]; sessions: Map<number, NegotiatedEnc | undefined>; summaries: SessionSummary[] } {
  const { frames } = parseFrames(payloads);
  const sessions = detectSessions(frames, options);
  annotateDecryption(frames, sessions);

  const summaries = summarizeSessions(frames, sessions);
  return { frames, sessions, summaries };
}

function summarizeSessions(
  frames: AnnotatedFrame[],
  sessions: Map<number, NegotiatedEnc | undefined>,
): SessionSummary[] {
  const byStream = new Map<number, SessionSummary>();
  for (const af of frames) {
    const id = af.pcap.streamId;
    let s = byStream.get(id);
    if (!s) {
      s = { streamId: id, c2sFrames: 0, s2cFrames: 0 };
      byStream.set(id, s);
    }
    if (af.pcap.direction === "c2s") s.c2sFrames += 1;
    else s.s2cFrames += 1;
  }
  for (const [id, enc] of sessions.entries()) {
    const s = byStream.get(id);
    if (!s) continue;
    if (!enc) continue;
    s.loginEncType = enc.kind;
    if (enc.kind === "aes" || enc.kind === "full_aes") {
      s.loginNonce = enc.nonce;
      s.resolvedPassword = enc.password;
    }
  }
  // attach a preview of the login XML (modern login, cmd_id=1, c2s, w/ body)
  for (const af of frames) {
    if (af.frame.header.cmdId !== 1) continue;
    if (af.pcap.direction !== "c2s") continue;
    if (af.frame.body.length === 0) continue;
    const s = byStream.get(af.pcap.streamId);
    if (!s || s.loginXmlPreview) continue;
    s.loginXmlPreview = (af.decryptedXml ?? "").slice(0, 240);
  }
  return Array.from(byStream.values()).sort((a, b) => a.streamId - b.streamId);
}
