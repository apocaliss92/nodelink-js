/**
 * Redact a tshark-produced pcap-ng file in place by zeroing the body bytes of
 * Baichuan login frames (cmd_id=1, which carries the username + password
 * digest). Everything else — including the challenge nonce — is preserved so
 * a maintainer can decrypt the rest of the conversation locally.
 *
 * The function works directly on the file buffer:
 *   1. Walk pcap-ng blocks, find Enhanced Packet Blocks (type 6).
 *   2. Parse Ethernet → IPv4 → TCP, locate the TCP payload window.
 *   3. Within the payload, scan for the Baichuan magic `f0 de bc 0a` (or its
 *      reversed variant), decode the 20/24-byte header, and if cmd_id == 1
 *      overwrite the body bytes with zeros.
 *   4. Recompute the TCP checksum (RFC 793 / 1071 1's-complement sum over the
 *      pseudo header + TCP header + payload). The IP checksum is unchanged
 *      because we never touch IP addresses or lengths.
 *
 * IPv6 and non-Ethernet link types are left untouched (returned as-is). The
 * camera protocol only runs over IPv4/TCP, so this is safe for our captures.
 */
import { readFileSync, writeFileSync } from "node:fs";

const PCAPNG_BLOCK_TYPE_SHB = 0x0a0d0d0a;
const PCAPNG_BLOCK_TYPE_EPB = 0x00000006;
const PCAPNG_BLOCK_TYPE_SPB = 0x00000003;
const PCAPNG_BLOCK_TYPE_PB_OBSOLETE = 0x00000002;
const PCAPNG_BYTE_ORDER_MAGIC_LE = 0x1a2b3c4d;

const ETHERTYPE_IPV4 = 0x0800;
const IP_PROTO_TCP = 6;

/** Baichuan magic in the two byte orders we accept. */
const BC_MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);
const BC_MAGIC_REV = Buffer.from([0x0a, 0xbc, 0xde, 0xf0]);

const BC_CMD_ID_LOGIN = 1;

export interface RedactionResult {
  bytesRedacted: number;
  loginFramesRedacted: number;
  packetsTouched: number;
  packetsTotal: number;
}

/**
 * Read `inputPath`, redact login bodies, write to `outputPath`. Returns
 * counters useful for surfacing in the UI ("we wiped N login bytes").
 */
export function redactPcapng(
  inputPath: string,
  outputPath: string,
): RedactionResult {
  const buf = Buffer.from(readFileSync(inputPath));
  const result: RedactionResult = {
    bytesRedacted: 0,
    loginFramesRedacted: 0,
    packetsTouched: 0,
    packetsTotal: 0,
  };

  // pcap-ng files always start with a Section Header Block. The fourth-byte
  // pattern of the byte-order magic tells us little- vs big-endian.
  if (buf.length < 12 || buf.readUInt32LE(0) !== PCAPNG_BLOCK_TYPE_SHB) {
    throw new Error(
      "Input does not look like a pcap-ng file (missing SHB magic).",
    );
  }
  // We assume LE for tshark on x86/ARM macOS+Linux. The byte-order magic at
  // offset 8 of the SHB confirms.
  if (buf.readUInt32LE(8) !== PCAPNG_BYTE_ORDER_MAGIC_LE) {
    throw new Error(
      "Big-endian pcap-ng files are not supported by this redactor.",
    );
  }

  let off = 0;
  while (off + 8 <= buf.length) {
    const blockType = buf.readUInt32LE(off);
    const blockLen = buf.readUInt32LE(off + 4);
    if (blockLen < 12 || off + blockLen > buf.length) break;

    if (
      blockType === PCAPNG_BLOCK_TYPE_EPB ||
      blockType === PCAPNG_BLOCK_TYPE_PB_OBSOLETE
    ) {
      result.packetsTotal++;
      // EPB layout (RFC 9354 §4.3):
      //   [0..3] block type
      //   [4..7] block total length
      //   [8..11] interface id
      //   [12..15] timestamp high
      //   [16..19] timestamp low
      //   [20..23] captured packet length
      //   [24..27] original packet length
      //   [28..28+capLen-1] packet data (link-layer)
      //   ... padding + options + repeat block total length
      const capturedLen = buf.readUInt32LE(off + 20);
      const dataStart = off + 28;
      if (dataStart + capturedLen > off + blockLen) break;
      const touched = redactInLinkFrame(
        buf,
        dataStart,
        capturedLen,
        result,
      );
      if (touched) result.packetsTouched++;
    } else if (blockType === PCAPNG_BLOCK_TYPE_SPB) {
      // Simple Packet Block: link-layer data starts after [type|len|origLen]
      // (12 bytes). We don't rely on tshark emitting these but support them
      // for completeness.
      result.packetsTotal++;
      const origLen = buf.readUInt32LE(off + 8);
      const dataStart = off + 12;
      if (dataStart + origLen > off + blockLen) break;
      const touched = redactInLinkFrame(buf, dataStart, origLen, result);
      if (touched) result.packetsTouched++;
    }

    off += blockLen;
  }

  writeFileSync(outputPath, buf);
  return result;
}

