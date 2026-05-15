import { aesDecrypt, bcDecrypt, type EncryptionProtocol } from "../../src/protocol/crypto";
import { BC_CMD_ID_VIDEO } from "../../src/protocol/constants";
import { BcMediaCodec, type UnknownChunkListener } from "../../src/baichuan/stream/BcMediaCodec";
import type { AnnotatedFrame, NegotiatedEnc } from "./decrypt";

export interface MediaScanEntry {
  frameNumber: number;
  streamId: number;
  channelId: number;
  magic: number;
  magicAscii: string;
  type: string;
  size: number;
  offset: number;
  /** First 64 bytes of the packet, hex */
  preview: string;
}

/**
 * Walk every cmd_id=3 frame for each TCP stream, decrypt the BcMedia payload
 * the same way `BaichuanVideoStream` does (parses `<encryptLen>` from the
 * Extension XML, applies partial AES decrypt, falls back to fresh-IV decrypt
 * otherwise), and feed the decrypted bytes through the production `BcMediaCodec`.
 *
 * The codec is configured with a `setUnknownChunkListener` so we surface every
 * 4-byte magic that the parser silently drops — those are the prime candidates
 * for any undocumented metadata sub-packet (e.g. Motion Mark coordinates).
 */
export function scanMediaStream(
  frames: AnnotatedFrame[],
  sessions: Map<number, NegotiatedEnc | undefined>,
): MediaScanEntry[] {
  const out: MediaScanEntry[] = [];

  // Bucket frames by (streamId, direction). Each bucket gets its own codec.
  const buckets = new Map<string, AnnotatedFrame[]>();
  for (const af of frames) {
    if (af.frame.header.cmdId !== BC_CMD_ID_VIDEO) continue;
    if (af.frame.payload.length === 0) continue;
    const key = `${af.pcap.streamId}:${af.pcap.direction}`;
    const list = buckets.get(key);
    if (list) list.push(af);
    else buckets.set(key, [af]);
  }

  for (const [key, list] of buckets) {
    const streamId = Number(key.split(":")[0]);
    const enc = sessions.get(streamId);
    if (!enc) continue;

    const codec = new BcMediaCodec(false);
    const listener: UnknownChunkListener = ({ magic, preview, skipped }) => {
      out.push({
        frameNumber: -1,
        streamId,
        channelId: -1,
        magic,
        magicAscii: magicAscii(magic),
        type: "Unknown",
        size: skipped,
        offset: -1,
        preview: previewHex(preview, 64),
      });
    };
    codec.setUnknownChunkListener(listener);

    for (const af of list) {
      const dec = decryptVideoPayload({
        payload: af.frame.payload,
        extension: af.frame.extension,
        channelId: af.frame.header.channelId,
        enc,
      });
      const packets = codec.decode(dec);
      for (const p of packets) {
        out.push({
          frameNumber: af.pcap.frameNumber,
          streamId,
          channelId: af.frame.header.channelId,
          magic: bcMediaMagicOf(p),
          magicAscii: magicAscii(bcMediaMagicOf(p)),
          type: p.type,
          size: dec.length,
          offset: -1,
          preview: "",
        });
      }
    }
  }

  return out;
}

function bcMediaMagicOf(p: { type: string }): number {
  switch (p.type) {
    case "InfoV1": return 0x31303031;
    case "InfoV2": return 0x32303031;
    case "Iframe": return 0x63643030;
    case "Pframe": return 0x63643130;
    case "Aac": return 0x62773530;
    case "Adpcm": return 0x62773130;
    default: return 0;
  }
}

interface DecryptParams {
  payload: Buffer;
  extension: Buffer;
  channelId: number;
  enc: NegotiatedEnc;
}

/**
 * Match `BaichuanVideoStream.chooseDecryptedOrRawCandidate` for live (cmdId=3):
 * - parse `<encryptLen>N</encryptLen>` from the extension XML
 * - if present and N < payload.length: decrypt first N bytes, keep rest clear
 * - if absent: fresh AES decrypt for full_aes, BC-decrypt for bc, raw for none
 */
function decryptVideoPayload(p: DecryptParams): Buffer {
  const encryptLen = parseEncryptLen(p.extension, p.channelId, asEncryptionProtocol(p.enc));

  if (encryptLen !== undefined && encryptLen > 0 && encryptLen < p.payload.length) {
    const encryptedPart = p.payload.subarray(0, encryptLen);
    const clearPart = p.payload.subarray(encryptLen);
    const decryptedPart = oneShotDecrypt(encryptedPart, p.channelId, p.enc);
    return Buffer.concat([decryptedPart, clearPart]);
  }

  return oneShotDecrypt(p.payload, p.channelId, p.enc);
}

function oneShotDecrypt(buf: Buffer, channelId: number, enc: NegotiatedEnc): Buffer {
  if (enc.kind === "none") return buf;
  if (enc.kind === "bc") return bcDecrypt(buf, channelId);
  return aesDecrypt(buf, enc.key);
}

function asEncryptionProtocol(enc: NegotiatedEnc): EncryptionProtocol {
  if (enc.kind === "none" || enc.kind === "bc") return { kind: enc.kind };
  return { kind: enc.kind, key: enc.key };
}

function parseEncryptLen(
  extension: Buffer,
  channelId: number,
  enc: EncryptionProtocol,
): number | undefined {
  if (extension.length === 0) return undefined;
  // Try every possible decoding to find the XML
  const candidates: Buffer[] = [];
  try { if (enc.kind === "aes" || enc.kind === "full_aes") candidates.push(aesDecrypt(extension, enc.key)); } catch {/* ignore */}
  try { candidates.push(bcDecrypt(extension, channelId)); } catch {/* ignore */}
  candidates.push(extension);
  for (const c of candidates) {
    const s = c.toString("utf8");
    if (!s.startsWith("<?xml") && !s.startsWith("<Extension")) continue;
    const m = /<encryptLen>(\d+)<\/encryptLen>/i.exec(s);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function magicAscii(m: number): string {
  return Buffer.from([m & 0xff, (m >>> 8) & 0xff, (m >>> 16) & 0xff, (m >>> 24) & 0xff])
    .toString("ascii")
    .replace(/[^\x20-\x7e]/g, ".");
}

function previewHex(buf: Buffer, max: number): string {
  return buf.subarray(0, max).toString("hex").match(/../g)?.join(" ") ?? "";
}
