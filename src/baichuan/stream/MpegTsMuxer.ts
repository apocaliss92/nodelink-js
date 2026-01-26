/**
 * Simple MPEG-TS Muxer for H.264/H.265 video with PTS timestamps.
 *
 * This muxer creates MPEG-TS packets from raw Annex-B video frames,
 * preserving the original PTS timestamps. This allows ffmpeg to read
 * the stream with correct timing without needing -r (framerate) hints.
 *
 * MPEG-TS format:
 * - 188-byte packets
 * - PAT (Program Association Table) - PID 0x0000
 * - PMT (Program Map Table) - PID 0x1000
 * - Video PES - PID 0x0100
 *
 * PTS timestamps are in 90kHz units (standard for MPEG-TS).
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

// PIDs
const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const VIDEO_PID = 0x0100;

// Stream types
const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_H265 = 0x24;

// Continuity counters (0-15, wrap around)
let patCc = 0;
let pmtCc = 0;
let videoCc = 0;

/**
 * Create a PAT (Program Association Table) packet.
 */
function createPat(): Buffer {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);

  // TS header (4 bytes)
  packet[0] = TS_SYNC_BYTE;
  packet[1] = 0x40 | ((PAT_PID >> 8) & 0x1f); // payload_unit_start=1, PID high
  packet[2] = PAT_PID & 0xff; // PID low
  packet[3] = 0x10 | (patCc & 0x0f); // no adaptation, payload only, CC
  patCc = (patCc + 1) & 0x0f;

  // Pointer field (1 byte) - 0 means table starts immediately
  packet[4] = 0x00;

  // PAT section
  let idx = 5;
  packet[idx++] = 0x00; // table_id = 0 (PAT)
  packet[idx++] = 0xb0; // section_syntax_indicator=1, private=0, reserved=11
  packet[idx++] = 13; // section_length (includes CRC)
  packet[idx++] = 0x00; // transport_stream_id high
  packet[idx++] = 0x01; // transport_stream_id low
  packet[idx++] = 0xc1; // reserved, version=0, current_next=1
  packet[idx++] = 0x00; // section_number
  packet[idx++] = 0x00; // last_section_number

  // Program 1 -> PMT PID
  packet[idx++] = 0x00; // program_number high
  packet[idx++] = 0x01; // program_number low
  packet[idx++] = 0xe0 | ((PMT_PID >> 8) & 0x1f); // reserved + PMT PID high
  packet[idx++] = PMT_PID & 0xff; // PMT PID low

  // CRC32 (calculated over section from table_id to last byte before CRC)
  const crc = crc32Mpeg(packet.subarray(5, idx));
  packet.writeUInt32BE(crc, idx);

  return packet;
}

/**
 * Create a PMT (Program Map Table) packet.
 */
function createPmt(streamType: number): Buffer {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);

  // TS header
  packet[0] = TS_SYNC_BYTE;
  packet[1] = 0x40 | ((PMT_PID >> 8) & 0x1f);
  packet[2] = PMT_PID & 0xff;
  packet[3] = 0x10 | (pmtCc & 0x0f);
  pmtCc = (pmtCc + 1) & 0x0f;

  // Pointer field
  packet[4] = 0x00;

  // PMT section
  let idx = 5;
  packet[idx++] = 0x02; // table_id = 2 (PMT)
  packet[idx++] = 0xb0; // section_syntax_indicator=1
  packet[idx++] = 18; // section_length
  packet[idx++] = 0x00; // program_number high
  packet[idx++] = 0x01; // program_number low
  packet[idx++] = 0xc1; // reserved, version=0, current_next=1
  packet[idx++] = 0x00; // section_number
  packet[idx++] = 0x00; // last_section_number
  packet[idx++] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f); // reserved + PCR_PID high
  packet[idx++] = VIDEO_PID & 0xff; // PCR_PID low
  packet[idx++] = 0xf0; // reserved + program_info_length high
  packet[idx++] = 0x00; // program_info_length low

  // Stream info (video)
  packet[idx++] = streamType; // stream_type (H.264 or H.265)
  packet[idx++] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f); // reserved + elementary_PID high
  packet[idx++] = VIDEO_PID & 0xff; // elementary_PID low
  packet[idx++] = 0xf0; // reserved + ES_info_length high
  packet[idx++] = 0x00; // ES_info_length low

  // CRC32
  const crc = crc32Mpeg(packet.subarray(5, idx));
  packet.writeUInt32BE(crc, idx);

  return packet;
}

