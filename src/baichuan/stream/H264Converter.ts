/**
 * H.264 Format Converter
 * Converts H.264 data from length-prefixed (AVCC) to Annex-B (start codes).
 *
 * Based on neolink: BcMedia payloads can be length-prefixed and must be converted
 * to Annex-B for ffmpeg/RTSP streaming.
 */

// Annex-B start codes:
// - 4 bytes: 0x00 00 00 01
// - 3 bytes: 0x00 00 01
const NAL_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const NAL_START_CODE_3B = Buffer.from([0x00, 0x00, 0x01]);

/** Returns true if the buffer starts with an Annex-B start code. */
export function hasStartCodes(data: Buffer): boolean {
  if (data.length < 4) return false;
  
  // Important: to distinguish Annex-B vs AVCC, check ONLY the beginning.
  // Searching for a start code "in the middle" can cause false positives and prevent conversion.
  if (data.subarray(0, 4).equals(NAL_START_CODE_4B)) return true; // 0x00000001
  if (data.subarray(0, 3).equals(NAL_START_CODE_3B)) return true; // 0x000001
  return false;
}

function tryConvertWithLengthReader(data: Buffer, readLen: (buf: Buffer, offset: number) => number): Buffer | null {
  const result: Buffer[] = [];
  let offset = 0;
  let nalCount = 0;

  while (offset < data.length) {
    if (offset + 4 > data.length) return null;
    const nalLength = readLen(data, offset);
    offset += 4;
    if (nalLength <= 0) return null;
    if (nalLength > data.length - offset) return null;

    result.push(NAL_START_CODE_4B);
    result.push(data.subarray(offset, offset + nalLength));
    offset += nalLength;
    nalCount++;
  }

  // Require at least 1 NAL to consider the conversion valid.
  if (nalCount === 0) return null;
  return Buffer.concat(result);
}

function tryConvertWithLengthReader16(data: Buffer, readLen: (buf: Buffer, offset: number) => number): Buffer | null {
  const result: Buffer[] = [];
  let offset = 0;
  let nalCount = 0;

  while (offset < data.length) {
    if (offset + 2 > data.length) return null;
    const nalLength = readLen(data, offset);
    offset += 2;
    if (nalLength <= 0) return null;
    if (nalLength > data.length - offset) return null;

    result.push(NAL_START_CODE_4B);
    result.push(data.subarray(offset, offset + nalLength));
    offset += nalLength;
    nalCount++;
  }

  if (nalCount === 0) return null;
  return Buffer.concat(result);
}

function looksLikeSingleH264Nal(nalPayload: Buffer): boolean {
  if (nalPayload.length < 1) return false;
  const b0 = nalPayload[0];
  if (b0 === undefined) return false;
  if ((b0 & 0x80) !== 0) return false; // forbidden_zero_bit must be 0
  const nalType = b0 & 0x1f;
  return nalType >= 1 && nalType <= 23;
}

function depacketizeRtpAggregationToAnnexB(payload: Buffer): Buffer | null {
  // Supports some H.264 "RTP-style" aggregation payloads (STAP/MTAP) that can appear in Baichuan streams.
  // Reference: RFC 6184
  if (payload.length < 1) return null;
  const nalHeader = payload[0]!;
  const nalType = nalHeader & 0x1f;

  const out: Buffer[] = [];
  const pushNal = (nal: Buffer) => {
    if (nal.length === 0) return;
    out.push(NAL_START_CODE_4B, nal);
  };

  // STAP-A (24): [1B header][2B size][NAL]...
  if (nalType === 24) {
    let off = 1;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (size <= 0 || off + size > payload.length) return null;
      pushNal(payload.subarray(off, off + size));
      off += size;
    }
    return out.length ? Buffer.concat(out) : null;
  }

  // STAP-B (25): [1B header][2B DON][2B size][NAL]...
  if (nalType === 25) {
    let off = 1 + 2; // skip DON
    if (off > payload.length) return null;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (size <= 0 || off + size > payload.length) return null;
      pushNal(payload.subarray(off, off + size));
      off += size;
    }
    return out.length ? Buffer.concat(out) : null;
  }

  // MTAP16 (26): [1B header][2B DON][2B size][1B DOND][2B TS offset][NAL]...
  if (nalType === 26) {
    let off = 1 + 2; // skip DON
    if (off > payload.length) return null;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (off + 1 + 2 > payload.length) return null; // need DOND + TS offset
      off += 1; // skip DOND
      off += 2; // skip TS offset (16-bit)
      if (size <= 0 || off + size > payload.length) return null;
      pushNal(payload.subarray(off, off + size));
      off += size;
    }
    return out.length ? Buffer.concat(out) : null;
  }

  // MTAP24 (27): [1B header][2B DON][2B size][1B DOND][3B TS offset][NAL]...
  if (nalType === 27) {
    let off = 1 + 2; // skip DON
    if (off > payload.length) return null;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (off + 1 + 3 > payload.length) return null; // need DOND + TS offset
      off += 1; // skip DOND
      off += 3; // skip TS offset (24-bit)
      if (size <= 0 || off + size > payload.length) return null;
      pushNal(payload.subarray(off, off + size));
      off += size;
    }
    return out.length ? Buffer.concat(out) : null;
  }

  return null;
}

