/**
 * MPEG-TS Muxer for H.264/H.265 video + ADTS AAC audio.
 *
 * Produces 188-byte MPEG-TS packets suitable for feeding to go2rtc via a
 * plain TCP connection (`tcp://127.0.0.1:{port}`).  go2rtc auto-detects the
 * container format from the 0x47 sync byte and extracts both video and audio.
 *
 * Stream layout:
 *   PID 0x0000 — PAT (Program Association Table)
 *   PID 0x1000 — PMT (Program Map Table)
 *   PID 0x0100 — Video elementary stream (H.264 or H.265, Annex-B)
 *   PID 0x0101 — Audio elementary stream (AAC-ADTS, stream type 0x0F)
 *
 * Each `MpegTsMuxer` instance is independent: continuity counters are
 * per-instance so multiple concurrent streams do not corrupt each other.
 *
 * Usage:
 *   const muxer = new MpegTsMuxer({ videoType: "H265", includeAudio: true });
 *   const tsBytes = muxer.muxVideo(annexBBuffer, ptsUs, isKeyframe);
 *   const tsBytes = muxer.muxAudio(adtsBuffer, ptsUs);
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const TS_PAYLOAD_SIZE = TS_PACKET_SIZE - 4; // 184

// Fixed PIDs
const PID_PAT = 0x0000;
const PID_PMT = 0x1000;
const PID_VIDEO = 0x0100;
const PID_AUDIO = 0x0101;

// MPEG-TS stream types
const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_H265 = 0x24;
const STREAM_TYPE_AAC = 0x0f; // ISO/IEC 13818-7 ADTS AAC

// PES stream IDs
const PES_STREAM_ID_VIDEO = 0xe0;
const PES_STREAM_ID_AUDIO = 0xc0;

// Resend PAT+PMT at least every N video frames (and always on keyframes)
const PAT_PMT_INTERVAL = 40;

// ---------------------------------------------------------------------------
// CRC-32/MPEG-2
// ---------------------------------------------------------------------------

function crc32Mpeg(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 24;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04c11db7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
  }
  return crc >>> 0;
}

// ---------------------------------------------------------------------------
// PTS encoding (5 bytes, 90 kHz clock)
// ---------------------------------------------------------------------------

/**
 * Convert microseconds to a 90 kHz PTS value (MPEG-TS standard clock rate).
 * Wraps at 2^33 (about 26 hours).
 */
function usToPts(us: number): number {
  // 90 kHz = 90 000 ticks/second; microseconds → ticks = us * 90 / 1000
  return Math.floor((us * 90) / 1000) & 0x1ffffffff; // 33-bit mask
}

/**
 * Encode a PTS value into 5 bytes.
 * prefix: 0b0010 for PTS-only, 0b0011 for PTS in a PTS+DTS pair.
 */
function encodePts(buf: Buffer, offset: number, pts: number, prefix: number): void {
  buf[offset + 0] = (prefix << 4) | ((pts >>> 30) & 0x07) << 1 | 0x01;
  buf[offset + 1] = (pts >>> 22) & 0xff;
  buf[offset + 2] = ((pts >>> 15) & 0x7f) << 1 | 0x01;
  buf[offset + 3] = (pts >>> 7) & 0xff;
  buf[offset + 4] = (pts & 0x7f) << 1 | 0x01;
}

// ---------------------------------------------------------------------------
// TS packet helpers
// ---------------------------------------------------------------------------

/**
 * Build a TS packet header (4 bytes).
 *
 * @param buf        - destination buffer (>= 4 bytes)
 * @param pid        - packet identifier (13 bits)
 * @param pusi       - payload_unit_start_indicator (true for first TS of PES)
 * @param cc         - continuity counter (4 bits, already incremented by caller)
 * @param hasAdapt   - whether adaptation field is present
 * @param hasPayload - whether payload is present
 */