/**
 * Create TS packets for a video PES (Packetized Elementary Stream).
 *
 * @param data - Annex-B video data (with start codes)
 * @param pts - Presentation timestamp in microseconds
 * @param isKeyframe - Whether this is a keyframe (for random access indicator)
 */
function createVideoPes(
  data: Buffer,
  pts: number,
  isKeyframe: boolean,
): Buffer[] {
  const packets: Buffer[] = [];

  // Convert microseconds to 90kHz PTS
  const pts90k = Math.floor((pts * 90000) / 1_000_000);

  // Create PES header
  // PES header: 6 bytes base + 3 bytes PTS header + 5 bytes PTS
  const pesHeaderLen = 14;
  const pesHeader = Buffer.alloc(pesHeaderLen);

  let idx = 0;
  // Start code prefix (3 bytes)
  pesHeader[idx++] = 0x00;
  pesHeader[idx++] = 0x00;
  pesHeader[idx++] = 0x01;
  // Stream ID (0xe0 = video)
  pesHeader[idx++] = 0xe0;
  // PES packet length (0 = unbounded for video)
  pesHeader[idx++] = 0x00;
  pesHeader[idx++] = 0x00;
  // PES header flags
  pesHeader[idx++] = 0x80; // '10' marker bits, no scrambling, no priority, no alignment, no copyright, no original
  pesHeader[idx++] = 0x80; // PTS only, no DTS, no ESCR, no ES_rate, no DSM_trick_mode, no additional_copy_info, no CRC, no extension
  // PES header data length
  pesHeader[idx++] = 0x05; // 5 bytes for PTS

  // PTS (5 bytes)
  // Format: '0010' + PTS[32..30] + '1' + PTS[29..15] + '1' + PTS[14..0] + '1'
  pesHeader[idx++] = 0x21 | ((pts90k >> 29) & 0x0e); // '0010' + PTS[32:30] + '1'
  pesHeader[idx++] = (pts90k >> 22) & 0xff; // PTS[29:22]
  pesHeader[idx++] = 0x01 | ((pts90k >> 14) & 0xfe); // PTS[21:15] + '1'
  pesHeader[idx++] = (pts90k >> 7) & 0xff; // PTS[14:7]
  pesHeader[idx++] = 0x01 | ((pts90k << 1) & 0xfe); // PTS[6:0] + '1'

  // Combine PES header with payload
  const pesData = Buffer.concat([pesHeader, data]);
  let pesOffset = 0;

  // Fragment into TS packets
  let isFirst = true;
  while (pesOffset < pesData.length) {
    const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
    let pktIdx = 0;

    // TS header
    packet[pktIdx++] = TS_SYNC_BYTE;
    packet[pktIdx++] = (isFirst ? 0x40 : 0x00) | ((VIDEO_PID >> 8) & 0x1f);
    packet[pktIdx++] = VIDEO_PID & 0xff;

    const remaining = pesData.length - pesOffset;
    const maxPayload = TS_PACKET_SIZE - 4; // 184 bytes

    if (remaining >= maxPayload) {
      // Full payload, no adaptation field needed
      packet[pktIdx++] = 0x10 | (videoCc & 0x0f);
      videoCc = (videoCc + 1) & 0x0f;
      pesData.copy(packet, pktIdx, pesOffset, pesOffset + maxPayload);
      pesOffset += maxPayload;
    } else {
      // Need adaptation field for padding
      const adaptLen = maxPayload - remaining - 1; // -1 for adaptation_field_length byte

      if (adaptLen < 0) {
        // Edge case: very small remaining data, use stuffing
        packet[pktIdx++] = 0x30 | (videoCc & 0x0f); // adaptation + payload
        videoCc = (videoCc + 1) & 0x0f;
        packet[pktIdx++] = TS_PACKET_SIZE - 4 - 1 - remaining; // adaptation_field_length
        if (isFirst && isKeyframe) {
          packet[pktIdx++] = 0x40; // random_access_indicator
          // Fill rest with stuffing
          for (let i = pktIdx; i < TS_PACKET_SIZE - remaining; i++) {
            packet[i] = 0xff;
          }
        } else {
          packet[pktIdx++] = 0x00; // no flags
          for (let i = pktIdx; i < TS_PACKET_SIZE - remaining; i++) {
            packet[i] = 0xff;
          }
        }
        pesData.copy(packet, TS_PACKET_SIZE - remaining, pesOffset);
        pesOffset += remaining;
      } else {
        // Normal case with adaptation field
        packet[pktIdx++] = 0x30 | (videoCc & 0x0f); // adaptation + payload
        videoCc = (videoCc + 1) & 0x0f;

        if (adaptLen === 0) {
          packet[pktIdx++] = 0x00; // adaptation_field_length = 0
        } else {
          packet[pktIdx++] = adaptLen; // adaptation_field_length
          if (isFirst && isKeyframe) {
            packet[pktIdx++] = 0x40; // random_access_indicator
          } else {
            packet[pktIdx++] = 0x00; // no flags
          }
          // Stuffing bytes
          for (let i = 0; i < adaptLen - 1; i++) {
            packet[pktIdx++] = 0xff;
          }
        }

        pesData.copy(packet, pktIdx, pesOffset, pesOffset + remaining);
        pesOffset += remaining;
      }
    }

    packets.push(packet);
    isFirst = false;
  }

  return packets;
}