/**
 * Find IPv4/TCP payload inside an Ethernet frame and zero any cmd_id=1 body
 * bytes. Returns true if anything was modified in this packet (so we can
 * count packets touched separately from frames redacted).
 */
function redactInLinkFrame(
  buf: Buffer,
  start: number,
  length: number,
  result: RedactionResult,
): boolean {
  if (length < 14) return false;
  // Ethernet II: dest(6) src(6) ethertype(2). We don't bother with VLAN tags.
  const ethertype = buf.readUInt16BE(start + 12);
  if (ethertype !== ETHERTYPE_IPV4) return false;

  const ipStart = start + 14;
  if (ipStart + 20 > start + length) return false;
  const verIhl = buf[ipStart] ?? 0;
  const version = verIhl >> 4;
  if (version !== 4) return false;
  const ihl = (verIhl & 0x0f) * 4;
  if (ipStart + ihl > start + length) return false;
  const proto = buf[ipStart + 9];
  if (proto !== IP_PROTO_TCP) return false;
  const totalLen = buf.readUInt16BE(ipStart + 2);
  const ipEnd = ipStart + totalLen;
  if (ipEnd > start + length) return false;

  const tcpStart = ipStart + ihl;
  if (tcpStart + 20 > ipEnd) return false;
  const dataOff = ((buf[tcpStart + 12] ?? 0) >> 4) * 4;
  if (tcpStart + dataOff > ipEnd) return false;
  const payloadStart = tcpStart + dataOff;
  const payloadEnd = ipEnd;
  if (payloadEnd <= payloadStart) return false;

  let modified = false;
  // Find every Baichuan frame in this TCP payload window. A single TCP
  // segment can hold multiple frames or be a partial frame (the latter we
  // skip — the redactor is best-effort and bodies that span segments stay
  // untouched, but tshark captures rarely fragment small login frames).
  let p = payloadStart;
  while (p + 20 <= payloadEnd) {
    if (
      !(
        (buf[p] === BC_MAGIC[0] &&
          buf[p + 1] === BC_MAGIC[1] &&
          buf[p + 2] === BC_MAGIC[2] &&
          buf[p + 3] === BC_MAGIC[3]) ||
        (buf[p] === BC_MAGIC_REV[0] &&
          buf[p + 1] === BC_MAGIC_REV[1] &&
          buf[p + 2] === BC_MAGIC_REV[2] &&
          buf[p + 3] === BC_MAGIC_REV[3])
      )
    ) {
      // Not magic: advance one byte and try to resync. Login frames are
      // small enough that they're rarely fragmented after the magic, but we
      // still scan rather than assume the segment starts on a frame boundary.
      p++;
      continue;
    }
    const cmdId = buf.readUInt32LE(p + 4);
    const bodyLen = buf.readUInt32LE(p + 8);
    const messageClass = buf.readUInt16LE(p + 18);
    const headerLen = messageClass === 0x6414 ? 24 : 20;
    const frameEnd = p + headerLen + bodyLen;
    if (frameEnd > payloadEnd) break; // partial — let the next segment handle it

    if (cmdId === BC_CMD_ID_LOGIN && bodyLen > 0) {
      buf.fill(0x00, p + headerLen, frameEnd);
      result.bytesRedacted += bodyLen;
      result.loginFramesRedacted++;
      modified = true;
    }
    p = frameEnd;
  }

  if (modified) {
    // TCP checksum is over [pseudo-header][TCP header + payload]. Recompute.
    // Pseudo header (12 bytes): srcAddr(4) dstAddr(4) zero(1) proto(1) tcpLen(2)
    const tcpLen = ipEnd - tcpStart;
    const pseudo = Buffer.alloc(12);
    buf.copy(pseudo, 0, ipStart + 12, ipStart + 16); // src addr
    buf.copy(pseudo, 4, ipStart + 16, ipStart + 20); // dst addr
    pseudo[9] = IP_PROTO_TCP;
    pseudo.writeUInt16BE(tcpLen, 10);
    // Zero out the existing checksum field before computing.
    buf.writeUInt16BE(0, tcpStart + 16);
    const checksum = onesComplementSum(pseudo, buf.subarray(tcpStart, ipEnd));
    buf.writeUInt16BE(checksum, tcpStart + 16);
  }

  return modified;
}

/**
 * RFC 1071 1's-complement 16-bit sum over the concatenation of the given
 * buffers. Used for IPv4 / TCP / UDP checksums.
 */
function onesComplementSum(...parts: Buffer[]): number {
  let sum = 0;
  for (const part of parts) {
    let i = 0;
    for (; i + 2 <= part.length; i += 2) {
      sum += (part[i]! << 8) | part[i + 1]!;
    }
    if (i < part.length) {
      // Odd byte: pad with zero.
      sum += (part[i]! << 8);
    }
  }
  while (sum > 0xffff) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}