function writeTsHeader(
  buf: Buffer,
  pid: number,
  pusi: boolean,
  cc: number,
  hasAdapt: boolean,
  hasPayload: boolean,
): void {
  buf[0] = TS_SYNC_BYTE;
  buf[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  buf[2] = pid & 0xff;
  buf[3] =
    ((hasAdapt ? 0x20 : 0x00) | (hasPayload ? 0x10 : 0x00) | (cc & 0x0f));
}

/**
 * Wrap a PES buffer into one or more 188-byte TS packets.
 * The first packet sets PUSI; continuation packets do not.
 * The last packet uses an adaptation field to pad to 188 bytes if needed.
 *
 * @param pesData     - Complete PES bytes (start code through payload)
 * @param pid         - TS PID for the elementary stream
 * @param ccRef       - Object wrapping the continuity counter so it is mutated in-place
 * @param isKeyframe  - Set random_access_indicator in adaptation field of first packet
 */
function pesToTsPackets(
  pesData: Buffer,
  pid: number,
  ccRef: { cc: number },
  isKeyframe: boolean,
): Buffer {
  const totalPackets = Math.ceil(pesData.length / TS_PAYLOAD_SIZE);
  const out = Buffer.allocUnsafe(totalPackets * TS_PACKET_SIZE);
  let pesOffset = 0;
  let outOffset = 0;
  let isFirst = true;

  while (pesOffset < pesData.length) {
    const remaining = pesData.length - pesOffset;
    const packet = out.subarray(outOffset, outOffset + TS_PACKET_SIZE);
    outOffset += TS_PACKET_SIZE;

    if (remaining >= TS_PAYLOAD_SIZE) {
      // Full payload — no adaptation field needed
      writeTsHeader(packet, pid, isFirst, ccRef.cc, false, true);
      ccRef.cc = (ccRef.cc + 1) & 0x0f;
      pesData.copy(packet, 4, pesOffset, pesOffset + TS_PAYLOAD_SIZE);
      pesOffset += TS_PAYLOAD_SIZE;
    } else {
      // Last (or only) packet — pad with adaptation field
      const paddingNeeded = TS_PAYLOAD_SIZE - remaining;

      if (paddingNeeded === 1) {
        // Adaptation field length byte = 0 (no flags, 0 stuffing bytes)
        writeTsHeader(packet, pid, isFirst, ccRef.cc, true, true);
        ccRef.cc = (ccRef.cc + 1) & 0x0f;
        packet[4] = 0x00; // adaptation_field_length = 0
        pesData.copy(packet, 5, pesOffset, pesOffset + remaining);
      } else {
        // paddingNeeded >= 2: adaptation_field_length byte + (paddingNeeded-2) stuffing + 1 flags byte
        writeTsHeader(packet, pid, isFirst, ccRef.cc, true, true);
        ccRef.cc = (ccRef.cc + 1) & 0x0f;
        const adaptLen = paddingNeeded - 1; // excludes the adaptation_field_length byte itself
        packet[4] = adaptLen;
        // Flags byte: random_access_indicator on first video keyframe packet only
        packet[5] = isFirst && isKeyframe ? 0x40 : 0x00;
        // Stuffing bytes (0xff)
        packet.fill(0xff, 6, 4 + paddingNeeded);
        pesData.copy(packet, 4 + paddingNeeded, pesOffset, pesOffset + remaining);
      }
      pesOffset += remaining;
    }

    isFirst = false;
  }

  return out;
}

// ---------------------------------------------------------------------------
// PAT / PMT builders (instance methods using per-instance CC)
// ---------------------------------------------------------------------------

function buildPat(cc: number): Buffer {
  const pkt = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  pkt[0] = TS_SYNC_BYTE;
  pkt[1] = 0x40 | ((PID_PAT >> 8) & 0x1f); // PUSI=1
  pkt[2] = PID_PAT & 0xff;
  pkt[3] = 0x10 | (cc & 0x0f);

  pkt[4] = 0x00; // pointer_field

  // PAT section (starts at byte 5)
  const sectionStart = 5;
  let i = sectionStart;
  pkt[i++] = 0x00; // table_id = PAT
  pkt[i++] = 0xb0; // section_syntax_indicator=1, '0'=0, reserved=11
  pkt[i++] = 13;   // section_length (includes everything after this byte through CRC)
  pkt[i++] = 0x00; // transport_stream_id high
  pkt[i++] = 0x01; // transport_stream_id low
  pkt[i++] = 0xc1; // reserved, version=0, current_next=1
  pkt[i++] = 0x00; // section_number
  pkt[i++] = 0x00; // last_section_number
  // Program 1 → PMT PID
  pkt[i++] = 0x00;
  pkt[i++] = 0x01;
  pkt[i++] = 0xe0 | ((PID_PMT >> 8) & 0x1f);
  pkt[i++] = PID_PMT & 0xff;
  // CRC32 covers table_id through last program entry
  const crc = crc32Mpeg(pkt.subarray(sectionStart, i));
  pkt.writeUInt32BE(crc, i);

  return pkt;
}

function buildPmt(
  videoStreamType: number,
  includeAudio: boolean,
  cc: number,
): Buffer {
  const pkt = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  pkt[0] = TS_SYNC_BYTE;
  pkt[1] = 0x40 | ((PID_PMT >> 8) & 0x1f); // PUSI=1
  pkt[2] = PID_PMT & 0xff;
  pkt[3] = 0x10 | (cc & 0x0f);

  pkt[4] = 0x00; // pointer_field

  const sectionStart = 5;
  let i = sectionStart;
  pkt[i++] = 0x02; // table_id = PMT
  pkt[i++] = 0xb0; // section_syntax_indicator=1

  // section_length placeholder — filled in after we know the content
  const sectionLenPos = i;
  i += 1; // skip section_length (filled below)

  pkt[i++] = 0x00; // program_number high
  pkt[i++] = 0x01; // program_number low
  pkt[i++] = 0xc1; // reserved, version=0, current_next=1
  pkt[i++] = 0x00; // section_number
  pkt[i++] = 0x00; // last_section_number
  // PCR_PID = video PID
  pkt[i++] = 0xe0 | ((PID_VIDEO >> 8) & 0x1f);
  pkt[i++] = PID_VIDEO & 0xff;
  // program_info_length = 0 (no descriptors)
  pkt[i++] = 0xf0;
  pkt[i++] = 0x00;

  // Video stream entry
  pkt[i++] = videoStreamType;
  pkt[i++] = 0xe0 | ((PID_VIDEO >> 8) & 0x1f);
  pkt[i++] = PID_VIDEO & 0xff;
  pkt[i++] = 0xf0; // ES_info_length high
  pkt[i++] = 0x00; // ES_info_length low

  // Audio stream entry (optional)
  if (includeAudio) {
    pkt[i++] = STREAM_TYPE_AAC;
    pkt[i++] = 0xe0 | ((PID_AUDIO >> 8) & 0x1f);
    pkt[i++] = PID_AUDIO & 0xff;
    pkt[i++] = 0xf0; // ES_info_length high
    pkt[i++] = 0x00; // ES_info_length low
  }

  // section_length = bytes from program_number through CRC (i - sectionLenPos - 1 + 4 CRC bytes)
  const sectionLen = (i - sectionStart - 3) + 4; // -3 for table_id, flags, section_length field itself
  pkt[sectionLenPos] = sectionLen;

  const crc = crc32Mpeg(pkt.subarray(sectionStart, i));
  pkt.writeUInt32BE(crc, i);

  return pkt;
}

// ---------------------------------------------------------------------------
// PES builders
// ---------------------------------------------------------------------------

function buildVideoPes(annexBData: Buffer, ptsUs: number, isKeyframe: boolean): Buffer {
  const pts = usToPts(ptsUs);

  // PES header: 6-byte fixed + 3-byte optional header + 5-byte PTS = 14 bytes
  const pesHeader = Buffer.allocUnsafe(14);
  pesHeader[0] = 0x00; // start code prefix
  pesHeader[1] = 0x00;
  pesHeader[2] = 0x01;
  pesHeader[3] = PES_STREAM_ID_VIDEO;
  // PES_packet_length = 0 (unbounded — allowed for video elementary streams)
  pesHeader[4] = 0x00;
  pesHeader[5] = 0x00;
  // Flags: marker='10', data_alignment_indicator=isKeyframe, PTS_DTS_flags=10 (PTS only)
  pesHeader[6] = 0x80 | (isKeyframe ? 0x04 : 0x00);
  pesHeader[7] = 0x80; // PTS_DTS_flags = 10 (PTS only)
  pesHeader[8] = 0x05; // PES_header_data_length = 5 (one PTS field)
  encodePts(pesHeader, 9, pts, 0b0010); // prefix 0b0010 = PTS only

  return Buffer.concat([pesHeader, annexBData]);
}

function buildAudioPes(adtsData: Buffer, ptsUs: number): Buffer {
  const pts = usToPts(ptsUs);

  // For audio: PES_packet_length must be set (payload is bounded)
  // PES_packet_length = 3 (flags+length) + 5 (PTS) + adtsData.length = 8 + adtsData.length
  const pesPayloadLen = 8 + adtsData.length;

  const pesHeader = Buffer.allocUnsafe(14);
  pesHeader[0] = 0x00;
  pesHeader[1] = 0x00;
  pesHeader[2] = 0x01;
  pesHeader[3] = PES_STREAM_ID_AUDIO;
  pesHeader[4] = (pesPayloadLen >> 8) & 0xff;
  pesHeader[5] = pesPayloadLen & 0xff;
  pesHeader[6] = 0x80; // marker bits, no scrambling, no priority, no alignment
  pesHeader[7] = 0x80; // PTS_DTS_flags = 10 (PTS only)
  pesHeader[8] = 0x05; // PES_header_data_length
  encodePts(pesHeader, 9, pts, 0b0010);

  return Buffer.concat([pesHeader, adtsData]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MpegTsMuxerOptions {
  /** Video codec type. */
  videoType: "H264" | "H265";
  /**
   * Whether to include an audio PID (0x0101) in the PMT.
   * When true, audio frames muxed via muxAudio() are wrapped in PES packets
   * on PID 0x0101 (AAC-ADTS, stream type 0x0F).
   * Default: true.
   */
  includeAudio?: boolean;
}

/**
 * Stateful MPEG-TS muxer.  Each instance has its own continuity counters —
 * create one per output stream (or per client connection for prebuffer replay).
 */
export class MpegTsMuxer {
  private readonly videoStreamType: number;
  private readonly includeAudio: boolean;

  // Per-instance continuity counters (4-bit, wrap at 16)
  private patCc = 0;
  private pmtCc = 0;
  private videoCc = 0;
  private audioCc = 0;

  private framesSinceTableSend = 0;
  private tablesSent = false;

  constructor(options: MpegTsMuxerOptions) {
    this.videoStreamType =
      options.videoType === "H265" ? STREAM_TYPE_H265 : STREAM_TYPE_H264;
    this.includeAudio = options.includeAudio ?? true;
  }

  /**
   * Mux a video frame (Annex-B H.264 or H.265) into MPEG-TS packets.
   * PAT and PMT are emitted before keyframes and periodically.
   *
   * @param annexBData - Annex-B video data (with start codes)
   * @param ptsUs      - Presentation timestamp in microseconds
   * @param isKeyframe - Whether this is an IDR / IRAP frame
   */
  muxVideo(annexBData: Buffer, ptsUs: number, isKeyframe: boolean): Buffer {
    const chunks: Buffer[] = [];

    const needTables =
      !this.tablesSent ||
      isKeyframe ||
      this.framesSinceTableSend >= PAT_PMT_INTERVAL;

    if (needTables) {
      chunks.push(buildPat(this.patCc));
      this.patCc = (this.patCc + 1) & 0x0f;
      chunks.push(buildPmt(this.videoStreamType, this.includeAudio, this.pmtCc));
      this.pmtCc = (this.pmtCc + 1) & 0x0f;
      this.tablesSent = true;
      this.framesSinceTableSend = 0;
    }
    this.framesSinceTableSend++;

    const pes = buildVideoPes(annexBData, ptsUs, isKeyframe);
    const ccRef = { cc: this.videoCc };
    chunks.push(pesToTsPackets(pes, PID_VIDEO, ccRef, isKeyframe));
    this.videoCc = ccRef.cc;

    return Buffer.concat(chunks);
  }

  /**
   * Mux an audio frame (ADTS AAC) into MPEG-TS packets.
   * Returns an empty Buffer when includeAudio is false.
   *
   * @param adtsData - Raw ADTS AAC frame (starting with 0xFF 0xF1/0xF9 syncword)
   * @param ptsUs    - Presentation timestamp in microseconds
   */
  muxAudio(adtsData: Buffer, ptsUs: number): Buffer {
    if (!this.includeAudio || adtsData.length === 0) return Buffer.alloc(0);

    const pes = buildAudioPes(adtsData, ptsUs);
    const ccRef = { cc: this.audioCc };
    const result = pesToTsPackets(pes, PID_AUDIO, ccRef, false);
    this.audioCc = ccRef.cc;
    return result;
  }

  /** Reset all continuity counters and table state (e.g. after stream restart). */
  reset(): void {
    this.patCc = 0;
    this.pmtCc = 0;
    this.videoCc = 0;
    this.audioCc = 0;
    this.framesSinceTableSend = 0;
    this.tablesSent = false;
  }
}