/**
 * CRC32 for MPEG-TS (polynomial 0x04c11db7).
 */
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

export interface MpegTsMuxerOptions {
  /** Video codec type */
  videoType: "H264" | "H265";
}

/**
 * MPEG-TS Muxer class for streaming video with timestamps.
 */
export class MpegTsMuxer {
  private readonly streamType: number;
  private patSent = false;
  private pmtSent = false;
  private patPmtInterval = 0;
  private readonly patPmtIntervalMax = 40; // Send PAT/PMT every ~40 frames

  constructor(options: MpegTsMuxerOptions) {
    this.streamType =
      options.videoType === "H265" ? STREAM_TYPE_H265 : STREAM_TYPE_H264;
  }

  /**
   * Reset continuity counters (call when starting a new stream).
   */
  static resetCounters(): void {
    patCc = 0;
    pmtCc = 0;
    videoCc = 0;
  }

  /**
   * Mux a video frame into MPEG-TS packets.
   *
   * @param data - Annex-B video data (with start codes)
   * @param microseconds - Frame timestamp in microseconds
   * @param isKeyframe - Whether this is a keyframe
   * @returns Buffer containing all TS packets for this frame
   */
  mux(data: Buffer, microseconds: number, isKeyframe: boolean): Buffer {
    const packets: Buffer[] = [];

    // Send PAT/PMT at start and periodically (especially before keyframes)
    if (
      !this.patSent ||
      !this.pmtSent ||
      isKeyframe ||
      this.patPmtInterval >= this.patPmtIntervalMax
    ) {
      packets.push(createPat());
      packets.push(createPmt(this.streamType));
      this.patSent = true;
      this.pmtSent = true;
      this.patPmtInterval = 0;
    }
    this.patPmtInterval++;

    // Create video PES packets
    const videoPackets = createVideoPes(data, microseconds, isKeyframe);
    packets.push(...videoPackets);

    return Buffer.concat(packets);
  }
}
