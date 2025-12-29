/**
 * H.265/HEVC Format Converter
 * Converts H.265 data from length-prefixed (HVCC) to Annex-B (start codes).
 *
 * Similar to H.264 converter, but handles H.265/HEVC specific NAL unit types.
 * H.265 uses VPS (Video Parameter Set), SPS (Sequence Parameter Set), and PPS (Picture Parameter Set).
 */

// Annex-B start codes (same as H.264):
const NAL_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const NAL_START_CODE_3B = Buffer.from([0x00, 0x00, 0x01]);

/** Returns true if the buffer starts with an Annex-B start code. */
export function hasStartCodes(data: Buffer): boolean {
  if (data.length < 4) return false;
  
  // Important: to distinguish Annex-B vs HVCC, check ONLY the beginning.
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

function looksLikeSingleH265Nal(nalPayload: Buffer): boolean {
  if (nalPayload.length < 2) return false;
  const b0 = nalPayload[0];
  const b1 = nalPayload[1];
  if (b0 === undefined || b1 === undefined) return false;
  
  // H.265 NAL unit header: first byte has forbidden_zero_bit (bit 7) and nal_unit_type (bits 0-6)
  // Second byte has nuh_layer_id (bits 0-5) and nuh_temporal_id_plus1 (bits 6-7)
  if ((b0 & 0x80) !== 0) return false; // forbidden_zero_bit must be 0
  const nalType = (b0 >> 1) & 0x3f; // Extract NAL unit type (6 bits)
  
  // Valid H.265 NAL unit types: 0-40 (some are reserved)
  // Common types: VPS (32), SPS (33), PPS (34), IDR (19-20), CRA (21), etc.
  return nalType <= 40;
}

/**
 * Converts H.265 data from length-prefixed (HVCC) to Annex-B (start codes).
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

  // Otherwise, try HVCC -> AnnexB conversion.
  // In practice most sources use 4-byte big-endian, but some streams can be little-endian:
  // try both and take the first valid conversion.
  const be = tryConvertWithLengthReader(data, (b, o) => b.readUInt32BE(o));
  if (be) return be;
  const le = tryConvertWithLengthReader(data, (b, o) => b.readUInt32LE(o));
  if (le) return le;

  // If it looks like a single H.265 NAL without start codes, prepend a start code.
  if (looksLikeSingleH265Nal(data)) {
    return Buffer.concat([NAL_START_CODE_4B, data]);
  }
  return data;
}

/**
 * Splits Annex-B formatted H.265 data into individual NAL unit payloads (without start codes).
 */
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

/**
 * Gets H.265 NAL unit type from a NAL payload (without start code).
 * Returns null if invalid.
 */
export function getH265NalType(nalPayload: Buffer): number | null {
  if (nalPayload.length < 1) return null;
  const b0 = nalPayload[0];
  if (b0 === undefined) return null;
  if ((b0 & 0x80) !== 0) return null; // forbidden_zero_bit must be 0
  return (b0 >> 1) & 0x3f; // Extract NAL unit type (6 bits)
}

/**
 * Checks if an H.265 NAL unit is an IRAP (Intra Random Access Point) picture.
 * IRAP pictures include IDR, CRA, and BLA types.
 */
export function isH265Irap(nalType: number): boolean {
  // H.265 IRAP types: 16-23
  // 16: BLA_W_LP, 17: BLA_W_RADL, 18: BLA_N_LP
  // 19: IDR_W_RADL, 20: IDR_N_LP
  // 21: CRA_NUT
  // 22-23: Reserved
  return nalType >= 16 && nalType <= 23;
}

/**
 * Validates an H.265 Annex-B access unit.
 * Checks that it has start codes and contains valid NAL unit types.
 */
export function isValidH265AnnexBAccessUnit(annexB: Buffer): boolean {
  if (!hasStartCodes(annexB)) return false;
  const nals = splitAnnexBToNalPayloads(annexB);
  if (nals.length === 0) return false;
  for (const nal of nals) {
    if (nal.length < 2) return false; // H.265 NAL header is at least 2 bytes
    const b0 = nal[0];
    if (b0 === undefined) return false;
    if ((b0 & 0x80) !== 0) return false; // forbidden_zero_bit
    const nalType = getH265NalType(nal);
    if (nalType === null) return false;
    // Valid H.265 NAL unit types: 0-40 (some are reserved)
    if (nalType > 40) return false;
  }
  return true;
}

/**
 * Checks if an H.265 Annex-B access unit is a keyframe (IRAP picture).
 * A keyframe should contain VPS, SPS, PPS, and an IRAP picture.
 */
export function isH265KeyframeAnnexB(annexB: Buffer): boolean {
  const nals = splitAnnexBToNalPayloads(annexB);
  let hasVps = false;
  let hasSps = false;
  let hasPps = false;
  let hasIrap = false;
  
  for (const nal of nals) {
    const nalType = getH265NalType(nal);
    if (nalType === null) continue;
    
    if (nalType === 32) hasVps = true; // VPS
    if (nalType === 33) hasSps = true; // SPS
    if (nalType === 34) hasPps = true; // PPS
    if (isH265Irap(nalType)) hasIrap = true; // IRAP picture
  }
  
  // A keyframe should have at least VPS, SPS, PPS, and an IRAP picture
  return hasIrap && hasVps && hasSps && hasPps;
}

/**
 * Extracts VPS (Video Parameter Set) from H.265 Annex-B data.
 * Returns the VPS NAL payload (without start code) or null if not found.
 */
export function extractVpsFromAnnexB(annexB: Buffer): Buffer | null {
  const nals = splitAnnexBToNalPayloads(annexB);
  for (const nal of nals) {
    const nalType = getH265NalType(nal);
    if (nalType === 32) { // VPS
      return nal;
    }
  }
  return null;
}

/**
 * Extracts SPS (Sequence Parameter Set) from H.265 Annex-B data.
 * Returns the SPS NAL payload (without start code) or null if not found.
 */
export function extractSpsFromAnnexB(annexB: Buffer): Buffer | null {
  const nals = splitAnnexBToNalPayloads(annexB);
  for (const nal of nals) {
    const nalType = getH265NalType(nal);
    if (nalType === 33) { // SPS
      return nal;
    }
  }
  return null;
}

/**
 * Extracts PPS (Picture Parameter Set) from H.265 Annex-B data.
 * Returns the PPS NAL payload (without start code) or null if not found.
 */
export function extractPpsFromAnnexB(annexB: Buffer): Buffer | null {
  const nals = splitAnnexBToNalPayloads(annexB);
  for (const nal of nals) {
    const nalType = getH265NalType(nal);
    if (nalType === 34) { // PPS
      return nal;
    }
  }
  return null;
}