/**
 * Converts H.264 data from length-prefixed (AVCC) to Annex-B (start codes).
 *
 * The length-prefixed format uses a 4-byte big-endian integer to indicate the size
 * of each NAL unit, followed by the NAL unit bytes.
 *
 * Annex-B uses start codes (0x00000001 or 0x000001) before each NAL unit.
 */
export function convertToAnnexB(data: Buffer): Buffer {
  // If the data already has start codes, return it as-is.
  if (hasStartCodes(data)) {
    return data;
  }

  // Otherwise, try AVCC -> AnnexB conversion.
  // In practice most sources use 4-byte big-endian, but some streams can be little-endian:
  // try both and take the first valid conversion.
  const be = tryConvertWithLengthReader(data, (b, o) => b.readUInt32BE(o));
  if (be) return be;
  const le = tryConvertWithLengthReader(data, (b, o) => b.readUInt32LE(o));
  if (le) return le;

  // Also try 2-byte length-prefixed (some streams do this on P-frames).
  const be16 = tryConvertWithLengthReader16(data, (b, o) => b.readUInt16BE(o));
  if (be16) return be16;
  const le16 = tryConvertWithLengthReader16(data, (b, o) => b.readUInt16LE(o));
  if (le16) return le16;

  // Fallback: unrecognized.
  // If it looks like an RTP aggregation payload (STAP/MTAP), depacketize into Annex-B NAL units.
  const agg = depacketizeRtpAggregationToAnnexB(data);
  if (agg) return agg;

  // If it looks like a single H.264 NAL without start codes, prepend a start code.
  if (looksLikeSingleH264Nal(data)) {
    return Buffer.concat([NAL_START_CODE_4B, data]);
  }
  return data;
}

export function splitAnnexBToNalPayloads(annexB: Buffer): Buffer[] {
  // Returns NAL payloads without start codes.
  const starts: Array<{ idx: number; len: number }> = [];
  for (let i = 0; i < annexB.length - 3; i++) {
    if (annexB[i] === 0x00 && annexB[i + 1] === 0x00) {
      if (annexB[i + 2] === 0x01) {
        starts.push({ idx: i, len: 3 });
        i += 2;
      } else if (annexB[i + 2] === 0x00 && annexB[i + 3] === 0x01) {
        starts.push({ idx: i, len: 4 });
        i += 3;
      }
    }
  }
  if (starts.length === 0) return [];
  const out: Buffer[] = [];
  for (let s = 0; s < starts.length; s++) {
    const st = starts[s]!;
    const start = st.idx + st.len;
    const end = starts[s + 1] ? starts[s + 1]!.idx : annexB.length;
    if (end > start) out.push(annexB.subarray(start, end));
  }
  return out;
}

export function isValidH264AnnexBAccessUnit(annexB: Buffer): boolean {
  if (!hasStartCodes(annexB)) return false;
  const nals = splitAnnexBToNalPayloads(annexB);
  if (nals.length === 0) return false;
  for (const nal of nals) {
    if (nal.length < 1) return false;
    const b0 = nal[0];
    if (b0 === undefined) return false;
    if ((b0 & 0x80) !== 0) return false; // forbidden_zero_bit
    const nalType = b0 & 0x1f;
    // In Annex-B we expect types 1..23 (VCL + SPS/PPS/SEI/AUD etc).
    // Types 24..29 are RTP packetization payloads, not a NAL unit byte stream.
    if (nalType === 0 || nalType >= 24) return false;
  }
  return true;
}

export function isH264KeyframeAnnexB(annexB: Buffer): boolean {
  const nals = splitAnnexBToNalPayloads(annexB);
  let hasSps = false;
  let hasPps = false;
  let hasIdr = false;
  for (const nal of nals) {
    const t = (nal[0] ?? 0) & 0x1f;
    if (t === 7) hasSps = true;
    if (t === 8) hasPps = true;
    if (t === 5) hasIdr = true;
  }
  return hasIdr && hasSps && hasPps;
}

/**
 * Depacketizer for H.264 "RTP-like" payloads (RFC 6184) when the camera sends single NAL units,
 * STAP/MTAP aggregation or FU-A/FU-B fragmentation inside a BcMedia frame payload.
 *
 * Returns NAL units already in Annex-B (with start codes).
 */
export class H264RtpDepacketizer {
  private fuNalHeader: number | null = null;
  private fuParts: Buffer[] = [];

  reset(): void {
    this.fuNalHeader = null;
    this.fuParts = [];
  }

  push(payload: Buffer): Buffer[] {
    if (payload.length === 0) return [];

    // Important: behave like an RFC 6184 "RTP-like" depacketizer here, so do NOT run
    // AVCC/heuristic conversions that could produce false positives.
    // If it's already Annex-B, return as-is.
    if (hasStartCodes(payload)) return [payload];

    const b0 = payload[0]!;
    if ((b0 & 0x80) !== 0) return []; // forbidden_zero_bit must be 0 for H.264
    const nalType = b0 & 0x1f;

    // Single NAL unit
    if (nalType >= 1 && nalType <= 23) {
      return [Buffer.concat([NAL_START_CODE_4B, payload])];
    }

    // STAP-A (24): multiple NAL in one payload
    if (nalType === 24) {
      if (payload.length < 1 + 2) return [];
      let off = 1;
      const out: Buffer[] = [];
      while (off + 2 <= payload.length) {
        const size = payload.readUInt16BE(off);
        off += 2;
        if (size <= 0 || off + size > payload.length) return [];
        const nal = payload.subarray(off, off + size);
        off += size;
        if (nal.length < 1) return [];
        if ((nal[0]! & 0x80) !== 0) return [];
        const t = nal[0]! & 0x1f;
        if (t === 0 || t >= 24) return [];
        out.push(Buffer.concat([NAL_START_CODE_4B, nal]));
      }
      return out;
    }

    // FU-A / FU-B
    if (nalType === 28 || nalType === 29) {
      if (payload.length < 2) return [];
      const fuIndicator = payload[0]!;
      const fuHeader = payload[1]!;
      const start = (fuHeader & 0x80) !== 0;
      const end = (fuHeader & 0x40) !== 0;
      const origType = fuHeader & 0x1f;
      const reconstructedHeader = (fuIndicator & 0xe0) | origType; // F+NRI from indicator, type from header

      let off = 2;
      if (nalType === 29) {
        // FU-B has DON (2 bytes)
        if (payload.length < off + 2) return [];
        off += 2;
      }
      const frag = payload.subarray(off);

      if (start) {
        this.fuNalHeader = reconstructedHeader;
        this.fuParts = [frag];
      } else if (this.fuNalHeader != null) {
        this.fuParts.push(frag);
      } else {
        // frammento senza start: scarta
        return [];
      }

      if (end && this.fuNalHeader != null) {
        const nal = Buffer.concat([Buffer.from([this.fuNalHeader]), ...this.fuParts]);
        this.reset();
        return [Buffer.concat([NAL_START_CODE_4B, nal])];
      }
      return [];
    }

    // Other types (24-27) should already be handled by convertToAnnexB; if we are here, ignore.
    return [];
  }
}

/**
 * Converte dati H.264 da Annex-B a length-prefixed (se necessario)
 * Non usato per ffmpeg, ma utile per altri scopi
 */
export function convertToLengthPrefixed(data: Buffer): Buffer {
  const result: Buffer[] = [];
  let offset = 0;
  
  while (offset < data.length) {
    // Cerca start code
    let startCodeOffset = -1;
    let startCodeLength = 0;
    
    // Cerca 4-byte start code
    if (offset + 4 <= data.length && data.subarray(offset, offset + 4).equals(NAL_START_CODE_4B)) {
      startCodeOffset = offset;
      startCodeLength = 4;
    }
    // Cerca 3-byte start code
    else if (offset + 3 <= data.length && data.subarray(offset, offset + 3).equals(NAL_START_CODE_3B)) {
      startCodeOffset = offset;
      startCodeLength = 3;
    }
    
    if (startCodeOffset === -1) {
      // No start code found, append the remainder as-is
      result.push(data.subarray(offset));
      break;
    }
    
    // Salta lo start code
    offset = startCodeOffset + startCodeLength;
    
    // Trova il prossimo start code o la fine dei dati
    let nextStartCode = -1;
    let nextStartCodeLength = 0;
    
    for (let i = offset; i < data.length - 3; i++) {
      if (i + 4 <= data.length && data.subarray(i, i + 4).equals(NAL_START_CODE_4B)) {
        nextStartCode = i;
        nextStartCodeLength = 4;
        break;
      }
      if (i + 3 <= data.length && data.subarray(i, i + 3).equals(NAL_START_CODE_3B)) {
        nextStartCode = i;
        nextStartCodeLength = 3;
        break;
      }
    }
    
    // Estrai il NAL unit
    const nalEnd = nextStartCode !== -1 ? nextStartCode : data.length;
    const nalData = data.subarray(offset, nalEnd);
    
    // Aggiungi length prefix (4 bytes, big-endian)
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(nalData.length, 0);
    result.push(lengthBuf);
    
    // Aggiungi dati NAL
    result.push(nalData);
    
    offset = nalEnd;
  }
  
  return Buffer.concat(result);
}

